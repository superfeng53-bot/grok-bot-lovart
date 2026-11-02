#!/bin/bash
# Switch Fork-2 Chrome to Profile N (lovart-auto copy: fixed 1280x800 window so it works on a bare Xvfb without WM). Usage: switch-profile.sh N
set -e
N="${1:?profile number}"
UD=/home/box/chrome-profile/Fork-2
# Kill only chrome processes for this user-data-dir (not this shell)
mapfile -t PIDS < <(pgrep -f "/opt/google/chrome/chrome" || true)
# Prefer killing via google-chrome parent with exact profile flag pattern via PID file approach
for pid in $(pgrep -f "remote-debugging-port=9224" || true); do
  # skip if not chrome
  cmd=$(ps -p "$pid" -o args= 2>/dev/null || true)
  if [[ "$cmd" == *"/usr/bin/google-chrome"* ]] || [[ "$cmd" == *"/opt/google/chrome/chrome --type=zygote"* ]] || [[ "$cmd" == *"google-chrome --user-data-dir=$UD"* ]]; then
    kill "$pid" 2>/dev/null || true
  fi
done
# Broader: kill chrome main for Fork-2
for pid in $(pgrep -f "user-data-dir=$UD" || true); do
  cmd=$(ps -p "$pid" -o args= 2>/dev/null || true)
  if [[ "$cmd" == *chrome* ]] && [[ "$cmd" != *bash* ]]; then
    kill "$pid" 2>/dev/null || true
  fi
done
sleep 3
# force leftover chrome children
pkill -9 -f "/opt/google/chrome/chrome.*user-data-dir=$UD" 2>/dev/null || true
sleep 2
# wait until no Fork-2 chrome remains
for i in 1 2 3 4 5 6 7 8 9 10; do
  if ! pgrep -f "user-data-dir=$UD" >/dev/null 2>&1; then break; fi
  pkill -9 -f "user-data-dir=$UD" 2>/dev/null || true
  sleep 1
done
rm -f "$UD/SingletonLock" "$UD/SingletonSocket" "$UD/SingletonCookie"
nohup google-chrome --user-data-dir="$UD" --profile-directory="Profile $N" \
  --disable-quic --no-proxy-server --remote-debugging-port=9224 \
  --window-position=0,0 --window-size=1280,800 \
  --class=box-chrome --password-store=basic --no-first-run --no-default-browser-check \
  https://www.lovart.ai/zh/home >/tmp/chrome-lovart.log 2>&1 &
echo "launched profile $N pid $!"
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -s --max-time 1 http://127.0.0.1:9224/json/version >/dev/null 2>&1; then
    echo CDP_OK

# Verify profile actually loaded (anti cross-login 2026-10-18)
sleep 1
ok=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  if pgrep -af "user-data-dir=$UD" | grep -F -- "--profile-directory=Profile $N" >/dev/null 2>&1; then
    ok=1; break
  fi
  sleep 0.5
done
if [[ $ok -ne 1 ]]; then
  echo "PROFILE_MISMATCH: expected Profile $N not in chrome cmdline" >&2
  exit 2
fi
echo "PROFILE_OK Profile $N"
    exit 0
  fi
  sleep 1
done
echo CDP_FAIL
exit 1
