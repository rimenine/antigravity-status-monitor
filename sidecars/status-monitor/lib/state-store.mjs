import { existsSync, readdirSync, statSync } from "node:fs";
import { BRAIN_DIRS, FALLBACK_HOOK_PATH } from "./config.mjs";
import {
  clearMatchingFallbackHooks,
  readMatchingFallbackHooks,
  resolveFallbackHooksDir,
} from "./fallback-hooks.mjs";
import { resolveEventText } from "./i18n.mjs";
import { collectTokenStats, resolveTranscriptLogPath } from "./tokens.mjs";
import {
  createEmptyHook,
  createEmptyTranscript,
  parseTranscriptSnapshot,
} from "./transcript-reader.mjs";
import { computeVerdict } from "./verdict.mjs";

const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

/** 创建多会话隔离的状态仓库，负责聚合 Hooks、Transcript 日志与裁决快照。 */
export function createStateStore({
  brainDirs = BRAIN_DIRS,
  fallbackHookPath = FALLBACK_HOOK_PATH,
  fallbackHooksDir = undefined,
  lsAddress = "",
} = {}) {
  const resolvedFallbackHooksDir = resolveFallbackHooksDir(fallbackHookPath, fallbackHooksDir);
  const conversations = new Map();
  const loggedToolSteps = new Set();
  const events = [];
  let latestConvId = null;
  let lastFullScanAt = 0;

  function getOrCreateConv(convId) {
    const key = convId || "default";
    if (!conversations.has(key)) {
      conversations.set(key, {
        hook: createEmptyHook(convId || null),
        transcript: createEmptyTranscript(convId || null),
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
    events.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ts: Date.now(),
      kind,
      title,
      detail,
      level,
      conversationId,
      ...(i18n ? { i18n } : {}),
    });
    if (events.length > 40) {
      events.length = 40;
    }
  }

  function findTranscriptPathForConv(convId) {
    if (!convId) return null;
    const conv = conversations.get(convId);
    if (conv?.hook?.transcriptPath && existsSync(conv.hook.transcriptPath)) {
      return conv.hook.transcriptPath;
    }
    for (const brainDir of brainDirs) {
      const p = resolveTranscriptLogPath(brainDir, convId);
      if (p) return p;
    }
    return null;
  }

  function parseTranscriptFile(convId, filePath, recordTimeline = true) {
    if (!filePath || !existsSync(filePath)) return false;
    const now = Date.now();
    const existingConv = conversations.get(convId || "default");
    const result = parseTranscriptSnapshot(filePath, convId, existingConv?.transcript || null, now);

    if (result.status === "stale-idle" && existingConv?.transcript) {
      existingConv.transcript.inferredPhase = "idle";
      return true;
    }
    if (result.status !== "updated") {
      return false;
    }

    const nextT = result.transcript;
    const conv = getOrCreateConv(convId);
    const changed =
      conv.transcript.latestStepIndex !== nextT.latestStepIndex ||
      conv.transcript.inferredPhase !== nextT.inferredPhase ||
      conv.transcript.conversationId !== convId ||
      conv.transcript.size !== nextT.size ||
      conv.transcript.latestStepAt !== nextT.latestStepAt;

    if (
      recordTimeline &&
      nextT.inferredPhase === "running_tool" &&
      result.lastToolName &&
      result.lastStepIndex != null &&
      now - result.latestStepAt < 15000
    ) {
      const stepKey = `${convId}:${result.lastStepIndex}`;
      if (!loggedToolSteps.has(stepKey)) {
        if (loggedToolSteps.size > 200) loggedToolSteps.clear();
        loggedToolSteps.add(stepKey);
        const shortConv = convId && convId !== "default" ? `#${convId.slice(0, 6)}` : "";
        pushTimelineEvent(
          "tool",
          `执行工具: ${result.lastToolName}`,
          [shortConv, `Step #${result.lastStepIndex}`].filter(Boolean).join(" · "),
          "info",
          convId,
          { key: "TOOL_STEP", params: { tools: result.lastToolName, shortConv, stepIdx: result.lastStepIndex } },
        );
      }
    }

    conv.transcript = nextT;
    return changed;
  }

  function isConvActive(conv, now = Date.now()) {
    if (!conv) return false;
    const hActive =
      conv.hook?.phase &&
      conv.hook.phase !== "idle" &&
      conv.hook.lastEventAt &&
      now - conv.hook.lastEventAt < ACTIVE_WINDOW_MS;
    const tActive =
      conv.transcript?.inferredPhase &&
      conv.transcript.inferredPhase !== "idle" &&
      conv.transcript.latestStepAt &&
      now - conv.transcript.latestStepAt < ACTIVE_WINDOW_MS;
    return Boolean(hActive || tActive);
  }

  function getConvUpdatedAt(conv) {
    if (!conv) return 0;
    return Math.max(conv.hook?.lastEventAt || 0, conv.transcript?.latestStepAt || 0);
  }

  function listRecentConversations(now = Date.now(), limit = 8) {
    const items = [];
    for (const [id, conv] of conversations.entries()) {
      if (!id || id === "default") continue;
      const updatedAt = getConvUpdatedAt(conv);
      if (!updatedAt && !conv.transcript?.filePath) continue;
      const active = isConvActive(conv, now);
      const hookPhase = conv.hook?.phase || "idle";
      const transcriptPhase = conv.transcript?.inferredPhase || "idle";
      const phase = active ? (hookPhase !== "idle" ? hookPhase : transcriptPhase) : "idle";
      items.push({
        id,
        active,
        phase,
        updatedAt,
        stepIdx: conv.transcript?.latestStepIndex ?? conv.hook?.stepIdx ?? null,
      });
    }
    items.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
    return items.slice(0, limit);
  }

  function resolveActiveConversation(requestedConvId = null) {
    const normalizedReqId = requestedConvId === "auto" ? null : requestedConvId;
    if (normalizedReqId) {
      const reqPath = findTranscriptPathForConv(normalizedReqId);
      if (reqPath && !conversations.get(normalizedReqId)?.transcript?.filePath) {
        parseTranscriptFile(normalizedReqId, reqPath, false);
      }
      const existing = conversations.get(normalizedReqId);
      if (existing && (existing.hook.lastEventAt || existing.transcript.filePath)) {
        return existing;
      }
      return {
        hook: createEmptyHook(normalizedReqId),
        transcript: createEmptyTranscript(normalizedReqId),
      };
    }

    const now = Date.now();
    const pinned = latestConvId ? conversations.get(latestConvId) : null;
    if (pinned && isConvActive(pinned, now)) {
      return pinned;
    }

    let bestActive = null;
    let bestActiveTs = -1;
    let bestConv = null;
    let bestTs = -1;
    for (const [id, conv] of conversations) {
      if (id === "default") continue;
      const ts = getConvUpdatedAt(conv);
      if (isConvActive(conv, now) && ts > bestActiveTs) {
        bestActiveTs = ts;
        bestActive = conv;
      }
      if (ts > bestTs) {
        bestTs = ts;
        bestConv = conv;
      }
    }

    if (bestActive) return bestActive;
    if (pinned && (pinned.hook.lastEventAt || pinned.transcript.filePath)) {
      return pinned;
    }
    if (bestConv) return bestConv;
    const defConv = conversations.get("default");
    if (defConv && (defConv.hook.lastEventAt || defConv.transcript.filePath)) {
      return defConv;
    }
    if (latestConvId) return getOrCreateConv(latestConvId);
    return getOrCreateConv("default");
  }

  function refreshTranscript(convId, recordTimeline = true) {
    if (!convId) return false;
    if (!latestConvId) {
      latestConvId = convId;
    }
    try {
      const p = findTranscriptPathForConv(convId);
      return p ? parseTranscriptFile(convId, p, recordTimeline) : false;
    } catch {
      return false;
    }
  }

  function findNewestBrainTranscript() {
    let newestPath = null;
    let newestConvId = null;
    let newestMtime = 0;

    for (const brainDir of brainDirs) {
      if (!existsSync(brainDir)) continue;
      const dirs = readdirSync(brainDir, { withFileTypes: true });
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const p = resolveTranscriptLogPath(brainDir, d.name);
        if (!p) continue;
        const mtime = statSync(p).mtimeMs;
        if (mtime > newestMtime) {
          newestMtime = mtime;
          newestPath = p;
          newestConvId = d.name;
        }
      }
    }
    return { newestPath, newestConvId, newestMtime };
  }

  function scanTranscript(requestedConvIds = null, recordTimeline = true, { fullScanIntervalMs = 0 } = {}) {
    try {
      let anyChanged = false;
      const scannedConvIds = new Set();

      const targetIds =
        typeof requestedConvIds === "string"
          ? [requestedConvIds]
          : requestedConvIds && typeof requestedConvIds[Symbol.iterator] === "function"
            ? [...requestedConvIds].filter(Boolean)
            : [];

      for (const cid of targetIds) {
        if (scannedConvIds.has(cid)) continue;
        scannedConvIds.add(cid);
        const reqPath = findTranscriptPathForConv(cid);
        if (reqPath) {
          anyChanged = parseTranscriptFile(cid, reqPath, recordTimeline) || anyChanged;
        }
      }

      if (latestConvId && !scannedConvIds.has(latestConvId)) {
        scannedConvIds.add(latestConvId);
        const latestHookPath = findTranscriptPathForConv(latestConvId);
        if (latestHookPath) {
          anyChanged = parseTranscriptFile(latestConvId, latestHookPath, recordTimeline) || anyChanged;
        }
      }

      const now = Date.now();
      const shouldFullScan =
        fullScanIntervalMs <= 0 || !latestConvId || now - lastFullScanAt >= fullScanIntervalMs;

      if (shouldFullScan) {
        lastFullScanAt = now;
        const { newestPath, newestConvId, newestMtime } = findNewestBrainTranscript();

        if (newestPath && newestConvId) {
          if (!scannedConvIds.has(newestConvId)) {
            const preferredPath = findTranscriptPathForConv(newestConvId) || newestPath;
            anyChanged = parseTranscriptFile(newestConvId, preferredPath, recordTimeline) || anyChanged;
          }
          if (!latestConvId) {
            latestConvId = newestConvId;
          } else if (newestConvId !== latestConvId) {
            const curConv = getOrCreateConv(latestConvId);
            const newestConv = conversations.get(newestConvId);
            const curLastAt = Math.max(curConv.hook.lastEventAt || 0, curConv.transcript.latestStepAt || 0);
            const curActive = isConvActive(curConv, now);
            const allowSwitch = !curActive || Boolean(newestConv?.transcript?.hasUserExplicit);
            if (allowSwitch && newestMtime > curLastAt + 2000) {
              latestConvId = newestConvId;
            }
          }
        }
      }

      return anyChanged;
    } catch {
      return false;
    }
  }

  function applyHookEvent(record, recordTimeline = true) {
    const { eventName, receivedAt = Date.now(), payload = {} } = record;
    const convId = payload.conversationId || latestConvId || "default";
    if (payload.conversationId) {
      latestConvId = payload.conversationId;
    }

    const conv = getOrCreateConv(convId);
    const h = conv.hook;
    h.lastEvent = eventName;
    h.lastEventAt = receivedAt;
    if (payload.conversationId) h.conversationId = payload.conversationId;
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
      const convId = record?.payload?.conversationId || "default";
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
    }

    const effectiveReqId = requestedConvId === "auto" ? null : requestedConvId;
    const conv = resolveActiveConversation(effectiveReqId);
    const verdict = computeVerdict({
      hook: conv.hook,
      transcript: conv.transcript,
      ls,
      probes,
      consecutiveFailures,
      simulation,
      config,
      now,
    });
    const tokenStats = collectTokenStats(brainDirs, conv.transcript.filePath);

    const activeConversationId =
      conv.hook.conversationId || conv.transcript.conversationId || effectiveReqId || null;
    // 仅保留当前绑定窗口与全局事件（无 conversationId），避免其他并行对话的调用记录混入本窗口事件流
    const scopedEvents = events
      .filter(
        (ev) =>
          !ev.conversationId ||
          !activeConversationId ||
          activeConversationId === "default" ||
          ev.conversationId === activeConversationId,
      )
      .map((ev) => resolveEventText(ev, config?.lang || "zh"));

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
      simulation,
      recentConversations: listRecentConversations(now),
      events: scopedEvents,
    };
  }

  return {
    events,
    pushTimelineEvent,
    refreshTranscript,
    scanTranscript,
    applyHookEvent,
    loadFallbackHookIfNewer,
    clearFallbackHook,
    listRecentConversations,
    resolveActiveConversation,
    buildSnapshot,
  };
}
