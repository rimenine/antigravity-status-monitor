import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { detectProxyConfig, normalizeIp } from "./proxy.mjs";

export {
  getEnvProxy,
  isNoProxyTarget,
  parseProxyUrl,
  parseScutilProxy,
  parseWindowsRegistryProxy,
} from "./proxy.mjs";
export {
  getLsEndpoints,
  inspectLanguageServer,
  isTunIp,
  parseLsofTcp,
  parseLsEndpointsFromCmd,
  parsePsFallbackPids,
  parseSsTcp,
  parseWindowsNetstat,
  summarizeLsConnections,
} from "./process-probe.mjs";

export function isProxyConnectOk(firstLine) {
  return /^HTTP\/\d(?:\.\d)?\s+200(?:\s|$)/i.test(String(firstLine || "").trim());
}

export function isProbeHttpOk(code) {
  if (!Number.isInteger(code) || code <= 0 || code >= 500) return false;
  if (code < 400) return true;
  return code === 400 || code === 404 || code === 405 || code === 410;
}

function openHttpConnectTunnel(tcpSocket, u, targetPort, proxy, finish, onReady) {
  const hostHeader = `${u.hostname}:${targetPort}`;
  const reqLines = [`CONNECT ${hostHeader} HTTP/1.1`, `Host: ${hostHeader}`];
  if (proxy.authHeader) {
    reqLines.push(`Proxy-Authorization: ${proxy.authHeader}`);
  }
  reqLines.push("Connection: close", "", "");
  tcpSocket.write(reqLines.join("\r\n"));

  let rx = Buffer.alloc(0);
  const crlfEnd = Buffer.from("\r\n\r\n");
  const lfEnd = Buffer.from("\n\n");

  const onConnectData = (chunk) => {
    rx = rx.length > 0 ? Buffer.concat([rx, chunk]) : Buffer.from(chunk);
    let hdrEnd = rx.indexOf(crlfEnd);
    let sepLen = 4;
    if (hdrEnd === -1) {
      hdrEnd = rx.indexOf(lfEnd);
      sepLen = 2;
    }
    if (hdrEnd === -1) {
      if (rx.length > 32768) {
        tcpSocket.off("data", onConnectData);
        finish({ ok: false, statusCode: null, error: "代理响应头过长" });
      }
      return;
    }
    tcpSocket.off("data", onConnectData);

    const headerText = rx.subarray(0, hdrEnd).toString("latin1");
    const firstLine = headerText.split(/\r?\n/)[0] || "";
    if (!isProxyConnectOk(firstLine)) {
      finish({ ok: false, statusCode: null, error: `代理隧道拒绝: ${firstLine}` });
      return;
    }
    const extra = Buffer.from(rx.subarray(hdrEnd + sepLen));
    onReady(extra);
  };
  tcpSocket.on("data", onConnectData);
}

function encodeSocks5Ipv6(ip) {
  const bare = normalizeIp(ip).split("%")[0];
  const halves = bare.split("::");
  if (halves.length > 2) return null;
  const parsePart = (part) => (part ? part.split(":").map((h) => parseInt(h, 16)) : []);
  const head = parsePart(halves[0]);
  const tail = halves.length === 2 ? parsePart(halves[1]) : [];
  if (head.some((n) => Number.isNaN(n)) || tail.some((n) => Number.isNaN(n))) return null;
  const missing = 8 - (head.length + tail.length);
  if ((halves.length === 2 && missing < 0) || (halves.length === 1 && missing !== 0)) return null;
  const words = [...head, ...new Array(Math.max(0, missing)).fill(0), ...tail];
  const out = Buffer.alloc(16);
  for (let i = 0; i < 8; i += 1) {
    out.writeUInt16BE(words[i], i * 2);
  }
  return out;
}

