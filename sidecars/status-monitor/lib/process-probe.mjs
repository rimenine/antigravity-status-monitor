import { execFile } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
import { normalizeIp, splitHostPort } from "./proxy.mjs";

const execFileAsync = promisify(execFile);
const endpointCache = new Map();

function checkLsHealthz(lsAddress, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (!lsAddress) {
      resolve({ reachable: null, instanceId: null });
      return;
    }
    const req = http.get(`http://${lsAddress}/healthz`, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          resolve({ reachable: parsed?.status === "ok", instanceId: parsed?.instanceId || null });
        } catch {
          resolve({ reachable: res.statusCode === 200, instanceId: null });
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ reachable: false, instanceId: null });
    });
    req.on("error", () => resolve({ reachable: false, instanceId: null }));
  });
}

function parsePort(address) {
  if (!address) return null;
  const port = Number(String(address).split(":").pop());
  return Number.isInteger(port) && port > 0 ? port : null;
}

export function isTunIp(ip) {
  const clean = normalizeIp(ip);
  // 198.18.0.0/15 为 Fake-IP 常用保留段，100.64.0.0/10 为 CGNAT/Clash TUN 常见虚拟网卡网段
  if (clean.startsWith("198.18.") || clean.startsWith("198.19.")) return true;
  const m = clean.match(/^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (m) {
    const oct2 = Number(m[1]);
    return oct2 >= 64 && oct2 <= 127;
  }
  return false;
}

function normalizeTcpState(rawState) {
  const s = String(rawState || "").toUpperCase();
  if (s === "LISTEN" || s === "LISTENING") return "LISTENING";
  if (s === "ESTAB" || s === "ESTABLISHED") return "ESTABLISHED";
  if (s === "SYN-SENT" || s === "SYN_SENT") return "SYN_SENT";
  return s;
}

export function parseWindowsNetstat(stdout) {
  const rows = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0] !== "TCP") continue;
    rows.push({
      local: parts[1],
      remote: parts[2],
      state: normalizeTcpState(parts[3]),
      pid: parts[4],
    });
  }
  return rows;
}

export function parseLsofTcp(stdout) {
  const rows = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("COMMAND")) continue;
    const cols = trimmed.split(/\s+/);
    const pid = cols[1];
    if (!/^\d+$/.test(pid || "")) continue;
    const tcpMatch = trimmed.match(/\bTCP\s+(\S+)(?:\s+\(([^)]+)\))?\s*$/);
    if (!tcpMatch) continue;
    const endpointStr = tcpMatch[1];
    const state = normalizeTcpState(tcpMatch[2] || "");
    const arrowIdx = endpointStr.indexOf("->");
    const local = arrowIdx === -1 ? endpointStr : endpointStr.slice(0, arrowIdx);
    const remote = arrowIdx === -1 ? "*:*" : endpointStr.slice(arrowIdx + 2);
    rows.push({ local, remote, state, pid, command: cols[0] });
  }
  return rows;
}

export function parseSsTcp(stdout) {
  const rows = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("State") || trimmed.startsWith("Netid")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 5) continue;
    const state = normalizeTcpState(parts[0]);
    const local = parts[3];
    const remote = parts[4];
    const tail = parts.slice(5).join(" ");
    const pids = new Set();
    for (const m of tail.matchAll(/pid=(\d+)/g)) {
      pids.add(m[1]);
    }
    for (const pid of pids) {
      rows.push({ local, remote, state, pid });
    }
  }
  return rows;
}

export function summarizeLsConnections(rows, { lsPort = null, fallbackPids = [], proxy = null } = {}) {
  let pids = [];
  let matchedByPort = false;
  if (lsPort) {
    const listenPids = [
      ...new Set(
        rows
          .filter((r) => r.state === "LISTENING" && splitHostPort(r.local)[1] === String(lsPort))
          .map((r) => String(r.pid)),
      ),
    ];
    if (listenPids.length > 0) {
      pids = listenPids;
      matchedByPort = true;
    }
  }

  if (pids.length === 0 && fallbackPids.length > 0) {
    pids = [...new Set(fallbackPids.map(String))];
  }

  const pidSet = new Set(pids);
  const proxyKeys = new Set();
  if (proxy?.enabled) {
    const host = normalizeIp(proxy.host);
    proxyKeys.add(`${host}:${proxy.port}`);
    proxyKeys.add(`[${host}]:${proxy.port}`);
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      proxyKeys.add(`127.0.0.1:${proxy.port}`);
      proxyKeys.add(`[127.0.0.1]:${proxy.port}`);
      proxyKeys.add(`::1:${proxy.port}`);
      proxyKeys.add(`[::1]:${proxy.port}`);
      proxyKeys.add(`localhost:${proxy.port}`);
    }
  }

  let established443 = 0;
  let synSent443 = 0;
  let proxyConns = 0;
  let tunDetected = false;
  const localIpSet = new Set();

  for (const r of rows) {
    if (!pidSet.has(String(r.pid))) continue;
    const [remoteHostRaw, remotePort] = splitHostPort(r.remote);
    const remoteNormalized = `${normalizeIp(remoteHostRaw)}:${remotePort}`;
    if (proxyKeys.has(r.remote) || proxyKeys.has(remoteNormalized)) {
      if (r.state === "ESTABLISHED") proxyConns += 1;
      continue;
    }
    if (remotePort !== "443") continue;
    const [localIpRaw] = splitHostPort(r.local);
    const localIp = normalizeIp(localIpRaw);
    localIpSet.add(localIp);
    if (isTunIp(localIp) || isTunIp(remoteHostRaw)) tunDetected = true;
    if (r.state === "ESTABLISHED") established443 += 1;
    else if (r.state === "SYN_SENT") synSent443 += 1;
  }

  let route = null;
  if (established443 + synSent443 > 0) route = tunDetected ? "tun" : "direct";
  else if (proxyConns > 0) route = "proxy";

  return {
    running: pids.length > 0,
    pids,
    lsPid: matchedByPort ? pids[0] : pids.length === 1 ? pids[0] : null,
    matchedByPort,
    established443,
    synSent443,
    proxyConns,
    tunDetected,
    localIps: [...localIpSet],
    route,
  };
}

