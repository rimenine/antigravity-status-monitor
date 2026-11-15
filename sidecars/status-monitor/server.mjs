import http from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAlertLogger } from "./lib/alert-logger.mjs";
import {
  applyConfigPatch,
  CONFIG_PATH,
  loadConfig,
  LS_ADDRESS,
  PUBLIC_DIR,
  resolveAlertLogPath,
  sanitizeConfigForClient,
  SERVER_INFO_PATH,
} from "./lib/config.mjs";
import {
  BASE_SECURITY_HEADERS,
  readJsonBody,
  sendJson,
  sendPreloadScript,
  sendStaticAsset,
} from "./lib/http-helpers.mjs";
import { sendDesktopNotification } from "./lib/notify.mjs";
import { createProbeCoordinator } from "./lib/probe-coordinator.mjs";
import { probePaths } from "./lib/probe.mjs";
import { getLsEndpoints, inspectLanguageServer } from "./lib/process-probe.mjs";
import { createSdkBridge } from "./lib/sdk-bridge.mjs";
import { createSecurityGuard, isAllowedHost } from "./lib/security.mjs";
import { createServerRegistry } from "./lib/server-registry.mjs";
import { createSseHub } from "./lib/sse-hub.mjs";
import { createStateStore } from "./lib/state-store.mjs";
import { normalizeConvId } from "./lib/timeline-store.mjs";

function createInitialLsState() {
  return {
    running: null,
    pids: [],
    lsPid: null,
    matchedByPort: false,
    established443: 0,
    synSent443: 0,
    proxyConns: 0,
    tunDetected: false,
    localIps: [],
    route: null,
    endpoints: null,
    healthz: { reachable: null, instanceId: null },
  };
}

