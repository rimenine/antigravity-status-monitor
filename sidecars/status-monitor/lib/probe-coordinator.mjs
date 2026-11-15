import { getNotificationText } from "./i18n.mjs";
import { sendDesktopNotification } from "./notify.mjs";
import { probePaths } from "./probe.mjs";
import { getLsEndpoints, inspectLanguageServer } from "./process-probe.mjs";
import { getEnvProxy, invalidateProxyCache } from "./proxy.mjs";
import { computeVerdict, selectEffectiveProbe } from "./verdict.mjs";

const MAX_PROBE_HISTORY = 40;
const NOTIFY_COOLDOWN_MS = 60_000;

/** 协调网络探针、Language Server 探查、桌面通知去重与定时调度。 */
export function createProbeCoordinator({
  config,
  store,
  runtime,
  lsAddress = "",
  probePathsFn = probePaths,
  inspectLsFn = inspectLanguageServer,
  getLsEndpointsFn = getLsEndpoints,
  notifyFn = sendDesktopNotification,
  alertLogger = null,
  disableSchedulers = false,
  onHealthDead = () => {},
  onStateChanged = () => {},
  getPreferredConvId = () => null,
} = {}) {
  const timers = [];
  let probeTimer = null;
  let lastNotifiedAt = 0;
  let prevVerdictCode = "IDLE";
  let simBackupNotifyState = null;
  let lsHealthFailures = 0;
  let inFlightProbe = null;
  let inFlightGen = -1;
  let configGeneration = 0;
  let lsEndpointsPid = null;
  let pacNotifiedUrl = null;

  function restoreNotifyStateAfterSim() {
    if (simBackupNotifyState) {
      lastNotifiedAt = simBackupNotifyState.lastNotifiedAt;
      prevVerdictCode =
        simBackupNotifyState.prevVerdictCode === "DISCONNECTED_HANG" ? "DISCONNECTED_HANG" : "IDLE";
      simBackupNotifyState = null;
    } else {
      lastNotifiedAt = 0;
      prevVerdictCode = "IDLE";
    }
  }

  function onSimulationToggle(enable, now = Date.now()) {
    if (enable) {
      if (!simBackupNotifyState) {
        simBackupNotifyState = { prevVerdictCode, lastNotifiedAt };
      }
      prevVerdictCode = "DISCONNECTED_HANG";
      const notified = Boolean(config.notifyOnDisconnect);
      if (notified) {
        lastNotifiedAt = now;
        const note = getNotificationText({ simulated: true, messageKey: "NET_DOWN_HANG" }, config.lang);
        notifyFn(note.title, note.message);
      }
      alertLogger?.append({
        type: "SIMULATION_ON",
        reason: "MANUAL_PREVIEW",
        simulated: true,
        notified,
        convId: getPreferredConvId() || null,
      });
      return;
    }
    restoreNotifyStateAfterSim();
  }

  function invalidateOnProxyOrTargetChange() {
    configGeneration += 1;
    invalidateProxyCache();
    pacNotifiedUrl = null;
  }

  function pushProbeSample(result) {
    runtime.probes.push(result);
    if (runtime.probes.length > MAX_PROBE_HISTORY) {
      runtime.probes.shift();
    }
  }

  function recordPacStatusIfNeeded(dual) {
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
      pushProbeSample(errResult);
      onStateChanged({ force: true });
      throw err;
    }

    // 探测期间若目标地址或代理刚被修改，丢弃过期样本并立刻按最新配置复测。
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

    recordPacStatusIfNeeded(dual);

    const result = selectEffectiveProbe({
      dual,
      ls: runtime.ls,
      lastKnownLsRoute: runtime.lastKnownLsRoute,
      envProxy: getEnvProxy(process.env, probeUrlSnapshot),
    });
    const wasDown = runtime.consecutiveFailures >= 2;
    const activeConv = store.resolveActiveConversation(getPreferredConvId());

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
        alertLogger?.append({
          type: "NET_RECOVERED",
          latencyMs: result.latencyMs,
          convId: activeConv.id || null,
        });
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
        alertLogger?.append({
          type: "NET_FAILED",
          error: result.error || "超时",
          convId: activeConv.id || null,
        });
      }
    }

    pushProbeSample(result);

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
      prevVerdictCode !== "DISCONNECTED_HANG"
    ) {
      const canNotify =
        config.notifyOnDisconnect &&
        Date.now() - lastNotifiedAt > NOTIFY_COOLDOWN_MS;
      if (canNotify) {
        lastNotifiedAt = Date.now();
        const note = getNotificationText(
          { simulated: verdict.simulated, messageKey: verdict.messageKey },
          config.lang,
        );
        notifyFn(note.title, note.message);
      }
      alertLogger?.append({
        type: "DISCONNECTED_HANG",
        reason: verdict.messageKey || "UNKNOWN",
        message: verdict.message,
        simulated: verdict.simulated,
        notified: Boolean(canNotify),
        convId: activeConv.id || null,
        error: result.ok ? "" : result.error || "",
        lsRunning: runtime.ls?.running ?? null,
        healthz: runtime.ls?.healthz?.reachable ?? null,
      });
    }
    prevVerdictCode = verdict.code;
    onStateChanged({ force: true });
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
          onHealthDead();
        }
      } else if (lsInfo.healthz?.reachable === true) {
        lsHealthFailures = 0;
      }
    }

    onStateChanged();
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

  function startSchedulers({ getPinnedConvIds }) {
    if (disableSchedulers) return;
    store.loadFallbackHookIfNewer();
    store.scanTranscript();
    runLsInspection()
      .then(() => runProbeOnce())
      .catch(() => {});
    resetProbeScheduler();
    timers.push(
      setInterval(() => {
        const pinnedConvIds = getPinnedConvIds();
        if (store.scanTranscript(pinnedConvIds, true, { fullScanIntervalMs: 4500 })) {
          onStateChanged({ force: true });
        }
      }, 1500),
      setInterval(() => {
        runLsInspection().catch(() => {});
      }, 5000),
      setInterval(() => onStateChanged({ force: false }), 1000),
    );
  }

  function stop() {
    if (probeTimer) {
      clearInterval(probeTimer);
      probeTimer = null;
    }
    for (const t of timers) clearInterval(t);
    timers.length = 0;
  }

  return {
    runProbeOnce,
    runLsInspection,
    resetProbeScheduler,
    startSchedulers,
    invalidateOnProxyOrTargetChange,
    onSimulationToggle,
    restoreNotifyStateAfterSim,
    stop,
  };
}
