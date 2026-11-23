(function (ns) {
  const { $, state, i18n, format, render, createClient } = ns;

  format.initThemeObserver();
  i18n.applyStaticI18n(state.currentLang);

  const client = createClient({
    onRender: (data) => render.render(data),
  });

  async function runActionButton(btn, actionFn, { activeDurationMs = 0 } = {}) {
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    btn.classList.add("active");
    try {
      client.clearActionError();
      await actionFn();
      await client.pollStatus({ manual: true });
      client.notifySiblingPanels();
      client.scheduleNextPoll();
    } catch (err) {
      client.reportActionError(err);
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
    runActionButton($("btnProbe"), () => client.postJson("/api/probe"), { activeDurationMs: 350 });
  });

  $("btnAlertProbe")?.addEventListener("click", () => {
    runActionButton($("btnAlertProbe"), () => client.postJson("/api/probe"), { activeDurationMs: 350 });
  });

  $("btnAlertProxy")?.addEventListener("click", () => {
    setSettingsOpen(true);
    const proxyInput = $("cfgManualProxy");
    if (proxyInput) {
      proxyInput.scrollIntoView?.({ block: "nearest" });
      proxyInput.focus();
    }
  });

  $("btnAlertStopSim")?.addEventListener("click", () => {
    const currentConvId = client.getConvScope().pageConvId || null;
    runActionButton($("btnAlertStopSim"), () =>
      client.postJson("/api/simulate", { active: false, conversationId: currentConvId }),
    );
  });

  $("btnSim").addEventListener("click", () => {
    const nextActive = !Boolean(state.lastData?.simulation?.active);
    const currentConvId = client.getConvScope().pageConvId || null;
    runActionButton($("btnSim"), () =>
      client.postJson("/api/simulate", { active: nextActive, conversationId: currentConvId }),
    );
  });

  function setSettingsOpen(open, { restoreFocus = false } = {}) {
    const panel = $("settingsPanel");
    const btn = $("btnSettings");
    if (!panel || !btn) return;
    const isOpen = Boolean(open);
    panel.classList.toggle("open", isOpen);
    btn.classList.toggle("active", isOpen);
    btn.setAttribute("aria-expanded", String(isOpen));
    if (!isOpen && restoreFocus) {
      btn.focus();
    }
  }

  $("btnSettings").addEventListener("click", () => {
    const nextOpen = !$("settingsPanel")?.classList.contains("open");
    setSettingsOpen(nextOpen);
  });

  function initTooltip() {
    const tipEl = $("uiTooltip");
    if (!tipEl) return () => {};
    let activeTarget = null;
    let showTimer = null;

    function clearTimer() {
      if (showTimer) {
        clearTimeout(showTimer);
        showTimer = null;
      }
    }

    function positionTip(target) {
      if (!target || !tipEl.classList.contains("visible")) return;
      const rect = target.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        hideTip();
        return;
      }
      tipEl.style.left = "0px";
      tipEl.style.top = "0px";
      const tipRect = tipEl.getBoundingClientRect();
      const pad = 8;
      const gap = 6;
      let top = rect.top - tipRect.height - gap;
      if (top < pad) {
        top = rect.bottom + gap;
      }
      if (top + tipRect.height > window.innerHeight - pad) {
        top = Math.max(pad, window.innerHeight - tipRect.height - pad);
      }
      const centerX = rect.left + rect.width / 2 - tipRect.width / 2;
      const left = Math.min(Math.max(pad, centerX), Math.max(pad, window.innerWidth - tipRect.width - pad));
      tipEl.style.left = `${Math.round(left)}px`;
      tipEl.style.top = `${Math.round(top)}px`;
    }

    function showTip(target) {
      const text = target?.getAttribute?.("data-tip")?.trim();
      if (!text) {
        hideTip();
        return;
      }
      activeTarget = target;
      tipEl.textContent = text;
      tipEl.setAttribute("aria-hidden", "false");
      tipEl.classList.add("visible");
      positionTip(target);
    }

    function hideTip() {
      clearTimer();
      activeTarget = null;
      tipEl.classList.remove("visible");
      tipEl.setAttribute("aria-hidden", "true");
    }

    document.addEventListener("pointerover", (e) => {
      if (e.pointerType === "touch") return;
      const next = e.target?.closest?.("[data-tip]");
      if (!next) return;
      if (next === activeTarget && tipEl.classList.contains("visible")) return;
      clearTimer();
      showTimer = setTimeout(() => {
        showTimer = null;
        showTip(next);
      }, 80);
    });

    document.addEventListener("pointerout", (e) => {
      const current = e.target?.closest?.("[data-tip]");
      if (!current) return;
      const into = e.relatedTarget?.closest?.("[data-tip]");
      if (into === current) return;
      clearTimer();
      if (activeTarget === current) {
        hideTip();
      }
    });

    document.addEventListener("focusin", (e) => {
      const next = e.target?.closest?.("[data-tip]");
      if (next) {
        clearTimer();
        showTip(next);
      }
    });

    document.addEventListener("focusout", (e) => {
      const current = e.target?.closest?.("[data-tip]");
      if (current && current === activeTarget) {
        hideTip();
      }
    });

    window.addEventListener("scroll", hideTip, { capture: true, passive: true });
    window.addEventListener("resize", hideTip, { passive: true });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && tipEl.classList.contains("visible")) {
        hideTip();
      }
    });

    return () => {
      if (!activeTarget) return;
      if (!activeTarget.isConnected) {
        hideTip();
        return;
      }
      const nextText = activeTarget.getAttribute("data-tip")?.trim();
      if (!nextText) {
        hideTip();
        return;
      }
      if (tipEl.textContent !== nextText) {
        tipEl.textContent = nextText;
      }
      positionTip(activeTarget);
    };
  }

  ns.syncTooltip = initTooltip();

  // 仅保留 Esc 快捷关闭已展开的设置面板，避免与 IDE 辅助栏及输入法产生单键冲突
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("settingsPanel")?.classList.contains("open")) {
      e.preventDefault();
      setSettingsOpen(false, { restoreFocus: true });
    }
  });

  let langSwitchSeq = 0;
  let saveCfgSeq = 0;

  function isProxyError(err) {
    const code = String(err?.code || "");
    return (
      code === "INVALID_PROXY_URL" ||
      code === "INVALID_PROXY_PORT" ||
      code === "UNSUPPORTED_PROXY_PROTOCOL"
    );
  }

  async function switchLang(nextLang) {
    if (!["zh", "en"].includes(nextLang)) return;
    const seq = ++langSwitchSeq;
    state.pendingLangSave = true;
    try {
      localStorage.setItem("asm-lang", nextLang);
    } catch {
    }
    state.lastSparkSig = "";
    state.lastTimelineSig = "";
    state.lastConfigSig = "";
    i18n.applyStaticI18n(nextLang);
    client.syncPersistentBannerLang?.();
    if (state.lastData) {
      render.render(state.lastData);
    }
    try {
      client.clearActionError();
      await client.postJson("/api/config", { lang: nextLang });
      if (seq !== langSwitchSeq) return;
      if (!state.hasProxyError) {
        render.showCfgError("");
      }
      await client.pollStatus({ manual: true });
      if (seq !== langSwitchSeq) return;
      client.notifySiblingPanels();
      client.scheduleNextPoll();
    } catch (err) {
      if (seq === langSwitchSeq) {
        client.reportActionError(err);
      }
    } finally {
      if (seq === langSwitchSeq) {
        state.pendingLangSave = false;
      }
    }
  }

  $("btnLangZh").addEventListener("click", () => switchLang("zh"));
  $("btnLangEn").addEventListener("click", () => switchLang("en"));

  $("cfgManualProxy")?.addEventListener("input", () => {
    state.proxyDraftDirty = true;
  });

  const saveCfg = async () => {
    const seq = ++saveCfgSeq;
    render.showCfgError("");
    client.clearActionError();
    const nextTheme = $("cfgTheme").value;
    const nextProbeUrl = $("cfgProbeUrl").value.trim();
    const nextManualProxy = $("cfgManualProxy").value.trim();
    const prevManualProxy = state.lastData?.config?.manualProxyUrl || "";
    const prevProbeUrl = state.lastData?.config?.probeUrl || "";
    const manualProxyChanged = nextManualProxy !== prevManualProxy;
    const probeUrlChanged = nextProbeUrl !== prevProbeUrl;
    format.applyTheme(nextTheme);
    try {
      state.lastConfigSig = "";
      await client.postJson("/api/config", {
        intervalMs: Number($("cfgInterval").value),
        stallThresholdSec: Number($("cfgStall").value),
        probeUrl: nextProbeUrl,
        manualProxyUrl: nextManualProxy,
        theme: nextTheme,
        lang: state.currentLang,
        notifyOnDisconnect: $("cfgNotify").checked,
      });
      if (seq !== saveCfgSeq) return;
      state.proxyDraftDirty = false;
      if (manualProxyChanged || probeUrlChanged) {
        await client.postJson("/api/probe");
        if (seq !== saveCfgSeq) return;
      }
      await client.pollStatus({ manual: true });
      if (seq !== saveCfgSeq) return;
      client.notifySiblingPanels();
      client.scheduleNextPoll();
    } catch (err) {
      if (seq === saveCfgSeq) {
        render.showCfgError(err?.message || i18n.dict().invalidConfig, {
          isProxyError: isProxyError(err),
        });
      }
    }
  };

  $("cfgInterval").addEventListener("change", saveCfg);
  $("cfgStall").addEventListener("change", saveCfg);
  $("cfgProbeUrl").addEventListener("change", saveCfg);
  $("cfgManualProxy").addEventListener("change", saveCfg);
  $("cfgTheme").addEventListener("change", saveCfg);
  $("cfgNotify").addEventListener("change", saveCfg);

  if (document.readyState === "complete") {
    client.startPolling();
  } else {
    window.addEventListener("load", client.startPolling, { once: true });
  }
})(globalThis.AsmUI);
