import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyConfigPatch,
  CONFIG_PATH,
  ensureRuntimeDir,
  loadConfig,
  LS_ADDRESS,
  PUBLIC_DIR,
  sanitizeConfigForClient,
  SERVER_INFO_PATH,
} from "./lib/config.mjs";
import { getNotificationText } from "./lib/i18n.mjs";
import { sendDesktopNotification } from "./lib/notify.mjs";
import { probePaths } from "./lib/probe.mjs";
import { getLsEndpoints, inspectLanguageServer } from "./lib/process-probe.mjs";
import { getEnvProxy, invalidateProxyCache } from "./lib/proxy.mjs";
import { createSdkBridge } from "./lib/sdk-bridge.mjs";
import { createSecurityGuard, isAllowedHost } from "./lib/security.mjs";
import { createStateStore } from "./lib/state-store.mjs";
import { computeVerdict, selectEffectiveProbe } from "./lib/verdict.mjs";

const STATIC_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "application/javascript; charset=utf-8"],
};

const BASE_SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; connect-src 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

const MAX_JSON_BODY_BYTES = 256 * 1024;

function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      rejectBody(err);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_JSON_BODY_BYTES) {
        const err = new Error("Payload too large");
        err.status = 413;
        req.pause();
        fail(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolveBody(raw.trim() ? JSON.parse(raw) : {});
      } catch (err) {
        err.status = 400;
        rejectBody(err);
      }
    });
    req.on("error", fail);
  });
}

function sendJson(res, status, data, req = null) {
  const body = JSON.stringify(data);
  const headers = {
    ...BASE_SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body, "utf8"),
  };
  if (status === 413) {
    headers.Connection = "close";
  }
  res.writeHead(status, headers);
  if (status === 413 && req) {
    res.end(body, () => {
      try {
        req.destroy();
      } catch {
      }
    });
    return;
  }
  res.end(body);
}

