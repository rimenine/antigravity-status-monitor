import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureRuntimeDir, SERVER_INFO_PATH, SERVERS_DIR } from "./config.mjs";
import { readRegisteredServers, resolveServerInstanceFilename } from "./runtime-paths.mjs";

function serializeServerRecord(rec) {
  return {
    port: rec.port,
    pid: rec.pid,
    startedAt: rec.startedAt,
    hookToken: rec.hookToken,
    lsAddress: rec.lsAddress || null,
    conversationId: rec.conversationId || null,
  };
}

/** 解决多窗口 `.runtime/servers` 注册表目录路径，保持与 legacy `serverInfoPath` 对齐。 */
export function resolveServersDir(serverInfoPath, serversDir = undefined) {
  if (serversDir !== undefined) return serversDir;
  if (serverInfoPath === SERVER_INFO_PATH) return SERVERS_DIR;
  return serverInfoPath ? join(dirname(serverInfoPath), "servers") : null;
}

/** 管理当前 Sidecar 实例的 `.runtime/servers/*.json` 与兼容文件 `server.json` 生命周期。 */
export function createServerRegistry({
  writeServerInfo = true,
  serverInfoPath = SERVER_INFO_PATH,
  serversDir = undefined,
} = {}) {
  const resolvedServersDir = resolveServersDir(serverInfoPath, serversDir);
  let activeInstancePath = null;
  let listeningPort = null;
  let wroteLegacyServerInfo = false;

  function writeRegistration(rawRecord) {
    listeningPort = rawRecord.port;
    if (!writeServerInfo || (!serverInfoPath && !resolvedServersDir)) {
      return;
    }

    const record = serializeServerRecord(rawRecord);
    if (resolvedServersDir) {
      mkdirSync(resolvedServersDir, { recursive: true });
      activeInstancePath = join(
        resolvedServersDir,
        resolveServerInstanceFilename(record.pid, record.port),
      );
      writeFileSync(activeInstancePath, JSON.stringify(record, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
    }
    if (serverInfoPath) {
      if (serverInfoPath === SERVER_INFO_PATH) ensureRuntimeDir();
      else mkdirSync(dirname(serverInfoPath), { recursive: true });
      writeFileSync(serverInfoPath, JSON.stringify(record, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
      wroteLegacyServerInfo = true;
    }
  }

  function cleanup() {
    if (!writeServerInfo) return;
    if (activeInstancePath) {
      try {
        if (existsSync(activeInstancePath)) {
          unlinkSync(activeInstancePath);
        }
      } catch {
      }
      activeInstancePath = null;
    }

    const ownedPort = listeningPort;
    const ownedLegacy = wroteLegacyServerInfo;
    listeningPort = null;
    wroteLegacyServerInfo = false;
    if (!serverInfoPath || !ownedLegacy) return;

    try {
      if (!existsSync(serverInfoPath)) return;
      const info = JSON.parse(readFileSync(serverInfoPath, "utf8"));
      if (info?.pid !== process.pid || (ownedPort && info?.port && info.port !== ownedPort)) {
        return;
      }
      const remaining = resolvedServersDir
        ? readRegisteredServers({ serversDir: resolvedServersDir, pruneDead: true })
        : [];
      if (remaining.length > 0) {
        writeFileSync(
          serverInfoPath,
          JSON.stringify(serializeServerRecord(remaining[0]), null, 2),
          { encoding: "utf8", mode: 0o600 },
        );
      } else {
        unlinkSync(serverInfoPath);
      }
    } catch {
    }
  }

  return {
    writeRegistration,
    cleanup,
  };
}
