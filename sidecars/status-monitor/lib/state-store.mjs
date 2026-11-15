import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { BRAIN_DIRS, FALLBACK_HOOK_PATH } from "./config.mjs";
import { resolveEventText } from "./i18n.mjs";
import { doesFallbackRecordMatchScope } from "./runtime-paths.mjs";
import { collectTokenStats, resolveTranscriptLogPath } from "./tokens.mjs";
import { computeVerdict } from "./verdict.mjs";

function createEmptyHook(conversationId = null) {
  return {
    phase: "idle",
    lastEvent: null,
    lastEventAt: null,
    turnStartedAt: null,
    conversationId,
    modelName: null,
    toolName: null,
    stepIdx: null,
    terminationReason: null,
    error: null,
    transcriptPath: null,
  };
}

function createEmptyTranscript(conversationId = null) {
  return {
    conversationId,
    filePath: null,
    mtimeMs: null,
    size: null,
    latestStepIndex: null,
    latestStepType: null,
    latestStepStatus: null,
    latestStepAt: null,
    latestRecordCreatedAt: null,
    hasUserExplicit: false,
    lastToolName: null,
    tokens: null,
    inferredPhase: "idle",
  };
}

const TERMINAL_PLANNER_STATUSES = new Set([
  "DONE",
  "ERROR",
  "CANCELLED",
  "CANCELED",
  "FAILED",
  "ABORTED",
  "STOPPED",
]);

function readLastCompleteLineFallback(fd, size, maxScanBytes = 32 * 1024 * 1024) {
  const chunkSize = 512 * 1024;
  let pos = size;
  let trailingEmpty = true;
  let lineEnd = size;
  const minPos = Math.max(0, size - maxScanBytes);

  while (pos > minPos) {
    const start = Math.max(minPos, pos - chunkSize);
    const len = pos - start;
    const buf = Buffer.allocUnsafe(len);
    const n = readSync(fd, buf, 0, len, start);
    if (n <= 0) break;
    let idx = n - 1;
    while (idx >= 0) {
      if (buf[idx] === 0x0a) {
        if (trailingEmpty && start + idx >= lineEnd - 2) {
          lineEnd = start + idx;
          idx -= 1;
          continue;
        }
        const lineStart = start + idx + 1;
        const lineLen = lineEnd - lineStart;
        if (lineLen > 0) {
          const lineBuf = Buffer.allocUnsafe(lineLen);
          const rn = readSync(fd, lineBuf, 0, lineLen, lineStart);
          try {
            return [JSON.parse(lineBuf.subarray(0, rn).toString("utf8").trim())];
          } catch {
            return [];
          }
        }
      } else if (buf[idx] !== 0x0d && buf[idx] !== 0x20 && buf[idx] !== 0x09) {
        trailingEmpty = false;
      }
      idx -= 1;
    }
    pos = start;
  }

  if (minPos === 0 && lineEnd > 0) {
    const lineBuf = Buffer.allocUnsafe(lineEnd);
    const rn = readSync(fd, lineBuf, 0, lineEnd, 0);
    try {
      return [JSON.parse(lineBuf.subarray(0, rn).toString("utf8").trim())];
    } catch {
      return [];
    }
  }
  return [];
}

function readWindowRecords(fd, size, windowBytes) {
  const start = Math.max(0, size - windowBytes);
  const length = size - start;
  const buf = Buffer.allocUnsafe(length);
  const bytesRead = readSync(fd, buf, 0, length, start);
  let slice = buf.subarray(0, bytesRead);
  if (start > 0) {
    const firstNl = slice.indexOf(0x0a);
    if (firstNl === -1) {
      return { start, parsed: [] };
    }
    slice = slice.subarray(firstNl + 1);
  }
  const parsed = [];
  for (const line of slice.toString("utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      parsed.push(JSON.parse(line));
    } catch {
    }
  }
  return { start, parsed };
}

