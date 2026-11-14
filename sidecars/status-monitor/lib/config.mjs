import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateProxyInput } from "./proxy.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIDECAR_DIR = resolve(__dirname, "..");

export const PLUGIN_ROOT = resolve(SIDECAR_DIR, "../..");
export const RUNTIME_DIR = process.env.ASM_RUNTIME_DIR || join(PLUGIN_ROOT, ".runtime");
export const SERVER_INFO_PATH = join(RUNTIME_DIR, "server.json");
export const FALLBACK_HOOK_PATH = join(RUNTIME_DIR, "hook-state.json");
export const CONFIG_PATH = join(RUNTIME_DIR, "config.json");
export const PUBLIC_DIR = join(SIDECAR_DIR, "public");

export const LS_ADDRESS = process.env.ANTIGRAVITY_LS_ADDRESS || "";
const APP_DATA_DIR =
  process.env.ANTIGRAVITY_APP_DATA_DIR || join(homedir(), ".gemini", "antigravity");

export const BRAIN_DIRS = [
  ...new Set([
    join(APP_DATA_DIR, "brain"),
    join(homedir(), ".gemini", "antigravity", "brain"),
    join(homedir(), ".gemini", "antigravity-ide", "brain"),
    join(homedir(), ".gemini", "antigravity-cli", "brain"),
  ]),
];

export const DEFAULT_PROBE_URL = "https://daily-cloudcode-pa.googleapis.com";

/**
 * 将 POSIX / BCP-47 区域标识归一化为插件支持的语言代码。
 */
export function parseLocaleLang(rawLocale) {
  const normalized = String(rawLocale || "").trim().toLowerCase();
  if (!normalized) return null;
  if (
    normalized === "c" ||
    normalized === "posix" ||
    normalized.startsWith("c.") ||
    normalized.startsWith("posix.")
  ) {
    return "en";
  }
  return normalized.startsWith("zh") ? "zh" : "en";
}

/**
 * 依据环境变量与系统 ICU 区域设置推导首次启动的默认界面语言（非中文系统回退 en）。
 */
export function detectDefaultLang({ env = process.env, intlLocale = "" } = {}) {
  for (const key of ["ASM_DEFAULT_LANG", "LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"]) {
    const val = env?.[key];
    if (val) {
      const first = String(val).split(":")[0];
      const parsed = parseLocaleLang(first);
      if (parsed) return parsed;
    }
  }
  try {
    const resolved = intlLocale || Intl.DateTimeFormat().resolvedOptions().locale || "";
    const parsed = parseLocaleLang(resolved);
    if (parsed) return parsed;
  } catch {
  }
  return "en";
}

export const DEFAULT_CONFIG = {
  intervalMs: 3000,
  timeoutMs: 2500,
  stallThresholdSec: 25,
  probeUrl: DEFAULT_PROBE_URL,
  probeUrlMigratedV2: true,
  manualProxyUrl: "",
  notifyOnDisconnect: true,
  theme: "auto",
  lang: detectDefaultLang(),
};

export function ensureRuntimeDir() {
  mkdirSync(RUNTIME_DIR, { recursive: true });
}

function saveConfig(cfg, configPath = CONFIG_PATH) {
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf8");
  } catch {
  }
}

function clampFiniteNumber(val, min, max) {
  if (typeof val === "number") {
    return Number.isFinite(val) ? Math.min(max, Math.max(min, Math.round(val))) : null;
  }
  if (typeof val === "string" && val.trim() !== "") {
    const n = Number(val);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : null;
  }
  return null;
}

function validateHttpsProbeUrl(raw) {
  if (typeof raw !== "string") return { ok: false, errorCode: "INVALID_PROBE_URL", detail: "探测目标必须是合法的 https:// URL" };
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return { ok: false, errorCode: "INVALID_PROBE_URL", detail: "探测目标不能包含空白且必须是合法的 https:// URL" };
  }
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "https:" || !u.hostname) {
      return { ok: false, errorCode: "INVALID_PROBE_URL", detail: "探测目标仅支持合法的 https:// URL" };
    }
    return { ok: true, value: trimmed };
  } catch {
    return { ok: false, errorCode: "INVALID_PROBE_URL", detail: "探测目标 URL 格式无效，请检查后重试" };
  }
}

function createConfigError(code, detail) {
  const err = new Error(detail);
  err.status = 400;
  err.code = code;
  return err;
}

