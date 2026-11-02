#!/bin/bash
# 管理 Lovart 自动检查的定时器（supercronic，用户态，不需要 root/systemd）
#   scheduler.sh start|ensure   启动（已在跑则什么都不做）—— 重启 box 后执行一次即可恢复
#   scheduler.sh stop           停止
#   scheduler.sh status         查看状态
set -u
AUTO=/workspace/lovart-auto
BIN=/home/box/.local/bin/supercronic
PIDF=/tmp/lovart-auto-scheduler.pid
LOG=$AUTO/logs/scheduler.log
export TZ=Asia/Shanghai LANG=C.UTF-8 HOME=/home/box PATH=/home/box/.local/bin:/usr/local/bin:/usr/bin:/bin

running() { [[ -f $PIDF ]] && kill -0 "$(cat $PIDF)" 2>/dev/null; }

case "${1:-status}" in
  start|ensure)
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
    if running; then kill "$(cat $PIDF)"; sleep 1; rm -f $PIDF; echo stopped; else echo "not running"; fi
    ;;
  status)
    if running; then
      echo "running (loop pid $(cat $PIDF))"; pgrep -af "supercronic.*lovart-auto/crontab" | sed 's/^/  /'
    else echo "NOT running → run: $AUTO/scheduler.sh start"; fi
    ;;
  *) echo "usage: $0 start|ensure|stop|status"; exit 64 ;;
esac
