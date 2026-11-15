const ICONS = {
  ok: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  active: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
  tool: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
  warning: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  danger: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
};

const GLOW_COLORS = {
  ok: "var(--mon-ok-soft)",
  active: "var(--mon-accent-soft)",
  tool: "var(--mon-tool-soft)",
  warning: "var(--mon-warn-soft)",
  danger: "var(--mon-danger-soft)",
  neutral: "var(--mon-accent-soft)",
};

const I18N = {
  zh: {
    htmlLang: "zh-CN",
    docTitle: "反重力实时状态监控",
    sseDotTitle: "本地监控服务连接状态（自适应短连接轮询）",
    brandTitle: "反重力实时状态监控",
    btnProbeTitle: "立即探测一次网络",
    btnProbe: "探测",
    btnSimTitle: "模拟 VPN 断开挂起效果（15s）",
    btnSimStart: "预览告警",
    btnSimStop: "停止预览",
    btnSettingsTitle: "展开/收起设置",
    btnSettingsAria: "设置",
    convSelectAria: "选择监控会话",
    convAutoOpt: "自动跟随活跃",
    convPinnedOpt: (id) => `本窗口 #${id.slice(0, 6)}`,
    convItemOpt: (id, active) => `${active ? "● " : ""}#${id.slice(0, 8)}${active ? " (运行中)" : ""}`,
    convActiveHint: (id) => `检测到活跃会话 #${id.slice(0, 8)}，可切换下拉框为“自动跟随活跃”`,
    actionTimeout: "请求超时，请检查本地 Sidecar 服务状态",
    actionFailedPrefix: "操作失败: ",
    initBadge: "初始化中",
    initHeadline: "正在连接本地监控探针…",
    initSummary: "正在读取 Hooks 状态、对话日志与网络探针。",
    authDeniedBadge: "AUTH · 鉴权拦截",
    authDeniedHeadline: "缺少或无效的访问令牌",
    authDeniedSummary: "请在 Antigravity 中打开面板，或使用启动日志输出的带 ?token=... URL 访问。",
    alertLeadHtml: "<strong>建议操作：</strong>当前主界面可能仍显示“工作中”，但请求已被断网阻塞。",
    alertSteps: "1. 检查 VPN / 代理是否掉线并重连；2. 若恢复后仍卡住，可点击取消当前回答后重试。",
    chartTitle: "VPN / 上游 HTTPS 探针曲线",
    statNow: "当前",
    statAvg: "均值",
    statRate: "可用率",
    chartWait: "等待首次探测…",
    cardAgent: "Agent 心跳",
    cardNet: "网络链路",
    cardLs: "Language Server",
    tokenTitle: "Token 计量统计",
    tokLastLabel: "本轮上下文",
    tokSessLabel: "本会话累计",
    tokTodayLabel: "今日全部会话",
    tokBarTitle: "本会话 Token 构成占比",
    legInput: "输入",
    legCache: "缓存读取",
    legOut: "输出",
    settingsTitle: "监控配置",
    settingLang: "语言 / Language",
    settingInterval: "探测频率",
    settingStall: "卡顿预警阈值",
    settingProbeUrl: "探测目标",
    settingManualProxy: "手动代理（留空自动）",
    settingTheme: "界面主题",
    settingNotify: "断网挂起时发送系统桌面通知",
    interval2s: "每 2 秒（灵敏）",
    interval3s: "每 3 秒（推荐）",
    interval5s: "每 5 秒（省电）",
    stall15: "15 秒无新步骤",
    stall25: "25 秒无新步骤",
    stall45: "45 秒无新步骤",
    probeCloudCode: "Cloud Code 上游接口 (默认)",
    themeAuto: "跟随 Antigravity / 系统",
    themeDark: "深色 Obsidian",
    themeLight: "浅色极简",
    timelineTitle: "实时事件流（Hooks & 网络变化）",
    timelineEmpty: "暂无事件，发起一次对话或等待探针变化后将自动显示",
    badges: {
      IDLE: "IDLE · 空闲",
      OFFLINE_IDLE: "OFFLINE · 断网",
      WAITING_LLM: "WORKING · 模型",
      RUNNING_TOOL: "WORKING · 工具",
      SUSPECT_STALL: "WARNING · 延迟",
      DISCONNECTED_HANG: "ALERT · 断网挂起",
    },
    timeout: "超时",
    fail: "失败",
    down: "不通",
    directShort: "直连",
    proxyShort: "代理",
    latestOk: (t, ms, code, dual) => `最近: ${t} · ${ms} ms (HTTP ${code})${dual}`,
    latestFail: (t, err, dual) => `最近失败: ${t} · ${err}${dual}`,
    dualNote: (d, p) => ` · [直连 ${d} / 代理 ${p}]`,
    srcHooks: "Hooks",
    srcLog: "日志",
    srcWait: "等待",
    waitActivity: "等待活动",
    secAgo: (s) => `${s}s 前写入`,
    noLog: "暂无日志",
    modeProxy: (addr) => `代理 ${addr}`,
    modePacUnsupported: "PAC (暂不支持)",
    pacTooltip: (u) => `检测到系统 PAC 代理 (${u || "AutoConfigURL"})，暂不支持解析脚本，可在设置中手动指定代理`,
    modeTun: "TUN / Fake-IP",
    modeDirect: "直连模式",
    netDown: (n) => `异常 (连败 ${n} 次)`,
    netRetry: (n) => `异常 · 复测中 (${n})`,
    netHealthy: "连通正常",
    netProbing: "探测中",
    lsRunning: "运行中",
    lsUnavailable: "采集受限",
    lsNotFound: "未检测到",
    lsSkipped: "套接字探测不可用",
    lsStopped: "进程未运行",
    lsConns: (e, s) => `${e} 条 443 连接${s > 0 ? ` (${s} 重连中)` : ""}`,
    routeTag: { tun: " · TUN", proxy: " · 代理", direct: " · 直连" },
    cacheHit: (r) => (r != null ? `缓存命中 ${r}%` : "缓存命中 --"),
    callsCount: (c) => (c != null ? `${c} 次调用` : "-- 次调用"),
    lastSub: (inp, out) => `新输入 ${inp} · Out ${out}`,
    todaySub: (s, c) => (s != null ? `${s} 会话 · ${c} 次` : "-- 个会话"),
    convLabel: (id) => `会话: ${id ? id.slice(0, 8) : "--"}`,
    allTime: (tot, s) => `历史总计: ${tot} (${s} 会话)`,
    syncTime: (t) => `同步: ${t}`,
  },
  en: {
    htmlLang: "en",
    docTitle: "Antigravity Status Monitor",
    sseDotTitle: "Local monitor connection status (adaptive short polling)",
    brandTitle: "Status Monitor",
    btnProbeTitle: "Probe network now",
    btnProbe: "Probe",
    btnSimTitle: "Simulate upstream hang alert (15s)",
    btnSimStart: "Test Alert",
    btnSimStop: "Stop Alert",
    btnSettingsTitle: "Toggle settings",
    btnSettingsAria: "Settings",
    convSelectAria: "Conversation scope",
    convAutoOpt: "Auto (Active)",
    convPinnedOpt: (id) => `This Tab #${id.slice(0, 6)}`,
    convItemOpt: (id, active) => `${active ? "● " : ""}#${id.slice(0, 8)}${active ? " (Active)" : ""}`,
    convActiveHint: (id) => `Active chat #${id.slice(0, 8)} detected — switch selector to Auto`,
    actionTimeout: "Request timed out",
    actionFailedPrefix: "Action failed: ",
    initBadge: "INIT",
    initHeadline: "Connecting to local monitor…",
    initSummary: "Reading Hooks, transcript logs & network probes.",
    authDeniedBadge: "AUTH · DENIED",
    authDeniedHeadline: "Missing or invalid access token",
    authDeniedSummary: "Open inside Antigravity or use the full ?token=... URL printed by the server.",
    alertLeadHtml: "<strong>Action:</strong> The main UI may still show \"Working\", but upstream connectivity is lost.",
    alertSteps: "1. Check your network, proxy, or VPN connection; 2. If it stays stuck, cancel and retry.",
    chartTitle: "Upstream HTTPS Probe",
    statNow: "Now",
    statAvg: "Avg",
    statRate: "Uptime",
    chartWait: "Waiting for first probe…",
    cardAgent: "Agent Heartbeat",
    cardNet: "Network Route",
    cardLs: "Language Server",
    tokenTitle: "Token Usage",
    tokLastLabel: "Context",
    tokSessLabel: "Session",
    tokTodayLabel: "Today Total",
    tokBarTitle: "Session token breakdown",
    legInput: "Input",
    legCache: "Cache Read",
    legOut: "Output",
    settingsTitle: "Monitor Settings",
    settingLang: "Language / 语言",
    settingInterval: "Probe Interval",
    settingStall: "Stall Threshold",
    settingProbeUrl: "Probe Target",
    settingManualProxy: "Manual Proxy (Opt.)",
    settingTheme: "Theme",
    settingNotify: "Desktop alert on upstream hang",
    interval2s: "Every 2s (Fast)",
    interval3s: "Every 3s (Recommended)",
    interval5s: "Every 5s (Eco)",
    stall15: "15s without new log",
    stall25: "25s without new log",
    stall45: "45s without new log",
    probeCloudCode: "Cloud Code (Default)",
    themeAuto: "Follow Host / System",
    themeDark: "Dark Obsidian",
    themeLight: "Light Minimal",
    timelineTitle: "Live Event Stream (Hooks & Network)",
    timelineEmpty: "No events yet. Start a chat or wait for probe changes.",
    badges: {
      IDLE: "IDLE",
      OFFLINE_IDLE: "OFFLINE",
      WAITING_LLM: "WORKING · LLM",
      RUNNING_TOOL: "WORKING · TOOL",
      SUSPECT_STALL: "WARNING · STALL",
      DISCONNECTED_HANG: "ALERT · HANG",
    },
    timeout: "Timeout",
    fail: "Failed",
    down: "Down",
    directShort: "Direct",
    proxyShort: "Proxy",
    latestOk: (t, ms, code, dual) => `Latest: ${t} · ${ms} ms (HTTP ${code})${dual}`,
    latestFail: (t, err, dual) => `Failed: ${t} · ${err}${dual}`,
    dualNote: (d, p) => ` · [Direct ${d} / Proxy ${p}]`,
    srcHooks: "Hooks",
    srcLog: "Log",
    srcWait: "Wait",
    waitActivity: "Waiting",
    secAgo: (s) => `${s}s ago`,
    noLog: "No logs yet",
    modeProxy: (addr) => `Proxy ${addr}`,
    modePacUnsupported: "PAC (Unsupported)",
    pacTooltip: (u) => `System PAC proxy detected (${u || "AutoConfigURL"}); unsupported, set a manual proxy in Settings if needed`,
    modeTun: "TUN / Fake-IP",
    modeDirect: "Direct",
    netDown: (n) => `Down (${n} fails)`,
    netRetry: (n) => `Retrying (${n} fail)`,
    netHealthy: "Healthy",
    netProbing: "Probing",
    lsRunning: "Running",
    lsUnavailable: "Unavailable",
    lsNotFound: "Not found",
    lsSkipped: "Socket probe N/A",
    lsStopped: "Not running",
    lsConns: (e, s) => `${e} TLS:443${s > 0 ? ` (${s} SYN)` : ""}`,
    routeTag: { tun: " · TUN", proxy: " · Proxy", direct: " · Direct" },
    cacheHit: (r) => (r != null ? `Cache ${r}%` : "Cache --"),
    callsCount: (c) => (c != null ? `${c} calls` : "-- calls"),
    lastSub: (inp, out) => `New ${inp} · Out ${out}`,
    todaySub: (s, c) => (s != null ? `${s} chats · ${c} calls` : "-- chats"),
    convLabel: (id) => `Chat: ${id ? id.slice(0, 8) : "--"}`,
    allTime: (tot, s) => `All-time: ${tot} (${s} chats)`,
    syncTime: (t) => `Sync: ${t}`,
  },
};

