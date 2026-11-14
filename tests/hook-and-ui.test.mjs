import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createSdkBridge } from "../sidecars/status-monitor/lib/sdk-bridge.mjs";
import { PLUGIN_ROOT, withTempDir } from "./helpers.mjs";

function runHookReporter({ pluginRoot, eventName, stdinPayload }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(PLUGIN_ROOT, "hooks/hook-reporter.mjs"), eventName],
      {
        env: { ...process.env, PLUGIN_ROOT: pluginRoot },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (stdinPayload !== undefined) {
      child.stdin.write(JSON.stringify(stdinPayload));
    }
    child.stdin.end();
  });
}

describe("hooks/hook-reporter.mjs（事件上报与降级写入）", () => {
  it("Sidecar 存活时携带 X-Hook-Token 上报事件并输出 {}", async () => {
    await withTempDir(async (dir) => {
      let received = null;
      const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          received = {
            url: req.url,
            hookToken: req.headers["x-hook-token"],
            contentType: req.headers["content-type"],
            body: JSON.parse(body),
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
        });
      });

      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address();
      mkdirSync(join(dir, ".runtime"), { recursive: true });
      const fallbackFile = join(dir, ".runtime", "hook-state.json");
      writeFileSync(fallbackFile, JSON.stringify({ eventName: "PreInvocation", receivedAt: 1000 }));
      writeFileSync(
        join(dir, ".runtime", "server.json"),
        JSON.stringify({ port, hookToken: "test-hook-token-123" }),
      );

      const res = await runHookReporter({
        pluginRoot: dir,
        eventName: "PreInvocation",
        stdinPayload: {
          conversationId: "conv-e2e-1",
          invocationNum: 3,
          modelName: "test-model",
          transcriptPath: "C:/tmp/t.jsonl",
        },
      });
      server.close();

      assert.equal(res.code, 0, res.stderr);
      assert.equal(res.stdout, "{}\n");
      assert.equal(received.url, "/api/hook");
      assert.equal(received.hookToken, "test-hook-token-123");
      assert.equal(received.contentType, "application/json");
      assert.equal(received.body.eventName, "PreInvocation");
      assert.equal(received.body.payload.conversationId, "conv-e2e-1");
      assert.equal(received.body.payload.invocationNum, 3);
      assert.equal(existsSync(fallbackFile), false);
    });
  });

  it("Sidecar 不可达时静默降级写入 .runtime/hook-state.json", async () => {
    await withTempDir(async (dir) => {
      const res = await runHookReporter({
        pluginRoot: dir,
        eventName: "Stop",
        stdinPayload: {
          conversationId: "conv-fallback",
          terminationReason: "DONE",
        },
      });

      assert.equal(res.code, 0, res.stderr);
      assert.equal(res.stdout, "{}\n");

      const fallbackFile = join(dir, ".runtime", "hook-state.json");
      assert.equal(existsSync(fallbackFile), true);
      const saved = JSON.parse(readFileSync(fallbackFile, "utf8"));
      assert.equal(saved.eventName, "Stop");
      assert.equal(saved.payload.conversationId, "conv-fallback");
      assert.equal(saved.payload.terminationReason, "DONE");
    });
  });
});

