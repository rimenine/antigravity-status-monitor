import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ABORTED_PLANNER_STATUSES,
  hasPendingBackgroundTask,
  hasPendingParallelTools,
  inferTranscriptPhase,
  parseTranscriptError,
} from "../sidecars/status-monitor/lib/transcript-reader.mjs";
import {
  computeVerdict,
  selectEffectiveProbe,
} from "../sidecars/status-monitor/lib/verdict.mjs";

describe("selectEffectiveProbe（主判定链路选择）", () => {
  it("环境变量存在代理时强制使用 proxy 链路", () => {
    const dual = {
      direct: { ok: true, latencyMs: 50, mode: "direct" },
      proxy: { ok: false, latencyMs: 2500, mode: "proxy", error: "TIMEOUT" },
      proxyConfig: { enabled: true, host: "127.0.0.1", port: 7897, source: "env" },
    };
    const res = selectEffectiveProbe({
      dual,
      ls: { route: "direct" },
      lastKnownLsRoute: "direct",
      envProxy: dual.proxyConfig,
    });
    assert.equal(res.activeRoute, "proxy");
    assert.equal(res.ok, false);
    assert.deepEqual(res.dual, { direct: dual.direct, proxy: dual.proxy });
  });

  it("Language Server 走 TUN 时以直连探针为准并标记 tun", () => {
    const dual = {
      direct: { ok: true, latencyMs: 180, mode: "direct" },
      proxy: { ok: false, latencyMs: 1200, mode: "proxy", error: "ECONNREFUSED" },
      proxyConfig: { enabled: true, host: "127.0.0.1", port: 7897, source: "windows-registry" },
    };
    const res = selectEffectiveProbe({
      dual,
      ls: { route: "tun", tunDetected: true },
      lastKnownLsRoute: null,
      envProxy: null,
    });
    assert.equal(res.activeRoute, "tun");
    assert.equal(res.ok, true);
    assert.equal(res.latencyMs, 180);
  });

  it("Language Server 走 proxy 时即使直连成功也采用代理探针结果", () => {
    const dual = {
      direct: { ok: true, latencyMs: 90, mode: "direct" },
      proxy: { ok: false, latencyMs: 2500, mode: "proxy", error: "TIMEOUT" },
      proxyConfig: { enabled: true, host: "127.0.0.1", port: 7890, source: "env" },
    };
    const res = selectEffectiveProbe({
      dual,
      ls: { route: "proxy" },
      lastKnownLsRoute: null,
      envProxy: null,
    });
    assert.equal(res.activeRoute, "proxy");
    assert.equal(res.ok, false);
  });

  it("未观测到 LS 路由时：直连不通但代理通则回退参考 proxy", () => {
    const dual = {
      direct: { ok: false, latencyMs: 2500, mode: "direct", error: "TIMEOUT" },
      proxy: { ok: true, latencyMs: 310, mode: "proxy" },
      proxyConfig: { enabled: true, host: "127.0.0.1", port: 7897, source: "windows-registry" },
    };
    const res = selectEffectiveProbe({
      dual,
      ls: { route: null, tunDetected: false },
      lastKnownLsRoute: null,
      envProxy: null,
    });
    assert.equal(res.activeRoute, "proxy");
    assert.equal(res.ok, true);
    assert.equal(res.latencyMs, 310);
  });

  it("手动指定代理 (source=manual) 时优先采用 proxy 探测结果", () => {
    const dual = {
      direct: { ok: false, latencyMs: 2500, mode: "direct", error: "TIMEOUT" },
      proxy: { ok: true, latencyMs: 190, mode: "proxy", proxyAddress: "socks5://127.0.0.1:1080" },
      proxyConfig: { enabled: true, protocol: "socks5", host: "127.0.0.1", port: 1080, source: "manual" },
    };
    const res = selectEffectiveProbe({
      dual,
      ls: { route: "direct", tunDetected: false },
      lastKnownLsRoute: "direct",
      envProxy: null,
    });
    assert.equal(res.activeRoute, "proxy");
    assert.equal(res.ok, true);
    assert.equal(res.latencyMs, 190);
  });

  it("关闭代理且仅有陈旧 lastKnownLsRoute=proxy 时不产生孤立 proxy 路由", () => {
    const dual = {
      direct: { ok: true, latencyMs: 120, mode: "direct", proxyAddress: null },
      proxy: null,
      proxyConfig: { enabled: false, source: "none" },
    };
    const res = selectEffectiveProbe({
      dual,
      ls: { route: null, tunDetected: false },
      lastKnownLsRoute: "proxy",
      envProxy: null,
    });
    assert.equal(res.activeRoute, "direct");
    assert.equal(res.proxyAddress, null);
    assert.equal(res.ok, true);
  });

  it("混合代理/CGNAT 路由且直连不通、代理通畅时优先采信 proxy 探测", () => {
    const dual = {
      direct: { ok: false, latencyMs: 4000, mode: "direct", error: "TIMEOUT" },
      proxy: { ok: true, latencyMs: 210, mode: "proxy", proxyAddress: "127.0.0.1:7897" },
      proxyConfig: { enabled: true, host: "127.0.0.1", port: 7897, source: "windows-registry" },
    };
    const res = selectEffectiveProbe({
      dual,
      ls: { route: "direct", tunDetected: true, proxyConns: 2 },
      lastKnownLsRoute: null,
      envProxy: null,
    });
    assert.equal(res.activeRoute, "proxy");
    assert.equal(res.ok, true);
    assert.equal(res.latencyMs, 210);
  });
});

