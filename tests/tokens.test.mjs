import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  collectTokenStats,
  parseTranscriptTokens,
} from "../sidecars/status-monitor/lib/tokens.mjs";
import { localNoonIso, withTempDir, writeJsonl } from "./helpers.mjs";

describe("parseTranscriptTokens（单会话 Token 解析与缓存）", () => {
  it("文件不存在时返回 null", () => {
    assert.equal(parseTranscriptTokens("Z:/non-existent-path/transcript.jsonl"), null);
  });

  it("准确聚合 PLANNER_RESPONSE、忽略非模型行与损坏 JSON 行", async () => {
    await withTempDir(async (dir) => {
      const { iso } = localNoonIso();
      const filePath = join(dir, "conv-1/.system_generated/logs/transcript.jsonl");
      writeJsonl(filePath, [
        { step_index: 0, type: "USER_INPUT", content: "hi", created_at: iso },
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          input_tokens: 1000,
          cache_read_tokens: 3000,
          output_tokens: 250,
          created_at: iso,
        },
        {
          step_index: 2,
          type: "PLANNER_RESPONSE",
          input_tokens: 500,
          cache_read_tokens: 4500,
          output_tokens: 150,
          created_at: iso,
        },
      ]);
      appendFileSync(filePath, "{broken PLANNER_RESPONSE json\n", "utf8");

      const parsed = parseTranscriptTokens(filePath);
      assert.ok(parsed);
      assert.equal(parsed.session.calls, 2);
      assert.equal(parsed.session.input, 1500);
      assert.equal(parsed.session.cacheRead, 7500);
      assert.equal(parsed.session.output, 400);
      assert.equal(parsed.session.total, 9400);
      assert.equal(parsed.session.cacheHitRate, 83.3);

      assert.deepEqual(parsed.lastCall, {
        stepIndex: 2,
        input: 500,
        cacheRead: 4500,
        output: 150,
        contextTotal: 5000,
      });
    });
  });

  it("input 与 cacheRead 均为 0 时 cacheHitRate 返回 null（避免除以 0）", async () => {
    await withTempDir(async (dir) => {
      const { iso } = localNoonIso();
      const filePath = join(dir, "transcript.jsonl");
      writeJsonl(filePath, [
        {
          step_index: 0,
          type: "PLANNER_RESPONSE",
          input_tokens: 0,
          cache_read_tokens: 0,
          output_tokens: 10,
          created_at: iso,
        },
      ]);
      const parsed = parseTranscriptTokens(filePath);
      assert.equal(parsed.session.cacheHitRate, null);
    });
  });

  it("文件追加新记录后自动失效缓存并更新统计", async () => {
    await withTempDir(async (dir) => {
      const { iso } = localNoonIso();
      const filePath = join(dir, "transcript.jsonl");
      writeJsonl(filePath, [
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          input_tokens: 100,
          cache_read_tokens: 200,
          output_tokens: 50,
          created_at: iso,
        },
      ]);

      const first = parseTranscriptTokens(filePath);
      assert.equal(first.session.calls, 1);
      assert.equal(first.session.total, 350);

      assert.equal(parseTranscriptTokens(filePath), first);

      appendFileSync(
        filePath,
        JSON.stringify({
          step_index: 2,
          type: "PLANNER_RESPONSE",
          input_tokens: 300,
          cache_read_tokens: 600,
          output_tokens: 100,
          created_at: iso,
        }) + "\n",
        "utf8",
      );

      const second = parseTranscriptTokens(filePath);
      assert.notEqual(second, first);
      assert.equal(second.session.calls, 2);
      assert.equal(second.session.total, 1350);
      assert.equal(second.lastCall.stepIndex, 2);
    });
  });
});

