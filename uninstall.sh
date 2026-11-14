#!/usr/bin/env sh
set -eu

KEEP_CONFIG=0
PLUGINS_ROOT="${HOME}/.gemini/config/plugins"

for arg in "$@"; do
  case "${arg}" in
    -h|--help)
      echo "Usage: sh ./uninstall.sh [--keep-config] [PLUGINS_ROOT]"
      exit 0
      ;;
    --keep-config) KEEP_CONFIG=1 ;;
    -*)
      echo "[ERR] Unknown option: ${arg}" >&2
      exit 2
      ;;
    *) PLUGINS_ROOT="${arg}" ;;
  esac
done

CANDIDATE_IDS="agent-status-monitor antigravity-status-monitor"
FOUND_ANY=0
for cid in ${CANDIDATE_IDS}; do
  if [ -d "${PLUGINS_ROOT}/${cid}" ]; then
    FOUND_ANY=1
    break
  fi
done

if [ "${FOUND_ANY}" -eq 0 ]; then
  echo "[INFO] Plugin is not installed at ${PLUGINS_ROOT}/agent-status-monitor."
  exit 0
fi

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

uninstall_plugin_dir() {
  TARGET_ID="$1"
  TARGET_DIR="${PLUGINS_ROOT}/${TARGET_ID}"
  if [ ! -d "${TARGET_DIR}" ]; then
    return 0
  fi

  case "$(pwd)/" in
    "${TARGET_DIR}/"*) cd "${PLUGINS_ROOT}" ;;
  esac

  rm -f "${TARGET_DIR}/sidecars/status-monitor/sidecar.json" 2>/dev/null || true
  stop_verified_sidecar "${TARGET_DIR}/.runtime/server.json"

  BACKUP_CFG=""
  CFG_FILE="${TARGET_DIR}/.runtime/config.json"
  if [ "${KEEP_CONFIG}" -eq 1 ] && [ -f "${CFG_FILE}" ]; then
    BACKUP_CFG="$(cat "${CFG_FILE}")"
  fi

  rm -rf "${TARGET_DIR}"

  if [ "${KEEP_CONFIG}" -eq 1 ] && [ -n "${BACKUP_CFG}" ]; then
    mkdir -p "${TARGET_DIR}/.runtime"
    printf '%s\n' "${BACKUP_CFG}" > "${TARGET_DIR}/.runtime/config.json"
    echo "[OK] Plugin removed; preserved user config at ${TARGET_DIR}/.runtime/config.json"
  else
    echo "[OK] Uninstalled ${TARGET_ID} from ${TARGET_DIR}"
  fi
}

for cid in ${CANDIDATE_IDS}; do
  uninstall_plugin_dir "${cid}"
done
