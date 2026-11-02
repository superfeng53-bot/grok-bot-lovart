#!/usr/bin/env bash
# One Lovart account = one Chrome user-data-dir + one CDP port + one jev-browse.
# Parallel-safe: no shared SingletonLock across accounts.
#
# Layout:
#   /home/box/chrome-profile/lovart-p<N>/Default  ← seeded from Fork-2/Profile N
#   CDP port = 9200 + N   (Profile 1 → 9201, Profile 24 → 9224)
#
# Usage:
#   jev-profile.sh migrate <N> [N2 ...]   # copy Fork-2 Profile → lovart-pN (Chrome for that src must be stopped)
#   jev-profile.sh start <N>
#   jev-profile.sh stop <N>
#   jev-profile.sh run <N> --url U --goal G [...]
#   jev-profile.sh status
set -euo pipefail
export PATH=/home/box/.local/node22/bin:${PATH:-}
export DISPLAY="${DISPLAY:-:4}"
export GTK_USE_PORTAL="${GTK_USE_PORTAL:-0}"

FORK2=/home/box/chrome-profile/Fork-2
ROOT=/home/box/chrome-profile
ENV_FILE=/workspace/jev-browse/.env
CLI=/workspace/jev-browse/bundled/cli.mjs

ud_for() { echo "$ROOT/lovart-p$1"; }
port_for() { echo $((9200 + $1)); }

ACTION="${1:?migrate|start|stop|run|status}"
shift || true

ensure_anti() {
  if [[ -x /home/box/bin/lovart-anti-cookie-ensure.sh ]]; then
    /home/box/bin/lovart-anti-cookie-ensure.sh >/dev/null || true
  fi
}

kill_ud() {
  local ud="$1"
  for pid in $(pgrep -f "user-data-dir=${ud}" || true); do
    cmd=$(ps -p "$pid" -o args= 2>/dev/null || true)
    if [[ "$cmd" == *chrome* ]] && [[ "$cmd" != *bash* ]]; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  sleep 2
  pkill -9 -f "user-data-dir=${ud}" 2>/dev/null || true
  sleep 1
  rm -f "$ud/SingletonLock" "$ud/SingletonSocket" "$ud/SingletonCookie" 2>/dev/null || true
}

migrate_one() {
  local n="$1"
  local src="$FORK2/Profile $n"
  local ud; ud=$(ud_for "$n")
  if [[ ! -d "$src" ]]; then
    echo "MISSING_SRC Profile $n at $src" >&2
    return 1
  fi
  # Refuse if Fork-2 currently has this profile open (copy would be dirty / lock fight)
  if pgrep -af "user-data-dir=$FORK2" 2>/dev/null | grep -F -- "--profile-directory=Profile $n" >/dev/null; then
    echo "BUSY_FORK2 Profile $n still running on Fork-2 — stop it first, then migrate" >&2
    return 2
  fi
  mkdir -p "$ud"
  if [[ -d "$ud/Default" ]]; then
    echo "ALREADY $ud/Default (skip copy; delete it to re-seed)"
    return 0
  fi
  echo "COPY $src -> $ud/Default"
  cp -a "$src" "$ud/Default"
  echo "MIGRATED Profile $n -> $ud (port $(port_for "$n"))"
}

start_one() {
  local n="$1"
  local ud port
  ud=$(ud_for "$n")
  port=$(port_for "$n")
  ensure_anti
  if [[ ! -d "$ud/Default" ]]; then
    echo "NOT_MIGRATED Profile $n — run: $0 migrate $n" >&2
    return 1
  fi
  if curl -s --max-time 1 "http://127.0.0.1:${port}/json/version" >/dev/null 2>&1; then
    if pgrep -af "user-data-dir=${ud}" | grep -q "remote-debugging-port=${port}"; then
      echo "CDP_OK reuse lovart-p${n} port ${port}"
      return 0
    fi
    echo "PORT_BUSY ${port}" >&2
    return 1
  fi
  kill_ud "$ud"
  nohup env DISPLAY="$DISPLAY" GTK_USE_PORTAL=0 ${DBUS_SESSION_BUS_ADDRESS:+DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS} \
    google-chrome --user-data-dir="$ud" --profile-directory=Default \
    --disable-quic --no-proxy-server --remote-debugging-port="$port" \
    --window-position=$(( (n % 4) * 40 )),$(( (n % 4) * 40 )) --window-size=1280,800 \
    --class="lovart-p${n}" --password-store=basic --no-first-run --no-default-browser-check \
    about:blank >"/tmp/chrome-lovart-p${n}.log" 2>&1 &
  echo "launched lovart-p${n} pid $! port ${port}"
  local i
  for i in $(seq 1 30); do
    if curl -s --max-time 1 "http://127.0.0.1:${port}/json/version" >/dev/null 2>&1; then
      if pgrep -af "user-data-dir=${ud}" | grep -q "remote-debugging-port=${port}"; then
        echo "CDP_OK lovart-p${n} port ${port}"
        return 0
      fi
    fi
    sleep 0.4
  done
  echo "CDP_FAIL lovart-p${n} port ${port}" >&2
  return 1
}

stop_one() {
  local n="$1"
  kill_ud "$(ud_for "$n")"
  echo "stopped lovart-p${n}"
}

status_all() {
  echo "=== lovart-p* CDP ==="
  local d n port
  for d in "$ROOT"/lovart-p*; do
    [[ -d "$d" ]] || continue
    n=${d##*lovart-p}
    port=$(port_for "$n")
    if curl -s --max-time 1 "http://127.0.0.1:${port}/json/version" >/dev/null 2>&1; then
      echo "UP   Profile $n  port $port  ud=$d"
    else
      echo "DOWN Profile $n  port $port  ud=$d"
    fi
  done
  echo "=== Fork-2 (legacy, not parallel) ==="
  pgrep -af "user-data-dir=$FORK2" | grep -F -- '--profile-directory=' | head -5 || echo "(none)"
}

case "$ACTION" in
  migrate)
    [[ $# -ge 1 ]] || { echo "migrate needs profile number(s)" >&2; exit 2; }
    for n in "$@"; do migrate_one "$n"; done
    ;;
  start)
    [[ $# -ge 1 ]] || { echo "start needs profile number(s)" >&2; exit 2; }
    for n in "$@"; do start_one "$n"; done
    ;;
  stop)
    [[ $# -ge 1 ]] || { echo "stop needs profile number(s)" >&2; exit 2; }
    for n in "$@"; do stop_one "$n"; done
    ;;
  run)
    N="${1:?profile}"; shift
    start_one "$N"
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
    exec env JEV_PROVIDER=openrouter node "$CLI" --headed --cdp "http://127.0.0.1:$(port_for "$N")" "$@"
    ;;
  status)
    status_all
    ;;
  *)
    echo "Usage: $0 migrate|start|stop|run|status ..." >&2
    exit 2
    ;;
esac