function openSocks5Tunnel(tcpSocket, u, targetPort, proxy, finish, onReady) {
  if (proxy.hasAuth) {
    finish({ ok: false, statusCode: null, error: "SOCKS5 账号密码认证暂不支持" });
    return;
  }
  const hostStr = normalizeIp(u.hostname);
  const ipVer = net.isIP(hostStr);
  let addrPart = null;
  let atypByte = 0x03;
  if (ipVer === 4) {
    atypByte = 0x01;
    addrPart = Buffer.from(hostStr.split(".").map((n) => Number(n)));
  } else if (ipVer === 6) {
    atypByte = 0x04;
    addrPart = encodeSocks5Ipv6(hostStr);
  } else {
    const hostBuf = Buffer.from(hostStr, "ascii");
    if (hostBuf.length > 0 && hostBuf.length <= 255) {
      addrPart = Buffer.concat([Buffer.from([hostBuf.length]), hostBuf]);
    }
  }
  if (!addrPart) {
    finish({ ok: false, statusCode: null, error: "SOCKS5 目标域名无效" });
    return;
  }

  let stage = "greeting";
  let rx = Buffer.alloc(0);

  const onSocksData = (chunk) => {
    rx = rx.length > 0 ? Buffer.concat([rx, chunk]) : chunk;

    if (stage === "greeting") {
      if (rx.length < 2) return;
      const ver = rx[0];
      const method = rx[1];
      rx = Buffer.from(rx.subarray(2));
      if (ver !== 0x05) {
        tcpSocket.off("data", onSocksData);
        finish({ ok: false, statusCode: null, error: "SOCKS5 响应无效" });
        return;
      }
      if (method === 0x02 || method === 0xff) {
        tcpSocket.off("data", onSocksData);
        finish({ ok: false, statusCode: null, error: "SOCKS5 需要认证或无可用认证方式" });
        return;
      }
      if (method !== 0x00) {
        tcpSocket.off("data", onSocksData);
        finish({ ok: false, statusCode: null, error: `SOCKS5 认证方式不支持 (${method})` });
        return;
      }
      stage = "connect";
      const portBuf = Buffer.allocUnsafe(2);
      portBuf.writeUInt16BE(targetPort, 0);
      const req = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, atypByte]), addrPart, portBuf]);
      tcpSocket.write(req);
    }

    if (stage === "connect") {
      if (rx.length < 4) return;
      const ver = rx[0];
      const rep = rx[1];
      const atyp = rx[3];
      if (ver !== 0x05) {
        tcpSocket.off("data", onSocksData);
        finish({ ok: false, statusCode: null, error: "SOCKS5 CONNECT 响应无效" });
        return;
      }
      if (rep !== 0x00) {
        tcpSocket.off("data", onSocksData);
        finish({ ok: false, statusCode: null, error: `SOCKS5 隧道失败 (code ${rep})` });
        return;
      }
      // SOCKS5 应答头 4B + 端口 2B，按 IPv4(4B)/IPv6(16B)/域名(1B 长度 + N) 算整包长度防粘包截断
      let needLen = 0;
      if (atyp === 0x01) needLen = 10;
      else if (atyp === 0x04) needLen = 22;
      else if (atyp === 0x03) {
        if (rx.length < 5) return;
        needLen = 7 + rx[4];
      } else {
        tcpSocket.off("data", onSocksData);
        finish({ ok: false, statusCode: null, error: "SOCKS5 地址类型不支持" });
        return;
      }
      if (rx.length < needLen) return;
      const extra = Buffer.from(rx.subarray(needLen));
      tcpSocket.off("data", onSocksData);
      onReady(extra);
    }
  };

  tcpSocket.on("data", onSocksData);
  tcpSocket.write(Buffer.from([0x05, 0x01, 0x00]));
}