export function loadConfig(configPath = CONFIG_PATH) {
  const fallbackLang = detectDefaultLang();
  try {
    if (existsSync(configPath)) {
      const saved = JSON.parse(readFileSync(configPath, "utf8"));
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
        return { ...DEFAULT_CONFIG, lang: fallbackLang };
      }
      const intervalMs = clampFiniteNumber(saved.intervalMs, 1000, 30000) ?? DEFAULT_CONFIG.intervalMs;
      const timeoutMs = clampFiniteNumber(saved.timeoutMs, 800, 10000) ?? DEFAULT_CONFIG.timeoutMs;
      const stallThresholdSec = clampFiniteNumber(saved.stallThresholdSec, 5, 300) ?? DEFAULT_CONFIG.stallThresholdSec;
      const probeCheck = validateHttpsProbeUrl(saved.probeUrl);
      const proxyCheck = typeof saved.manualProxyUrl === "string"
        ? validateProxyInput(saved.manualProxyUrl)
        : { ok: false };
      const merged = {
        ...DEFAULT_CONFIG,
        intervalMs,
        timeoutMs,
        stallThresholdSec,
        probeUrl: probeCheck.ok ? probeCheck.value : DEFAULT_PROBE_URL,
        probeUrlMigratedV2: Boolean(saved.probeUrlMigratedV2),
        manualProxyUrl: proxyCheck.ok && !proxyCheck.maskedPlaceholder ? proxyCheck.value : "",
        notifyOnDisconnect: typeof saved.notifyOnDisconnect === "boolean"
          ? saved.notifyOnDisconnect
          : DEFAULT_CONFIG.notifyOnDisconnect,
        theme: ["auto", "dark", "light"].includes(saved.theme) ? saved.theme : DEFAULT_CONFIG.theme,
        lang: ["zh", "en"].includes(saved.lang) ? saved.lang : fallbackLang,
      };
      let dirty =
        merged.intervalMs !== saved.intervalMs ||
        merged.timeoutMs !== saved.timeoutMs ||
        merged.stallThresholdSec !== saved.stallThresholdSec ||
        merged.probeUrl !== saved.probeUrl ||
        merged.manualProxyUrl !== (saved.manualProxyUrl ?? "");
      if (
        !saved.probeUrlMigratedV2 &&
        (!saved.probeUrl || saved.probeUrl === "https://www.gstatic.com/generate_204")
      ) {
        merged.probeUrl = DEFAULT_PROBE_URL;
        merged.probeUrlMigratedV2 = true;
        dirty = true;
      }
      if (dirty) {
        saveConfig(merged, configPath);
      }
      return merged;
    }
  } catch {
  }
  return { ...DEFAULT_CONFIG, lang: fallbackLang };
}

function maskManualProxyUrl(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  try {
    const normalized = trimmed.includes("://") ? trimmed : `http://${trimmed}`;
    const u = new URL(normalized);
    if (!u.username && !u.password) return trimmed;
    u.username = "***";
    u.password = "";
    const masked = u.toString();
    return masked.endsWith("/") && !trimmed.endsWith("/") ? masked.slice(0, -1) : masked;
  } catch {
    return trimmed;
  }
}

export function sanitizeConfigForClient(config) {
  return {
    ...config,
    manualProxyUrl: maskManualProxyUrl(config?.manualProxyUrl),
  };
}

export function applyConfigPatch(config, patch, { configPath = CONFIG_PATH, strict = false } = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    if (strict) throw createConfigError("INVALID_CONFIG", "配置请求必须是 JSON 对象");
    return config;
  }

  const next = {};

  if (patch.intervalMs !== undefined) {
    if (patch.intervalMs !== null) {
      const n = clampFiniteNumber(patch.intervalMs, 1000, 30000);
      if (n !== null) next.intervalMs = n;
      else if (strict) throw createConfigError("INVALID_INTERVAL", "探测间隔必须是有效数字");
    } else if (strict) {
      throw createConfigError("INVALID_INTERVAL", "探测间隔不能为空");
    }
  }

  if (patch.timeoutMs !== undefined) {
    if (patch.timeoutMs !== null) {
      const n = clampFiniteNumber(patch.timeoutMs, 800, 10000);
      if (n !== null) next.timeoutMs = n;
      else if (strict) throw createConfigError("INVALID_TIMEOUT", "超时时间必须是有效数字");
    } else if (strict) {
      throw createConfigError("INVALID_TIMEOUT", "超时时间不能为空");
    }
  }

  if (patch.stallThresholdSec !== undefined) {
    if (patch.stallThresholdSec !== null) {
      const n = clampFiniteNumber(patch.stallThresholdSec, 5, 300);
      if (n !== null) next.stallThresholdSec = n;
      else if (strict) throw createConfigError("INVALID_STALL_THRESHOLD", "卡顿阈值必须是有效数字");
    } else if (strict) {
      throw createConfigError("INVALID_STALL_THRESHOLD", "卡顿阈值不能为空");
    }
  }

  if (patch.probeUrl !== undefined) {
    const res = validateHttpsProbeUrl(patch.probeUrl);
    if (res.ok) {
      next.probeUrl = res.value;
      next.probeUrlMigratedV2 = true;
    } else if (strict) {
      throw createConfigError(res.errorCode, res.detail);
    }
  }

  if (patch.manualProxyUrl !== undefined) {
    if (typeof patch.manualProxyUrl !== "string") {
      if (strict) throw createConfigError("INVALID_PROXY_URL", "手动代理地址必须是字符串");
    } else {
      const res = validateProxyInput(patch.manualProxyUrl);
      if (!res.ok) {
        if (strict) throw createConfigError(res.errorCode, res.detail);
      } else if (!res.maskedPlaceholder) {
        next.manualProxyUrl = res.value;
      }
    }
  }

  if (patch.notifyOnDisconnect !== undefined) {
    if (typeof patch.notifyOnDisconnect === "boolean") {
      next.notifyOnDisconnect = patch.notifyOnDisconnect;
    } else if (strict) {
      throw createConfigError("INVALID_NOTIFY_FLAG", "桌面通知开关必须是布尔值");
    }
  }

  if (patch.theme !== undefined) {
    if (["auto", "dark", "light"].includes(patch.theme)) {
      next.theme = patch.theme;
    } else if (strict) {
      throw createConfigError("INVALID_THEME", "不支持的主题选项");
    }
  }

  if (patch.lang !== undefined) {
    if (["zh", "en"].includes(patch.lang)) {
      next.lang = patch.lang;
    } else if (strict) {
      throw createConfigError("INVALID_LANG", "不支持的语言选项");
    }
  }

  Object.assign(config, next);
  saveConfig(config, configPath);
  return config;
}
