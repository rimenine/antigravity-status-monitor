import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

let proxyCache = { checkedAt: 0, proxy: null };

export function invalidateProxyCache() {
  proxyCache = { checkedAt: 0, proxy: null };
}

export function normalizeIp(host) {
  return String(host || "")
    .replace(/^\[|\]$/g, "")
    .replace(/^::ffff:/i, "");
}

export function splitHostPort(addr) {
  const raw = String(addr || "");
  const idx = raw.lastIndexOf(":");
  return idx === -1 ? [raw, ""] : [raw.slice(0, idx), raw.slice(idx + 1)];
}

function attachNonEnumerable(target, key, value) {
  // authHeader 与 bypassList 设为不可枚举属性，防止配置序列化或日志打印时意外泄露代理凭据
  Object.defineProperty(target, key, {
    value,
    enumerable: false,
    configurable: true,
  });
  return target;
}

export function validateProxyInput(raw, { requireExplicitPort = true } = {}) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) {
    return { ok: true, value: "", proxy: null };
  }
  if (trimmed.includes("://***@") || trimmed.startsWith("***@")) {
    return { ok: true, value: trimmed, proxy: null, maskedPlaceholder: true };
  }
  const hasScheme = trimmed.includes("://");
  let normalized = trimmed;
  if (!hasScheme) {
    const colonCount = (normalized.match(/:/g) || []).length;
    if (colonCount > 1 && !normalized.startsWith("[") && !normalized.includes("@")) {
      return {
        ok: false,
        errorCode: "INVALID_PROXY_PORT",
        detail: "IPv6 代理地址请使用 [::1]:端口 格式并包含端口",
      };
    }
    normalized = `http://${normalized}`;
  }
  let u;
  try {
    u = new URL(normalized);
  } catch {
    return {
      ok: false,
      errorCode: "INVALID_PROXY_URL",
      detail: "代理地址格式无效，请使用如 http://127.0.0.1:7897 或 socks5://127.0.0.1:1080",
    };
  }
  const proto = u.protocol.toLowerCase();
  if (proto === "https:") {
    return {
      ok: false,
      errorCode: "UNSUPPORTED_PROXY_PROTOCOL",
      detail: "暂不支持 https:// 代理协议，本地代理通常请填写 http://127.0.0.1:端口",
    };
  }
  if (proto === "socks4:" || proto === "socks4a:") {
    return {
      ok: false,
      errorCode: "UNSUPPORTED_PROXY_PROTOCOL",
      detail: "暂不支持 socks4:// 代理协议，请改用 http:// 或无认证 socks5://",
    };
  }
  const isSocks = proto === "socks:" || proto === "socks5:" || proto === "socks5h:";
  if (proto !== "http:" && !isSocks) {
    return {
      ok: false,
      errorCode: "UNSUPPORTED_PROXY_PROTOCOL",
      detail: `不支持的代理协议 (${u.protocol})，仅支持 http:// 或 socks5://`,
    };
  }
  if ((!hasScheme || requireExplicitPort) && !u.port) {
    return {
      ok: false,
      errorCode: "INVALID_PROXY_PORT",
      detail: "代理地址缺少端口号，请填写完整端口（如 127.0.0.1:7897）",
    };
  }
  const port = Number(u.port || (isSocks ? 1080 : 80));
  if (!u.hostname || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return {
      ok: false,
      errorCode: "INVALID_PROXY_PORT",
      detail: "代理主机名或端口无效（端口范围 1-65535）",
    };
  }
  if (isSocks && (u.username || u.password)) {
    return {
      ok: false,
      errorCode: "UNSUPPORTED_SOCKS_AUTH",
      detail: "SOCKS5 账号密码认证暂不支持，请改用 HTTP 代理或无认证 SOCKS5",
    };
  }
  return { ok: true, value: trimmed, proxy: buildProxyObject(u, isSocks, port, "manual") };
}

function buildProxyObject(u, isSocks, port, source) {
  const result = {
    enabled: true,
    host: normalizeIp(u.hostname),
    port,
    source,
  };
  if (isSocks) {
    result.protocol = "socks5";
  }
  if (u.username || u.password) {
    result.hasAuth = true;
    if (!isSocks) {
      const cred = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
      attachNonEnumerable(result, "authHeader", `Basic ${Buffer.from(cred, "utf8").toString("base64")}`);
    }
  }
  return result;
}