describe("computeVerdict（核心状态诊断引擎）", () => {
  const baseNow = 1_794_660_000_000;

  it("模拟断网开启时优先返回 DISCONNECTED_HANG 且标记 simulated=true", () => {
    const res = computeVerdict({
      hook: { phase: "idle", lastEventAt: baseNow - 1000 },
      transcript: null,
      ls: { running: true, healthz: { reachable: true } },
      probes: [{ ok: true, latencyMs: 80 }],
      consecutiveFailures: 0,
      simulation: { active: true },
      now: baseNow,
    });
    assert.equal(res.code, "DISCONNECTED_HANG");
    assert.equal(res.severity, "danger");
    assert.equal(res.simulated, true);
    assert.equal(res.networkDown, true);
  });

  it("等待模型且网络正常时返回 WAITING_LLM，并按最新时间戳选择信号源", () => {
    const hookNewer = computeVerdict({
      hook: { phase: "waiting_llm", lastEventAt: baseNow - 3000, turnStartedAt: baseNow - 5000 },
      transcript: { latestStepAt: baseNow - 4000, inferredPhase: "waiting_llm" },
      ls: { running: true, healthz: { reachable: true }, established443: 1, synSent443: 0 },
      probes: [{ ok: true, latencyMs: 145 }],
      consecutiveFailures: 0,
      config: { stallThresholdSec: 25 },
      now: baseNow,
    });
    assert.equal(hookNewer.code, "WAITING_LLM");
    assert.equal(hookNewer.severity, "active");
    assert.equal(hookNewer.phase, "waiting_llm");
    assert.equal(hookNewer.source, "hook");
    assert.equal(hookNewer.elapsedSec, 3);

    const transcriptNewer = computeVerdict({
      hook: { phase: "waiting_llm", lastEventAt: baseNow - 5000, turnStartedAt: baseNow - 133000 },
      transcript: { latestStepAt: baseNow - 2000, inferredPhase: "waiting_llm" },
      ls: { running: true, healthz: { reachable: true } },
      now: baseNow,
    });
    assert.equal(transcriptNewer.code, "WAITING_LLM");
    assert.equal(transcriptNewer.source, "transcript");
    assert.equal(transcriptNewer.elapsedSec, 2);

    const resetOnFreshLog = computeVerdict({
      hook: { phase: "waiting_llm", lastEventAt: baseNow - 133000, turnStartedAt: baseNow - 133000 },
      transcript: { latestStepAt: baseNow, inferredPhase: "waiting_llm" },
      ls: { running: true, healthz: { reachable: true } },
      now: baseNow,
    });
    assert.equal(resetOnFreshLog.code, "WAITING_LLM");
    assert.equal(resetOnFreshLog.elapsedSec, 0);
    assert.match(resetOnFreshLog.summary, /已持续等待 0s/);
  });

  it("等待模型但上游连续 >= 2 次失败时判定为假性工作中挂起 DISCONNECTED_HANG", () => {
    const res = computeVerdict({
      hook: { phase: "waiting_llm", lastEventAt: baseNow - 12000, turnStartedAt: baseNow - 12000 },
      transcript: { latestStepAt: baseNow - 12000, inferredPhase: "waiting_llm" },
      ls: { running: true, healthz: { reachable: true } },
      consecutiveFailures: 2,
      now: baseNow,
    });
    assert.equal(res.code, "DISCONNECTED_HANG");
    assert.equal(res.severity, "danger");
    assert.match(res.headline, /VPN|断开/);
  });

  it("等待模型但 Language Server 失联时判定为 DISCONNECTED_HANG", () => {
    const res = computeVerdict({
      hook: { phase: "waiting_llm", lastEventAt: baseNow - 8000, turnStartedAt: baseNow - 8000 },
      ls: { running: true, healthz: { reachable: false } },
      consecutiveFailures: 0,
      now: baseNow,
    });
    assert.equal(res.code, "DISCONNECTED_HANG");
    assert.equal(res.severity, "danger");
    assert.match(res.headline, /Language Server 失联/);
  });

  it("单次网络探测失败判定为 SUSPECT_STALL（warning）以便复测", () => {
    const res = computeVerdict({
      hook: { phase: "waiting_llm", lastEventAt: baseNow - 4000, turnStartedAt: baseNow - 4000 },
      ls: { running: true, healthz: { reachable: true } },
      consecutiveFailures: 1,
      now: baseNow,
    });
    assert.equal(res.code, "SUSPECT_STALL");
    assert.equal(res.severity, "warning");
  });

  it("LS 443 连接卡在 SYN_SENT >= 6s 时发出握手卡住告警", () => {
    const synEarly = computeVerdict({
      hook: { phase: "waiting_llm", lastEventAt: baseNow - 3000, turnStartedAt: baseNow - 3000 },
      ls: { running: true, healthz: { reachable: true }, synSent443: 2, established443: 0 },
      now: baseNow,
    });
    assert.equal(synEarly.code, "WAITING_LLM");

    const synStuck = computeVerdict({
      hook: { phase: "waiting_llm", lastEventAt: baseNow - 7000, turnStartedAt: baseNow - 7000 },
      ls: { running: true, healthz: { reachable: true }, synSent443: 2, established443: 0 },
      now: baseNow,
    });
    assert.equal(synStuck.code, "SUSPECT_STALL");
    assert.equal(synStuck.severity, "warning");
    assert.match(synStuck.headline, /握手卡住/);

    const mixedStuck = computeVerdict({
      hook: { phase: "waiting_llm", lastEventAt: baseNow - 8000, turnStartedAt: baseNow - 8000 },
      ls: { running: true, healthz: { reachable: true }, synSent443: 1, established443: 2 },
      now: baseNow,
    });
    assert.equal(mixedStuck.code, "SUSPECT_STALL");
    assert.match(mixedStuck.headline, /握手卡住/);
  });

  it("静默时间超过 stallThresholdSec 但探针正常时判定疑似模型卡顿；新 Hook 刚触发时不误报", () => {
    const stalled = computeVerdict({
      hook: { phase: "waiting_llm", lastEventAt: baseNow - 30000, turnStartedAt: baseNow - 30000 },
      transcript: { latestStepAt: baseNow - 30000, inferredPhase: "waiting_llm" },
      ls: { running: true, healthz: { reachable: true } },
      config: { stallThresholdSec: 25 },
      now: baseNow,
    });
    assert.equal(stalled.code, "SUSPECT_STALL");
    assert.equal(stalled.severity, "warning");
    assert.match(stalled.headline, /模型端卡顿/);

    const freshHookAfterSlowTool = computeVerdict({
      hook: { phase: "waiting_llm", lastEventAt: baseNow - 2000, turnStartedAt: baseNow - 45000 },
      transcript: { latestStepAt: baseNow - 40000, inferredPhase: "waiting_llm" },
      ls: { running: true, healthz: { reachable: true } },
      config: { stallThresholdSec: 25 },
      now: baseNow,
    });
    assert.equal(freshHookAfterSlowTool.code, "WAITING_LLM");
    assert.equal(freshHookAfterSlowTool.elapsedSec, 2);
  });

  it("本地工具执行阶段返回 RUNNING_TOOL", () => {
    const res = computeVerdict({
      hook: null,
      transcript: { latestStepAt: baseNow - 2000, inferredPhase: "running_tool", lastToolName: "run_command" },
      ls: { running: true, healthz: { reachable: true } },
      now: baseNow,
    });
    assert.equal(res.code, "RUNNING_TOOL");
    assert.equal(res.severity, "tool");
    assert.equal(res.source, "transcript");
    assert.match(res.summary, /run_command/);
  });

  it("空闲时按网络状态区分 IDLE 与 OFFLINE_IDLE", () => {
    const online = computeVerdict({
      hook: { phase: "idle", lastEventAt: baseNow - 1000 },
      probes: [{ ok: true, latencyMs: 215 }],
      consecutiveFailures: 0,
      now: baseNow,
    });
    assert.equal(online.code, "IDLE");
    assert.equal(online.severity, "ok");
    assert.match(online.summary, /215 ms/);

    const offline = computeVerdict({
      hook: { phase: "idle", lastEventAt: baseNow - 1000 },
      consecutiveFailures: 2,
      now: baseNow,
    });
    assert.equal(offline.code, "OFFLINE_IDLE");
    assert.equal(offline.severity, "warning");
  });

  it("超过 15 分钟陈旧的 Hook 自动回落为 idle", () => {
    const staleMs = 16 * 60 * 1000;
    const res = computeVerdict({
      hook: { phase: "waiting_llm", lastEventAt: baseNow - staleMs, turnStartedAt: baseNow - staleMs },
      probes: [{ ok: true, latencyMs: 100 }],
      now: baseNow,
    });
    assert.equal(res.phase, "idle");
    assert.equal(res.code, "IDLE");
  });

  it("支持英文文案输出（config.lang = en）", () => {
    const waitingEn = computeVerdict({
      hook: { phase: "waiting_llm", lastEventAt: baseNow - 4000, turnStartedAt: baseNow - 4000 },
      ls: { running: true, healthz: { reachable: true } },
      config: { stallThresholdSec: 25, lang: "en" },
      now: baseNow,
    });
    assert.equal(waitingEn.code, "WAITING_LLM");
    assert.match(waitingEn.headline, /Waiting for Model Response/);
    assert.match(waitingEn.summary, /Waiting 4s/);

    const hangEn = computeVerdict({
      hook: { phase: "waiting_llm", lastEventAt: baseNow - 10000 },
      ls: { running: true, healthz: { reachable: true } },
      consecutiveFailures: 2,
      config: { stallThresholdSec: 25, lang: "en" },
      now: baseNow,
    });
    assert.equal(hangEn.code, "DISCONNECTED_HANG");
    assert.match(hangEn.headline, /False Working · Upstream Unreachable/);
  });

  it("Stop Hook 后 Transcript 延迟落盘不回退回工作中，真正新步骤则切换", () => {
    const tStop = baseNow - 1000;
    const afterLateFlush = computeVerdict({
      hook: { phase: "idle", lastEvent: "Stop", lastEventAt: tStop },
      transcript: {
        latestStepAt: tStop + 80,
        latestRecordCreatedAt: tStop - 200,
        inferredPhase: "running_tool",
        lastToolName: "run_command",
      },
      ls: { running: true, healthz: { reachable: true } },
      probes: [{ ok: true, latencyMs: 90 }],
      now: baseNow,
    });
    assert.equal(afterLateFlush.code, "IDLE");
    assert.equal(afterLateFlush.source, "hook");

    const afterNewTurn = computeVerdict({
      hook: { phase: "idle", lastEvent: "Stop", lastEventAt: tStop - 5000 },
      transcript: {
        latestStepAt: tStop + 200,
        latestRecordCreatedAt: tStop + 200,
        inferredPhase: "waiting_llm",
      },
      ls: { running: true, healthz: { reachable: true } },
      now: baseNow,
    });
    assert.equal(afterNewTurn.code, "WAITING_LLM");
    assert.equal(afterNewTurn.source, "transcript");
  });

  it("近期 PreInvocation 后不应沿用旧日志时间误报 120s 无响应，卡顿阈值以最新活动为准", () => {
    const baseNow = 1_700_000_000_000;
    const stallVerdict = computeVerdict({
      hook: { phase: "waiting_llm", lastEvent: "PreInvocation", lastEventAt: baseNow - 30_000 },
      transcript: { latestStepAt: baseNow - 120_000, inferredPhase: "idle" },
      ls: { running: true, healthz: { reachable: true } },
      probes: [{ ok: true, latencyMs: 60 }],
      consecutiveFailures: 0,
      config: { stallThresholdSec: 25, lang: "zh" },
      now: baseNow,
    });
    assert.equal(stallVerdict.code, "SUSPECT_STALL");
    assert.equal(stallVerdict.messageKey, "MODEL_STALL");
    assert.equal(stallVerdict.elapsedSec, 30);
    assert.equal(stallVerdict.hookAgeSec, 30);
    assert.equal(stallVerdict.silentSec, 120);
    assert.equal(stallVerdict.messageParams.silentSec, 30);
    assert.match(stallVerdict.summary, /30s/);
    assert.doesNotMatch(stallVerdict.summary, /120s/);

    const freshVerdict = computeVerdict({
      hook: { phase: "waiting_llm", lastEvent: "PreInvocation", lastEventAt: baseNow - 5_000 },
      transcript: { latestStepAt: baseNow - 120_000, inferredPhase: "idle" },
      ls: { running: true, healthz: { reachable: true } },
      probes: [{ ok: true, latencyMs: 60 }],
      consecutiveFailures: 0,
      config: { stallThresholdSec: 25, lang: "zh" },
      now: baseNow,
    });
    assert.equal(freshVerdict.code, "WAITING_LLM");
    assert.equal(freshVerdict.elapsedSec, 5);
    assert.equal(freshVerdict.hookAgeSec, 5);
    assert.equal(freshVerdict.activityAgeSec, 5);
  });

  it("ERROR_MESSAGE 后台重试时不误报 IDLE，正确识别为 API_RETRY 并覆盖边界条件", () => {
    const t0 = 1_700_000_000_000;
    const uploadErr = parseTranscriptError({
      type: "ERROR_MESSAGE",
      error:
        'API error (attempt 1): request failed: Post "https://example.invalid/v1internal:streamGenerateContent": write tcp 192.0.2.1:50001->192.0.2.2:443: wsasend: An existing connection was forcibly closed by the remote host.',
    });

    // 1. PreInvocation 在 T0，ERROR_MESSAGE (attempt 1, wsasend) 在 T0+52s，now = T0+109s，探针绿灯 306ms
    const retrying = computeVerdict({
      hook: { phase: "waiting_llm", lastEvent: "PreInvocation", lastEventAt: t0 },
      transcript: {
        latestStepIndex: 212,
        latestStepType: "ERROR_MESSAGE",
        latestStepAt: t0 + 52_000,
        inferredPhase: "waiting_llm",
        latestError: uploadErr,
      },
      ls: { running: true, healthz: { reachable: true }, established443: 6, synSent443: 0 },
      probes: [{ ok: true, latencyMs: 306 }],
      consecutiveFailures: 0,
      config: { stallThresholdSec: 25, lang: "zh" },
      now: t0 + 109_000,
    });
    assert.equal(retrying.code, "API_RETRY");
    assert.equal(retrying.severity, "warning");
    assert.equal(retrying.phase, "waiting_llm");
    assert.equal(retrying.messageKey, "API_UPLOAD_RESET");
    assert.match(retrying.headline, /接口上传中断.*第 1 次/);
    assert.match(retrying.summary, /\/compact/);
    assert.doesNotMatch(retrying.summary, /192\.0\.2\.1/);

    // 2. attempt >= 3 或 network_error 升级为 danger，但仍为 API_RETRY（不触碰 DISCONNECTED_HANG 通知）
    const attempt3 = computeVerdict({
      hook: { phase: "waiting_llm", lastEvent: "PreInvocation", lastEventAt: t0 },
      transcript: {
        latestStepType: "ERROR_MESSAGE",
        latestStepAt: t0 + 52_000,
        inferredPhase: "waiting_llm",
        latestError: { ...uploadErr, attempt: 3 },
      },
      ls: { running: true, healthz: { reachable: true } },
      consecutiveFailures: 0,
      now: t0 + 60_000,
    });
    assert.equal(attempt3.code, "API_RETRY");
    assert.equal(attempt3.severity, "danger");

    const netErrRetry = computeVerdict({
      hook: { phase: "waiting_llm", lastEvent: "PreInvocation", lastEventAt: t0 },
      transcript: {
        latestStepType: "ERROR_MESSAGE",
        latestStepAt: t0 + 10_000,
        inferredPhase: "waiting_llm",
        latestError: parseTranscriptError({
          type: "ERROR_MESSAGE",
          error: "agent executor error: model unreachable: dial tcp 192.0.2.2:443: connection refused",
        }),
      },
      ls: { running: true, healthz: { reachable: true } },
      config: { lang: "en" },
      now: t0 + 15_000,
    });
    assert.equal(netErrRetry.code, "API_RETRY");
    assert.equal(netErrRetry.severity, "danger");
    assert.equal(netErrRetry.messageKey, "API_STREAM_ERROR");
    assert.match(netErrRetry.headline, /Model API Error/);

    // 3. 若同时上游探针连续失败 2 次，优先升级为 DISCONNECTED_HANG
    const withProbeDown = computeVerdict({
      hook: { phase: "waiting_llm", lastEvent: "PreInvocation", lastEventAt: t0 },
      transcript: {
        latestStepType: "ERROR_MESSAGE",
        latestStepAt: t0 + 52_000,
        inferredPhase: "waiting_llm",
        latestError: uploadErr,
      },
      ls: { running: true, healthz: { reachable: true } },
      consecutiveFailures: 2,
      now: t0 + 60_000,
    });
    assert.equal(withProbeDown.code, "DISCONNECTED_HANG");
    assert.equal(withProbeDown.messageKey, "NET_DOWN_HANG");

    // 4. Stop Hook 在 ERROR_MESSAGE 之后到达 -> IDLE
    const stoppedAfterError = computeVerdict({
      hook: { phase: "idle", lastEvent: "Stop", lastEventAt: t0 + 60_000 },
      transcript: {
        latestStepType: "ERROR_MESSAGE",
        latestStepAt: t0 + 52_000,
        latestRecordCreatedAt: t0 + 52_000,
        inferredPhase: "waiting_llm",
        latestError: uploadErr,
      },
      ls: { running: true, healthz: { reachable: true } },
      probes: [{ ok: true, latencyMs: 120 }],
      now: t0 + 62_000,
    });
    assert.equal(stoppedAfterError.code, "IDLE");

    // 5. 新 PreInvocation 在旧 ERROR_MESSAGE 之后 > 1s 到达 -> 清除旧报错，恢复 WAITING_LLM
    const newPreAfterOldErr = computeVerdict({
      hook: { phase: "waiting_llm", lastEvent: "PreInvocation", lastEventAt: t0 + 70_000 },
      transcript: {
        latestStepType: "ERROR_MESSAGE",
        latestStepAt: t0 + 52_000,
        inferredPhase: "waiting_llm",
        latestError: uploadErr,
      },
      ls: { running: true, healthz: { reachable: true } },
      now: t0 + 75_000,
    });
    assert.equal(newPreAfterOldErr.code, "WAITING_LLM");

    // 6. 活跃 PreInvocation (<5m) 期间写入未知非终态日志步骤时保持 waiting_llm；若是终态 PLANNER_RESPONSE 则回 IDLE
    const unknownStepDuringHook = computeVerdict({
      hook: { phase: "waiting_llm", lastEvent: "PreInvocation", lastEventAt: t0 },
      transcript: {
        latestStepType: "FUTURE_INTERMEDIATE_STEP",
        latestStepAt: t0 + 10_000,
        inferredPhase: "idle",
      },
      ls: { running: true, healthz: { reachable: true } },
      now: t0 + 15_000,
    });
    assert.equal(unknownStepDuringHook.code, "WAITING_LLM");
    assert.equal(unknownStepDuringHook.source, "hook");

    const terminalPlannerDuringHook = computeVerdict({
      hook: { phase: "waiting_llm", lastEvent: "PreInvocation", lastEventAt: t0 },
      transcript: {
        latestStepType: "PLANNER_RESPONSE",
        latestStepAt: t0 + 10_000,
        inferredPhase: "idle",
      },
      ls: { running: true, healthz: { reachable: true } },
      probes: [{ ok: true, latencyMs: 95 }],
      now: t0 + 15_000,
    });
    assert.equal(terminalPlannerDuringHook.code, "IDLE");

    // 7. tool_parse 类型 ERROR_MESSAGE 不触发 API_RETRY
    const toolParseVerdict = computeVerdict({
      hook: { phase: "waiting_llm", lastEvent: "PreInvocation", lastEventAt: t0 },
      transcript: {
        latestStepType: "ERROR_MESSAGE",
        latestStepAt: t0 + 5_000,
        inferredPhase: "waiting_llm",
        latestError: parseTranscriptError({
          type: "ERROR_MESSAGE",
          error: "There was a problem parsing the tool call.",
        }),
      },
      ls: { running: true, healthz: { reachable: true } },
      now: t0 + 8_000,
    });
    assert.equal(toolParseVerdict.code, "WAITING_LLM");
  });

  it("BACKGROUND_TASK（fullyIdle: false）等待后台回调时不误报 IDLE 或卡顿，完成后自动恢复", () => {
    const t0 = 1_700_000_000_000;
    const bgActive = computeVerdict({
      hook: { phase: "background_task", lastEvent: "Stop", lastEventAt: t0, fullyIdle: false },
      transcript: { latestStepType: "PLANNER_RESPONSE", latestStepAt: t0 + 80, latestRecordCreatedAt: t0 - 200, inferredPhase: "idle" },
      ls: { running: true, healthz: { reachable: true } },
      probes: [{ ok: true, latencyMs: 110 }],
      config: { stallThresholdSec: 25, lang: "zh" },
      now: t0 + 6 * 60 * 1000,
    });
    assert.equal(bgActive.code, "BACKGROUND_TASK");
    assert.equal(bgActive.severity, "tool");
    assert.equal(bgActive.phase, "background_task");
    assert.match(bgActive.headline, /后台任务/);

    const bgEn = computeVerdict({
      hook: { phase: "background_task", lastEvent: "Stop", lastEventAt: t0, fullyIdle: false },
      ls: { running: true, healthz: { reachable: true } },
      config: { lang: "en" },
      now: t0 + 15_000,
    });
    assert.equal(bgEn.code, "BACKGROUND_TASK");
    assert.match(bgEn.headline, /Background Task/);

    const resumed = computeVerdict({
      hook: { phase: "background_task", lastEvent: "Stop", lastEventAt: t0, fullyIdle: false },
      transcript: {
        latestStepType: "SYSTEM_MESSAGE",
        latestStepAt: t0 + 20_000,
        latestRecordCreatedAt: t0 + 20_000,
        inferredPhase: "waiting_llm",
      },
      ls: { running: true, healthz: { reachable: true } },
      now: t0 + 21_000,
    });
    assert.equal(resumed.code, "WAITING_LLM");
    assert.equal(resumed.source, "transcript");
  });

  it("纯慢超时、/healthz 单次抖动与带健康连接的孤立 SYN_SENT 均做防抖处理", () => {
    const t0 = 1_700_000_000_000;
    const hook = { phase: "waiting_llm", lastEvent: "PreInvocation", lastEventAt: t0 };

    const timeout2 = computeVerdict({
      hook,
      ls: { running: true, healthz: { reachable: true, consecutiveFailures: 0 } },
      probes: [
        { ok: false, error: "请求超时" },
        { ok: false, error: "请求超时" },
      ],
      consecutiveFailures: 2,
      now: t0 + 8_000,
    });
    assert.equal(timeout2.code, "SUSPECT_STALL");
    assert.equal(timeout2.messageKey, "NET_SUSPECT");

    const timeout3 = computeVerdict({
      hook,
      ls: { running: true, healthz: { reachable: true, consecutiveFailures: 0 } },
      probes: [
        { ok: false, error: "请求超时" },
        { ok: false, error: "请求超时" },
        { ok: false, error: "请求超时" },
      ],
      consecutiveFailures: 3,
      now: t0 + 12_000,
    });
    assert.equal(timeout3.code, "DISCONNECTED_HANG");
    assert.equal(timeout3.messageKey, "NET_DOWN_HANG");

    const hardErr2 = computeVerdict({
      hook,
      ls: { running: true, healthz: { reachable: true, consecutiveFailures: 0 } },
      probes: [
        { ok: false, error: "ENOTFOUND" },
        { ok: false, error: "ENOTFOUND" },
      ],
      consecutiveFailures: 2,
      now: t0 + 8_000,
    });
    assert.equal(hardErr2.code, "DISCONNECTED_HANG");

    const healthz1 = computeVerdict({
      hook,
      ls: { running: true, healthz: { reachable: false, consecutiveFailures: 1 } },
      now: t0 + 4_000,
    });
    assert.equal(healthz1.code, "WAITING_LLM");

    const healthz2 = computeVerdict({
      hook,
      ls: { running: true, healthz: { reachable: false, consecutiveFailures: 2 } },
      now: t0 + 9_000,
    });
    assert.equal(healthz2.code, "DISCONNECTED_HANG");
    assert.equal(healthz2.messageKey, "LS_DOWN");

    const synOnce = computeVerdict({
      hook,
      ls: { running: true, healthz: { reachable: true }, established443: 4, synSent443: 1, synStallStreak: 1 },
      now: t0 + 8_000,
    });
    assert.equal(synOnce.code, "WAITING_LLM");

    const synTwice = computeVerdict({
      hook,
      ls: { running: true, healthz: { reachable: true }, established443: 4, synSent443: 1, synStallStreak: 2 },
      now: t0 + 12_000,
    });
    assert.equal(synTwice.code, "SUSPECT_STALL");
    assert.equal(synTwice.messageKey, "LS_SYN_STALL");
  });
});

