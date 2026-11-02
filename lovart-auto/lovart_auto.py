#!/usr/bin/env python3
"""Lovart 每日积分到账检查 —— 纯程序化（不经模型）。

用法（一般通过 run.sh 调用）:
  lovart_auto.py first     第一轮：查全部在用号（当天已开查则只查 pending_today.profiles）
  lovart_auto.py recheck   重查：只查 pending_today.profiles；当天还没跑过第一轮则自动按第一轮跑
选项:
  --dry-run            只读/测试模式：状态文件用副本，所有输出写到 --out-dir（默认 /tmp/lovart-auto-dryrun-<时间>）
  --out-dir DIR        dry-run 输出目录
  --state-src PATH     dry-run 时拿来复制的状态文件（默认正式状态文件）
  --profiles 4,5,6     只查这些号（测试用；仍会跳过弃用号）
  --force              当天已全部有结论也照样跑；无 --profiles 时仍需 --dry-run；有 --profiles 时可实跑指定号
  --today YYYY-MM-DD   覆盖日期（只允许和 --dry-run 一起用）
TODAY 默认一律取 Asia/Shanghai 当前日期。
"""
import argparse, datetime, json, os, re, shutil, signal, subprocess, sys, time, traceback
from collections import Counter
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Asia/Shanghai")
WS = "/workspace"
AUTO = WS + "/lovart-auto"
CHECK = AUTO + "/check-one.cjs"
SWITCH = AUTO + "/switch-profile.sh"  # copy of /workspace/lovart-switch-profile-direct.sh + fixed window size
STATE = WS + "/lovart-daily-credits-state.json"
LOGMD = WS + "/lovart-daily-credits-log.md"
BACKUP_DIR = WS + "/backups/lovart-auto"
HARD_SKIP = {3, 7, 11, 12, 14, 16, 17}
CHECK_TIMEOUT = 300
MAX_ATTEMPTS = 3
FINAL_HOUR = 11  # 11 点那一轮（或第 3 次）是当天最后一轮
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
CONN_RE = re.compile(r"198\.18\.|SSL|EOF|ERR_|net::|connection|Connection|ECONN|socket|timed? ?out|Timeout|CDP|empty checker|no json|Target closed|Protocol error", re.I)


def now():
    return datetime.datetime.now(TZ)


def iso(dt=None):
    return (dt or now()).strftime("%Y-%m-%dT%H:%M:%S%z")


def log(*a):
    print(f"[{now().strftime('%H:%M:%S')}]", *a, file=sys.stderr, flush=True)


def scrub(s):
    return EMAIL_RE.sub("<email>", s or "")


def L(n):
    return f"L{n}"


def jdump(obj, path):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def empty_raw(note):
    return {"status": "blocked", "note": note, "bonus": None, "claimed_time": None, "balance": None,
            "today_remaining": None, "month_remaining": None, "total_balance": None,
            "topbar_lightning": None, "plan": None, "renewal": None, "last_bonus": None,
            "email_seen": None, "layout": None}


# ---------------------------------------------------------------- browser side
def run_switch(n):
    try:
        r = subprocess.run([SWITCH, str(n)], capture_output=True, text=True, timeout=90)
        log(f"switch P{n}:", (r.stdout or "").strip().replace("\n", " | "))
        return r.returncode == 0
    except subprocess.TimeoutExpired:
        log(f"switch P{n}: timeout")
        return False


def profile_running(n):
    r = subprocess.run(["ps", "-eo", "args"], capture_output=True, text=True)
    return re.search(rf"--profile-directory=Profile {n}( |$)", r.stdout, re.M) is not None


def run_checker(email, today):
    """Returns (raw_dict, timed_out)."""
    env = dict(os.environ, LOVART_TODAY=today)
    p = subprocess.Popen(["node", CHECK, email, today], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         text=True, env=env, start_new_session=True)
    try:
        out, err = p.communicate(timeout=CHECK_TIMEOUT)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except Exception:
            pass
        p.communicate()
        return empty_raw(f"checker timeout {CHECK_TIMEOUT}s"), True
    lines = [l for l in (out or "").splitlines() if l.strip().startswith("{")]
    if not lines:
        return empty_raw("empty checker output" + (f"; stderr={err.strip()[-200:]}" if err and err.strip() else "")), False
    try:
        return json.loads(lines[-1]), False
    except Exception:
        return empty_raw("no json from checker"), False


def kill_fork2_chrome():
    """扫号结束后关掉 Fork-2 Chrome，避免最后一个 Profile 常驻占内存（不是多 Profile 并行）。"""
    ud = "/home/box/chrome-profile/Fork-2"
    try:
        subprocess.run(
            ["bash", "-lc", f"pkill -f 'user-data-dir={ud}' >/dev/null 2>&1 || true; sleep 1; "
             f"pkill -9 -f 'user-data-dir={ud}' >/dev/null 2>&1 || true; "
             f"rm -f '{ud}/SingletonLock' '{ud}/SingletonSocket' '{ud}/SingletonCookie'"],
            timeout=20,
        )
        log("Fork-2 Chrome closed after credits scan")
    except Exception as e:
        log(f"Fork-2 Chrome cleanup warn: {e}")