function hasListeningPort(rows, lsPort) {
  return Boolean(
    lsPort &&
      rows.some((r) => r.state === "LISTENING" && splitHostPort(r.local)[1] === String(lsPort)),
  );
}

async function collectWindowsSocketState(lsPort) {
  const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "TCP"], {
    timeout: 2500,
    windowsHide: true,
  });
  const rows = parseWindowsNetstat(stdout);

  const fallbackPids = [];
  if (!hasListeningPort(rows, lsPort)) {
    const { stdout: tl } = await execFileAsync(
      "tasklist",
      ["/FI", "IMAGENAME eq language_server.exe", "/FO", "CSV", "/NH"],
      { timeout: 1500, windowsHide: true },
    );
    for (const line of tl.split(/\r?\n/)) {
      const m = line.match(/^"language_server\.exe","(\d+)"/i);
      if (m) fallbackPids.push(m[1]);
    }
  }
  return { rows, fallbackPids };
}

export function parsePsFallbackPids(stdout) {
  const pids = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    const base = m[2].trim().split("/").pop();
    if (/^language_server(?:$|[_.-])/i.test(base)) {
      pids.push(m[1]);
    }
  }
  return pids;
}

async function collectUnixSocketState(lsPort, platform) {
  let rows = [];
  let collected = false;

  if (platform === "linux") {
    try {
      const { stdout } = await execFileAsync("ss", ["-tnap"], { timeout: 2500 });
      rows = parseSsTcp(stdout);
      collected = true;
    } catch {
    }
  }

  if (!collected) {
    const { stdout } = await execFileAsync("lsof", ["-nP", "-iTCP"], { timeout: 2500 });
    rows = parseLsofTcp(stdout);
  }

  const fallbackPids = [];
  if (!hasListeningPort(rows, lsPort)) {
    try {
      const { stdout: pgOut } = await execFileAsync("pgrep", ["^language_server"], { timeout: 1500 });
      for (const line of pgOut.split(/\r?\n/)) {
        const pid = line.trim();
        if (/^\d+$/.test(pid)) fallbackPids.push(pid);
      }
    } catch {
    }
    if (fallbackPids.length === 0) {
      try {
        const { stdout: psOut } = await execFileAsync("ps", ["-eo", "pid=,comm="], { timeout: 1500 });
        fallbackPids.push(...parsePsFallbackPids(psOut));
      } catch {
      }
    }
  }
  return { rows, fallbackPids };
}

export async function inspectLanguageServer({ lsAddress, proxy } = {}) {
  const healthz = await checkLsHealthz(lsAddress);
  const empty = {
    running: null,
    pids: [],
    lsPid: null,
    matchedByPort: false,
    established443: 0,
    synSent443: 0,
    proxyConns: 0,
    tunDetected: false,
    localIps: [],
    route: null,
    healthz,
  };

  try {
    const lsPort = parsePort(lsAddress);
    const { rows, fallbackPids } =
      process.platform === "win32"
        ? await collectWindowsSocketState(lsPort)
        : await collectUnixSocketState(lsPort, process.platform);

    return {
      ...summarizeLsConnections(rows, { lsPort, fallbackPids, proxy }),
      healthz,
    };
  } catch {
    return empty;
  }
}

export function parseLsEndpointsFromCmd(cmd) {
  const pick = (flag) => {
    const m = String(cmd || "").match(new RegExp(`--${flag}[=\\s]+"?([^\\s"]+)`));
    return m && /^https:\/\//i.test(m[1]) ? m[1] : null;
  };
  return { cloudCode: pick("cloud_code_endpoint"), apiServer: pick("api_server_url") };
}

export async function getLsEndpoints(pid) {
  if (!pid || !/^\d+$/.test(String(pid))) return null;
  const key = String(pid);
  if (endpointCache.has(key)) return endpointCache.get(key);
  try {
    let stdout = "";
    if (process.platform === "win32") {
      ({ stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter ProcessId=${Number(key)}).CommandLine`,
        ],
        { timeout: 8000, windowsHide: true },
      ));
    } else {
      ({ stdout } = await execFileAsync("ps", ["-p", key, "-o", "args="], { timeout: 2500 }));
    }
    const result = parseLsEndpointsFromCmd(stdout.trim());
    if (result.cloudCode || result.apiServer) {
      if (endpointCache.size >= 16) {
        endpointCache.delete(endpointCache.keys().next().value);
      }
      endpointCache.set(key, result);
    }
    return result;
  } catch {
    return null;
  }
}