describe("collectTokenStats（跨目录、跨日期与当前会话聚合）", () => {
  it("区分当前会话、今日全部会话与历史总计，并去重重复 brainDir", async () => {
    await withTempDir(async (dir) => {
      const nowRef = localNoonIso();
      const yesterday = new Date(nowRef.ts - 24 * 60 * 60 * 1000);
      const oldIso = localNoonIso(yesterday).iso;

      const brainDir = join(dir, "brain");
      const convActive = join(brainDir, "conv-a/.system_generated/logs/transcript.jsonl");
      const convMixed = join(brainDir, "conv-b/.system_generated/logs/transcript.jsonl");

      writeJsonl(convActive, [
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          input_tokens: 200,
          cache_read_tokens: 800,
          output_tokens: 100,
          created_at: nowRef.iso,
        },
      ]);

      writeJsonl(convMixed, [
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          input_tokens: 1000,
          cache_read_tokens: 0,
          output_tokens: 200,
          created_at: oldIso,
        },
        {
          step_index: 2,
          type: "PLANNER_RESPONSE",
          input_tokens: 300,
          cache_read_tokens: 700,
          output_tokens: 50,
          created_at: nowRef.iso,
        },
      ]);

      const stats = collectTokenStats([brainDir, brainDir], convActive, nowRef.ts);

      assert.equal(stats.session.calls, 1);
      assert.equal(stats.session.total, 1100);
      assert.equal(stats.lastCall.contextTotal, 1000);

      assert.equal(stats.today.sessions, 2);
      assert.equal(stats.today.calls, 2);
      assert.equal(stats.today.input, 500);
      assert.equal(stats.today.cacheRead, 1500);
      assert.equal(stats.today.output, 150);
      assert.equal(stats.today.total, 2150);
      assert.equal(stats.today.cacheHitRate, 75);

      assert.equal(stats.allTime.sessions, 2);
      assert.equal(stats.allTime.calls, 3);
      assert.equal(stats.allTime.total, 3350);
    });
  });

  it("大文件分块读取不截断多字节 UTF-8、追加增量解析且重写后自动重置", async () => {
    await withTempDir(async (dir) => {
      const { iso } = localNoonIso();
      const filePath = join(dir, "large-transcript.jsonl");
      const pad = "中文多字节填充内容".repeat(4000);
      writeJsonl(filePath, [
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          content: pad,
          input_tokens: 100,
          cache_read_tokens: 900,
          output_tokens: 50,
          created_at: iso,
        },
        {
          step_index: 2,
          type: "PLANNER_RESPONSE",
          content: pad,
          input_tokens: 200,
          cache_read_tokens: 800,
          output_tokens: 60,
          created_at: iso,
        },
        {
          step_index: 3,
          type: "PLANNER_RESPONSE",
          content: pad,
          input_tokens: 300,
          cache_read_tokens: 700,
          output_tokens: 70,
          created_at: iso,
        },
      ]);

      const largeFirst = parseTranscriptTokens(filePath);
      assert.equal(largeFirst.session.calls, 3);
      assert.equal(largeFirst.session.total, 3180);

      appendFileSync(
        filePath,
        JSON.stringify({
          step_index: 4,
          type: "PLANNER_RESPONSE",
          input_tokens: 400,
          cache_read_tokens: 600,
          output_tokens: 20,
          created_at: iso,
        }) + "\n",
        "utf8",
      );
      const incremented = parseTranscriptTokens(filePath);
      assert.equal(incremented.session.calls, 4);
      assert.equal(incremented.session.total, 4200);
      assert.equal(incremented.lastCall.stepIndex, 4);

      writeFileSync(
        filePath,
        JSON.stringify({
          step_index: 1,
          type: "PLANNER_RESPONSE",
          input_tokens: 10,
          cache_read_tokens: 20,
          output_tokens: 5,
          created_at: iso,
        }) + "\n",
        "utf8",
      );
      const resetParsed = parseTranscriptTokens(filePath);
      assert.equal(resetParsed.session.calls, 1);
      assert.equal(resetParsed.session.total, 35);
    });
  });

  it("collectTokenStats 在活跃会话指向 transcript_full.jsonl 时对齐全局口径", async () => {
    await withTempDir(async (dir) => {
      const nowRef = localNoonIso();
      const brainDir = join(dir, "brain");
      const shortPath = join(brainDir, "conv-x/.system_generated/logs/transcript.jsonl");
      const fullPath = join(brainDir, "conv-x/.system_generated/logs/transcript_full.jsonl");
      writeJsonl(shortPath, [
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          input_tokens: 100,
          cache_read_tokens: 0,
          output_tokens: 10,
          created_at: nowRef.iso,
        },
      ]);
      writeJsonl(fullPath, [
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          input_tokens: 100,
          cache_read_tokens: 0,
          output_tokens: 10,
          created_at: nowRef.iso,
        },
        {
          step_index: 2,
          type: "PLANNER_RESPONSE",
          input_tokens: 200,
          cache_read_tokens: 0,
          output_tokens: 20,
          created_at: nowRef.iso,
        },
      ]);

      const stats = collectTokenStats([brainDir], fullPath, nowRef.ts, { cacheTtlMs: 0 });
      assert.equal(stats.session.total, 330);
      assert.equal(stats.today.total, 330);
      assert.equal(stats.allTime.total, 330);
    });
  });

  it("原地重写成更大文件时通过指纹校验触发全量重算，且 cacheTtl 内 today 始终 >= session", async () => {
    await withTempDir(async (dir) => {
      const nowRef = localNoonIso();
      const brainDir = join(dir, "brain");
      const activePath = join(brainDir, "conv-rw/.system_generated/logs/transcript.jsonl");
      const otherPath = join(brainDir, "conv-other/.system_generated/logs/transcript.jsonl");

      writeJsonl(otherPath, [
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          input_tokens: 100,
          cache_read_tokens: 0,
          output_tokens: 10,
          created_at: nowRef.iso,
        },
      ]);
      writeJsonl(activePath, [
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          input_tokens: 200,
          cache_read_tokens: 0,
          output_tokens: 20,
          created_at: nowRef.iso,
        },
      ]);

      const first = collectTokenStats([brainDir], activePath, nowRef.ts, { cacheTtlMs: 4000 });
      assert.equal(first.session.total, 220);
      assert.equal(first.today.total, 330);

      writeJsonl(activePath, [
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          content: "replaced-with-larger-content-".repeat(20),
          input_tokens: 500,
          cache_read_tokens: 0,
          output_tokens: 50,
          created_at: nowRef.iso,
        },
        {
          step_index: 2,
          type: "PLANNER_RESPONSE",
          input_tokens: 100,
          cache_read_tokens: 0,
          output_tokens: 10,
          created_at: nowRef.iso,
        },
      ]);

      const updated = collectTokenStats([brainDir], activePath, nowRef.ts, { cacheTtlMs: 4000 });
      assert.equal(updated.session.calls, 2);
      assert.equal(updated.session.total, 660);
      assert.ok(updated.today.total >= updated.session.total);
      assert.equal(updated.today.total, 770);
    });
  });
});
