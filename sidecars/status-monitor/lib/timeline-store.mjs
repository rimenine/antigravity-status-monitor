import { resolveEventText } from "./i18n.mjs";

const GLOBAL_EVENT_KINDS = new Set(["net", "probe"]);

/**
 * 规范化会话 ID，屏蔽空值及已废弃的 "auto" 切换标识。
 */
export function normalizeConvId(convId) {
  if (typeof convId !== "string") return null;
  const trimmed = convId.trim();
  if (!trimmed || trimmed === "auto") return null;
  return trimmed;
}

/**
 * 按会话物理分桶的时间线事件仓库。
 * 每个对话拥有独立事件桶，避免并行会话或后台子代理写入时相互混入或挤占容量。
 */
export function createTimelineStore({ maxPerBucket = 40, maxGlobalNet = 20 } = {}) {
  const buckets = new Map();
  const globalNetEvents = [];
  let seqCounter = 0;

  function pushToBucket(key, item, limit) {
    let list = buckets.get(key);
    if (!list) {
      list = [];
      buckets.set(key, list);
    }
    list.unshift(item);
    if (list.length > limit) {
      list.length = limit;
    }
  }

  function push(
    kind,
    title,
    detail = "",
    level = "info",
    conversationId = null,
    i18n = null,
  ) {
    seqCounter += 1;
    const scopedConvId = normalizeConvId(conversationId);
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      seq: seqCounter,
      ts: Date.now(),
      kind,
      title,
      detail,
      level,
      conversationId: scopedConvId && scopedConvId !== "default" ? scopedConvId : null,
      ...(i18n ? { i18n } : {}),
    };

    if (entry.conversationId) {
      pushToBucket(entry.conversationId, entry, maxPerBucket);
      return entry;
    }

    if (GLOBAL_EVENT_KINDS.has(kind)) {
      globalNetEvents.unshift(entry);
      if (globalNetEvents.length > maxGlobalNet) {
        globalNetEvents.length = maxGlobalNet;
      }
      return entry;
    }

    pushToBucket("default", entry, maxPerBucket);
    return entry;
  }

  function sortNewestFirst(items) {
    return items.sort((a, b) => (b.ts - a.ts) || (b.seq - a.seq));
  }

  function listForConversation(convId = null, lang = "zh") {
    const normalized = normalizeConvId(convId);
    const bucketKey = normalized || "default";
    const convEvents = buckets.get(bucketKey) || [];
    const combined = sortNewestFirst([...convEvents, ...globalNetEvents]);
    return combined.map((ev) => resolveEventText(ev, lang));
  }

  function listAllRaw() {
    const all = [...globalNetEvents];
    for (const list of buckets.values()) {
      all.push(...list);
    }
    return sortNewestFirst(all);
  }

  return {
    push,
    listForConversation,
    listAllRaw,
  };
}