describe("前端 DOM ID 一致性与 SDK 桥接降级行为", () => {
  it("app.js 引用的全部 DOM ID 均存在于 index.html", () => {
    const html = readFileSync(
      join(PLUGIN_ROOT, "sidecars/status-monitor/public/index.html"),
      "utf8",
    );
    const appJs = readFileSync(
      join(PLUGIN_ROOT, "sidecars/status-monitor/public/app.js"),
      "utf8",
    );
    const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const jsIds = [...new Set([...appJs.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]))];
    const missing = jsIds.filter((id) => !htmlIds.has(id));
    assert.deepEqual(missing, []);
    assert.ok(jsIds.length >= 22);
    assert.match(html, /id="btnSettings"[^>]*>[\s\S]*?<svg[\s\S]*?<\/svg>/);
    assert.match(html, /--mon-accent/);
    assert.match(html, /--mon-ok/);
    assert.match(html, /--mon-tool/);
    assert.doesNotMatch(html, /var\(--(accent|ok|tool)\)/);
    assert.ok(htmlIds.has("btnLangZh") && htmlIds.has("btnLangEn"));
    assert.match(appJs, /netRetry/);
    assert.match(appJs, /modePacUnsupported/);
    assert.match(appJs, /updateConnectionDot/);
    assert.match(appJs, /detectBrowserLang/);
    assert.match(appJs, /navigator\.language/);

    const stylesCss = readFileSync(
      join(PLUGIN_ROOT, "sidecars/status-monitor/public/styles.css"),
      "utf8",
    );
    assert.match(stylesCss, /\.setting-row\s+select[\s\S]*?max-width:\s*58%/);
    assert.match(stylesCss, /\.setting-row\s+select[\s\S]*?min-width:\s*0/);

    const pluginJson = JSON.parse(readFileSync(join(PLUGIN_ROOT, "plugin.json"), "utf8"));
    const sidecarJson = JSON.parse(readFileSync(join(PLUGIN_ROOT, "sidecars/status-monitor/sidecar.json"), "utf8"));
    assert.doesNotMatch(pluginJson.displayName, /[\u4e00-\u9fff]/);
    assert.doesNotMatch(pluginJson.description, /VPN|[\u4e00-\u9fff]/i);
    assert.doesNotMatch(sidecarJson.display_name, /[\u4e00-\u9fff]/);
    assert.doesNotMatch(sidecarJson.description, /VPN|[\u4e00-\u9fff]/i);
  });

  function runCommand(bin, args, cwd) {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  if (process.platform !== "win32") {
    it("Unix uninstall.sh 支持 -h/--help 并拒绝未知参数", async () => {
      const helpRes = await runCommand("sh", [join(PLUGIN_ROOT, "uninstall.sh"), "-h"]);
      assert.equal(helpRes.code, 0);
      assert.match(helpRes.stdout, /Usage:/);
      const badRes = await runCommand("sh", [join(PLUGIN_ROOT, "uninstall.sh"), "--unknown-flag"]);
      assert.notEqual(badRes.code, 0);
      assert.match(badRes.stderr, /Unknown option/);
    });
  }

  it("卸载脚本可识别相对路径启动的 server.mjs 进程并无锁删除目录", async () => {
    await withTempDir(async (sandbox) => {
      const isWin = process.platform === "win32";
      const installRes = isWin
        ? await runCommand(
            "powershell",
            ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(PLUGIN_ROOT, "install.ps1"), "-PluginsRoot", sandbox],
            PLUGIN_ROOT,
          )
        : await runCommand("sh", [join(PLUGIN_ROOT, "install.sh"), sandbox], PLUGIN_ROOT);
      assert.equal(installRes.code, 0, installRes.stderr || installRes.stdout);

      const destDir = join(sandbox, "agent-status-monitor");
      const sidecarDir = join(destDir, "sidecars", "status-monitor");
      const srvPath = join(destDir, ".runtime", "server.json");

      const childEnv = { ...process.env, ANTIGRAVITY_SIDECAR_WEB_PORT: "0", ANTIGRAVITY_LS_ADDRESS: "" };
      delete childEnv.ASM_RUNTIME_DIR;
      const sidecarProc = spawn(process.execPath, ["server.mjs"], {
        cwd: sidecarDir,
        env: childEnv,
        stdio: ["ignore", "ignore", "pipe"],
      });

      try {
        const deadline = Date.now() + 8000;
        while (!existsSync(srvPath) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 80));
        }
        assert.ok(existsSync(srvPath), "测试 Sidecar 未写出 .runtime/server.json");

        // 从外部目录启动，避免复制后从源目录读 uninstall 脚本导致与真实用户路径不一致
        const uninstArgs = isWin
          ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(PLUGIN_ROOT, "uninstall.ps1"), "-PluginsRoot", sandbox]
          : [join(PLUGIN_ROOT, "uninstall.sh"), sandbox];
        const uninstRes = await runCommand(isWin ? "powershell" : "sh", uninstArgs, sandbox);

        assert.equal(uninstRes.code, 0, uninstRes.stderr || uninstRes.stdout);
        assert.match(uninstRes.stdout, /Stopping running Sidecar process/);
        assert.equal(existsSync(destDir), false);
      } finally {
        try {
          sidecarProc.kill("SIGKILL");
        } catch {
        }
      }
    });
  });

  it("兼容 antigravity-status-monitor 目录名的胶囊提示与卸载清理", async () => {
    const skillMd = readFileSync(join(PLUGIN_ROOT, "skills", "status-monitor", "SKILL.md"), "utf8");
    assert.ok(skillMd.includes("sidecar://agent-status-monitor/status-monitor/"));
    assert.ok(skillMd.includes("sidecar://antigravity-status-monitor/status-monitor/"));

    await withTempDir(async (sandbox) => {
      const aliasDir = join(sandbox, "antigravity-status-monitor");
      mkdirSync(join(aliasDir, ".runtime"), { recursive: true });
      writeFileSync(join(aliasDir, ".runtime", "config.json"), '{"lang":"en"}', "utf8");

      const isWin = process.platform === "win32";
      const uninstArgs = isWin
        ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(PLUGIN_ROOT, "uninstall.ps1"), "-PluginsRoot", sandbox]
        : [join(PLUGIN_ROOT, "uninstall.sh"), sandbox];
      const res = await runCommand(isWin ? "powershell" : "sh", uninstArgs, sandbox);
      assert.equal(res.code, 0, res.stderr || res.stdout);
      assert.equal(existsSync(aliasDir), false);
    });
  });

  it("sdk-bridge 离线调用 /_sidecar/* 时安全降级并按环境返回或置空 preload 脚本", async () => {
    await withTempDir(async (emptyDir) => {
      const noSdkBridge = await createSdkBridge({ appDataDir: emptyDir, skipPackageImport: true });
      assert.equal(noSdkBridge.isSdkReady(), false);
      assert.equal(noSdkBridge.getPreloadJs(), null);
      const res = await noSdkBridge.handleSidecarRoute("/_sidecar/get-conversation-metadata", {});
      assert.equal(res.status, 503);
    });

    await withTempDir(async (fakeAppDir) => {
      const sdkDir = join(fakeAppDir, "lib", "node_modules", "sidecar_sdk");
      mkdirSync(sdkDir, { recursive: true });
      writeFileSync(join(sdkDir, "preload.js"), "window.__TEST_PRELOAD__ = true;", "utf8");
      const preloadBridge = await createSdkBridge({ appDataDir: fakeAppDir, skipPackageImport: true });
      assert.equal(preloadBridge.isSdkReady(), false);
      assert.equal(preloadBridge.getPreloadJs(), "window.__TEST_PRELOAD__ = true;");
      const res = await preloadBridge.handleSidecarRoute("/_sidecar/send-message", {});
      assert.equal(res.status, 503);
    });

    const defaultBridge = await createSdkBridge();
    const preloadJs = defaultBridge.getPreloadJs();
    assert.ok(preloadJs === null || (typeof preloadJs === "string" && preloadJs.length > 0));
    if (!defaultBridge.isSdkReady()) {
      const res = await defaultBridge.handleSidecarRoute("/_sidecar/get-conversation-metadata", {});
      assert.equal(res.status, 503);
    }
  });
});
