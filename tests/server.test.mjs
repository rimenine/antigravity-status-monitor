import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createStatusServer } from "../sidecars/status-monitor/server.mjs";
import { withTempDir } from "./helpers.mjs";

function httpRequest(port, method, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const payload = body == null ? null : typeof body === "string" ? body : JSON.stringify(body);
    const reqHeaders = { ...headers };
    if (payload != null) {
      reqHeaders["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers: reqHeaders }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        done = true;
        resolve({ status: res.statusCode, headers: res.headers, body: data });
      });
    });
    req.on("error", (err) => {
      if (!done) reject(err);
    });
    if (payload != null) req.write(payload);
    req.end();
  });
}

function readFirstTwoSseEvents(port, path) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk;
        const blocks = buf.split("\n\n");
        buf = blocks.pop() || "";
        for (const block of blocks) {
          const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
          if (dataLine) {
            events.push(JSON.parse(dataLine.slice(6)));
          }
        }
        if (events.length >= 2) {
          req.destroy();
          resolve(events);
        }
      });
    });
    req.on("error", (err) => {
      if (events.length >= 2) resolve(events);
      else reject(err);
    });
    setTimeout(() => {
      req.destroy();
      resolve(events);
    }, 3000);
  });
}

describe("server HTTP 端到端集成测试", () => {
  it("静态页面、/api/status、/api/simulate(含桌面通知)、/api/config 与双令牌鉴权全链路正常", async () => {
    await withTempDir(async (dir) => {
      const cfgPath = join(dir, "config.json");
      const srvPath = join(dir, "server.json");
      const fallbackPath = join(dir, "hook-state.json");
      const brainDir = join(dir, "brain");
      writeFileSync(cfgPath, JSON.stringify({ notifyOnDisconnect: true, lang: "zh" }), "utf8");

      const notifications = [];
      const app = await createStatusServer({
        configPath: cfgPath,
        serverInfoPath: srvPath,
        brainDirs: [brainDir],
        fallbackHookPath: fallbackPath,
        uiToken: "ui-secret-42",
        hookToken: "hook-secret-99",
        lsAddress: "",
        sdkBridgeImpl: {
          config: { conversationId: "conv-e2e" },
          getPreloadJs: () => "",
          isSdkReady: () => false,
          handleSidecarRoute: async () => ({ status: 404, data: { error: "stub" } }),
        },
        probePathsFn: async () => ({
          proxyConfig: null,
          direct: { ok: true, statusCode: 404, latencyMs: 25, mode: "direct", error: null },
          proxy: null,
        }),
        inspectLsFn: async () => ({
          running: true,
          pids: ["999"],
          lsPid: "999",
          matchedByPort: true,
          established443: 1,
          synSent443: 0,
          proxyConns: 0,
          tunDetected: false,
          localIps: [],
          route: "direct",
          healthz: { reachable: true, instanceId: "e2e" },
        }),
        notifyFn: (title, message) => notifications.push({ title, message }),
        disableSchedulers: true,
        writeServerInfo: true,
      });

      const port = await app.listen(0, "127.0.0.1");
      try {
        const htmlRes = await httpRequest(port, "GET", "/");
        assert.equal(htmlRes.status, 200);
        assert.equal(htmlRes.headers["x-content-type-options"], "nosniff");
        assert.equal(htmlRes.headers["content-security-policy"], "default-src 'self'; connect-src 'self'");
        assert.match(htmlRes.body, /id="btnSim"/);

        const rebindHtml = await httpRequest(port, "GET", "/", {
          headers: { Host: `evil.example:${port}` },
        });
        assert.equal(rebindHtml.status, 403);

        const jsRes = await httpRequest(port, "GET", "/app.js");
        assert.equal(jsRes.status, 200);
        assert.equal(jsRes.headers["content-security-policy"], "default-src 'self'; connect-src 'self'");
        assert.match(jsRes.body, /pollStatus/);
        assert.doesNotMatch(jsRes.body, /\bnew EventSource\b/);

        for (const subPath of ["/js/i18n.js", "/js/format.js", "/js/render.js", "/js/client.js"]) {
          const subRes = await httpRequest(port, "GET", subPath);
          assert.equal(subRes.status, 200);
          assert.equal(subRes.headers["content-security-policy"], "default-src 'self'; connect-src 'self'");
          assert.match(subRes.headers["content-type"], /application\/javascript/);
        }
        const traversalRes = await httpRequest(port, "GET", "/js/../server.mjs");
        assert.equal(traversalRes.status, 404);

        const unauthStatus = await httpRequest(port, "GET", "/api/status?conversationId=unauth-conv");
        assert.equal(unauthStatus.status, 401);

        const unauthEvents = await httpRequest(port, "GET", "/api/events");
        assert.equal(unauthEvents.status, 401);

        const crossSiteStatus = await httpRequest(port, "GET", "/api/status?conversationId=conv-e2e", {
          headers: { "Sec-Fetch-Site": "cross-site", "X-Sidecar-Token": "ui-secret-42" },
        });
        assert.equal(crossSiteStatus.status, 403);

        const rebindStatus = await httpRequest(port, "GET", "/api/status", {
          headers: { Host: `attacker.example:${port}`, "X-Sidecar-Token": "ui-secret-42" },
        });
        assert.equal(rebindStatus.status, 403);

        const srvDisk = JSON.parse(readFileSync(srvPath, "utf8"));
        assert.equal(srvDisk.hookToken, "hook-secret-99");
        assert.equal("uiToken" in srvDisk, false);

        const statusRes = await httpRequest(port, "GET", "/api/status?conversationId=conv-e2e", {
          headers: { "X-Sidecar-Token": "ui-secret-42" },
        });
        assert.equal(statusRes.status, 200);
        assert.equal(statusRes.headers["content-security-policy"], "default-src 'self'; connect-src 'self'");
        const snapshot = JSON.parse(statusRes.body);
        assert.equal(snapshot.security.uiTokenEnforced, true);
        assert.equal(snapshot.verdict.code, "IDLE");

        const badOrigin = await httpRequest(port, "POST", "/api/simulate", {
          headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
          body: {},
        });
        assert.equal(badOrigin.status, 403);

        const missingTok = await httpRequest(port, "POST", "/api/simulate", {
          headers: { Origin: "http://127.0.0.1:1234", "Content-Type": "application/json" },
          body: {},
        });
        assert.equal(missingTok.status, 401);

        const simOn = await httpRequest(port, "POST", "/api/simulate", {
          headers: {
            Origin: "plugin://agent-status-monitor",
            "Content-Type": "application/json",
            "X-Sidecar-Token": "ui-secret-42",
          },
          body: { active: true },
        });
        assert.equal(simOn.status, 200);
        assert.equal(JSON.parse(simOn.body).simulation.active, true);
        assert.equal(notifications.length, 1);

        const probeDuringSim = await httpRequest(port, "POST", "/api/probe", {
          headers: {
            Origin: "plugin://agent-status-monitor",
            "Content-Type": "application/json",
            "X-Sidecar-Token": "ui-secret-42",
          },
          body: {},
        });
        assert.equal(probeDuringSim.status, 200);
        assert.equal(notifications.length, 1);

        const simOff = await httpRequest(port, "POST", "/api/simulate", {
          headers: {
            Origin: "plugin://agent-status-monitor",
            "Content-Type": "application/json",
            "X-Sidecar-Token": "ui-secret-42",
          },
          body: { active: false },
        });
        assert.equal(simOff.status, 200);
        assert.equal(JSON.parse(simOff.body).simulation.active, false);

        const badHook = await httpRequest(port, "POST", "/api/hook", {
          headers: { "Content-Type": "application/json", "X-Hook-Token": "ui-secret-42" },
          body: { eventName: "PreInvocation" },
        });
        assert.equal(badHook.status, 401);

        const okHook = await httpRequest(port, "POST", "/api/hook", {
          headers: { "Content-Type": "application/json", "X-Hook-Token": "hook-secret-99" },
          body: {
            eventName: "PreInvocation",
            receivedAt: Date.now(),
            payload: { conversationId: "conv-e2e", invocationNum: 1 },
          },
        });
        assert.equal(okHook.status, 200);

        const afterHook = JSON.parse(
          (
            await httpRequest(port, "GET", "/api/status?conversationId=conv-e2e", {
              headers: { "X-Sidecar-Token": "ui-secret-42" },
            })
          ).body,
        );
        assert.equal(afterHook.hook.phase, "waiting_llm");
        assert.equal(afterHook.verdict.code, "WAITING_LLM");

        const ssePromise = readFirstTwoSseEvents(port, "/api/events?conversationId=conv-e2e&token=ui-secret-42");
        await new Promise((r) => setTimeout(r, 80));
        const cfgRes = await httpRequest(port, "POST", "/api/config", {
          headers: {
            Origin: "plugin://agent-status-monitor",
            "Content-Type": "application/json",
            "X-Sidecar-Token": "ui-secret-42",
          },
          body: { lang: "en" },
        });
        assert.equal(cfgRes.status, 200);
        const sseEvents = await ssePromise;
        assert.ok(sseEvents.length >= 2);
        assert.equal(sseEvents[sseEvents.length - 1].config.lang, "en");
      } finally {
        await app.stop();
      }
    });
  });

  it("并发探测合并、报错兜底、PAC 提示、lsPid 端点刷新、清理过期降级文件与 413 限流", async () => {
    await withTempDir(async (dir) => {
      const cfgPath = join(dir, "config.json");
      const fallbackPath = join(dir, "hook-state.json");
      writeFileSync(
        fallbackPath,
        JSON.stringify({ eventName: "PreInvocation", receivedAt: 1000 }),
        "utf8",
      );

      let probeCalls = 0;
      let shouldThrowProbe = false;
      let lastManualProxyArg = "";
      let currentPid = "101";
      const fetchedEndpointPids = [];

      const app = await createStatusServer({
        configPath: cfgPath,
        serverInfoPath: join(dir, "server.json"),
        brainDirs: [join(dir, "brain")],
        fallbackHookPath: fallbackPath,
        uiToken: "ui-tok",
        hookToken: "hk-tok",
        lsAddress: "",
        sdkBridgeImpl: {
          config: { conversationId: null },
          getPreloadJs: () => "",
          isSdkReady: () => false,
          handleSidecarRoute: async () => ({ status: 404, data: {} }),
        },
        probePathsFn: async (_url, _timeout, opts = {}) => {
          probeCalls += 1;
          lastManualProxyArg = opts.manualProxyUrl || "";
          await new Promise((r) => setTimeout(r, 40));
          if (shouldThrowProbe) throw new Error("probe boom");
          return {
            proxyConfig: {
              enabled: false,
              pacUrl: "http://127.0.0.1:7890/pac.js",
              source: "macos-pac-unsupported",
            },
            direct: { ok: true, statusCode: 404, latencyMs: 50, mode: "direct", error: null },
            proxy: null,
          };
        },
        inspectLsFn: async () => ({
          running: Boolean(currentPid),
          pids: currentPid ? [currentPid] : [],
          lsPid: currentPid,
          matchedByPort: Boolean(currentPid),
          established443: 0,
          synSent443: 0,
          proxyConns: 0,
          tunDetected: false,
          localIps: [],
          route: "direct",
          healthz: { reachable: Boolean(currentPid), instanceId: null },
        }),
        getLsEndpointsFn: async (pid) => {
          fetchedEndpointPids.push(pid);
          return { cloudCode: `https://cc-${pid}.example`, apiServer: null };
        },
        notifyFn: () => {},
        disableSchedulers: true,
        writeServerInfo: false,
      });

      const port = await app.listen(0, "127.0.0.1");
      const uiHeaders = {
        Origin: "plugin://agent-status-monitor",
        "Content-Type": "application/json",
        "X-Sidecar-Token": "ui-tok",
      };
      try {
        await app.runLsInspection();
        assert.equal(app.runtime.ls.endpoints.cloudCode, "https://cc-101.example");
        currentPid = "202";
        await app.runLsInspection();
        assert.equal(app.runtime.ls.endpoints.cloudCode, "https://cc-202.example");
        currentPid = null;
        await app.runLsInspection();
        assert.equal(app.runtime.ls.endpoints, null);
        assert.deepEqual(fetchedEndpointPids, ["101", "202"]);

        const [p1, p2] = await Promise.all([
          httpRequest(port, "POST", "/api/probe", { headers: uiHeaders, body: {} }),
          httpRequest(port, "POST", "/api/probe", { headers: uiHeaders, body: {} }),
        ]);
        assert.equal(p1.status, 200);
        assert.equal(p2.status, 200);
        assert.equal(probeCalls, 1);

        shouldThrowProbe = true;
        const pErr = await httpRequest(port, "POST", "/api/probe", { headers: uiHeaders, body: {} });
        assert.equal(pErr.status, 500);

        const pacStatus = JSON.parse(
          (await httpRequest(port, "GET", "/api/status", { headers: { "X-Sidecar-Token": "ui-tok" } })).body,
        );
        assert.equal(pacStatus.proxyConfig.source, "macos-pac-unsupported");
        assert.ok(pacStatus.events.some((e) => e.i18n?.key === "PAC_UNSUPPORTED"));

        shouldThrowProbe = false;
        const setManual = await httpRequest(port, "POST", "/api/config", {
          headers: uiHeaders,
          body: { manualProxyUrl: "http://alice:secretpw@127.0.0.1:7897" },
        });
        assert.equal(setManual.status, 200);
        assert.equal(JSON.parse(setManual.body).config.manualProxyUrl, "http://***@127.0.0.1:7897");

        const manualProbe = await httpRequest(port, "POST", "/api/probe", { headers: uiHeaders, body: {} });
        assert.equal(manualProbe.status, 200);
        assert.equal(lastManualProxyArg, "http://alice:secretpw@127.0.0.1:7897");

        const maskedStatus = await httpRequest(port, "GET", "/api/status", {
          headers: { "X-Sidecar-Token": "ui-tok" },
        });
        assert.equal(maskedStatus.status, 200);
        assert.equal(maskedStatus.body.includes("secretpw"), false);
        assert.equal(JSON.parse(maskedStatus.body).config.manualProxyUrl, "http://***@127.0.0.1:7897");

        const hookRes = await httpRequest(port, "POST", "/api/hook", {
          headers: { "Content-Type": "application/json", "X-Hook-Token": "hk-tok" },
          body: { eventName: "Stop", receivedAt: 2000, payload: { conversationId: "c1" } },
        });
        assert.equal(hookRes.status, 200);
        assert.equal(existsSync(fallbackPath), false);

        const bigRes = await httpRequest(port, "POST", "/api/config", {
          headers: uiHeaders,
          body: JSON.stringify({ pad: "中".repeat(100_000) }),
        });
        assert.equal(bigRes.status, 413);
      } finally {
        await app.stop();
      }
    });
  });

  it("Origin: null 返回 403、配置校验返回 400、关闭模拟立即恢复真实告警、代理关闭不粘滞及端点单次采集", async () => {
    await withTempDir(async (dir) => {
      const notifications = [];
      let proxyEnabled = true;
      let probeFail = false;
      let endpointCalls = 0;

      const app = await createStatusServer({
        configPath: join(dir, "config.json"),
        serverInfoPath: join(dir, "server.json"),
        brainDirs: [join(dir, "brain")],
        fallbackHookPath: join(dir, "hook-state.json"),
        uiToken: "ui-tok-2",
        hookToken: "hk-tok-2",
        lsAddress: "",
        sdkBridgeImpl: {
          config: { conversationId: "conv-s2" },
          getPreloadJs: () => "",
          isSdkReady: () => false,
          handleSidecarRoute: async () => ({ status: 404, data: {} }),
        },
        probePathsFn: async (_u, _t, opts = {}) => {
          const direct = probeFail
            ? { ok: false, statusCode: null, latencyMs: 500, mode: "direct", proxyAddress: null, error: "TIMEOUT" }
            : { ok: true, statusCode: 404, latencyMs: 35, mode: "direct", proxyAddress: null, error: null };
          if (opts.manualProxyUrl) {
            return {
              proxyConfig: { enabled: true, host: "127.0.0.1", port: 8899, source: "manual" },
              direct,
              proxy: { ok: true, statusCode: 404, latencyMs: 22, mode: "proxy", proxyAddress: "127.0.0.1:8899", error: null },
            };
          }
          if (proxyEnabled) {
            return {
              proxyConfig: { enabled: true, host: "127.0.0.1", port: 7897, source: "windows-registry" },
              direct,
              proxy: { ok: !probeFail, statusCode: probeFail ? null : 404, latencyMs: 40, mode: "proxy", proxyAddress: "127.0.0.1:7897", error: probeFail ? "DOWN" : null },
            };
          }
          return { proxyConfig: { enabled: false, source: "none" }, direct, proxy: null };
        },
        inspectLsFn: async () => ({
          running: true,
          pids: ["555"],
          lsPid: "555",
          matchedByPort: true,
          established443: 0,
          synSent443: 0,
          proxyConns: proxyEnabled ? 1 : 0,
          tunDetected: false,
          localIps: [],
          route: proxyEnabled ? "proxy" : null,
          healthz: { reachable: true, instanceId: "s2" },
        }),
        getLsEndpointsFn: async () => {
          endpointCalls += 1;
          return null;
        },
        notifyFn: (title, message) => notifications.push({ title, message }),
        disableSchedulers: true,
        writeServerInfo: false,
      });

      const port = await app.listen(0, "127.0.0.1");
      const uiHeaders = {
        Origin: "plugin://agent-status-monitor",
        "Content-Type": "application/json",
        "X-Sidecar-Token": "ui-tok-2",
      };
      try {
        const nullOriginRes = await httpRequest(port, "POST", "/api/simulate", {
          headers: {
            Origin: "null",
            "Content-Type": "application/json",
            "X-Sidecar-Token": "ui-tok-2",
          },
          body: {},
        });
        assert.equal(nullOriginRes.status, 403);

        await app.runLsInspection();
        await app.runLsInspection();
        assert.equal(endpointCalls, 1);

        const pWithProxy = await httpRequest(port, "POST", "/api/probe", { headers: uiHeaders, body: {} });
        assert.equal(JSON.parse(pWithProxy.body).result.activeRoute, "proxy");

        proxyEnabled = false;
        await app.runLsInspection();
        const pAfterOff = await httpRequest(port, "POST", "/api/probe", { headers: uiHeaders, body: {} });
        assert.equal(JSON.parse(pAfterOff.body).result.activeRoute, "direct");
        assert.equal(JSON.parse(pAfterOff.body).result.proxyAddress, null);

        for (const badBody of [
          { intervalMs: "not-a-number" },
          { probeUrl: "https://not a url" },
          { manualProxyUrl: "socks4://127.0.0.1:1080" },
          { manualProxyUrl: "127.0.0.1" },
          { manualProxyUrl: "socks5://user:pw@127.0.0.1:1080" },
        ]) {
          const badRes = await httpRequest(port, "POST", "/api/config", { headers: uiHeaders, body: badBody });
          assert.equal(badRes.status, 400);
          assert.ok(JSON.parse(badRes.body).detail);
        }

        await httpRequest(port, "POST", "/api/hook", {
          headers: { "Content-Type": "application/json", "X-Hook-Token": "hk-tok-2" },
          body: { eventName: "PreInvocation", receivedAt: Date.now(), payload: { conversationId: "conv-s2" } },
        });
        await httpRequest(port, "POST", "/api/simulate", { headers: uiHeaders, body: { active: true } });
        assert.equal(notifications.length, 1);
        await httpRequest(port, "POST", "/api/simulate", { headers: uiHeaders, body: { active: false } });

        probeFail = true;
        await httpRequest(port, "POST", "/api/probe", { headers: uiHeaders, body: {} });
        await httpRequest(port, "POST", "/api/probe", { headers: uiHeaders, body: {} });
        assert.equal(notifications.length, 1);
        await httpRequest(port, "POST", "/api/probe", { headers: uiHeaders, body: {} });
        assert.equal(notifications.length, 2);
      } finally {
        await app.stop();
      }
    });
  });

  it("未传 uiToken 且无环境变量时，仍默认随机生成令牌并强制校验全部 GET / POST API", async () => {
    await withTempDir(async (dir) => {
      const prevEnv = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
      delete process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
      try {
        const app = await createStatusServer({
          configPath: join(dir, "config.json"),
          serverInfoPath: join(dir, "server.json"),
          brainDirs: [join(dir, "brain")],
          fallbackHookPath: join(dir, "hook-state.json"),
          lsAddress: "",
          sdkBridgeImpl: {
            config: { conversationId: null },
            getPreloadJs: () => "",
            isSdkReady: () => false,
            handleSidecarRoute: async () => ({ status: 404, data: {} }),
          },
          notifyFn: () => {},
          disableSchedulers: true,
          writeServerInfo: false,
        });
        const port = await app.listen(0, "127.0.0.1");
        try {
          assert.equal(app.security.hasUiToken, true);
          assert.ok(app.security.uiToken.length >= 32);

          assert.equal((await httpRequest(port, "GET", "/api/status")).status, 401);
          assert.equal((await httpRequest(port, "GET", "/api/events")).status, 401);
          assert.equal((await httpRequest(port, "GET", "/api/unknown")).status, 401);
          assert.equal(
            (await httpRequest(port, "POST", "/api/probe", { headers: { "Content-Type": "application/json" }, body: {} })).status,
            401,
          );

          const okStatus = await httpRequest(port, "GET", "/api/status", {
            headers: { "X-Sidecar-Token": app.security.uiToken },
          });
          assert.equal(okStatus.status, 200);
          assert.equal(JSON.parse(okStatus.body).security.uiTokenEnforced, true);

          const notFoundWithTok = await httpRequest(port, "GET", "/api/unknown", {
            headers: { "X-Sidecar-Token": app.security.uiToken },
          });
          assert.equal(notFoundWithTok.status, 404);
        } finally {
          await app.stop();
        }
      } finally {
        if (prevEnv !== undefined) process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = prevEnv;
      }
    });
  });

  it("多窗口 Sidecar 共用 .runtime 时独立写 .runtime/servers/*.json 且关闭时优雅恢复 server.json", async () => {
    await withTempDir(async (dir) => {
      const rtDir = join(dir, ".runtime");
      const serverInfoPath = join(rtDir, "server.json");
      const serversDir = join(rtDir, "servers");
      const mkOpts = (lsAddress, uiToken, hookToken) => ({
        configPath: join(rtDir, "config.json"),
        serverInfoPath,
        serversDir,
        brainDirs: [join(dir, "brain")],
        fallbackHookPath: join(rtDir, "hook-state.json"),
        uiToken,
        hookToken,
        lsAddress,
        sdkBridgeImpl: {
          config: { conversationId: null },
          getPreloadJs: () => "",
          isSdkReady: () => false,
          handleSidecarRoute: async () => ({ status: 404, data: {} }),
        },
        notifyFn: () => {},
        disableSchedulers: true,
        writeServerInfo: true,
      });

      const app1 = await createStatusServer(mkOpts("127.0.0.1:1111", "ui-1", "hk-1"));
      const port1 = await app1.listen(0, "127.0.0.1");
      await new Promise((r) => setTimeout(r, 15));
      const app2 = await createStatusServer(mkOpts("127.0.0.1:2222", "ui-2", "hk-2"));
      const port2 = await app2.listen(0, "127.0.0.1");

      const inst1Path = join(serversDir, `sidecar-${process.pid}-${port1}.json`);
      const inst2Path = join(serversDir, `sidecar-${process.pid}-${port2}.json`);

      try {
        assert.equal(existsSync(inst1Path), true);
        assert.equal(existsSync(inst2Path), true);
        assert.equal(JSON.parse(readFileSync(inst1Path, "utf8")).lsAddress, "127.0.0.1:1111");
        assert.equal(JSON.parse(readFileSync(inst2Path, "utf8")).lsAddress, "127.0.0.1:2222");
        assert.equal(JSON.parse(readFileSync(serverInfoPath, "utf8")).port, port2);

        await app2.stop();
        assert.equal(existsSync(inst2Path), false);
        assert.equal(existsSync(inst1Path), true);
        const restoredLegacy = JSON.parse(readFileSync(serverInfoPath, "utf8"));
        assert.equal(restoredLegacy.port, port1);
        assert.equal(restoredLegacy.lsAddress, "127.0.0.1:1111");
      } finally {
        await app2.stop();
        await app1.stop();
      }
      assert.equal(existsSync(inst1Path), false);
      assert.equal(existsSync(serverInfoPath), false);
    });
  });

  it("HTTP/1.1 并发短轮询不阻塞操作、SSE 强断零泄漏且固定单对话隔离禁止 auto 切换与跨会话模拟污染", async () => {
    await withTempDir(async (dir) => {
      const app = await createStatusServer({
        configPath: join(dir, "config.json"),
        serverInfoPath: join(dir, "server.json"),
        brainDirs: [join(dir, "brain")],
        fallbackHookPath: join(dir, "hook-state.json"),
        uiToken: "ui-tok-follow",
        hookToken: "hk-tok-follow",
        lsAddress: "",
        sdkBridgeImpl: {
          config: { conversationId: null },
          getPreloadJs: () => "",
          isSdkReady: () => false,
          handleSidecarRoute: async () => ({ status: 404, data: {} }),
        },
        probePathsFn: async () => ({
          proxyConfig: null,
          direct: { ok: true, statusCode: 404, latencyMs: 18, mode: "direct", error: null },
          proxy: null,
        }),
        inspectLsFn: async () => ({
          running: true,
          pids: ["888"],
          lsPid: "888",
          matchedByPort: true,
          established443: 1,
          synSent443: 0,
          proxyConns: 0,
          tunDetected: false,
          localIps: [],
          route: "direct",
          healthz: { reachable: true, instanceId: "e2e-follow" },
        }),
        notifyFn: () => {},
        disableSchedulers: true,
        writeServerInfo: false,
      });

      const port = await app.listen(0, "127.0.0.1");
      const uiHeaders = { "X-Sidecar-Token": "ui-tok-follow" };
      const postHeaders = {
        Origin: "plugin://agent-status-monitor",
        "Content-Type": "application/json",
        "X-Sidecar-Token": "ui-tok-follow",
      };

      try {
        const now = Date.now();
        await httpRequest(port, "POST", "/api/hook", {
          headers: { "Content-Type": "application/json", "X-Hook-Token": "hk-tok-follow" },
          body: {
            eventName: "Stop",
            receivedAt: now - 5000,
            payload: { conversationId: "conv-pinned-idle", terminationReason: "DONE" },
          },
        });
        await httpRequest(port, "POST", "/api/hook", {
          headers: { "Content-Type": "application/json", "X-Hook-Token": "hk-tok-follow" },
          body: {
            eventName: "PreInvocation",
            receivedAt: now,
            payload: { conversationId: "conv-active-other", invocationNum: 3 },
          },
        });

        const pinnedSnap = JSON.parse(
          (await httpRequest(port, "GET", "/api/status?conversationId=conv-pinned-idle", { headers: uiHeaders })).body,
        );
        assert.equal(pinnedSnap.activeConversationId, "conv-pinned-idle");
        assert.equal(pinnedSnap.verdict.code, "IDLE");
        assert.equal("recentConversations" in pinnedSnap, false);
        assert.equal(pinnedSnap.events.some((e) => e.conversationId === "conv-active-other"), false);
        assert.ok(pinnedSnap.events.some((e) => e.conversationId === "conv-pinned-idle"));

        // 传入 conversationId=auto 时禁止切换到其他活跃会话
        const autoSnap = JSON.parse(
          (await httpRequest(port, "GET", "/api/status?conversationId=auto", { headers: uiHeaders })).body,
        );
        assert.equal(autoSnap.activeConversationId, null);
        assert.equal(autoSnap.verdict.code, "IDLE");
        assert.equal("recentConversations" in autoSnap, false);
        assert.equal(autoSnap.events.length, 0);

        // 在 conv-active-other 开启模拟告警时，不得影响 conv-pinned-idle 的状态或事件流
        await httpRequest(port, "POST", "/api/simulate", {
          headers: postHeaders,
          body: { active: true, conversationId: "conv-active-other" },
        });
        const pinnedAfterOtherSim = JSON.parse(
          (await httpRequest(port, "GET", "/api/status?conversationId=conv-pinned-idle", { headers: uiHeaders })).body,
        );
        assert.equal(pinnedAfterOtherSim.verdict.code, "IDLE");
        assert.equal(pinnedAfterOtherSim.simulation.active, false);
        assert.equal(pinnedAfterOtherSim.events.some((e) => e.i18n?.key === "SIM_ON"), false);

        const otherSnap = JSON.parse(
          (await httpRequest(port, "GET", "/api/status?conversationId=conv-active-other", { headers: uiHeaders })).body,
        );
        assert.equal(otherSnap.verdict.code, "DISCONNECTED_HANG");
        assert.equal(otherSnap.simulation.active, true);
        assert.ok(otherSnap.events.some((e) => e.i18n?.key === "SIM_ON"));
        await httpRequest(port, "POST", "/api/simulate", {
          headers: postHeaders,
          body: { active: false, conversationId: "conv-active-other" },
        });

        // 模拟 6 个 SSE 客户端连接后突然断开，验证服务端零泄漏
        const sseReqs = await Promise.all(
          Array.from({ length: 6 }, () =>
            new Promise((resolve) => {
              const req = http.get(
                `http://127.0.0.1:${port}/api/events?conversationId=conv-pinned-idle&token=ui-tok-follow`,
                (res) => {
                  res.once("data", () => resolve(req));
                },
              );
            }),
          ),
        );
        assert.equal(app.getSseClientCount(), 6);
        for (const r of sseReqs) r.destroy();
        await new Promise((r) => setTimeout(r, 60));
        assert.equal(app.getSseClientCount(), 0);

        // 用模拟 Chromium 的 HTTP/1.1 6-socket 连接池执行 24 个并发轮询 + 预览告警切换 + 首页加载
        const poolAgent = new http.Agent({ keepAlive: true, maxSockets: 6 });
        const pooledReq = (method, path, headers = {}, body = null) =>
          new Promise((resolve, reject) => {
            const payload = body == null ? null : JSON.stringify(body);
            const h = { ...headers };
            if (payload != null) h["Content-Length"] = Buffer.byteLength(payload);
            const req = http.request(
              { hostname: "127.0.0.1", port, path, method, headers: h, agent: poolAgent },
              (res) => {
                let raw = "";
                res.setEncoding("utf8");
                res.on("data", (d) => (raw += d));
                res.on("end", () => resolve({ status: res.statusCode, body: raw }));
              },
            );
            req.on("error", reject);
            if (payload != null) req.write(payload);
            req.end();
          });

        try {
          const startedAt = Date.now();
          const batch = await Promise.all([
            ...Array.from({ length: 20 }, () => pooledReq("GET", "/api/status?conversationId=conv-pinned-idle", uiHeaders)),
            pooledReq("GET", "/"),
            pooledReq("POST", "/api/simulate", postHeaders, { active: true, conversationId: "conv-pinned-idle" }),
            pooledReq("GET", "/api/status?conversationId=conv-pinned-idle", uiHeaders),
            pooledReq("POST", "/api/simulate", postHeaders, { active: false, conversationId: "conv-pinned-idle" }),
          ]);
          const elapsed = Date.now() - startedAt;
          assert.ok(batch.every((r) => r.status === 200));
          assert.ok(elapsed < 3000, `Expected fast non-blocked responses, took ${elapsed}ms`);
          assert.equal(app.getSseClientCount(), 0);
        } finally {
          poolAgent.destroy();
        }
      } finally {
        await app.stop();
      }
    });
  });

  it("LS_DOWN 发送独立桌面通知而非 VPN 文案，且 alerts.log 持久化关键告警与恢复记录", async () => {
    await withTempDir(async (dir) => {
      const notifications = [];
      let lsUp = false;
      let netUp = true;

      const rtDir = join(dir, ".runtime");
      const cfgPath = join(rtDir, "config.json");
      const alertsLogPath = join(rtDir, "alerts.log");

      const app = await createStatusServer({
        configPath: cfgPath,
        serverInfoPath: join(rtDir, "server.json"),
        brainDirs: [join(dir, "brain")],
        fallbackHookPath: join(rtDir, "hook-state.json"),
        uiToken: "ui-tok-alerts",
        hookToken: "hk-tok-alerts",
        lsAddress: "",
        sdkBridgeImpl: {
          config: { conversationId: "conv-alerts" },
          getPreloadJs: () => "",
          isSdkReady: () => false,
          handleSidecarRoute: async () => ({ status: 404, data: {} }),
        },
        probePathsFn: async () => ({
          proxyConfig: null,
          direct: netUp
            ? { ok: true, statusCode: 404, latencyMs: 18, mode: "direct", error: null }
            : { ok: false, statusCode: null, latencyMs: 400, mode: "direct", error: "TIMEOUT" },
          proxy: null,
        }),
        inspectLsFn: async () => ({
          running: lsUp,
          pids: lsUp ? ["888"] : [],
          lsPid: lsUp ? "888" : null,
          matchedByPort: lsUp,
          established443: lsUp ? 1 : 0,
          synSent443: 0,
          proxyConns: 0,
          tunDetected: false,
          localIps: [],
          route: "direct",
          healthz: { reachable: lsUp, instanceId: lsUp ? "inst-alerts" : null },
        }),
        notifyFn: (title, message) => notifications.push({ title, message }),
        disableSchedulers: true,
        writeServerInfo: false,
      });

      const port = await app.listen(0, "127.0.0.1");
      const postHeaders = {
        Origin: "plugin://agent-status-monitor",
        "Content-Type": "application/json",
        "X-Sidecar-Token": "ui-tok-alerts",
      };

      try {
        await httpRequest(port, "POST", "/api/hook", {
          headers: { "Content-Type": "application/json", "X-Hook-Token": "hk-tok-alerts" },
          body: {
            eventName: "PreInvocation",
            receivedAt: Date.now(),
            payload: { conversationId: "conv-alerts", invocationNum: 1 },
          },
        });

        // 场景 1：网络正常但 LS 失联 -> 弹窗应提示 Language Server 失联而非 VPN 断开
        await app.runLsInspection();
        await httpRequest(port, "POST", "/api/probe", { headers: postHeaders, body: {} });
        assert.equal(notifications.length, 1);
        assert.match(notifications[0].title, /Language Server/);
        assert.equal(notifications[0].title.includes("VPN"), false);

        // 场景 1b：LS 恢复存活后，单次 /healthz 失败防抖不误报 LS_DOWN，连续 2 次才报
        lsUp = true;
        await app.runLsInspection();
        await httpRequest(port, "POST", "/api/probe", { headers: postHeaders, body: {} });
        const aliveOnlyFailApp = await createStatusServer({
          configPath: join(dir, "cfg-hz.json"),
          serverInfoPath: join(dir, "srv-hz.json"),
          brainDirs: [join(dir, "brain")],
          fallbackHookPath: join(dir, "fb-hz.json"),
          uiToken: "ui-hz",
          hookToken: "hk-hz",
          lsAddress: "",
          sdkBridgeImpl: { config: { conversationId: "conv-hz" }, getPreloadJs: () => "", isSdkReady: () => false, handleSidecarRoute: async () => ({ status: 404, data: {} }) },
          probePathsFn: async () => ({ proxyConfig: null, direct: { ok: true, statusCode: 404, latencyMs: 12, mode: "direct", error: null }, proxy: null }),
          inspectLsFn: async () => ({ running: true, pids: ["99"], lsPid: "99", matchedByPort: true, established443: 1, synSent443: 0, proxyConns: 0, tunDetected: false, localIps: [], route: "direct", healthz: { reachable: false, instanceId: null } }),
          notifyFn: () => { throw new Error("should not notify after 1 healthz failure"); },
          disableSchedulers: true,
          writeServerInfo: false,
        });
        const portHz = await aliveOnlyFailApp.listen(0, "127.0.0.1");
        try {
          aliveOnlyFailApp.store.applyHookEvent({ eventName: "PreInvocation", receivedAt: Date.now(), payload: { conversationId: "conv-hz" } });
          await aliveOnlyFailApp.runLsInspection();
          const st1 = JSON.parse((await httpRequest(portHz, "GET", "/api/status?conversationId=conv-hz", { headers: { "X-Sidecar-Token": "ui-hz" } })).body);
          assert.equal(st1.verdict.code, "WAITING_LLM");
          await aliveOnlyFailApp.runLsInspection();
          const st2 = JSON.parse((await httpRequest(portHz, "GET", "/api/status?conversationId=conv-hz", { headers: { "X-Sidecar-Token": "ui-hz" } })).body);
          assert.equal(st2.verdict.code, "DISCONNECTED_HANG");
          assert.equal(st2.verdict.messageKey, "LS_DOWN");
        } finally {
          await aliveOnlyFailApp.stop();
        }

        // 场景 2：纯 TIMEOUT 连续 2 次先进入 NET_SUSPECT 复测，第 3 次确认 DISCONNECTED_HANG（60s 冷却期内不重复弹窗）并带 convId/message 落盘 alerts.log
        netUp = false;
        await httpRequest(port, "POST", "/api/probe", { headers: postHeaders, body: {} });
        await httpRequest(port, "POST", "/api/probe", { headers: postHeaders, body: {} });
        const afterTwoTimeouts = readFileSync(alertsLogPath, "utf8")
          .trim()
          .split(/\r?\n/)
          .map((line) => JSON.parse(line));
        assert.equal(afterTwoTimeouts.some((e) => e.reason === "NET_DOWN_HANG"), false);
        await httpRequest(port, "POST", "/api/probe", { headers: postHeaders, body: {} });
        assert.equal(notifications.length, 1);
        netUp = true;
        await httpRequest(port, "POST", "/api/probe", { headers: postHeaders, body: {} });

        assert.equal(existsSync(alertsLogPath), true);
        const entries = readFileSync(alertsLogPath, "utf8")
          .trim()
          .split(/\r?\n/)
          .map((line) => JSON.parse(line));
        assert.ok(entries.some((e) => e.type === "DISCONNECTED_HANG" && e.reason === "LS_DOWN" && e.notified === true && e.convId === "conv-alerts" && Boolean(e.message)));
        assert.ok(entries.some((e) => e.type === "NET_FAILED" && e.error === "TIMEOUT" && e.convId === "conv-alerts"));
        assert.ok(entries.some((e) => e.type === "DISCONNECTED_HANG" && e.reason === "NET_DOWN_HANG" && e.convId === "conv-alerts" && Boolean(e.message)));
        assert.ok(entries.some((e) => e.type === "NET_RECOVERED" && e.latencyMs === 18 && e.convId === "conv-alerts"));
      } finally {
        await app.stop();
      }
    });
  });

  it("多钉选会话下后台对话挂起仍触发通知并在 alerts.log 记录对应后台 convId", async () => {
    await withTempDir(async (dir) => {
      const notifications = [];
      const rtDir = join(dir, ".runtime");
      const alertsLogPath = join(rtDir, "alerts.log");
      const app = await createStatusServer({
        configPath: join(rtDir, "config.json"),
        serverInfoPath: join(rtDir, "server.json"),
        brainDirs: [join(dir, "brain")],
        fallbackHookPath: join(rtDir, "hook-state.json"),
        uiToken: "ui-pin",
        hookToken: "hk-pin",
        lsAddress: "",
        sdkBridgeImpl: { config: { conversationId: "conv-front-idle" }, getPreloadJs: () => "", isSdkReady: () => false, handleSidecarRoute: async () => ({ status: 404, data: {} }) },
        probePathsFn: async () => ({ proxyConfig: null, direct: { ok: false, statusCode: null, latencyMs: 100, mode: "direct", error: "ENOTFOUND" }, proxy: null }),
        inspectLsFn: async () => ({ running: true, pids: ["10"], lsPid: "10", matchedByPort: true, established443: 1, synSent443: 0, proxyConns: 0, tunDetected: false, localIps: [], route: "direct", healthz: { reachable: true, instanceId: "p" } }),
        notifyFn: (title, message) => notifications.push({ title, message }),
        disableSchedulers: true,
        writeServerInfo: false,
      });
      await app.listen(0, "127.0.0.1");
      try {
        await app.runLsInspection();
        app.store.applyHookEvent({ eventName: "Stop", receivedAt: Date.now() - 1000, payload: { conversationId: "conv-front-idle", terminationReason: "DONE" } });
        app.store.applyHookEvent({ eventName: "PreInvocation", receivedAt: Date.now(), payload: { conversationId: "conv-bg-busy", invocationNum: 1 } });
        // 触发对 conv-bg-busy 的状态查询，使 sseHub 记录到它
        await app.runProbeOnce();
        // 先调用 GET /api/status?conversationId=conv-bg-busy 模拟后台标签或近期窗口
        const port = app.server.address().port;
        await httpRequest(port, "GET", "/api/status?conversationId=conv-bg-busy", { headers: { "X-Sidecar-Token": "ui-pin" } });
        await app.runProbeOnce();
        assert.equal(notifications.length, 1);
        const entries = readFileSync(alertsLogPath, "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
        assert.ok(entries.some((e) => e.type === "DISCONNECTED_HANG" && e.convId === "conv-bg-busy"));
      } finally {
        await app.stop();
      }
    });
  });
});
