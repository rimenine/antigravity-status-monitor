(function (ns) {
  function buildSparklineSvg(list, d, format) {
    const w = 360;
    const h = 64;
    const padTop = 8;
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
      if (c.p.ok) curRun.push(c);
      else if (curRun.length > 0) {
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
        if (!c.p.ok) {
          const tip = format.escapeHtml(`${format.fmtTime(c.p.ts)} ${d.fail}: ${c.p.error || d.timeout}`);
          return `<rect x="${(c.x - 2.2).toFixed(1)}" y="${padTop}" width="4.4" height="${usableH}" rx="2" fill="var(--mon-danger)" stroke="transparent" stroke-width="5" opacity="0.82" data-tip="${tip}"/>`;
        }
        const isLast = idx === coords.length - 1;
        const tip = format.escapeHtml(`${format.fmtTime(c.p.ts)} ${c.p.latencyMs} ms`);
        return `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="${isLast ? 3.3 : 1.7}" fill="var(--mon-ok)" stroke="transparent" stroke-width="6" opacity="${isLast ? 1 : 0.55}" data-tip="${tip}"/>`;
      })
      .join("");

    return `
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
  }

  function buildSparklineTooltip(last, d, format) {
    const dir = last.dual?.direct;
    const prx = last.dual?.proxy;
    const dualNote =
      dir && prx
        ? d.dualNote(dir.ok ? `${dir.latencyMs}ms` : d.down, prx.ok ? `${prx.latencyMs}ms` : d.down)
        : "";
    return last.ok
      ? d.latestOk(format.fmtTime(last.ts), last.latencyMs, last.statusCode, dualNote)
      : d.latestFail(format.fmtTime(last.ts), last.error || d.timeout, dualNote);
  }

  function setTip(el, text, { markHelp = false } = {}) {
    if (!el) return;
    const msg = String(text || "").trim();
    if (msg) {
      el.setAttribute("data-tip", msg);
      el.removeAttribute("title");
      if (markHelp) el.classList.add("has-tip");
    } else {
      el.removeAttribute("data-tip");
      el.removeAttribute("title");
      if (markHelp) el.classList.remove("has-tip");
    }
  }

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
        setTip(tooltip, "", { markHelp: true });
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
    svg.innerHTML = buildSparklineSvg(list, d, format);

    const tipText = buildSparklineTooltip(last, d, format);
    tooltip.textContent = tipText;
    setTip(
      tooltip,
      last.ok && last.statusCode >= 400 && last.statusCode < 500 && d.latestOk404Note ? d.latestOk404Note : "",
      { markHelp: true },
    );
  }

  function getTimelineLevelInfo(ev, d) {
    const level = ev?.level || "info";
    const label = d.tlLevels?.[level] || d.tlLevels?.info || level;
    return { level, label, showTag: level === "warn" || level === "error" };
  }

  function syncTimelineItemEl(row, ev, d) {
    const { format } = ns;
    const { level, label, showTag } = getTimelineLevelInfo(ev, d);

    const dot = row.querySelector(".tl-dot");
    if (dot) {
      dot.className = `tl-dot ${level}`;
      dot.setAttribute("role", "img");
      dot.setAttribute("aria-label", label);
    }

    const titleEl = row.querySelector(".tl-title");
    if (titleEl) {
      let tagEl = titleEl.querySelector(".tl-level-tag");
      if (showTag) {
        if (!tagEl) {
          tagEl = document.createElement("span");
          titleEl.prepend(tagEl);
        }
        tagEl.className = `tl-level-tag ${level}`;
        if (tagEl.textContent !== label) tagEl.textContent = label;
      } else if (tagEl) {
        tagEl.remove();
      }
      const titleTextEl = titleEl.querySelector(".tl-title-text");
      if (titleTextEl && titleTextEl.textContent !== (ev.title || "")) {
        titleTextEl.textContent = ev.title || "";
      }
    }

    const bodyEl = row.querySelector(".tl-body");
    let detailEl = row.querySelector(".tl-detail");
    if (ev.detail) {
      if (!detailEl && bodyEl) {
        detailEl = document.createElement("div");
        detailEl.className = "tl-detail";
        bodyEl.appendChild(detailEl);
      }
      if (detailEl && detailEl.textContent !== ev.detail) {
        detailEl.textContent = ev.detail;
      }
    } else if (detailEl) {
      detailEl.remove();
    }

    const timeEl = row.querySelector(".tl-time");
    const nextTime = format.fmtTime(ev.ts);
    if (timeEl && timeEl.textContent !== nextTime) {
      timeEl.textContent = nextTime;
    }
  }

  function createTimelineItemEl(ev, d) {
    const row = document.createElement("div");
    row.className = "tl-item";
    row.dataset.eventId = ev.id;

    const dot = document.createElement("span");
    dot.className = "tl-dot";
    const body = document.createElement("div");
    body.className = "tl-body";

    const title = document.createElement("div");
    title.className = "tl-title";
    const titleText = document.createElement("span");
    titleText.className = "tl-title-text";
    title.appendChild(titleText);
    body.appendChild(title);

    const time = document.createElement("span");
    time.className = "tl-time";

    row.append(dot, body, time);
    syncTimelineItemEl(row, ev, d);
    return row;
  }

  function updateTimelineFade(tl) {
    if (!tl) return;
    const hasMore =
      tl.scrollHeight > tl.clientHeight + 2 && tl.scrollTop + tl.clientHeight < tl.scrollHeight - 4;
    tl.classList.toggle("has-more-bottom", hasMore);
  }

  function renderTimeline(events) {
    const { $, state, i18n, format } = ns;
    const d = i18n.dict();
    const tl = $("timelineList");
    if (tl && !tl.dataset.fadeBound) {
      tl.dataset.fadeBound = "1";
      tl.addEventListener("scroll", () => updateTimelineFade(tl), { passive: true });
    }
    const slice = Array.isArray(events) ? events.slice(0, 15) : [];
    const sig =
      slice.length === 0
        ? `empty:${state.currentLang}`
        : `${state.currentLang}|` + slice.map((e) => `${e.id}:${e.level || ""}:${e.title}:${e.detail}`).join("|");
    if (sig === state.lastTimelineSig) {
      updateTimelineFade(tl);
      return;
    }
    state.lastTimelineSig = sig;

    if (slice.length === 0) {
      tl.innerHTML = `<div class="empty-state">${format.escapeHtml(d.timelineEmpty)}</div>`;
      updateTimelineFade(tl);
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
        syncTimelineItemEl(existing, ev, d);
        frag.appendChild(existing);
      } else {
        frag.appendChild(createTimelineItemEl(ev, d));
      }
    }
    tl.replaceChildren(frag);
    if (prevScrollTop > 4) {
      tl.scrollTop = prevScrollTop;
    }
    updateTimelineFade(tl);
  }

  function showCfgError(msg, { isProxyError = false } = {}) {
    const el = ns.$("cfgError");
    const proxyInput = ns.$("cfgManualProxy");
    const hasErr = Boolean(msg);
    ns.state.hasCfgError = hasErr;
    ns.state.hasProxyError = Boolean(hasErr && isProxyError);
    if (proxyInput) {
      if (ns.state.hasProxyError) proxyInput.setAttribute("aria-invalid", "true");
      else proxyInput.removeAttribute("aria-invalid");
    }
    if (!el) return;
    el.textContent = msg || "";
    el.classList.toggle("visible", hasErr);
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
    if (!state.hasProxyError && !state.proxyDraftDirty && document.activeElement !== $("cfgManualProxy")) {
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

    const isSim = Boolean(simulation?.active);
    const simLeftSec =
      isSim && simulation?.expiresAt && data.now
        ? Math.max(0, Math.ceil((simulation.expiresAt - data.now) / 1000))
        : null;

    format.setText("verdictBadge", d.badges[verdict.code] || verdict.code);
    format.setText(
      "elapsedTimer",
      isSim
        ? d.simTimer(simLeftSec)
        : verdict.phase === "idle"
          ? d.timerReady
          : format.fmtElapsed(verdict.elapsedSec),
    );
    format.setText("verdictHeadline", verdict.headline);
    format.setText("verdictSummary", verdict.summary);

    $("alertStrip").classList.toggle("visible", verdict.code === "DISCONNECTED_HANG");
    $("btnAlertStopSim")?.classList.toggle("visible", isSim);
    $("chartCard")?.classList.toggle("is-simulating", isSim);
    $("btnSim").classList.toggle("danger-active", isSim);
    format.setText("btnSimText", isSim ? d.btnSimStop : d.btnSimStart);

    const latestProbe = metrics.latestProbe;
    format.setText("rttNow", latestProbe ? (latestProbe.ok ? `${latestProbe.latencyMs}ms` : d.timeout) : "--");
    format.setText("rttAvg", metrics.avgLatencyMs != null ? `${metrics.avgLatencyMs}ms` : "--");
    format.setText("rttRate", metrics.successRate != null ? `${metrics.successRate}%` : "--");
    renderSparkline(probes);
  }

  function formatHeartbeatAge(verdict, hook, transcript, d) {
    const hasHookAge = hook.lastEvent && verdict.hookAgeSec != null;
    const useHookAge =
      hasHookAge && (verdict.silentSec == null || verdict.hookAgeSec <= verdict.silentSec);
    const silentText = verdict.silentSec != null ? d.secAgo(verdict.silentSec) : d.noLog;
    if (verdict.code === "BACKGROUND_TASK") {
      return `${d.bgTaskLabel} · ${useHookAge ? d.hookAgo(verdict.hookAgeSec) : silentText}`;
    }
    if (transcript.latestStepType === "ERROR_MESSAGE" && transcript.latestError && !useHookAge) {
      const tag = transcript.latestError.attempt != null ? d.apiErrAttempt(transcript.latestError.attempt) : d.apiErrLabel;
      return `${tag} · ${silentText}`;
    }
    if (hook.lastEvent) {
      const hookLabel = d.hookEvents?.[hook.lastEvent] || hook.lastEvent;
      return useHookAge ? `${hookLabel} · ${d.hookAgo(verdict.hookAgeSec)}` : `${hookLabel} · ${silentText}`;
    }
    return silentText;
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
    format.setText("agentStepVal", stepNum != null ? d.stepLabel(stepNum) : d.waitActivity);
    format.setText("agentLogAge", formatHeartbeatAge(verdict, hook, transcript, d));

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
    setTip($("netModeBadge"), isPacUnsupported ? d.pacTooltip(proxyCfg?.pacUrl || "") : "", { markHelp: true });
    const isSim = Boolean(data.simulation?.active);
    format.setText(
      "netStatusVal",
      isSim
        ? d.netSimDown
        : verdict.networkDown
          ? metrics.consecutiveFailures > 0
            ? d.netDown(metrics.consecutiveFailures)
            : d.netDownNoCount
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
    setTip($("netTargetVal"), isPacUnsupported ? d.pacTooltip(proxyCfg?.pacUrl || "") : "", { markHelp: true });

    const isLsHealthy = ls.healthz?.reachable === true;
    const hs = isLsHealthy ? d.lsHealthy : ls.running ? d.lsRunning : ls.running === null ? d.lsUnavailable : d.lsNotFound;
    format.setText("lsHealthBadge", hs);
    setTip($("lsHealthBadge"), isLsHealthy ? d.lsHealthyTitle : "", { markHelp: true });
    const connText = ls.running === null ? d.lsSkipped : ls.running === false ? d.lsStopped : d.lsConns(ls.established443, ls.synSent443);
    format.setText("lsConnVal", connText);
    setTip($("lsConnVal"), ls.running ? d.lsConnsTitle : "", { markHelp: true });
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
      last ? d.lastSub(format.fmtTokens(last.input), format.fmtTokens(last.output)) : d.lastSubEmpty,
    );
    format.setText("tokSessTotal", sess ? format.fmtTokens(sess.total) : "--");
    format.setText(
      "tokSessSub",
      sess ? d.sessSub(format.fmtTokens(sess.input), format.fmtTokens(sess.output)) : d.sessSubEmpty,
    );
    format.setText("tokTodayTotal", today ? format.fmtTokens(today.total) : "--");
    format.setText("tokTodaySub", d.todaySub(today?.sessions, today?.calls));

    const barTotal = sess?.total || 0;
    $("tokBarTrack")?.classList.toggle("is-empty", barTotal <= 0);
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
          ? d.tokensFallback(transcript.tokens.input ?? "-", transcript.tokens.output ?? "-")
          : d.tokensEmpty,
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
    setTip($("convBadge"), convId || "", { markHelp: true });

    renderTimeline(events);
    format.setText("lastRefresh", d.syncTime(format.fmtTime(data.now)));
    ns.syncTooltip?.();
  }

  ns.render = { render, renderSparkline, renderTimeline, showCfgError, syncSettings };
})(globalThis.AsmUI = globalThis.AsmUI || {});
