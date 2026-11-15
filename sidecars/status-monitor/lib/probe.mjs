import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { detectProxyConfig, normalizeIp } from "./proxy.mjs";
import {
  buildProxyProbeRequest,
  isProxyConnectOk,
  openHttpConnectTunnel,
  openSocks5Tunnel,
} from "./proxy-tunnel.mjs";

export { buildProxyProbeRequest, isProxyConnectOk };
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

/** 判断探测返回 HTTP 状态码是否表示上游服务可达（包含 400/404/405/410）。 */
export function isProbeHttpOk(code) {
  if (!Number.isInteger(code) || code <= 0 || code >= 500) return false;
  if (code < 400) return true;
  return code === 400 || code === 404 || code === 405 || code === 410;
}

function connectTlsOverTunnel(tcpSocket, u, cleanHost, finish, assignTlsSocket) {
  return (extra) => {
    if (extra && extra.length > 0) {
      // 代理握手响应末尾若粘带了后续 TLS 字节，先回退到流头部再交由 tls.connect 解析
      tcpSocket.unshift(extra);
    }
    const tlsOpts =
      net.isIP(cleanHost) === 0
        ? { socket: tcpSocket, servername: cleanHost }
        : { socket: tcpSocket };
    const tlsSocket = tls.connect(tlsOpts, () => {
      tlsSocket.write(buildProxyProbeRequest(u));
    });
    assignTlsSocket(tlsSocket);

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
      if (lineEnd === -1) return;
      const m = httpBuf.slice(0, lineEnd).match(/HTTP\/\d(?:\.\d)?\s+(\d{3})/);
      if (!m) {
        finish({ ok: false, statusCode: null, error: "无效 HTTP 响应" });
        return;
      }
      const code = Number(m[1]);
      const ok = isProbeHttpOk(code);
      finish({ ok, statusCode: code, error: ok ? null : `HTTP ${code}` });
    });
  };
}

/** 通过 HTTP CONNECT 或无认证 SOCKS5 代理隧道发起一次短连接 HTTPS 探测。 */
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
      const startTls = connectTlsOverTunnel(tcpSocket, u, cleanHost, finish, (sock) => {
        tlsSocket = sock;
      });
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

/** 并发执行直连（或 TUN）与代理双链路 HTTPS 短连接探测。 */
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
