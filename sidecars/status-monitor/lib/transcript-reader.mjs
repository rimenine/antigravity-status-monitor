import { closeSync, openSync, readSync, statSync } from "node:fs";

const TRANSCRIPT_STALE_MS = 10 * 60 * 1000;
const CLOCK_SKEW_WINDOW_MS = 6 * 60 * 60 * 1000;

export const TERMINAL_PLANNER_STATUSES = new Set([
  "DONE",
  "ERROR",
  "CANCELLED",
  "CANCELED",
  "FAILED",
  "ABORTED",
  "STOPPED",
]);

export const WAITING_LLM_STEP_TYPES = new Set([
  "USER_INPUT",
  "GENERIC",
  "CODE_ACTION",
  "RUN_COMMAND",
  "VIEW_FILE",
  "SEARCH_WEB",
  "LIST_DIRECTORY",
  "GREP_SEARCH",
  "READ_URL_CONTENT",
  "SYSTEM_MESSAGE",
  "EPHEMERAL_MESSAGE",
  "CHECKPOINT",
  "CONVERSATION_HISTORY",
  "ERROR_MESSAGE",
]);

/** 构建空 Hook 状态结构。 */
export function createEmptyHook(conversationId = null) {
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

/** 构建空 Transcript 状态结构。 */
export function createEmptyTranscript(conversationId = null) {
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
    latestError: null,
    tokens: null,
    inferredPhase: "idle",
  };
}

function readSingleJsonLine(fd, start, length) {
  if (length <= 0) return [];
  const lineBuf = Buffer.allocUnsafe(length);
  const rn = readSync(fd, lineBuf, 0, length, start);
  try {
    return [JSON.parse(lineBuf.subarray(0, rn).toString("utf8").trim())];
  } catch {
    return [];
  }
}

