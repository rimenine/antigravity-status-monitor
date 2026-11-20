import { closeSync, openSync, readSync, statSync } from "node:fs";
import {
  ABORTED_PLANNER_STATUSES,
  hasPendingBackgroundTask,
  hasPendingParallelTools,
  inferTranscriptPhase,
  parseTranscriptError,
  TERMINAL_PLANNER_STATUSES,
  WAITING_LLM_STEP_TYPES,
} from "./transcript-phase.mjs";

export {
  ABORTED_PLANNER_STATUSES,
  hasPendingBackgroundTask,
  hasPendingParallelTools,
  inferTranscriptPhase,
  parseTranscriptError,
  TERMINAL_PLANNER_STATUSES,
  WAITING_LLM_STEP_TYPES,
};

const TRANSCRIPT_STALE_MS = 10 * 60 * 1000;
const ERROR_STALE_MS = 3 * 60 * 1000;
const CLOCK_SKEW_WINDOW_MS = 2 * 60 * 1000;

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
    fullyIdle: null,
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
    const staleMs = prevTranscript.latestStepType === "ERROR_MESSAGE" ? ERROR_STALE_MS : TRANSCRIPT_STALE_MS;
    const refActivityAt = prevTranscript.latestStepAt ?? prevTranscript.mtimeMs ?? 0;
    const idleExpired = prevTranscript.inferredPhase !== "idle" && now - refActivityAt >= staleMs;
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

  const staleMs = last.type === "ERROR_MESSAGE" ? ERROR_STALE_MS : TRANSCRIPT_STALE_MS;
  const effectiveActivityAt = Number.isFinite(latestStepAt) ? latestStepAt : mtimeMs;
  const isFresh = now - effectiveActivityAt < staleMs;
  const inferredPhase = inferTranscriptPhase(last, isFresh, parsed);
  const latestError = isFresh ? parseTranscriptError(last) : null;
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
