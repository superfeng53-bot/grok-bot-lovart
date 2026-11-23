#!/bin/bash
# 验证 scheduler.sh 的两件事：
# 1. script(1) 的 PTY 让「非 tty 就不写出」的 Go 假 supercronic 立刻把 read crontab 送进日志，
#    且 pidfile 指向 __loop bash，而不是 script。
# 2. 心跳约每 HEARTBEAT_SEC 一行；cgroup 写入成功/失败都只记诊断，不改开火与 10 秒重启。
# 不连接生产 pid、不调用仓库里的 scheduler.sh 本体（只跑改写过路径的副本）。
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC=$ROOT/lovart-auto/scheduler.sh
CRONTAB=$ROOT/lovart-auto/crontab
REAL_PIDF=/tmp/lovart-auto-scheduler.pid
CRONTAB_SHA=bd50d4973beebfdbe95be122590bdae70f791afb4d1b0675dfd80b74651113d8

die() {
  echo "FAIL: $*" >&2
  if [[ -n "${LOG:-}" && -f ${LOG:-} ]]; then
    echo "---- log ----" >&2
    cat -A "$LOG" >&2 || true
  fi
  exit 1
}

assert_source() {
  local sha
  sha=$(sha256sum "$CRONTAB" | awk '{print $1}')
  [[ $sha == "$CRONTAB_SHA" ]] || die "crontab 被改动了: $sha"
  grep -q '^HEARTBEAT_SEC=60$' "$SRC" || die "仓库里的心跳间隔必须仍是 60 秒"
  grep -q 'script -q -f -e -c' "$SRC" || die "start 应通过 script 分配 PTY"
  grep -q -- '-passthrough-logs' "$SRC" || die "supercronic 仍应使用 -passthrough-logs"
  grep -q 'sleep 10' "$SRC" || die "supercronic 退出后仍应等待 10 秒"
  grep -q 'echo $$ > "$PIDF"' "$SRC" || die "pidfile 应写循环 bash 的 \$\$"
  grep -q 'exec env LOVART_SCHEDULER_LOOP=1 bash' "$SRC" || die "start 应用 exec 去掉 script 外的 sh -c"
  # 注释里可以解释为什么不用 stdbuf；真正的命令行不能靠它。
  ! grep -vE '^[[:space:]]*#' "$SRC" | grep -q 'stdbuf' || die "不要用 stdbuf 冒充行缓冲"
  ! grep -vE '^[[:space:]]*#' "$SRC" | grep -q 'pkill -f' || die "不要用 pkill -f 按子串杀进程"
  ! grep -vE '^[[:space:]]*#' "$SRC" | grep -q 'supercronic\.\*' || die "不要留下 supercronic.* 这种宽匹配"
  ! grep -vE '^[[:space:]]*#' "$SRC" | grep -Eq 'systemd|0 9 \* \* \*' || die "scheduler.sh 不应加入 systemd 或 crontab 时刻"
}

