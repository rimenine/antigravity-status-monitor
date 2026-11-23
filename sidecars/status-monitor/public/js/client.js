(function (ns) {
  const POLL_VISIBLE_INTERVAL_MS = 1000;
  const REQUEST_TIMEOUT_MS = 4500;

  function createClient({ onRender } = {}) {
    const { $, state, i18n, format } = ns;
    const urlParams = new URLSearchParams(window.location.search);
    const urlConvId = urlParams.get("conversationId") || "";
    const urlToken = urlParams.get("token") || "";

    let pollHealthy = false;
    let liveStarted = false;
    let pollStopped = false;
    let pollTimer = null;
    let pollInFlight = null;
    let pollAbortController = null;
    let actionBannerTimer = null;
    let consecutivePollFailures = 0;
    let persistentBannerReason = null;
    const syncChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel("asm-status-sync") : null;

    function normalizeConvId(raw) {
      if (typeof raw !== "string") return "";
      const trimmed = raw.trim();
      return trimmed && trimmed !== "auto" ? trimmed : "";
    }

    function getCurrentConvId() {
      return normalizeConvId(window.sidecar?.conversationId) || normalizeConvId(urlConvId);
    }

    function getConvScope() {
      return { pageConvId: getCurrentConvId() };
    }

    function buildStatusEndpoint() {
      const currentConvId = getCurrentConvId();
      if (!currentConvId) return "/api/status";
      const statusParams = new URLSearchParams();
      statusParams.set("conversationId", currentConvId);
      return `/api/status?${statusParams.toString()}`;
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
      const externalSignal = options.signal;
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
          throw new Error(i18n.dict().actionTimeout);
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
      const res = await fetchWithTimeout(
        path,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
        6000,
      );
      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        const err = new Error(errData?.detail || errData?.error || `HTTP ${res.status}`);
        err.status = res.status;
        err.code = errData?.errorCode || errData?.error || "";
        throw err;
      }
      return res.json();
    }

    function notifySiblingPanels() {
      if (!syncChannel) return;
      try {
        syncChannel.postMessage({ type: "refresh", scope: getCurrentConvId(), ts: Date.now() });
      } catch {
      }
    }

    function updateConnectionDot() {
      const dot = $("sseDot");
      if (!dot) return;
      dot.classList.toggle("offline", !pollHealthy);
    }

    function getPersistentBannerText(reason) {
      const d = i18n.dict();
      if (reason === "auth") return d.authExpiredBanner;
      if (reason === "offline") return d.sidecarDisconnectedBanner;
      return "";
    }

    function renderPersistentBanner() {
      if (!persistentBannerReason) return;
      const banner = $("actionBanner");
      if (!banner) return;
      const msg = getPersistentBannerText(persistentBannerReason);
      if (!msg) return;
      banner.textContent = msg;
      banner.classList.add("visible");
    }

    function showPersistentBanner(reason) {
      persistentBannerReason = reason;
      if (actionBannerTimer) {
        clearTimeout(actionBannerTimer);
        actionBannerTimer = null;
      }
      renderPersistentBanner();
    }

    function clearPersistentBanner() {
      if (!persistentBannerReason) return;
      persistentBannerReason = null;
      if (actionBannerTimer) return;
      const banner = $("actionBanner");
      if (!banner) return;
      banner.textContent = "";
      banner.classList.remove("visible");
    }

    function syncPersistentBannerLang() {
      if (!persistentBannerReason || actionBannerTimer) return;
      renderPersistentBanner();
    }

    function clearActionError() {
      if (actionBannerTimer) {
        clearTimeout(actionBannerTimer);
        actionBannerTimer = null;
      }
      if (persistentBannerReason) {
        renderPersistentBanner();
        return;
      }
      const banner = $("actionBanner");
      if (!banner) return;
      banner.textContent = "";
      banner.classList.remove("visible");
    }

    function reportActionError(err) {
      const d = i18n.dict();
      const msg = `${d.actionFailedPrefix}${err?.message || d.unknownError}`;
      const banner = $("actionBanner");
      if (banner) {
        banner.textContent = msg;
        banner.classList.add("visible");
        if (actionBannerTimer) clearTimeout(actionBannerTimer);
        actionBannerTimer = setTimeout(() => clearActionError(), 6000);
        return;
      }
      format.setText("verdictSummary", msg);
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
      const endpoint = buildStatusEndpoint();

      const task = (async () => {
        try {
          const res = await fetchWithTimeout(endpoint, {
            method: "GET",
            signal: controller?.signal,
          });
          if (!res.ok) {
            if ((res.status === 401 || res.status === 403) && !state.lastData) {
              const d = i18n.dict();
              $("ambientGlow")?.style.setProperty(
                "--hero-glow",
                ns.GLOW_COLORS?.danger || "var(--mon-danger-soft)",
              );
              $("heroCard")?.setAttribute("data-severity", "danger");
              if ($("orbIcon") && ns.ICONS?.danger) {
                $("orbIcon").innerHTML = ns.ICONS.danger;
              }
              state.lastSeverity = "danger";
              format.setText("verdictBadge", d.authDeniedBadge);
              format.setText("verdictHeadline", d.authDeniedHeadline);
              format.setText("verdictSummary", d.authDeniedSummary);
            }
            const httpErr = new Error(`HTTP ${res.status}`);
            httpErr.status = res.status;
            throw httpErr;
          }
          const data = await res.json();
          if (controller?.signal?.aborted || pollAbortController !== controller) {
            return data;
          }
          pollHealthy = true;
          consecutivePollFailures = 0;
          clearPersistentBanner();
          updateConnectionDot();
          onRender?.(data, getConvScope());
          return data;
        } catch (err) {
          if (
            pollStopped ||
            (controller?.signal?.aborted &&
              (pollAbortController !== controller || controller.signal.reason?.message === "superseded"))
          ) {
            return null;
          }
          pollHealthy = false;
          updateConnectionDot();
          if (err?.status === 401 || err?.status === 403) {
            consecutivePollFailures = 0;
            if (state.lastData) {
              showPersistentBanner("auth");
            }
          } else {
            consecutivePollFailures += 1;
            if (consecutivePollFailures >= 3 && persistentBannerReason !== "auth") {
              showPersistentBanner("offline");
            }
          }
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
        syncChannel.onmessage = (ev) => {
          const msgScope = ev?.data?.scope || "";
          if (msgScope && msgScope !== getCurrentConvId()) return;
          if (!pollStopped && document.visibilityState !== "hidden") {
            clearPollTimer();
            pollStatus({ manual: true }).finally(() => scheduleNextPoll());
          }
        };
      }

      pollStatus({ manual: true }).finally(() => scheduleNextPoll());
    }

    return {
      getConvScope,
      postJson,
      notifySiblingPanels,
      clearActionError,
      reportActionError,
      syncPersistentBannerLang,
      pollStatus,
      clearPollTimer,
      scheduleNextPoll,
      stopPolling,
      startPolling,
    };
  }

  ns.createClient = createClient;
})(globalThis.AsmUI = globalThis.AsmUI || {});