export function parseProxyUrl(raw, source) {
  if (!raw) return null;
  try {
    const trimmed = String(raw).trim();
    if (!trimmed) return null;
    const hasScheme = trimmed.includes("://");
    let normalized = trimmed;
    if (!hasScheme) {
      const colonCount = (normalized.match(/:/g) || []).length;
      if (colonCount > 1 && !normalized.startsWith("[") && !normalized.includes("@")) {
        const lastColon = normalized.lastIndexOf(":");
        normalized = `[${normalized.slice(0, lastColon)}]:${normalized.slice(lastColon + 1)}`;
      }
      normalized = `http://${normalized}`;
    }
    const u = new URL(normalized);
    const proto = u.protocol.toLowerCase();
    const isSocks = proto === "socks:" || proto === "socks5:" || proto === "socks5h:";
    if (proto !== "http:" && !isSocks) return null;
    if (!hasScheme && !u.port) return null;
    const port = Number(u.port || (isSocks ? 1080 : 80));
    if (!u.hostname || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return buildProxyObject(u, isSocks, port, source);
  } catch {
    return null;
  }
}

function splitHostPortSafe(addr) {
  const s = String(addr || "").trim();
  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    if (close !== -1) {
      const rest = s.slice(close + 1);
      return [s.slice(1, close), rest.startsWith(":") ? rest.slice(1) : ""];
    }
  }
  const colonCount = (s.match(/:/g) || []).length;
  if (colonCount > 1) return [s, ""];
  return splitHostPort(s);
}

function ipv4ToInt(ip) {
  const parts = String(ip || "").split(".");
  if (parts.length !== 4) return null;
  let num = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    num = (num * 256) + n;
  }
  return num >>> 0;
}

function matchesCidrV4(targetIp, cidr) {
  const slash = cidr.indexOf("/");
  if (slash === -1) return false;
  const targetInt = ipv4ToInt(targetIp);
  if (targetInt == null) return false;
  let netPart = cidr.slice(0, slash).trim();
  const prefixLen = Number(cidr.slice(slash + 1));
  if (!Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > 32) return false;
  const dotParts = netPart.split(".");
  // 兼容 "192.168/16" 等省略尾部零段的 CIDR 缩写：仅当缺失段全在掩码外时补 0 凑齐 4 段
  while (dotParts.length < 4 && prefixLen <= dotParts.length * 8) {
    dotParts.push("0");
  }
  netPart = dotParts.join(".");
  const netInt = ipv4ToInt(netPart);
  if (netInt == null) return false;
  if (prefixLen === 0) return true;
  const mask = (0xffffffff << (32 - prefixLen)) >>> 0;
  return (targetInt & mask) === (netInt & mask);
}

