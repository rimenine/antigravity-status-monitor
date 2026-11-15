(function (ns) {
  const { $, state, i18n, format, render, createClient } = ns;

  format.initThemeObserver();
  i18n.applyStaticI18n(state.currentLang);

  const client = createClient({
    onRender: (data, convScope) => render.render(data, convScope),
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

  $("btnSim").addEventListener("click", () => {
    const nextActive = !Boolean(state.lastData?.simulation?.active);
    runActionButton($("btnSim"), () => client.postJson("/api/simulate", { active: nextActive }));
  });

  $("convSelect").addEventListener("change", () => {
    const next = $("convSelect").value || "auto";
    client.setSelectedConvScope(next);
    state.lastConvOptsSig = "";
    state.lastTimelineSig = "";
    client.clearActionError();
    client.clearPollTimer();
    client.pollStatus({ manual: true }).finally(() => client.scheduleNextPoll());
  });

  $("btnSettings").addEventListener("click", () => {
    const open = $("settingsPanel").classList.toggle("open");
    $("btnSettings").classList.toggle("active", open);
  });

  async function switchLang(nextLang) {
    if (!["zh", "en"].includes(nextLang)) return;
    state.pendingLangSave = true;
    try {
      localStorage.setItem("asm-lang", nextLang);
    } catch {
    }
    state.lastSparkSig = "";
    state.lastTimelineSig = "";
    state.lastConfigSig = "";
    i18n.applyStaticI18n(nextLang);
    if (state.lastData) {
      render.render(state.lastData, client.getConvScope());
    }
    try {
      client.clearActionError();
      await client.postJson("/api/config", { lang: nextLang });
      render.showCfgError("");
      await client.pollStatus({ manual: true });
      client.notifySiblingPanels();
      client.scheduleNextPoll();
    } catch (err) {
      client.reportActionError(err);
    } finally {
      state.pendingLangSave = false;
    }
  }

  $("btnLangZh").addEventListener("click", () => switchLang("zh"));
  $("btnLangEn").addEventListener("click", () => switchLang("en"));

  const saveCfg = async () => {
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
      if (manualProxyChanged || probeUrlChanged) {
        await client.postJson("/api/probe");
      }
      await client.pollStatus({ manual: true });
      client.notifySiblingPanels();
      client.scheduleNextPoll();
    } catch (err) {
      render.showCfgError(err?.message || "Invalid config");
      client.reportActionError(err);
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
