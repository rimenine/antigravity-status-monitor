import { attachNonEnumerable, isNoProxyTarget, normalizeIp } from "./proxy-bypass.mjs";

const SUPPORTED_SOCKS_PROTOCOLS = new Set(["socks:", "socks5:", "socks5h:"]);

function normalizeBareProxyUrl(trimmed, { wrapBareIpv6 = false } = {}) {
  const hasScheme = trimmed.includes("://");
  if (hasScheme) {
    return { hasScheme: true, normalized: trimmed };
  }
  let normalized = trimmed;
  const colonCount = (normalized.match(/:/g) || []).length;
  if (colonCount > 1 && !normalized.startsWith("[") && !normalized.includes("@")) {
    if (!wrapBareIpv6) {
      return { hasScheme: false, bareIpv6Error: true, normalized };
    }
    const lastColon = normalized.lastIndexOf(":");
    normalized = `[${normalized.slice(0, lastColon)}]:${normalized.slice(lastColon + 1)}`;
  }
  return { hasScheme: false, normalized: `http://${normalized}` };
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

/** 严格校验手动输入的代理地址，并返回结构化错误码与解析后的代理对象。 */
export function validateProxyInput(raw, { requireExplicitPort = true } = {}) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) {
    return { ok: true, value: "", proxy: null };
  }
  if (trimmed.includes("://***@") || trimmed.startsWith("***@")) {
    return { ok: true, value: trimmed, proxy: null, maskedPlaceholder: true };
  }
  const prep = normalizeBareProxyUrl(trimmed, { wrapBareIpv6: false });
  if (prep.bareIpv6Error) {
    return {
      ok: false,
      errorCode: "INVALID_PROXY_PORT",
      detail: "IPv6 代理地址请使用 [::1]:端口 格式并包含端口",
    };
  }
  let u;
  try {
    u = new URL(prep.normalized);
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
  const isSocks = SUPPORTED_SOCKS_PROTOCOLS.has(proto);
  if (proto !== "http:" && !isSocks) {
    return {
      ok: false,
      errorCode: "UNSUPPORTED_PROXY_PROTOCOL",
      detail: `不支持的代理协议 (${u.protocol})，仅支持 http:// 或 socks5://`,
    };
  }
  if ((!prep.hasScheme || requireExplicitPort) && !u.port) {
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

/** 宽松解析来自环境变量或系统配置的代理 URL。 */
export function parseProxyUrl(raw, source) {
  if (!raw) return null;
  try {
    const trimmed = String(raw).trim();
    if (!trimmed) return null;
    const prep = normalizeBareProxyUrl(trimmed, { wrapBareIpv6: true });
    const u = new URL(prep.normalized);
    const proto = u.protocol.toLowerCase();
    const isSocks = SUPPORTED_SOCKS_PROTOCOLS.has(proto);
    if (proto !== "http:" && !isSocks) return null;
    if (!prep.hasScheme && !u.port) return null;
    const port = Number(u.port || (isSocks ? 1080 : 80));
    if (!u.hostname || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return buildProxyObject(u, isSocks, port, source);
  } catch {
    return null;
  }
}

/** 从进程环境变量读取代理配置（遵循 NO_PROXY）。 */
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
