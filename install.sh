#!/usr/bin/env sh
set -eu

PLUGIN_ID="agent-status-monitor"
PLUGINS_ROOT="${HOME}/.gemini/config/plugins"

for arg in "$@"; do
  case "${arg}" in
    -h|--help)
      echo "Usage: sh ./install.sh [PLUGINS_ROOT]"
      exit 0
      ;;
    -*)
      echo "[ERR] Unknown option: ${arg}" >&2
      exit 2
      ;;
    *)
      PLUGINS_ROOT="${arg}"
      ;;
  esac
done

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
DEST_DIR="${PLUGINS_ROOT}/${PLUGIN_ID}"

is_verified_sidecar_process() {
  CAND_PID="$1"
  CAND_PORT="${2:-}"
  PROC_CMD="$(ps -p "${CAND_PID}" -o args= 2>/dev/null || true)"
  case "${PROC_CMD}" in
    *status-monitor*server.mjs*)
      return 0
      ;;
    *server.mjs*)
      if [ -e "/proc/${CAND_PID}/cwd" ]; then
        PROC_CWD="$(readlink "/proc/${CAND_PID}/cwd" 2>/dev/null || true)"
        case "${PROC_CWD}" in
          *status-monitor*) return 0 ;;
        esac
      fi
      if command -v lsof >/dev/null 2>&1; then
        CWD_OUT="$(lsof -a -p "${CAND_PID}" -d cwd -Fn 2>/dev/null || true)"
        case "${CWD_OUT}" in
          *status-monitor*) return 0 ;;
        esac
        if [ -n "${CAND_PORT}" ] && lsof -nP -iTCP:"${CAND_PORT}" -sTCP:LISTEN -p "${CAND_PID}" >/dev/null 2>&1; then
          return 0
        fi
      fi
      if [ -n "${CAND_PORT}" ] && command -v ss >/dev/null 2>&1; then
        SS_OUT="$(ss -ltnp "sport = :${CAND_PORT}" 2>/dev/null || true)"
        case "${SS_OUT}" in
          *"pid=${CAND_PID},"*) return 0 ;;
        esac
      fi
      ;;
  esac
  return 1
}

stop_verified_sidecar() {
  SRV_FILE="$1"
  if [ ! -f "${SRV_FILE}" ]; then
    return 0
  fi
  SIDECAR_PID="$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "${SRV_FILE}" | head -n 1 || true)"
  SIDECAR_PORT="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "${SRV_FILE}" | head -n 1 || true)"
  if [ -z "${SIDECAR_PID}" ] || ! kill -0 "${SIDECAR_PID}" 2>/dev/null; then
    return 0
  fi
  if is_verified_sidecar_process "${SIDECAR_PID}" "${SIDECAR_PORT}"; then
    echo "[INFO] Stopping running Sidecar process (PID ${SIDECAR_PID})..."
    kill "${SIDECAR_PID}" 2>/dev/null || true
    WAIT_N=0
    while kill -0 "${SIDECAR_PID}" 2>/dev/null && [ "${WAIT_N}" -lt 15 ]; do
      if sleep 0.2 2>/dev/null; then
        WAIT_N=$((WAIT_N + 1))
      else
        sleep 1
        WAIT_N=$((WAIT_N + 5))
      fi
    done
    if kill -0 "${SIDECAR_PID}" 2>/dev/null; then
      kill -9 "${SIDECAR_PID}" 2>/dev/null || true
      sleep 0.2 2>/dev/null || true
    fi
  fi
}

stop_all_verified_sidecars() {
  RT_DIR="$1"
  stop_verified_sidecar "${RT_DIR}/server.json"
  if [ -d "${RT_DIR}/servers" ]; then
    for INST_FILE in "${RT_DIR}/servers/"*.json; do
      [ -f "${INST_FILE}" ] || continue
      stop_verified_sidecar "${INST_FILE}"
    done
  fi
}

echo "=== Antigravity Status Monitor Installer ==="

mkdir -p "${PLUGINS_ROOT}"
echo "[OK] Target plugins directory: ${PLUGINS_ROOT}"

NODE_BIN=""
if command -v agy-node >/dev/null 2>&1; then
  NODE_BIN="$(command -v agy-node)"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
fi

if [ -n "${NODE_BIN}" ]; then
  echo "[OK] Detected runtime: ${NODE_BIN} ($(${NODE_BIN} -v 2>/dev/null || true))"
else
  echo "[WARN] Neither agy-node nor node found on PATH."
fi

if [ "${SCRIPT_DIR}" = "${DEST_DIR}" ]; then
  echo "[INFO] Source is already at ${DEST_DIR}; skipping copy."
else
  stop_all_verified_sidecars "${DEST_DIR}/.runtime"
  if [ -f "${DEST_DIR}/.runtime/config.json" ]; then
    echo "[OK] Existing .runtime configuration will be preserved."
  fi
  mkdir -p "${DEST_DIR}"
  for file in plugin.json hooks.json package.json README.md LICENSE uninstall.sh; do
    if [ -f "${SCRIPT_DIR}/${file}" ]; then
      cp -f "${SCRIPT_DIR}/${file}" "${DEST_DIR}/${file}"
    fi
  done
  if [ -f "${DEST_DIR}/uninstall.sh" ]; then
    chmod +x "${DEST_DIR}/uninstall.sh" || true
  fi
  for dir in assets hooks sidecars skills; do
    if [ -d "${SCRIPT_DIR}/${dir}" ]; then
      rm -rf "${DEST_DIR}/${dir}"
      cp -R "${SCRIPT_DIR}/${dir}" "${DEST_DIR}/${dir}"
    fi
  done
  echo "[OK] Installed plugin files to: ${DEST_DIR}"
fi

if [ -n "${NODE_BIN}" ]; then
  "${NODE_BIN}" --check "${DEST_DIR}/sidecars/status-monitor/server.mjs"
  "${NODE_BIN}" --check "${DEST_DIR}/hooks/hook-reporter.mjs"
  echo "[OK] Entrypoint syntax verification passed."
fi

echo ""
ALIAS_CLONE_DIR="${PLUGINS_ROOT}/antigravity-status-monitor"
if [ "${SCRIPT_DIR}" != "${DEST_DIR}" ] && [ "${SCRIPT_DIR}" = "${ALIAS_CLONE_DIR}" ]; then
  echo "[WARN] Detected source clone inside ${ALIAS_CLONE_DIR}; remove it to avoid duplicate plugin loading."
fi
echo "Installation complete! Open or restart Antigravity and open Antigravity Status Monitor."
