function normalizeLang(lang) {
  return lang === "en" ? "en" : "zh";
}

const VERDICT_COPY = {
  zh: {
    SIMULATED_DOWN: () => ({
      headline: "假性工作中 · VPN / 网络已断开（模拟预览）",
      summary: "已触发模拟断网告警：可直观查看断网挂起时的面板视觉提醒与通知效果。",
    }),
    LS_DOWN: ({ elapsedSec }) => ({
      headline: "异常挂起 · Language Server 失联",
      summary: `Agent 已等待 ${elapsedSec}s，但宿主 Language Server 进程或 healthz 接口不可达，请检查客户端状态。`,
    }),
    NET_DOWN_HANG: ({ elapsedSec, consecutiveFailures }) => ({
      headline: "假性工作中 · VPN / 网络已断开",
      summary: `Agent 已等待模型 ${elapsedSec}s，但上游 HTTPS 连续 ${consecutiveFailures} 次探测失败，请求大概率正在挂起！`,
    }),
    LS_SYN_STALL: ({ synSent443 }) => ({
      headline: "连接受阻 · Language Server 握手卡住",
      summary: `检测到 Language Server 有 ${synSent443} 条 443 连接卡在 SYN_SENT 状态，VPN 节点可能无响应。`,
    }),
    NET_SUSPECT: ({ elapsedSec }) => ({
      headline: "网络抖动 · 正在复测连通性",
      summary: `正在等待模型响应（${elapsedSec}s），最近一次网络探测失败，正在进行二次确认…`,
    }),
    MODEL_STALL: ({ silentSec }) => ({
      headline: "响应较慢 · 疑似模型端卡顿",
      summary: `网络探针正常，但已 ${silentSec}s 无新响应或日志写入，模型可能正在深度思考或排队超时。`,
    }),
    WAITING_LLM: ({ elapsedSec }) => ({
      headline: "真实工作中 · 等待模型响应",
      summary: `网络链路正常，已持续等待 ${elapsedSec}s，正在接收或等待模型输出。`,
    }),
    RUNNING_TOOL: ({ toolLabel }) => ({
      headline: "真实工作中 · 本地执行工具",
      summary: `正在执行 ${toolLabel || "本地工具"}（本地任务阶段，不依赖 VPN 上游流）。`,
    }),
    OFFLINE_IDLE: () => ({
      headline: "空闲待命 · VPN / 网络未连接",
      summary: "当前无进行中任务，但上游网络探测失败，发送新消息前请先恢复 VPN。",
    }),
    IDLE_OK: ({ latencyMs }) => ({
      headline: "空闲待命 · 网络正常",
      summary:
        latencyMs != null
          ? `上游连通正常（${latencyMs} ms），随时可以发起对话。`
          : "等待首次网络探测完成…",
    }),
  },
  en: {
    SIMULATED_DOWN: () => ({
      headline: "Simulated Hang · Upstream Unreachable",
      summary: "Preview alert active: inspect the hang banner and desktop notification behavior.",
    }),
    LS_DOWN: ({ elapsedSec }) => ({
      headline: "Hung · Language Server Unreachable",
      summary: `Agent waited ${elapsedSec}s, but host Language Server or /healthz is unreachable.`,
    }),
    NET_DOWN_HANG: ({ elapsedSec, consecutiveFailures }) => ({
      headline: "False Working · Upstream Unreachable",
      summary: `Agent has waited ${elapsedSec}s while upstream HTTPS failed ${consecutiveFailures} probes in a row. Request is likely hung!`,
    }),
    LS_SYN_STALL: ({ synSent443 }) => ({
      headline: "Blocked · Language Server Handshake Stalled",
      summary: `Detected ${synSent443} Language Server TLS (443) sockets stuck in SYN_SENT. Upstream route or proxy may be unresponsive.`,
    }),
    NET_SUSPECT: ({ elapsedSec }) => ({
      headline: "Network Jitter · Re-testing Connectivity",
      summary: `Waiting for model (${elapsedSec}s); latest probe failed and is being re-verified…`,
    }),
    MODEL_STALL: ({ silentSec }) => ({
      headline: "Slow Response · Possible Model Stall",
      summary: `Network probes pass, but no response or log update arrived for ${silentSec}s. The model may be thinking or queued.`,
    }),
    WAITING_LLM: ({ elapsedSec }) => ({
      headline: "Working · Waiting for Model Response",
      summary: `Network healthy. Waiting ${elapsedSec}s for next model output or stream flush.`,
    }),
    RUNNING_TOOL: ({ toolLabel }) => ({
      headline: "Working · Running Local Tool",
      summary: `Executing ${toolLabel || "local tool"} (local step, does not depend on the upstream stream).`,
    }),
    OFFLINE_IDLE: () => ({
      headline: "Idle · Upstream Unreachable",
      summary: "No active turn, but upstream probes failed. Check network or proxy before sending a prompt.",
    }),
    IDLE_OK: ({ latencyMs }) => ({
      headline: "Idle · Network Healthy",
      summary:
        latencyMs != null
          ? `Upstream reachable (${latencyMs} ms). Ready for prompts.`
          : "Waiting for initial network probe…",
    }),
  },
};