def check_profile(n, email, today):
    """Switch Chrome to Profile n, run checker; one automatic retry on timeout/blocked/empty."""
    log(f"=== Profile {n} ===")
    ok = run_switch(n)
    if not ok:
        time.sleep(2)
        ok = run_switch(n)
    if not ok:
        return empty_raw("CDP_FAIL after 2 launches")
    time.sleep(5)
    if not profile_running(n):
        log("profile mismatch in ps, relaunch")
        run_switch(n)
        time.sleep(5)
    raw, to = run_checker(email, today)
    # 阻塞 / 未到账但页面已有 DLB 区 / 余额未解析：再开一次用量页（防早上抢跑）
    need_retry = (
        raw.get("status") == "blocked"
        or (raw.get("status") == "miss" and ("hasDLB=true" in (raw.get("note") or "")))
        or (raw.get("status") in ("ok", "miss") and raw.get("balance") is None and raw.get("total_balance") is None)
    )
    if need_retry:
        why = "blocked" if raw.get("status") == "blocked" else ("miss+hasDLB" if raw.get("status") == "miss" else "balance=null")
        log(f"P{n} first try {why}{' TIMEOUT' if to else ''}: {scrub(raw.get('note'))[:120]} → wait + retry once")
        time.sleep(8)
        raw2, to2 = run_checker(email, today)
        # 第二次更好就换；仍 blocked 则标 after retry
        better = (
            (raw.get("status") != "ok" and raw2.get("status") == "ok")
            or (raw.get("balance") is None and raw2.get("balance") is not None)
            or (raw.get("total_balance") is None and raw2.get("total_balance") is not None)
            or (raw.get("status") == "blocked" and raw2.get("status") != "blocked")
        )
        if better or raw.get("status") == "blocked":
            if raw2.get("status") == "blocked":
                raw2["note"] = (raw2.get("note") or "") + " (after retry)"
            raw = raw2
        else:
            # 第二次没更好：保留第一次，但在 note 里记下已重试
            raw["note"] = (raw.get("note") or "") + " (retried once, unchanged)"
    return raw


# ---------------------------------------------------------------- bookkeeping

def write_balance_snapshot(today, state, day_accounts, ran):
    """本地余额快照：以后对账优先查当天文件，不靠误读的本日额度。"""
    snap_dir = WS + "/lovart-balance-snapshots"
    os.makedirs(snap_dir, exist_ok=True)
    path = f"{snap_dir}/{today}.json"
    index_path = f"{snap_dir}/index.md"
    prev = {}
    if os.path.exists(path):
        try:
            prev = json.load(open(path))
        except Exception:
            prev = {}
    accounts = dict(prev.get("accounts") or {})
    by_profile = {x.get("profile"): x for x in (day_accounts or []) if x.get("profile") in ran}
    for n in ran:
        rec = by_profile.get(n) or {}
        acc = (state.get("accounts") or {}).get(str(n)) or {}
        today_rem = rec.get("today_remaining") if rec.get("today_remaining") is not None else acc.get("today_remaining")
        # 快照总额：本轮可靠 total_balance 优先；旧 state.balance 仅在「像真总额」时沿用。
        # 禁止把被顶栏续费日污染的旧值（如 L15 balance=13）写进当日快照。
        rec_tot = rec.get("total_balance")
        state_bal = acc.get("balance")
        if rec_tot is not None:
            snap_tot = rec_tot
        elif _topbar_looks_real_total(state_bal, today_rem):
            snap_tot = state_bal
        else:
            snap_tot = None
        accounts[str(n)] = {
            "L": f"L{n}",
            "class": acc.get("class") or rec.get("class_after"),
            "bonus": rec.get("bonus"),
            "claimed_time": rec.get("claimed_time"),
            "today_remaining": today_rem,
            "total_balance": snap_tot,
            "plan": rec.get("plan") or acc.get("plan"),
            "checked_at": rec.get("checked_at") or iso(),
            "chrome_profile": acc.get("chrome_profile") or n,
        }
    doc = {"date": today, "tz": "Asia/Shanghai", "updated_at": iso(), "accounts": accounts}
    jdump(doc, path)
    # append index line
    bits = []
    for k in sorted(accounts, key=lambda x: int(x)):
        if int(k) not in ran:
            continue
        a = accounts[k]
        bits.append(f"L{k}:{a.get('class')}/本日={a.get('today_remaining')}/总额={a.get('total_balance')}")
    line = "- {} {} | {} | file={}\n".format(
        today, iso(), (" ".join(bits) if bits else "(no accounts)"), path)
    if not os.path.exists(index_path):
        with open(index_path, "w") as f:
            f.write("# lovart balance snapshots\n\n")
    with open(index_path, "a") as f:
        f.write(line)
    log("balance snapshot:", path)
    return path


def classify(prior, bonus, balance, note_special=None, today_remaining=None, total_balance=None):
    """returns new class. balance/total_balance = 可用总额。
    2026-10-30：有可靠 total≤100 且 bonus=100 → 充值；>100 → 特殊。
    note_special 仅备注，不挡住「总额≤100→充值」。无可靠总额时保持 prior。
    """
    # 2026-10-25 用户定：+30 也算免费号（与 +70 同组）
    if bonus in (30, 70):
        return "免费"
    tot = total_balance if isinstance(total_balance, (int, float)) else balance
    if bonus == 100:
        # 10-11 / 10-30：可用总额 >100 → 特殊；可靠总额 ≤100 → 充值（含特殊号降级）
        if tot is not None and tot > 100:
            return "特殊"
        if tot is not None and tot <= 100:
            return "充值"
        # 无可靠总额：不瞎降级；特殊保持特殊，其它按充值
        if prior == "特殊":
            return "特殊"
        return "充值"
    return prior


