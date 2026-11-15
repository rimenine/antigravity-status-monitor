[简体中文](README.md) | **English**

# Antigravity Status Monitor (`antigravity-status-monitor`)

When running long agent tasks in Antigravity, the main UI can stay stuck on a spinning **"Working"** state with no visible output — either because the model or local tools are still running, or because the request silently hung underneath due to a stalled stream or dropped connection.

Built with **zero external dependencies**, this Sidecar sits in Antigravity's auxiliary pane and brings together Lifecycle Hooks, `transcript.jsonl` writes, the local `Language Server` socket, upstream HTTPS probes, and token counts so you can quickly tell real progress apart from a silent hang ("false working" state).

---

## UI Preview

| Live Working State & Probe Chart | Hang Alert & Toast Preview | Settings & Live Event Stream |
| :---: | :---: | :---: |
| <img src="docs/screenshots/status-working-en.jpg" alt="Live Working State and Upstream Probe Chart" width="240" /> | <img src="docs/screenshots/alert-preview-en.jpg" alt="Simulated Hang Alert Banner and Desktop Notification" width="240" /> | <img src="docs/screenshots/settings-events-en.jpg" alt="Monitor Settings and Live Event Stream" width="240" /> |

---

## How It Works

Because a single spinner hides where execution paused, the panel tracks four direct signals:

