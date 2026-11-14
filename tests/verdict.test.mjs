import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
});