/** 从文件末尾反向扫描最后一行完整 JSON 记录（用于超大单行兜底）。 */
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
          return readSingleJsonLine(fd, lineStart, lineLen);
        }
      } else if (buf[idx] !== 0x0d && buf[idx] !== 0x20 && buf[idx] !== 0x09) {
        trailingEmpty = false;
      }
      idx -= 1;
    }
    pos = start;
  }

  if (minPos === 0 && lineEnd > 0) {
    return readSingleJsonLine(fd, 0, lineEnd);
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

/** 按指数放大窗口从 Transcript 尾部读取 JSONL 记录，确保覆盖到 PLANNER_RESPONSE。 */
export function readTailLines(filePath, stat, initialBytes = 32768, maxBytes = 16 * 1024 * 1024) {
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

/** 解析 Transcript 中 ERROR_MESSAGE 记录的错误分类、重试次数与脱敏原因。 */
export function parseTranscriptError(record) {
  if (!record || record.type !== "ERROR_MESSAGE") return null;
  const rawFull = String(record.error || record.content || "").trim();
  if (!rawFull) {
    return {
      kind: "unknown",
      attempt: null,
      shortReason: "API error",
      raw: "",
    };
  }

  const attemptMatch = rawFull.match(/\battempt\s+(\d+)\b/i);
  const attempt = attemptMatch ? Number(attemptMatch[1]) : null;
  const lower = rawFull.toLowerCase();

  let kind = "api_error";
  let shortReason = "";
  if (
    lower.includes("wsasend") ||
    lower.includes("forcibly closed") ||
    lower.includes("connection reset") ||
    lower.includes("broken pipe") ||
    lower.includes("econnreset")
  ) {
    kind = "upload_reset";
    shortReason = lower.includes("wsasend")
      ? "wsasend: connection forcibly closed"
      : "connection reset by peer";
  } else if (
    lower.includes("stream idle timeout") ||
    lower.includes("context deadline exceeded") ||
    lower.includes("timed out")
  ) {
    kind = "stream_timeout";
    const tm = rawFull.match(/stream idle timeout\s*\(([^)]+)\)/i);
    shortReason = tm ? `stream idle timeout (${tm[1]})` : "upstream request timeout";
  } else if (lower.includes("stream was interrupted")) {
    kind = "stream_interrupted";
    shortReason = "stream interrupted";
  } else if (lower.includes(": eof") || /\beof\b/i.test(rawFull)) {
    kind = "upstream_eof";
    shortReason = "upstream EOF";
  } else if (
    lower.includes("model unreachable") ||
    lower.includes("dial tcp") ||
    lower.includes("no such host") ||
    lower.includes("connection refused")
  ) {
    kind = "network_error";
    shortReason = "model API unreachable";
  } else if (lower.includes("parsing the tool call")) {
    kind = "tool_parse";
    shortReason = "tool call parse error";
  } else {
    const cleaned = rawFull
      .replace(/Post\s+"https?:\/\/[^"]+":?\s*/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    shortReason = (cleaned || "API error").slice(0, 96);
  }

  return {
    kind,
    attempt,
    shortReason,
    raw: rawFull.slice(0, 240),
  };
}

/** 根据最后一条记录与文件新鲜度推断当前所处阶段。 */
export function inferTranscriptPhase(last, isFresh) {
  if (!isFresh || !last) return "idle";
  if (WAITING_LLM_STEP_TYPES.has(last.type)) {
    return "waiting_llm";
  }
  if (last.type === "PLANNER_RESPONSE") {
    if (last.tool_calls && last.tool_calls.length > 0) {
      return "running_tool";
    }
    if (TERMINAL_PLANNER_STATUSES.has(String(last.status || "").toUpperCase())) {
      return "idle";
    }
    return "waiting_llm";
  }
  return "idle";
}

/** 读取并解析单个 Transcript 文件的最新步骤与推断阶段。 */
export function parseTranscriptSnapshot(filePath, convId, prevTranscript = null, now = Date.now()) {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return { status: "missing" };
  }

  if (
    prevTranscript &&
    prevTranscript.filePath === filePath &&
    prevTranscript.mtimeMs === stat.mtimeMs &&
    prevTranscript.size === stat.size
  ) {
    const idleExpired =
      prevTranscript.inferredPhase !== "idle" &&
      now - Math.max(prevTranscript.latestStepAt || 0, prevTranscript.mtimeMs || 0) >= TRANSCRIPT_STALE_MS;
    return { status: idleExpired ? "stale-idle" : "unchanged" };
  }

  // 若文件本次确实发生了追加或修改，说明是刚写入的新步骤，即使用户日志 created_at 偏早也应计为最新活动时间。
  const fileActivelyUpdated =
    Boolean(prevTranscript) &&
    prevTranscript.filePath === filePath &&
    (prevTranscript.size !== stat.size ||
      (prevTranscript.mtimeMs != null && stat.mtimeMs > prevTranscript.mtimeMs));

  const { mtimeMs, size, parsed } = readTailLines(filePath, stat);
  if (parsed.length === 0) return { status: "empty" };

  const last = parsed[parsed.length - 1];
  const lastPlanner = [...parsed].reverse().find((x) => x.type === "PLANNER_RESPONSE");
  const hasUserExplicit = Boolean(
    prevTranscript?.hasUserExplicit || parsed.some((x) => x.source === "USER_EXPLICIT"),
  );
  const parsedStepAt = last.created_at ? Date.parse(last.created_at) : NaN;
  const latestRecordCreatedAt = Number.isFinite(parsedStepAt) ? parsedStepAt : null;
  let latestStepAt = mtimeMs;
  if (Number.isFinite(parsedStepAt)) {
    latestStepAt =
      fileActivelyUpdated || mtimeMs - parsedStepAt < CLOCK_SKEW_WINDOW_MS
        ? Math.max(parsedStepAt, mtimeMs)
        : parsedStepAt;
  }

  const isFresh = now - Math.max(latestStepAt || 0, mtimeMs) < TRANSCRIPT_STALE_MS;
  const inferredPhase = inferTranscriptPhase(last, isFresh);
  const latestError = parseTranscriptError(last);
  const lastToolName = lastPlanner?.tool_calls?.length
    ? lastPlanner.tool_calls.map((t) => t.name).join(", ")
    : null;

  return {
    status: "updated",
    lastStepIndex: last.step_index ?? null,
    lastToolName,
    latestStepAt,
    transcript: {
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
      latestError,
      tokens: lastPlanner
        ? {
            input: lastPlanner.input_tokens ?? null,
            output: lastPlanner.output_tokens ?? null,
            cacheRead: lastPlanner.cache_read_tokens ?? null,
          }
        : null,
      inferredPhase,
    },
  };
}