function readTailLines(filePath, stat, initialBytes = 32768, maxBytes = 16 * 1024 * 1024) {
  const size = stat.size;
  if (size <= 0) return { mtimeMs: stat.mtimeMs, size: 0, parsed: [] };

  const fd = openSync(filePath, "r");
  try {
    let windowBytes = initialBytes;
    while (true) {
      const { start, parsed } = readWindowRecords(fd, size, windowBytes);
      const hasPlanner = parsed.some((x) => x.type === "PLANNER_RESPONSE");
      if (start === 0 || (parsed.length > 0 && hasPlanner)) {
        return { mtimeMs: stat.mtimeMs, size, parsed };
      }
      if (windowBytes >= maxBytes) {
        const finalParsed = parsed.length > 0 ? parsed : readLastCompleteLineFallback(fd, size);
        return { mtimeMs: stat.mtimeMs, size, parsed: finalParsed };
      }
      windowBytes = Math.min(maxBytes, windowBytes * 4);
    }
  } finally {
    closeSync(fd);
  }
}

export function createStateStore({
  brainDirs = BRAIN_DIRS,
  fallbackHookPath = FALLBACK_HOOK_PATH,
  fallbackHooksDir = undefined,
  lsAddress = "",
} = {}) {
  const resolvedFallbackHooksDir =
    fallbackHooksDir !== undefined
      ? fallbackHooksDir
      : fallbackHookPath
        ? join(dirname(fallbackHookPath), "hooks")
        : null;
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
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      return false;
    }

    const existingConv = conversations.get(convId || "default");
    const prevT = existingConv?.transcript;
    if (
      prevT &&
      prevT.filePath === filePath &&
      prevT.mtimeMs === stat.mtimeMs &&
      prevT.size === stat.size
    ) {
      if (
        prevT.inferredPhase !== "idle" &&
        Date.now() - Math.max(prevT.latestStepAt || 0, prevT.mtimeMs || 0) >= 10 * 60 * 1000
      ) {
        prevT.inferredPhase = "idle";
        return true;
      }
      return false;
    }

    const fileActivelyUpdated =
      Boolean(prevT) &&
      prevT.filePath === filePath &&
      (prevT.size !== stat.size || (prevT.mtimeMs != null && stat.mtimeMs > prevT.mtimeMs));

    const { mtimeMs, size, parsed } = readTailLines(filePath, stat);
    if (parsed.length === 0) return false;

    const last = parsed[parsed.length - 1];
    const lastPlanner = [...parsed].reverse().find((x) => x.type === "PLANNER_RESPONSE");
    const hasUserExplicit = Boolean(prevT?.hasUserExplicit || parsed.some((x) => x.source === "USER_EXPLICIT"));
    const parsedStepAt = last.created_at ? Date.parse(last.created_at) : NaN;
    const latestRecordCreatedAt = Number.isFinite(parsedStepAt) ? parsedStepAt : null;
    let latestStepAt = mtimeMs;
    if (Number.isFinite(parsedStepAt)) {
      latestStepAt =
        fileActivelyUpdated || mtimeMs - parsedStepAt < 6 * 60 * 60 * 1000
          ? Math.max(parsedStepAt, mtimeMs)
          : parsedStepAt;
    }

    const isFresh = Date.now() - Math.max(latestStepAt || 0, mtimeMs) < 10 * 60 * 1000;
    let inferredPhase = "idle";
    let lastToolName = null;
    if (lastPlanner?.tool_calls?.length) {
      lastToolName = lastPlanner.tool_calls.map((t) => t.name).join(", ");
    }

    if (isFresh) {
      if (last.type === "USER_INPUT" || last.type === "GENERIC" || last.type === "CODE_ACTION") {
        inferredPhase = "waiting_llm";
      } else if (last.type === "PLANNER_RESPONSE") {
        if (last.tool_calls && last.tool_calls.length > 0) {
          inferredPhase = "running_tool";
        } else if (TERMINAL_PLANNER_STATUSES.has(String(last.status || "").toUpperCase())) {
          inferredPhase = "idle";
        } else {
          inferredPhase = "waiting_llm";
        }
      }
    }

    const conv = getOrCreateConv(convId);
    const changed =
      conv.transcript.latestStepIndex !== last.step_index ||
      conv.transcript.inferredPhase !== inferredPhase ||
      conv.transcript.conversationId !== convId ||
      conv.transcript.size !== size ||
      conv.transcript.latestStepAt !== latestStepAt;

    if (
      recordTimeline &&
      inferredPhase === "running_tool" &&
      lastToolName &&
      last.step_index != null &&
      Date.now() - latestStepAt < 15000
    ) {
      const stepKey = `${convId}:${last.step_index}`;
      if (!loggedToolSteps.has(stepKey)) {
        if (loggedToolSteps.size > 200) loggedToolSteps.clear();
        loggedToolSteps.add(stepKey);
        const shortConv = convId && convId !== "default" ? `#${convId.slice(0, 6)}` : "";
        pushTimelineEvent(
          "tool",
          `执行工具: ${lastToolName}`,
          [shortConv, `Step #${last.step_index}`].filter(Boolean).join(" · "),
          "info",
          convId,
          { key: "TOOL_STEP", params: { tools: lastToolName, shortConv, stepIdx: last.step_index } },
        );
      }
    }

    conv.transcript = {
      conversationId: convId,
      filePath,
      mtimeMs,
      size,
      latestStepIndex: last.step_index ?? null,
      latestStepType: last.type || null,
      latestStepStatus: last.status || null,
      latestStepAt,
      latestRecordCreatedAt,
      hasUserExplicit,
      lastToolName,
      tokens: lastPlanner
        ? {
            input: lastPlanner.input_tokens ?? null,
            output: lastPlanner.output_tokens ?? null,
            cacheRead: lastPlanner.cache_read_tokens ?? null,
          }
        : null,
      inferredPhase,
    };

    return changed;
  }

  function isConvActive(conv, now = Date.now()) {
    if (!conv) return false;
    const hActive =
      conv.hook?.phase &&
      conv.hook.phase !== "idle" &&
      conv.hook.lastEventAt &&
      now - conv.hook.lastEventAt < 10 * 60 * 1000;
    const tActive =
      conv.transcript?.inferredPhase &&
      conv.transcript.inferredPhase !== "idle" &&
      conv.transcript.latestStepAt &&
      now - conv.transcript.latestStepAt < 10 * 60 * 1000;
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
    try {
      const p = findTranscriptPathForConv(convId);
      return p ? parseTranscriptFile(convId, p, recordTimeline) : false;
    } catch {
      return false;
    }
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

  function listFallbackFiles() {
    const files = [];
    if (resolvedFallbackHooksDir && existsSync(resolvedFallbackHooksDir)) {
      try {
        for (const name of readdirSync(resolvedFallbackHooksDir).sort()) {
          if (name.endsWith(".json")) {
            files.push(join(resolvedFallbackHooksDir, name));
          }
        }
      } catch {
      }
    }
    if (fallbackHookPath && existsSync(fallbackHookPath)) {
      files.push(fallbackHookPath);
    }
    return files;
  }

  function loadFallbackHookIfNewer() {
    for (const filePath of listFallbackFiles()) {
      try {
        const record = JSON.parse(readFileSync(filePath, "utf8"));
        if (!doesFallbackRecordMatchScope(record, { lsAddress })) continue;
        const convId = record?.payload?.conversationId || "default";
        const conv = getOrCreateConv(convId);
        if (record?.receivedAt && (!conv.hook.lastEventAt || record.receivedAt > conv.hook.lastEventAt)) {
          applyHookEvent(record, false);
        }
      } catch {
      }
    }
  }

  function clearFallbackHook(upToTs = Infinity, { conversationId = null, lsAddress: scopeLs = null } = {}) {
    const targetLs = scopeLs ?? (lsAddress || null);
    for (const filePath of listFallbackFiles()) {
      try {
        let shouldDelete = false;
        const existing = JSON.parse(readFileSync(filePath, "utf8"));
        if (doesFallbackRecordMatchScope(existing, { conversationId, lsAddress: targetLs })) {
          shouldDelete =
            !existing?.receivedAt || !Number.isFinite(upToTs) || existing.receivedAt <= upToTs;
        }
        if (shouldDelete) {
          unlinkSync(filePath);
        }
      } catch {
      }
    }
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

    const okProbes = probes.filter((p) => p.ok);
    const avgLatencyMs = okProbes.length
      ? Math.round(okProbes.reduce((acc, p) => acc + p.latencyMs, 0) / okProbes.length)
      : null;
    const successRate = probes.length
      ? Math.round((okProbes.length / probes.length) * 100)
      : null;

    return {
      now,
      activeConversationId: conv.hook.conversationId || conv.transcript.conversationId || effectiveReqId || null,
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
      events: events.map((ev) => resolveEventText(ev, config?.lang || "zh")),
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