1. **Lifecycle Hooks + Transcript Activity Timer**
   - [hooks.json](hooks.json) registers only `PreInvocation` and `Stop` (using Antigravity's bundled `agy-node` first, falling back to `node`).
   - Whenever new output lands in `transcript.jsonl` or a Hook fires, the silence timer resets immediately so long multi-tool turns aren't flagged as stuck.
2. **Silent Hang Detection, Differentiated Alerts & Host Health**
   - Combines how long the session has stayed silent against your stall threshold with host `Language Server` `/healthz` checks (located via `ANTIGRAVITY_LS_ADDRESS`), stuck `TCP 443 SYN_SENT` sockets, and upstream probe results. If Antigravity closes, the Sidecar exits cleanly on its own instead of sticking around as an orphan process.
   - **Cause-Specific Desktop Alerts & Bounded History**: Distinguishes **Upstream Connection Lost** (VPN/network timeout) from **Language Server Unreachable** when sending desktop notifications, and persists compact disconnect, LS-down, and recovery records to `.runtime/alerts.log` (bounded JSONL with automatic trimming) for post-hoc inspection.
3. **Dual-Link Upstream HTTPS Probes & Isolated Polling**
   - Periodically opens fresh short-lived HTTPS `GET` probes (defaulting to `https://daily-cloudcode-pa.googleapis.com`) across direct/TUN and proxy routes (reading env vars / OS proxy settings, plus an optional manual proxy with HTTP `Basic` auth or unauthenticated SOCKS5).
   - **Adaptive Short Polling & Strict Current-Chat Isolation**: Visible panels poll `/api/status` every 1s with short-lived requests and pause immediately when hidden (`visibilityState === "hidden"`), preventing Chromium's 6-connection-per-origin HTTP/1.1 limit from stalling new Sidecar tabs or action buttons. The UI provides no switcher control, and the backend removes `auto` switching and cross-directory conversation hijacking altogether—every conversation keeps a physically bucketed live event stream and only displays its own Hooks, tool steps, simulation alerts, and network changes, updating only when the host switches chats. `/api/events` SSE remains available on the backend for external consumers.
4. **Default Auth on All APIs + DNS Rebinding Guard + Strict CSP**
   - Binds strictly to `127.0.0.1` and validates the HTTP `Host` header against loopback addresses (`127.0.0.1`, `localhost`, `[::1]`) on every request to block DNS rebinding attacks;
   - **Enforces authentication on all `GET /api/*` and `POST /api/*` routes by default**: even standalone launches without `ANTIGRAVITY_SIDECAR_UI_TOKEN` automatically generate a random 48-char hex `uiToken` (printed cleanly in the startup `?token=...` URL). Rejects `Sec-Fetch-Site: cross-site`, `Origin: null`, and untrusted origins, enforces `Content-Type: application/json` on `POST`, and separates UI tokens from the Hook token (`.runtime/server.json` never stores `uiToken`);
   - **Strict Browser-Level CSP**: serves `Content-Security-Policy: default-src 'self'; connect-src 'self'` across dashboard assets and APIs (with zero inline styles or scripts), physically locking down outbound network requests from the WebView.

---

## Scope & Limitations

This is a lightweight Sidecar status monitor rather than a packet-level inspector, with a few practical boundaries:

* **Fresh short probes passing doesn't guarantee an old stream is alive**: Probes open new short-lived HTTPS connections to check DNS/TLS/HTTP reachability (`2xx/3xx` and `400/404/405/410` count as reachable since `daily-cloudcode-pa.googleapis.com` returns `404` on `/`; `401/403/407/408/429/451` and `5xx` count as blocked or failed). If an already-open streaming connection goes half-dead upstream while a brand-new probe succeeds or fails over, the panel will lean toward **Possible Model Stall** rather than offline hang.
* **What proxy & TUN detection covers**: Automatically reads **HTTP proxies** (including `Basic` auth) and **unauthenticated SOCKS5 proxies** from environment variables (`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` / `NO_PROXY`), Windows registry `HKCU`/`HKLM` (with `ProxyOverride` and `DefaultConnectionSettings`), macOS `scutil` (with `ExceptionsList`), and Linux GNOME `gsettings` (with `ignore-hosts`), plus a **Manual Proxy** box in Settings when you need an override (for PAC, non-GNOME Linux, standalone SOCKS5, etc.). **It does not evaluate PAC scripts (warns instead), `https://` or `socks4://` proxies, password-authenticated SOCKS5, enterprise NTLM auth, or process-injected transparent proxies; corporate MITM root certs not trusted by Node can also report TLS failures.** TUN interfaces are heuristically tagged using `198.18.0.0/15` (Fake-IP) and `100.64.0.0/10` (CGNAT / Tailscale / WireGuard).
* **Small runtime footprint**: Antigravity spawns a short-lived Node/agy-node hook process on `PreInvocation` and `Stop`, while the Sidecar stays resident alongside the host.
* **Authenticated local API routes**: All `GET /api/*` (`/api/status`, `/api/events`) and `POST /api/*` routes require `X-Sidecar-Token` (or `?token=` for `EventSource`) by default alongside loopback `Host`, `Sec-Fetch-Site`, and `Origin` checks. Unauthenticated or cross-site local probes are rejected with `401`/`403`.
* **Token math**: `total` simply adds raw `input_tokens + cache_read_tokens + output_tokens` occurrences across turns. Treat it as a rough sense of session workload and cache hit ratio rather than exact billing or quota usage. Live session stats follow the Hook-reported path; all-time stats scan `transcript.jsonl` (falling back to `transcript_full.jsonl`).
* **Local alert log & notification suppression**: The Sidecar keeps only a bounded JSONL summary of alert/recovery transitions in `.runtime/alerts.log` (default `64 KB` / latest `120` lines) with zero external telemetry. Setting `ANTIGRAVITY_APP_DATA_DIR` strictly scopes `brain/` discovery, and automated/headless runs can set `ASM_DISABLE_NOTIFICATIONS=1` to suppress OS toast popups.

---

## Cross-Platform Support Matrix

| Platform | HTTPS Probes | System Proxy Detection | Language Server & 443 Sockets | Desktop Notifications | Verification Level |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Windows** | Supported | Env vars + Registry `HKCU`/`HKLM` (`HTTP` / `SOCKS5` / `ProxyOverride`; PAC warning + manual proxy fallback) | `netstat -ano -p TCP` + `tasklist` + CIM | PowerShell WinRT Toast notifications | **Long-run live desktop verified** + CI integration tests |
| **macOS** | Supported | Env vars + `scutil --proxy` (`HTTP` / `SOCKS5`; PAC warning + manual proxy fallback) | `lsof -nP -iTCP` + `pgrep`/`ps` | `osascript` notifications | Unit tests + GitHub Actions macOS CI |
| **Linux** | Supported | Env vars (`ALL_PROXY`/`NO_PROXY`) + GNOME `gsettings` (or env/manual proxy on non-GNOME) | `ss -tnap` (fallback `lsof`) + `pgrep`/`ps` | `notify-send` | Unit tests + GitHub Actions Ubuntu CI |

---

## Quick Install & Uninstall

### Option 1: Ask Antigravity to Download & Install Automatically (Recommended, No Git / CLI Needed)

Not familiar with Git or terminal commands? Open a new Antigravity chat, paste the prompt below, and Antigravity will download, verify, extract, and install the plugin for you while preserving any existing `.runtime/config.json`:

```text
Please download and install (or update) the Antigravity Status Monitor plugin for me:
1. Download the package matching my OS from https://github.com/rimenine/antigravity-status-monitor/releases/latest (agent-status-monitor.zip on Windows, agent-status-monitor.tar.gz on macOS / Linux), verify its checksum against SHA256SUMS.txt if present, or fall back to downloading the main branch source archive if no prebuilt Release is available.
2. Extract it to a temporary directory and run install.ps1 (Windows) or install.sh (macOS / Linux), keeping my existing .runtime/config.json intact.
3. Clean up the temporary files afterward and verify the plugin files and side pane entrypoint are ready.
```

> Works for upgrades too: send the same prompt again and Antigravity will stop the old Sidecar cleanly, update runtime files, and preserve your threshold and notification settings.

### Option 2: GitHub Releases Archive or One-Line Command

Download a prebuilt `.zip` or `.tar.gz` bundle (with `SHA256SUMS.txt`) from [Releases](https://github.com/rimenine/antigravity-status-monitor/releases/latest) — extract `agent-status-monitor/` directly into `~/.gemini/config/plugins/`, run the included `install.ps1` / `install.sh`, or install in one command:

```powershell
# Windows (PowerShell one-liner)
$tmp = Join-Path $env:TEMP "asm-install"; Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Force $tmp | Out-Null
Invoke-WebRequest "https://github.com/rimenine/antigravity-status-monitor/releases/latest/download/agent-status-monitor.zip" -OutFile "$tmp\asm.zip"
Expand-Archive "$tmp\asm.zip" -DestinationPath $tmp -Force
powershell -ExecutionPolicy Bypass -File "$tmp\agent-status-monitor\install.ps1"
```

```bash
# macOS / Linux (one-liner)
TMP_DIR="$(mktemp -d)" && curl -fsSL "https://github.com/rimenine/antigravity-status-monitor/releases/latest/download/agent-status-monitor.tar.gz" | tar -xz -C "$TMP_DIR" && sh "$TMP_DIR/agent-status-monitor/install.sh" && rm -rf "$TMP_DIR"
```

### Option 3: Git Clone Installer & Uninstall

```powershell
# Windows (PowerShell)
git clone https://github.com/rimenine/antigravity-status-monitor.git
cd antigravity-status-monitor
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

```bash
# macOS / Linux
git clone https://github.com/rimenine/antigravity-status-monitor.git
cd antigravity-status-monitor
sh ./install.sh
```

You can also clone directly into `~/.gemini/config/plugins/agent-status-monitor`. The `install.ps1` / `install.sh` script auto-detects `~/.gemini/config` and `agy-node` / `node`, copies only the files needed at runtime (skipping `tests/`, `docs/`, `.github/`, `.git/`, `scripts/`, and `README.en.md`), and keeps any existing `.runtime/config.json` intact.

Uninstall (the uninstaller removes `sidecar.json` and stops the running Sidecar cleanly; if Antigravity is currently open, disabling the plugin or closing the IDE first avoids host auto-restart attempts during cleanup; you can also ask Antigravity to run `uninstall.ps1` / `uninstall.sh` inside the plugin directory):

```powershell
# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1              # Full removal
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -KeepConfig  # Remove plugin, keep config.json
```

```bash
# macOS / Linux
sh ./uninstall.sh                # Full removal
sh ./uninstall.sh --keep-config  # Remove plugin, keep config.json
```

After installation, open or restart Antigravity (or toggle the plugin off and back on after upgrading), and ask in chat to **`Open the Antigravity Status Monitor panel`** (or **`打开反重力状态监控面板`**) to bring up the side pane.

---

## Controls & Configuration

- **Top bar actions**: `Probe` (run immediate connectivity test), `Test Alert` (15-second simulated hang alert preview), and **Settings gear icon**.
- **Configurable options**: Probe interval (`2s` / `3s` / `5s`), stall threshold (`15s` / `25s` / `45s`), probe target, manual proxy override, theme (`Follow Host / System`, `Dark Obsidian`, `Light Minimal`), and desktop hang notification toggle.

---

## Project Structure

```text
antigravity-status-monitor/
├── package.json                    # Package metadata and test runner (npm test)
├── plugin.json                     # Antigravity plugin manifest
├── .github/workflows/
│   ├── ci.yml                      # GitHub Actions matrix CI (Ubuntu / macOS / Windows)
│   └── release.yml                 # Tag / manual GitHub Release packager workflow
├── scripts/
│   └── package-release.mjs         # Zero-dependency .zip / .tar.gz & SHA256SUMS bundler
├── hooks.json                      # Lifecycle Hooks (PreInvocation + Stop)
├── install.ps1 / uninstall.ps1     # Windows auto-detect installer / uninstaller
├── install.sh / uninstall.sh       # macOS / Linux auto-detect installer / uninstaller
├── LICENSE                         # MIT License
├── README.md                       # Simplified Chinese README
├── README.en.md                    # English README
├── assets/logo.svg                 # Plugin icon
├── docs/screenshots/               # README preview screenshots (CN & EN)
├── hooks/hook-reporter.mjs         # Hook reporter script (X-Hook-Token auth)
├── skills/status-monitor/SKILL.md  # Side-pane launch & diagnostics skill
├── tests/                          # Unit and real-process integration tests (node:test)
└── sidecars/status-monitor/
    ├── sidecar.json                # Sidecar registration manifest
    ├── server.mjs                  # Sidecar entrypoint, HTTP routing & lifecycle wiring
    ├── lib/
    │   ├── config.mjs              # Runtime paths, brain isolation & config persistence
    │   ├── alert-logger.mjs        # Bounded JSONL alert & recovery persistence log
    │   ├── runtime-paths.mjs       # Multi-window .runtime/servers & hooks scope helpers
    │   ├── http-helpers.mjs        # Security headers, static asset whitelist & JSON I/O
    │   ├── sse-hub.mjs             # SSE broadcast hub & pinned conversation tracking
    │   ├── server-registry.mjs     # Multi-instance registration & exit cleanup
    │   ├── probe-coordinator.mjs   # Probe scheduler, LS inspection, alert dedup & logging
    │   ├── i18n.mjs                # Chinese/English localization strings, alerts & verdicts
    │   ├── security.mjs            # CSRF, Origin, Content-Type & dual-token verification
    │   ├── sdk-bridge.mjs          # sidecar_sdk bridge (/preload.js & AgentAPI)
    │   ├── transcript-reader.mjs   # Transcript tail-chunk reader & phase inference
    │   ├── fallback-hooks.mjs      # Scoped offline fallback hook loader & cleanup
    │   ├── timeline-store.mjs      # Physically bucketed per-chat live event store
    │   ├── state-store.mjs         # Strict current-chat state & snapshot builder
    │   ├── verdict.mjs             # Pure state diagnosis engine
    │   ├── proxy.mjs               # Proxy config parsing, Bypass/CIDR & OS proxy detection
    │   ├── process-probe.mjs       # Language Server PID, 443 socket & route inspection
    │   ├── notify.mjs              # Cross-platform desktop alerts (WinRT / AppleScript / libnotify)
    │   ├── probe.mjs               # Direct & proxied HTTPS upstream probe facade
    │   └── tokens.mjs              # Token usage parser and incremental cache
    └── public/
        ├── index.html
        ├── styles.css
        ├── app.js                  # Dashboard bootstrap & UI event bindings
        └── js/
            ├── i18n.js             # Frontend zh/en dictionaries & static i18n
            ├── format.js           # Duration/token formatters & adaptive theme resolver
            ├── render.js           # Sparkline SVG, timeline & telemetry card renderers
            └── client.js           # Auth transport, adaptive polling & error banner
```

---

## Running Automated Tests

Zero external dependencies — run with system Node or Antigravity's bundled `agy-node`:

```bash
npm test
# Or using Antigravity's built-in runtime:
agy-node --test tests/*.test.mjs
```

---

## License

[MIT](LICENSE) © 2026 [rimenine](https://github.com/rimenine)
