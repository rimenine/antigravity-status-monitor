import { formatVerdictCopy } from "./i18n.mjs";

export function selectEffectiveProbe({ dual, ls, lastKnownLsRoute, envProxy }) {
  const hasUsableProxy = Boolean(dual.proxy || dual.proxyConfig?.enabled || envProxy);
  const lsRoute = ls?.route || (hasUsableProxy ? lastKnownLsRoute : null);

  let activeRoute = "direct";
  let primary = dual.direct;

  if (envProxy || dual.proxyConfig?.source === "manual" || (lsRoute === "proxy" && hasUsableProxy)) {
    activeRoute = "proxy";
    primary = dual.proxy || dual.direct;
  } else if (lsRoute === "tun" || ls?.tunDetected) {
    activeRoute = "tun";
    primary = dual.direct;
  } else if (lsRoute === "direct") {
    activeRoute = "direct";
    primary = dual.direct;
  } else {
    if (dual.direct?.ok) {
      activeRoute = "direct";
      primary = dual.direct;
    } else if (dual.proxy?.ok) {
      activeRoute = "proxy";
      primary = dual.proxy;
    } else {
      activeRoute = dual.proxy ? "proxy" : "direct";
      primary = dual.direct || dual.proxy;
    }
  }

  return {
    ...primary,
    activeRoute,
    proxyAddress: activeRoute === "proxy" ? (primary?.proxyAddress ?? null) : null,
    proxyConfig: dual.proxyConfig,
    dual: {
      direct: dual.direct,
      proxy: dual.proxy,
    },
  };
}

export function computeVerdict({
  hook,
  transcript,
  ls,
  probes = [],
  consecutiveFailures = 0,
  simulation = { active: false },
  config = { stallThresholdSec: 25 },
  now = Date.now(),
}) {
  const hookAgeMs = hook?.lastEventAt ? now - hook.lastEventAt : Infinity;
  const transcriptAgeMs = transcript?.latestStepAt ? now - transcript.latestStepAt : Infinity;
  const hookIsStop = hook?.lastEvent === "Stop" && hook?.phase === "idle" && Number.isFinite(hook?.lastEventAt);
  const transcriptAdvancedPastStop =
    !hookIsStop ||
    !transcript?.latestStepAt ||
    (transcript.latestRecordCreatedAt != null && transcript.latestRecordCreatedAt > hook.lastEventAt + 50) ||
    transcript.latestStepAt - hook.lastEventAt > 3000;

  let phase = "idle";
  let source = "none";
  if (
    hook?.lastEventAt &&
    (!transcript?.latestStepAt ||
      hook.lastEventAt >= transcript.latestStepAt ||
      (hookIsStop && !transcriptAdvancedPastStop))
  ) {
    const timedOutWithIdleTranscript =
      hook.phase !== "idle" && hookAgeMs > 5 * 60 * 1000 && transcript?.inferredPhase === "idle";
    phase = hookAgeMs < 15 * 60 * 1000 && !timedOutWithIdleTranscript ? hook.phase : "idle";
    source = "hook";
  } else if (transcript?.latestStepAt) {
    phase = transcriptAgeMs < 15 * 60 * 1000 ? transcript.inferredPhase : "idle";
    source = "transcript";
  }

  const latestActivityAt =
    Math.max(hook?.lastEventAt || 0, transcript?.latestStepAt || 0) || null;
  const activeSince =
    phase !== "idle" ? latestActivityAt || hook?.turnStartedAt || now : null;
  const elapsedSec = activeSince ? Math.max(0, Math.floor((now - activeSince) / 1000)) : 0;
  const silentSec = transcript?.latestStepAt
    ? Math.max(0, Math.floor((now - transcript.latestStepAt) / 1000))
    : null;

  const latestProbe = probes[probes.length - 1] || null;
  const simulatedDown = Boolean(simulation?.active);
  const networkDown = simulatedDown || consecutiveFailures >= 2;
  const networkSuspect = !networkDown && consecutiveFailures === 1;
  const lsDown = ls?.running === false || ls?.healthz?.reachable === false;
  const lsSynStall = (ls?.synSent443 || 0) > 0;

  const lang = config?.lang || "zh";
  let code;
  let severity;
  let messageKey;
  let messageParams;

  if (simulatedDown) {
    code = "DISCONNECTED_HANG";
    severity = "danger";
    messageKey = "SIMULATED_DOWN";
    messageParams = {};
  } else if (phase === "waiting_llm") {
    if (lsDown) {
      code = "DISCONNECTED_HANG";
      severity = "danger";
      messageKey = "LS_DOWN";
      messageParams = { elapsedSec };
    } else if (networkDown) {
      code = "DISCONNECTED_HANG";
      severity = "danger";
      messageKey = "NET_DOWN_HANG";
      messageParams = { elapsedSec, consecutiveFailures };
    } else if (lsSynStall && elapsedSec >= 6) {
      code = "SUSPECT_STALL";
      severity = "warning";
      messageKey = "LS_SYN_STALL";
      messageParams = { synSent443: ls.synSent443 };
    } else if (networkSuspect) {
      code = "SUSPECT_STALL";
      severity = "warning";
      messageKey = "NET_SUSPECT";
      messageParams = { elapsedSec };
    } else if (
      silentSec !== null &&
      silentSec >= (config.stallThresholdSec || 25) &&
      elapsedSec >= (config.stallThresholdSec || 25)
    ) {
      code = "SUSPECT_STALL";
      severity = "warning";
      messageKey = "MODEL_STALL";
      messageParams = { silentSec };
    } else {
      code = "WAITING_LLM";
      severity = "active";
      messageKey = "WAITING_LLM";
      messageParams = { elapsedSec };
    }
  } else if (phase === "running_tool") {
    const toolLabel = hook?.toolName || transcript?.lastToolName || "";
    code = "RUNNING_TOOL";
    severity = "tool";
    messageKey = "RUNNING_TOOL";
    messageParams = { toolLabel };
  } else {
    if (networkDown) {
      code = "OFFLINE_IDLE";
      severity = "warning";
      messageKey = "OFFLINE_IDLE";
      messageParams = {};
    } else {
      code = "IDLE";
      severity = "ok";
      messageKey = "IDLE_OK";
      messageParams = { latencyMs: latestProbe?.ok ? latestProbe.latencyMs : null };
    }
  }

  const { headline, summary } = formatVerdictCopy(messageKey, messageParams, lang);

  return {
    code,
    severity,
    headline,
    summary,
    messageKey,
    messageParams,
    phase,
    source,
    elapsedSec,
    silentSec,
    networkDown,
    simulated: simulatedDown,
  };
}
