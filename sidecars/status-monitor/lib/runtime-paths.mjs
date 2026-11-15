import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export function sanitizeScopeSegment(raw, maxLen = 72) {
  return String(raw || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, maxLen);
}

export function buildHookScopeKey({ conversationId = null, lsAddress = null } = {}) {
  if (conversationId) {
    return `conv-${sanitizeScopeSegment(conversationId, 80)}`;
  }
  if (lsAddress) {
    return `ls-${sanitizeScopeSegment(lsAddress, 60)}`;
  }
  return "default";
}

export function resolveServerInstanceFilename(pid, port) {
  return `sidecar-${pid}-${port}.json`;
}

export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return true;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err?.code !== "ESRCH";
  }
}

export function readRegisteredServers({ serverInfoPath, serversDir, pruneDead = false } = {}) {
  const records = [];

  const tryLoad = (filePath, fromServersDir) => {
    if (!filePath || !existsSync(filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      if (!parsed || typeof parsed !== "object" || !parsed.port) return;
      if (parsed.pid && !isPidAlive(parsed.pid)) {
        if (pruneDead && fromServersDir) {
          try {
            unlinkSync(filePath);
          } catch {
          }
        }
        return;
      }
      records.push({ ...parsed, _filePath: filePath, _fromServersDir: fromServersDir });
    } catch {
    }
  };

  if (serversDir && existsSync(serversDir)) {
    try {
      for (const name of readdirSync(serversDir).sort()) {
        if (name.endsWith(".json")) {
          tryLoad(join(serversDir, name), true);
        }
      }
    } catch {
    }
  }
  tryLoad(serverInfoPath, false);

  const byKey = new Map();
  for (const rec of records) {
    const key = `${rec.pid || "nopid"}:${rec.port}`;
    const prev = byKey.get(key);
    if (
      !prev ||
      (rec._fromServersDir && !prev._fromServersDir) ||
      (rec.startedAt || 0) >= (prev.startedAt || 0)
    ) {
      byKey.set(key, rec);
    }
  }
  return [...byKey.values()].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

export function selectTargetServers(candidates, { conversationId = null, lsAddress = null } = {}) {
  if (!candidates || candidates.length === 0) return [];

  if (conversationId) {
    const exactConv = candidates.filter(
      (c) => c.conversationId && c.conversationId === conversationId,
    );
    if (exactConv.length > 0) return exactConv;
  }

  if (lsAddress) {
    const exactLs = candidates.filter((c) => c.lsAddress && c.lsAddress === lsAddress);
    if (exactLs.length > 0) return exactLs;
    return candidates.filter((c) => !c.lsAddress);
  }

  return candidates;
}

export function doesFallbackRecordMatchScope(
  record,
  { conversationId = null, lsAddress = null } = {},
) {
  if (!record || typeof record !== "object") return false;
  const recConv = record?.payload?.conversationId || null;
  const recLs = record?.lsAddress || null;
  if (lsAddress && recLs && recLs !== lsAddress) return false;
  if (conversationId && recConv && recConv !== conversationId) return false;
  return true;
}
