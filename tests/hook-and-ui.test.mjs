import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createContext, runInContext } from "node:vm";
import { packageRelease } from "../scripts/package-release.mjs";
import { createSdkBridge } from "../sidecars/status-monitor/lib/sdk-bridge.mjs";
import { createStatusServer } from "../sidecars/status-monitor/server.mjs";
import { PLUGIN_ROOT, withTempDir } from "./helpers.mjs";

function runHookReporter({ pluginRoot, eventName, stdinPayload, env = {} }) {
  return new Promise((resolve, reject) => {
    const childEnv = {
      ...process.env,
      PLUGIN_ROOT: pluginRoot,
      ANTIGRAVITY_CONVERSATION_ID: "",
      ANTIGRAVITY_LS_ADDRESS: "",
      ...env,
    };
    const child = spawn(
      process.execPath,
      [join(PLUGIN_ROOT, "hooks/hook-reporter.mjs"), eventName],
      {
        env: childEnv,
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

  it("Sidecar 不可达时按作用域静默降级写入 .runtime/hooks/<scope>.json", async () => {
    await withTempDir(async (dir) => {
      const res = await runHookReporter({
        pluginRoot: dir,
        eventName: "Stop",
        stdinPayload: {
          conversationId: "conv-fallback",
          terminationReason: "DONE",
        },
        env: { ASM_RUNTIME_DIR: join(dir, ".runtime"), ANTIGRAVITY_LS_ADDRESS: "" },
      });

      assert.equal(res.code, 0, res.stderr);
      assert.equal(res.stdout, "{}\n");

      const fallbackFile = join(dir, ".runtime", "hooks", "conv-conv-fallback.json");
      assert.equal(existsSync(fallbackFile), true);
      assert.equal(existsSync(join(dir, ".runtime", "hook-state.json")), false);
      const saved = JSON.parse(readFileSync(fallbackFile, "utf8"));
      assert.equal(saved.eventName, "Stop");
      assert.equal(saved.payload.conversationId, "conv-fallback");
      assert.equal(saved.payload.terminationReason, "DONE");
    });
  });

  it("多窗口 .runtime/servers 精准路由 Hook 且不误删其他窗口的离线状态文件", async () => {
    await withTempDir(async (dir) => {
      const received1 = [];
      const received2 = [];
      const mkMockServer = (bucket) =>
        http.createServer((req, res) => {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => {
            bucket.push({ token: req.headers["x-hook-token"], body: JSON.parse(body) });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end('{"ok":true}');
          });
        });

      const srv1 = mkMockServer(received1);
      const srv2 = mkMockServer(received2);
      await new Promise((r) => srv1.listen(0, "127.0.0.1", r));
      await new Promise((r) => srv2.listen(0, "127.0.0.1", r));
      const port1 = srv1.address().port;
      const port2 = srv2.address().port;

      const rtDir = join(dir, ".runtime");
      const serversDir = join(rtDir, "servers");
      const hooksDir = join(rtDir, "hooks");
      mkdirSync(serversDir, { recursive: true });
      mkdirSync(hooksDir, { recursive: true });

      writeFileSync(
        join(serversDir, `sidecar-${process.pid}-${port1}.json`),
        JSON.stringify({ port: port1, pid: process.pid, startedAt: 1000, hookToken: "tok-1", lsAddress: "127.0.0.1:10001" }),
      );
      writeFileSync(
        join(serversDir, `sidecar-${process.pid}-${port2}.json`),
        JSON.stringify({ port: port2, pid: process.pid, startedAt: 2000, hookToken: "tok-2", lsAddress: "127.0.0.1:10002" }),
      );
      // 模拟 legacy server.json 已被窗口 2 覆盖
      writeFileSync(
        join(rtDir, "server.json"),
        JSON.stringify({ port: port2, pid: process.pid, startedAt: 2000, hookToken: "tok-2", lsAddress: "127.0.0.1:10002" }),
      );

      const win1HookFile = join(hooksDir, "conv-conv-win1.json");
      const win2HookFile = join(hooksDir, "conv-conv-win2.json");
      writeFileSync(
        win1HookFile,
        JSON.stringify({ eventName: "PreInvocation", receivedAt: 900, lsAddress: "127.0.0.1:10001", payload: { conversationId: "conv-win1" } }),
      );
      writeFileSync(
        win2HookFile,
        JSON.stringify({ eventName: "PreInvocation", receivedAt: 950, lsAddress: "127.0.0.1:10002", payload: { conversationId: "conv-win2" } }),
      );

      try {
        const res1 = await runHookReporter({
          pluginRoot: dir,
          eventName: "PreInvocation",
          stdinPayload: { conversationId: "conv-win1", invocationNum: 1 },
          env: { ASM_RUNTIME_DIR: rtDir, ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:10001" },
        });
        assert.equal(res1.code, 0, res1.stderr);
        assert.equal(received1.length, 1);
        assert.equal(received1[0].token, "tok-1");
        assert.equal(received1[0].body.lsAddress, "127.0.0.1:10001");
        assert.equal(received2.length, 0);
        assert.equal(existsSync(win1HookFile), false);
        assert.equal(existsSync(win2HookFile), true);
      } finally {
        srv1.close();
        srv2.close();
      }

      // 两窗口均离线且仅有 lsAddress 时各自写独立文件互不覆盖
      const off1 = await runHookReporter({
        pluginRoot: dir,
        eventName: "PreInvocation",
        stdinPayload: {},
        env: { ASM_RUNTIME_DIR: rtDir, ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:30001" },
      });
      const off2 = await runHookReporter({
        pluginRoot: dir,
        eventName: "Stop",
        stdinPayload: { terminationReason: "DONE" },
        env: { ASM_RUNTIME_DIR: rtDir, ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:30002" },
      });
      assert.equal(off1.code, 0);
      assert.equal(off2.code, 0);
      assert.equal(existsSync(join(hooksDir, "ls-127.0.0.1_30001.json")), true);
      assert.equal(existsSync(join(hooksDir, "ls-127.0.0.1_30002.json")), true);
    });
  });
});

describe("前端 DOM ID 一致性与 SDK 桥接降级行为", () => {
  it("前端模块化脚本引用的全部 DOM ID 均存在于 index.html", () => {
    const publicDir = join(PLUGIN_ROOT, "sidecars/status-monitor/public");
    const html = readFileSync(join(publicDir, "index.html"), "utf8");
    const scriptMatches = [...html.matchAll(/<script\s+src="\/([^"]+)"\s+defer><\/script>/g)].map(
      (m) => m[1],
    );
    assert.deepEqual(scriptMatches, [
      "js/i18n.js",
      "js/format.js",
      "js/render.js",
      "js/client.js",
      "app.js",
    ]);

    const frontendCode = scriptMatches
      .map((rel) => readFileSync(join(publicDir, rel), "utf8"))
      .join("\n");
    const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const jsIds = [...new Set([...frontendCode.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]))];
    const missing = jsIds.filter((id) => !htmlIds.has(id));
    assert.deepEqual(missing, []);
    assert.ok(jsIds.length >= 22);
    assert.match(html, /id="btnSettings"[^>]*>[\s\S]*?<svg[\s\S]*?<\/svg>/);
    assert.doesNotMatch(html, /\bstyle\s*=|<style\b/i);
    assert.doesNotMatch(html, /var\(--(accent|ok|tool)\)/);
    assert.ok(htmlIds.has("btnLangZh") && htmlIds.has("btnLangEn"));
    assert.ok(htmlIds.has("actionBanner") && htmlIds.has("convBadge"));
    assert.equal(htmlIds.has("convSelect"), false);
    assert.match(frontendCode, /netRetry/);
    assert.match(frontendCode, /modePacUnsupported/);
    assert.match(frontendCode, /updateConnectionDot/);
    assert.match(frontendCode, /detectBrowserLang/);
    assert.match(frontendCode, /navigator\.language/);
    assert.doesNotMatch(frontendCode, /\bEventSource\b/);
    assert.match(frontendCode, /visibilityState/);
    assert.match(frontendCode, /AbortController/);
    assert.match(frontendCode, /X-Sidecar-Token/);
    assert.doesNotMatch(frontendCode, /\.cssText\s*=/);

    const stylesCss = readFileSync(
      join(PLUGIN_ROOT, "sidecars/status-monitor/public/styles.css"),
      "utf8",
    );
    assert.match(stylesCss, /--mon-accent/);
    assert.match(stylesCss, /--mon-ok/);
    assert.match(stylesCss, /--mon-tool/);
    assert.match(stylesCss, /\.theme-probe\s*\{/);
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
      const serversDir = join(destDir, ".runtime", "servers");

      const spawnSidecar = (lsAddr) => {
        const childEnv = {
          ...process.env,
          ANTIGRAVITY_SIDECAR_WEB_PORT: "0",
          ANTIGRAVITY_LS_ADDRESS: lsAddr,
          ANTIGRAVITY_CONVERSATION_ID: "",
        };
        delete childEnv.ASM_RUNTIME_DIR;
        return spawn(process.execPath, ["server.mjs"], {
          cwd: sidecarDir,
          env: childEnv,
          stdio: ["ignore", "ignore", "pipe"],
        });
      };

      const sidecarProc1 = spawnSidecar("127.0.0.1:45111");
      const sidecarProc2 = spawnSidecar("127.0.0.1:45222");

      try {
        const deadline = Date.now() + 8000;
        while (
          (!existsSync(srvPath) ||
            !existsSync(serversDir) ||
            readdirSync(serversDir).filter((f) => f.endsWith(".json")).length < 2) &&
          Date.now() < deadline
        ) {
          await new Promise((r) => setTimeout(r, 80));
        }
        assert.ok(existsSync(srvPath), "测试 Sidecar 未写出 .runtime/server.json");
        assert.equal(
          readdirSync(serversDir).filter((f) => f.endsWith(".json")).length,
          2,
          "测试多窗口 Sidecar 未写出两份 .runtime/servers/*.json",
        );

        // 从外部目录启动，避免复制后从源目录读 uninstall 脚本导致与真实用户路径不一致
        const uninstArgs = isWin
          ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(PLUGIN_ROOT, "uninstall.ps1"), "-PluginsRoot", sandbox]
          : [join(PLUGIN_ROOT, "uninstall.sh"), sandbox];
        const uninstRes = await runCommand(isWin ? "powershell" : "sh", uninstArgs, sandbox);

        assert.equal(uninstRes.code, 0, uninstRes.stderr || uninstRes.stdout);
        const stopMatches = uninstRes.stdout.match(/Stopping running Sidecar process/g) || [];
        assert.ok(stopMatches.length >= 2, `Expected >=2 sidecars stopped, stdout: ${uninstRes.stdout}`);
        assert.equal(existsSync(destDir), false);
      } finally {
        for (const p of [sidecarProc1, sidecarProc2]) {
          try {
            p.kill("SIGKILL");
          } catch {
          }
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

  it("package-release 可构建可解压安装的 .zip/.tar.gz 与 SHA256SUMS.txt", async () => {
    await withTempDir(async (sandbox) => {
      const outDir = join(sandbox, "dist");
      const res = packageRelease({ repoRoot: PLUGIN_ROOT, outDir, tag: "v1.0.1-test" });

      assert.equal(res.pluginId, "agent-status-monitor");
      assert.ok(existsSync(join(outDir, "agent-status-monitor-v1.0.1-test.zip")));
      assert.ok(existsSync(join(outDir, "agent-status-monitor-v1.0.1-test.tar.gz")));
      assert.ok(existsSync(join(outDir, "agent-status-monitor.zip")));
      assert.ok(existsSync(join(outDir, "agent-status-monitor.tar.gz")));

      const sums = readFileSync(join(outDir, "SHA256SUMS.txt"), "utf8").trim().split("\n");
      assert.equal(sums.length, 4);
      for (const line of sums) {
        const [expectedHash, fileName] = line.trim().split(/\s+/);
        const actualHash = createHash("sha256").update(readFileSync(join(outDir, fileName))).digest("hex");
        assert.equal(actualHash, expectedHash);
      }

      const tarExtract = join(sandbox, "tar-out");
      mkdirSync(tarExtract, { recursive: true });
      const tarRes = await runCommand("tar", ["-xzf", join(outDir, "agent-status-monitor.tar.gz"), "-C", tarExtract]);
      assert.equal(tarRes.code, 0, tarRes.stderr);
      assert.equal(existsSync(join(tarExtract, "agent-status-monitor", "plugin.json")), true);
      assert.equal(existsSync(join(tarExtract, "agent-status-monitor", "install.sh")), true);
      assert.equal(existsSync(join(tarExtract, "agent-status-monitor", "install.ps1")), true);
      assert.equal(
        existsSync(join(tarExtract, "agent-status-monitor", "sidecars", "status-monitor", "lib", "runtime-paths.mjs")),
        true,
      );
      assert.equal(existsSync(join(tarExtract, "agent-status-monitor", "tests")), false);
      assert.equal(existsSync(join(tarExtract, "agent-status-monitor", ".runtime")), false);

      if (process.platform !== "win32") {
        assert.ok((statSync(join(tarExtract, "agent-status-monitor", "install.sh")).mode & 0o111) !== 0);
        assert.ok((statSync(join(tarExtract, "agent-status-monitor", "uninstall.sh")).mode & 0o111) !== 0);
      }

      const zipExtract = join(sandbox, "zip-out");
      mkdirSync(zipExtract, { recursive: true });
      const zipCmd =
        process.platform === "win32"
          ? await runCommand("powershell", [
              "-NoProfile",
              "-Command",
              `Expand-Archive -Path '${join(outDir, "agent-status-monitor.zip").replace(/'/g, "''")}' -DestinationPath '${zipExtract.replace(/'/g, "''")}' -Force`,
            ])
          : await runCommand("unzip", ["-q", join(outDir, "agent-status-monitor.zip"), "-d", zipExtract]);
      assert.equal(zipCmd.code, 0, zipCmd.stderr || zipCmd.stdout);
      assert.equal(existsSync(join(zipExtract, "agent-status-monitor", "sidecars", "status-monitor", "server.mjs")), true);
      assert.equal(existsSync(join(zipExtract, "agent-status-monitor", "tests")), false);
    });
  });

  it("app.js 真实对接 server.mjs 完成首屏拉取、预览告警切换、错误条保活、对话跟随与隐藏停轮询", async () => {
    await withTempDir(async (dir) => {
      const app = await createStatusServer({
        configPath: join(dir, "config.json"),
        serverInfoPath: join(dir, "server.json"),
        brainDirs: [join(dir, "brain")],
        fallbackHookPath: join(dir, "hook-state.json"),
        uiToken: "tok-ui-vm",
        hookToken: "tok-hk-vm",
        lsAddress: "",
        sdkBridgeImpl: {
          config: { conversationId: "conv-idle" },
          getPreloadJs: () => "",
          isSdkReady: () => false,
          handleSidecarRoute: async () => ({ status: 404, data: {} }),
        },
        probePathsFn: async () => ({
          proxyConfig: null,
          direct: { ok: true, statusCode: 404, latencyMs: 12, mode: "direct", error: null },
          proxy: null,
        }),
        inspectLsFn: async () => ({
          running: true,
          pids: ["777"],
          lsPid: "777",
          matchedByPort: true,
          established443: 1,
          synSent443: 0,
          proxyConns: 0,
          tunDetected: false,
          localIps: [],
          route: "direct",
          healthz: { reachable: true, instanceId: "vm-e2e" },
        }),
        notifyFn: () => {},
        disableSchedulers: true,
        writeServerInfo: false,
      });

      const port = await app.listen(0, "127.0.0.1");
      const now = Date.now();
      app.store.applyHookEvent({
        eventName: "Stop",
        receivedAt: now - 3000,
        payload: { conversationId: "conv-idle", terminationReason: "DONE" },
      });
      app.store.applyHookEvent({
        eventName: "PreInvocation",
        receivedAt: now,
        payload: { conversationId: "conv-busy", invocationNum: 5 },
      });

      const publicDir = join(PLUGIN_ROOT, "sidecars/status-monitor/public");
      const html = readFileSync(join(publicDir, "index.html"), "utf8");
      const scriptFiles = ["js/i18n.js", "js/format.js", "js/render.js", "js/client.js", "app.js"].map(
        (rel) => ({
          filename: rel,
          code: readFileSync(join(publicDir, rel), "utf8"),
        }),
      );

      const makeEl = (tag = "div") => {
        const classes = new Set();
        const attrs = new Map();
        const listeners = new Map();
        return {
          tagName: tag.toUpperCase(),
          textContent: "",
          innerHTML: "",
          value: "",
          checked: false,
          disabled: false,
          title: "",
          scrollTop: 0,
          children: [],
          dataset: {},
          style: {
            setProperty() {},
            getPropertyValue() {
              return "";
            },
          },
          classList: {
            add: (c) => classes.add(c),
            remove: (c) => classes.delete(c),
            contains: (c) => classes.has(c),
            toggle: (c, force) => {
              if (force === undefined) {
                if (classes.has(c)) {
                  classes.delete(c);
                  return false;
                }
                classes.add(c);
                return true;
              }
              if (force) classes.add(c);
              else classes.delete(c);
              return Boolean(force);
            },
          },
          setAttribute: (k, v) => attrs.set(k, String(v)),
          getAttribute: (k) => attrs.get(k) ?? null,
          removeAttribute: (k) => attrs.delete(k),
          appendChild: function (child) {
            this.children.push(child);
            return child;
          },
          append: function (...args) {
            this.children.push(...args);
          },
          replaceChildren: function (frag) {
            this.children = frag?.children ? [...frag.children] : [];
          },
          querySelector: () => null,
          remove: () => {},
          addEventListener: (type, fn) => {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
          },
          trigger: (type) => {
            for (const fn of listeners.get(type) || []) fn({ type });
          },
        };
      };

      const elements = new Map();
      for (const m of html.matchAll(/\bid="([^"]+)"/g)) {
        elements.set(m[1], makeEl());
      }
      const docListeners = new Map();
      const winListeners = new Map();
      const sessionMap = new Map();
      const localMap = new Map([["asm-lang", "zh"]]);
      const fetchCalls = [];
      let injectSimError = false;

      const docObj = {
        readyState: "complete",
        visibilityState: "visible",
        activeElement: null,
        documentElement: makeEl("html"),
        getElementById: (id) => elements.get(id) || null,
        querySelectorAll: () => [],
        createElement: (tag) => makeEl(tag),
        createDocumentFragment: () => ({
          children: [],
          appendChild(c) {
            this.children.push(c);
            return c;
          },
        }),
        addEventListener: (t, fn) => {
          if (!docListeners.has(t)) docListeners.set(t, []);
          docListeners.get(t).push(fn);
        },
        emit: (t) => {
          for (const fn of docListeners.get(t) || []) fn({ type: t });
        },
      };

      const winObj = {
        location: { search: "?token=tok-ui-vm&conversationId=conv-idle" },
        sidecar: {
          conversationId: "conv-idle",
          fetch: async (path, opts = {}) => {
            fetchCalls.push({ method: opts.method || "GET", path });
            if (injectSimError && path === "/api/simulate") {
              injectSimError = false;
              return {
                ok: false,
                status: 500,
                json: async () => ({ ok: false, error: "simulated backend failure" }),
              };
            }
            const headers = new Headers(opts.headers || {});
            headers.set("Content-Type", "application/json");
            headers.set("X-Sidecar-Token", "tok-ui-vm");
            headers.set("Origin", "plugin://agent-status-monitor");
            return globalThis.fetch(`http://127.0.0.1:${port}${path}`, { ...opts, headers });
          },
        },
        addEventListener: (t, fn) => {
          if (!winListeners.has(t)) winListeners.set(t, []);
          winListeners.get(t).push(fn);
        },
        emit: (t) => {
          for (const fn of winListeners.get(t) || []) fn({ type: t });
        },
        matchMedia: () => ({ matches: false, addEventListener() {} }),
      };

      const sandbox = {
        window: winObj,
        document: docObj,
        navigator: { language: "zh-CN" },
        localStorage: {
          getItem: (k) => localMap.get(k) ?? null,
          setItem: (k, v) => localMap.set(k, String(v)),
        },
        sessionStorage: {
          getItem: (k) => sessionMap.get(k) ?? null,
          setItem: (k, v) => sessionMap.set(k, String(v)),
        },
        Headers,
        URLSearchParams,
        AbortController,
        MutationObserver: class {
          observe() {}
        },
        BroadcastChannel: class {
          postMessage() {}
        },
        getComputedStyle: () => ({ color: "rgb(0,0,0)" }),
        setTimeout,
        clearTimeout,
        Date,
      };
      winObj.window = winObj;

      const waitUntil = async (pred, timeoutMs = 3000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (pred()) return;
          await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error("waitUntil timed out");
      };

      try {
        const vmContext = createContext(sandbox);
        for (const mod of scriptFiles) {
          runInContext(mod.code, vmContext, { filename: mod.filename });
        }

        // 1. 首屏严格绑定宿主当前空闲会话 conv-idle（不提供手动切换器，也不会主动拉取 conversationId=auto）
        await waitUntil(() => elements.get("verdictBadge").textContent.includes("IDLE"));
        assert.match(elements.get("convBadge").textContent, /conv-idl/);
        assert.equal(fetchCalls.some((u) => String(u).includes("conversationId=auto")), false);

        // 2. 点击 #btnSim 开启预览告警 -> UI 切换告警 -> 再点击关闭 -> 恢复 IDLE
        elements.get("btnSim").trigger("click");
        await waitUntil(() => elements.get("verdictBadge").textContent.includes("ALERT"));
        assert.equal(elements.get("btnSim").classList.contains("danger-active"), true);

        elements.get("btnSim").trigger("click");
        await waitUntil(() => elements.get("verdictBadge").textContent.includes("IDLE"));
        assert.equal(elements.get("btnSim").classList.contains("danger-active"), false);

        // 3. 操作失败提示显示在独立 #actionBanner，且后续 pollStatus/render 不冲掉它
        injectSimError = true;
        elements.get("btnSim").trigger("click");
        await waitUntil(() => elements.get("actionBanner").classList.contains("visible"));
        assert.match(elements.get("actionBanner").textContent, /simulated backend failure/);
        docObj.visibilityState = "visible";
        winObj.emit("focus");
        await new Promise((r) => setTimeout(r, 120));
        assert.equal(elements.get("actionBanner").classList.contains("visible"), true);

        // 4. 仅当宿主窗口（sidecar.conversationId）切换为 conv-busy 时，面板才随用户切换并显示 PreInvocation 真实距今秒数
        winObj.sidecar.conversationId = "conv-busy";
        winObj.emit("focus");
        await waitUntil(() => elements.get("verdictBadge").textContent.includes("WORKING"));
        assert.match(elements.get("convBadge").textContent, /conv-bus/);
        assert.match(elements.get("agentLogAge").textContent, /PreInvocation · \d+s/);
        assert.doesNotMatch(elements.get("agentLogAge").textContent, /前写入/);
        assert.equal(fetchCalls.some((u) => String(u).includes("conversationId=auto")), false);

        // 5. 切到隐藏页签后停止轮询请求，防止后台窗口耗尽 HTTP/1.1 6 连接池
        docObj.visibilityState = "hidden";
        docObj.emit("visibilitychange");
        await new Promise((r) => setTimeout(r, 150));
        const countWhenHidden = fetchCalls.length;
        await new Promise((r) => setTimeout(r, 1300));
        assert.equal(fetchCalls.length, countWhenHidden);

        // 6. 切回可见时立刻恢复拉取
        docObj.visibilityState = "visible";
        docObj.emit("visibilitychange");
        await waitUntil(() => fetchCalls.length > countWhenHidden);
      } finally {
        winObj.emit("pagehide");
        await app.stop();
      }
    });
  });
});