/** 创建 Antigravity Status Monitor Sidecar 服务实例（组合存储、探针、安全鉴权与 HTTP 路由）。 */
export async function createStatusServer({
  configPath = CONFIG_PATH,
  serverInfoPath = SERVER_INFO_PATH,
  serversDir = undefined,
  brainDirs,
  fallbackHookPath = undefined,
  fallbackHooksDir = undefined,
  uiToken,
  hookToken,
  lsAddress = LS_ADDRESS,
  sdkBridgeImpl = null,
  probePathsFn = probePaths,
  inspectLsFn = inspectLanguageServer,
  getLsEndpointsFn = getLsEndpoints,
  notifyFn = sendDesktopNotification,
  alertLogPath = undefined,
  disableSchedulers = false,
  writeServerInfo = true,
  exitFn = (code) => process.exit(code),
} = {}) {
  const config = loadConfig(configPath);
  const alertLogger = createAlertLogger({
    logPath: alertLogPath ?? resolveAlertLogPath(configPath),
  });
  const registry = createServerRegistry({ writeServerInfo, serverInfoPath, serversDir });
  const security = createSecurityGuard({ uiToken, hookToken });
  const sdkBridge = sdkBridgeImpl || (await createSdkBridge());
  const defaultConvId = normalizeConvId(sdkBridge.config?.conversationId);
  const store = createStateStore({
    brainDirs,
    fallbackHookPath,
    fallbackHooksDir,
    lsAddress,
    defaultConvId,
  });

  const runtime = {
    probes: [],
    consecutiveFailures: 0,
    lastProxyConfig: null,
    lastKnownLsRoute: null,
    lsEndpoints: null,
    ls: createInitialLsState(),
    simulation: {
      active: false,
      expiresAt: null,
      convId: null,
    },
  };

  function resolveEffectiveConvId(rawConvId) {
    return normalizeConvId(rawConvId) || defaultConvId || null;
  }

  function getSnapshot(requestedConvId = null) {
    const effectiveConvId = resolveEffectiveConvId(requestedConvId);
    const snap = store.buildSnapshot({
      probes: runtime.probes,
      consecutiveFailures: runtime.consecutiveFailures,
      ls: runtime.ls,
      simulation: runtime.simulation,
      config: sanitizeConfigForClient(config),
      requestedConvId: effectiveConvId,
    });
    return {
      ...snap,
      proxyConfig: runtime.lastProxyConfig,
    };
  }

  const sseHub = createSseHub({
    getSnapshot,
    getSdkConvId: () => sdkBridge.config.conversationId,
  });

  const coordinator = createProbeCoordinator({
    config,
    store,
    runtime,
    lsAddress,
    probePathsFn,
    inspectLsFn,
    getLsEndpointsFn,
    notifyFn,
    alertLogger,
    disableSchedulers,
    onHealthDead: () => {
      registry.cleanup();
      exitFn(0);
    },
    onStateChanged: (opts) => sseHub.broadcastState(opts),
    getPreferredConvId: () => sseHub.getPreferredConvId(),
  });

  function handleStatusOrEventsGet(req, res, url) {
    const boundConvId = resolveEffectiveConvId(url.searchParams.get("conversationId"));
    const recordTimeline = url.pathname === "/api/status";
    // 优先吸收匹配窗口作用域的降级 Hook 文件（防止启动期 / 重启竞态漏事件）
    store.loadFallbackHookIfNewer();
    if (boundConvId) {
      sseHub.recordRequestedConv(boundConvId);
      store.refreshTranscript(boundConvId, recordTimeline);
    }

    if (url.pathname === "/api/status") {
      sendJson(res, 200, {
        ...getSnapshot(boundConvId),
        security: {
          uiTokenEnforced: security.hasUiToken,
          sdkReady: sdkBridge.isSdkReady(),
        },
      });
      return;
    }

    sseHub.attachClient(req, res, boundConvId);
  }

  async function handleHookPost(req, res) {
    const auth = security.verifyHookPost(req);
    if (!auth.ok) {
      sendJson(res, auth.status, { ok: false, error: auth.error });
      return;
    }
    try {
      const body = await readJsonBody(req);
      const hookConvId = normalizeConvId(body?.payload?.conversationId);
      store.applyHookEvent(body, true);
      store.clearFallbackHook(body?.receivedAt ?? Infinity, {
        conversationId: hookConvId,
        lsAddress: body?.lsAddress || null,
      });
      sendJson(res, 200, { ok: true });
      setImmediate(() => {
        try {
          if (hookConvId) {
            store.refreshTranscript(hookConvId, true);
          }
          sseHub.broadcastState();
        } catch {
        }
      });
    } catch (err) {
      sendJson(res, err.status || 400, { ok: false, error: err.message }, req);
    }
  }

  async function handleUiPost(req, res, url) {
    const auth = security.verifyUiPost(req, url);
    if (!auth.ok) {
      sendJson(res, auth.status, { ok: false, error: auth.error });
      return;
    }

    if (url.pathname.startsWith("/_sidecar/")) {
      try {
        const body = await readJsonBody(req);
        const result = await sdkBridge.handleSidecarRoute(url.pathname, body);
        sendJson(res, result.status, result.data);
      } catch (err) {
        sendJson(res, err.status || 400, { ok: false, error: err.message }, req);
      }
      return;
    }

    if (url.pathname === "/api/probe") {
      try {
        const result = await coordinator.runProbeOnce({ forceRefresh: true });
        sendJson(res, 200, { ok: true, result });
      } catch (err) {
        sendJson(res, err.status || 500, { ok: false, error: err.message });
      }
      return;
    }

    if (url.pathname === "/api/config") {
      try {
        const patch = await readJsonBody(req);
        const prevProbeUrl = config.probeUrl;
        const prevManualProxy = config.manualProxyUrl;
        applyConfigPatch(config, patch, { configPath, strict: true });
        if (config.probeUrl !== prevProbeUrl || config.manualProxyUrl !== prevManualProxy) {
          coordinator.invalidateOnProxyOrTargetChange();
        }
        coordinator.resetProbeScheduler();
        sseHub.broadcastState({ force: true });
        sendJson(res, 200, { ok: true, config: sanitizeConfigForClient(config) });
      } catch (err) {
        sendJson(
          res,
          err.status || 400,
          { ok: false, error: err.code || err.message, detail: err.message },
          req,
        );
      }
      return;
    }

    if (url.pathname === "/api/simulate") {
      try {
        const body = await readJsonBody(req);
        const simConvId = resolveEffectiveConvId(
          body.conversationId ?? url.searchParams.get("conversationId"),
        );
        const enable = body.active !== undefined ? Boolean(body.active) : !runtime.simulation.active;
        runtime.simulation.active = enable;
        runtime.simulation.expiresAt = enable ? Date.now() + 15000 : null;
        runtime.simulation.convId = enable ? simConvId : null;
        if (enable) {
          store.pushTimelineEvent(
            "sim",
            "开启断网警报预览",
            "持续 15 秒，可随时点击关闭",
            "warn",
            simConvId,
            { key: "SIM_ON" },
          );
        } else {
          store.pushTimelineEvent("sim", "关闭断网警报预览", "", "info", simConvId, { key: "SIM_OFF" });
        }
        coordinator.onSimulationToggle(enable, { convId: simConvId });
        sseHub.broadcastState({ force: true });
        sendJson(res, 200, { ok: true, simulation: runtime.simulation });
      } catch (err) {
        sendJson(res, err.status || 400, { ok: false, error: err.message }, req);
      }
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  }

  const server = http.createServer(async (req, res) => {
    if (!isAllowedHost(req)) {
      sendJson(res, 403, { ok: false, error: "Forbidden host" });
      return;
    }

    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (req.method === "GET") {
      if (url.pathname === "/preload.js") {
        sendPreloadScript(sdkBridge.getPreloadJs(), res);
        return;
      }
      if (sendStaticAsset(url.pathname, PUBLIC_DIR, res)) {
        return;
      }
      if (url.pathname === "/favicon.ico") {
        res.writeHead(204, BASE_SECURITY_HEADERS);
        res.end();
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        const auth = security.verifyUiGet(req, url);
        if (!auth.ok) {
          sendJson(res, auth.status, { ok: false, error: auth.error });
          return;
        }
      }
      if (url.pathname === "/api/status" || url.pathname === "/api/events") {
        handleStatusOrEventsGet(req, res, url);
        return;
      }
    }

    if (req.method === "POST") {
      if (url.pathname === "/api/hook") {
        await handleHookPost(req, res);
        return;
      }
      await handleUiPost(req, res, url);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  });

  function listen(port = 0, host = "127.0.0.1") {
    return new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(port, host, () => {
        server.off("error", rejectListen);
        const actualPort = server.address().port;
        registry.writeRegistration({
          port: actualPort,
          pid: process.pid,
          startedAt: Date.now(),
          hookToken: security.hookToken,
          lsAddress: lsAddress || null,
          conversationId: sdkBridge.config.conversationId || null,
        });
        coordinator.startSchedulers({
          getPinnedConvIds: () => sseHub.getPinnedConvIds(),
        });
        resolveListen(actualPort);
      });
    });
  }

  function stop() {
    coordinator.stop();
    sseHub.closeAll();
    registry.cleanup();
    return new Promise((resolveClose) => {
      if (!server.listening) {
        resolveClose();
        return;
      }
      server.close(() => resolveClose());
    });
  }

  return {
    server,
    security,
    config,
    store,
    runtime,
    listen,
    stop,
    cleanupServerFile: registry.cleanup,
    runLsInspection: coordinator.runLsInspection,
    runProbeOnce: coordinator.runProbeOnce,
    getSseClientCount: sseHub.getClientCount,
  };
}

function isSameModulePath(a, b) {
  if (!a || !b) return false;
  const pa = resolve(a);
  const pb = resolve(b);
  return process.platform === "win32" ? pa.toLowerCase() === pb.toLowerCase() : pa === pb;
}

const isMain = isSameModulePath(process.argv[1], fileURLToPath(import.meta.url));

if (isMain) {
  const app = await createStatusServer();
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      app.cleanupServerFile();
      process.exit(0);
    });
  }
  process.on("exit", () => app.cleanupServerFile());

  const port = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || 0);
  const actualPort = await app.listen(port, "127.0.0.1");
  const hasEnvUiToken = Boolean(String(process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || "").trim());
  const listenUrl = hasEnvUiToken
    ? `http://127.0.0.1:${actualPort}`
    : `http://127.0.0.1:${actualPort}/?token=${encodeURIComponent(app.security.uiToken)}`;
  console.error(`Antigravity Status Monitor listening on ${listenUrl}`);
}
