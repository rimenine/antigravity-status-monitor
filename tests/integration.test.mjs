import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import {
  getLsEndpoints,
  inspectLanguageServer,
  parseScutilProxy,
} from "../sidecars/status-monitor/lib/probe.mjs";
import { readRegisteredServers } from "../sidecars/status-monitor/lib/runtime-paths.mjs";
import { PLUGIN_ROOT, withTempDir } from "./helpers.mjs";

const execFileAsync = promisify(execFile);

function httpRequest(port, method, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : typeof body === "string" ? body : JSON.stringify(body);
    const reqHeaders = { ...headers };
    if (payload != null) {
      reqHeaders["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers: reqHeaders }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

function spawnFakeLs(outboundHost = "") {
  const script = `
    const http = require("node:http");
    const net = require("node:net");
    let outbound = null;
    let outboundConnected = false;
    const srv = http.createServer((req, res) => {
      if (req.url === "/healthz") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", instanceId: "ci-ls-1" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      const host = process.env.FAKE_LS_OUTBOUND_HOST;
      if (!host) {
        process.stdout.write(JSON.stringify({ port, outboundConnected }) + "\\n");
        return;
      }
      outbound = net.connect({ host, port: 443 });
      const report = () => process.stdout.write(JSON.stringify({ port, outboundConnected }) + "\\n");
      const timer = setTimeout(report, 1200);
      outbound.once("connect", () => {
        clearTimeout(timer);
        outboundConnected = true;
        report();
      });
      outbound.once("error", () => {
        clearTimeout(timer);
        report();
      });
    });
    process.stdin.resume();
    process.stdin.on("end", () => {
      try { outbound?.destroy(); } catch {}
      srv.close(() => process.exit(0));
    });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        script,
        "--",
        "--cloud_code_endpoint=https://daily-cloudcode-pa.googleapis.com",
        "--api_server_url",
        "https://api.example.com",
      ],
      {
        env: { ...process.env, FAKE_LS_OUTBOUND_HOST: outboundHost },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let out = "";
    let err = "";
    let settled = false;
    const fail = (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {}
      reject(new Error(msg));
    };
    const timer = setTimeout(() => fail(`Fake LS startup timed out: ${err}`), 5000);
    child.stderr.on("data", (d) => (err += d));
    child.stdout.on("data", (d) => {
      out += d;
      const nl = out.indexOf("\n");
      if (nl !== -1 && !settled) {
        settled = true;
        clearTimeout(timer);
        const info = JSON.parse(out.slice(0, nl));
        resolve({ child, port: info.port, outboundConnected: info.outboundConnected });
      }
    });
    child.once("exit", (code) => fail(`Fake LS exited (${code}): ${err}`));
    child.on("error", (e) => fail(e.message));
  });
}

async function waitForFile(filePath, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(filePath, "utf8"));
        if (parsed?.port) return parsed;
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve();
    }, 2500);
    child.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
    try {
      child.stdin?.end();
      if (process.platform !== "win32") child.kill("SIGTERM");
    } catch {}
  });
}

describe("真实系统命令与子进程集成测试", () => {
  it("真实拉起伪装 Language Server 进程并执行系统级端口/命令行/443链路探测", async () => {
    const outboundHost = process.env.ASM_CI_OUTBOUND === "1" ? "github.com" : "";
    const fake = await spawnFakeLs(outboundHost);
    try {
      const ls = await inspectLanguageServer({ lsAddress: `127.0.0.1:${fake.port}` });
      assert.equal(ls.healthz?.reachable, true);
      assert.equal(ls.healthz?.instanceId, "ci-ls-1");
      assert.equal(ls.running, true);
      assert.equal(ls.matchedByPort, true);
      assert.equal(ls.lsPid, String(fake.child.pid));

      if (fake.outboundConnected) {
        assert.ok(ls.established443 >= 1, `expected established443 >= 1, got ${JSON.stringify(ls)}`);
        assert.ok(["direct", "tun"].includes(ls.route), `unexpected route: ${ls.route}`);
      }

      const endpoints = await getLsEndpoints(fake.child.pid);
      assert.deepEqual(endpoints, {
        cloudCode: "https://daily-cloudcode-pa.googleapis.com",
        apiServer: "https://api.example.com",
      });
    } finally {
      await stopChild(fake.child);
    }
  });

  it("真实启动 server.mjs 子进程并端到端打通全部 HTTP 接口", async () => {
    await withTempDir(async (dir) => {
      const runtimeDir = join(dir, ".runtime");
      const appDataDir = join(dir, "appdata");
      mkdirSync(runtimeDir, { recursive: true });
      mkdirSync(join(appDataDir, "brain"), { recursive: true });
      writeFileSync(
        join(runtimeDir, "config.json"),
        JSON.stringify({
          intervalMs: 60000,
          timeoutMs: 1200,
          probeUrl: "https://127.0.0.1:1/healthz",
          notifyOnDisconnect: true,
          lang: "zh",
        }),
        "utf8",
      );

      const child = spawn(process.execPath, [join(PLUGIN_ROOT, "sidecars/status-monitor/server.mjs")], {
        env: {
          ...process.env,
          ASM_RUNTIME_DIR: runtimeDir,
          ANTIGRAVITY_APP_DATA_DIR: appDataDir,
          ANTIGRAVITY_SIDECAR_UI_TOKEN: "ci-ui-token",
          ANTIGRAVITY_LS_ADDRESS: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      try {
        const srvInfo = await waitForFile(join(runtimeDir, "server.json"));
        const port = srvInfo.port;
        const uiHeaders = {
          Origin: "plugin://agent-status-monitor",
          "Content-Type": "application/json",
          "X-Sidecar-Token": "ci-ui-token",
        };

        const unauthRes = await httpRequest(port, "GET", "/api/status");
        assert.equal(unauthRes.status, 401);

        const rebindRes = await httpRequest(port, "GET", "/api/status", {
          headers: { Host: `evil.example:${port}`, "X-Sidecar-Token": "ci-ui-token" },
        });
        assert.equal(rebindRes.status, 403);

        const statusRes = await httpRequest(port, "GET", "/api/status", { headers: uiHeaders });
        assert.equal(statusRes.status, 200);
        assert.equal(statusRes.headers["content-security-policy"], "default-src 'self'; connect-src 'self'");
        const statusJson = JSON.parse(statusRes.body);
        assert.equal(statusJson.security.uiTokenEnforced, true);

        const cfgRes = await httpRequest(port, "POST", "/api/config", {
          headers: uiHeaders,
          body: { lang: "en", notifyOnDisconnect: process.env.CI === "true" },
        });
        assert.equal(cfgRes.status, 200);
        assert.equal(JSON.parse(cfgRes.body).config.lang, "en");

        const probeRes = await httpRequest(port, "POST", "/api/probe", {
          headers: uiHeaders,
          body: {},
        });
        assert.equal(probeRes.status, 200);
        const probeJson = JSON.parse(probeRes.body);
        assert.equal(probeJson.ok, true);
        assert.equal(probeJson.result.ok, false);

        const simRes = await httpRequest(port, "POST", "/api/simulate", {
          headers: uiHeaders,
          body: { active: true },
        });
        assert.equal(simRes.status, 200);
        assert.equal(JSON.parse(simRes.body).simulation.active, true);

        const hookRes = await httpRequest(port, "POST", "/api/hook", {
          headers: {
            "Content-Type": "application/json",
            "X-Hook-Token": srvInfo.hookToken,
          },
          body: {
            eventName: "PreInvocation",
            receivedAt: Date.now(),
            payload: { conversationId: "ci-conv-1", invocationNum: 1 },
          },
        });
        assert.equal(hookRes.status, 200);

        const afterRes = await httpRequest(port, "GET", "/api/status?conversationId=ci-conv-1", {
          headers: uiHeaders,
        });
        assert.equal(afterRes.status, 200);
        const afterJson = JSON.parse(afterRes.body);
        assert.equal(afterJson.hook.phase, "waiting_llm");
        assert.equal(afterJson.verdict.code, "DISCONNECTED_HANG");
      } finally {
        if (process.platform === "win32") {
          try {
            child.kill();
          } catch {}
        } else {
          await stopChild(child);
        }
      }
    });
  });

  it("独立启动无 ANTIGRAVITY_SIDECAR_UI_TOKEN 时仍自动启用 Token 认证并在 stderr 打印访问链接", async () => {
    await withTempDir(async (dir) => {
      const runtimeDir = join(dir, ".runtime");
      const appDataDir = join(dir, "appdata");
      mkdirSync(runtimeDir, { recursive: true });
      mkdirSync(join(appDataDir, "brain"), { recursive: true });

      const childEnv = {
        ...process.env,
        ASM_RUNTIME_DIR: runtimeDir,
        ANTIGRAVITY_APP_DATA_DIR: appDataDir,
        ANTIGRAVITY_LS_ADDRESS: "",
      };
      delete childEnv.ANTIGRAVITY_SIDECAR_UI_TOKEN;

      let stderrOut = "";
      const child = spawn(process.execPath, [join(PLUGIN_ROOT, "sidecars/status-monitor/server.mjs")], {
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stderr.on("data", (d) => (stderrOut += d.toString("utf8")));

      try {
        const srvInfo = await waitForFile(join(runtimeDir, "server.json"));
        const deadline = Date.now() + 4000;
        let standaloneToken = "";
        while (Date.now() < deadline) {
          const m = stderrOut.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=([0-9a-f]+)/);
          if (m) {
            standaloneToken = m[1];
            break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        assert.ok(standaloneToken.length >= 32, `Expected standalone token URL in stderr, got: ${stderrOut}`);
        assert.equal("uiToken" in srvInfo, false);

        assert.equal((await httpRequest(srvInfo.port, "GET", "/api/status")).status, 401);
        const okRes = await httpRequest(srvInfo.port, "GET", "/api/status", {
          headers: { "X-Sidecar-Token": standaloneToken },
        });
        assert.equal(okRes.status, 200);
        assert.equal(JSON.parse(okRes.body).security.uiTokenEnforced, true);
      } finally {
        if (process.platform === "win32") {
          try {
            child.kill();
          } catch {}
        } else {
          await stopChild(child);
        }
      }
    });
  });

  it("多窗口独立 Sidecar 进程并存时，hook-reporter 按 LS 地址精准投递且清理死亡进程注册表", async () => {
    await withTempDir(async (dir) => {
      const runtimeDir = join(dir, ".runtime");
      const serversDir = join(runtimeDir, "servers");
      const appDataDir = join(dir, "appdata");
      mkdirSync(runtimeDir, { recursive: true });
      mkdirSync(join(appDataDir, "brain"), { recursive: true });

      const spawnSidecar = (lsAddress, uiToken) =>
        spawn(process.execPath, [join(PLUGIN_ROOT, "sidecars/status-monitor/server.mjs")], {
          env: {
            ...process.env,
            ASM_RUNTIME_DIR: runtimeDir,
            ANTIGRAVITY_APP_DATA_DIR: appDataDir,
            ANTIGRAVITY_CONVERSATION_ID: "",
            ANTIGRAVITY_LS_ADDRESS: lsAddress,
            ANTIGRAVITY_SIDECAR_UI_TOKEN: uiToken,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });

      const child1 = spawnSidecar("127.0.0.1:41111", "tok-win-1");
      const child2 = spawnSidecar("127.0.0.1:42222", "tok-win-2");

      try {
        const deadline = Date.now() + 8000;
        let win1Info = null;
        let win2Info = null;
        while (Date.now() < deadline) {
          if (existsSync(serversDir)) {
            const list = readRegisteredServers({ serversDir });
            win1Info = list.find((s) => s.lsAddress === "127.0.0.1:41111") || null;
            win2Info = list.find((s) => s.lsAddress === "127.0.0.1:42222") || null;
            if (win1Info && win2Info) break;
          }
          await new Promise((r) => setTimeout(r, 80));
        }
        assert.ok(win1Info && win2Info, "Both Sidecar instances should register in .runtime/servers");

        const hookRes = await new Promise((resolve, reject) => {
          const hk = spawn(process.execPath, [join(PLUGIN_ROOT, "hooks/hook-reporter.mjs"), "PreInvocation"], {
            env: {
              ...process.env,
              PLUGIN_ROOT,
              ASM_RUNTIME_DIR: runtimeDir,
              ANTIGRAVITY_CONVERSATION_ID: "",
              ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:41111",
            },
            stdio: ["pipe", "pipe", "pipe"],
          });
          hk.on("error", reject);
          hk.on("close", (code) => resolve(code));
          hk.stdin.end(JSON.stringify({ conversationId: "conv-win1-only", invocationNum: 1 }));
        });
        assert.equal(hookRes, 0);

        const s1 = JSON.parse(
          (await httpRequest(win1Info.port, "GET", "/api/status", { headers: { "X-Sidecar-Token": "tok-win-1" } })).body,
        );
        const s2 = JSON.parse(
          (await httpRequest(win2Info.port, "GET", "/api/status", { headers: { "X-Sidecar-Token": "tok-win-2" } })).body,
        );
        assert.equal(s1.activeConversationId, "conv-win1-only");
        assert.equal(s1.hook.phase, "waiting_llm");
        assert.notEqual(s2.activeConversationId, "conv-win1-only");
        assert.equal(s2.hook.phase, "idle");

        if (process.platform === "win32") {
          child1.kill();
        } else {
          await stopChild(child1);
        }
        if (child1.exitCode === null) {
          await new Promise((r) => child1.once("exit", r));
        }
        const aliveAfterKill1 = readRegisteredServers({
          serverInfoPath: join(runtimeDir, "server.json"),
          serversDir,
          pruneDead: true,
        });
        assert.equal(aliveAfterKill1.some((s) => s.lsAddress === "127.0.0.1:41111"), false);
        assert.equal(aliveAfterKill1.some((s) => s.lsAddress === "127.0.0.1:42222"), true);
        assert.equal(readdirSync(serversDir).length, 1);
      } finally {
        for (const c of [child1, child2]) {
          if (process.platform === "win32") {
            try {
              c.kill();
            } catch {}
          } else {
            await stopChild(c);
          }
        }
      }
    });
  });

  if (process.platform === "darwin") {
    it("macOS 实机验证 scutil --proxy 与 osascript 通知脚本语法/转义", async () => {
      const { stdout: scutilOut } = await execFileAsync("scutil", ["--proxy"], { timeout: 2500 });
      assert.match(scutilOut, /<dictionary>/);
      parseScutilProxy(scutilOut);

      const script = 'display notification "Quote \\"ok\\" and \\\\ slash" with title "Antigravity Status Monitor"';
      const scptPath = join(tmpdir(), `asm-ci-${Date.now()}.scpt`);
      try {
        await execFileAsync("osacompile", ["-e", script, "-o", scptPath], { timeout: 4000 });
        try {
          await execFileAsync("osascript", ["-e", script], { timeout: 4000 });
        } catch (err) {
          assert.doesNotMatch(String(err?.stderr || err?.message || ""), /syntax error|compile error/i);
        }
      } finally {
        rmSync(scptPath, { force: true });
      }
    });
  }
});