export function probeViaProxy(targetUrl, proxy, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const start = Date.now();
    const isSocks = proxy.protocol === "socks5";
    const proxyAddress = `${isSocks ? "socks5://" : ""}${proxy.host}:${proxy.port}`;
    let u;
    try {
      u = new URL(targetUrl);
      if (u.protocol !== "https:") {
        throw new Error("Only https protocol supported");
      }
    } catch {
      resolve({
        ts: Date.now(),
        latencyMs: 0,
        mode: "proxy",
        proxyAddress,
        target: targetUrl,
        ok: false,
        statusCode: null,
        error: "探测目标 URL 无效",
      });
      return;
    }
    const targetPort = Number(u.port || 443);
    const cleanHost = normalizeIp(u.hostname);
    let settled = false;
    let tcpSocket = null;
    let tlsSocket = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        tlsSocket?.destroy();
        tcpSocket?.destroy();
      } catch {
      }
      resolve({
        ts: Date.now(),
        latencyMs: Date.now() - start,
        mode: "proxy",
        proxyAddress,
        target: targetUrl,
        ...result,
      });
    };

    const timer = setTimeout(() => {
      finish({ ok: false, statusCode: null, error: "连接超时 (Proxy/TLS)" });
    }, timeoutMs);

    tcpSocket = net.connect(proxy.port, proxy.host, () => {
      const startTls = (extra) => {
        if (extra && extra.length > 0) {
          // 代理握手响应末尾若粘带了后续 TLS 字节，先回退到流头部再交由 tls.connect 解析
          tcpSocket.unshift(extra);
        }
        const tlsOpts = net.isIP(cleanHost) === 0
          ? { socket: tcpSocket, servername: cleanHost }
          : { socket: tcpSocket };
        tlsSocket = tls.connect(tlsOpts, () => {
          const path = `${u.pathname || "/"}${u.search || ""}`;
          tlsSocket.write(
            `GET ${path} HTTP/1.1\r\nHost: ${u.hostname}\r\nUser-Agent: agy-status-monitor/1.1\r\nConnection: close\r\n\r\n`,
          );
        });

        tlsSocket.once("error", (err) => {
          finish({ ok: false, statusCode: null, error: `TLS 握手失败: ${err.code || err.message}` });
        });

        tlsSocket.once("end", () => {
          finish({ ok: false, statusCode: null, error: "连接过早关闭" });
        });

        let httpBuf = "";
        tlsSocket.on("data", (d) => {
          httpBuf += d.toString("utf8");
          const lineEnd = httpBuf.indexOf("\r\n");
          if (lineEnd !== -1) {
            const m = httpBuf.slice(0, lineEnd).match(/HTTP\/\d(?:\.\d)?\s+(\d{3})/);
            if (!m) {
              finish({ ok: false, statusCode: null, error: "无效 HTTP 响应" });
              return;
            }
            const code = Number(m[1]);
            const ok = isProbeHttpOk(code);
            finish({ ok, statusCode: code, error: ok ? null : `HTTP ${code}` });
          }
        });
      };

      if (isSocks) {
        openSocks5Tunnel(tcpSocket, u, targetPort, proxy, finish, startTls);
      } else {
        openHttpConnectTunnel(tcpSocket, u, targetPort, proxy, finish, startTls);
      }
    });

    tcpSocket.once("error", (err) => {
      finish({ ok: false, statusCode: null, error: `代理不可达: ${err.code || err.message}` });
    });

    tcpSocket.once("end", () => {
      finish({ ok: false, statusCode: null, error: "代理连接过早关闭" });
    });
  });
}

function probeDirect(targetUrl, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    let req = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        req?.destroy();
      } catch {
      }
      resolve({
        ts: Date.now(),
        latencyMs: Date.now() - start,
        mode: "direct",
        proxyAddress: null,
        target: targetUrl,
        ...result,
      });
    };

    const timer = setTimeout(() => {
      finish({ ok: false, statusCode: null, error: "请求超时" });
    }, timeoutMs);

    try {
      req = https.get(
        targetUrl,
        {
          timeout: timeoutMs,
          agent: false,
          headers: { "User-Agent": "agy-status-monitor/1.1", Connection: "close" },
        },
        (res) => {
          res.resume();
          const code = res.statusCode || 0;
          const ok = isProbeHttpOk(code);
          finish({ ok, statusCode: code, error: ok ? null : `HTTP ${code}` });
        },
      );
      req.on("timeout", () => finish({ ok: false, statusCode: null, error: "Socket 超时" }));
      req.on("error", (err) => {
        finish({ ok: false, statusCode: null, error: err.code || err.message || "网络不可达" });
      });
    } catch (err) {
      finish({ ok: false, statusCode: null, error: err.message });
    }
  });
}

export async function probePaths(
  targetUrl,
  timeoutMs = 2500,
  { manualProxyUrl = "", forceRefresh = false } = {},
) {
  const proxyConfig = await detectProxyConfig(targetUrl, { manualProxyUrl, forceRefresh });
  const [direct, viaProxy] = await Promise.all([
    probeDirect(targetUrl, timeoutMs),
    proxyConfig.enabled ? probeViaProxy(targetUrl, proxyConfig, timeoutMs) : Promise.resolve(null),
  ]);
  return { ts: Date.now(), target: targetUrl, proxyConfig, direct, proxy: viaProxy };
}
