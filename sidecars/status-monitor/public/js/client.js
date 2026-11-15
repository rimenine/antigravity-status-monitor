(function (ns) {
  const POLL_VISIBLE_INTERVAL_MS = 1000;
  const REQUEST_TIMEOUT_MS = 4500;
  const CONV_SCOPE_KEY = "asm-conv-scope";

  function createClient({ onRender } = {}) {
    const { $, state, i18n, format } = ns;
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
    let pollHealthy = false;
    let liveStarted = false;
    let pollStopped = false;
    let pollTimer = null;
    let pollInFlight = null;
    let pollAbortController = null;
    let actionBannerTimer = null;
    const syncChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel("asm-status-sync") : null;

    function getConvScope() {
      return { pageConvId, selectedConvScope };
    }

    function setSelectedConvScope(scope) {
      selectedConvScope = scope || "auto";
      persistConvScope(selectedConvScope);
    }

    function buildStatusEndpoint(scope = selectedConvScope) {
      const statusParams = new URLSearchParams();
      if (scope) statusParams.set("conversationId", scope);
      const statusQuery = statusParams.toString();
      return statusQuery ? `/api/status?${statusQuery}` : "/api/status";
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
        throw new Error(errData?.detail || errData?.error || `HTTP ${res.status}`);
      }
      return res.json();
    }

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
      const prefix = i18n.dict().actionFailedPrefix;
      const msg = `${prefix}${err?.message || "unknown"}`;
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
      const endpoint = buildStatusEndpoint(selectedConvScope);

      const task = (async () => {
        try {
          const res = await fetchWithTimeout(endpoint, {
            method: "GET",
            signal: controller?.signal,
          });
          if (!res.ok) {
            if ((res.status === 401 || res.status === 403) && !state.lastData) {
              const d = i18n.dict();
              format.setText("verdictBadge", d.authDeniedBadge);
              format.setText("verdictHeadline", d.authDeniedHeadline);
              format.setText("verdictSummary", d.authDeniedSummary);
            }
            throw new Error(`HTTP ${res.status}`);
          }
          const data = await res.json();
          if (controller?.signal?.aborted || pollAbortController !== controller) {
            return data;
          }
          pollHealthy = true;
          updateConnectionDot();
          onRender?.(data, getConvScope());
          return data;
        } catch {
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

    return {
      getConvScope,
      setSelectedConvScope,
      postJson,
      notifySiblingPanels,
      clearActionError,
      reportActionError,
      pollStatus,
      clearPollTimer,
      scheduleNextPoll,
      stopPolling,
      startPolling,
    };
  }

  ns.createClient = createClient;
})(globalThis.AsmUI = globalThis.AsmUI || {});
