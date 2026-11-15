/** 标准化 IP 字符串，去除 IPv6 方括号及 IPv4 映射前缀。 */
export function normalizeIp(host) {
  return String(host || "")
    .replace(/^\[|\]$/g, "")
    .replace(/^::ffff:/i, "");
}

/** 从 host:port 文本拆分主机与端口（不解析复杂 IPv6）。 */
export function splitHostPort(addr) {
  const raw = String(addr || "");
  const idx = raw.lastIndexOf(":");
  return idx === -1 ? [raw, ""] : [raw.slice(0, idx), raw.slice(idx + 1)];
}

/** 将凭据或绕过列表挂为不可枚举属性，避免配置序列化或日志意外泄露敏感字段。 */
export function attachNonEnumerable(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: false,
    configurable: true,
  });
  return target;
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
    num = num * 256 + n;
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

/** 判断目标 URL 是否命中 NO_PROXY 或系统代理绕过规则列表。 */
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
