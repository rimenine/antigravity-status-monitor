import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { attachNonEnumerable } from "./proxy-bypass.mjs";
import { parseProxyUrl } from "./proxy-url.mjs";

const execFileAsync = promisify(execFile);

function parseWindowsDefaultConnFlags(connectionsStdout) {
  if (!connectionsStdout) return null;
  const m = String(connectionsStdout).match(/DefaultConnectionSettings\s+REG_BINARY\s+([0-9a-fA-F]+)/i);
  if (!m || m[1].length < 18) return null;
  // DefaultConnectionSettings 第 9 字节（十六进制下标 16..18）是连接标志位掩码，0x04 表示启用 PAC
  const flags = parseInt(m[1].slice(16, 18), 16);
  return Number.isNaN(flags) ? null : flags;
}

/** 解析 Windows Internet Settings 注册表输出并提取代理、Bypass 列表或 PAC 状态。 */
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

/** 解析 macOS `scutil --proxy` 输出，支持 HTTP / HTTPS / SOCKS5 与 ExceptionsList。 */
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

/** 查询 Windows HKCU / HKLM 系统代理设置。 */
export async function detectWindowsRegistryProxy() {
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
      const detected = parseWindowsRegistryProxy(stdout, connRes?.stdout || "");
      if (detected) return detected;
    } catch {
    }
  }
  return null;
}

async function detectLinuxGnomeProxy() {
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
  return null;
}

/** 检测 macOS 或 Linux 桌面环境的系统代理设置。 */
export async function detectUnixSystemProxy(platform) {
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
      return await detectLinuxGnomeProxy();
    } catch {
      return null;
    }
  }
  return null;
}
