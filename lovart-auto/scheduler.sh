#!/bin/bash
# 管理 Lovart 自动检查的定时器（supercronic，用户态，不需要 root/systemd）
#   scheduler.sh start|ensure   启动（已在跑则什么都不做）—— 重启 box 后执行一次即可恢复
#   scheduler.sh stop           停止
#   scheduler.sh status         查看状态
#   scheduler.sh restart        停干净后重开（清「仍在跑」僵尸状态时用）
#
# 日志行缓冲：Go 的 supercronic 写到普通文件时不会按行刷出，只对它套 stdbuf 无效。
# start 用 util-linux script(1) 分配 PTY，输出经 script -f 立刻进入 scheduler.log。
# pidfile 里是 __loop 这个循环 bash 的 pid，不是 script 的 pid。
# 心跳和 cgroup 只做诊断，不改 crontab、开火方式或「退出后 10 秒再拉起」。
# cgroup 写失败是预期（服务用户通常写不了 background/cgroup.procs），不代表冻结已修好。
set -u
AUTO=/workspace/lovart-auto
BIN=/home/box/.local/bin/supercronic
PIDF=/tmp/lovart-auto-scheduler.pid
LOG=$AUTO/logs/scheduler.log
# 诊断心跳间隔。只影响循环里的旁路进程，不改变任务时刻或 supercronic 的 10 秒重启。
HEARTBEAT_SEC=60
# 尽力把循环 bash 挪进 background cgroup；子进程在这之后 fork，成功时才会跟着继承。
CGROUP_PROCS=/sys/fs/cgroup/background/cgroup.procs
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

# __loop 只应由 start 经 script 拉起。stdout 必须是 PTY，否则日志会再次堵在用户态缓冲里。
run_loop() {
  # 只有 start 经 script 拉起时才带这个标记，避免有人在终端里直接跑 __loop 写掉 pidfile。
  if [[ "${LOVART_SCHEDULER_LOOP:-}" != 1 ]]; then
    echo "usage: $0 start|ensure|stop|restart|status" >&2
    exit 64
  fi
  if [[ ! -t 1 ]]; then
    echo "[$(date '+%F %T %z')] scheduler __loop refused: stdout is not a pty" >>"$LOG"
    exit 1
  fi
  # 关掉作业监控，避免「Terminated」写进日志；关掉输出后处理，避免 PTY 把 LF 变成 CR LF。
  set +m
  stty -opost 2>/dev/null || true
  echo $$ > "$PIDF"
  local ts cg_pid
  ts=$(date '+%F %T %z')
  cg_pid=$$
  # 重定向失败（文件不存在或服务用户不可写）不能把 shell 的报错灌进日志，也不能中止循环。
  if { echo "$cg_pid" >>"$CGROUP_PROCS"; } 2>/dev/null; then
    echo "[$ts] cgroup best-effort: moved pid=$cg_pid into $CGROUP_PROCS (diagnostic only; not a freeze fix)"
  else
    echo "[$ts] cgroup best-effort: could not move pid=$cg_pid into $CGROUP_PROCS (expected if not writable; not a freeze fix)"
  fi
  local child="" hb=""
  trap 'kill ${child:-} ${hb:-} 2>/dev/null || true; exit 0' TERM INT
  while true; do
    echo "[$(date '+%F %T %z')] start supercronic"
    # stdin 保持 /dev/null，和改 PTY 之前一样，避免任务从终端读到输入。
    # 内部标记不传给任务。
    env -u LOVART_SCHEDULER_LOOP "$BIN" -passthrough-logs "$AUTO/crontab" </dev/null &
    child=$!
    # 心跳是旁路：supercronic 一退出，wait 立刻返回，再杀掉心跳，重启等待仍是 10 秒。
    (
      # 这里不是函数，不能用 local。wait 可被 TERM 立刻打断，避免把 10 秒重启拖成一个心跳间隔。
      trap 'kill ${sp:-} 2>/dev/null || true; exit 0' TERM INT
      sp=
      while kill -0 "$child" 2>/dev/null; do
        sleep "$HEARTBEAT_SEC" &
        sp=$!
        wait "$sp" || exit 0
        kill -0 "$child" 2>/dev/null || exit 0
        echo "[$(date '+%F %T %z')] heartbeat epoch=$(date +%s) supercronic_pid=$child"
      done
    ) </dev/null &
    hb=$!
    wait "$child"
    rc=$?
    kill -TERM "$hb" 2>/dev/null || true
    wait "$hb" 2>/dev/null || true
    echo "[$(date '+%F %T %z')] supercronic exited $rc, restart in 10s"
    sleep 10
  done
}

case "${1:-status}" in
  start|ensure)
    kill_stale_runs
    if running; then echo "already running (loop pid $(cat $PIDF))"; exit 0; fi
    mkdir -p "$AUTO/logs"
    # -q 不在 stdout 写 Script started/done；-f 每次从 PTY 读到数据就 fflush 到日志。
    # typescript 丢到 /dev/null，日志只用 script 自己的 stdout，避免横幅和双写。
    loop_cmd=$(printf 'LOVART_SCHEDULER_LOOP=1 bash %q __loop' "$0")
    nohup setsid script -q -f -e -c "$loop_cmd" /dev/null >>"$LOG" 2>&1 </dev/null &
    sleep 1
    running && echo "started (loop pid $(cat $PIDF))" || { echo "FAILED to start, see $LOG"; exit 1; }
    ;;
  __loop)
    run_loop
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
