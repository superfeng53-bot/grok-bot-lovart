#!/usr/bin/env bash
# Keep sand-cookie-persist / sand-session-sync from reinjecting shared cookies across Chrome profiles.
set -u
LOG=/tmp/kill-sand-cookie-persist.log
SEED_PATHS=(
  /home/box/sand-data/chrome-cookie-seed.json
  /home/box/agent-data/chrome-cookie-seed.json
)
ensure_blocked_dir() {
  local p="$1"
  if [ -f "$p" ]; then
    mv -f "$p" "${p}.bak-auto-$(date +%Y%m%d%H%M%S)" 2>/dev/null || rm -f "$p"
  fi
  if [ ! -e "$p" ]; then
    mkdir -p "$p" 2>/dev/null || true
  fi
  if [ -d "$p" ]; then
    chmod 555 "$p" 2>/dev/null || true
  fi
}
echo "$(date '+%F %T') watchdog start pid=$$" >>"$LOG"
while true; do
  if pgrep -f 'sand-cookie-persist\.mjs' >/dev/null 2>&1; then
    pkill -f 'sand-cookie-persist\.mjs' 2>/dev/null || true
    echo "$(date '+%F %T') killed sand-cookie-persist" >>"$LOG"
  fi
  if pgrep -f 'sand-session-sync\.mjs' >/dev/null 2>&1; then
    pkill -f 'sand-session-sync\.mjs' 2>/dev/null || true
    echo "$(date '+%F %T') killed sand-session-sync" >>"$LOG"
  fi
  if pgrep -f 'sand-cookie-import\.mjs' >/dev/null 2>&1; then
    pkill -f 'sand-cookie-import\.mjs' 2>/dev/null || true
    echo "$(date '+%F %T') killed sand-cookie-import" >>"$LOG"
  fi
  for p in "${SEED_PATHS[@]}"; do
    ensure_blocked_dir "$p"
  done
  # neutralize known bak seed files (readable cookie jars)
  for f in /home/box/sand-data/chrome-cookie-seed.json.bak* /home/box/agent-data/chrome-cookie-seed.json.bak*; do
    [ -f "$f" ] || continue
    mv -f "$f" "${f}.disabled-$(date +%Y%m%d%H%M%S)" 2>/dev/null || chmod 000 "$f" 2>/dev/null || true
  done
  sleep 2
done
