(function (ns) {
  ns.$ = (id) => document.getElementById(id);

  ns.ICONS = {
    ok: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polyline points="20 6 9 17 4 12"/></svg>',
    active: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
    tool: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
    warning: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    danger: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  };

  ns.GLOW_COLORS = {
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
      btnProbeTitle: "立即执行一次上游网络探测",
      btnProbe: "探测",
      btnSimTitle: "模拟 15 秒断网挂起告警，预览提醒与通知效果",
      btnSimStart: "演练告警",
      btnSimStop: "停止演练",
      btnSettingsTitle: "展开/收起设置",
      btnSettingsAria: "设置",
      actionTimeout: "请求超时，请检查本地监控服务状态",
      actionFailedPrefix: "操作失败: ",
      unknownError: "未知错误",
      invalidConfig: "配置保存失败，请检查输入格式",
      initBadge: "连接中",
      initHeadline: "正在连接本地监控探针…",
      initSummary: "正在读取 Hooks 状态、对话日志与网络探针。",
      authDeniedBadge: "鉴权失效",
      authDeniedHeadline: "缺少或无效的访问令牌",
      authDeniedSummary: "请在 Antigravity 中打开面板，或使用启动日志输出的带 ?token=... URL 访问。",
      timerReady: "待命",
      alertLeadHtml: "<strong>建议操作：</strong>当前主界面可能仍显示“工作中”，但请求已被断网阻塞。",
      alertSteps: "1. 检查 VPN / 代理是否掉线并重连；2. 若恢复后仍卡住，可点击取消当前回答后重试。",
      chartTitle: "上游 HTTPS 探测",
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
      tokDetailsToggle: "明细",
      settingsTitle: "监控配置",
      settingsGroupProbe: "探测与网络",
      settingsGroupUi: "显示与通知",
      settingLang: "语言 / Language",
      settingInterval: "探测频率",
      settingStall: "卡顿预警阈值",
      settingProbeUrl: "探测目标",
      settingManualProxy: "手动代理（留空自动）",
      manualProxyHint: "留空则自动读取系统/环境代理。支持 http:// 或无认证 socks5://（需含端口，不支持 PAC）。",
      settingTheme: "界面主题",
      settingNotify: "断网挂起时发送系统桌面通知",
      settingsHelpToggle: "探测说明与边界",
      settingsHelpProbe: "HTTPS 探针只要收到上游响应（含 HTTP 404）即判定链路可达；新连接可达不代表既有流式长连接必然存活。",
      settingsHelpLocal: "纯本地运行，事件流仅保留当前对话；异常日志保存在本地运行目录，不上传外部服务。",
      tokFootnote: "统计口径：原始 Token 累加（含缓存读取），仅反映工作量，不等同于计费或配额。",
      interval2s: "每 2 秒（灵敏）",
      interval3s: "每 3 秒（推荐）",
      interval5s: "每 5 秒（省电）",
      stall15: "15 秒无新进展",
      stall25: "25 秒无新进展",
      stall45: "45 秒无新进展",
      probeCloudCode: "Cloud Code（默认）",
      themeAuto: "跟随宿主 / 系统",
      themeDark: "深色模式",
      themeLight: "浅色模式",
      timelineTitle: "本对话事件流",
      timelineEmpty: "当前对话尚无状态记录。发送消息后将显示执行阶段与网络变化。",
      badges: {
        IDLE: "空闲",
        OFFLINE_IDLE: "离线断网",
        WAITING_LLM: "模型响应中",
        RUNNING_TOOL: "工具执行中",
        BACKGROUND_TASK: "后台待唤醒",
        API_RETRY: "接口重试",
        SUSPECT_STALL: "疑似卡顿",
        DISCONNECTED_HANG: "断网挂起",
      },
      timeout: "超时",
      fail: "失败",
      down: "不通",
      directShort: "直连",
      proxyShort: "代理",
      latestOk: (t, ms, code, dual) => `可达: ${t} · ${ms} ms (HTTP ${code})${dual}`,
      latestOk404Note: "收到上游响应（含 HTTP 404）即表示 TLS 与网络链路可达",
      latestFail: (t, err, dual) => `最近失败: ${t} · ${err}${dual}`,
      dualNote: (d, p) => ` · [直连 ${d} / 代理 ${p}]`,
      srcHooks: "Hooks",
      srcLog: "日志",
      srcWait: "等待",
      waitActivity: "等待活动",
      stepLabel: (n) => `第 ${n} 步`,
      hookEvents: {
        PreInvocation: "开始调用",
        PostInvocation: "调用完成",
        Stop: "本轮结束",
      },
      hookAgo: (s) => `${s}s 前`,
      secAgo: (s) => `${s}s 前写入`,
      apiErrAttempt: (n) => `API 报错 #${n}`,
      apiErrLabel: "API 报错",
      bgTaskLabel: "后台任务",
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
      lsHealthy: "健康正常",
      lsHealthyTitle: "Language Server /healthz 响应正常",
      lsRunning: "运行中",
      lsUnavailable: "采集受限",
      lsNotFound: "未检测到",
      lsSkipped: "套接字探测不可用",
      lsStopped: "进程未运行",
      lsConns: (e, s) => `${e} 条 HTTPS 连接${s > 0 ? `（${s} 重连中）` : ""}`,
      lsConnsTitle: "已建立的 TLS:443 加密连接数",
      routeTag: { tun: " · TUN", proxy: " · 代理", direct: " · 直连" },
      cacheHit: (r) => (r != null ? `缓存命中 ${r}%` : "缓存命中 --"),
      callsCount: (c) => (c != null ? `${c} 次调用` : "-- 次调用"),
      lastSub: (inp, out) => `新输入 ${inp} · 输出 ${out}`,
      lastSubEmpty: "输出 --",
      sessSub: (inp, out) => `输入 ${inp} · 输出 ${out}`,
      sessSubEmpty: "输入 -- · 输出 --",
      todaySub: (s, c) => (s != null ? `${s} 会话 · ${c} 次` : "-- 个会话"),
      convLabel: (id) => `会话: ${id ? id.slice(0, 8) : "--"}`,
      allTime: (tot, s) => `历史总计: ${tot} (${s} 会话)`,
      tokensFallback: (inp, out) => `Token 输入 ${inp} · 输出 ${out}`,
      tokensEmpty: "历史总计: --",
      syncTime: (t) => `同步: ${t}`,
      authExpiredBanner: "监控鉴权已失效（HTTP 401/403），当前展示最后一次同步快照；请关闭并重新打开面板以刷新令牌。",
      sidecarDisconnectedBanner: "与本地监控服务连续失联，当前展示最后一次同步快照，正在自动重连…",
      simTimer: (sec) => (sec != null ? `演练 ${sec}s` : "演练中"),
      netSimDown: "模拟断网（演练中）",
      netDownNoCount: "连接异常",
      chartSimNotice: "演练中：下方折线仍为真实探测结果，演练结束后自动恢复",
      alertBtnProbe: "立即探测",
      alertBtnProxy: "配置代理",
      alertBtnStopSim: "停止演练",
      tlLevels: { info: "信息", active: "进行", success: "正常", warn: "预警", error: "异常" },
    },
    en: {
      htmlLang: "en",
      docTitle: "Antigravity Status Monitor",
      sseDotTitle: "Local monitor connection status (adaptive short polling)",
      brandTitle: "Status Monitor",
      btnProbeTitle: "Run an immediate upstream network probe",
      btnProbe: "Probe",
      btnSimTitle: "Run a 15s disconnect alert test",
      btnSimStart: "Test Alert",
      btnSimStop: "Stop Test",
      btnSettingsTitle: "Toggle settings",
      btnSettingsAria: "Settings",
      actionTimeout: "Request timed out. Check whether the local monitor service is running.",
      actionFailedPrefix: "Action failed: ",
      unknownError: "unknown error",
      invalidConfig: "Failed to save settings; check the format and try again.",
      initBadge: "CONNECTING",
      initHeadline: "Connecting to local monitor…",
      initSummary: "Reading Hooks, transcript logs & network probes.",
      authDeniedBadge: "AUTH DENIED",
      authDeniedHeadline: "Missing or invalid access token",
      authDeniedSummary: "Open inside Antigravity or use the full ?token=... URL printed by the server.",
      timerReady: "READY",
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
      tokDetailsToggle: "Breakdown",
      settingsTitle: "Monitor Settings",
      settingsGroupProbe: "Detection & Network",
      settingsGroupUi: "Display & Alerts",
      settingLang: "Language / 语言",
      settingInterval: "Probe Interval",
      settingStall: "Stall Threshold",
      settingProbeUrl: "Probe Target",
      settingManualProxy: "Manual Proxy (Opt.)",
      manualProxyHint: "Leave blank for auto-detection. Supports http:// or unauthenticated socks5:// with port (no PAC).",
      settingTheme: "Theme",
      settingNotify: "Desktop alert on upstream hang",
      settingsHelpToggle: "How detection works",
      settingsHelpProbe: "Any upstream HTTP response (including 404) confirms reachability; a healthy probe does not guarantee an existing stream is alive.",
      settingsHelpLocal: "Runs locally with per-chat event isolation; alert logs stay on disk and are never uploaded.",
      tokFootnote: "Raw token sum (including cache reads) for workload tracking; not official billing or quota.",
      interval2s: "2s (Fast)",
      interval3s: "3s (Recommended)",
      interval5s: "5s (Eco)",
      stall15: "15s no activity",
      stall25: "25s no activity",
      stall45: "45s no activity",
      probeCloudCode: "Cloud Code (Default)",
      themeAuto: "Follow Host / System",
      themeDark: "Dark",
      themeLight: "Light",
      timelineTitle: "Chat Event Stream",
      timelineEmpty: "No events for this chat yet. Send a message to see run stages and network changes.",
      badges: {
        IDLE: "IDLE",
        OFFLINE_IDLE: "OFFLINE",
        WAITING_LLM: "THINKING",
        RUNNING_TOOL: "RUNNING TOOL",
        BACKGROUND_TASK: "BACKGROUND",
        API_RETRY: "API RETRY",
        SUSPECT_STALL: "STALLED",
        DISCONNECTED_HANG: "DISCONNECTED",
      },
      timeout: "Timeout",
      fail: "Failed",
      down: "Down",
      directShort: "Direct",
      proxyShort: "Proxy",
      latestOk: (t, ms, code, dual) => `Reachable: ${t} · ${ms} ms (HTTP ${code})${dual}`,
      latestOk404Note: "Any upstream HTTP response (including 404) confirms TLS and route reachability",
      latestFail: (t, err, dual) => `Failed: ${t} · ${err}${dual}`,
      dualNote: (d, p) => ` · [Direct ${d} / Proxy ${p}]`,
      srcHooks: "Hooks",
      srcLog: "Log",
      srcWait: "Wait",
      waitActivity: "Waiting",
      stepLabel: (n) => `Step #${n}`,
      hookEvents: {
        PreInvocation: "Invocation started",
        PostInvocation: "Invocation done",
        Stop: "Turn ended",
      },
      hookAgo: (s) => `${s}s ago`,
      secAgo: (s) => `${s}s ago`,
      apiErrAttempt: (n) => `API Error #${n}`,
      apiErrLabel: "API Error",
      bgTaskLabel: "Background",
      noLog: "No logs yet",
      modeProxy: (addr) => `Proxy ${addr}`,
      modePacUnsupported: "PAC (Unsupported)",
      pacTooltip: (u) => `System PAC proxy detected (${u || "AutoConfigURL"}); unsupported, set a manual proxy in Settings if needed`,
      modeTun: "TUN / Fake-IP",
      modeDirect: "Direct",
      netDown: (n) => `Down (${n} ${n === 1 ? "fail" : "fails"})`,
      netRetry: (n) => `Retrying (${n} ${n === 1 ? "fail" : "fails"})`,
      netHealthy: "Healthy",
      netProbing: "Probing",
      lsHealthy: "Healthy",
      lsHealthyTitle: "Language Server /healthz OK",
      lsRunning: "Running",
      lsUnavailable: "Unavailable",
      lsNotFound: "Not found",
      lsSkipped: "Socket probe N/A",
      lsStopped: "Not running",
      lsConns: (e, s) => `${e} HTTPS ${e === 1 ? "conn" : "conns"}${s > 0 ? ` (${s} SYN)` : ""}`,
      lsConnsTitle: "Established TLS:443 connections",
      routeTag: { tun: " · TUN", proxy: " · Proxy", direct: " · Direct" },
      cacheHit: (r) => (r != null ? `Cache ${r}%` : "Cache --"),
      callsCount: (c) => (c != null ? `${c} ${c === 1 ? "call" : "calls"}` : "-- calls"),
      lastSub: (inp, out) => `New ${inp} · Out ${out}`,
      lastSubEmpty: "Out --",
      sessSub: (inp, out) => `In ${inp} · Out ${out}`,
      sessSubEmpty: "In -- · Out --",
      todaySub: (s, c) => (s != null ? `${s} ${s === 1 ? "chat" : "chats"} · ${c} ${c === 1 ? "call" : "calls"}` : "-- chats"),
      convLabel: (id) => `Chat: ${id ? id.slice(0, 8) : "--"}`,
      allTime: (tot, s) => `All-time: ${tot} (${s} ${s === 1 ? "chat" : "chats"})`,
      tokensFallback: (inp, out) => `Tokens In ${inp} · Out ${out}`,
      tokensEmpty: "All-time: --",
      syncTime: (t) => `Sync: ${t}`,
      authExpiredBanner: "Monitor auth expired (HTTP 401/403). Showing last synced snapshot; reopen panel to refresh token.",
      sidecarDisconnectedBanner: "Lost connection to local monitor service. Showing last synced snapshot; retrying automatically…",
      simTimer: (sec) => (sec != null ? `Test ${sec}s` : "Testing"),
      netSimDown: "Simulated Down (Test)",
      netDownNoCount: "Down",
      chartSimNotice: "Test active: chart still reflects real probes until test ends",
      alertBtnProbe: "Probe Now",
      alertBtnProxy: "Proxy Settings",
      alertBtnStopSim: "Stop Test",
      tlLevels: { info: "Info", active: "Active", success: "OK", warn: "Warn", error: "Error" },
    },
  };

  function detectBrowserLang() {
    try {
      const saved = localStorage.getItem("asm-lang");
      if (saved === "zh" || saved === "en") return saved;
    } catch {
    }
    const nav = String(navigator.language || navigator.userLanguage || "").toLowerCase();
    return nav.startsWith("zh") ? "zh" : "en";
  }

  ns.state = ns.state || {
    currentLang: detectBrowserLang(),
    lastData: null,
    pendingLangSave: false,
    lastSeverity: null,
    lastSparkSig: "",
    lastTimelineSig: "",
    lastConfigSig: "",
    configuredTheme: "auto",
    hasCfgError: false,
    hasProxyError: false,
    proxyDraftDirty: false,
  };

  function dict() {
    return I18N[ns.state.currentLang] || I18N.zh;
  }

  function applyStaticI18n(lang) {
    ns.state.currentLang = lang === "en" ? "en" : "zh";
    const d = dict();
    const { $, format } = ns;
    document.documentElement.lang = d.htmlLang;
    document.title = d.docTitle;

    for (const el of document.querySelectorAll("[data-i18n]")) {
      const key = el.dataset.i18n;
      if (d[key] != null) el.textContent = d[key];
    }
    for (const el of document.querySelectorAll("[data-i18n-title]")) {
      const key = el.dataset.i18nTitle;
      if (d[key] != null) {
        el.setAttribute("data-tip", d[key]);
        el.removeAttribute("title");
      }
    }
    for (const el of document.querySelectorAll("[data-i18n-opt]")) {
      const key = el.dataset.i18nOpt;
      if (d[key] != null) el.textContent = d[key];
    }
    for (const el of document.querySelectorAll("[data-i18n-aria]")) {
      const key = el.dataset.i18nAria;
      if (d[key] != null) el.setAttribute("aria-label", d[key]);
    }

    $("btnSettings")?.setAttribute("aria-label", d.btnSettingsAria);
    format.setText("btnSimText", ns.state.lastData?.simulation?.active ? d.btnSimStop : d.btnSimStart);
    $("alertStripLead").innerHTML = d.alertLeadHtml;
    format.setText("alertStripSteps", d.alertSteps);

    $("btnLangZh")?.classList.toggle("active", ns.state.currentLang === "zh");
    $("btnLangZh")?.setAttribute("aria-pressed", String(ns.state.currentLang === "zh"));
    $("btnLangEn")?.classList.toggle("active", ns.state.currentLang === "en");
    $("btnLangEn")?.setAttribute("aria-pressed", String(ns.state.currentLang === "en"));

    if (!ns.state.lastData) {
      format.setText("verdictBadge", d.initBadge);
      format.setText("verdictHeadline", d.initHeadline);
      format.setText("verdictSummary", d.initSummary);
      format.setText("chartTooltip", d.chartWait);
      format.setText("agentLogAge", d.noLog);
      format.setText("tokCacheRate", d.cacheHit(null));
      format.setText("tokCalls", d.callsCount(null));
      format.setText("tokLastSub", d.lastSubEmpty);
      format.setText("tokSessSub", d.sessSubEmpty);
      format.setText("tokTodaySub", d.todaySub(null, null));
      format.setText("tokenInfo", d.tokensEmpty);
      format.setText("convBadge", d.convLabel(null));
      format.setText("lastRefresh", d.syncTime("--"));
      const tl = $("timelineList");
      if (tl) {
        tl.innerHTML = `<div class="empty-state">${format.escapeHtml(d.timelineEmpty)}</div>`;
      }
    }
  }

  ns.i18n = {
    I18N,
    detectBrowserLang,
    dict,
    applyStaticI18n,
  };
})(globalThis.AsmUI = globalThis.AsmUI || {});