wait_grep() {
  local pat=$1 secs=$2 i
  for ((i = 0; i < secs * 10; i++)); do
    if grep -F -q -- "$pat" "$LOG"; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

count_fixed() {
  local pat=$1
  grep -F -c -- "$pat" "$LOG" || true
}

proc_args_contain() {
  local needle=$1 p cmd found=0
  shopt -s nullglob
  for p in /proc/[0-9]*; do
    cmd=$(tr '\0' ' ' <"$p/cmdline" 2>/dev/null || true)
    if [[ $cmd == *"$needle"* ]]; then
      found=1
      break
    fi
  done
  shopt -u nullglob
  [[ $found -eq 1 ]]
}

wait_count() {
  local pat=$1 n=$2 secs=$3 i got
  for ((i = 0; i < secs * 10; i++)); do
    got=$(count_fixed "$pat")
    if [[ $got -ge $n ]]; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

compile_fake() {
  local dir=$1
  cat >"$dir/fake.go" <<'EOF'
package main

import (
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

func isatty(fd int) bool {
	var t syscall.Termios
	_, _, errno := syscall.Syscall6(syscall.SYS_IOCTL, uintptr(fd), syscall.TCGETS, uintptr(unsafe.Pointer(&t)), 0, 0, 0)
	return errno == 0
}

func main() {
	if path := os.Getenv("FAKE_META"); path != "" {
		f, err := os.Create(path)
		if err == nil {
			fmt.Fprintf(f, "stdin_tty=%v\nstdout_tty=%v\nstderr_tty=%v\n", isatty(0), isatty(1), isatty(2))
			fmt.Fprintf(f, "args=%s\n", strings.Join(os.Args, "\n"))
			f.Close()
		}
	}
	// 模拟「不是终端就不把 read crontab 写出去」。stdbuf 改变不了这个判断。
	if isatty(2) {
		_, _ = os.Stderr.Write([]byte("read crontab\n"))
	}
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	select {
	case <-sig:
		os.Exit(0)
	case <-time.After(5 * time.Minute):
	}
}
EOF
  GO111MODULE=off go build -o "$dir/fake-supercronic" "$dir/fake.go"
}

prepare_copy() {
  local dir=$1 heartbeat=$2 cgroup=$3
  cp "$SRC" "$dir/scheduler.sh"
  chmod +x "$dir/scheduler.sh"
  # 目录名故意不含 lovart-auto，避免和旧的宽 pkill 或生产路径撞车。
  [[ $dir != *lovart-auto* ]] || die "测试目录含有 lovart-auto: $dir"
  sed -i \
    -e "s|^AUTO=.*|AUTO=$dir/credit-sched|" \
    -e "s|^BIN=.*|BIN=$TMP/fake-supercronic|" \
    -e "s|^PIDF=.*|PIDF=$dir/scheduler.pid|" \
    -e "s|^HEARTBEAT_SEC=.*|HEARTBEAT_SEC=$heartbeat|" \
    -e "s|^CGROUP_PROCS=.*|CGROUP_PROCS=$cgroup|" \
    "$dir/scheduler.sh"
  grep -qxF "AUTO=$dir/credit-sched" "$dir/scheduler.sh" || die "副本 AUTO 没改成测试目录"
  grep -qxF "PIDF=$dir/scheduler.pid" "$dir/scheduler.sh" || die "副本仍指向生产 pidfile"
  grep -qxF "BIN=$TMP/fake-supercronic" "$dir/scheduler.sh" || die "副本没指向假 supercronic"
  grep -qxF "CGROUP_PROCS=$cgroup" "$dir/scheduler.sh" || die "副本 cgroup 路径没改掉"
  [[ $dir/credit-sched != *lovart-auto* && $dir/scheduler.pid != "$REAL_PIDF" ]] || die "副本路径和生产成本撞了"
}

negative_control() {
  local bin=$1 out=$2
  : >"$out"
  "$bin" >>"$out" 2>>"$out" &
  local pid=$!
  sleep 0.4
  if grep -q 'read crontab' "$out"; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    die "假 supercronic 在普通文件上就把 read crontab 写出来了，测试不再能证明 PTY"
  fi
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

loop_pid() { cat "$PIDF"; }

assert_pid_is_loop_bash() {
  local lp ppid cmd pcmd
  lp=$(loop_pid)
  [[ -n $lp ]] || die "pidfile 是空的"
  kill -0 "$lp" || die "pidfile 里的进程不在"
  cmd=$(tr '\0' ' ' </proc/"$lp"/cmdline)
  [[ $cmd == *'__loop'* ]] || die "pidfile 不是 __loop bash: $cmd"
  [[ $(ps -o comm= -p "$lp" | tr -d ' ') == bash ]] || die "pidfile 进程不是 bash"
  ppid=$(ps -o ppid= -p "$lp" | tr -d ' ')
  [[ $ppid != "$lp" ]] || die "pidfile 不该是它自己的父进程"
  pcmd=$(ps -o args= -p "$ppid")
  # exec 之后父进程应直接是 script。中间如果还剩 sh -c，把整条祖先进错误里。
  if [[ $(ps -o comm= -p "$ppid" | tr -d ' ') != script ]]; then
    die "父进程应是 script，实际: $pcmd"$'\n'"$(ancestor_chain "$lp")"
  fi
  local child_cmd
  child_cmd=$(ps -o args= --ppid "$lp" | tr '\n' '|')
  [[ $child_cmd == *fake-supercronic* ]] || die "循环 bash 的子进程里没有假 supercronic: $child_cmd"
}

assert_mtime_fresh() {
  python3 - "$LOG" <<'PY'
import os, sys, time
path = sys.argv[1]
delta = time.time() - os.stat(path).st_mtime
if delta > 3:
    sys.exit("log mtime lags wall clock by %.1fs" % delta)
print("mtime delta %.3fs" % delta)
PY
}

ancestor_chain() {
  local p=$1 i=0 comm args
  while [[ -n $p && $p != 0 && $p != 1 && $i -lt 6 ]]; do
    comm=$(ps -o comm= -p "$p" 2>/dev/null | tr -d ' ' || true)
    args=$(ps -o args= -p "$p" 2>/dev/null || true)
    printf '  pid=%s comm=%s args=%s\n' "$p" "$comm" "$args"
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ' || true)
    i=$((i + 1))
  done
}

start_production_lookalikes() {
  # 旧 pkill -f 'supercronic.*lovart-auto/crontab' 会命中这种 bash -c。
  bash -c 'sleep 400; : /home/box/.local/bin/supercronic -passthrough-logs /workspace/lovart-auto/crontab' &
  standin_supervisor_pid=$!
  # ELF 才能保住 argv0。shebang 脚本会被内核改成解释器路径。
  env -u FAKE_META bash -c 'exec -a /home/box/.local/bin/supercronic "$1" -passthrough-logs /workspace/lovart-auto/crontab' _ "$TMP/fake-supercronic" &
  standin_super_pid=$!
  sleep 0.3
  kill -0 "$standin_supervisor_pid" || die "supervisor 替身没起来"
  kill -0 "$standin_super_pid" || die "supercronic 替身没起来"
  local sup_cmd sc
  sup_cmd=$(tr '\0' ' ' <"/proc/$standin_supervisor_pid/cmdline")
  [[ $sup_cmd == *'/home/box/.local/bin/supercronic -passthrough-logs /workspace/lovart-auto/crontab'* ]] \
    || die "supervisor 替身不像生产命令行: $sup_cmd"
  sc=$(python3 - "/proc/$standin_super_pid/cmdline" <<'PY'
import sys
data = open(sys.argv[1], "rb").read().split(b"\0")
if data and data[-1] == b"":
    data = data[:-1]
print("\n".join(x.decode() for x in data))
PY
)
  [[ $sc == $'/home/box/.local/bin/supercronic\n-passthrough-logs\n/workspace/lovart-auto/crontab' ]] \
    || die "supercronic 替身 argv 不是生产那三项: $sc"
}

assert_lookalikes_alive() {
  kill -0 "$standin_supervisor_pid" || die "stop 误伤了看起来像生产 supervisor 的 bash -c"
  kill -0 "$standin_super_pid" || die "stop 误伤了看起来像生产 supercronic 的进程"
}

cleanup() {
  if [[ -n "${SCHED:-}" && -f ${SCHED:-} ]]; then
    "$SCHED" stop >/dev/null 2>&1 || true
  fi
  if [[ -n "${PIDF:-}" && -f ${PIDF:-} ]]; then
    local lp
    lp=$(cat "$PIDF" 2>/dev/null || true)
    if [[ -n ${lp:-} ]]; then
      pkill -TERM -P "$lp" 2>/dev/null || true
      kill -TERM "$lp" 2>/dev/null || true
    fi
    rm -f "$PIDF"
  fi
  if [[ -n ${standin_supervisor_pid:-} ]]; then
    kill "$standin_supervisor_pid" 2>/dev/null || true
  fi
  if [[ -n ${standin_super_pid:-} ]]; then
    kill "$standin_super_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

assert_source
[[ ! -e $REAL_PIDF ]] || die "本机已有生产 pidfile，测试中止以免碰到它"

TMP=$(mktemp -d)
compile_fake "$TMP"
negative_control "$TMP/fake-supercronic" "$TMP/negative.log"
start_production_lookalikes

# --- cgroup 写失败：进程仍要起来，日志只记预期失败 ---
FAIL_DIR=$TMP/fail
mkdir -p "$FAIL_DIR"
prepare_copy "$FAIL_DIR" 60 "$FAIL_DIR/missing-dir/cgroup.procs"
SCHED=$FAIL_DIR/scheduler.sh
PIDF=$FAIL_DIR/scheduler.pid
LOG=$FAIL_DIR/credit-sched/logs/scheduler.log
export FAKE_META=$FAIL_DIR/meta
rm -f "$FAKE_META"
"$SCHED" start >/dev/null
wait_grep 'could not move pid=' 3 || die "cgroup 失败没有写进日志"
grep -q 'expected if not writable' "$LOG" || die "失败日志没说明这是预期"
grep -q 'not a freeze fix' "$LOG" || die "失败日志不应让人以为冻结已修好"
kill -0 "$(loop_pid)" || die "cgroup 失败不应该让循环退出"
"$SCHED" stop >/dev/null
[[ ! -f $PIDF ]] || die "stop 后失败用例的 pidfile 还在"
assert_lookalikes_alive

# --- 行缓冲、pidfile、心跳、cgroup 成功、10 秒重启 ---
OK_DIR=$TMP/ok
mkdir -p "$OK_DIR"
CG=$OK_DIR/cgroup.procs
: >"$CG"
prepare_copy "$OK_DIR" 3 "$CG"
SCHED=$OK_DIR/scheduler.sh
PIDF=$OK_DIR/scheduler.pid
LOG=$OK_DIR/credit-sched/logs/scheduler.log
export FAKE_META=$OK_DIR/meta
rm -f "$FAKE_META"
# 直接跑 __loop 不能写 pidfile（即便外面碰巧是终端）。
direct_rc=0
direct_out=$("$SCHED" __loop 2>&1) || direct_rc=$?
[[ $direct_rc -eq 64 ]] || die "直接 __loop 应拒绝，退出码 $direct_rc，输出: $direct_out"
[[ ! -f $PIDF ]] || die "直接 __loop 写了 pidfile"
# 调度器还没启动时，stop 只能靠精确 argv 清理。生产样子的替身必须还在。
env -u FAKE_META "$TMP/fake-supercronic" -passthrough-logs "$OK_DIR/credit-sched/crontab" &
orphan=$!
sleep 0.2
kill -0 "$orphan" || die "本副本残留没起来"
"$SCHED" stop >/dev/null || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
  kill -0 "$orphan" 2>/dev/null || break
  sleep 0.1
done
if kill -0 "$orphan" 2>/dev/null; then
  die "stop 没有按精确 argv 清掉本副本的残留 supercronic"
fi
assert_lookalikes_alive
start_out=$("$SCHED" start)
[[ $start_out == started\ \(loop\ pid\ * ]] || die "start 输出异常: $start_out"
wait_grep 'start supercronic' 3 || die "启动后日志里没有 start supercronic"
wait_grep 'read crontab' 3 || die "启动后、未发 kill，日志里没有 read crontab"
assert_mtime_fresh
! grep -q $'\r' "$LOG" || die "日志含 CR，PTY 把换行翻译了"
! grep -q 'Script started' "$LOG" || die "日志含 script 横幅"
! grep -q 'Terminated' "$LOG" || die "日志含 Terminated"
lp=$(loop_pid)
[[ $start_out == *"loop pid $lp"* ]] || die "start 打印的 pid 与 pidfile 不一致"
assert_pid_is_loop_bash
echo "process tree:"
ancestor_chain "$lp"
[[ -f $FAKE_META ]] || die "假 supercronic 没写 meta"
grep -q '^stdin_tty=false$' "$FAKE_META" || die "任务 stdin 不应是终端: $(cat "$FAKE_META")"
grep -q '^stderr_tty=true$' "$FAKE_META" || die "supercronic stderr 应看到 PTY: $(cat "$FAKE_META")"
grep -F -q -- '-passthrough-logs' "$FAKE_META" || die "没有按原样传入 -passthrough-logs"
grep -F -q -- "$OK_DIR/credit-sched/crontab" "$FAKE_META" || die "crontab 路径不对: $(cat "$FAKE_META")"
grep -F -q "moved pid=$lp into $CG" "$LOG" || die "cgroup 成功没有记日志"
grep -F -q 'not a freeze fix' "$LOG" || die "成功日志也不应宣称冻结已修好"
grep -qx "$lp" "$CG" || die "cgroup.procs 里没有循环 pid"
# 心跳间隔在副本里是 3 秒。start 自己已经等了约 1 秒，这里再等到出现。
wait_grep 'heartbeat epoch=' 6 || die "没有墙钟心跳"
hb=$(grep -F 'heartbeat epoch=' "$LOG" | head -1 || true)
[[ $hb =~ ^\[[0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{2}:[0-9]{2}:[0-9]{2}\ [+-][0-9]{4}\]\ heartbeat\ epoch=[0-9]+\ supercronic_pid=[0-9]+$ ]] \
  || die "心跳格式不对: $hb"

ensure_out=$("$SCHED" ensure)
[[ $ensure_out == *"already running (loop pid $lp)"* ]] || die "ensure 应保持原循环: $ensure_out"
[[ $(loop_pid) == "$lp" ]] || die "ensure 换了 pid"

# 只杀掉 supercronic，循环应马上记下退出，并在约 10 秒后重新拉起。不要杀循环本身。
child=$(ps -o pid=,args= --ppid "$lp" | awk '/fake-supercronic/ {print $1; exit}')
[[ -n ${child:-} ]] || die "找不到假 supercronic 子进程"
kill -TERM "$child"
wait_grep 'supercronic exited' 2 || die "supercronic 退出后 2 秒内没有退出记录（重启检测被心跳拖住了）"
wait_count 'start supercronic' 2 15 || die "约 10 秒后没有第二次 start supercronic"
wait_count 'read crontab' 2 3 || die "重新拉起后没有新的 read crontab"
exited_line=$(grep -F 'supercronic exited' "$LOG" | head -1 || true)
python3 - "$exited_line" "$LOG" <<'PY'
import re, sys, datetime
exited = sys.argv[1]
text = open(sys.argv[2], encoding="utf-8").read().splitlines()
def stamp(line):
    m = re.match(r"\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) ", line)
    if not m:
        sys.exit("bad stamp: " + line)
    return datetime.datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S")
seen = False
nxt = None
exit_at = stamp(exited)
for line in text:
    if line == exited:
        seen = True
        continue
    if seen and "start supercronic" in line:
        nxt = stamp(line)
        break
if nxt is None:
    sys.exit("no second start yet")
delta = (nxt - exit_at).total_seconds()
if not (8 <= delta <= 14):
    sys.exit("restart delay %.1fs, want about 10s" % delta)
print("restart delay %.0fs" % delta)
PY

# restart 走 stop+start，pidfile 换成新的循环 bash。
old=$lp
reads_before=$(count_fixed 'read crontab')
restart_out=$("$SCHED" restart)
new=$(loop_pid)
[[ $restart_out == *"started (loop pid $new)"* ]] || die "restart 输出异常: $restart_out"
[[ $new != "$old" ]] || die "restart 没有换循环 pid"
! kill -0 "$old" 2>/dev/null || die "旧循环还在"
assert_pid_is_loop_bash
wait_count 'read crontab' $((reads_before + 1)) 3 || die "restart 后没有新的 read crontab"

# status 在没有 lock holder 时，原脚本的最后一条 [[ -f ]] 会让退出码为 1。只检查输出。
status_out=$("$SCHED" status || true)
[[ $status_out == *"running (loop pid $new)"* ]] || die "status 没报告循环 pid: $status_out"
stop_out=$("$SCHED" stop || true)
[[ $stop_out == *stopped* ]] || die "stop 输出异常: $stop_out"
[[ ! -f $PIDF ]] || die "stop 后 pidfile 还在"
! kill -0 "$new" 2>/dev/null || die "stop 后循环还在"
if proc_args_contain "$SCHED __loop"; then die "stop 后还有 __loop 或 script"; fi
if proc_args_contain "$TMP/fake-supercronic"; then die "stop 后假 supercronic 还在"; fi
assert_lookalikes_alive
[[ ! -e $REAL_PIDF ]] || die "测试碰到了生产 pidfile"
sha256sum "$CRONTAB" | awk '{print $1}' | grep -qx "$CRONTAB_SHA" || die "跑完后 crontab 变了"

echo "PASS scheduler pty line-buffer, pidfile, heartbeat, cgroup diagnostic, 10s restart"
