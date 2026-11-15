import { isNoProxyTarget, normalizeIp, splitHostPort } from "./proxy-bypass.mjs";
import { detectUnixSystemProxy, detectWindowsRegistryProxy, parseScutilProxy, parseWindowsRegistryProxy } from "./proxy-system.mjs";
import { getEnvProxy, parseProxyUrl, validateProxyInput } from "./proxy-url.mjs";

export { isNoProxyTarget, normalizeIp, splitHostPort };
export { parseScutilProxy, parseWindowsRegistryProxy };
export { getEnvProxy, parseProxyUrl, validateProxyInput };

let proxyCache = { checkedAt: 0, proxy: null };

/** 清空系统代理缓存（代理设置变更后调用）。 */
export function invalidateProxyCache() {
  proxyCache = { checkedAt: 0, proxy: null };
}

/** 按优先级检测当前生效代理：手动代理 -> NO_PROXY/环境变量 -> 操作系统代理设置。 */
export async function detectProxyConfig(targetUrl = "", manualOrOpts = "") {
  const opts =
    typeof manualOrOpts === "object" && manualOrOpts !== null
      ? manualOrOpts
      : { manualProxyUrl: manualOrOpts, forceRefresh: false };
  const manualProxyUrl = opts.manualProxyUrl || "";
  const forceRefresh = Boolean(opts.forceRefresh);

  const manual = parseProxyUrl(manualProxyUrl, "manual");
  if (manual) return manual;

  if (targetUrl && isNoProxyTarget(targetUrl, process.env)) {
    return { enabled: false, source: "no-proxy" };
  }

  const envProxy = getEnvProxy(process.env, targetUrl);
  if (envProxy) return envProxy;

  const now = Date.now();
  let cachedProxy =
    !forceRefresh && now - proxyCache.checkedAt < 5000 && proxyCache.proxy
      ? proxyCache.proxy
      : null;

  if (!cachedProxy) {
    const detected =
      process.platform === "win32"
        ? await detectWindowsRegistryProxy()
        : await detectUnixSystemProxy(process.platform);

    cachedProxy = detected || { enabled: false, source: "none" };
    proxyCache = { checkedAt: now, proxy: cachedProxy };
  }

  if (
    cachedProxy.enabled &&
    cachedProxy.bypassList?.length &&
    isNoProxyTarget(targetUrl, null, cachedProxy.bypassList)
  ) {
    return { enabled: false, source: "no-proxy" };
  }
  return cachedProxy;
}
