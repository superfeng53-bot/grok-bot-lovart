#!/bin/bash
# Lovart 画布专用：开 Fork-2 Profile N（带 session DBus + GTK_USE_PORTAL=0）
# 原因：裸 switch-profile 开的 Chrome 点音频「Open」后易整窗退出；文件框依赖 session bus。
# Usage: lovart-canvas-chrome.sh <N>
set -euo pipefail
N="${1:?profile number}"
UD=/home/box/chrome-profile/Fork-2
export DISPLAY="${DISPLAY:-:4}"
export GTK_USE_PORTAL=0

/home/box/bin/lovart-anti-cookie-ensure.sh >/dev/null || true

# kill existing Fork-2 chrome
for pid in $(pgrep -f "user-data-dir=$UD" || true); do
  cmd=$(ps -p "$pid" -o args= 2>/dev/null || true)
  if [[ "$cmd" == *chrome* ]] && [[ "$cmd" != *bash* ]]; then
    kill "$pid" 2>/dev/null || true
  fi
done
sleep 2
pkill -9 -f "user-data-dir=$UD" 2>/dev/null || true
sleep 1
rm -f "$UD/SingletonLock" "$UD/SingletonSocket" "$UD/SingletonCookie"

# session dbus for native file dialogs
if [[ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]] || [[ ! -S "${DBUS_SESSION_BUS_ADDRESS#unix:path=}" ]]; then
  eval "$(dbus-launch --sh-syntax)"
  export DBUS_SESSION_BUS_ADDRESS
fi
echo "DBUS=$DBUS_SESSION_BUS_ADDRESS DISPLAY=$DISPLAY GTK_USE_PORTAL=$GTK_USE_PORTAL"

nohup google-chrome --user-data-dir="$UD" --profile-directory="Profile $N" \
  --disable-quic --no-proxy-server --remote-debugging-port=9224 \
  --window-position=0,0 --window-size=1280,800 \
  --class=box-chrome --password-store=basic --no-first-run --no-default-browser-check \
  --hide-crash-restore-bubble \
  https://www.lovart.ai/zh/home >/tmp/chrome-lovart-canvas.log 2>&1 &
echo "launched profile $N pid $!"

for i in $(seq 1 20); do
  if curl -s --max-time 1 http://127.0.0.1:9224/json/version >/dev/null 2>&1; then
    echo CDP_OK
    break
  fi
  sleep 1
done

ok=0
for i in $(seq 1 20); do
  if pgrep -af "user-data-dir=$UD" | grep -F -- "--profile-directory=Profile $N" >/dev/null 2>&1; then
    ok=1; break
  fi
  sleep 0.5
done
if [[ $ok -ne 1 ]]; then
  echo "PROFILE_MISMATCH: expected Profile $N" >&2
  exit 2
fi
echo "PROFILE_OK Profile $N (canvas-safe)"
