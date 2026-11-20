---
name: status-monitor
description: Open and explain the Antigravity Status Monitor side-pane panel to distinguish genuine agent progress from a silent "Working" hang.
---

# Antigravity Status Monitor

Use this skill when the user asks to inspect real-time agent execution status, diagnose a frozen/hung "Working" spinner ("一直显示工作中但没回复"), or open the Status Monitor panel (e.g. "Open the Antigravity Status Monitor panel" / "打开反重力状态监控面板"):

1. Following the `ui-plugin-navigation` pattern, if the plugin is enabled and running, provide a clickable capsule link to open the sidecar pane (the leading path segment must match the actual directory name under `~/.gemini/config/plugins/`, which you can verify from the parent directory of this `SKILL.md`):
   - Standard install directory (`agent-status-monitor`, recommended): `[Status Monitor](sidecar://agent-status-monitor/status-monitor/)`
   - Direct clone without renaming (`antigravity-status-monitor`): `[Status Monitor](sidecar://antigravity-status-monitor/status-monitor/)`
2. To explain or diagnose the live state, have the user open the panel above (Antigravity injects the session token automatically), or inspect local runtime files under `~/.gemini/config/plugins/agent-status-monitor/.runtime/` (`hooks/`, `hook-state.json`, `config.json`, `server.json`, `servers/`, `alerts.log`; note `GET /api/status` enforces `X-Sidecar-Token` / `?token=` authentication by default).
3. Key verdict codes surfaced in the panel: `WAITING_LLM` (waiting for model output), `RUNNING_TOOL` (local tool or incomplete parallel tool batch), `BACKGROUND_TASK` (turn ended with `fullyIdle: false` while a background task or subagent is still running and will auto-resume), `API_RETRY` (transcript `ERROR_MESSAGE` retry such as `wsasend` upload reset or upstream EOF/timeout), `SUSPECT_STALL` (timeout/jitter re-check, `SYN_SENT` stall, or model silence past threshold), and `DISCONNECTED_HANG` (confirmed upstream network loss or `Language Server` unreachable).