def _topbar_looks_real_total(tb, today_remaining):
    """顶栏小数（<100 且 ≤ today_remaining）不得抬成 total_balance。"""
    if not isinstance(tb, (int, float)) or tb <= 0:
        return False
    if today_remaining is not None and tb < 100 and tb <= today_remaining:
        return False
    return tb >= 100 or (today_remaining is not None and tb > today_remaining)


def make_rec(n, email, prior, r, attempt, checked_at, note_special=None):
    status = r.get("status")
    if status == "login_required":
        status = "needs_otp"
    bonus = r.get("bonus")
    today_remaining = r.get("today_remaining")
    total_balance = r.get("total_balance")
    # balance 字段 = 可用总额（checker 优先 API usablePower / 可靠页面总额）
    balance = r.get("balance")
    if total_balance is None and isinstance(balance, (int, float)):
        # 兼容旧 checker：若 note 标明本日= 且无总额，勿把本日当总额
        total_balance = None
    if total_balance is None:
        # 禁止用非 looksReal 的顶栏小数抬成 total（例：total=null + topbar=29 + today=100）
        cands = []
        tb = r.get("topbar_lightning")
        if _topbar_looks_real_total(tb, today_remaining):
            cands.append(tb)
        if isinstance(balance, (int, float)):
            if today_remaining is None or balance != today_remaining:
                if _topbar_looks_real_total(balance, today_remaining) or (
                    today_remaining is not None and balance > today_remaining
                ) or balance >= 100:
                    cands.append(balance)
        total_balance = max(cands) if cands else None
    # 展示/state 的 balance 只认可靠总额；禁止把本日额度抬成总额（否则特殊号会被误降级）
    display_balance = total_balance
    rec = {
        "profile": n,
        "email": email,
        "email_confirmed": bool(r.get("email_seen")) and (r.get("email_seen") or "").lower() == email.lower(),
        "bonus": bonus,
        "claimed_time": r.get("claimed_time"),
        "balance": display_balance,
        "today_remaining": today_remaining,
        "month_remaining": r.get("month_remaining"),
        "total_balance": total_balance,
        "topbar_lightning": r.get("topbar_lightning"),
        "plan": r.get("plan"),
        "renewal": r.get("renewal"),
        "last_bonus": r.get("last_bonus"),
        "status": status,
        "block_reason": scrub(r.get("note")) if status == "blocked" else None,
        "note": scrub(r.get("note") or ""),
        "class_before": prior,
        "class_after": (
            # 分类只看可靠 total_balance；本日额度不算「可靠总额」
            classify(prior, bonus, total_balance,
                     note_special=note_special, today_remaining=today_remaining, total_balance=total_balance)
            if status == "ok" else prior
        ),
        "layout": r.get("layout"),
        "switched_to_classic": r.get("switched_to_classic"),
        "attempt": attempt,
        "checked_at": checked_at,
    }
    if status == "email_mismatch":
        rec["note"] = "email mismatch (page shows a different account)"
    return rec


def is_final(attempt, t):
    return attempt >= MAX_ATTEMPTS or t.hour >= FINAL_HOUR


def next_check_label(t):
    if t.hour < 10:
        return "10 点"
    if t.hour < 11:
        return "11 点"
    return None


def join_l(ns):
    return "、".join(L(n) for n in sorted(ns))