function matchesBypassEntry(targetHost, targetPort, entryRaw) {
  const entry = String(entryRaw || "").trim().toLowerCase();
  if (!entry) return false;
  if (entry === "*") return true;
  if (entry === "<local>") {
    return !targetHost.includes(".") && !targetHost.includes(":");
  }
  const [entryHostRaw, entryPort] = splitHostPortSafe(entry);
  if (entryPort && /^\d+$/.test(entryPort) && entryPort !== targetPort) return false;
  const cleanEntry = normalizeIp(entryHostRaw);
  if (!cleanEntry) return false;
  if (cleanEntry.includes("/")) {
    return matchesCidrV4(targetHost, cleanEntry);
  }
  if (cleanEntry.includes("*")) {
    const escaped = cleanEntry.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`, "i").test(targetHost);
  }
  if (cleanEntry.startsWith(".")) {
    return targetHost.endsWith(cleanEntry) || targetHost === cleanEntry.slice(1);
  }
  return targetHost === cleanEntry || targetHost.endsWith(`.${cleanEntry}`);
}

export function isNoProxyTarget(targetUrl, env = process.env, extraBypass = []) {
  const raw = env?.NO_PROXY || env?.no_proxy || "";
  const envEntries = raw ? String(raw).split(",") : [];
  const entries = [...envEntries, ...(Array.isArray(extraBypass) ? extraBypass : [])];
  if (!entries.length || !targetUrl) return false;
  let u;
  try {
    u = new URL(targetUrl);
  } catch {
    return false;
  }
  const targetHost = normalizeIp(u.hostname).toLowerCase();
  const targetPort = String(u.port || (u.protocol === "https:" ? 443 : 80));
  return entries.some((item) => matchesBypassEntry(targetHost, targetPort, item));
}

export function getEnvProxy(env = process.env, targetUrl = "") {
  if (targetUrl && isNoProxyTarget(targetUrl, env)) return null;
  return parseProxyUrl(
    env.HTTPS_PROXY ||
      env.https_proxy ||
      env.HTTP_PROXY ||
      env.http_proxy ||
      env.ALL_PROXY ||
      env.all_proxy,
    "env",
  );
}

function parseWindowsDefaultConnFlags(connectionsStdout) {
  if (!connectionsStdout) return null;
  const m = String(connectionsStdout).match(/DefaultConnectionSettings\s+REG_BINARY\s+([0-9a-fA-F]+)/i);
  if (!m || m[1].length < 18) return null;
  // DefaultConnectionSettings 第 9 字节（十六进制下标 16..18）是连接标志位掩码，0x04 表示启用 PAC
  const flags = parseInt(m[1].slice(16, 18), 16);
  return Number.isNaN(flags) ? null : flags;
}

export function parseWindowsRegistryProxy(stdout, connectionsStdout = "") {
  if (!stdout) return null;
  const enableMatch = stdout.match(/ProxyEnable\s+REG_DWORD\s+0x([0-9a-fA-F]+)/);
  const serverMatch = stdout.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/);
  const overrideMatch = stdout.match(/ProxyOverride\s+REG_SZ\s+([^\r\n]+)/);
  const pacMatch = stdout.match(/AutoConfigURL\s+REG_SZ\s+([^\r\n]+)/);
  const enabled = enableMatch ? parseInt(enableMatch[1], 16) === 1 : false;
  const connFlags = parseWindowsDefaultConnFlags(connectionsStdout || stdout);
  const bypassList = overrideMatch
    ? overrideMatch[1]
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  if (enabled && serverMatch) {
    const rawServer = serverMatch[1].trim();
    const parts = rawServer
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    const hasProtoPrefix = parts.some((s) => s.includes("="));
    let parsed = null;
    if (!hasProtoPrefix && parts[0]) {
      parsed = parseProxyUrl(parts[0], "windows-registry");
    } else {
      const byScheme = new Map();
      for (const part of parts) {
        const eq = part.indexOf("=");
        if (eq > 0) {
          byScheme.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
        }
      }
      const httpTarget = byScheme.get("https") || byScheme.get("http");
      if (httpTarget) {
        parsed = parseProxyUrl(httpTarget, "windows-registry");
      }
      if (!parsed) {
        const socksTarget = byScheme.get("socks");
        if (socksTarget) {
          const socksUrl = socksTarget.includes("://") ? socksTarget : `socks5://${socksTarget}`;
          parsed = parseProxyUrl(socksUrl, "windows-registry");
        }
      }
    }
    if (parsed) {
      if (bypassList.length) attachNonEnumerable(parsed, "bypassList", bypassList);
      return parsed;
    }
  }

  const pacUrl = pacMatch ? pacMatch[1].trim() : "";
  const pacAllowed = connFlags == null || (connFlags & 0x04) !== 0;
  if (pacUrl && pacAllowed) {
    return { enabled: false, pacUrl, source: "windows-pac-unsupported" };
  }
  return null;
}

export function parseScutilProxy(stdout) {
  if (!stdout) return null;
  const dict = {};
  const exceptions = [];
  let inExceptions = false;
  for (const line of String(stdout).split(/\r?\n/)) {
    if (inExceptions) {
      if (/^\s*\}/.test(line)) {
        inExceptions = false;
        continue;
      }
      const arrItem = line.match(/^\s*\d+\s*:\s*(.+?)\s*$/);
      if (arrItem && arrItem[1]) {
        exceptions.push(arrItem[1].trim());
      }
      continue;
    }
    if (/^\s*ExceptionsList\s*:\s*<array>\s*\{/.test(line)) {
      inExceptions = true;
      continue;
    }
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$/);
    if (m) dict[m[1]] = m[2];
  }
  const withBypass = (proxy) => {
    if (proxy && exceptions.length) {
      attachNonEnumerable(proxy, "bypassList", exceptions);
    }
    return proxy;
  };
  if (dict.HTTPSEnable === "1" && dict.HTTPSProxy && dict.HTTPSPort) {
    return withBypass(parseProxyUrl(`${dict.HTTPSProxy}:${dict.HTTPSPort}`, "macos-scutil"));
  }
  if (dict.HTTPEnable === "1" && dict.HTTPProxy && dict.HTTPPort) {
    return withBypass(parseProxyUrl(`${dict.HTTPProxy}:${dict.HTTPPort}`, "macos-scutil"));
  }
  if (dict.SOCKSEnable === "1" && dict.SOCKSProxy && dict.SOCKSPort) {
    return withBypass(parseProxyUrl(`socks5://${dict.SOCKSProxy}:${dict.SOCKSPort}`, "macos-scutil"));
  }
  if (dict.ProxyAutoConfigEnable === "1") {
    return {
      enabled: false,
      pacUrl: dict.ProxyAutoConfigURLString || "",
      source: "macos-pac-unsupported",
    };
  }
  return null;
}

