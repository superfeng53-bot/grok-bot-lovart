#!/bin/bash
# 管理 Lovart 自动检查的定时器（supercronic，用户态，不需要 root/systemd）
#   scheduler.sh start|ensure   启动（已在跑则什么都不做）—— 重启 box 后执行一次即可恢复
#   scheduler.sh stop           停止
#   scheduler.sh status         查看状态
#   scheduler.sh restart        停干净后重开（清「仍在跑」僵尸状态时用）
set -u
AUTO=/workspace/lovart-auto
BIN=/home/box/.local/bin/supercronic
PIDF=/tmp/lovart-auto-scheduler.pid
LOG=$AUTO/logs/scheduler.log
export TZ=Asia/Shanghai LANG=C.UTF-8 HOME=/home/box PATH=/home/box/.local/bin:/usr/local/bin:/usr/bin:/bin

running() { [[ -f $PIDF ]] && kill -0 "$(cat $PIDF)" 2>/dev/null; }

kill_stale_runs() {
  # 杀掉超过 90 分钟的 run.sh / lovart_auto.py，避免锁与 supercronic「仍在跑」跨天
  local now stale
  now=$(date +%s)
  for pid in $(pgrep -f '/workspace/lovart-auto/run\.sh' || true); do
    stale=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')
    if [[ -n "${stale:-}" && "$stale" -gt 5400 ]]; then
      echo "[$(date '+%F %T %z')] kill stale run.sh pid=$pid etimes=${stale}s" >>"$LOG"
      kill -TERM "$pid" 2>/dev/null || true
      sleep 2
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
  for pid in $(pgrep -f '/workspace/lovart-auto/lovart_auto\.py' || true); do
    stale=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')
    if [[ -n "${stale:-}" && "$stale" -gt 5400 ]]; then
      echo "[$(date '+%F %T %z')] kill stale lovart_auto.py pid=$pid etimes=${stale}s" >>"$LOG"
      kill -TERM "$pid" 2>/dev/null || true
      sleep 2
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
}

stop_all() {
  kill_stale_runs
  if running; then
    local loop
    loop=$(cat "$PIDF")
    # 先杀 supercronic 子进程，再杀托管循环
    pkill -TERM -P "$loop" 2>/dev/null || true
    kill -TERM "$loop" 2>/dev/null || true
    sleep 2
    pkill -KILL -P "$loop" 2>/dev/null || true
    kill -KILL "$loop" 2>/dev/null || true
    rm -f "$PIDF"
  fi
  # 兜底：残留 supercronic
  pkill -f 'supercronic.*lovart-auto/crontab' 2>/dev/null || true
  rm -f /tmp/lovart-auto.lock.pid /tmp/lovart-auto.lock.holder
}

case "${1:-status}" in
  start|ensure)
    kill_stale_runs
    if running; then echo "already running (loop pid $(cat $PIDF))"; exit 0; fi
    mkdir -p "$AUTO/logs"
    # 自恢复循环：supercronic 退出/崩溃后 10 秒自动重启
    nohup setsid bash -c "
      echo \$\$ > $PIDF
      trap 'kill \$child 2>/dev/null; exit 0' TERM INT
      while true; do
        echo \"[\$(date '+%F %T %z')] start supercronic\"
        $BIN -passthrough-logs $AUTO/crontab & child=\$!
        wait \$child
        echo \"[\$(date '+%F %T %z')] supercronic exited \$?, restart in 10s\"
        sleep 10
      done" >>"$LOG" 2>&1 < /dev/null &
    sleep 1
    running && echo "started (loop pid $(cat $PIDF))" || { echo "FAILED to start, see $LOG"; exit 1; }
    ;;
  stop)
    stop_all
    echo stopped
    ;;
  restart)
    stop_all
    sleep 1
    exec "$0" start
    ;;
  status)
    if running; then
      echo "running (loop pid $(cat $PIDF))"; pgrep -af "supercronic.*lovart-auto/crontab" | sed 's/^/  /'
      [[ -f /tmp/lovart-auto.lock.holder ]] && echo "lock holder: $(cat /tmp/lovart-auto.lock.holder) pid=$(cat /tmp/lovart-auto.lock.pid 2>/dev/null)"
    else echo "NOT running → run: $AUTO/scheduler.sh start"; fi
    ;;
  *) echo "usage: $0 start|ensure|stop|restart|status"; exit 64 ;;
esac
