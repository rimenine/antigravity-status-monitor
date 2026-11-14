import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
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
        assert.match(htmlRes.body, /id="btnSim"/);

        const jsRes = await httpRequest(port, "GET", "/app.js");
        assert.equal(jsRes.status, 200);
        assert.match(jsRes.body, /new EventSource/);

        const statusRes = await httpRequest(port, "GET", "/api/status?conversationId=conv-e2e");
        assert.equal(statusRes.status, 200);
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

        const afterHook = JSON.parse((await httpRequest(port, "GET", "/api/status?conversationId=conv-e2e")).body);
        assert.equal(afterHook.hook.phase, "waiting_llm");
        assert.equal(afterHook.verdict.code, "WAITING_LLM");

        const ssePromise = readFirstTwoSseEvents(port, "/api/events?conversationId=conv-e2e");
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

        const pacStatus = JSON.parse((await httpRequest(port, "GET", "/api/status")).body);
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

        const maskedStatus = await httpRequest(port, "GET", "/api/status");
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
        assert.equal(notifications.length, 2);
      } finally {
        await app.stop();
      }
    });
  });
});