async function detectUnixSystemProxy(platform) {
  if (platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("scutil", ["--proxy"], { timeout: 1200 });
      return parseScutilProxy(stdout);
    } catch {
      return null;
    }
  }
  if (platform === "linux") {
    try {
      const { stdout: modeOut } = await execFileAsync(
        "gsettings",
        ["get", "org.gnome.system.proxy", "mode"],
        { timeout: 1000 },
      );
      if (modeOut.includes("auto")) {
        let pacUrl = "";
        try {
          const { stdout: pacOut } = await execFileAsync(
            "gsettings",
            ["get", "org.gnome.system.proxy", "autoconfig-url"],
            { timeout: 800 },
          );
          pacUrl = pacOut.trim().replace(/^'|'$/g, "");
        } catch {
        }
        return { enabled: false, pacUrl, source: "linux-pac-unsupported" };
      }
      if (!modeOut.includes("manual")) return null;
      let ignoreHosts = [];
      try {
        const { stdout: igOut } = await execFileAsync(
          "gsettings",
          ["get", "org.gnome.system.proxy", "ignore-hosts"],
          { timeout: 800 },
        );
        ignoreHosts = [...igOut.matchAll(/'([^']+)'/g)].map((m) => m[1].trim()).filter(Boolean);
      } catch {
      }
      for (const proto of ["https", "http", "socks"]) {
        const [{ stdout: hostOut }, { stdout: portOut }] = await Promise.all([
          execFileAsync("gsettings", ["get", `org.gnome.system.proxy.${proto}`, "host"], { timeout: 800 }),
          execFileAsync("gsettings", ["get", `org.gnome.system.proxy.${proto}`, "port"], { timeout: 800 }),
        ]);
        const host = hostOut.trim().replace(/^'|'$/g, "");
        const port = Number(portOut.trim());
        const target = host && port > 0 ? (proto === "socks" ? `socks5://${host}:${port}` : `${host}:${port}`) : "";
        const parsed = target ? parseProxyUrl(target, "linux-gsettings") : null;
        if (parsed) {
          if (ignoreHosts.length) attachNonEnumerable(parsed, "bypassList", ignoreHosts);
          return parsed;
        }
      }
    } catch {
      return null;
    }
  }
  return null;
}

export async function detectProxyConfig(targetUrl = "", manualOrOpts = "") {
  const opts = typeof manualOrOpts === "object" && manualOrOpts !== null
    ? manualOrOpts
    : { manualProxyUrl: manualOrOpts, forceRefresh: false };
  const manualProxyUrl = opts.manualProxyUrl || "";
  const forceRefresh = Boolean(opts.forceRefresh);

  const manual = parseProxyUrl(manualProxyUrl, "manual");
  if (manual) return manual;

  if (targetUrl && isNoProxyTarget(targetUrl, process.env)) {
    return { enabled: false, source: "no-proxy" };
  }

  const envProxy = getEnvProxy(process.env, targetUrl);
  if (envProxy) return envProxy;

  const now = Date.now();
  let cachedProxy = !forceRefresh && now - proxyCache.checkedAt < 5000 && proxyCache.proxy
    ? proxyCache.proxy
    : null;

  if (!cachedProxy) {
    let detected = null;
    if (process.platform === "win32") {
      for (const regKey of [
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
        "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
      ]) {
        try {
          const isHkcu = regKey.startsWith("HKCU\\");
          const [{ stdout }, connRes] = await Promise.all([
            execFileAsync("reg", ["query", regKey], { timeout: 1200, windowsHide: true }),
            isHkcu
              ? execFileAsync(
                  "reg",
                  ["query", `${regKey}\\Connections`, "/v", "DefaultConnectionSettings"],
                  { timeout: 1000, windowsHide: true },
                ).catch(() => ({ stdout: "" }))
              : Promise.resolve({ stdout: "" }),
          ]);
          detected = parseWindowsRegistryProxy(stdout, connRes?.stdout || "");
          if (detected) break;
        } catch {
        }
      }
    } else {
      detected = await detectUnixSystemProxy(process.platform);
    }

    cachedProxy = detected || { enabled: false, source: "none" };
    proxyCache = { checkedAt: now, proxy: cachedProxy };
  }

  if (cachedProxy.enabled && cachedProxy.bypassList?.length && isNoProxyTarget(targetUrl, null, cachedProxy.bypassList)) {
    return { enabled: false, source: "no-proxy" };
  }
  return cachedProxy;
}
