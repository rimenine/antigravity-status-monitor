import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { doesFallbackRecordMatchScope } from "./runtime-paths.mjs";

/** 解析 `.runtime/hooks` 目录路径（未显式传入时随 legacy `fallbackHookPath` 推导）。 */
export function resolveFallbackHooksDir(fallbackHookPath, fallbackHooksDir = undefined) {
  if (fallbackHooksDir !== undefined) return fallbackHooksDir;
  return fallbackHookPath ? join(dirname(fallbackHookPath), "hooks") : null;
}

/** 列出当前存在的所有降级 Hook 状态文件（包含作用域目录与 legacy 单文件）。 */
export function listFallbackHookFiles({ fallbackHooksDir = null, fallbackHookPath = null } = {}) {
  const files = [];
  if (fallbackHooksDir && existsSync(fallbackHooksDir)) {
    try {
      for (const name of readdirSync(fallbackHooksDir).sort()) {
        if (name.endsWith(".json")) {
          files.push(join(fallbackHooksDir, name));
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

/** 读取属于当前窗口 (`lsAddress`) 作用域的所有降级 Hook 记录。 */
export function readMatchingFallbackHooks({
  fallbackHooksDir = null,
  fallbackHookPath = null,
  lsAddress = "",
} = {}) {
  const records = [];
  for (const filePath of listFallbackHookFiles({ fallbackHooksDir, fallbackHookPath })) {
    try {
      const record = JSON.parse(readFileSync(filePath, "utf8"));
      if (doesFallbackRecordMatchScope(record, { lsAddress })) {
        records.push(record);
      }
    } catch {
    }
  }
  return records;
}

/** 清理已过期或已落入当前作用域内的离线 Hook 降级文件。 */
export function clearMatchingFallbackHooks({
  fallbackHooksDir = null,
  fallbackHookPath = null,
  upToTs = Infinity,
  conversationId = null,
  lsAddress = null,
} = {}) {
  for (const filePath of listFallbackHookFiles({ fallbackHooksDir, fallbackHookPath })) {
    try {
      const existing = JSON.parse(readFileSync(filePath, "utf8"));
      if (!doesFallbackRecordMatchScope(existing, { conversationId, lsAddress })) {
        continue;
      }
      const expired = !existing?.receivedAt || !Number.isFinite(upToTs) || existing.receivedAt <= upToTs;
      if (expired) {
        unlinkSync(filePath);
      }
    } catch {
    }
  }
}
