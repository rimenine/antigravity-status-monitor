import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_ALERT_LOG_MAX_BYTES = 64 * 1024;
export const DEFAULT_ALERT_LOG_KEEP_LINES = 120;

const OPTIONAL_FIELDS = [
  "reason",
  "message",
  "simulated",
  "notified",
  "convId",
  "error",
  "lsRunning",
  "healthz",
  "latencyMs",
];

function compactAlertEntry(entry = {}) {
  const payload = {
    ts: new Date(entry.ts ?? Date.now()).toISOString(),
    type: String(entry.type || "EVENT"),
  };
  for (const key of OPTIONAL_FIELDS) {
    if (entry[key] !== undefined && entry[key] !== null && entry[key] !== "") {
      payload[key] = entry[key];
    }
  }
  return payload;
}

/**
 * 创建有界 JSONL 预警事件日志记录器。
 * 写入失败时静默降级，避免影响主探测循环与状态服务。
 */
export function createAlertLogger({
  logPath = "",
  maxBytes = DEFAULT_ALERT_LOG_MAX_BYTES,
  keepLines = DEFAULT_ALERT_LOG_KEEP_LINES,
} = {}) {
  if (!logPath) {
    return {
      logPath: "",
      append() {},
      readRecent() {
        return [];
      },
    };
  }

  function trimIfNeeded() {
    if (!maxBytes || !keepLines || !existsSync(logPath)) return;
    const size = statSync(logPath).size;
    if (size <= maxBytes) return;
    const lines = readFileSync(logPath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    if (lines.length <= keepLines) return;
    const retained = lines.slice(-keepLines);
    writeFileSync(logPath, `${retained.join("\n")}\n`, "utf8");
  }

  function append(entry) {
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      const payload = compactAlertEntry(entry);
      appendFileSync(logPath, `${JSON.stringify(payload)}\n`, "utf8");
      trimIfNeeded();
    } catch {
      // 日志写入失败不应中断状态监控
    }
  }

  function readRecent(limit = 50) {
    try {
      if (!existsSync(logPath)) return [];
      const lines = readFileSync(logPath, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .slice(-Math.max(1, limit));
      const records = [];
      for (const line of lines) {
        try {
          records.push(JSON.parse(line));
        } catch {
          // 跳过单行损坏记录
        }
      }
      return records;
    } catch {
      return [];
    }
  }

  return { logPath, append, readRecent };
}
