import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createStateStore } from "../sidecars/status-monitor/lib/state-store.mjs";
import { localNoonIso, withTempDir, writeJsonl } from "./helpers.mjs";

describe("createStateStore（多会话状态隔离与 Transcript 解析）", () => {
  it("不同 conversationId 的 Hook 状态互相隔离", async () => {
    await withTempDir(async (dir) => {
      const store = createStateStore({
        brainDirs: [join(dir, "brain")],
        fallbackHookPath: join(dir, "hook-state.json"),
      });

      store.applyHookEvent({
        eventName: "PreInvocation",
        receivedAt: Date.now(),
        payload: { conversationId: "conv-A", invocationNum: 1 },
      });
      store.applyHookEvent({
        eventName: "Stop",
        receivedAt: Date.now() + 10,
        payload: { conversationId: "conv-B", terminationReason: "DONE" },
      });

      const snapA = store.buildSnapshot({
        probes: [{ ok: true, latencyMs: 120 }],
        consecutiveFailures: 0,
        ls: { running: true, healthz: { reachable: true } },
        simulation: { active: false },
        config: { stallThresholdSec: 25 },
        requestedConvId: "conv-A",
      });
      const snapB = store.buildSnapshot({
        probes: [{ ok: true, latencyMs: 120 }],
        consecutiveFailures: 0,
        ls: { running: true, healthz: { reachable: true } },
        simulation: { active: false },
        config: { stallThresholdSec: 25 },
        requestedConvId: "conv-B",
      });

      assert.equal(snapA.activeConversationId, "conv-A");
      assert.equal(snapA.verdict.code, "WAITING_LLM");
      assert.equal(snapB.activeConversationId, "conv-B");
      assert.equal(snapB.verdict.code, "IDLE");
    });
  });

  it("scanTranscript 自动识别工具执行阶段并按 step 去重时间线事件", async () => {
    await withTempDir(async (dir) => {
      const brainDir = join(dir, "brain");
      const convId = "conv-tool-1";
      const transcriptPath = join(brainDir, convId, ".system_generated/logs/transcript.jsonl");
      const nowIso = new Date().toISOString();

      writeJsonl(transcriptPath, [
        { step_index: 0, type: "USER_INPUT", content: "check", created_at: nowIso },
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          status: "PENDING",
          tool_calls: [{ name: "read_file" }, { name: "run_command" }],
          created_at: nowIso,
        },
      ]);

      const store = createStateStore({
        brainDirs: [brainDir],
        fallbackHookPath: join(dir, "hook-state.json"),
      });

      const changed1 = store.scanTranscript(convId, true);
      const changed2 = store.scanTranscript(convId, true);
      assert.equal(changed1, true);
      assert.equal(changed2, false);

      const toolEvents = store.events.filter((e) => e.kind === "tool");
      assert.equal(toolEvents.length, 1);
      assert.match(toolEvents[0].title, /read_file, run_command/);

      const conv = store.resolveActiveConversation(convId);
      assert.equal(conv.transcript.inferredPhase, "running_tool");
      assert.equal(conv.transcript.lastToolName, "read_file, run_command");
    });
  });

  it("超过 10 分钟陈旧的 Transcript 文件推断为 idle", async () => {
    await withTempDir(async (dir) => {
      const brainDir = join(dir, "brain");
      const convId = "conv-stale";
      const transcriptPath = join(brainDir, convId, ".system_generated/logs/transcript.jsonl");
      const oldDate = new Date(Date.now() - 12 * 60 * 1000);

      writeJsonl(transcriptPath, [
        { step_index: 0, type: "USER_INPUT", content: "old", created_at: oldDate.toISOString() },
      ]);
      utimesSync(transcriptPath, oldDate, oldDate);

      const store = createStateStore({
        brainDirs: [brainDir],
        fallbackHookPath: join(dir, "hook-state.json"),
      });
      store.scanTranscript(convId, false);
      const conv = store.resolveActiveConversation(convId);
      assert.equal(conv.transcript.inferredPhase, "idle");
    });
  });

  it("loadFallbackHookIfNewer 仅加载比内存更新的降级 Hook 状态", async () => {
    await withTempDir(async (dir) => {
      const fallbackPath = join(dir, "hook-state.json");
      const store = createStateStore({
        brainDirs: [join(dir, "brain")],
        fallbackHookPath: fallbackPath,
      });

      const newerTs = Date.now();
      writeFileSync(
        fallbackPath,
        JSON.stringify({
          eventName: "PreInvocation",
          receivedAt: newerTs,
          payload: { conversationId: "conv-fb", modelName: "test-model" },
        }),
        "utf8",
      );

      store.loadFallbackHookIfNewer();
      assert.equal(store.resolveActiveConversation("conv-fb").hook.phase, "waiting_llm");

      writeFileSync(
        fallbackPath,
        JSON.stringify({
          eventName: "Stop",
          receivedAt: newerTs - 5000,
          payload: { conversationId: "conv-fb" },
        }),
        "utf8",
      );
      store.loadFallbackHookIfNewer();
      assert.equal(store.resolveActiveConversation("conv-fb").hook.phase, "waiting_llm");
    });
  });

  it("buildSnapshot 自动清理过期模拟告警并聚合探针成功率与均值", async () => {
    await withTempDir(async (dir) => {
      const { iso } = localNoonIso();
      const brainDir = join(dir, "brain");
      writeJsonl(join(brainDir, "conv-m/.system_generated/logs/transcript.jsonl"), [
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          input_tokens: 50,
          cache_read_tokens: 150,
          output_tokens: 20,
          created_at: iso,
        },
      ]);

      const store = createStateStore({
        brainDirs: [brainDir],
        fallbackHookPath: join(dir, "hook-state.json"),
      });
      const simulation = { active: true, expiresAt: Date.now() - 100 };
      const snap = store.buildSnapshot({
        probes: [
          { ok: true, latencyMs: 100 },
          { ok: false, latencyMs: 2500 },
          { ok: true, latencyMs: 200 },
        ],
        consecutiveFailures: 0,
        ls: { running: true, healthz: { reachable: true } },
        simulation,
        config: { stallThresholdSec: 25 },
        requestedConvId: "conv-m",
      });

      assert.equal(simulation.active, false);
      assert.equal(snap.metrics.avgLatencyMs, 150);
      assert.equal(snap.metrics.successRate, 67);
      assert.equal(snap.tokenStats.session.total, 220);
    });
  });

  it("日志有新输出时即使 created_at 早于写入时间，等待时间也立即归零", async () => {
    await withTempDir(async (dir) => {
      const brainDir = join(dir, "brain");
      const convId = "conv-reset-wait";
      const transcriptPath = join(brainDir, convId, ".system_generated/logs/transcript.jsonl");

      const oldCreatedAt = new Date(Date.now() - 40_000).toISOString();
      writeJsonl(transcriptPath, [
        { step_index: 0, type: "USER_INPUT", content: "long task", created_at: oldCreatedAt },
      ]);

      const store = createStateStore({
        brainDirs: [brainDir],
        fallbackHookPath: join(dir, "hook-state.json"),
      });

      store.applyHookEvent({
        eventName: "PreInvocation",
        receivedAt: Date.now() - 133_000,
        payload: { conversationId: convId },
      });

      store.refreshTranscript(convId, false);
      const snap1 = store.buildSnapshot({
        probes: [{ ok: true, latencyMs: 100 }],
        consecutiveFailures: 0,
        ls: { running: true, healthz: { reachable: true } },
        simulation: { active: false },
        config: { stallThresholdSec: 25 },
        requestedConvId: convId,
      });

      assert.equal(snap1.verdict.code, "WAITING_LLM");
      assert.ok(snap1.verdict.elapsedSec <= 2, `期望归零，实际 elapsedSec=${snap1.verdict.elapsedSec}`);

      appendFileSync(
        transcriptPath,
        JSON.stringify({
          step_index: 1,
          type: "GENERIC",
          status: "DONE",
          created_at: new Date(Date.now() - 35_000).toISOString(),
        }) + "\n",
        "utf8",
      );
      const refreshed = store.refreshTranscript(convId, false);
      assert.equal(refreshed, true);
      const snap2 = store.buildSnapshot({
        probes: [{ ok: true, latencyMs: 100 }],
        consecutiveFailures: 0,
        ls: { running: true, healthz: { reachable: true } },
        simulation: { active: false },
        config: { stallThresholdSec: 25 },
        requestedConvId: convId,
      });
      assert.equal(snap2.verdict.code, "WAITING_LLM");
      assert.ok(snap2.verdict.elapsedSec <= 2);
    });
  });

  it("已记录的历史时间线事件随 config.lang 动态切换中英文", async () => {
    await withTempDir(async (dir) => {
      const store = createStateStore({
        brainDirs: [join(dir, "brain")],
        fallbackHookPath: join(dir, "hook-state.json"),
      });

      store.applyHookEvent({
        eventName: "PreInvocation",
        receivedAt: Date.now(),
        payload: { conversationId: "conv-i18n", invocationNum: 2 },
      });

      const snapZh = store.buildSnapshot({
        probes: [{ ok: true, latencyMs: 100 }],
        consecutiveFailures: 0,
        ls: { running: true, healthz: { reachable: true } },
        simulation: { active: false },
        config: { stallThresholdSec: 25, lang: "zh" },
        requestedConvId: "conv-i18n",
      });
      const snapEn = store.buildSnapshot({
        probes: [{ ok: true, latencyMs: 100 }],
        consecutiveFailures: 0,
        ls: { running: true, healthz: { reachable: true } },
        simulation: { active: false },
        config: { stallThresholdSec: 25, lang: "en" },
        requestedConvId: "conv-i18n",
      });

      assert.match(snapZh.events[0].title, /开始请求模型/);
      assert.match(snapEn.events[0].title, /Requesting Model/);
      assert.match(snapEn.events[0].detail, /Call #2/);
    });
  });

  it("支持 transcript_full.jsonl 状态兜底、钉选旧 convId 扫描及过期 fallbackHook 清理", async () => {
    await withTempDir(async (dir) => {
      const brainDir = join(dir, "brain");
      const fallbackPath = join(dir, "hook-state.json");
      const oldConvPath = join(brainDir, "conv-pinned/.system_generated/logs/transcript_full.jsonl");
      const newConvPath = join(brainDir, "conv-newest/.system_generated/logs/transcript.jsonl");
      const oldTs = new Date(Date.now() - 10_000).toISOString();
      const newTs = new Date().toISOString();

      writeJsonl(oldConvPath, [{ step_index: 1, type: "USER_INPUT", content: "hi", created_at: oldTs }]);
      writeJsonl(newConvPath, [
        { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", created_at: newTs },
      ]);

      const store = createStateStore({ brainDirs: [brainDir], fallbackHookPath: fallbackPath });
      store.scanTranscript(null, false);
      assert.equal(store.resolveActiveConversation("conv-pinned").transcript.inferredPhase, "waiting_llm");

      appendFileSync(
        oldConvPath,
        JSON.stringify({ step_index: 2, type: "PLANNER_RESPONSE", status: "DONE", created_at: newTs }) + "\n",
        "utf8",
      );
      const changedPinned = store.scanTranscript(new Set(["conv-pinned"]), false);
      assert.equal(changedPinned, true);
      assert.equal(store.resolveActiveConversation("conv-pinned").transcript.inferredPhase, "idle");

      writeFileSync(fallbackPath, JSON.stringify({ eventName: "PreInvocation", receivedAt: 5000 }));
      store.clearFallbackHook(4000);
      assert.equal(existsSync(fallbackPath), true);
      store.clearFallbackHook(5000);
      assert.equal(existsSync(fallbackPath), false);
    });
  });

  it("readTailLines 在最后一步单行超过 32KB 时自动回溯放大窗口解析", async () => {
    await withTempDir(async (dir) => {
      const brainDir = join(dir, "brain");
      const convId = "conv-huge-tail";
      const filePath = join(brainDir, convId, ".system_generated/logs/transcript_full.jsonl");
      const nowIso = new Date().toISOString();
      const hugeText = "A".repeat(70_000);

      writeJsonl(filePath, [
        { step_index: 1, type: "USER_INPUT", content: "start", created_at: nowIso },
        {
          step_index: 2,
          type: "PLANNER_RESPONSE",
          status: "PENDING",
          content: hugeText,
          tool_calls: [{ name: "run_command" }],
          input_tokens: 1200,
          output_tokens: 80,
          created_at: nowIso,
        },
      ]);

      const store = createStateStore({
        brainDirs: [brainDir],
        fallbackHookPath: join(dir, "hook-state.json"),
      });
      const changed = store.scanTranscript(convId, false);
      assert.equal(changed, true);
      const conv = store.resolveActiveConversation(convId);
      assert.equal(conv.transcript.latestStepIndex, 2);
      assert.equal(conv.transcript.inferredPhase, "running_tool");
      assert.equal(conv.transcript.lastToolName, "run_command");
      assert.equal(conv.transcript.tokens.input, 1200);
    });
  });

  it("空白新 convId 不窜用旧会话数据、异常终态识别为 idle、子代理写入不劫持主会话且支持 >2MB 单行", async () => {
    await withTempDir(async (dir) => {
      const brainDir = join(dir, "brain");
      const nowIso = new Date().toISOString();
      const mainPath = join(brainDir, "conv-main/.system_generated/logs/transcript.jsonl");
      const subPath = join(brainDir, "conv-subagent/.system_generated/logs/transcript.jsonl");
      const errPath = join(brainDir, "conv-err/.system_generated/logs/transcript.jsonl");
      const giantPath = join(brainDir, "conv-giant/.system_generated/logs/transcript.jsonl");

      writeJsonl(mainPath, [
        { step_index: 1, source: "USER_EXPLICIT", type: "USER_INPUT", content: "hi", created_at: nowIso },
      ]);
      writeJsonl(errPath, [
        { step_index: 1, type: "PLANNER_RESPONSE", status: "ERROR", created_at: nowIso },
      ]);
      writeJsonl(giantPath, [
        { step_index: 1, type: "USER_INPUT", content: "hi", created_at: nowIso },
        {
          step_index: 2,
          type: "PLANNER_RESPONSE",
          status: "CANCELLED",
          content: "X".repeat(2_600_000),
          input_tokens: 900,
          output_tokens: 50,
          created_at: nowIso,
        },
      ]);

      const store = createStateStore({
        brainDirs: [brainDir],
        fallbackHookPath: join(dir, "hook-state.json"),
      });

      const emptySnap = store.buildSnapshot({
        probes: [{ ok: true, latencyMs: 100 }],
        consecutiveFailures: 0,
        ls: { running: true, healthz: { reachable: true } },
        simulation: { active: false },
        config: { stallThresholdSec: 25 },
        requestedConvId: "brand-new-empty-conv",
      });
      assert.equal(emptySnap.activeConversationId, "brand-new-empty-conv");
      assert.equal(emptySnap.verdict.code, "IDLE");
      assert.equal(emptySnap.tokenStats.session.total, 0);

      store.scanTranscript("conv-err", false);
      assert.equal(store.resolveActiveConversation("conv-err").transcript.inferredPhase, "idle");

      store.scanTranscript("conv-giant", false);
      const giantConv = store.resolveActiveConversation("conv-giant");
      assert.equal(giantConv.transcript.latestStepIndex, 2);
      assert.equal(giantConv.transcript.inferredPhase, "idle");

      store.applyHookEvent({
        eventName: "PreInvocation",
        receivedAt: Date.now() - 5000,
        payload: { conversationId: "conv-main", invocationNum: 1 },
      });
      store.scanTranscript("conv-main", false);
      writeJsonl(subPath, [
        { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", created_at: new Date(Date.now() + 5000).toISOString() },
      ]);
      const futureTime = new Date(Date.now() + 5000);
      utimesSync(subPath, futureTime, futureTime);
      store.scanTranscript(["conv-subagent", "conv-main"], false);
      assert.equal(store.resolveActiveConversation("conv-main").hook.conversationId, "conv-main");
      assert.equal(store.resolveActiveConversation("conv-main").hook.phase, "waiting_llm");
      assert.equal(store.resolveActiveConversation(null).hook.conversationId, null);
    });
  });

  it("多窗口 .runtime/hooks 作用域隔离：仅加载与清理匹配 lsAddress / conversationId 的离线文件", async () => {
    await withTempDir(async (dir) => {
      const brainDir = join(dir, "brain");
      const hooksDir = join(dir, "hooks");
      mkdirSync(hooksDir, { recursive: true });
      const now = Date.now();
      const fileA = join(hooksDir, "ls-win-a.json");
      const fileB = join(hooksDir, "ls-win-b.json");

      writeFileSync(
        fileA,
        JSON.stringify({
          eventName: "PreInvocation",
          receivedAt: now,
          lsAddress: "127.0.0.1:1111",
          payload: { conversationId: "conv-win-a" },
        }),
      );
      writeFileSync(
        fileB,
        JSON.stringify({
          eventName: "PreInvocation",
          receivedAt: now,
          lsAddress: "127.0.0.1:2222",
          payload: { conversationId: "conv-win-b" },
        }),
      );

      const storeA = createStateStore({
        brainDirs: [brainDir],
        fallbackHookPath: join(dir, "hook-state.json"),
        fallbackHooksDir: hooksDir,
        lsAddress: "127.0.0.1:1111",
      });
      storeA.loadFallbackHookIfNewer();
      assert.equal(storeA.resolveActiveConversation("conv-win-a").hook.phase, "waiting_llm");
      assert.equal(storeA.resolveActiveConversation("conv-win-b").hook.lastEvent, null);

      storeA.clearFallbackHook(now + 100, { conversationId: "conv-win-a", lsAddress: "127.0.0.1:1111" });
      assert.equal(existsSync(fileA), false);
      assert.equal(existsSync(fileB), true);
    });
  });

  it("彻底屏蔽 auto 切换与 recentConversations 列表，未指定 convId 时不劫持其他活跃会话", async () => {
    await withTempDir(async (dir) => {
      const store = createStateStore({
        brainDirs: [join(dir, "brain")],
        fallbackHookPath: join(dir, "hook-state.json"),
      });
      const t0 = Date.now();
      store.applyHookEvent({
        eventName: "PreInvocation",
        receivedAt: t0 - 2000,
        payload: { conversationId: "conv-a", invocationNum: 1 },
      });
      store.applyHookEvent({
        eventName: "PreInvocation",
        receivedAt: t0,
        payload: { conversationId: "conv-b", invocationNum: 2 },
      });

      assert.equal(store.resolveActiveConversation("auto").hook.conversationId, null);
      assert.equal(store.resolveActiveConversation(null).hook.conversationId, null);

      const snapAuto = store.buildSnapshot({
        probes: [{ ok: true, latencyMs: 50 }],
        consecutiveFailures: 0,
        ls: { running: true, healthz: { reachable: true } },
        simulation: { active: false },
        config: { stallThresholdSec: 25, lang: "zh" },
        requestedConvId: "auto",
      });
      assert.equal(snapAuto.activeConversationId, null);
      assert.equal(snapAuto.verdict.code, "IDLE");
      assert.equal("recentConversations" in snapAuto, false);
      assert.equal(snapAuto.events.some((e) => Boolean(e.conversationId)), false);
    });
  });

  it("物理分桶严格隔离不同会话事件流，其他会话高频事件不挤占本对话并保留全局网络变化", async () => {
    await withTempDir(async (dir) => {
      const store = createStateStore({
        brainDirs: [join(dir, "brain")],
        fallbackHookPath: join(dir, "fallback.json"),
      });
      const t0 = Date.now();
      store.pushTimelineEvent("probe", "网络正常", "50ms", "info");
      store.applyHookEvent({
        eventName: "PreInvocation",
        receivedAt: t0 - 2000,
        payload: { conversationId: "conv-a", invocationNum: 1 },
      });
      // 无归属的模拟操作也不应泄漏进 conv-a 或 conv-b
      store.pushTimelineEvent("sim", "开启断网警报预览", "", "warn", null, { key: "SIM_ON" });
      // conv-b 连续产生 50 条事件，不得挤掉或混入 conv-a
      for (let i = 1; i <= 50; i++) {
        store.applyHookEvent({
          eventName: "PreInvocation",
          receivedAt: t0 + i * 10,
          payload: { conversationId: "conv-b", invocationNum: i },
        });
      }

      const snapA = store.buildSnapshot({
        probes: [{ ok: true, latencyMs: 50 }],
        consecutiveFailures: 0,
        ls: { running: true, healthz: { reachable: true } },
        simulation: { active: false },
        config: { stallThresholdSec: 25, lang: "zh" },
        requestedConvId: "conv-a",
      });
      assert.ok(snapA.events.some((e) => e.title === "网络正常"));
      assert.ok(snapA.events.some((e) => e.conversationId === "conv-a"));
      assert.equal(snapA.events.some((e) => e.conversationId === "conv-b"), false);
      assert.equal(snapA.events.some((e) => e.i18n?.key === "SIM_ON"), false);

      const snapB = store.buildSnapshot({
        probes: [{ ok: true, latencyMs: 50 }],
        consecutiveFailures: 0,
        ls: { running: true, healthz: { reachable: true } },
        simulation: { active: false },
        config: { stallThresholdSec: 25, lang: "zh" },
        requestedConvId: "conv-b",
      });
      assert.ok(snapB.events.some((e) => e.title === "网络正常"));
      assert.ok(snapB.events.some((e) => e.conversationId === "conv-b"));
      assert.equal(snapB.events.some((e) => e.conversationId === "conv-a"), false);
    });
  });

  it("解析 ERROR_MESSAGE 重试记录：同 step_index 不同时间戳独立记录事件流、严格会话隔离、stale-idle 与新响应后自动清理", async () => {
    await withTempDir(async (dir) => {
      const brainDir = join(dir, "brain");
      const convErr = "conv-err-retry";
      const convOther = "conv-other-clean";
      const transcriptPath = join(brainDir, convErr, ".system_generated/logs/transcript.jsonl");
      const t1 = new Date(Date.now() - 3000);
      const t2 = new Date(Date.now() - 1000);

      writeJsonl(transcriptPath, [
        { step_index: 211, type: "USER_INPUT", content: "question", created_at: new Date(Date.now() - 5000).toISOString() },
        {
          step_index: 212,
          type: "ERROR_MESSAGE",
          status: "DONE",
          error:
            'API error (attempt 1): request failed: Post "https://example.invalid/v1": write tcp 192.0.2.1:50001->192.0.2.2:443: wsasend: An existing connection was forcibly closed by the remote host.',
          created_at: t1.toISOString(),
        },
      ]);

      const store = createStateStore({
        brainDirs: [brainDir],
        fallbackHookPath: join(dir, "hook-state.json"),
      });

      assert.equal(store.scanTranscript(convErr, true), true);
      const snap1 = store.buildSnapshot({
        probes: [{ ok: true, latencyMs: 120 }],
        consecutiveFailures: 0,
        ls: { running: true, healthz: { reachable: true } },
        simulation: { active: false },
        config: { stallThresholdSec: 25, lang: "zh" },
        requestedConvId: convErr,
      });
      assert.equal(snap1.transcript.inferredPhase, "waiting_llm");
      assert.equal(snap1.transcript.latestError?.kind, "upload_reset");
      assert.equal(snap1.verdict.code, "API_RETRY");
      assert.equal(snap1.events.filter((e) => e.i18n?.key === "API_ERROR_STEP").length, 1);

      // 相同 step_index=212 但不同 created_at（如用户重发后再次失败）必须再次写入事件流，且不污染 convOther
      appendFileSync(
        transcriptPath,
        JSON.stringify({
          step_index: 212,
          type: "ERROR_MESSAGE",
          status: "DONE",
          error: 'API error (attempt 3): Post "https://example.invalid/v1": EOF',
          created_at: t2.toISOString(),
        }) + "\n",
        "utf8",
      );
      assert.equal(store.scanTranscript(convErr, true), true);
      const snap2 = store.buildSnapshot({
        probes: [{ ok: true, latencyMs: 120 }],
        consecutiveFailures: 0,
        ls: { running: true, healthz: { reachable: true } },
        simulation: { active: false },
        config: { stallThresholdSec: 25, lang: "en" },
        requestedConvId: convErr,
      });
      const errEvents2 = snap2.events.filter((e) => e.i18n?.key === "API_ERROR_STEP");
      assert.equal(errEvents2.length, 2);
      assert.match(errEvents2[0].title, /Attempt #3/);
      assert.equal(snap2.verdict.severity, "danger");

      const snapOther = store.buildSnapshot({
        probes: [{ ok: true, latencyMs: 120 }],
        consecutiveFailures: 0,
        ls: { running: true, healthz: { reachable: true } },
        simulation: { active: false },
        config: { stallThresholdSec: 25, lang: "zh" },
        requestedConvId: convOther,
      });
      assert.equal(snapOther.events.some((e) => e.i18n?.key === "API_ERROR_STEP"), false);

      // stale-idle 过期后自动清理 latestError
      const oldTime = new Date(Date.now() - 12 * 60 * 1000);
      utimesSync(transcriptPath, oldTime, oldTime);
      store.resolveActiveConversation(convErr).transcript.latestStepAt = oldTime.getTime();
      store.resolveActiveConversation(convErr).transcript.mtimeMs = oldTime.getTime();
      assert.equal(store.scanTranscript(convErr, false), true);
      assert.equal(store.resolveActiveConversation(convErr).transcript.inferredPhase, "idle");
      assert.equal(store.resolveActiveConversation(convErr).transcript.latestError, null);

      // 恢复后收到终态 PLANNER_RESPONSE，清空 latestError 并回归 IDLE
      appendFileSync(
        transcriptPath,
        JSON.stringify({
          step_index: 213,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          content: "ok",
          created_at: new Date().toISOString(),
        }) + "\n",
        "utf8",
      );
      assert.equal(store.scanTranscript(convErr, true), true);
      const snapRecovered = store.buildSnapshot({
        probes: [{ ok: true, latencyMs: 120 }],
        consecutiveFailures: 0,
        ls: { running: true, healthz: { reachable: true } },
        simulation: { active: false },
        config: { stallThresholdSec: 25, lang: "zh" },
        requestedConvId: convErr,
      });
      assert.equal(snapRecovered.transcript.latestError, null);
      assert.equal(snapRecovered.verdict.code, "IDLE");
    });
  });

  it("Stop(fullyIdle: false) 切入 background_task 并隔离事件流、ERROR_MESSAGE 3 分钟过期、2 分钟时钟窗防旧日志激活", async () => {
    await withTempDir(async (dir) => {
      const brainDir = join(dir, "brain");
      const store = createStateStore({
        brainDirs: [brainDir],
        fallbackHookPath: join(dir, "hook-state.json"),
      });

      // 1. Stop(fullyIdle: false) -> background_task + HOOK_STOP_BACKGROUND；USER_CANCELED 则仍回 idle
      const now = Date.now();
      store.applyHookEvent({
        eventName: "PreInvocation",
        receivedAt: now - 3000,
        payload: { conversationId: "conv-bg-1", invocationNum: 1 },
      });
      assert.equal(store.resolveActiveConversation("conv-bg-1").hook.fullyIdle, null);

      store.applyHookEvent({
        eventName: "Stop",
        receivedAt: now,
        payload: { conversationId: "conv-bg-1", terminationReason: "NO_TOOL_CALL", fullyIdle: false },
      });
      const snapBg = store.buildSnapshot({
        probes: [{ ok: true, latencyMs: 80 }],
        consecutiveFailures: 0,
        ls: { running: true, healthz: { reachable: true } },
        simulation: { active: false },
        config: { stallThresholdSec: 25, lang: "zh" },
        requestedConvId: "conv-bg-1",
      });
      assert.equal(snapBg.hook.phase, "background_task");
      assert.equal(snapBg.hook.fullyIdle, false);
      assert.equal(snapBg.verdict.code, "BACKGROUND_TASK");
      assert.ok(snapBg.events.some((e) => e.i18n?.key === "HOOK_STOP_BACKGROUND"));

      store.applyHookEvent({
        eventName: "Stop",
        receivedAt: now + 1000,
        payload: { conversationId: "conv-bg-cancel", terminationReason: "USER_CANCELED", fullyIdle: false },
      });
      assert.equal(store.resolveActiveConversation("conv-bg-cancel").hook.phase, "idle");

      // 2. ERROR_MESSAGE 超过 3 分钟即触发 stale-idle（无需等 10 分钟），新文件若 created_at > 3m 也不残留 latestError
      const errConv = "conv-err-3m";
      const errPath = join(brainDir, errConv, ".system_generated/logs/transcript.jsonl");
      const age3m20 = new Date(Date.now() - 200_000);
      writeJsonl(errPath, [
        { step_index: 5, type: "ERROR_MESSAGE", error: 'API error (attempt 1): Post "https://example.invalid": EOF', created_at: age3m20.toISOString() },
      ]);
      utimesSync(errPath, age3m20, age3m20);
      store.scanTranscript(errConv, false);
      assert.equal(store.resolveActiveConversation(errConv).transcript.inferredPhase, "idle");
      assert.equal(store.resolveActiveConversation(errConv).transcript.latestError, null);

      // 3. 2 小时前旧 USER_INPUT 即使 mtime 被外部程序刷新也不误激活为 waiting_llm
      const oldConv = "conv-touched-mtime";
      const oldPath = join(brainDir, oldConv, ".system_generated/logs/transcript.jsonl");
      writeJsonl(oldPath, [
        { step_index: 1, type: "USER_INPUT", content: "old", created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
      ]);
      store.scanTranscript(oldConv, false);
      assert.equal(store.resolveActiveConversation(oldConv).transcript.inferredPhase, "idle");
    });
  });
});
