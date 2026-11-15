import { readFileSync } from "node:fs";
import { join } from "node:path";

export const BASE_SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; connect-src 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

export const STATIC_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "application/javascript; charset=utf-8"],
  "/js/i18n.js": ["js/i18n.js", "application/javascript; charset=utf-8"],
  "/js/format.js": ["js/format.js", "application/javascript; charset=utf-8"],
  "/js/render.js": ["js/render.js", "application/javascript; charset=utf-8"],
  "/js/client.js": ["js/client.js", "application/javascript; charset=utf-8"],
};

const MAX_JSON_BODY_BYTES = 256 * 1024;

/** 安全读取并解析限制体积内的 JSON 请求体。 */
export function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      rejectBody(err);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_JSON_BODY_BYTES) {
        const err = new Error("Payload too large");
        err.status = 413;
        req.pause();
        fail(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolveBody(raw.trim() ? JSON.parse(raw) : {});
      } catch (err) {
        err.status = 400;
        rejectBody(err);
      }
    });
    req.on("error", fail);
  });
}

/** 统一发送附带安全头的 JSON 响应；遇到 413 超限响应时主动关闭底层连接。 */
export function sendJson(res, status, data, req = null) {
  const body = JSON.stringify(data);
  const headers = {
    ...BASE_SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body, "utf8"),
  };
  if (status === 413) {
    headers.Connection = "close";
  }
  res.writeHead(status, headers);
  if (status === 413 && req) {
    res.end(body, () => {
      try {
        req.destroy();
      } catch {
      }
    });
    return;
  }
  res.end(body);
}

/** 根据静态白名单返回前端资源。 */
export function sendStaticAsset(pathname, publicDir, res) {
  const entry = STATIC_FILES[pathname];
  if (!entry) return false;
  const [filename, contentType] = entry;
  try {
    const content = readFileSync(join(publicDir, filename));
    res.writeHead(200, {
      ...BASE_SECURITY_HEADERS,
      "Content-Type": contentType,
      "Content-Length": content.byteLength,
    });
    res.end(content);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`Failed to load ${filename}: ${err.message}`);
  }
  return true;
}

/** 返回 /preload.js 桥接脚本（standalone 模式下为空脚本以保持零报错加载）。 */
export function sendPreloadScript(js, res) {
  const body = js || "";
  res.writeHead(200, {
    ...BASE_SECURITY_HEADERS,
    "Content-Type": "application/javascript; charset=utf-8",
    "Content-Length": Buffer.byteLength(body, "utf8"),
  });
  res.end(body);
}