export function formatVerdictCopy(key, params = {}, lang = "zh") {
  const l = normalizeLang(lang);
  const fn = VERDICT_COPY[l][key] || VERDICT_COPY.zh[key];
  return fn ? fn(params) : { headline: "", summary: "" };
}

const EVENT_COPY = {
  zh: {
    TOOL_STEP: ({ tools, shortConv, stepIdx }) => ({
      title: `执行工具: ${tools}`,
      detail: [shortConv, `Step #${stepIdx}`].filter(Boolean).join(" · "),
    }),
    HOOK_PRE_INVOCATION: ({ shortConv, invocationNum }) => ({
      title: "开始请求模型 (PreInvocation)",
      detail: [
        shortConv,
        invocationNum != null ? `第 ${invocationNum} 次模型调用` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    }),
    HOOK_STOP: ({ reason, error, shortConv }) => ({
      title: `回合结束 (${reason})`,
      detail: error || shortConv || "",
    }),
    NET_RECOVERED: ({ latencyMs }) => ({
      title: "VPN / 上游网络已恢复",
      detail: `延迟 ${latencyMs} ms`,
    }),
    NET_FAILED: ({ error }) => ({
      title: "上游网络连续探测失败",
      detail: error || "超时",
    }),
    SIM_ON: () => ({
      title: "开启断网警报预览",
      detail: "持续 15 秒，可随时点击关闭",
    }),
    SIM_OFF: () => ({
      title: "关闭断网警报预览",
      detail: "",
    }),
    PAC_UNSUPPORTED: ({ pacUrl }) => ({
      title: "检测到系统 PAC 自动代理",
      detail: `暂不支持解析 PAC 脚本，已按直连探测（可在设置中手动填代理）(${pacUrl || "AutoConfigURL"})`,
    }),
  },
  en: {
    TOOL_STEP: ({ tools, shortConv, stepIdx }) => ({
      title: `Tool: ${tools}`,
      detail: [shortConv, `Step #${stepIdx}`].filter(Boolean).join(" · "),
    }),
    HOOK_PRE_INVOCATION: ({ shortConv, invocationNum }) => ({
      title: "Requesting Model (PreInvocation)",
      detail: [shortConv, invocationNum != null ? `Call #${invocationNum}` : ""]
        .filter(Boolean)
        .join(" · "),
    }),
    HOOK_STOP: ({ reason, error, shortConv }) => ({
      title: `Turn Finished (${reason})`,
      detail: error || shortConv || "",
    }),
    NET_RECOVERED: ({ latencyMs }) => ({
      title: "Upstream Connection Restored",
      detail: `Latency ${latencyMs} ms`,
    }),
    NET_FAILED: ({ error }) => ({
      title: "Upstream Probes Failing",
      detail: error || "Timeout",
    }),
    SIM_ON: () => ({
      title: "Disconnect Alert Preview On",
      detail: "Active for 15s (click to stop)",
    }),
    SIM_OFF: () => ({
      title: "Disconnect Alert Preview Off",
      detail: "",
    }),
    PAC_UNSUPPORTED: ({ pacUrl }) => ({
      title: "System PAC Proxy Detected",
      detail: `PAC scripts are unsupported; probing direct (set manual proxy if needed) (${pacUrl || "AutoConfigURL"})`,
    }),
  },
};

export function resolveEventText(ev, lang = "zh") {
  if (!ev?.i18n?.key) return ev;
  const l = normalizeLang(lang);
  const fn = EVENT_COPY[l][ev.i18n.key];
  if (!fn) return ev;
  const { title, detail } = fn(ev.i18n.params || {});
  return { ...ev, title, detail };
}

function normalizeNotificationInput(input) {
  if (typeof input === "object" && input !== null) {
    return {
      simulated: Boolean(input.simulated),
      messageKey: String(input.messageKey || "NET_DOWN_HANG"),
    };
  }
  return {
    simulated: Boolean(input),
    messageKey: "NET_DOWN_HANG",
  };
}

export function getNotificationText(input, lang = "zh") {
  const { simulated, messageKey } = normalizeNotificationInput(input);
  const isLsDown = !simulated && messageKey === "LS_DOWN";

  if (normalizeLang(lang) === "en") {
    if (isLsDown) {
      return {
        title: "Antigravity: Language Server Unreachable",
        message:
          'Conversation appears "Working", but host Language Server or /healthz is unreachable.',
      };
    }
    return {
      title: simulated
        ? "Antigravity: Upstream Hang Alert (Preview)"
        : "Antigravity: Upstream Connection Lost",
      message: simulated
        ? "Preview notification for silent hang alert."
        : 'Conversation appears "Working", but upstream HTTPS probes failed. Check your network or proxy.',
    };
  }

  if (isLsDown) {
    return {
      title: "Antigravity：Language Server 失联",
      message:
        "当前对话仍显示工作中，但宿主 Language Server 进程或 healthz 接口不可达，请检查客户端状态。",
    };
  }
  return {
    title: simulated
      ? "Antigravity：检测到 VPN / 网络断开（预览）"
      : "Antigravity：检测到 VPN / 网络断开",
    message: simulated
      ? "这是一条断网挂起告警的模拟通知预览。"
      : "当前对话仍显示工作中，但上游网络已连续超时，请检查 VPN 连接。",
  };
}
