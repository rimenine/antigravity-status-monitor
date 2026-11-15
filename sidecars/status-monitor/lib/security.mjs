import { randomBytes, timingSafeEqual } from "node:crypto";

const LOOPBACK_ORIGIN_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;
const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/i;
const SAFE_APP_ORIGIN_RE = /^(?:plugin|vscode-webview|file):/i;

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function getHeader(req, name) {
  const val = req?.headers?.[name.toLowerCase()];
  return Array.isArray(val) ? val[0] : val;
}

export function isJsonContentType(req) {
  const ct = getHeader(req, "content-type") || "";
  const mime = ct.split(";")[0].trim().toLowerCase();
  return mime === "application/json";
}

export function isAllowedHost(req, { allowMissing = false } = {}) {
  const host = getHeader(req, "host");
  if (host === undefined) return allowMissing;
  if (typeof host !== "string") return false;
  const m = LOOPBACK_HOST_RE.exec(host.trim());
  if (!m) return false;
  if (m[2] !== undefined) {
    const port = Number(m[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  }
  return true;
}

export function isAllowedOrigin(req) {
  const origin = getHeader(req, "origin");
  if (!origin) return true;
  if (origin === "null") return false;
  return LOOPBACK_ORIGIN_RE.test(origin) || SAFE_APP_ORIGIN_RE.test(origin);
}

function verifyBrowserContext(req) {
  if (!isAllowedHost(req, { allowMissing: true })) {
    return { ok: false, status: 403, error: "Forbidden host" };
  }
  const fetchSite = getHeader(req, "sec-fetch-site");
  if (fetchSite && String(fetchSite).trim().toLowerCase() === "cross-site") {
    return { ok: false, status: 403, error: "Forbidden cross-site request" };
  }
  if (!isAllowedOrigin(req)) {
    return { ok: false, status: 403, error: "Forbidden origin" };
  }
  return { ok: true };
}

function verifyBasePost(req) {
  const ctx = verifyBrowserContext(req);
  if (!ctx.ok) return ctx;
  if (!isJsonContentType(req)) {
    return { ok: false, status: 415, error: "Content-Type must be application/json" };
  }
  return { ok: true };
}

function verifyTokenValue(provided, expected, errMsg) {
  if (!safeEqual(provided, expected)) {
    return { ok: false, status: 401, error: errMsg };
  }
  return { ok: true };
}

export function createSecurityGuard({
  uiToken,
  hookToken,
} = {}) {
  const resolvedUiToken =
    String(uiToken ?? process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN ?? "").trim() ||
    randomBytes(24).toString("hex");
  const resolvedHookToken =
    String(hookToken ?? "").trim() || randomBytes(24).toString("hex");

  function verifyUiGet(req, url) {
    const ctx = verifyBrowserContext(req);
    if (!ctx.ok) return ctx;
    const provided =
      getHeader(req, "x-sidecar-token") || url?.searchParams?.get("token") || "";
    return verifyTokenValue(provided, resolvedUiToken, "Invalid or missing X-Sidecar-Token");
  }

  function verifyUiPost(req, url) {
    const base = verifyBasePost(req);
    if (!base.ok) return base;
    const provided =
      getHeader(req, "x-sidecar-token") || url?.searchParams?.get("token") || "";
    return verifyTokenValue(provided, resolvedUiToken, "Invalid or missing X-Sidecar-Token");
  }

  function verifyHookPost(req) {
    const base = verifyBasePost(req);
    if (!base.ok) return base;
    const provided = getHeader(req, "x-hook-token") || "";
    return verifyTokenValue(provided, resolvedHookToken, "Invalid or missing X-Hook-Token");
  }

  return {
    uiToken: resolvedUiToken,
    hookToken: resolvedHookToken,
    hasUiToken: Boolean(resolvedUiToken),
    verifyUiGet,
    verifyUiPost,
    verifyHookPost,
  };
}
