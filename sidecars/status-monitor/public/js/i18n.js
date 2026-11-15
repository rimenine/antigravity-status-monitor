(function (ns) {
  ns.$ = (id) => document.getElementById(id);

  ns.ICONS = {
    ok: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    active: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
    tool: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
    warning: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    danger: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
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
    lastConvOptsSig: "",
    configuredTheme: "auto",
    hasCfgError: false,
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

    ns.state.lastConvOptsSig = "";
    $("btnSettings")?.setAttribute("aria-label", d.btnSettingsAria);
    format.setText("btnSimText", ns.state.lastData?.simulation?.active ? d.btnSimStop : d.btnSimStart);
    $("alertStripLead").innerHTML = d.alertLeadHtml;
    format.setText("alertStripSteps", d.alertSteps);

    $("btnLangZh")?.classList.toggle("active", ns.state.currentLang === "zh");
    $("btnLangEn")?.classList.toggle("active", ns.state.currentLang === "en");

    if (!ns.state.lastData) {
      format.setText("verdictBadge", d.initBadge);
      format.setText("verdictHeadline", d.initHeadline);
      format.setText("verdictSummary", d.initSummary);
      format.setText("chartTooltip", d.chartWait);
      format.setText("agentLogAge", d.noLog);
      format.setText("tokCacheRate", d.cacheHit(null));
      format.setText("tokCalls", d.callsCount(null));
      format.setText("tokTodaySub", d.todaySub(null, null));
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