def build_summary(day, today, attempt, final, mode, state, errors, files, ran_profiles):
    accs = {a["profile"]: a for a in day.get("accounts", [])}
    st_accs = state["accounts"]
    recharge, free, special, other = [], [], [], []
    pending, not_arrived, conn, login, mismatch, page_err = [], [], [], [], [], []
    for n, a in sorted(accs.items()):
        s = a.get("status")
        if s == "ok":
            b = a.get("bonus")
            cls = a.get("class_after")
            if b == 100 and cls == "充值":
                recharge.append(n)
            elif b == 100 and cls == "特殊":
                special.append(n)
            elif b in (30, 70):
                free.append(n)
            else:
                other.append((n, b))
        elif s == "miss":
            (not_arrived if final else pending).append(n)
        elif s == "blocked":
            (conn if CONN_RE.search(a.get("note") or "") else page_err).append(n)
        elif s == "needs_otp":
            login.append(n)
        elif s == "email_mismatch":
            mismatch.append(n)
    class_changes = [{"account": L(c["profile"]), "from": c["from"], "to": c["to"], "reason": c.get("reason")}
                     for c in day.get("class_changes", [])]
    new_dep = sorted(day.get("new_deprecated", []))
    skipped = sorted(int(k) for k, a in st_accs.items() if a.get("deprecated") or int(k) in HARD_SKIP)
    errs = list(errors)
    for n in conn:
        errs.append(f"{L(n)} 连接失败：{scrub(accs[n].get('note'))[:160]}")
    for n in page_err:
        errs.append(f"{L(n)} 页面没能正常读取：{scrub(accs[n].get('note'))[:160]}")
    for n in login:
        errs.append(f"{L(n)} 要求登录（需人工输验证码）")
    for n in mismatch:
        errs.append(f"{L(n)} 浏览器里登录的不是这个号（账号错配）")
    if errors or conn or page_err or login or mismatch:
        status = "error"
    elif pending or not_arrived:
        status = "pending"
    else:
        status = "ok"

    # ---- message_zh
    arr = []
    if recharge:
        arr.append(f"充值号 {join_l(recharge)} {'各 ' if len(recharge) > 1 else ''}+100")
    if special:
        arr.append(f"特殊号 {join_l(special)} {'各 ' if len(special) > 1 else ''}+100")
    if free:
        # 免费号可能是 +70 或 +30，按金额分组表述
        by_b = {}
        for n in free:
            b = accs[n].get("bonus")
            by_b.setdefault(b, []).append(n)
        bits = []
        for b in sorted(by_b.keys(), reverse=True):
            ns = by_b[b]
            if len(ns) > 1:
                bits.append(f"{len(ns)} 个免费号各 +{b}")
            else:
                bits.append(f"免费号 {join_l(ns)} +{b}")
        arr.append(("另外 " if arr else "") + "，".join(bits))
    for n, b in other:
        arr.append(f"{L(n)} +{b}")
    arr_txt = "，".join(arr)
    t = now()
    if status == "ok":
        msg = f"今天的 Lovart 积分全部到账了：{arr_txt}，没有没到账的。"
    else:
        msg = "今天的 Lovart 积分" + (f"已到账：{arr_txt}。" if arr_txt else "还没有号到账。")
        if pending:
            nxt = next_check_label(t)
            msg += f"{join_l(pending)} 还没到账（已查 {attempt} 次），" + (f"{nxt}再查。" if nxt else "稍后再查。")
        if not_arrived:
            bits = [f"{L(n)}（已连续 {st_accs[str(n)].get('consecutive_miss_days')} 天）" for n in not_arrived]
            msg += f"{'、'.join(bits)}今天查了 {attempt} 次都没到账，记为今日未到账。"
        if conn:
            msg += f"{join_l(conn)} 连接出问题（网关假 IP / SSL 断开等），这轮没法判断，不算未到账" + ("，需要人工看一下。" if final else "，下一轮会再查。")
        if page_err:
            msg += f"{join_l(page_err)} 页面没能正常读取（账户菜单/用量页没打开），这轮没法判断，不算未到账" + ("，需要人工看一下。" if final else "，下一轮会再查。")
        if login:
            msg += f"{join_l(login)} 要求重新登录，需要人工处理（输验证码）。"
        if mismatch:
            msg += f"{join_l(mismatch)} 浏览器里登录的账号对不上，需要人工核对。"
        if errors:
            msg += "检查脚本自己出错了，需要人工接手。"
    if class_changes:
        cc = "；".join(f"{c['account']} 从{c['from']}号改成{c['to']}号（今天 {c['reason']}）" for c in class_changes)
        msg += f"账号分类有变化：{cc}。"
    if new_dep:
        msg += f"{join_l(new_dep)} 连续 3 天没到账，已改为弃用。"
    if not class_changes and not new_dep:
        msg += "账号分类没变，也没有新弃用的号。"
    elif not class_changes:
        msg += "其他账号分类没变。"
    elif not new_dep:
        msg += "没有新弃用的号。"

    return {
        "date": today,
        "generated_at": iso(),
        "status": status,
        "mode": mode,
        "attempt": attempt,
        "final": final,
        "checked_this_run": [L(n) for n in sorted(ran_profiles)],
        "recharge": [L(n) for n in recharge],
        "free": [L(n) for n in free],
        "special": [L(n) for n in special],
        "other_bonus": [{"account": L(n), "bonus": b} for n, b in other],
        "pending": [L(n) for n in pending],
        "not_arrived": [L(n) for n in not_arrived],
        "connection_errors": [L(n) for n in conn],
        "page_errors": [L(n) for n in page_err],
        "login_required": [L(n) for n in login],
        "email_mismatch": [L(n) for n in mismatch],
        "skipped_deprecated": [L(n) for n in skipped],
        "class_changes": class_changes,
        "new_deprecated": [L(n) for n in new_dep],
        "errors": errs,
        "counts": {"+100": len(recharge) + len(special),
                   "+70": sum(1 for n in free if accs[n].get("bonus") == 70),
                   "+30": sum(1 for n in free if accs[n].get("bonus") == 30),
                   "free": len(free), "pending": len(pending),
                   "not_arrived": len(not_arrived), "connection_errors": len(conn), "page_errors": len(page_err),
                   "login_required": len(login), "email_mismatch": len(mismatch)},
        "accounts": [{"account": L(n), "class": a.get("class_after"), "bonus": a.get("bonus"),
                      "claimed_time": a.get("claimed_time"),
                      "balance": (st_accs.get(str(n), {}).get("balance")
                                  if st_accs.get(str(n), {}).get("balance") is not None
                                  else a.get("balance")),
                      "plan": a.get("plan"), "status": a.get("status"), "attempt": a.get("attempt")}
                     for n, a in sorted(accs.items())],
        "message_zh": msg,
        "files": files,
    }


