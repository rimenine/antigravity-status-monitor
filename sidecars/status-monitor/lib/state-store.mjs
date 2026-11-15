import { existsSync } from "node:fs";
import { BRAIN_DIRS, FALLBACK_HOOK_PATH } from "./config.mjs";
import {
  clearMatchingFallbackHooks,
  readMatchingFallbackHooks,
  resolveFallbackHooksDir,
} from "./fallback-hooks.mjs";
import { createTimelineStore, normalizeConvId } from "./timeline-store.mjs";
import { collectTokenStats, resolveTranscriptLogPath } from "./tokens.mjs";
import {
  createEmptyHook,
  createEmptyTranscript,
  parseTranscriptSnapshot,
} from "./transcript-reader.mjs";
import { computeVerdict } from "./verdict.mjs";

/**
 * 创建严格单对话隔离的状态仓库，负责聚合 Hooks、Transcript 日志与裁决快照。
 * 不执行跨会话自动抢占切换，每个会话持有物理隔离的事件流与状态对象。
 */
export function createStateStore({
  brainDirs = BRAIN_DIRS,
  fallbackHookPath = FALLBACK_HOOK_PATH,
  fallbackHooksDir = undefined,
  lsAddress = "",
  defaultConvId = null,
} = {}) {
  const resolvedFallbackHooksDir = resolveFallbackHooksDir(fallbackHookPath, fallbackHooksDir);
  const fixedDefaultConvId = normalizeConvId(defaultConvId);
  const conversations = new Map();
  const loggedToolSteps = new Set();
  const timeline = createTimelineStore();

  function getOrCreateConv(convId) {
    const key = normalizeConvId(convId) || "default";
    if (!conversations.has(key)) {
      conversations.set(key, {
        hook: createEmptyHook(key === "default" ? null : key),
        transcript: createEmptyTranscript(key === "default" ? null : key),
      });
    }
    return conversations.get(key);
  }

  function pushTimelineEvent(
    kind,
    title,
    detail = "",
    level = "info",
    conversationId = null,
    i18n = null,
  ) {
    return timeline.push(kind, title, detail, level, conversationId, i18n);
  }

  function findTranscriptPathForConv(convId) {
    const targetId = normalizeConvId(convId);
    if (!targetId) return null;
    const conv = conversations.get(targetId);
    if (conv?.hook?.transcriptPath && existsSync(conv.hook.transcriptPath)) {
      return conv.hook.transcriptPath;
    }
    for (const brainDir of brainDirs) {
      const p = resolveTranscriptLogPath(brainDir, targetId);
      if (p) return p;
    }
    return null;
  }

  function parseTranscriptFile(convId, filePath, recordTimeline = true) {
    const targetId = normalizeConvId(convId);
    if (!targetId || !filePath || !existsSync(filePath)) return false;
    const now = Date.now();
    const existingConv = conversations.get(targetId);
    const result = parseTranscriptSnapshot(filePath, targetId, existingConv?.transcript || null, now);

    if (result.status === "stale-idle" && existingConv?.transcript) {
      existingConv.transcript.inferredPhase = "idle";
      return true;
    }
    if (result.status !== "updated") {
      return false;
    }

    const nextT = result.transcript;
    const conv = getOrCreateConv(targetId);
    const changed =
      conv.transcript.latestStepIndex !== nextT.latestStepIndex ||
      conv.transcript.inferredPhase !== nextT.inferredPhase ||
      conv.transcript.conversationId !== targetId ||
      conv.transcript.size !== nextT.size ||
      conv.transcript.latestStepAt !== nextT.latestStepAt;

    if (
      recordTimeline &&
      nextT.inferredPhase === "running_tool" &&
      result.lastToolName &&
      result.lastStepIndex != null &&
      now - result.latestStepAt < 15000
    ) {
      const stepKey = `${targetId}:${result.lastStepIndex}`;
      if (!loggedToolSteps.has(stepKey)) {
        if (loggedToolSteps.size > 200) loggedToolSteps.clear();
        loggedToolSteps.add(stepKey);
        const shortConv = targetId !== "default" ? `#${targetId.slice(0, 6)}` : "";
        pushTimelineEvent(
          "tool",
          `执行工具: ${result.lastToolName}`,
          [shortConv, `Step #${result.lastStepIndex}`].filter(Boolean).join(" · "),
          "info",
          targetId,
          { key: "TOOL_STEP", params: { tools: result.lastToolName, shortConv, stepIdx: result.lastStepIndex } },
        );
      }
    }

    conv.transcript = nextT;
    return changed;
  }

  /**
   * 仅解析并返回请求显式锁定的对话（或固定默认会话）。
   * 未传会话 ID 时只返回独立 "default" 状态，绝不跨目录切换到其他对话。
   */
  function resolveActiveConversation(requestedConvId = null) {
    const boundId = normalizeConvId(requestedConvId) || fixedDefaultConvId;
    if (boundId) {
      const reqPath = findTranscriptPathForConv(boundId);
      if (reqPath && !conversations.get(boundId)?.transcript?.filePath) {
        parseTranscriptFile(boundId, reqPath, false);
      }
      const existing = conversations.get(boundId);
      if (existing && (existing.hook.lastEventAt || existing.transcript.filePath)) {
        return existing;
      }
      return {
        hook: createEmptyHook(boundId),
        transcript: createEmptyTranscript(boundId),
      };
    }

    return (
      conversations.get("default") || {
        hook: createEmptyHook(null),
        transcript: createEmptyTranscript(null),
      }
    );
  }

  function refreshTranscript(convId, recordTimeline = true) {
    const targetId = normalizeConvId(convId);
    if (!targetId) return false;
    try {
      const p = findTranscriptPathForConv(targetId);
      return p ? parseTranscriptFile(targetId, p, recordTimeline) : false;
    } catch {
      return false;
    }
  }

  /**
   * 仅刷新显式指定的对话列表，不再遍历扫描无关会话目录。
   */
  function scanTranscript(requestedConvIds = null, recordTimeline = true) {
    try {
      let anyChanged = false;
      const scannedConvIds = new Set();

      const rawList =
        typeof requestedConvIds === "string"
          ? [requestedConvIds]
          : requestedConvIds && typeof requestedConvIds[Symbol.iterator] === "function"
            ? [...requestedConvIds]
            : [];
      const targetIds = rawList.map((id) => normalizeConvId(id)).filter(Boolean);

      for (const cid of targetIds) {
        if (scannedConvIds.has(cid)) continue;
        scannedConvIds.add(cid);
        const reqPath = findTranscriptPathForConv(cid);
        if (reqPath) {
          anyChanged = parseTranscriptFile(cid, reqPath, recordTimeline) || anyChanged;
        }
      }
      return anyChanged;
    } catch {
      return false;
    }
  }

  function applyHookEvent(record, recordTimeline = true) {
    const { eventName, receivedAt = Date.now(), payload = {} } = record;
    const convId = normalizeConvId(payload.conversationId) || fixedDefaultConvId || "default";

    const conv = getOrCreateConv(convId);
    const h = conv.hook;
    h.lastEvent = eventName;
    h.lastEventAt = receivedAt;
    if (convId !== "default") {
      h.conversationId = convId;
    }
    if (payload.modelName) h.modelName = payload.modelName;
    if (payload.transcriptPath) h.transcriptPath = payload.transcriptPath;
    if (payload.stepIdx !== null && payload.stepIdx !== undefined) h.stepIdx = payload.stepIdx;

    const shortConv = h.conversationId ? `#${h.conversationId.slice(0, 6)}` : "";

    if (eventName === "PreInvocation") {
      h.phase = "waiting_llm";
      if (!h.turnStartedAt) h.turnStartedAt = receivedAt;
      h.terminationReason = null;
      h.error = null;
      if (recordTimeline) {
        const inv = payload.invocationNum != null ? `第 ${payload.invocationNum} 次模型调用` : "";
        pushTimelineEvent(
          "hook",
          "开始请求模型 (PreInvocation)",
          [shortConv, inv].filter(Boolean).join(" · "),
          "active",
          h.conversationId,
          {
            key: "HOOK_PRE_INVOCATION",
            params: { shortConv, invocationNum: payload.invocationNum ?? null },
          },
        );
      }
    } else if (eventName === "Stop") {
      h.phase = "idle";
      h.turnStartedAt = null;
      h.toolName = null;
      h.terminationReason = payload.terminationReason || "DONE";
      h.error = payload.error || null;
      const isErr = payload.terminationReason === "ERROR" || Boolean(payload.error);
      if (recordTimeline) {
        pushTimelineEvent(
          "hook",
          `回合结束 (${h.terminationReason})`,
          h.error || shortConv,
          isErr ? "error" : "success",
          h.conversationId,
          {
            key: "HOOK_STOP",
            params: {
              reason: h.terminationReason,
              error: h.error || "",
              shortConv,
            },
          },
        );
      }
    }
  }

  function loadFallbackHookIfNewer() {
    const records = readMatchingFallbackHooks({
      fallbackHooksDir: resolvedFallbackHooksDir,
      fallbackHookPath,
      lsAddress,
    });
    for (const record of records) {
      const convId = normalizeConvId(record?.payload?.conversationId) || fixedDefaultConvId || "default";
      const conv = getOrCreateConv(convId);
      if (record?.receivedAt && (!conv.hook.lastEventAt || record.receivedAt > conv.hook.lastEventAt)) {
        applyHookEvent(record, false);
      }
    }
  }

  function clearFallbackHook(upToTs = Infinity, { conversationId = null, lsAddress: scopeLs = null } = {}) {
    clearMatchingFallbackHooks({
      fallbackHooksDir: resolvedFallbackHooksDir,
      fallbackHookPath,
      upToTs,
      conversationId,
      lsAddress: scopeLs ?? (lsAddress || null),
    });
  }

  function buildSnapshot({ probes, consecutiveFailures, ls, simulation, config, requestedConvId = null }) {
    const now = Date.now();
    if (simulation?.active && simulation.expiresAt && now > simulation.expiresAt) {
      simulation.active = false;
      simulation.expiresAt = null;
      simulation.convId = null;
    }

    const boundConvId = normalizeConvId(requestedConvId) || fixedDefaultConvId;
    const conv = resolveActiveConversation(boundConvId);
    const activeConversationId =
      conv.hook.conversationId || conv.transcript.conversationId || boundConvId || null;

    const scopedSimulation =
      simulation?.active && (!simulation.convId || simulation.convId === activeConversationId)
        ? simulation
        : { active: false, expiresAt: null, convId: null };

    const verdict = computeVerdict({
      hook: conv.hook,
      transcript: conv.transcript,
      ls,
      probes,
      consecutiveFailures,
      simulation: scopedSimulation,
      config,
      now,
    });
    const tokenStats = collectTokenStats(brainDirs, conv.transcript.filePath);
    const scopedEvents = timeline.listForConversation(activeConversationId, config?.lang || "zh");

    const okProbes = probes.filter((p) => p.ok);
    const avgLatencyMs = okProbes.length
      ? Math.round(okProbes.reduce((acc, p) => acc + p.latencyMs, 0) / okProbes.length)
      : null;
    const successRate = probes.length
      ? Math.round((okProbes.length / probes.length) * 100)
      : null;

    return {
      now,
      activeConversationId,
      verdict,
      config,
      hook: conv.hook,
      transcript: conv.transcript,
      tokenStats,
      ls,
      probes,
      metrics: {
        latestProbe: probes[probes.length - 1] || null,
        avgLatencyMs,
        successRate,
        consecutiveFailures,
      },
      simulation: scopedSimulation,
      events: scopedEvents,
    };
  }

  const storeApi = {
    pushTimelineEvent,
    refreshTranscript,
    scanTranscript,
    applyHookEvent,
    loadFallbackHookIfNewer,
    clearFallbackHook,
    resolveActiveConversation,
    buildSnapshot,
  };
  Object.defineProperty(storeApi, "events", {
    enumerable: true,
    get: () => timeline.listAllRaw(),
  });
  return storeApi;
}
