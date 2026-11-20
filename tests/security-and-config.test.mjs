import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createAlertLogger } from "../sidecars/status-monitor/lib/alert-logger.mjs";
import {
  applyConfigPatch,
  DEFAULT_CONFIG,
  DEFAULT_PROBE_URL,
  detectDefaultLang,
  loadConfig,
  parseLocaleLang,
  resolveAlertLogPath,
  resolveBrainDirs,
  sanitizeConfigForClient,
} from "../sidecars/status-monitor/lib/config.mjs";
import { getNotificationText } from "../sidecars/status-monitor/lib/i18n.mjs";
import { sendDesktopNotification } from "../sidecars/status-monitor/lib/notify.mjs";
import {
  createSecurityGuard,
  isAllowedHost,
  isAllowedOrigin,
  isJsonContentType,
} from "../sidecars/status-monitor/lib/security.mjs";
import { withTempDir } from "./helpers.mjs";

describe("security（CSRF 防护与双令牌鉴权）", () => {
  const probeUrl = new URL("http://127.0.0.1:57608/api/probe");

  it("严格识别 application/json 与允许的本地/插件 Origin", () => {
    assert.equal(isJsonContentType({ headers: { "content-type": "application/json" } }), true);
    assert.equal(
      isJsonContentType({ headers: { "content-type": "application/json; charset=utf-8" } }),
      true,
    );
    assert.equal(isJsonContentType({ headers: { "content-type": "text/plain" } }), false);

    assert.equal(isAllowedOrigin({ headers: { origin: "http://127.0.0.1:57608" } }), true);
    assert.equal(isAllowedOrigin({ headers: { origin: "http://localhost:3000" } }), true);
    assert.equal(isAllowedOrigin({ headers: { origin: "plugin://agent-status-monitor" } }), true);
    assert.equal(isAllowedOrigin({ headers: { origin: "vscode-webview://abc" } }), true);
    assert.equal(isAllowedOrigin({ headers: {} }), true);
    assert.equal(isAllowedOrigin({ headers: { origin: "null" } }), false);
    assert.equal(isAllowedOrigin({ headers: { origin: "https://evil.example" } }), false);
  });

  it("verifyUiPost 按 Origin -> Content-Type -> X-Sidecar-Token 顺序拦截非法请求", () => {
    const guard = createSecurityGuard({ uiToken: "ui-tok-1", hookToken: "hook-tok-1" });

    assert.equal(
      guard.verifyUiPost(
        { headers: { origin: "https://evil.example", "content-type": "application/json", "x-sidecar-token": "ui-tok-1" } },
        probeUrl,
      ).status,
      403,
    );
    assert.equal(
      guard.verifyUiPost(
        { headers: { origin: "http://127.0.0.1:57608", "content-type": "text/plain", "x-sidecar-token": "ui-tok-1" } },
        probeUrl,
      ).status,
      415,
    );
    assert.equal(
      guard.verifyUiPost(
        { headers: { origin: "plugin://agent-status-monitor", "content-type": "application/json" } },
        probeUrl,
      ).status,
      401,
    );
    assert.equal(
      guard.verifyUiPost(
        {
          headers: {
            origin: "plugin://agent-status-monitor",
            "content-type": "application/json",
            "x-sidecar-token": "ui-tok-1",
          },
        },
        probeUrl,
      ).ok,
      true,
    );
    assert.equal(
      guard.verifyUiPost(
        { headers: { "content-type": "application/json" } },
        new URL("http://127.0.0.1:57608/api/probe?token=ui-tok-1"),
      ).ok,
      true,
    );
  });

  it("verifyHookPost 独立校验 X-Hook-Token，防止 UI 令牌与 Hook 令牌混用", () => {
    const guard = createSecurityGuard({ uiToken: "ui-tok-1", hookToken: "hook-tok-1" });

    assert.equal(
      guard.verifyHookPost({ headers: { "content-type": "application/json", "x-hook-token": "ui-tok-1" } }).status,
      401,
    );
    assert.equal(
      guard.verifyHookPost({ headers: { "content-type": "application/json", "x-hook-token": "hook-tok-1" } }).ok,
      true,
    );
  });

  it("isAllowedHost 仅放行回环地址并在未传 uiToken 时默认生成随机令牌且校验 GET / POST", () => {
    assert.equal(isAllowedHost({ headers: { host: "127.0.0.1:57608" } }), true);
    assert.equal(isAllowedHost({ headers: { host: "localhost:3000" } }), true);
    assert.equal(isAllowedHost({ headers: { host: "[::1]:8080" } }), true);
    assert.equal(isAllowedHost({ headers: { host: "evil.example:57608" } }), false);
    assert.equal(isAllowedHost({ headers: { host: "127.0.0.1.evil.example" } }), false);
    assert.equal(isAllowedHost({ headers: { host: "evil.localhost:57608" } }), false);
    assert.equal(isAllowedHost({ headers: { host: "127.0.0.1:0" } }), false);
    assert.equal(isAllowedHost({ headers: { host: "127.0.0.1:70000" } }), false);
    assert.equal(isAllowedHost({ headers: {} }), false);

    const prevEnvTok = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
    delete process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
    try {
      const defaultGuard = createSecurityGuard();
      assert.equal(defaultGuard.hasUiToken, true);
      assert.match(defaultGuard.uiToken, /^[0-9a-f]{48}$/);

      const statusUrl = new URL("http://127.0.0.1:57608/api/status");
      assert.equal(defaultGuard.verifyUiGet({ headers: { host: "evil.example:57608" } }, statusUrl).status, 403);
      assert.equal(
        defaultGuard.verifyUiGet(
          {
            headers: {
              host: "127.0.0.1:57608",
              "sec-fetch-site": "cross-site",
              "x-sidecar-token": defaultGuard.uiToken,
            },
          },
          statusUrl,
        ).status,
        403,
      );
      assert.equal(
        defaultGuard.verifyUiGet(
          { headers: { host: "127.0.0.1:57608", origin: "https://evil.example", "x-sidecar-token": defaultGuard.uiToken } },
          statusUrl,
        ).status,
        403,
      );
      assert.equal(defaultGuard.verifyUiGet({ headers: { host: "127.0.0.1:57608" } }, statusUrl).status, 401);
      assert.equal(
        defaultGuard.verifyUiGet(
          { headers: { host: "127.0.0.1:57608", "sec-fetch-site": "same-origin", "x-sidecar-token": defaultGuard.uiToken } },
          statusUrl,
        ).ok,
        true,
      );
      assert.equal(
        defaultGuard.verifyUiGet(
          { headers: { host: "127.0.0.1:57608" } },
          new URL(`http://127.0.0.1:57608/api/events?token=${defaultGuard.uiToken}`),
        ).ok,
        true,
      );
      assert.equal(
        defaultGuard.verifyUiPost({ headers: { host: "127.0.0.1:57608", "content-type": "application/json" } }, probeUrl)
          .status,
        401,
      );
      assert.equal(
        defaultGuard.verifyUiPost(
          { headers: { host: "evil.example:57608", "content-type": "application/json", "x-sidecar-token": defaultGuard.uiToken } },
          probeUrl,
        ).status,
        403,
      );
    } finally {
      if (prevEnvTok !== undefined) process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = prevEnvTok;
    }
  });
});