describe("transcript-reader 错误解析与阶段推断", () => {
  it("parseTranscriptError 分类提取并脱敏各类 ERROR_MESSAGE", () => {
    assert.equal(parseTranscriptError(null), null);
    assert.equal(parseTranscriptError({ type: "PLANNER_RESPONSE", status: "DONE" }), null);

    const emptyErr = parseTranscriptError({ type: "ERROR_MESSAGE" });
    assert.equal(emptyErr.kind, "unknown");
    assert.equal(emptyErr.attempt, null);
    assert.equal(emptyErr.shortReason, "API error");

    const wsasendErr = parseTranscriptError({
      type: "ERROR_MESSAGE",
      error:
        'API error (attempt 2): request failed: Post "https://example.invalid/v1": write tcp 192.0.2.10:54321->192.0.2.20:443: wsasend: An existing connection was forcibly closed by the remote host.',
    });
    assert.equal(wsasendErr.kind, "upload_reset");
    assert.equal(wsasendErr.attempt, 2);
    assert.equal(wsasendErr.shortReason, "wsasend: connection forcibly closed");
    assert.doesNotMatch(wsasendErr.shortReason, /192\.0\.2/);

    const eofErr = parseTranscriptError({
      type: "ERROR_MESSAGE",
      error: 'API error (attempt 4): Post "https://example.invalid/v1": EOF',
    });
    assert.equal(eofErr.kind, "upstream_eof");
    assert.equal(eofErr.attempt, 4);
    assert.equal(eofErr.shortReason, "upstream EOF");

    const timeoutErr = parseTranscriptError({
      type: "ERROR_MESSAGE",
      error: "API error (attempt 1): request failed: stream idle timeout (5m0s): context canceled",
    });
    assert.equal(timeoutErr.kind, "stream_timeout");
    assert.equal(timeoutErr.shortReason, "stream idle timeout (5m0s)");

    const interruptedErr = parseTranscriptError({
      type: "ERROR_MESSAGE",
      error: "The stream was interrupted. Please continue the task you were working on.",
    });
    assert.equal(interruptedErr.kind, "stream_interrupted");
    assert.equal(interruptedErr.shortReason, "stream interrupted");

    const unreachableErr = parseTranscriptError({
      type: "ERROR_MESSAGE",
      error: "agent executor error: model unreachable: no such host",
    });
    assert.equal(unreachableErr.kind, "network_error");
    assert.equal(unreachableErr.shortReason, "model API unreachable");

    const toolParseErr = parseTranscriptError({
      type: "ERROR_MESSAGE",
      error: "There was a problem parsing the tool call.",
    });
    assert.equal(toolParseErr.kind, "tool_parse");

    const genericErr = parseTranscriptError({
      type: "ERROR_MESSAGE",
      error: 'API error (attempt 2): Post "https://example.invalid/v1": HTTP 503 upstream busy',
    });
    assert.equal(genericErr.kind, "api_error");
    assert.equal(genericErr.attempt, 2);
    assert.doesNotMatch(genericErr.shortReason, /https:\/\//);
    assert.match(genericErr.shortReason, /HTTP 503 upstream busy/);
  });

  it("inferTranscriptPhase 识别 ERROR_MESSAGE、并行工具进度、异常中止工具态与未完成后台任务", () => {
    for (const type of ["ERROR_MESSAGE", "RUN_COMMAND", "SYSTEM_MESSAGE", "CHECKPOINT"]) {
      assert.equal(inferTranscriptPhase({ type }, true), "waiting_llm");
      assert.equal(inferTranscriptPhase({ type }, false), "idle");
    }
    assert.equal(inferTranscriptPhase({ type: "PLANNER_RESPONSE", status: "DONE" }, true), "idle");

    for (const st of ABORTED_PLANNER_STATUSES) {
      assert.equal(
        inferTranscriptPhase({ type: "PLANNER_RESPONSE", status: st, tool_calls: [{ name: "run_command" }] }, true),
        "idle",
      );
    }

    const batchPlanner = {
      type: "PLANNER_RESPONSE",
      status: "DONE",
      tool_calls: [{ name: "read_file" }, { name: "read_file" }, { name: "read_file" }, { name: "run_command" }],
    };
    const partialParsed = [
      batchPlanner,
      { type: "GENERIC", status: "DONE" },
      { type: "GENERIC", status: "DONE" },
      { type: "GENERIC", status: "DONE" },
    ];
    assert.equal(hasPendingParallelTools(partialParsed), true);
    assert.equal(inferTranscriptPhase(partialParsed[partialParsed.length - 1], true, partialParsed), "running_tool");

    const fullParsed = [...partialParsed, { type: "GENERIC", status: "DONE" }];
    assert.equal(hasPendingParallelTools(fullParsed), false);
    assert.equal(inferTranscriptPhase(fullParsed[fullParsed.length - 1], true, fullParsed), "waiting_llm");

    const bgParsed = [
      { type: "USER_INPUT", content: "run tests" },
      { type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "run_command" }] },
      {
        type: "GENERIC",
        status: "RUNNING",
        content: "Tool is running as a background task with task id: conv/task-101",
      },
      { type: "PLANNER_RESPONSE", status: "DONE", content: "Waiting in background" },
    ];
    assert.equal(hasPendingBackgroundTask(bgParsed), true);
    assert.equal(inferTranscriptPhase(bgParsed[bgParsed.length - 1], true, bgParsed), "background_task");

    const bgFinishedParsed = [
      ...bgParsed,
      { type: "SYSTEM_MESSAGE", content: 'Task id "conv/task-101" finished with result' },
      { type: "PLANNER_RESPONSE", status: "DONE", content: "All done" },
    ];
    assert.equal(hasPendingBackgroundTask(bgFinishedParsed), false);
    assert.equal(inferTranscriptPhase(bgFinishedParsed[bgFinishedParsed.length - 1], true, bgFinishedParsed), "idle");
  });
});
