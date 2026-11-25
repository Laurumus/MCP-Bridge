#!/usr/bin/env bash
# Install and enable the OpenCode MCP bridge as a systemd service, and switch
# the manually-started bridge over to it. Must be run as root (via sudo).
# Fails fast on any error; never prints secrets; does not touch the SSH shell.
#
# Note: the unit is copied as-is. Edit its User, WorkingDirectory and PATH for
# this machine BEFORE running this script.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_DIR="$(dirname "$SCRIPT_DIR")"
UNIT_SRC="$SCRIPT_DIR/opencode-mcp-bridge.service"
UNIT_DST="/etc/systemd/system/opencode-mcp-bridge.service"
SERVICE="opencode-mcp-bridge.service"
PORT="${BRIDGE_PORT:-9999}"

log() { printf '%s\n' "$*"; }

# --- 0. guard: root required ------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run as root (sudo bash $0)" >&2
  exit 1
fi

# --- 1. install the unit and reload -----------------------------------------
if [ ! -f "$UNIT_SRC" ]; then
  echo "ERROR: unit source not found: $UNIT_SRC" >&2
  exit 1
fi
install -m 0644 "$UNIT_SRC" "$UNIT_DST"
log "installed $UNIT_DST"
systemctl daemon-reload

# --- 2. validate the unit ----------------------------------------------------
log "systemd-analyze verify:"
systemd-analyze verify "$SERVICE"

# --- 3. stop the manual bridge (strict match only) ---------------------------
# Discover a process whose command is exactly `node src/main.js`, owned by
# opencode, with cwd = the bridge directory. This avoids broad pkill and matches
# only the manual bridge, not other node processes.
find_manual_bridge() {
  local pid cmd owner cwd
  for pid in $(pgrep -x node 2>/dev/null || true); do
    [ -r "/proc/$pid/cmdline" ] || continue
    cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" | sed 's/ *$//')
    [ "$cmd" = "node src/main.js" ] || continue
    owner=$(stat -c '%U' "/proc/$pid" 2>/dev/null || true)
    [ "$owner" = "opencode" ] || continue
    cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
    [ "$cwd" = "$BRIDGE_DIR" ] || continue
    printf '%s' "$pid"
    return 0
  done
  return 1
}

if pid=$(find_manual_bridge); then
  log "manual bridge found: PID $pid (owner=opencode, cwd=$BRIDGE_DIR, cmd='node src/main.js')"
  log "sending SIGTERM to $pid"
  kill -TERM "$pid"
  stopped=0
  for _ in $(seq 1 30); do
    if ! kill -0 "$pid" 2>/dev/null && ! ss -ltn | grep -qE ":${PORT}[[:space:]]"; then
      log "manual bridge stopped and port $PORT is free"
      stopped=1
      break
    fi
    sleep 1
  done
  if [ "$stopped" -ne 1 ]; then
    echo "ABORT: manual bridge PID $pid did not stop in time — not starting a second instance" >&2
    exit 1
  fi
else
  log "no manual bridge process matched (already stopped?)"
fi

# --- 4. guard: port must be free before starting -----------------------------
if ss -ltn | grep -qE ":${PORT}[[:space:]]"; then
  echo "ABORT: port $PORT is still occupied — refusing to start a second instance" >&2
  exit 1
fi

# --- 5. enable and start the bridge service ---------------------------------
systemctl enable "$SERVICE"
systemctl start "$SERVICE"
log "enabled and started $SERVICE"

# --- 6. summary --------------------------------------------------------------
log ""
log "=== status ==="
systemctl is-enabled "$SERVICE"
systemctl is-active "$SERVICE"
systemctl status "$SERVICE" --no-pager -l -n 12 || true