def write_zh_report(path, day, summary, state, active, mode):
    accs = {a["profile"]: a for a in day.get("accounts", [])}
    c = Counter(a.get("status") for a in accs.values())
    b = Counter(a.get("bonus") for a in accs.values() if a.get("status") == "ok")
    skipped = ",".join(str(int(k)) for k, a in sorted(state["accounts"].items(), key=lambda kv: int(kv[0]))
                       if a.get("deprecated") or int(k) in HARD_SKIP)
    head = {"ok": "**全部到账**", "pending": "**有号未到账**", "error": "**有异常（需人工看）**"}[summary["status"]]

    def line(n, a):
        # 余额用最终写入 state 的总额（与 class_changes 一并进日报）
        st = state["accounts"].get(str(n), {})
        bal = st.get("balance") if st.get("balance") is not None else a.get("balance")
        bal_s = str(bal) if bal is not None else f"未解析（顶栏 {a.get('topbar_lightning')}）"
        s = f"- {L(n)} | +{a.get('bonus')} @ {a.get('claimed_time')} | 余额 {bal_s} | {a.get('plan')}"
        if a.get("renewal"):
            s += f" | 续费 {a['renewal']}"
        return s

    out = [f"## Lovart 每日登录积分检查报告 {day['date']}", ""]
    out.append(f"- 检查时段：{day.get('started')} → {day.get('finished')}（Asia/Shanghai）；本轮第 {day.get('attempt')} 次（{mode}）" + ("，当天最后一轮" if summary["final"] else ""))
    out.append(f"- 活跃账号：{len(active)}（跳过弃用 {skipped}）")
    out.append(f"- 结果：{head} — +100×{b.get(100, 0)}，+70×{b.get(70, 0)}，未到账×{c.get('miss', 0)}，阻塞×{c.get('blocked', 0)}，需OTP×{c.get('needs_otp', 0)}")
    cc = "；".join(f"{x['account']} {x['from']}→{x['to']}（{x['reason']}）" for x in summary["class_changes"]) or "无"
    out.append(f"- 类别变更：{cc}；新弃用：{'、'.join(summary['new_deprecated']) or '无'}")
    out.append("- 方法：自动任务 /workspace/lovart-auto/run.sh（CDP，Fork-2，lovart-auto/check-one.cjs，日期自动取上海时间），不经模型")
    out.append("")
    groups = [("+100（充值）", lambda a: a.get("status") == "ok" and a.get("bonus") == 100 and a.get("class_after") == "充值"),
              ("+100（特殊）", lambda a: a.get("status") == "ok" and a.get("bonus") == 100 and a.get("class_after") == "特殊"),
              ("免费（+70/+30）", lambda a: a.get("status") == "ok" and a.get("bonus") in (30, 70)),
              ("其他到账额", lambda a: a.get("status") == "ok" and a.get("bonus") not in (30, 70, 100))]
    for title, f in groups:
        rows = [line(n, a) for n, a in sorted(accs.items()) if f(a)]
        if rows or title in ("+100（充值）", "免费（+70/+30）"):
            out.append(f"### {title}")
            out.extend(rows or ["- 无"])
            out.append("")
    out.append("### 未到账 / 待重查")
    rows = []
    for n, a in sorted(accs.items()):
        if a.get("status") == "miss":
            cm = state["accounts"][str(n)].get("consecutive_miss_days")
            tag = "今日未到账" if summary["final"] else "待重查"
            rows.append(f"- {L(n)} | {tag} | 已查 {a.get('attempt')} 次 | 最近一次到账 {a.get('last_bonus') or '未知'} | 余额 {a.get('balance')} | 连续未到账 {cm} 天")
    out.extend(rows or ["- 无"])
    out.append("")
    out.append("### 连接异常 / 需登录 / 账号错配")
    rows = []
    for n, a in sorted(accs.items()):
        if a.get("status") in ("blocked", "needs_otp", "email_mismatch"):
            rows.append(f"- {L(n)} | {a.get('status')} | {scrub(a.get('note'))[:200]}")
    out.extend(rows or ["- 无"])
    out.append("")
    out.append("### 新弃用")
    out.extend([f"- {x}" for x in summary["new_deprecated"]] or ["- 无"])
    out.append("")
    notes = []
    for n, a in sorted(accs.items()):
        if a.get("status") == "ok" and a.get("balance") is None:
            notes.append(f"- {L(n)} 用量页余额未解析，顶栏 {a.get('topbar_lightning')}；不影响到账判断。")
        if a.get("switched_to_classic"):
            notes.append(f"- {L(n)} 页面是新版，检查时切回了经典版。")
    if notes:
        out.append("### 备注")
        out.extend(notes)
        out.append("")
    out.append("### 日报")
    out.append(summary["message_zh"])
    out.append("")
    with open(path, "w") as f:
        f.write(scrub("\n".join(out)))


