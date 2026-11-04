#!/bin/bash
# Lovart 每日积分检查入口（程序化，不经模型）。日期一律自动取 Asia/Shanghai。
#   run.sh first     第一轮：查全部在用号（9:00）
#   run.sh recheck   重查：只查 pending_today.profiles（10:00/11:00）；当天全部有结论则直接退出
# 其余参数原样传给 lovart_auto.py，例如：run.sh first --dry-run --profiles 4,5
#
# 注意：本脚本内部已 flock /tmp/lovart-auto.lock。禁止再包一层 flock（会死锁）。
# crontab 须用 timeout 包本脚本，防止单轮挂死让 supercronic 跨天跳过同名任务。
set -u

# 防 Cookie：扫号前确保无 persist/session-sync（不用 LLM）
/home/box/bin/lovart-anti-cookie-ensure.sh || exit 1
MODE="${1:-}"
case "$MODE" in first|recheck) shift ;; *) echo "usage: $0 first|recheck [--dry-run --out-dir D --profiles 4,5]" >&2; exit 64 ;; esac

export TZ=Asia/Shanghai LANG=C.UTF-8 HOME=/home/box
export PATH=/home/box/.local/bin:/usr/local/bin:/usr/bin:/bin
AUTO=/workspace/lovart-auto
TODAY=$(TZ=Asia/Shanghai date +%F)
mkdir -p "$AUTO/logs"
RUNLOG="$AUTO/logs/run-$TODAY.log"
DRY=0; for x in "$@"; do [[ "$x" == "--dry-run" ]] && DRY=1; done

# 独立的虚拟屏幕给 Fork-2 Chrome 用（不依赖任何 agent 的桌面）。可用 LOVART_DISPLAY 覆盖。
DISP="${LOVART_DISPLAY:-:99}"
if [[ ! -S "/tmp/.X11-unix/X${DISP#:}" ]]; then
  nohup Xvfb "$DISP" -screen 0 1280x800x24 -ac +extension GLX +render -noreset >/tmp/xvfb-lovart.log 2>&1 &
  sleep 2
fi
export DISPLAY="$DISP"

# flock 等待秒数：定时默认 15 分钟（2026-11-03 前是 50 分钟，过长会拖死后续轮次）
LOCK_WAIT="${LOVART_AUTO_LOCK_WAIT:-900}"

{
  echo "===== $(date '+%F %T %z') run.sh $MODE $* (DISPLAY=$DISPLAY, pid $$) ====="
  # 同一时间只允许一个检查在动 Chrome
  exec 9>/tmp/lovart-auto.lock
  if ! flock -w "$LOCK_WAIT" 9; then
    echo "lock busy >${LOCK_WAIT}s, give up"
    if [[ $DRY == 0 ]]; then
      python3 - "$AUTO/summary-$TODAY.json" "$MODE" <<'PY'
import json,sys,os,time
p,mode=sys.argv[1:3]
d=json.load(open(p)) if os.path.exists(p) else {"date":time.strftime("%F")}
d.setdefault("errors",[]).append(f"{mode} 轮：上一轮检查占用超过锁等待时限，本轮放弃")
d["status"]="error"; d["message_zh"]=d.get("message_zh","")+"（另外：本轮检查因上一轮卡住没跑成，需要人工看一下。）"
json.dump(d,open(p,"w"),ensure_ascii=False,indent=2)
PY
    fi
    exit 3
  fi
  echo $$ > /tmp/lovart-auto.lock.pid
  echo "$(date '+%F %T %z') $MODE" > /tmp/lovart-auto.lock.holder
  python3 "$AUTO/lovart_auto.py" "$MODE" "$@"
  rc=$?
  rm -f /tmp/lovart-auto.lock.pid /tmp/lovart-auto.lock.holder
  echo "===== $(date '+%F %T %z') exit $rc ====="
  exit $rc
} >>"$RUNLOG" 2>&1
