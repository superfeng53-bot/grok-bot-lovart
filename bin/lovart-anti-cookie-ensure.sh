#!/usr/bin/env bash
# One-shot: kill cookie sync injectors, block seed paths, ensure watchdog is running.
# MUST run after every box boot/restart, and BEFORE any Lovart Profile login.
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
    echo "DO NOT put cookie seed files here. Directory blocks sand-cookie-persist." >"$p/README-DO-NOT-SEED.txt" 2>/dev/null || true
  fi
  if [ -d "$p" ]; then
    chmod 555 "$p" 2>/dev/null || true
  fi
}
killed=()
for pat in 'sand-cookie-persist\.mjs' 'sand-session-sync\.mjs' 'sand-cookie-import\.mjs'; do
  if pgrep -f "$pat" >/dev/null 2>&1; then
    pkill -f "$pat" 2>/dev/null || true
    killed+=("$pat")
    echo "$(date '+%F %T') ensure killed $pat" >>"$LOG"
  fi
done
for p in "${SEED_PATHS[@]}"; do
  ensure_blocked_dir "$p"
done
# Restart watchdog if missing or still the old one-liner log-only process
if ! pgrep -f 'kill-sand-cookie-persist\.sh' >/dev/null 2>&1; then
  nohup setsid /home/box/bin/kill-sand-cookie-persist.sh >>/tmp/kill-sand-cookie-persist.nohup.out 2>&1 &
  echo "$(date '+%F %T') ensure started watchdog pid=$!" >>"$LOG"
  echo "watchdog:started"
else
  echo "watchdog:already-up pid=$(pgrep -f 'kill-sand-cookie-persist\.sh' | head -1)"
fi
if [ ${#killed[@]} -gt 0 ]; then
  echo "killed:${killed[*]}"
else
  echo "killed:none"
fi
# Final verify (only the injector .mjs — not our kill-sand-cookie-persist.sh)
sleep 1
left=$(pgrep -af 'sand-session-sync\.mjs|sand-cookie-persist\.mjs|sand-cookie-import\.mjs' || true)
if [ -n "$left" ]; then
  echo "FAIL still running: $left"
  exit 1
fi
echo "OK no sync/persist/import; seeds blocked"
