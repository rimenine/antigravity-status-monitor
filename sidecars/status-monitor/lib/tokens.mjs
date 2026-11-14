import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const fileCache = new Map();
const collectCache = new Map();
const CHUNK_BYTES = 256 * 1024;
const MAX_FILE_CACHE = 500;

export function resolveTranscriptLogPath(rootOrLogsDir, convId = null) {
  if (!rootOrLogsDir) return null;
  const logsDir = convId
    ? join(rootOrLogsDir, convId, ".system_generated", "logs")
    : rootOrLogsDir;
  const primary = join(logsDir, "transcript.jsonl");
  if (existsSync(primary)) return primary;
  const fullFallback = join(logsDir, "transcript_full.jsonl");
  if (existsSync(fullFallback)) return fullFallback;
  return null;
}

function localDateKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function emptyBucket() {
  return {
    calls: 0,
    input: 0,
    cacheRead: 0,
    output: 0,
    total: 0,
  };
}

function addBucket(target, source) {
  target.calls += source.calls;
  target.input += source.input;
  target.cacheRead += source.cacheRead;
  target.output += source.output;
  target.total += source.total;
}

function computeCacheHitRate(input, cacheRead) {
  const denom = input + cacheRead;
  if (denom <= 0) return null;
  return Math.round((cacheRead / denom) * 1000) / 10;
}

function createEmptyParserState() {
  return {
    parsedOffset: 0,
    session: emptyBucket(),
    daily: new Map(),
    lastCall: null,
  };
}

function cloneParserState(state) {
  const daily = new Map();
  for (const [k, v] of state.daily.entries()) {
    daily.set(k, { ...v });
  }
  return {
    parsedOffset: state.parsedOffset,
    session: { ...state.session },
    daily,
    lastCall: state.lastCall ? { ...state.lastCall } : null,
  };
}

function parseLinesIntoState(text, fallbackTs, state) {
  for (const line of text.split(/\r?\n/)) {
    if (!line || !line.includes("PLANNER_RESPONSE")) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== "PLANNER_RESPONSE") continue;

    const inp = Number(obj.input_tokens) || 0;
    const cache = Number(obj.cache_read_tokens) || 0;
    const out = Number(obj.output_tokens) || 0;
    const tot = inp + cache + out;

    state.session.calls += 1;
    state.session.input += inp;
    state.session.cacheRead += cache;
    state.session.output += out;
    state.session.total += tot;

    state.lastCall = {
      stepIndex: obj.step_index ?? null,
      input: inp,
      cacheRead: cache,
      output: out,
      contextTotal: inp + cache,
    };

    const ts = obj.created_at ? Date.parse(obj.created_at) : fallbackTs;
    const key = localDateKey(Number.isFinite(ts) ? ts : fallbackTs);
    let bucket = state.daily.get(key);
    if (!bucket) {
      bucket = emptyBucket();
      state.daily.set(key, bucket);
    }
    bucket.calls += 1;
    bucket.input += inp;
    bucket.cacheRead += cache;
    bucket.output += out;
    bucket.total += tot;
  }
}

function readSlice(fd, offset, length) {
  if (length <= 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(length);
  const n = readSync(fd, buf, 0, length, offset);
  return n === length ? buf : Buffer.from(buf.subarray(0, n));
}

export function parseTranscriptTokens(filePath) {
  if (!filePath || !existsSync(filePath)) return null;

  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return null;
  }

  const cached = fileCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.summary;
  }

  let state = createEmptyParserState();
  let leftover = Buffer.alloc(0);

  try {
    const fd = openSync(filePath, "r");
    try {
      let canAppend = Boolean(
        cached &&
          cached.state.parsedOffset > 0 &&
          stat.size > cached.state.parsedOffset &&
          (!cached.ino || !stat.ino || cached.ino === stat.ino),
      );
      if (canAppend && cached.headFp && cached.tailFp) {
        // 仅靠 size 变大或 inode 相同无法防原位覆写，复核上次已解析区间的首尾字节指纹一致才增量追加
        const curHead = readSlice(fd, 0, cached.headFp.length);
        const curTail = readSlice(
          fd,
          Math.max(0, cached.state.parsedOffset - cached.tailFp.length),
          cached.tailFp.length,
        );
        if (!curHead.equals(cached.headFp) || !curTail.equals(cached.tailFp)) {
          canAppend = false;
        }
      }
      if (canAppend) {
        state = cloneParserState(cached.state);
      }

      if (stat.size > state.parsedOffset) {
        let readPos = state.parsedOffset;
        const chunkBuf = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, stat.size - readPos));
        while (readPos < stat.size) {
          const toRead = Math.min(chunkBuf.length, stat.size - readPos);
          const n = readSync(fd, chunkBuf, 0, toRead, readPos);
          if (n <= 0) break;
          readPos += n;
          const slice = chunkBuf.subarray(0, n);
          const combined = leftover.length > 0 ? Buffer.concat([leftover, slice]) : slice;
          // 在 UTF-8 解码前按换行字节 0x0a 对齐切块，防止固定缓冲把多字节中文或末尾半行 JSON 劈断
          const lastNl = combined.lastIndexOf(0x0a);
          if (lastNl !== -1) {
            const completeText = combined.subarray(0, lastNl + 1).toString("utf8");
            parseLinesIntoState(completeText, stat.mtimeMs, state);
            state.parsedOffset += lastNl + 1;
            leftover = Buffer.from(combined.subarray(lastNl + 1));
          } else {
            leftover = Buffer.from(combined);
          }
        }
      }

      const headLen = Math.min(512, state.parsedOffset);
      const tailLen = Math.min(256, state.parsedOffset);
      const headFp = headLen > 0 ? readSlice(fd, 0, headLen) : null;
      const tailFp = tailLen > 0 ? readSlice(fd, state.parsedOffset - tailLen, tailLen) : null;

      let finalState = state;
      if (leftover.length > 0) {
        finalState = cloneParserState(state);
        parseLinesIntoState(leftover.toString("utf8"), stat.mtimeMs, finalState);
      }

      const summary = {
        session: {
          ...finalState.session,
          cacheHitRate: computeCacheHitRate(finalState.session.input, finalState.session.cacheRead),
        },
        lastCall: finalState.lastCall,
        daily: finalState.daily,
      };

      if (!fileCache.has(filePath) && fileCache.size >= MAX_FILE_CACHE) {
        fileCache.delete(fileCache.keys().next().value);
      }
      fileCache.set(filePath, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        ino: stat.ino || 0,
        headFp,
        tailFp,
        state,
        summary,
      });

      return summary;
    } finally {
      closeSync(fd);
    }
  } catch {
    return cached?.summary || null;
  }
}

