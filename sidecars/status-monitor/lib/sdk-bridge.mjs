import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function resolveFallbackSdkDir(appDataDir) {
  return join(
    appDataDir || process.env.ANTIGRAVITY_APP_DATA_DIR || join(homedir(), ".gemini", "antigravity"),
    "lib",
    "node_modules",
    "sidecar_sdk",
  );
}

async function loadSdkModule(fallbackSdkDir, skipPackageImport = false) {
  if (!skipPackageImport) {
    try {
      return await import("sidecar_sdk");
    } catch {
    }
  }
  const fallbackEntry = join(fallbackSdkDir, "index.mjs");
  if (existsSync(fallbackEntry)) {
    return await import(pathToFileURL(fallbackEntry).href);
  }
  return null;
}

function loadPreloadContent(fallbackSdkDir, skipPackageImport = false) {
  const candidates = [];
  if (!skipPackageImport) {
    try {
      const resolved = import.meta.resolve("sidecar_sdk/preload.js");
      candidates.push(fileURLToPath(resolved));
    } catch {
    }
  }
  candidates.push(join(fallbackSdkDir, "preload.js"));

  if (!skipPackageImport) {
    try {
      const resolvedIndex = import.meta.resolve("sidecar_sdk");
      candidates.push(join(dirname(fileURLToPath(resolvedIndex)), "preload.js"));
    } catch {
    }
  }

  for (const p of candidates) {
    try {
      if (p && existsSync(p)) {
        return readFileSync(p, "utf8");
      }
    } catch {
    }
  }
  return null;
}

export async function createSdkBridge(options = {}) {
  const fallbackSdkDir = resolveFallbackSdkDir(options.appDataDir);
  const skipPackageImport = Boolean(options.skipPackageImport);
  const sdkMod = await loadSdkModule(fallbackSdkDir, skipPackageImport);
  const preloadJs = loadPreloadContent(fallbackSdkDir, skipPackageImport);
  let sdkApp = null;

  if (sdkMod?.SidecarApp) {
    try {
      sdkApp = new sdkMod.SidecarApp();
    } catch {
      sdkApp = null;
    }
  }

  const metadataCache = new Map();

  async function handleSidecarRoute(pathname, body = {}) {
    if (!sdkApp) {
      return {
        status: 503,
        data: { error: "sidecar_sdk agent bridge unavailable in standalone mode" },
      };
    }

    try {
      if (pathname === "/_sidecar/get-conversation-metadata") {
        const convId = body.conversationId || "";
        const cached = convId ? metadataCache.get(convId) : null;
        if (cached && Date.now() - cached.ts < 60_000) {
          return { status: 200, data: cached.value };
        }
        const value = sdkApp.getConversationMetadata(convId);
        if (convId && value && !value.error) {
          if (metadataCache.size > 50) metadataCache.clear();
          metadataCache.set(convId, { ts: Date.now(), value });
        }
        return { status: 200, data: value };
      }

      if (pathname === "/_sidecar/send-message") {
        const value = sdkApp.sendMessage(body.conversationId, body.message, {
          title: body.title,
          projectId: body.projectId,
        });
        return { status: 200, data: value };
      }

      if (pathname === "/_sidecar/new-conversation") {
        const value = sdkApp.startConversation(body.message, {
          model: body.model,
          projectId: body.projectId,
        });
        return { status: 200, data: value };
      }

      return { status: 404, data: { error: "Unknown sidecar route" } };
    } catch (err) {
      return { status: 500, data: { error: err?.message || "AgentAPI error" } };
    }
  }

  return {
    getPreloadJs: () => preloadJs,
    isSdkReady: () => Boolean(sdkApp),
    config: sdkApp?.config || { projectId: null, conversationId: null },
    handleSidecarRoute,
  };
}
