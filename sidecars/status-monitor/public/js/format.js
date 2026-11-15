(function (ns) {
  function setText(id, next) {
    const el = ns.$(id);
    const val = String(next ?? "");
    if (el && el.textContent !== val) {
      el.textContent = val;
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
    return new Date(ts).toLocaleTimeString(ns.state.currentLang === "en" ? "en-US" : "zh-CN", {
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

  function applyTheme(themePref = ns.state.configuredTheme) {
    ns.state.configuredTheme = themePref || "auto";
    if (ns.state.configuredTheme === "dark" || ns.state.configuredTheme === "light") {
      if (document.documentElement.getAttribute("data-theme") !== ns.state.configuredTheme) {
        document.documentElement.setAttribute("data-theme", ns.state.configuredTheme);
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

  function initThemeObserver() {
    new MutationObserver(() => {
      if (ns.state.configuredTheme === "auto") {
        applyTheme("auto");
      }
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    applyTheme("auto");
  }

  ns.format = {
    setText,
    fmtElapsed,
    fmtTokens,
    fmtTime,
    escapeHtml,
    applyTheme,
    initThemeObserver,
  };
})(globalThis.AsmUI = globalThis.AsmUI || {});