export function collectTokenStats(
  brainDirs,
  activeTranscriptPath,
  nowTs = Date.now(),
  { cacheTtlMs = 4000 } = {},
) {
  const todayKey = localDateKey(nowTs);
  const resolvedActive = activeTranscriptPath ? resolve(activeTranscriptPath) : "";
  const activeDir = resolvedActive ? dirname(resolvedActive) : "";
  const dirKey = `${todayKey}::${resolvedActive}::${brainDirs.filter(Boolean).join("|")}`;
  const cachedAll = cacheTtlMs > 0 ? collectCache.get(dirKey) : null;

  let othersToday;
  let othersAllTime;
  let othersSessionsToday;
  let othersTotalSessions;

  if (cachedAll && Date.now() - cachedAll.at < cacheTtlMs) {
    ({ othersToday, othersAllTime, othersSessionsToday, othersTotalSessions } = cachedAll);
  } else {
    othersToday = emptyBucket();
    othersAllTime = emptyBucket();
    othersSessionsToday = 0;
    othersTotalSessions = 0;

    const seenPaths = new Set();
    for (const brainDir of brainDirs) {
      if (!brainDir || !existsSync(brainDir)) continue;
      let dirs;
      try {
        dirs = readdirSync(brainDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const logsDir = join(brainDir, d.name, ".system_generated", "logs");
        if (activeDir && resolve(logsDir) === activeDir) continue;
        const p = resolveTranscriptLogPath(logsDir);
        if (!p) continue;
        const normPath = resolve(p);
        if (seenPaths.has(normPath)) continue;
        seenPaths.add(normPath);

        const parsed = parseTranscriptTokens(p);
        if (!parsed) continue;
        if (parsed.session.calls > 0) {
          othersTotalSessions += 1;
          addBucket(othersAllTime, parsed.session);
        }

        const tb = parsed.daily.get(todayKey);
        if (tb && tb.calls > 0) {
          othersSessionsToday += 1;
          addBucket(othersToday, tb);
        }
      }
    }

    if (cacheTtlMs > 0) {
      if (collectCache.size >= 32) collectCache.clear();
      collectCache.set(dirKey, {
        at: Date.now(),
        othersToday,
        othersAllTime,
        othersSessionsToday,
        othersTotalSessions,
      });
    }
  }

  const activeParsed = activeTranscriptPath ? parseTranscriptTokens(activeTranscriptPath) : null;
  const today = { ...othersToday };
  const allTime = { ...othersAllTime };
  let sessionCountToday = othersSessionsToday;
  let totalSessions = othersTotalSessions;

  if (activeParsed) {
    if (activeParsed.session.calls > 0) {
      totalSessions += 1;
      addBucket(allTime, activeParsed.session);
    }
    const activeToday = activeParsed.daily.get(todayKey);
    if (activeToday && activeToday.calls > 0) {
      sessionCountToday += 1;
      addBucket(today, activeToday);
    }
  }

  return {
    todayDate: todayKey,
    lastCall: activeParsed?.lastCall || null,
    session: activeParsed?.session || { ...emptyBucket(), cacheHitRate: null },
    today: {
      ...today,
      sessions: sessionCountToday,
      cacheHitRate: computeCacheHitRate(today.input, today.cacheRead),
    },
    allTime: {
      ...allTime,
      sessions: totalSessions,
      cacheHitRate: computeCacheHitRate(allTime.input, allTime.cacheRead),
    },
  };
}
