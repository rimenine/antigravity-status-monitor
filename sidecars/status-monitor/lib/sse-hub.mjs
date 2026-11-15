import { BASE_SECURITY_HEADERS } from "./http-helpers.mjs";
import { normalizeConvId } from "./timeline-store.mjs";

const PINNED_CONV_TTL_MS = 60_000;
const SSE_HEARTBEAT_INTERVAL_MS = 10_000;

/** 管理 SSE 订阅连接、差异帧缓存及各窗口已绑定的活跃会话集合（不含跨会话自动切换）。 */
export function createSseHub({ getSnapshot, getSdkConvId = () => null } = {}) {
  const sseClients = new Map();
  const recentRequestedConvs = new Map();
  const lastSseStateByConv = new Map();

  function recordRequestedConv(convId) {
    const normalized = normalizeConvId(convId);
    if (!normalized) return;
    const now = Date.now();
    recentRequestedConvs.set(normalized, now);
    if (recentRequestedConvs.size > 32) {
      for (const [k, ts] of recentRequestedConvs.entries()) {
        if (now - ts > PINNED_CONV_TTL_MS) recentRequestedConvs.delete(k);
      }
    }
  }

  function getPinnedConvIds(now = Date.now()) {
    const pinnedConvIds = new Set();
    const sdkConvId = normalizeConvId(getSdkConvId());
    if (sdkConvId) pinnedConvIds.add(sdkConvId);
    for (const cid of sseClients.values()) {
      if (cid) pinnedConvIds.add(cid);
    }
    for (const [cid, ts] of recentRequestedConvs.entries()) {
      if (now - ts <= PINNED_CONV_TTL_MS) {
        pinnedConvIds.add(cid);
      } else {
        recentRequestedConvs.delete(cid);
      }
    }
    return pinnedConvIds;
  }

  function getPreferredConvId() {
    const sdkConvId = normalizeConvId(getSdkConvId());
    if (sdkConvId) return sdkConvId;
    for (const cid of sseClients.values()) {
      if (cid) return cid;
    }
    let latestCid = null;
    let latestTs = -1;
    const now = Date.now();
    for (const [cid, ts] of recentRequestedConvs.entries()) {
      if (now - ts <= PINNED_CONV_TTL_MS && ts > latestTs) {
        latestTs = ts;
        latestCid = cid;
      }
    }
    return latestCid;
  }

  function detachClient(res, destroy = false) {
    sseClients.delete(res);
    if (destroy) {
      try {
        if (!res.destroyed) res.destroy();
      } catch {
      }
    }
  }

  function buildSseDiffKey(snap) {
    const isIdle = snap.verdict?.phase === "idle";
    const normalizedVerdict =
      snap.verdict && isIdle
        ? {
            ...snap.verdict,
            silentSec: snap.verdict.silentSec == null ? null : Math.floor(snap.verdict.silentSec / 5),
            hookAgeSec: snap.verdict.hookAgeSec == null ? null : Math.floor(snap.verdict.hookAgeSec / 5),
            activityAgeSec:
              snap.verdict.activityAgeSec == null ? null : Math.floor(snap.verdict.activityAgeSec / 5),
          }
        : snap.verdict;
    return JSON.stringify({
      ...snap,
      now: 0,
      verdict: normalizedVerdict,
    });
  }

  function attachClient(req, res, requestedConvId = null) {
    const boundConvId = normalizeConvId(requestedConvId) || normalizeConvId(getSdkConvId());
    res.writeHead(200, {
      ...BASE_SECURITY_HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    const cleanup = () => detachClient(res);
    req.on("close", cleanup);
    req.on("aborted", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);

    const initSnap = getSnapshot(boundConvId);
    const initKey = boundConvId || "";
    lastSseStateByConv.set(initKey, { diffKey: buildSseDiffKey(initSnap), sentAt: Date.now() });
    try {
      res.write(`event: state\ndata: ${JSON.stringify(initSnap)}\n\n`);
      if (!res.writableEnded && !res.destroyed) {
        sseClients.set(res, boundConvId);
      }
    } catch {
      detachClient(res, true);
    }
  }

  function broadcastState({ force = false } = {}) {
    if (sseClients.size === 0) return;
    const now = Date.now();
    const frameByConv = new Map();
    const activeKeys = new Set();

    for (const [res, convId] of sseClients.entries()) {
      if (res.writableEnded || res.destroyed) {
        detachClient(res);
        continue;
      }
      const key = convId || "";
      activeKeys.add(key);
      let entry = frameByConv.get(key);
      if (!entry) {
        const snap = getSnapshot(convId || null);
        const diffKey = buildSseDiffKey(snap);
        const prev = lastSseStateByConv.get(key);
        const changed =
          force || !prev || prev.diffKey !== diffKey || now - prev.sentAt >= SSE_HEARTBEAT_INTERVAL_MS;
        entry = changed
          ? { changed: true, diffKey, payload: `event: state\ndata: ${JSON.stringify(snap)}\n\n` }
          : { changed: false };
        if (changed) {
          lastSseStateByConv.set(key, { diffKey, sentAt: now });
        }
        frameByConv.set(key, entry);
      }
      if (!entry.changed) continue;
      try {
        res.write(entry.payload);
      } catch {
        detachClient(res, true);
      }
    }

    for (const key of lastSseStateByConv.keys()) {
      if (!activeKeys.has(key)) lastSseStateByConv.delete(key);
    }
  }

  function closeAll() {
    for (const res of sseClients.keys()) {
      try {
        res.end();
      } catch {
      }
    }
    sseClients.clear();
  }

  return {
    recordRequestedConv,
    getPinnedConvIds,
    getPreferredConvId,
    attachClient,
    broadcastState,
    closeAll,
    getClientCount: () => sseClients.size,
  };
}