describe("config（配置加载、边界限制与旧探测地址自动迁移）", () => {
  it("自动将旧版 gstatic.com 探测地址迁移为 DEFAULT_PROBE_URL，并将未迁移的默认 2500ms 超时平滑升至 4000ms", async () => {
    await withTempDir(async (dir) => {
      const cfgPath = join(dir, "config.json");
      writeFileSync(
        cfgPath,
        JSON.stringify({ probeUrl: "https://www.gstatic.com/generate_204", timeoutMs: 2500 }),
        "utf8",
      );

      assert.equal(DEFAULT_CONFIG.timeoutMs, 4000);
      assert.equal(DEFAULT_CONFIG.timeoutMigratedV3, true);

      const loaded = loadConfig(cfgPath);
      assert.equal(loaded.probeUrl, DEFAULT_PROBE_URL);
      assert.equal(loaded.probeUrlMigratedV2, true);
      assert.equal(loaded.timeoutMs, 4000);
      assert.equal(loaded.timeoutMigratedV3, true);

      // 用户已迁移后显式设定为 2500ms 时，不应再次覆盖
      const customPath = join(dir, "custom-timeout.json");
      writeFileSync(
        customPath,
        JSON.stringify({ timeoutMs: 2500, timeoutMigratedV3: true, probeUrlMigratedV2: true }),
        "utf8",
      );
      assert.equal(loadConfig(customPath).timeoutMs, 2500);
    });
  });

  it("applyConfigPatch 对数值越界与非法 URL/Theme 进行安全钳位和过滤", async () => {
    await withTempDir(async (dir) => {
      const cfgPath = join(dir, "config.json");
      const cfg = { ...DEFAULT_CONFIG };
      applyConfigPatch(
        cfg,
        {
          intervalMs: 100,
          timeoutMs: 999999,
          stallThresholdSec: 2,
          probeUrl: "http://insecure.example",
          notifyOnDisconnect: false,
          theme: "invalid-theme",
        },
        { configPath: cfgPath },
      );

      assert.equal(cfg.intervalMs, 1000);
      assert.equal(cfg.timeoutMs, 10000);
      assert.equal(cfg.stallThresholdSec, 5);
      assert.equal(cfg.probeUrl, DEFAULT_PROBE_URL);
      assert.equal(cfg.notifyOnDisconnect, false);
      assert.equal(cfg.theme, "auto");

      const reloaded = loadConfig(cfgPath);
      assert.equal(reloaded.intervalMs, 1000);
      assert.equal(reloaded.notifyOnDisconnect, false);
      assert.equal(reloaded.lang, DEFAULT_CONFIG.lang);

      applyConfigPatch(cfg, { lang: "en" }, { configPath: cfgPath });
      assert.equal(loadConfig(cfgPath).lang, "en");

      applyConfigPatch(cfg, { lang: "fr" }, { configPath: cfgPath });
      assert.equal(loadConfig(cfgPath).lang, "en");

      applyConfigPatch(cfg, { manualProxyUrl: "socks5://127.0.0.1:1080" }, { configPath: cfgPath });
      assert.equal(loadConfig(cfgPath).manualProxyUrl, "socks5://127.0.0.1:1080");

      applyConfigPatch(cfg, { manualProxyUrl: "invalid://bad" }, { configPath: cfgPath });
      assert.equal(loadConfig(cfgPath).manualProxyUrl, "socks5://127.0.0.1:1080");

      applyConfigPatch(cfg, { manualProxyUrl: "http://alice:pw@127.0.0.1:7897" }, { configPath: cfgPath });
      assert.equal(sanitizeConfigForClient(cfg).manualProxyUrl, "http://***@127.0.0.1:7897");

      applyConfigPatch(cfg, { manualProxyUrl: "" }, { configPath: cfgPath });
      assert.equal(loadConfig(cfgPath).manualProxyUrl, "");
    });
  });

  it("loadConfig 自动修复损坏数值/URL，strict 模式拒绝非法配置而不落盘 NaN/null", async () => {
    await withTempDir(async (dir) => {
      const cfgPath = join(dir, "config.json");
      writeFileSync(
        cfgPath,
        JSON.stringify({
          intervalMs: null,
          timeoutMs: "NaN",
          stallThresholdSec: null,
          probeUrl: "https://not a url",
          manualProxyUrl: "socks4://127.0.0.1:1080",
          probeUrlMigratedV2: true,
        }),
        "utf8",
      );

      const healed = loadConfig(cfgPath);
      assert.equal(healed.intervalMs, DEFAULT_CONFIG.intervalMs);
      assert.equal(healed.timeoutMs, DEFAULT_CONFIG.timeoutMs);
      assert.equal(healed.stallThresholdSec, DEFAULT_CONFIG.stallThresholdSec);
      assert.equal(healed.probeUrl, DEFAULT_PROBE_URL);
      assert.equal(healed.manualProxyUrl, "");

      applyConfigPatch(healed, { intervalMs: "not-a-number", probeUrl: "https://not a url" }, { configPath: cfgPath });
      assert.equal(healed.intervalMs, DEFAULT_CONFIG.intervalMs);
      assert.equal(healed.probeUrl, DEFAULT_PROBE_URL);

      for (const badPatch of [
        { intervalMs: "not-a-number" },
        { probeUrl: "https://not a url" },
        { manualProxyUrl: "127.0.0.1" },
        { manualProxyUrl: "https://127.0.0.1:7897" },
        { manualProxyUrl: "socks4://127.0.0.1:1080" },
        { manualProxyUrl: "socks5://alice:pw@127.0.0.1:1080" },
      ]) {
        assert.throws(
          () => applyConfigPatch(healed, badPatch, { configPath: cfgPath, strict: true }),
          (err) => err?.status === 400 && Boolean(err?.code),
        );
      }
      assert.equal(healed.manualProxyUrl, "");
    });
  });

  it("按系统/环境变量自动识别默认语言（中文环境 zh，非中文环境 en），且显式配置优先", async () => {
    assert.equal(parseLocaleLang("zh_CN.UTF-8"), "zh");
    assert.equal(parseLocaleLang("zh-Hant-TW"), "zh");
    assert.equal(parseLocaleLang("en_US.UTF-8"), "en");
    assert.equal(parseLocaleLang("ja_JP.UTF-8"), "en");
    assert.equal(parseLocaleLang("C.UTF-8"), "en");
    assert.equal(parseLocaleLang("POSIX"), "en");
    assert.equal(parseLocaleLang(""), null);

    assert.equal(detectDefaultLang({ env: { LC_ALL: "en_US.UTF-8" }, intlLocale: "zh-CN" }), "en");
    assert.equal(detectDefaultLang({ env: { LANG: "zh_CN.UTF-8" }, intlLocale: "en-US" }), "zh");
    assert.equal(detectDefaultLang({ env: {}, intlLocale: "en-US" }), "en");
    assert.equal(detectDefaultLang({ env: {}, intlLocale: "zh-CN" }), "zh");

    await withTempDir(async (dir) => {
      const prevAsmLang = process.env.ASM_DEFAULT_LANG;
      const missingCfg = join(dir, "missing.json");
      try {
        process.env.ASM_DEFAULT_LANG = "en_US";
        assert.equal(loadConfig(missingCfg).lang, "en");

        process.env.ASM_DEFAULT_LANG = "zh_CN";
        assert.equal(loadConfig(missingCfg).lang, "zh");

        const explicitCfg = join(dir, "explicit.json");
        writeFileSync(explicitCfg, JSON.stringify({ lang: "en" }), "utf8");
        assert.equal(loadConfig(explicitCfg).lang, "en");
      } finally {
        if (prevAsmLang === undefined) delete process.env.ASM_DEFAULT_LANG;
        else process.env.ASM_DEFAULT_LANG = prevAsmLang;
      }
    });
  });

  it("resolveBrainDirs 环境变量隔离、LS_DOWN 通知文案分离与 alert-logger 有界滚动", async () => {
    await withTempDir(async (dir) => {
      const customAppData = join(dir, "isolated-app");
      assert.deepEqual(
        resolveBrainDirs({ env: { ANTIGRAVITY_APP_DATA_DIR: customAppData }, home: dir }),
        [join(customAppData, "brain")],
      );

      const fallbackDirs = resolveBrainDirs({ env: {}, home: dir });
      assert.equal(fallbackDirs.length, 3);
      assert.ok(fallbackDirs.includes(join(dir, ".gemini", "antigravity", "brain")));

      assert.equal(resolveAlertLogPath(join(dir, ".runtime", "config.json")), join(dir, ".runtime", "alerts.log"));

      // 兼容旧 boolean 参数与新对象参数，并严格区分 LS_DOWN 与 VPN 断网文案
      assert.match(getNotificationText(false, "zh").title, /VPN/);
      assert.match(getNotificationText(true, "en").title, /Preview/);
      const lsZh = getNotificationText({ simulated: false, messageKey: "LS_DOWN" }, "zh");
      assert.match(lsZh.title, /Language Server/);
      assert.equal(lsZh.title.includes("VPN"), false);
      const lsEn = getNotificationText({ simulated: false, messageKey: "LS_DOWN" }, "en");
      assert.match(lsEn.title, /Language Server Unreachable/);

      // ASM_DISABLE_NOTIFICATIONS=1 时可直接调用 sendDesktopNotification 而不弹窗/抛错
      const prevDisable = process.env.ASM_DISABLE_NOTIFICATIONS;
      process.env.ASM_DISABLE_NOTIFICATIONS = "1";
      try {
        assert.doesNotThrow(() => sendDesktopNotification("Test Title", "Test Body"));
      } finally {
        if (prevDisable === undefined) delete process.env.ASM_DISABLE_NOTIFICATIONS;
        else process.env.ASM_DISABLE_NOTIFICATIONS = prevDisable;
      }

      // alert-logger 追加写入与按 maxBytes/keepLines 有界裁剪
      const logPath = join(dir, ".runtime", "alerts.log");
      const logger = createAlertLogger({ logPath, maxBytes: 320, keepLines: 3 });
      for (let i = 0; i < 10; i++) {
        logger.append({ type: "DISCONNECTED_HANG", reason: `R_${i}`, convId: `c-${i}` });
      }
      assert.equal(existsSync(logPath), true);
      const recent = logger.readRecent(10);
      assert.equal(recent.length, 3);
      assert.equal(recent[0].reason, "R_7");
      assert.equal(recent[2].reason, "R_9");
      assert.ok(homedir().length > 0);
    });
  });
});