def append_log(path, day, summary, ran, files, mode):
    accs = day.get("accounts", [])
    c = Counter(a.get("status") for a in accs)
    p100 = [a["profile"] for a in accs if a.get("status") == "ok" and a.get("bonus") == 100]
    p70 = [a for a in accs if a.get("status") == "ok" and a.get("bonus") == 70]
    cc = ", ".join(f"P{x['profile']} {x['from']}→{x['to']}" for x in day.get("class_changes", [])) or "none"
    nd = ", ".join(f"P{n}" for n in day.get("new_deprecated", [])) or "none"
    lines = [
        "",
        f"## {day['date']} attempt{day['attempt']} (finished {day.get('finished')})",
        f"- +100×{len(p100)} ({','.join('P%d' % n for n in sorted(p100))}) | +70×{len(p70)} | miss×{c.get('miss', 0)} | blocked×{c.get('blocked', 0)} | needs_otp×{c.get('needs_otp', 0)}" + (f" | email_mismatch×{c['email_mismatch']}" if c.get("email_mismatch") else ""),
        f"- class_changes: {cc}",
        f"- new_deprecated: {nd}",
        f"- checked this run: {','.join('P%d' % n for n in sorted(ran)) or 'none'} | pending_today.profiles: {day.get('pending_retry')}",
        f"- summary status: {summary['status']}{' (final)' if summary['final'] else ''}",
        "- report_sent: false (auto, no model; message_zh in summary)",
        f"- source: lovart-auto/run.sh {mode} (programmatic, no model)",
        f"- results: {files['results']}",
        f"- attempt: {files['attempt']}",
        f"- zh: {files['zh']}",
        f"- summary: {files['summary']}",
    ]
    if summary["errors"]:
        lines.append("- errors: " + " ; ".join(summary["errors"]))
    with open(path, "a") as f:
        f.write(scrub("\n".join(lines)) + "\n")


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["first", "recheck"])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--out-dir")
    ap.add_argument("--state-src", default=STATE)
    ap.add_argument("--profiles")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--today")
    a = ap.parse_args()
    if a.today and not a.dry_run:
        ap.error("--today only allowed with --dry-run")
    if a.force and not a.dry_run and not a.profiles:
        ap.error("--force without --profiles only allowed with --dry-run（指定 --profiles 时可实跑重扫）")

    t0 = now()
    today = a.today or t0.strftime("%Y-%m-%d")

    if a.dry_run:
        out = a.out_dir or f"/tmp/lovart-auto-dryrun-{t0.strftime('%Y%m%d-%H%M%S')}"
        os.makedirs(out, exist_ok=True)
        state_path = os.path.join(out, "lovart-daily-credits-state.json")
        if not os.path.exists(state_path):
            shutil.copy2(a.state_src, state_path)
        log_path = os.path.join(out, "lovart-daily-credits-log.md")
        if not os.path.exists(log_path):
            shutil.copy2(LOGMD, log_path)
        base, sum_dir = out, out
    else:
        state_path, log_path, base, sum_dir = STATE, LOGMD, WS, AUTO

    files = {
        "state": state_path,
        "log": log_path,
        "results": f"{base}/lovart-daily-credits-results-{today}.json",
        "report_json": f"{base}/lovart-daily-credits-report-{today}.json",
        "zh": f"{base}/lovart-daily-credits-report-{today}-zh.md",
        "summary": f"{sum_dir}/summary-{today}.json",
    }

    state = json.load(open(state_path))
    pt = state.get("pending_today") or {}
    same_day = pt.get("date") == today and int(pt.get("attempt_done") or 0) >= 1
    active = sorted(int(k) for k, x in state["accounts"].items()
                    if not x.get("deprecated") and x.get("class") != "弃用" and int(k) not in HARD_SKIP)

    force_profiles_only = bool(a.force and a.profiles and not a.dry_run)

    if same_day and not pt.get("profiles") and not a.force:
        log(f"{today}: 当天已全部有结论（attempt_done={pt.get('attempt_done')}，pending 为空），直接退出")
        if not os.path.exists(files["summary"]) and os.path.exists(files["results"]):
            day = json.load(open(files["results"]))
            s = build_summary(day, today, int(pt.get("attempt_done") or 1), True, "already-done", state, [], files, [])
            jdump(s, files["summary"])
            log("补写 summary:", files["summary"])
        print(json.dumps({"exit": "already_done", "date": today, "summary": files["summary"]}, ensure_ascii=False))
        return 0

    if same_day and (not a.force or force_profiles_only):
        # 指定号强制重扫：合并进当天 results，不重置 attempt=1 以免抹掉其它号
        attempt = int(pt.get("attempt_done") or 1) + (1 if force_profiles_only or pt.get("profiles") else 0)
        if force_profiles_only and not pt.get("profiles"):
            attempt = int(pt.get("attempt_done") or 1) + 1
        targets = [n for n in pt.get("profiles", []) if n in active]
        effective_mode = "recheck"
        if force_profiles_only:
            log(f"force+profiles：合并重扫指定号（不重置全天 first）")
    else:
        attempt = 1
        targets = list(active)
        effective_mode = "first"
        if a.mode == "recheck":
            log("今天还没有第一轮记录 → 按第一轮查全部在用号")
    if a.profiles:
        only = {int(x) for x in a.profiles.split(",") if x.strip()}
        targets = [n for n in (active if (a.force or force_profiles_only) else targets) if n in only]
    fh = os.environ.get("LOVART_AUTO_FAKE_HOUR") if a.dry_run else None  # test hook, dry-run only
    final = is_final(attempt, t0.replace(hour=int(fh)) if fh else t0)
    files["attempt"] = f"{base}/lovart-daily-credits-attempt{attempt}-{today}.json"
    files["attempt_md"] = f"{base}/lovart-daily-credits-attempt{attempt}-{today}.md"
    log(f"date={today} mode={a.mode}→{effective_mode} attempt={attempt} final={final} targets={targets} dry_run={a.dry_run}")

    # backups of formal files before touching anything
    if not a.dry_run:
        os.makedirs(BACKUP_DIR, exist_ok=True)
        stamp = t0.strftime("%Y%m%d-%H%M%S")
        for src in (STATE, LOGMD, files["results"], files["zh"]):
            if os.path.exists(src):
                shutil.copy2(src, os.path.join(BACKUP_DIR, f"{os.path.basename(src)}.bak-{stamp}"))

    # day-level results (merged across attempts)
    if effective_mode == "recheck" and os.path.exists(files["results"]):
        day = json.load(open(files["results"]))
    else:
        day = {"date": today, "attempt": attempt, "started": iso(t0),
               "method": "cdp-puppeteer + classic-UI switch (lovart-auto/check-one.cjs) via Fork-2 / lovart-auto/switch-profile.sh; lovart-auto/run.sh (no model)",
               "note": "programmatic run (lovart-auto)", "accounts": [], "pending_retry": [], "class_changes": [],
               "new_deprecated": []}
    day.setdefault("class_changes", [])
    day.setdefault("new_deprecated", [])
    attempt_doc = {"date": today, "attempt": attempt, "started": iso(t0), "method": day.get("method"),
                   "note": f"lovart-auto {effective_mode}", "accounts": [], "pending_retry": [], "class_changes": []}
    day["attempt"] = attempt
    day[f"attempt{attempt}_started"] = iso(t0)

    errors = []
    ran = []
    for n in targets:
        acc = state["accounts"][str(n)]
        email = acc.get("email") or ""
        prior = acc.get("class")
        # chrome_profile: L 编号与 Chrome Profile 目录可分离（如 L15→Profile 24）
        chrome_n = int(acc.get("chrome_profile") or n)
        try:
            fake = os.environ.get("LOVART_AUTO_FAKE") if a.dry_run else None  # test hook, dry-run only
            raw = dict(json.load(open(fake)).get(str(n)) or empty_raw("fake: no entry")) if fake else check_profile(chrome_n, email, today)
        except Exception as e:
            raw = empty_raw(f"runner exception: {e}")
        rec = make_rec(n, email, prior, raw, attempt, iso(), note_special=acc.get("note_special"))
        ran.append(n)
        if chrome_n != n:
            log(f"L{n} → Chrome Profile {chrome_n}")
        log(f"P{n} status={rec['status']} bonus={rec['bonus']} time={rec['claimed_time']} bal={rec['balance']} plan={rec['plan']} class {rec['class_before']}→{rec['class_after']} | {rec['note'][:160]}")
        attempt_doc["accounts"].append(rec)
        day["accounts"] = [x for x in day["accounts"] if x.get("profile") != n] + [rec]
        with open(files["attempt_md"], "a") as f:
            f.write(f"- P{n} | bonus={rec['bonus']} | time={rec['claimed_time']} | bal={rec['balance']} | plan={rec['plan']} | status={rec['status']} | class {rec['class_before']}→{rec['class_after']} | {rec['note']}\n")

        # ---- update state account
        h = {"date": today, "bonus": rec["bonus"], "attempt": attempt, "note": rec["note"],
             "balance": rec.get("total_balance") if rec.get("total_balance") is not None else rec["balance"],
             "today_remaining": rec.get("today_remaining"),
             "total_balance": rec.get("total_balance"),
             "status": rec["status"], "claimed_time": rec["claimed_time"], "plan": rec["plan"],
             "renewal": rec["renewal"], "topbar_lightning": rec["topbar_lightning"]}
        if rec["status"] != "ok":
            h["last_bonus"] = rec["last_bonus"]
        if rec["status"] == "blocked":
            h["block_reason"] = rec["block_reason"]
        acc.setdefault("history", []).append(h)
        if rec["status"] == "ok":
            acc["consecutive_miss_days"] = 0
            # 2026-10-30：按真实可用总额写入；禁止硬保留旧高余额 / 拒绝降级
            # 只写可靠 total_balance，禁止用本日额度覆盖 state.balance
            new_tot = rec.get("total_balance")
            if new_tot is not None:
                acc["balance"] = new_tot
                # 同步 rec，供日报/summary 用最终写入 state 的总额
                rec["balance"] = new_tot
            else:
                # 无可靠总额：若旧 balance 等于本轮毒顶栏（续费日误读），清掉污染
                tb = rec.get("topbar_lightning")
                today_rem = rec.get("today_remaining")
                if (
                    isinstance(acc.get("balance"), (int, float))
                    and isinstance(tb, (int, float))
                    and acc.get("balance") == tb
                    and not _topbar_looks_real_total(tb, today_rem)
                ):
                    acc["balance"] = None
                    rec["balance"] = None
                    rec["note"] = (rec.get("note") or "") + "; cleared_contaminated_balance"
            if rec.get("today_remaining") is not None:
                acc["today_remaining"] = rec["today_remaining"]
            if rec["class_after"] != prior:
                acc["class"] = rec["class_after"]
                tot = rec.get("total_balance")
                reason = f"+{rec['bonus']}" + (f" total={tot}" if tot is not None else "")
                # 特殊→充值：清空 note_special，原备注写入 note 留痕
                if prior == "特殊" and rec["class_after"] == "充值":
                    old_ns = acc.get("note_special")
                    if old_ns:
                        trail = f"降级清空 note_special（原：{old_ns}）"
                        acc["note"] = ((acc.get("note") or "").rstrip() + ("；" if acc.get("note") else "") + trail)
                        rec["note"] = (rec.get("note") or "") + f" | {trail}"
                    acc["note_special"] = None
                ch = {"profile": n, "from": prior, "to": rec["class_after"], "reason": reason}
                day["class_changes"] = [c for c in day["class_changes"] if c.get("profile") != n] + [ch]
                attempt_doc["class_changes"].append(ch)
            else:
                # 分类未变：清掉当日残留的错误 class_changes
                day["class_changes"] = [c for c in day["class_changes"] if c.get("profile") != n]

    # ---- day conclusions
    day["accounts"].sort(key=lambda x: x["profile"])
    if final:
        for rec in day["accounts"]:
            if rec.get("status") == "miss" and rec.get("attempt") == attempt and rec["profile"] in ran:
                acc = state["accounts"][str(rec["profile"])]
                acc["consecutive_miss_days"] = int(acc.get("consecutive_miss_days") or 0) + 1
                acc["history"][-1]["note"] += f"; 今日未到账 (attempt {attempt}, consecutive {acc['consecutive_miss_days']})"
                if acc["consecutive_miss_days"] >= 3:
                    acc["deprecated"] = True
                    acc["class"] = "弃用"
                    acc["skip_reason"] = f"{acc['consecutive_miss_days']} consecutive miss days (auto, {today})"
                    if rec["profile"] not in day["new_deprecated"]:
                        day["new_deprecated"].append(rec["profile"])
    # 非最后一轮：未到账 + 各类异常都进下一轮；最后一轮之后只留异常号（手动 run.sh recheck 可再查）
    retry_status = ("miss", "blocked", "needs_otp", "email_mismatch") if not final else ("blocked", "needs_otp", "email_mismatch")
    day["pending_retry"] = [x["profile"] for x in day["accounts"] if x.get("status") in ("miss", "blocked")]
    pending_profiles = [x["profile"] for x in day["accounts"] if x.get("status") in retry_status]
    t1 = now()
    day["finished"] = iso(t1)
    day[f"attempt{attempt}_finished"] = iso(t1)
    attempt_doc["finished"] = iso(t1)
    attempt_doc["pending_retry"] = [x["profile"] for x in attempt_doc["accounts"] if x.get("status") in ("miss", "blocked")]

    snap_path = None
    if ran and not a.dry_run:
        try:
            snap_path = write_balance_snapshot(today, state, day.get("accounts") or [], ran)
        except Exception as e:
            log(f"balance snapshot failed: {e}")
    summary = build_summary(day, today, attempt, final, effective_mode, state, errors, files, ran)
    if snap_path:
        summary["balance_snapshot"] = snap_path

    # ---- state.pending_today
    newpt = dict(pt) if (same_day and pt.get("date") == today) else {}
    newpt.update({
        "date": today,
        "attempt_done": attempt,
        "profiles": pending_profiles,
        "report_sent": False,
        "class_changes_so_far": day["class_changes"],
        "new_deprecated": day["new_deprecated"],
        f"attempt{attempt}_started": iso(t0),
        f"attempt{attempt}_finished": iso(t1),
        "final": final,
        "summary_status": summary["status"],
        "summary": files["summary"],
        "note": f"lovart-auto/run.sh {effective_mode}（程序化，不经模型）; status={summary['status']}",
    })
    state["pending_today"] = newpt
    state["last_run"] = today

    # ---- write everything
    jdump(attempt_doc, files["attempt"])
    jdump(day, files["results"])
    jdump(day, files["report_json"])
    jdump(state, state_path)
    write_zh_report(files["zh"], day, summary, state, active, effective_mode)
    append_log(log_path, day, summary, ran, files, effective_mode)
    jdump(summary, files["summary"])
    # 2026-10-25：整批结束后关 Chrome，避免最后一个 Profile 挂着占 ~1.5G+
    if not a.dry_run:
        kill_fork2_chrome()
    print(json.dumps({"exit": "done", "status": summary["status"], "summary": files["summary"],
                      "balance_snapshot": summary.get("balance_snapshot"),
                      "message_zh": summary["message_zh"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as e:
        tb = traceback.format_exc()
        log("FATAL", tb)
        today = now().strftime("%Y-%m-%d")
        dry = "--dry-run" in sys.argv
        path = os.environ.get("LOVART_AUTO_ERR_SUMMARY") or (None if dry else f"{AUTO}/summary-{today}.json")
        if path:
            try:
                jdump({"date": today, "generated_at": iso(), "status": "error", "recharge": [], "free": [],
                       "special": [], "pending": [], "not_arrived": [], "connection_errors": [], "login_required": [],
                       "class_changes": [], "new_deprecated": [],
                       "errors": [f"脚本自身出错: {scrub(str(e))}"],
                       "message_zh": "今天的 Lovart 积分检查脚本自己出错了，没有得出结论，需要人工（或模型）接手。"}, path)
            except Exception:
                pass
        sys.exit(2)