const $ = (id) => document.getElementById(id);

let lastSeverity = null;
let lastSparkSig = "";
let lastTimelineSig = "";
let lastConfigSig = "";
let lastConvOptsSig = "";
let configuredTheme = "auto";
function detectBrowserLang() {
  try {
    const saved = localStorage.getItem("asm-lang");
    if (saved === "zh" || saved === "en") return saved;
  } catch {
  }
  const nav = String(navigator.language || navigator.userLanguage || "").toLowerCase();
  return nav.startsWith("zh") ? "zh" : "en";
}

let currentLang = detectBrowserLang();
let lastData = null;
let pendingLangSave = false;

function dict() {
  return I18N[currentLang] || I18N.zh;
}

function setText(id, next) {
  const el = $(id);
  const val = String(next ?? "");
  if (el && el.textContent !== val) {
    el.textContent = val;
  }
}

function applyStaticI18n(lang) {
  currentLang = lang === "en" ? "en" : "zh";
  const d = dict();
  document.documentElement.lang = d.htmlLang;
  document.title = d.docTitle;

  for (const el of document.querySelectorAll("[data-i18n]")) {
    const key = el.dataset.i18n;
    if (d[key] != null) el.textContent = d[key];
  }
  for (const el of document.querySelectorAll("[data-i18n-title]")) {
    const key = el.dataset.i18nTitle;
    if (d[key] != null) el.title = d[key];
  }
  for (const el of document.querySelectorAll("[data-i18n-opt]")) {
    const key = el.dataset.i18nOpt;
    if (d[key] != null) el.textContent = d[key];
  }
  for (const el of document.querySelectorAll("[data-i18n-aria]")) {
    const key = el.dataset.i18nAria;
    if (d[key] != null) el.setAttribute("aria-label", d[key]);
  }

  lastConvOptsSig = "";
  $("btnSettings")?.setAttribute("aria-label", d.btnSettingsAria);
  setText("btnSimText", lastData?.simulation?.active ? d.btnSimStop : d.btnSimStart);
  $("alertStripLead").innerHTML = d.alertLeadHtml;
  setText("alertStripSteps", d.alertSteps);

  $("btnLangZh")?.classList.toggle("active", currentLang === "zh");
  $("btnLangEn")?.classList.toggle("active", currentLang === "en");

  if (!lastData) {
    setText("verdictBadge", d.initBadge);
    setText("verdictHeadline", d.initHeadline);
    setText("verdictSummary", d.initSummary);
    setText("chartTooltip", d.chartWait);
    setText("agentLogAge", d.noLog);
    setText("tokCacheRate", d.cacheHit(null));
    setText("tokCalls", d.callsCount(null));
    setText("tokTodaySub", d.todaySub(null, null));
    setText("convBadge", d.convLabel(null));
    setText("lastRefresh", d.syncTime("--"));
    const tl = $("timelineList");
    if (tl) {
      tl.innerHTML = `<div class="empty-state">${escapeHtml(d.timelineEmpty)}</div>`;
    }
  }
}

