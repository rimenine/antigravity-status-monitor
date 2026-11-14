import { randomBytes, timingSafeEqual } from "node:crypto";

const LOOPBACK_ORIGIN_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;
const SAFE_APP_ORIGIN_RE = /^(?:plugin|vscode-webview|file):/i;

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function getHeader(req, name) {
  const val = req.headers[name.toLowerCase()];
  return Array.isArray(val) ? val[0] : val;
}

export function isJsonContentType(req) {
  const ct = getHeader(req, "content-type") || "";
  const mime = ct.split(";")[0].trim().toLowerCase();
  return mime === "application/json";
}

export function isAllowedOrigin(req) {
  const origin = getHeader(req, "origin");
  if (!origin) return true;
  if (origin === "null") return false;
  return LOOPBACK_ORIGIN_RE.test(origin) || SAFE_APP_ORIGIN_RE.test(origin);
}

function verifyBasePost(req) {
  if (!isAllowedOrigin(req)) {
    return { ok: false, status: 403, error: "Forbidden origin" };
  }
  if (!isJsonContentType(req)) {
    return { ok: false, status: 415, error: "Content-Type must be application/json" };
  }
  return { ok: true };
}

export function createSecurityGuard({
  uiToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || "",
  hookToken = randomBytes(24).toString("hex"),
} = {}) {
  function verifyUiPost(req, url) {
    const base = verifyBasePost(req);
    if (!base.ok) return base;
    if (uiToken) {
      const provided =
        getHeader(req, "x-sidecar-token") || url.searchParams.get("token") || "";
      if (!safeEqual(provided, uiToken)) {
        return { ok: false, status: 401, error: "Invalid or missing X-Sidecar-Token" };
      }
    }
    return { ok: true };
  }

  function verifyHookPost(req) {
    const base = verifyBasePost(req);
    if (!base.ok) return base;
    if (hookToken) {
      const provided = getHeader(req, "x-hook-token") || "";
      if (!safeEqual(provided, hookToken)) {
        return { ok: false, status: 401, error: "Invalid or missing X-Hook-Token" };
      }
    }
    return { ok: true };
  }

  return {
    hookToken,
    hasUiToken: Boolean(uiToken),
    verifyUiPost,
    verifyHookPost,
  };
}