export async function createStatusServer({
  configPath = CONFIG_PATH,
  serverInfoPath = SERVER_INFO_PATH,
  brainDirs,
  fallbackHookPath,
  uiToken,
  hookToken,
  lsAddress = LS_ADDRESS,
  sdkBridgeImpl = null,
  probePathsFn = probePaths,
  inspectLsFn = inspectLanguageServer,
  getLsEndpointsFn = getLsEndpoints,
  notifyFn = sendDesktopNotification,
  disableSchedulers = false,
  writeServerInfo = true,
  exitFn = (code) => process.exit(code),
} = {}) {
  const config = loadConfig(configPath);
  const store = createStateStore({ brainDirs, fallbackHookPath });
  const security = createSecurityGuard({ uiToken, hookToken });
  const sdkBridge = sdkBridgeImpl || (await createSdkBridge());

  const runtime = {
    probes: [],
    consecutiveFailures: 0,
    lastProxyConfig: null,
    lastKnownLsRoute: null,
    lsEndpoints: null,
    ls: {
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
    },
    simulation: {
      active: false,
      expiresAt: null,
    },
  };

  const sseClients = new Map();
  const timers = [];
  let lastNotifiedAt = 0;
  let prevVerdictCode = "IDLE";
  let simBackupNotifyState = null;
  let probeTimer = null;
  let lsHealthFailures = 0;
  let inFlightProbe = null;
  let inFlightGen = -1;
  let configGeneration = 0;
  let lsEndpointsPid = null;
  let pacNotifiedUrl = null;
  let lastRequestedConvId = null;
  const lastSseStateByConv = new Map();

  function getPreferredConvId() {
    if (sdkBridge.config.conversationId) return sdkBridge.config.conversationId;
    for (const cid of sseClients.values()) {
      if (cid) return cid;
    }
    return lastRequestedConvId || null;
  }

  function restoreNotifyStateAfterSim() {
    if (simBackupNotifyState) {
      lastNotifiedAt = simBackupNotifyState.lastNotifiedAt;
      prevVerdictCode = simBackupNotifyState.prevVerdictCode === "DISCONNECTED_HANG"
        ? "DISCONNECTED_HANG"
        : "IDLE";
      simBackupNotifyState = null;
    } else {
      lastNotifiedAt = 0;
      prevVerdictCode = "IDLE";
    }
  }

  function getSnapshot(requestedConvId = null) {
    const effectiveConvId = requestedConvId || sdkBridge.config.conversationId || null;
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

  function buildSseDiffKey(snap) {
    const isIdle = snap.verdict?.phase === "idle";
    const normalizedVerdict = snap.verdict && isIdle
      ? { ...snap.verdict, silentSec: snap.verdict.silentSec == null ? null : Math.floor(snap.verdict.silentSec / 5) }
      : snap.verdict;
    return JSON.stringify({
      ...snap,
      now: 0,
      verdict: normalizedVerdict,
    });
  }

  function broadcastState({ force = false } = {}) {
    if (sseClients.size === 0) return;
    const now = Date.now();
    const frameByConv = new Map();
    const activeKeys = new Set();

    for (const [res, convId] of sseClients.entries()) {
      const key = convId || "";
      activeKeys.add(key);
      let entry = frameByConv.get(key);
      if (!entry) {
        const snap = getSnapshot(convId || null);
        const diffKey = buildSseDiffKey(snap);
        const prev = lastSseStateByConv.get(key);
        const changed = force || !prev || prev.diffKey !== diffKey || now - prev.sentAt >= 10_000;
        entry = changed
          ? { changed: true, diffKey, payload: `event: state\ndata: ${JSON.stringify(snap)}\n\n` }
          : { changed: false };
        if (changed) {
          lastSseStateByConv.set(key, { diffKey, sentAt: now });
        }
        frameByConv.set(key, entry);
      }
      if (!entry.changed) continue;
      try {
        res.write(entry.payload);
      } catch {
        sseClients.delete(res);
      }
    }

    for (const key of lastSseStateByConv.keys()) {
      if (!activeKeys.has(key)) lastSseStateByConv.delete(key);
    }
  }

  async function executeProbeOnce(expectedGen = configGeneration, { forceRefresh = false } = {}) {
    const now = Date.now();
    if (runtime.simulation.active && runtime.simulation.expiresAt && now > runtime.simulation.expiresAt) {
      runtime.simulation.active = false;
      runtime.simulation.expiresAt = null;
      restoreNotifyStateAfterSim();
    }

    const probeUrlSnapshot = config.probeUrl;
    const timeoutSnapshot = config.timeoutMs;
    const manualProxySnapshot = config.manualProxyUrl;

    let dual;
    try {
      dual = await probePathsFn(probeUrlSnapshot, timeoutSnapshot, {
        manualProxyUrl: manualProxySnapshot,
        forceRefresh,
      });
    } catch (err) {
      if (expectedGen !== configGeneration) {
        return runtime.probes[runtime.probes.length - 1] || null;
      }
      const errResult = {
        ts: Date.now(),
        latencyMs: 0,
        mode: "direct",
        activeRoute: "direct",
        proxyAddress: null,
        proxyConfig: runtime.lastProxyConfig,
        target: probeUrlSnapshot,
        ok: false,
        statusCode: null,
        error: err?.message || "探测异常",
        dual: { direct: null, proxy: null },
      };
      runtime.consecutiveFailures += 1;
      runtime.probes.push(errResult);
      if (runtime.probes.length > 40) runtime.probes.shift();
      broadcastState({ force: true });
      throw err;
    }

    if (expectedGen !== configGeneration) {
      return runProbeOnce({ forceRefresh: true });
    }

    runtime.lastProxyConfig = dual.proxyConfig;
    const hasConfiguredProxy = Boolean(dual?.proxy || dual?.proxyConfig?.enabled);
    if (!hasConfiguredProxy && runtime.lastKnownLsRoute === "proxy") {
      runtime.lastKnownLsRoute = null;
      if (runtime.ls.route === "proxy") {
        runtime.ls.route = runtime.ls.tunDetected ? "tun" : null;
      }
    }

    if (String(dual?.proxyConfig?.source || "").endsWith("pac-unsupported")) {
      const pacUrl = dual.proxyConfig.pacUrl || "";
      if (pacNotifiedUrl !== pacUrl) {
        pacNotifiedUrl = pacUrl;
        store.pushTimelineEvent(
          "net",
          "检测到系统 PAC 自动代理",
          `暂不支持解析 PAC 脚本，已按直连探测（可在设置中手动填代理）(${pacUrl || "AutoConfigURL"})`,
          "warn",
          null,
          { key: "PAC_UNSUPPORTED", params: { pacUrl } },
        );
      }
    } else {
      pacNotifiedUrl = null;
    }

    const result = selectEffectiveProbe({
      dual,
      ls: runtime.ls,
      lastKnownLsRoute: runtime.lastKnownLsRoute,
      envProxy: getEnvProxy(process.env, probeUrlSnapshot),
    });
    const wasDown = runtime.consecutiveFailures >= 2;

    if (result.ok) {
      runtime.consecutiveFailures = 0;
      if (wasDown) {
        store.pushTimelineEvent(
          "net",
          "VPN / 上游网络已恢复",
          `延迟 ${result.latencyMs} ms`,
          "success",
          null,
          { key: "NET_RECOVERED", params: { latencyMs: result.latencyMs } },
        );
      }
    } else {
      runtime.consecutiveFailures += 1;
      if (runtime.consecutiveFailures === 2) {
        store.pushTimelineEvent(
          "net",
          "上游网络连续探测失败",
          result.error || "超时",
          "error",
          null,
          { key: "NET_FAILED", params: { error: result.error || "" } },
        );
      }
    }

    runtime.probes.push(result);
    if (runtime.probes.length > 40) {
      runtime.probes.shift();
    }

    const activeConv = store.resolveActiveConversation(getPreferredConvId());
    const verdict = computeVerdict({
      hook: activeConv.hook,
      transcript: activeConv.transcript,
      ls: runtime.ls,
      probes: runtime.probes,
      consecutiveFailures: runtime.consecutiveFailures,
      simulation: runtime.simulation,
      config,
    });

    if (
      verdict.code === "DISCONNECTED_HANG" &&
      prevVerdictCode !== "DISCONNECTED_HANG" &&
      config.notifyOnDisconnect &&
      Date.now() - lastNotifiedAt > 60_000
    ) {
      lastNotifiedAt = Date.now();
      const note = getNotificationText(verdict.simulated, config.lang);
      notifyFn(note.title, note.message);
    }
    prevVerdictCode = verdict.code;
    broadcastState({ force: true });
    return result;
  }

  function runProbeOnce({ forceRefresh = false } = {}) {
    if (inFlightProbe && inFlightGen === configGeneration) {
      return inFlightProbe;
    }
    const gen = configGeneration;
    inFlightGen = gen;
    const p = executeProbeOnce(gen, { forceRefresh }).finally(() => {
      if (inFlightProbe === p) {
        inFlightProbe = null;
        inFlightGen = -1;
      }
    });
    inFlightProbe = p;
    return p;
  }

  async function runLsInspection() {
    const lsInfo = await inspectLsFn({
      lsAddress,
      proxy: runtime.lastProxyConfig,
    });

    if (lsInfo.running === false) {
      runtime.lastKnownLsRoute = null;
    } else if (lsInfo.route) {
      runtime.lastKnownLsRoute = lsInfo.route;
    }

    if (
      runtime.lastKnownLsRoute === "proxy" &&
      runtime.lastProxyConfig &&
      !runtime.lastProxyConfig.enabled
    ) {
      runtime.lastKnownLsRoute = null;
    }

    if (!lsInfo.lsPid) {
      lsEndpointsPid = null;
      runtime.lsEndpoints = null;
    } else if (lsInfo.lsPid !== lsEndpointsPid) {
      const endpoints = await getLsEndpointsFn(lsInfo.lsPid);
      lsEndpointsPid = lsInfo.lsPid;
      runtime.lsEndpoints = endpoints || null;
    }

    const resolvedRoute =
      lsInfo.route ||
      (runtime.lastKnownLsRoute === "proxy" && runtime.lastProxyConfig && !runtime.lastProxyConfig.enabled
        ? null
        : runtime.lastKnownLsRoute);

    runtime.ls = {
      ...lsInfo,
      route: resolvedRoute,
      endpoints: runtime.lsEndpoints,
    };

    if (lsAddress) {
      if (lsInfo.healthz?.reachable === false) {
        lsHealthFailures += 1;
        if (lsHealthFailures >= 3) {
          cleanupServerFile();
          exitFn(0);
        }
      } else if (lsInfo.healthz?.reachable === true) {
        lsHealthFailures = 0;
      }
    }

    broadcastState();
  }

  function resetProbeScheduler() {
    if (probeTimer) clearInterval(probeTimer);
    if (disableSchedulers) return;
    probeTimer = setInterval(
      () => {
        runProbeOnce().catch(() => {});
      },
      Math.max(1000, Number(config.intervalMs) || 3000),
    );
  }

  function cleanupServerFile() {
    if (!writeServerInfo || !serverInfoPath) return;
    try {
      if (existsSync(serverInfoPath)) {
        const info = JSON.parse(readFileSync(serverInfoPath, "utf8"));
        if (info?.pid === process.pid) {
          unlinkSync(serverInfoPath);
        }
      }
    } catch {
    }
  }

  const server = http.createServer(async (req, res) => {
    if (!isAllowedHost(req)) {
      sendJson(res, 403, { ok: false, error: "Forbidden host" });
      return;
    }

    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/preload.js") {
      const js = sdkBridge.getPreloadJs();
      if (!js) {
        const stub = "";
        res.writeHead(200, {
          ...BASE_SECURITY_HEADERS,
          "Content-Type": "application/javascript; charset=utf-8",
          "Content-Length": Buffer.byteLength(stub, "utf8"),
        });
        res.end(stub);
        return;
      }
      res.writeHead(200, {
        ...BASE_SECURITY_HEADERS,
        "Content-Type": "application/javascript; charset=utf-8",
        "Content-Length": Buffer.byteLength(js, "utf8"),
      });
      res.end(js);
      return;
    }

    if (req.method === "GET" && STATIC_FILES[url.pathname]) {
      const [filename, contentType] = STATIC_FILES[url.pathname];
      try {
        const content = readFileSync(join(PUBLIC_DIR, filename));
        res.writeHead(200, {
          ...BASE_SECURITY_HEADERS,
          "Content-Type": contentType,
          "Content-Length": content.byteLength,
        });
        res.end(content);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`Failed to load ${filename}: ${err.message}`);
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      res.writeHead(204, BASE_SECURITY_HEADERS);
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/")) {
      const auth = security.verifyUiGet(req, url);
      if (!auth.ok) {
        sendJson(res, auth.status, { ok: false, error: auth.error });
        return;
      }
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      const requestedConvId = url.searchParams.get("conversationId")?.trim() || null;
      if (requestedConvId) lastRequestedConvId = requestedConvId;
      store.refreshTranscript(requestedConvId || sdkBridge.config.conversationId || null, true);
      sendJson(res, 200, {
        ...getSnapshot(requestedConvId),
        security: {
          uiTokenEnforced: security.hasUiToken,
          sdkReady: sdkBridge.isSdkReady(),
        },
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/events") {
      const requestedConvId = url.searchParams.get("conversationId")?.trim() || null;
      if (requestedConvId) lastRequestedConvId = requestedConvId;
      store.refreshTranscript(requestedConvId || sdkBridge.config.conversationId || null, false);
      res.writeHead(200, {
        ...BASE_SECURITY_HEADERS,
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      const initSnap = getSnapshot(requestedConvId);
      const initKey = requestedConvId || "";
      lastSseStateByConv.set(initKey, { diffKey: buildSseDiffKey(initSnap), sentAt: Date.now() });
      res.write(`event: state\ndata: ${JSON.stringify(initSnap)}\n\n`);
      sseClients.set(res, requestedConvId);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/hook") {
      const auth = security.verifyHookPost(req);
      if (!auth.ok) {
        sendJson(res, auth.status, { ok: false, error: auth.error });
        return;
      }
      try {
        const body = await readJsonBody(req);
        store.applyHookEvent(body, true);
        store.clearFallbackHook(body?.receivedAt ?? Infinity);
        sendJson(res, 200, { ok: true });
        setImmediate(() => {
          try {
            store.scanTranscript(body?.payload?.conversationId || null);
            broadcastState();
          } catch {
          }
        });
      } catch (err) {
        sendJson(res, err.status || 400, { ok: false, error: err.message }, req);
      }
      return;
    }

    if (req.method === "POST") {
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
          const result = await runProbeOnce({ forceRefresh: true });
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
            configGeneration += 1;
            invalidateProxyCache();
            pacNotifiedUrl = null;
          }
          resetProbeScheduler();
          broadcastState({ force: true });
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
          const enable = body.active !== undefined ? Boolean(body.active) : !runtime.simulation.active;
          runtime.simulation.active = enable;
          runtime.simulation.expiresAt = enable ? Date.now() + 15000 : null;
          if (enable) {
            if (!simBackupNotifyState) {
              simBackupNotifyState = { prevVerdictCode, lastNotifiedAt };
            }
            prevVerdictCode = "DISCONNECTED_HANG";
            store.pushTimelineEvent(
              "sim",
              "开启断网警报预览",
              "持续 15 秒，可随时点击关闭",
              "warn",
              null,
              { key: "SIM_ON" },
            );
            if (config.notifyOnDisconnect) {
              lastNotifiedAt = Date.now();
              const note = getNotificationText(true, config.lang);
              notifyFn(note.title, note.message);
            }
          } else {
            restoreNotifyStateAfterSim();
            store.pushTimelineEvent("sim", "关闭断网警报预览", "", "info", null, { key: "SIM_OFF" });
          }
          broadcastState({ force: true });
          sendJson(res, 200, { ok: true, simulation: runtime.simulation });
        } catch (err) {
          sendJson(res, err.status || 400, { ok: false, error: err.message }, req);
        }
        return;
      }
    }

    sendJson(res, 404, { error: "Not found" });
  });

  function listen(port = 0, host = "127.0.0.1") {
    return new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(port, host, () => {
        server.off("error", rejectListen);
        const actualPort = server.address().port;
        if (writeServerInfo && serverInfoPath) {
          if (serverInfoPath === SERVER_INFO_PATH) ensureRuntimeDir();
          else mkdirSync(dirname(serverInfoPath), { recursive: true });
          writeFileSync(
            serverInfoPath,
            JSON.stringify(
              {
                port: actualPort,
                pid: process.pid,
                startedAt: Date.now(),
                hookToken: security.hookToken,
              },
              null,
              2,
            ),
            { encoding: "utf8", mode: 0o600 },
          );
        }

        if (!disableSchedulers) {
          store.loadFallbackHookIfNewer();
          store.scanTranscript();
          runLsInspection()
            .then(() => runProbeOnce())
            .catch(() => {});
          resetProbeScheduler();
          timers.push(
            setInterval(() => {
              const pinnedConvIds = new Set();
              if (sdkBridge.config.conversationId) pinnedConvIds.add(sdkBridge.config.conversationId);
              for (const cid of sseClients.values()) {
                if (cid) pinnedConvIds.add(cid);
              }
              if (store.scanTranscript(pinnedConvIds, true, { fullScanIntervalMs: 4500 })) {
                broadcastState({ force: true });
              }
            }, 1500),
            setInterval(() => {
              runLsInspection().catch(() => {});
            }, 5000),
            setInterval(() => broadcastState({ force: false }), 1000),
          );
        }

        resolveListen(actualPort);
      });
    });
  }

  function stop() {
    if (probeTimer) clearInterval(probeTimer);
    for (const t of timers) clearInterval(t);
    timers.length = 0;
    for (const res of sseClients.keys()) {
      try {
        res.end();
      } catch {
      }
    }
    sseClients.clear();
    cleanupServerFile();
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
    cleanupServerFile,
    runLsInspection,
    runProbeOnce,
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
