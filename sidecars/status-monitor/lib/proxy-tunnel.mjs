import net from "node:net";
import { normalizeIp } from "./proxy.mjs";

/** 构造通过隧道连接目标 HTTPS 服务后的 HTTP GET 探测请求报文。 */
export function buildProxyProbeRequest(u) {
  const path = `${u.pathname || "/"}${u.search || ""}`;
  return `GET ${path} HTTP/1.1\r\nHost: ${u.host}\r\nUser-Agent: agy-status-monitor/1.1\r\nConnection: close\r\n\r\n`;
}

/** 校验 HTTP CONNECT 首行响应是否为 200 状态码。 */
export function isProxyConnectOk(firstLine) {
  return /^HTTP\/\d(?:\.\d)?\s+200(?:\s|$)/i.test(String(firstLine || "").trim());
}

/** 在已建立的 TCP 套接字上执行 HTTP CONNECT 隧道握手。 */
export function openHttpConnectTunnel(tcpSocket, u, targetPort, proxy, finish, onReady) {
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

function buildSocks5TargetAddress(hostname) {
  const hostStr = normalizeIp(hostname);
  const ipVer = net.isIP(hostStr);
  if (ipVer === 4) {
    return {
      atypByte: 0x01,
      addrPart: Buffer.from(hostStr.split(".").map((n) => Number(n))),
    };
  }
  if (ipVer === 6) {
    const addrPart = encodeSocks5Ipv6(hostStr);
    return addrPart ? { atypByte: 0x04, addrPart } : null;
  }
  const hostBuf = Buffer.from(hostStr, "ascii");
  if (hostBuf.length === 0 || hostBuf.length > 255) return null;
  return {
    atypByte: 0x03,
    addrPart: Buffer.concat([Buffer.from([hostBuf.length]), hostBuf]),
  };
}

/** 在已建立的 TCP 套接字上执行无认证 SOCKS5 CONNECT 握手。 */
export function openSocks5Tunnel(tcpSocket, u, targetPort, proxy, finish, onReady) {
  if (proxy.hasAuth) {
    finish({ ok: false, statusCode: null, error: "SOCKS5 账号密码认证暂不支持" });
    return;
  }
  const encodedAddr = buildSocks5TargetAddress(u.hostname);
  if (!encodedAddr) {
    finish({ ok: false, statusCode: null, error: "SOCKS5 目标域名无效" });
    return;
  }

  const { atypByte, addrPart } = encodedAddr;
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