function fmtElapsed(sec) {
  if (sec == null || sec < 0) return "--:--";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function fmtTokens(n) {
  if (n == null || !Number.isFinite(n)) return "--";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtTime(ts) {
  if (!ts) return "--";
  return new Date(ts).toLocaleTimeString(currentLang === "en" ? "en-US" : "zh-CN", {
    hour12: false,
  });
}

function escapeHtml(text) {
  return String(text || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

function applyTheme(themePref = configuredTheme) {
  configuredTheme = themePref || "auto";
  if (configuredTheme === "dark" || configuredTheme === "light") {
    if (document.documentElement.getAttribute("data-theme") !== configuredTheme) {
      document.documentElement.setAttribute("data-theme", configuredTheme);
    }
    return;
  }

  const hostBg = document.documentElement.style.getPropertyValue("--background").trim();
  if (!hostBg) {
    if (document.documentElement.getAttribute("data-theme") !== "auto") {
      document.documentElement.setAttribute("data-theme", "auto");
    }
    return;
  }

  const probe = document.createElement("span");
  probe.className = "theme-probe";
  document.documentElement.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();

  const nums = (c.match(/[\d.]+/g) || []).map(Number);
  let targetTheme = "host-dark";
  if (nums.length >= 3) {
    const scale = c.startsWith("color(") ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    targetTheme = lum < 0.5 ? "host-dark" : "host-light";
  }
  if (document.documentElement.getAttribute("data-theme") !== targetTheme) {
    document.documentElement.setAttribute("data-theme", targetTheme);
  }
}

new MutationObserver(() => {
  if (configuredTheme === "auto") {
    applyTheme("auto");
  }
}).observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
applyTheme("auto");
applyStaticI18n(currentLang);

function renderSparkline(probes) {
  const d = dict();
  const svg = $("sparkSvg");
  const tooltip = $("chartTooltip");
  if (!probes || probes.length === 0) {
    if (lastSparkSig !== "empty:" + currentLang) {
      lastSparkSig = "empty:" + currentLang;
      svg.innerHTML = "";
      setText("chartTooltip", d.chartWait);
    }
    return;
  }

  const maxPoints = 40;
  const list = probes.slice(-maxPoints);
  const last = list[list.length - 1];
  const sig =
    `${currentLang}|` +
    list.map((p) => `${p.ts}:${p.ok ? 1 : 0}:${p.latencyMs}`).join("|") +
    `|${last.dual?.direct?.latencyMs ?? ""}:${last.dual?.proxy?.latencyMs ?? ""}`;

  if (sig === lastSparkSig) return;
  lastSparkSig = sig;

  const w = 360;
  const h = 72;
  const padTop = 18;
  const padBottom = 6;
  const usableH = h - padTop - padBottom;
  const maxLat = Math.max(300, ...list.map((p) => (p.ok ? p.latencyMs : 0)));

  const stepX = list.length > 1 ? w / (list.length - 1) : w / 2;
  const coords = list.map((p, i) => {
    const x = list.length === 1 ? w / 2 : i * stepX;
    const norm = p.ok ? Math.min(1, p.latencyMs / maxLat) : 0;
    const y = p.ok ? padTop + usableH * (1 - norm * 0.85) : padTop;
    return { x, y, p };
  });

  const okRuns = [];
  let curRun = [];
  for (const c of coords) {
    if (c.p.ok) {
      curRun.push(c);
    } else if (curRun.length > 0) {
      okRuns.push(curRun);
      curRun = [];
    }
  }
  if (curRun.length > 0) {
    okRuns.push(curRun);
  }

  const areaPaths = okRuns
    .filter((run) => run.length > 1)
    .map((run) => {
      const pts = run.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`);
      return `M ${run[0].x.toFixed(1)},${h} L ${pts.join(" L ")} L ${run[run.length - 1].x.toFixed(1)},${h} Z`;
    });
  const linePaths = okRuns
    .filter((run) => run.length > 1)
    .map((run) => `M ${run.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" L ")}`);

  const dots = coords
    .map((c, idx) => {
      const isLast = idx === coords.length - 1;
      if (!c.p.ok) {
        return `<rect x="${(c.x - 2.2).toFixed(1)}" y="${padTop}" width="4.4" height="${usableH}" rx="2" fill="var(--mon-danger)" opacity="0.82"><title>${fmtTime(c.p.ts)} ${d.fail}: ${escapeHtml(c.p.error)}</title></rect>`;
      }
      const r = isLast ? 3.3 : 1.7;
      const opacity = isLast ? 1 : 0.55;
      return `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="${r}" fill="var(--mon-ok)" opacity="${opacity}"><title>${fmtTime(c.p.ts)} ${c.p.latencyMs} ms</title></circle>`;
    })
    .join("");

  svg.innerHTML = `
    <defs>
      <linearGradient id="sparkArea" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--mon-ok)" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="var(--mon-ok)" stop-opacity="0.01"/>
      </linearGradient>
    </defs>
    <line x1="0" y1="${padTop + usableH * 0.5}" x2="${w}" y2="${padTop + usableH * 0.5}" stroke="var(--mon-border)" stroke-dasharray="3 3" />
    ${areaPaths.map((dStr) => `<path d="${dStr}" fill="url(#sparkArea)" />`).join("")}
    ${linePaths.map((dStr) => `<path d="${dStr}" fill="none" stroke="var(--mon-ok)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />`).join("")}
    ${dots}
  `;

  const dir = last.dual?.direct;
  const prx = last.dual?.proxy;
  const dualNote =
    dir && prx
      ? d.dualNote(
          dir.ok ? `${dir.latencyMs}ms` : d.down,
          prx.ok ? `${prx.latencyMs}ms` : d.down,
        )
      : "";
  const tipText = last.ok
    ? d.latestOk(fmtTime(last.ts), last.latencyMs, last.statusCode, dualNote)
    : d.latestFail(fmtTime(last.ts), last.error || d.timeout, dualNote);
  tooltip.textContent = tipText;
  tooltip.title = tipText;
}

function createTimelineItemEl(ev) {
  const row = document.createElement("div");
  row.className = "tl-item";
  row.dataset.eventId = ev.id;

  const dot = document.createElement("span");
  dot.className = `tl-dot ${ev.level || "info"}`;

  const body = document.createElement("div");
  body.className = "tl-body";

  const title = document.createElement("div");
  title.className = "tl-title";
  title.textContent = ev.title || "";
  body.appendChild(title);

  if (ev.detail) {
    const detail = document.createElement("div");
    detail.className = "tl-detail";
    detail.textContent = ev.detail;
    body.appendChild(detail);
  }

  const time = document.createElement("span");
  time.className = "tl-time";
  time.textContent = fmtTime(ev.ts);

  row.append(dot, body, time);
  return row;
}

function renderTimeline(events) {
  const d = dict();
  const tl = $("timelineList");
  const slice = Array.isArray(events) ? events.slice(0, 15) : [];
  const sig =
    slice.length === 0
      ? `empty:${currentLang}`
      : `${currentLang}|` + slice.map((e) => `${e.id}:${e.title}:${e.detail}`).join("|");
  if (sig === lastTimelineSig) return;
  lastTimelineSig = sig;

  if (slice.length === 0) {
    tl.innerHTML = `<div class="empty-state">${escapeHtml(d.timelineEmpty)}</div>`;
    return;
  }

  const prevScrollTop = tl.scrollTop;
  const existingById = new Map();
  for (const child of tl.children) {
    if (child.dataset?.eventId) {
      existingById.set(child.dataset.eventId, child);
    }
  }

  const frag = document.createDocumentFragment();
  for (const ev of slice) {
    const existing = existingById.get(ev.id);
    if (existing) {
      const titleEl = existing.querySelector(".tl-title");
      const detailEl = existing.querySelector(".tl-detail");
      if (titleEl && titleEl.textContent !== (ev.title || "")) {
        titleEl.textContent = ev.title || "";
      }
      if (detailEl && detailEl.textContent !== (ev.detail || "")) {
        detailEl.textContent = ev.detail || "";
      }
      frag.appendChild(existing);
    } else {
      frag.appendChild(createTimelineItemEl(ev));
    }
  }
  tl.replaceChildren(frag);
  if (prevScrollTop > 4) {
    tl.scrollTop = prevScrollTop;
  }
}

let hasCfgError = false;

function showCfgError(msg) {
  const el = $("cfgError");
  if (!el) return;
  hasCfgError = Boolean(msg);
  el.textContent = msg || "";
  el.classList.toggle("visible", hasCfgError);
}

function syncSettings(config) {
  const sig = JSON.stringify([
    config.intervalMs,
    config.stallThresholdSec,
    config.probeUrl,
    config.manualProxyUrl || "",
    config.theme || "auto",
    config.lang || "zh",
    Boolean(config.notifyOnDisconnect),
  ]);
  if (sig === lastConfigSig) return;
  lastConfigSig = sig;

  if (document.activeElement !== $("cfgInterval")) $("cfgInterval").value = String(config.intervalMs);
  if (document.activeElement !== $("cfgStall")) $("cfgStall").value = String(config.stallThresholdSec);
  if (!hasCfgError && document.activeElement !== $("cfgProbeUrl")) $("cfgProbeUrl").value = config.probeUrl;
  if (!hasCfgError && document.activeElement !== $("cfgManualProxy")) {
    $("cfgManualProxy").value = config.manualProxyUrl || "";
  }
  if (document.activeElement !== $("cfgTheme")) $("cfgTheme").value = config.theme || "auto";
  $("cfgNotify").checked = Boolean(config.notifyOnDisconnect);
}

function render(data) {
  lastData = data;
  const { verdict, config, hook, transcript, tokenStats, ls, metrics, simulation, events, probes } = data;

  if (!pendingLangSave && config.lang && config.lang !== currentLang) {
    try {
      localStorage.setItem("asm-lang", config.lang);
    } catch {
    }
    applyStaticI18n(config.lang);
  }
  const d = dict();

  applyTheme(config.theme || "auto");

  const hero = $("heroCard");
  if (lastSeverity !== verdict.severity) {
    lastSeverity = verdict.severity;
    $("ambientGlow").style.setProperty("--hero-glow", GLOW_COLORS[verdict.severity] || "var(--mon-accent-soft)");
    hero.setAttribute("data-severity", verdict.severity);
    $("orbIcon").innerHTML = ICONS[verdict.severity] || ICONS.ok;
  }

  setText("verdictBadge", d.badges[verdict.code] || verdict.code);
  setText("elapsedTimer", verdict.phase === "idle" ? "READY" : fmtElapsed(verdict.elapsedSec));
  setText("verdictHeadline", verdict.headline);
  setText("verdictSummary", verdict.summary);

  $("alertStrip").classList.toggle("visible", verdict.code === "DISCONNECTED_HANG");

  $("btnSim").classList.toggle("danger-active", Boolean(simulation?.active));
  setText("btnSimText", simulation?.active ? d.btnSimStop : d.btnSimStart);

  const latestProbe = metrics.latestProbe;
  setText("rttNow", latestProbe ? (latestProbe.ok ? `${latestProbe.latencyMs}ms` : d.timeout) : "--");
  setText("rttAvg", metrics.avgLatencyMs != null ? `${metrics.avgLatencyMs}ms` : "--");
  setText("rttRate", metrics.successRate != null ? `${metrics.successRate}%` : "--");
  renderSparkline(probes);

  setText(
    "agentSourceBadge",
    verdict.source === "hook" ? d.srcHooks : verdict.source === "transcript" ? d.srcLog : d.srcWait,
  );
  const stepNum = transcript.latestStepIndex ?? hook.stepIdx;
  setText("agentStepVal", stepNum != null ? `Step #${stepNum}` : d.waitActivity);
  const silentText = verdict.silentSec != null ? d.secAgo(verdict.silentSec) : d.noLog;
  setText("agentLogAge", hook.lastEvent ? `${hook.lastEvent} · ${silentText}` : silentText);

  const proxyCfg = latestProbe?.proxyConfig || data.proxyConfig;
  const isPacUnsupported = String(proxyCfg?.source || "").endsWith("pac-unsupported");
  const activeRoute = latestProbe?.activeRoute || ls.route || (ls.tunDetected ? "tun" : "direct");
  const proxyAddr =
    latestProbe?.proxyAddress ||
    (proxyCfg?.host && proxyCfg?.port ? `${proxyCfg.host}:${proxyCfg.port}` : "");
  const modeText =
    activeRoute === "proxy" && proxyAddr
      ? d.modeProxy(proxyAddr)
      : isPacUnsupported
        ? d.modePacUnsupported
        : activeRoute === "tun" || ls.tunDetected
          ? d.modeTun
          : activeRoute === "proxy"
            ? d.proxyShort
            : d.modeDirect;
  setText("netModeBadge", modeText);
  if ($("netModeBadge")) {
    $("netModeBadge").title = isPacUnsupported ? d.pacTooltip(proxyCfg?.pacUrl || "") : "";
  }
  setText(
    "netStatusVal",
    verdict.networkDown
      ? d.netDown(metrics.consecutiveFailures)
      : latestProbe?.ok
        ? d.netHealthy
        : latestProbe
          ? d.netRetry(metrics.consecutiveFailures || 1)
          : d.netProbing,
  );
  const hostLabel = config.probeUrl.replace(/^https?:\/\//, "").split("/")[0];
  const dualDirect = latestProbe?.dual?.direct;
  const dualProxy = latestProbe?.dual?.proxy;
  setText(
    "netTargetVal",
    dualDirect && dualProxy
      ? `${d.directShort}:${dualDirect.ok ? `${dualDirect.latencyMs}ms` : "×"} · ${d.proxyShort}:${dualProxy.ok ? `${dualProxy.latencyMs}ms` : "×"}`
      : isPacUnsupported
        ? `PAC · ${hostLabel}`
        : hostLabel,
  );
  if ($("netTargetVal")) {
    $("netTargetVal").title = isPacUnsupported ? d.pacTooltip(proxyCfg?.pacUrl || "") : "";
  }

  setText(
    "lsHealthBadge",
    ls.healthz?.reachable === true
      ? "healthz OK"
      : ls.running
        ? d.lsRunning
        : ls.running === null
          ? d.lsUnavailable
          : d.lsNotFound,
  );
  setText(
    "lsConnVal",
    ls.running === null
      ? d.lsSkipped
      : ls.running === false
        ? d.lsStopped
        : d.lsConns(ls.established443, ls.synSent443),
  );
  const routeTag = d.routeTag[ls.route] || "";
  setText("lsPidVal", ls.pids?.length ? `PID: ${ls.pids.join(", ")}${routeTag}` : "PID: --");

  const sess = tokenStats?.session;
  const last =
    tokenStats?.lastCall ||
    (transcript.tokens
      ? {
          input: transcript.tokens.input || 0,
          cacheRead: transcript.tokens.cacheRead || 0,
          output: transcript.tokens.output || 0,
          contextTotal: (transcript.tokens.input || 0) + (transcript.tokens.cacheRead || 0),
        }
      : null);
  const today = tokenStats?.today;

  setText("tokCacheRate", d.cacheHit(sess?.cacheHitRate));
  setText("tokCalls", d.callsCount(sess?.calls));

  setText("tokLastCtx", last ? fmtTokens(last.contextTotal) : "--");
  setText("tokLastSub", last ? d.lastSub(fmtTokens(last.input), fmtTokens(last.output)) : "Out --");

  setText("tokSessTotal", sess ? fmtTokens(sess.total) : "--");
  setText("tokSessSub", sess ? `In ${fmtTokens(sess.input)} · Out ${fmtTokens(sess.output)}` : "In -- / Out --");

  setText("tokTodayTotal", today ? fmtTokens(today.total) : "--");
  setText("tokTodaySub", d.todaySub(today?.sessions, today?.calls));

  const barTotal = sess?.total || 0;
  $("tokBarIn").style.width = barTotal > 0 ? `${((sess.input / barTotal) * 100).toFixed(1)}%` : "0%";
  $("tokBarCache").style.width = barTotal > 0 ? `${((sess.cacheRead / barTotal) * 100).toFixed(1)}%` : "0%";
  $("tokBarOut").style.width = barTotal > 0 ? `${((sess.output / barTotal) * 100).toFixed(1)}%` : "0%";

  setText("tokLegIn", sess ? fmtTokens(sess.input) : "--");
  setText("tokLegCache", sess ? fmtTokens(sess.cacheRead) : "--");
  setText("tokLegOut", sess ? fmtTokens(sess.output) : "--");

  syncSettings(config);

  const convId = data.activeConversationId || hook.conversationId || transcript.conversationId;
  setText("convBadge", d.convLabel(convId));
  syncConvSelect(data);
  const otherActive = Array.isArray(data.recentConversations)
    ? data.recentConversations.find((c) => c.active && c.id && c.id !== convId)
    : null;
  if ($("convBadge")) {
    $("convBadge").title = otherActive ? d.convActiveHint(otherActive.id) : "";
  }

  renderTimeline(events);

  const allTok = tokenStats?.allTime;
  setText(
    "tokenInfo",
    allTok
      ? d.allTime(fmtTokens(allTok.total), allTok.sessions)
      : transcript.tokens
        ? `Tokens In:${transcript.tokens.input ?? "-"} Out:${transcript.tokens.output ?? "-"}`
        : "Tokens: --",
  );
  setText("lastRefresh", d.syncTime(fmtTime(data.now)));
}

const POLL_VISIBLE_INTERVAL_MS = 1000;
const REQUEST_TIMEOUT_MS = 4500;
const CONV_SCOPE_KEY = "asm-conv-scope";

const urlParams = new URLSearchParams(window.location.search);
const pageConvId = window.sidecar?.conversationId || urlParams.get("conversationId") || "";
const urlToken = urlParams.get("token") || "";

function loadInitialConvScope() {
  try {
    const saved = sessionStorage.getItem(CONV_SCOPE_KEY);
    if (saved) return saved;
  } catch {
  }
  return pageConvId || "auto";
}

function persistConvScope(scope) {
  try {
    sessionStorage.setItem(CONV_SCOPE_KEY, scope);
  } catch {
  }
}

let selectedConvScope = loadInitialConvScope();

function buildStatusEndpoint(scope = selectedConvScope) {
  const statusParams = new URLSearchParams();
  if (scope) statusParams.set("conversationId", scope);
  const statusQuery = statusParams.toString();
  return statusQuery ? `/api/status?${statusQuery}` : "/api/status";
}

function syncConvSelect(data) {
  const sel = $("convSelect");
  if (!sel) return;
  const d = dict();
  const recent = Array.isArray(data?.recentConversations) ? data.recentConversations : [];
  const options = [{ value: "auto", label: d.convAutoOpt }];
  const seen = new Set(["auto"]);

  if (pageConvId && !seen.has(pageConvId)) {
    seen.add(pageConvId);
    options.push({ value: pageConvId, label: d.convPinnedOpt(pageConvId) });
  }
  for (const item of recent) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    options.push({ value: item.id, label: d.convItemOpt(item.id, Boolean(item.active)) });
  }
  if (selectedConvScope && !seen.has(selectedConvScope)) {
    seen.add(selectedConvScope);
    options.push({ value: selectedConvScope, label: d.convItemOpt(selectedConvScope, false) });
  }

  const sig = `${currentLang}|${selectedConvScope}|` + options.map((o) => `${o.value}:${o.label}`).join("|");
  if (sig === lastConvOptsSig || document.activeElement === sel) return;
  lastConvOptsSig = sig;

  const frag = document.createDocumentFragment();
  for (const opt of options) {
    const el = document.createElement("option");
    el.value = opt.value;
    el.textContent = opt.label;
    frag.appendChild(el);
  }
  sel.replaceChildren(frag);
  sel.value = selectedConvScope;
}

function apiFetch(path, options = {}) {
  if (window.sidecar?.fetch) {
    return window.sidecar.fetch(path, { cache: "no-store", ...options });
  }
  const headers = new Headers(options.headers || {});
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (urlToken) {
    headers.set("X-Sidecar-Token", urlToken);
  }
  return fetch(path, { cache: "no-store", ...options, headers });
}

async function fetchWithTimeout(path, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  if (typeof AbortController !== "function") {
    return apiFetch(path, options);
  }
  const controller = new AbortController();
  let externalSignal = options.signal;
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("timeout"));
  }, timeoutMs);

  try {
    return await apiFetch(path, { ...options, signal: controller.signal });
  } catch (err) {
    if (timedOut) {
      throw new Error(dict().actionTimeout);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

async function postJson(path, body = {}) {
  const res = await fetchWithTimeout(path, {
    method: "POST",
    body: JSON.stringify(body),
  }, 6000);
  if (!res.ok) {
    const errData = await res.json().catch(() => null);
    throw new Error(errData?.detail || errData?.error || `HTTP ${res.status}`);
  }
  return res.json();
}

let pollHealthy = false;
let liveStarted = false;
let pollStopped = false;
let pollTimer = null;
let pollInFlight = null;
let pollAbortController = null;
let actionBannerTimer = null;
const syncChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel("asm-status-sync") : null;

function notifySiblingPanels() {
  if (!syncChannel) return;
  try {
    syncChannel.postMessage({ type: "refresh", scope: selectedConvScope, ts: Date.now() });
  } catch {
  }
}

function updateConnectionDot() {
  const dot = $("sseDot");
  if (!dot) return;
  dot.classList.toggle("offline", !pollHealthy);
}

function clearActionError() {
  if (actionBannerTimer) {
    clearTimeout(actionBannerTimer);
    actionBannerTimer = null;
  }
  const banner = $("actionBanner");
  if (!banner) return;
  banner.textContent = "";
  banner.classList.remove("visible");
}

function reportActionError(err) {
  const prefix = dict().actionFailedPrefix;
  const msg = `${prefix}${err?.message || "unknown"}`;
  const banner = $("actionBanner");
  if (banner) {
    banner.textContent = msg;
    banner.classList.add("visible");
    if (actionBannerTimer) clearTimeout(actionBannerTimer);
    actionBannerTimer = setTimeout(() => clearActionError(), 6000);
    return;
  }
  setText("verdictSummary", msg);
}

async function pollStatus({ manual = false } = {}) {
  if (pollStopped) return null;
  if (pollInFlight) {
    if (!manual) return pollInFlight;
    if (pollAbortController) {
      try {
        pollAbortController.abort(new Error("superseded"));
      } catch {
      }
    }
  }

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  pollAbortController = controller;
  const endpoint = buildStatusEndpoint(selectedConvScope);

  const task = (async () => {
    try {
      const res = await fetchWithTimeout(endpoint, {
        method: "GET",
        signal: controller?.signal,
      });
      if (!res.ok) {
        if ((res.status === 401 || res.status === 403) && !lastData) {
          const d = dict();
          setText("verdictBadge", d.authDeniedBadge);
          setText("verdictHeadline", d.authDeniedHeadline);
          setText("verdictSummary", d.authDeniedSummary);
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      if (controller?.signal?.aborted || pollAbortController !== controller) {
        return data;
      }
      pollHealthy = true;
      updateConnectionDot();
      render(data);
      return data;
    } catch (err) {
      if (controller?.signal?.aborted && pollAbortController !== controller) {
        return null;
      }
      pollHealthy = false;
      updateConnectionDot();
      return null;
    } finally {
      if (pollAbortController === controller) {
        pollAbortController = null;
      }
      if (pollInFlight === task) {
        pollInFlight = null;
      }
    }
  })();

  pollInFlight = task;
  return task;
}

function clearPollTimer() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function scheduleNextPoll() {
  clearPollTimer();
  if (pollStopped || document.visibilityState === "hidden") {
    return;
  }
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    await pollStatus();
    scheduleNextPoll();
  }, POLL_VISIBLE_INTERVAL_MS);
}

function stopPolling() {
  pollStopped = true;
  clearPollTimer();
  if (pollAbortController) {
    try {
      pollAbortController.abort(new Error("unload"));
    } catch {
    }
    pollAbortController = null;
  }
}

function startPolling() {
  if (liveStarted) return;
  liveStarted = true;
  pollStopped = false;

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      clearPollTimer();
    } else if (!pollStopped) {
      clearPollTimer();
      pollStatus({ manual: true }).finally(() => scheduleNextPoll());
    }
  });
  window.addEventListener("focus", () => {
    if (!pollStopped && document.visibilityState !== "hidden") {
      clearPollTimer();
      pollStatus({ manual: true }).finally(() => scheduleNextPoll());
    }
  });
  window.addEventListener("pagehide", stopPolling);
  window.addEventListener("beforeunload", stopPolling);

  if (syncChannel) {
    syncChannel.onmessage = () => {
      if (!pollStopped && document.visibilityState !== "hidden") {
        clearPollTimer();
        pollStatus({ manual: true }).finally(() => scheduleNextPoll());
      }
    };
  }

  pollStatus({ manual: true }).finally(() => scheduleNextPoll());
}

async function runActionButton(btn, actionFn, { activeDurationMs = 0 } = {}) {
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  btn.classList.add("active");
  try {
    clearActionError();
    await actionFn();
    await pollStatus({ manual: true });
    notifySiblingPanels();
    scheduleNextPoll();
  } catch (err) {
    reportActionError(err);
  } finally {
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    if (activeDurationMs > 0) {
      setTimeout(() => btn.classList.remove("active"), activeDurationMs);
    } else {
      btn.classList.remove("active");
    }
  }
}

$("btnProbe").addEventListener("click", () => {
  runActionButton($("btnProbe"), () => postJson("/api/probe"), { activeDurationMs: 350 });
});

$("btnSim").addEventListener("click", () => {
  const nextActive = !Boolean(lastData?.simulation?.active);
  runActionButton($("btnSim"), () => postJson("/api/simulate", { active: nextActive }));
});

$("convSelect").addEventListener("change", () => {
  const next = $("convSelect").value || "auto";
  selectedConvScope = next;
  persistConvScope(next);
  lastConvOptsSig = "";
  lastTimelineSig = "";
  clearActionError();
  clearPollTimer();
  pollStatus({ manual: true }).finally(() => scheduleNextPoll());
});

$("btnSettings").addEventListener("click", () => {
  const open = $("settingsPanel").classList.toggle("open");
  $("btnSettings").classList.toggle("active", open);
});

async function switchLang(nextLang) {
  if (!["zh", "en"].includes(nextLang)) return;
  pendingLangSave = true;
  try {
    localStorage.setItem("asm-lang", nextLang);
  } catch {
  }
  lastSparkSig = "";
  lastTimelineSig = "";
  lastConfigSig = "";
  applyStaticI18n(nextLang);
  if (lastData) {
    render(lastData);
  }
  try {
    clearActionError();
    await postJson("/api/config", { lang: nextLang });
    showCfgError("");
    await pollStatus({ manual: true });
    notifySiblingPanels();
    scheduleNextPoll();
  } catch (err) {
    reportActionError(err);
  } finally {
    pendingLangSave = false;
  }
}

$("btnLangZh").addEventListener("click", () => switchLang("zh"));
$("btnLangEn").addEventListener("click", () => switchLang("en"));

const saveCfg = async () => {
  showCfgError("");
  clearActionError();
  const nextTheme = $("cfgTheme").value;
  const nextProbeUrl = $("cfgProbeUrl").value.trim();
  const nextManualProxy = $("cfgManualProxy").value.trim();
  const prevManualProxy = lastData?.config?.manualProxyUrl || "";
  const prevProbeUrl = lastData?.config?.probeUrl || "";
  const manualProxyChanged = nextManualProxy !== prevManualProxy;
  const probeUrlChanged = nextProbeUrl !== prevProbeUrl;
  applyTheme(nextTheme);
  try {
    lastConfigSig = "";
    await postJson("/api/config", {
      intervalMs: Number($("cfgInterval").value),
      stallThresholdSec: Number($("cfgStall").value),
      probeUrl: nextProbeUrl,
      manualProxyUrl: nextManualProxy,
      theme: nextTheme,
      lang: currentLang,
      notifyOnDisconnect: $("cfgNotify").checked,
    });
    if (manualProxyChanged || probeUrlChanged) {
      await postJson("/api/probe");
    }
    await pollStatus({ manual: true });
    notifySiblingPanels();
    scheduleNextPoll();
  } catch (err) {
    showCfgError(err?.message || "Invalid config");
    reportActionError(err);
  }
};

$("cfgInterval").addEventListener("change", saveCfg);
$("cfgStall").addEventListener("change", saveCfg);
$("cfgProbeUrl").addEventListener("change", saveCfg);
$("cfgManualProxy").addEventListener("change", saveCfg);
$("cfgTheme").addEventListener("change", saveCfg);
$("cfgNotify").addEventListener("change", saveCfg);

if (document.readyState === "complete") {
  startPolling();
} else {
  window.addEventListener("load", startPolling, { once: true });
}
