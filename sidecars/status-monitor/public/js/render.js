(function (ns) {
  function renderSparkline(probes) {
    const { $, state, i18n, format } = ns;
    const d = i18n.dict();
    const svg = $("sparkSvg");
    const tooltip = $("chartTooltip");
    if (!probes || probes.length === 0) {
      if (state.lastSparkSig !== "empty:" + state.currentLang) {
        state.lastSparkSig = "empty:" + state.currentLang;
        svg.innerHTML = "";
        format.setText("chartTooltip", d.chartWait);
      }
      return;
    }

    const list = probes.slice(-40);
    const last = list[list.length - 1];
    const sig =
      `${state.currentLang}|` +
      list.map((p) => `${p.ts}:${p.ok ? 1 : 0}:${p.latencyMs}`).join("|") +
      `|${last.dual?.direct?.latencyMs ?? ""}:${last.dual?.proxy?.latencyMs ?? ""}`;

    if (sig === state.lastSparkSig) return;
    state.lastSparkSig = sig;

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
    if (curRun.length > 0) okRuns.push(curRun);

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
          return `<rect x="${(c.x - 2.2).toFixed(1)}" y="${padTop}" width="4.4" height="${usableH}" rx="2" fill="var(--mon-danger)" opacity="0.82"><title>${format.fmtTime(c.p.ts)} ${d.fail}: ${format.escapeHtml(c.p.error)}</title></rect>`;
        }
        const r = isLast ? 3.3 : 1.7;
        const opacity = isLast ? 1 : 0.55;
        return `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="${r}" fill="var(--mon-ok)" opacity="${opacity}"><title>${format.fmtTime(c.p.ts)} ${c.p.latencyMs} ms</title></circle>`;
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
      ? d.latestOk(format.fmtTime(last.ts), last.latencyMs, last.statusCode, dualNote)
      : d.latestFail(format.fmtTime(last.ts), last.error || d.timeout, dualNote);
    tooltip.textContent = tipText;
    tooltip.title = tipText;
  }

  function createTimelineItemEl(ev) {
    const { format } = ns;
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
    time.textContent = format.fmtTime(ev.ts);

    row.append(dot, body, time);
    return row;
  }

  function renderTimeline(events) {
    const { $, state, i18n, format } = ns;
    const d = i18n.dict();
    const tl = $("timelineList");
    const slice = Array.isArray(events) ? events.slice(0, 15) : [];
    const sig =
      slice.length === 0
        ? `empty:${state.currentLang}`
        : `${state.currentLang}|` + slice.map((e) => `${e.id}:${e.title}:${e.detail}`).join("|");
    if (sig === state.lastTimelineSig) return;
    state.lastTimelineSig = sig;

    if (slice.length === 0) {
      tl.innerHTML = `<div class="empty-state">${format.escapeHtml(d.timelineEmpty)}</div>`;
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

  function showCfgError(msg) {
    const el = ns.$("cfgError");
    if (!el) return;
    ns.state.hasCfgError = Boolean(msg);
    el.textContent = msg || "";
    el.classList.toggle("visible", ns.state.hasCfgError);
  }

  function syncSettings(config) {
    const { $, state } = ns;
    const sig = JSON.stringify([
      config.intervalMs,
      config.stallThresholdSec,
      config.probeUrl,
      config.manualProxyUrl || "",
      config.theme || "auto",
      config.lang || "zh",
      Boolean(config.notifyOnDisconnect),
    ]);
    if (sig === state.lastConfigSig) return;
    state.lastConfigSig = sig;

    if (document.activeElement !== $("cfgInterval")) $("cfgInterval").value = String(config.intervalMs);
    if (document.activeElement !== $("cfgStall")) $("cfgStall").value = String(config.stallThresholdSec);
    if (!state.hasCfgError && document.activeElement !== $("cfgProbeUrl")) {
      $("cfgProbeUrl").value = config.probeUrl;
    }
    if (!state.hasCfgError && document.activeElement !== $("cfgManualProxy")) {
      $("cfgManualProxy").value = config.manualProxyUrl || "";
    }
    if (document.activeElement !== $("cfgTheme")) $("cfgTheme").value = config.theme || "auto";
    $("cfgNotify").checked = Boolean(config.notifyOnDisconnect);
  }

  function renderHeroAndProbe(data, d) {
    const { $, state, format, ICONS, GLOW_COLORS } = ns;
    const { verdict, simulation, metrics, probes } = data;
    const hero = $("heroCard");
    if (state.lastSeverity !== verdict.severity) {
      state.lastSeverity = verdict.severity;
      $("ambientGlow").style.setProperty("--hero-glow", GLOW_COLORS[verdict.severity] || "var(--mon-accent-soft)");
      hero.setAttribute("data-severity", verdict.severity);
      $("orbIcon").innerHTML = ICONS[verdict.severity] || ICONS.ok;
    }

    format.setText("verdictBadge", d.badges[verdict.code] || verdict.code);
    format.setText("elapsedTimer", verdict.phase === "idle" ? "READY" : format.fmtElapsed(verdict.elapsedSec));
    format.setText("verdictHeadline", verdict.headline);
    format.setText("verdictSummary", verdict.summary);

    $("alertStrip").classList.toggle("visible", verdict.code === "DISCONNECTED_HANG");
    $("btnSim").classList.toggle("danger-active", Boolean(simulation?.active));
    format.setText("btnSimText", simulation?.active ? d.btnSimStop : d.btnSimStart);

    const latestProbe = metrics.latestProbe;
    format.setText("rttNow", latestProbe ? (latestProbe.ok ? `${latestProbe.latencyMs}ms` : d.timeout) : "--");
    format.setText("rttAvg", metrics.avgLatencyMs != null ? `${metrics.avgLatencyMs}ms` : "--");
    format.setText("rttRate", metrics.successRate != null ? `${metrics.successRate}%` : "--");
    renderSparkline(probes);
  }

  function renderTelemetryCards(data, d) {
    const { $, format } = ns;
    const { verdict, config, hook, transcript, ls, metrics } = data;
    const latestProbe = metrics.latestProbe;

    format.setText(
      "agentSourceBadge",
      verdict.source === "hook" ? d.srcHooks : verdict.source === "transcript" ? d.srcLog : d.srcWait,
    );
    const stepNum = transcript.latestStepIndex ?? hook.stepIdx;
    format.setText("agentStepVal", stepNum != null ? `Step #${stepNum}` : d.waitActivity);
    // 若最近 Hook 事件（如 PreInvocation）比旧对话日志更新，则优先展示 Hook 距今秒数，避免显示“PreInvocation · 120s 前写入”
    const hasHookAge = hook.lastEvent && verdict.hookAgeSec != null;
    const useHookAge =
      hasHookAge && (verdict.silentSec == null || verdict.hookAgeSec <= verdict.silentSec);
    const silentText = verdict.silentSec != null ? d.secAgo(verdict.silentSec) : d.noLog;
    const heartbeatText = hook.lastEvent
      ? useHookAge
        ? `${hook.lastEvent} · ${d.hookAgo(verdict.hookAgeSec)}`
        : `${hook.lastEvent} · ${silentText}`
      : silentText;
    format.setText("agentLogAge", heartbeatText);

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
    format.setText("netModeBadge", modeText);
    if ($("netModeBadge")) {
      $("netModeBadge").title = isPacUnsupported ? d.pacTooltip(proxyCfg?.pacUrl || "") : "";
    }
    format.setText(
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
    format.setText(
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

    format.setText(
      "lsHealthBadge",
      ls.healthz?.reachable === true
        ? "healthz OK"
        : ls.running
          ? d.lsRunning
          : ls.running === null
            ? d.lsUnavailable
            : d.lsNotFound,
    );
    format.setText(
      "lsConnVal",
      ls.running === null
        ? d.lsSkipped
        : ls.running === false
          ? d.lsStopped
          : d.lsConns(ls.established443, ls.synSent443),
    );
    const routeTag = d.routeTag[ls.route] || "";
    format.setText("lsPidVal", ls.pids?.length ? `PID: ${ls.pids.join(", ")}${routeTag}` : "PID: --");
  }

  function renderTokens(data, d) {
    const { $, format } = ns;
    const { tokenStats, transcript } = data;
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

    format.setText("tokCacheRate", d.cacheHit(sess?.cacheHitRate));
    format.setText("tokCalls", d.callsCount(sess?.calls));
    format.setText("tokLastCtx", last ? format.fmtTokens(last.contextTotal) : "--");
    format.setText(
      "tokLastSub",
      last ? d.lastSub(format.fmtTokens(last.input), format.fmtTokens(last.output)) : "Out --",
    );
    format.setText("tokSessTotal", sess ? format.fmtTokens(sess.total) : "--");
    format.setText(
      "tokSessSub",
      sess ? `In ${format.fmtTokens(sess.input)} · Out ${format.fmtTokens(sess.output)}` : "In -- / Out --",
    );
    format.setText("tokTodayTotal", today ? format.fmtTokens(today.total) : "--");
    format.setText("tokTodaySub", d.todaySub(today?.sessions, today?.calls));

    const barTotal = sess?.total || 0;
    $("tokBarIn").style.width = barTotal > 0 ? `${((sess.input / barTotal) * 100).toFixed(1)}%` : "0%";
    $("tokBarCache").style.width = barTotal > 0 ? `${((sess.cacheRead / barTotal) * 100).toFixed(1)}%` : "0%";
    $("tokBarOut").style.width = barTotal > 0 ? `${((sess.output / barTotal) * 100).toFixed(1)}%` : "0%";

    format.setText("tokLegIn", sess ? format.fmtTokens(sess.input) : "--");
    format.setText("tokLegCache", sess ? format.fmtTokens(sess.cacheRead) : "--");
    format.setText("tokLegOut", sess ? format.fmtTokens(sess.output) : "--");

    const allTok = tokenStats?.allTime;
    format.setText(
      "tokenInfo",
      allTok
        ? d.allTime(format.fmtTokens(allTok.total), allTok.sessions)
        : transcript.tokens
          ? `Tokens In:${transcript.tokens.input ?? "-"} Out:${transcript.tokens.output ?? "-"}`
          : "Tokens: --",
    );
  }

  function render(data) {
    const { $, state, i18n, format } = ns;
    state.lastData = data;
    const { config, hook, transcript, events } = data;

    if (!state.pendingLangSave && config.lang && config.lang !== state.currentLang) {
      try {
        localStorage.setItem("asm-lang", config.lang);
      } catch {
      }
      i18n.applyStaticI18n(config.lang);
    }
    const d = i18n.dict();
    format.applyTheme(config.theme || "auto");

    renderHeroAndProbe(data, d);
    renderTelemetryCards(data, d);
    renderTokens(data, d);
    syncSettings(config);

    const convId = data.activeConversationId || hook.conversationId || transcript.conversationId;
    format.setText("convBadge", d.convLabel(convId));
    if ($("convBadge")) {
      $("convBadge").title = "";
    }

    renderTimeline(events);
    format.setText("lastRefresh", d.syncTime(format.fmtTime(data.now)));
  }

  ns.render = {
    render,
    renderSparkline,
    renderTimeline,
    showCfgError,
    syncSettings,
  };
})(globalThis.AsmUI = globalThis.AsmUI || {});
