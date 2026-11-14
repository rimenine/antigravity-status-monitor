import assert from "node:assert/strict";
import net from "node:net";
import { describe, it } from "node:test";
import {
  getEnvProxy,
  isNoProxyTarget,
  isProbeHttpOk,
  isProxyConnectOk,
  isTunIp,
  parseLsofTcp,
  parseLsEndpointsFromCmd,
  parseProxyUrl,
  parsePsFallbackPids,
  parseScutilProxy,
  parseSsTcp,
  parseWindowsNetstat,
  parseWindowsRegistryProxy,
  probeViaProxy,
  summarizeLsConnections,
} from "../sidecars/status-monitor/lib/probe.mjs";

describe("probe 跨平台解析与汇总（Windows / macOS / Linux）", () => {
  it("parseWindowsNetstat + summarizeLsConnections 识别 TUN 443 与代理回退", () => {
    const netstatOut = [
      "Active Connections",
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    127.0.0.1:5387         0.0.0.0:0              LISTENING       1001",
      "  TCP    198.18.0.2:50123       142.250.72.206:443     ESTABLISHED     1001",
      "  TCP    198.18.0.2:50124       142.250.72.206:443     SYN_SENT        1001",
      "  TCP    127.0.0.1:50999        127.0.0.1:7897         ESTABLISHED     9999",
    ].join("\r\n");

    const rows = parseWindowsNetstat(netstatOut);
    const summary = summarizeLsConnections(rows, {
      lsPort: 5387,
      proxy: { enabled: true, host: "127.0.0.1", port: 7897 },
    });

    assert.equal(summary.running, true);
    assert.equal(summary.matchedByPort, true);
    assert.equal(summary.lsPid, "1001");
    assert.equal(summary.established443, 1);
    assert.equal(summary.synSent443, 1);
    assert.equal(summary.tunDetected, true);
    assert.equal(summary.route, "tun");
  });

  it("parseLsofTcp 解析 macOS/Linux lsof 输出并统计 443/代理与 IPv6", () => {
    const lsofOut = [
      "COMMAND     PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME",
      "language_  2345 user   21u  IPv4 0x1234567890abcdef      0t0  TCP 127.0.0.1:5387 (LISTEN)",
      "language_  2345 user   22u  IPv4 0x1234567890abcdef      0t0  TCP 192.168.1.10:51234->127.0.0.1:7890 (ESTABLISHED)",
      "language_  2345 user   23u  IPv6 0x1234567890abcdef      0t0  TCP [::ffff:198.19.0.5]:51235->[2607:f8b0::1]:443 (ESTABLISHED)",
    ].join("\n");

    const rows = parseLsofTcp(lsofOut);
    const summary = summarizeLsConnections(rows, {
      lsPort: 5387,
      proxy: { enabled: true, host: "127.0.0.1", port: 7890 },
    });

    assert.equal(summary.running, true);
    assert.equal(summary.lsPid, "2345");
    assert.equal(summary.proxyConns, 1);
    assert.equal(summary.established443, 1);
    assert.equal(summary.tunDetected, true);
    assert.equal(summary.route, "tun");
  });

  it("parseSsTcp 解析 Linux ss -tnp 输出并在无直连 443 时识别 proxy 路由", () => {
    const ssOut = [
      "State    Recv-Q Send-Q Local Address:Port  Peer Address:Port Process",
      'LISTEN   0      128        127.0.0.1:5387     0.0.0.0:*     users:(("language_server",pid=4321,fd=21))',
      'ESTAB    0      0          127.0.0.1:43210    127.0.0.1:7897 users:(("language_server",pid=4321,fd=24))',
    ].join("\n");

    const rows = parseSsTcp(ssOut);
    const summary = summarizeLsConnections(rows, {
      lsPort: 5387,
      proxy: { enabled: true, host: "127.0.0.1", port: 7897 },
    });

    assert.equal(summary.running, true);
    assert.equal(summary.lsPid, "4321");
    assert.equal(summary.proxyConns, 1);
    assert.equal(summary.established443, 0);
    assert.equal(summary.route, "proxy");
  });

  it("isTunIp 识别 Fake-IP 与 CGNAT TUN 网段且不误伤普通局域网", () => {
    assert.equal(isTunIp("198.18.0.1"), true);
    assert.equal(isTunIp("[::ffff:198.19.12.3]"), true);
    assert.equal(isTunIp("100.64.0.2"), true);
    assert.equal(isTunIp("100.127.255.1"), true);
    assert.equal(isTunIp("100.63.0.1"), false);
    assert.equal(isTunIp("192.168.1.5"), false);
  });

  it("parseWindowsRegistryProxy 与 parseScutilProxy 正确提取系统代理并识别 PAC", () => {
    const regOut = [
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
      "    ProxyEnable    REG_DWORD    0x1",
      "    ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7897",
    ].join("\r\n");
    const winProxy = parseWindowsRegistryProxy(regOut);
    assert.deepEqual(winProxy, {
      enabled: true,
      host: "127.0.0.1",
      port: 7897,
      source: "windows-registry",
    });

    const pacOut = [
      "    ProxyEnable    REG_DWORD    0x0",
      "    AutoConfigURL    REG_SZ    http://127.0.0.1:7890/pac.js",
    ].join("\r\n");
    assert.deepEqual(parseWindowsRegistryProxy(pacOut), {
      enabled: false,
      pacUrl: "http://127.0.0.1:7890/pac.js",
      source: "windows-pac-unsupported",
    });

    const scutilOut = [
      "<dictionary> {",
      "  HTTPEnable : 1",
      "  HTTPPort : 7890",
      "  HTTPProxy : 127.0.0.1",
      "  HTTPSEnable : 1",
      "  HTTPSPort : 7897",
      "  HTTPSProxy : 127.0.0.1",
      "}",
    ].join("\n");
    const macProxy = parseScutilProxy(scutilOut);
    assert.deepEqual(macProxy, {
      enabled: true,
      host: "127.0.0.1",
      port: 7897,
      source: "macos-scutil",
    });
  });

  it("parseLsEndpointsFromCmd 提取命令行中的 HTTPS 上游端点", () => {
    const res = parseLsEndpointsFromCmd(
      '/usr/bin/language_server --cloud_code_endpoint="https://daily-cloudcode-pa.googleapis.com" --api_server_url https://api.example.com',
    );
    assert.deepEqual(res, {
      cloudCode: "https://daily-cloudcode-pa.googleapis.com",
      apiServer: "https://api.example.com",
    });
  });

  it("isProxyConnectOk、isProbeHttpOk 与 parsePsFallbackPids 覆盖响应与 Unix 架构后缀边界", () => {
    assert.equal(isProxyConnectOk("HTTP/1.1 200 Connection Established"), true);
    assert.equal(isProxyConnectOk("HTTP/1.1 200"), true);
    assert.equal(isProxyConnectOk("HTTP/1.1 407 Proxy Authentication Required"), false);

    assert.equal(isProbeHttpOk(200), true);
    assert.equal(isProbeHttpOk(302), true);
    assert.equal(isProbeHttpOk(404), true);
    assert.equal(isProbeHttpOk(401), false);
    assert.equal(isProbeHttpOk(403), false);
    assert.equal(isProbeHttpOk(407), false);
    assert.equal(isProbeHttpOk(429), false);
    assert.equal(isProbeHttpOk(502), false);

    const psOut = [
      "  101 language_server",
      "  202 /Applications/Antigravity.app/Contents/MacOS/language_server_macos_arm64",
      "  303 /opt/agy/language_server_linux_x64",
      "  404 node",
      "  505 rg",
    ].join("\n");
    assert.deepEqual(parsePsFallbackPids(psOut), ["101", "202", "303"]);
  });

  it("支持 Windows socks=、macOS SOCKS/PAC、ALL_PROXY/NO_PROXY 与 [::1] 回环互认", () => {
    const winSocks = parseWindowsRegistryProxy(
      "    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    socks=127.0.0.1:10808",
    );
    assert.deepEqual(winSocks, {
      enabled: true,
      protocol: "socks5",
      host: "127.0.0.1",
      port: 10808,
      source: "windows-registry",
    });

    const macSocks = parseScutilProxy("<dictionary> {\n  SOCKSEnable : 1\n  SOCKSProxy : 127.0.0.1\n  SOCKSPort : 1080\n}");
    assert.deepEqual(macSocks, {
      enabled: true,
      protocol: "socks5",
      host: "127.0.0.1",
      port: 1080,
      source: "macos-scutil",
    });

    const macPac = parseScutilProxy(
      "<dictionary> {\n  ProxyAutoConfigEnable : 1\n  ProxyAutoConfigURLString : http://127.0.0.1/p.pac\n}",
    );
    assert.deepEqual(macPac, {
      enabled: false,
      pacUrl: "http://127.0.0.1/p.pac",
      source: "macos-pac-unsupported",
    });

    const allProxy = getEnvProxy(
      { ALL_PROXY: "socks5h://127.0.0.1:1080" },
      "https://daily-cloudcode-pa.googleapis.com",
    );
    assert.deepEqual(allProxy, {
      enabled: true,
      protocol: "socks5",
      host: "127.0.0.1",
      port: 1080,
      source: "env",
    });
    assert.equal(
      isNoProxyTarget("https://daily-cloudcode-pa.googleapis.com", { NO_PROXY: "foo.com,.googleapis.com" }),
      true,
    );
    assert.equal(
      getEnvProxy(
        { ALL_PROXY: "socks5://127.0.0.1:1080", NO_PROXY: "*.googleapis.com" },
        "https://daily-cloudcode-pa.googleapis.com",
      ),
      null,
    );

    const authProxy = parseProxyUrl("http://alice:pw@127.0.0.1:7897", "manual");
    assert.equal(authProxy.hasAuth, true);
    assert.equal(authProxy.authHeader, `Basic ${Buffer.from("alice:pw").toString("base64")}`);
    assert.equal(JSON.stringify(authProxy).includes("pw"), false);

    const ipv6Summary = summarizeLsConnections(
      [{ local: "[::1]:50111", remote: "[::1]:7897", state: "ESTABLISHED", pid: "888" }],
      {
        fallbackPids: ["888"],
        proxy: { enabled: true, host: "localhost", port: 7897 },
      },
    );
    assert.equal(ipv6Summary.proxyConns, 1);
    assert.equal(ipv6Summary.route, "proxy");
  });

  it("probeViaProxy 正确发送 SOCKS5 握手与 HTTP Basic 鉴权头", async () => {
    const socksSrv = net.createServer((sock) => {
      let stage = 0;
      sock.on("data", (buf) => {
        if (stage === 0) {
          stage = 1;
          assert.deepEqual([...buf], [0x05, 0x01, 0x00]);
          sock.write(Buffer.from([0x05, 0x00]));
        } else {
          assert.equal(buf[0], 0x05);
          assert.equal(buf[1], 0x01);
          assert.equal(buf[3], 0x03);
          const len = buf[4];
          assert.equal(buf.subarray(5, 5 + len).toString("ascii"), "daily-cloudcode-pa.googleapis.com");
          assert.equal(buf.readUInt16BE(5 + len), 443);
          sock.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        }
      });
    });
    await new Promise((r) => socksSrv.listen(0, "127.0.0.1", r));
    const socksRes = await probeViaProxy(
      "https://daily-cloudcode-pa.googleapis.com",
      { enabled: true, protocol: "socks5", host: "127.0.0.1", port: socksSrv.address().port },
      1500,
    );
    socksSrv.close();
    assert.equal(socksRes.ok, false);
    assert.match(socksRes.error, /SOCKS5 隧道失败/);

    let receivedReq = "";
    const httpProxySrv = net.createServer((sock) => {
      sock.on("data", (chunk) => {
        receivedReq += chunk.toString("utf8");
        if (receivedReq.includes("\r\n\r\n")) {
          sock.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
        }
      });
    });
    await new Promise((r) => httpProxySrv.listen(0, "127.0.0.1", r));
    const authCfg = parseProxyUrl(`http://alice:pw@127.0.0.1:${httpProxySrv.address().port}`, "manual");
    const httpRes = await probeViaProxy("https://daily-cloudcode-pa.googleapis.com", authCfg, 1500);
    httpProxySrv.close();
    assert.equal(httpRes.ok, false);
    assert.match(receivedReq, /Proxy-Authorization: Basic YWxpY2U6cHc=/);
  });

  it("支持 BypassList/ProxyOverride、DefaultConnectionSettings 开关、SOCKS5 IP ATYP 与非法 URL 防护", async () => {
    const winWithBypass = parseWindowsRegistryProxy(
      [
        "    ProxyEnable    REG_DWORD    0x1",
        "    ProxyServer    REG_SZ    127.0.0.1:7897",
        "    ProxyOverride  REG_SZ    localhost;127.*;*.googleapis.com;<local>",
      ].join("\r\n"),
    );
    assert.deepEqual(winWithBypass, {
      enabled: true,
      host: "127.0.0.1",
      port: 7897,
      source: "windows-registry",
    });
    assert.equal(
      isNoProxyTarget("https://daily-cloudcode-pa.googleapis.com", null, winWithBypass.bypassList),
      true,
    );
    assert.equal(isNoProxyTarget("https://127.0.0.9:8443", null, winWithBypass.bypassList), true);
    assert.equal(isNoProxyTarget("http://intranet/health", null, winWithBypass.bypassList), true);
    assert.equal(isNoProxyTarget("https://api.example.com", null, winWithBypass.bypassList), false);

    const stalePacReg = [
      "    ProxyEnable    REG_DWORD    0x0",
      "    AutoConfigURL  REG_SZ       http://127.0.0.1:7890/pac.js",
    ].join("\r\n");
    const flagsOffConn = "    DefaultConnectionSettings    REG_BINARY    460000000100000001000000";
    assert.equal(parseWindowsRegistryProxy(stalePacReg, flagsOffConn), null);

    const flagsPacOnConn = "    DefaultConnectionSettings    REG_BINARY    460000000100000005000000";
    assert.equal(parseWindowsRegistryProxy(stalePacReg, flagsPacOnConn)?.source, "windows-pac-unsupported");

    const scutilExceptions = parseScutilProxy(
      [
        "<dictionary> {",
        "  HTTPEnable : 1",
        "  HTTPProxy : 127.0.0.1",
        "  HTTPPort : 7897",
        "  ExceptionsList : <array> {",
        "    0 : *.local",
        "    1 : 169.254/16",
        "    2 : daily-cloudcode-pa.googleapis.com",
        "  }",
        "}",
      ].join("\n"),
    );
    assert.equal(
      isNoProxyTarget("https://daily-cloudcode-pa.googleapis.com", null, scutilExceptions.bypassList),
      true,
    );
    assert.equal(isNoProxyTarget("https://169.254.10.5", null, scutilExceptions.bypassList), true);

    assert.equal(parseProxyUrl("127.0.0.1", "manual"), null);
    assert.equal(parseProxyUrl("https://127.0.0.1:7897", "manual"), null);
    assert.equal(parseProxyUrl("socks4://127.0.0.1:1080", "manual"), null);

    const badUrlRes = await probeViaProxy(
      "https://not a url",
      { enabled: true, host: "127.0.0.1", port: 7897 },
      500,
    );
    assert.equal(badUrlRes.ok, false);
    assert.match(badUrlRes.error, /URL/);

    const socksIpSrv = net.createServer((sock) => {
      let stage = 0;
      sock.on("data", (buf) => {
        if (stage === 0) {
          stage = 1;
          sock.write(Buffer.from([0x05, 0x00]));
        } else {
          assert.equal(buf[3], 0x01);
          assert.deepEqual([...buf.subarray(4, 8)], [127, 0, 0, 9]);
          assert.equal(buf.readUInt16BE(8), 443);
          sock.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        }
      });
    });
    await new Promise((r) => socksIpSrv.listen(0, "127.0.0.1", r));
    const ipRes = await probeViaProxy(
      "https://127.0.0.9",
      { enabled: true, protocol: "socks5", host: "127.0.0.1", port: socksIpSrv.address().port },
      1500,
    );
    socksIpSrv.close();
    assert.equal(ipRes.ok, false);
    assert.match(ipRes.error, /SOCKS5 隧道失败/);
  });
});
