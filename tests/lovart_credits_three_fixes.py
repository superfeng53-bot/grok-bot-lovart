#!/usr/bin/env python3
"""FAKE DATA / 假数据。Lovart 积分三项回归。

覆盖：跨日 recheck 不占新日 first、同日 recheck、新日 first、
单号 force 按账号计次、无 profiles 的 force 实跑闸门、
邮箱数字 / No login / null 不回填、不因异常余额改分类、
合法 API 与页面总额仍入账、顶栏小数与续费日仍被挡住。

不连接真实账号、浏览器、网络或凭据。扫描只用 --dry-run 与假 JSON。
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PY = ROOT / "lovart-auto" / "lovart_auto.py"
NODE_TEST = ROOT / "tests" / "lovart_credits_balance_resolve.cjs"
CASES_PATH = ROOT / "tests" / "fixtures" / "lovart-credits" / "balance-cases.json"
D = "2099-01-15"
D1 = "2099-01-16"

FAILURES = []


def fail(name, detail):
    FAILURES.append(name)
    print(f"FAIL {name}: {detail}", file=sys.stderr)


def ok(name):
    print(f"PASS {name}")


def load_mod():
    spec = importlib.util.spec_from_file_location("lovart_auto_under_test", PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def clean_env(extra=None):
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": tempfile.gettempdir(),
        "TZ": "Asia/Shanghai",
        "LANG": "C.UTF-8",
        "PYTHONHASHSEED": "0",
    }
    if extra:
        env.update(extra)
    return env


def run_auto(args, env, timeout=60):
    return subprocess.run(
        [sys.executable, str(PY), *args],
        cwd=str(ROOT),
        env=env,
        text=True,
        capture_output=True,
        timeout=timeout,
    )


def account(cls, email, balance=None, deprecated=False):
    row = {
        "class": "弃用" if deprecated else cls,
        "email": email,
        "balance": balance,
        "deprecated": deprecated,
        "consecutive_miss_days": 0,
        "history": [],
        "today_remaining": None,
    }
    return row


def counting_state():
    return {
        "_comment": "FAKE DATA / 假数据",
        "accounts": {
            "101": account("充值", "acct101@example.com", 80),
            "102": account("特殊", "acct102@example.com", 250),
            "103": account("免费", "acct103@example.com", 30),
            "104": account("弃用", "acct104@example.com", 0, deprecated=True),
            "105": account("免费", "acct105@example.com", 30),
        },
        "pending_today": {
            "date": D,
            "attempt_done": 1,
            "profiles": [101, 102, 103],
        },
    }


def miss_row(n, cls):
    return {
        "profile": n,
        "status": "miss",
        "attempt": 1,
        "bonus": None,
        "class_before": cls,
        "class_after": cls,
        "balance": None,
        "total_balance": None,
        "today_remaining": 70,
        "note": "fake miss",
        "email": f"acct{n}@example.com",
    }


def counting_results():
    classes = {101: "充值", 102: "特殊", 103: "免费"}
    return {
        "_comment": "FAKE DATA / 假数据",
        "date": D,
        "attempt": 1,
        "started": f"{D}T09:00:00+0800",
        "accounts": [miss_row(n, classes[n]) for n in (101, 102, 103)],
        "pending_retry": [101, 102, 103],
        "class_changes": [],
        "new_deprecated": [],
    }


def counting_fake():
    row = {
        "status": "miss",
        "bonus": None,
        "today_remaining": 70,
        "total_balance": None,
        "balance": None,
        "topbar_lightning": None,
        "usablePower": None,
        "plan": "Starter",
    }
    return {str(n): dict(row) for n in (101, 102, 103, 105)}


def write_json(path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def prepare_counting(out, with_results=True):
    state_path = out / "state-src.json"
    fake_path = out / "fake.json"
    write_json(state_path, counting_state())
    write_json(fake_path, counting_fake())
    if with_results:
        write_json(out / f"lovart-daily-credits-results-{D}.json", counting_results())
    return state_path, fake_path


def load_out_json(out, name):
    path = out / name
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def names_with(out, needle):
    return sorted(p.name for p in out.iterdir() if needle in p.name)


def test_hard_skip(mod):
    name = "hard_skip_empty"
    if mod.HARD_SKIP != set():
        fail(name, f"HARD_SKIP={mod.HARD_SKIP!r}，弃用必须只看 state.deprecated")
    else:
        ok(name)


def test_resolve_units(mod, cases):
    name = "resolve_observed_total_units"
    bad = []
    for c in cases:
        total, reason = mod.resolve_observed_total(c["raw"], c["email"])
        if total != c["expect_total"]:
            bad.append(f"{c['id']} total={total} reason={reason} expect={c['expect_total']}")
    poisoned = {
        "status": "ok",
        "bonus": 100,
        "usablePower": 123456789,
        "total_balance": 123456789,
        "note_balance_source": "api_usablePower",
        "api_account_meta": {"ok": True, "msg": "ok"},
        "today_remaining": 70,
    }
    total, reason = mod.resolve_observed_total(poisoned, "123456789@example.com")
    if total is not None:
        bad.append(f"api email collision kept {total} ({reason})")
    free = mod.make_rec(
        130, "free130@example.com", "充值",
        {"status": "ok", "bonus": 30, "total_balance": None, "api_account_error": "No login"},
        1, "t",
    )
    if free["class_after"] != "免费" or free["total_balance"] is not None:
        bad.append(f"bonus 30 unreliable -> {free['class_after']} total={free['total_balance']}")
    if bad:
        fail(name, "; ".join(bad))
    else:
        ok(name)


def test_snapshot_no_backfill(mod):
    name = "snapshot_null_not_backfilled"
    state = {
        "accounts": {
            "103": {"class": "特殊", "balance": 100, "balance_stale": True, "plan": "Starter"},
            "108": {"class": "充值", "balance": 80, "plan": "Starter"},
        }
    }
    day_accounts = [
        {"profile": 103, "total_balance": None, "today_remaining": 70, "class_after": "特殊", "bonus": 100},
        {"profile": 108, "total_balance": 80, "today_remaining": 80, "class_after": "充值", "bonus": 100},
    ]
    with tempfile.TemporaryDirectory(prefix="lovart-snap-fake-") as td:
        mod.write_balance_snapshot(D, state, day_accounts, [103, 108], snap_dir=td)
        doc = json.loads(Path(td, f"{D}.json").read_text(encoding="utf-8"))
    a103 = doc["accounts"]["103"]
    a108 = doc["accounts"]["108"]
    bad = []
    if a103.get("total_balance") is not None:
        bad.append(f"103 total={a103.get('total_balance')}")
    if a103.get("total_balance_historical") != 100 or a103.get("total_balance_historical_note") != "prior_state_not_this_round":
        bad.append(f"103 historical={a103.get('total_balance_historical')}")
    if a108.get("total_balance") != 80 or a108.get("total_balance_historical") is not None:
        bad.append(f"108 {a108}")
    if bad:
        fail(name, "; ".join(bad))
    else:
        ok(name)


def test_cross_day_and_force():
    with tempfile.TemporaryDirectory(prefix="lovart-count-fake-") as td:
        out = Path(td)
        state_path, fake_path = prepare_counting(out)
        env_base = {
            "LOVART_AUTO_FAKE": str(fake_path),
        }

        def invoke(name, mode, fake_now, extra_args, expect_rc):
            run_out = out / name
            run_out.mkdir()
            # 重查需要当天 results 已在该次输出目录里。
            if mode == "recheck" and "--today" in extra_args:
                today = extra_args[extra_args.index("--today") + 1]
            else:
                today = fake_now[:10]
            src_results = out / f"lovart-daily-credits-results-{D}.json"
            if mode == "recheck" and today == D:
                write_json(run_out / f"lovart-daily-credits-results-{D}.json", counting_results())
            env = clean_env({**env_base, "LOVART_AUTO_FAKE_NOW": fake_now})
            args = [
                mode, "--dry-run",
                "--out-dir", str(run_out),
                "--state-src", str(state_path),
                *extra_args,
            ]
            proc = run_auto(args, env)
            if proc.returncode != expect_rc:
                fail(name, f"exit {proc.returncode} expect {expect_rc}\nstdout={proc.stdout}\nstderr={proc.stderr}")
                return None, proc
            ok(name + f" exit={proc.returncode}")
            return run_out, proc

        refused, proc = invoke(
            "recheck_0002_no_today", "recheck", f"{D1}T00:02:00", [], 4,
        )
        if refused:
            if names_with(refused, D1):
                fail("recheck_0002_no_d1_files", str(names_with(refused, D1)))
            else:
                ok("recheck_0002_no_d1_files")
            copied = load_out_json(refused, "lovart-daily-credits-state.json")
            if not copied or copied.get("pending_today", {}).get("date") != D:
                fail("recheck_0002_pending_unchanged", str(copied.get("pending_today") if copied else None))
            else:
                ok("recheck_0002_pending_unchanged")
            try:
                payload = json.loads(proc.stdout)
            except Exception as e:
                payload = {}
                fail("recheck_0002_json", str(e))
            if payload.get("exit") != "refused_recheck_without_first" or payload.get("date") != D1:
                fail("recheck_0002_payload", proc.stdout)
            else:
                ok("recheck_0002_payload")

        late, proc = invoke(
            "recheck_today_D", "recheck", f"{D1}T00:02:00", ["--today", D], 0,
        )
        if late:
            if names_with(late, D1):
                fail("recheck_today_D_no_d1", str(names_with(late, D1)))
            else:
                ok("recheck_today_D_no_d1")
            results = load_out_json(late, f"lovart-daily-credits-results-{D}.json")
            summary = load_out_json(late, f"summary-{D}.json")
            if not results or results.get("date") != D:
                fail("recheck_today_D_results", "missing")
            else:
                attempts = {a["profile"]: a.get("attempt") for a in results["accounts"]}
                if attempts != {101: 2, 102: 2, 103: 2}:
                    fail("recheck_today_D_attempts", str(attempts))
                elif summary.get("mode") != "recheck":
                    fail("recheck_today_D_mode", str(summary.get("mode")))
                else:
                    ok("recheck_today_D_is_recheck_of_D")

        same, proc = invoke(
            "same_day_recheck", "recheck", f"{D}T10:05:00", [], 0,
        )
        if same:
            results = load_out_json(same, f"lovart-daily-credits-results-{D}.json")
            summary = load_out_json(same, f"summary-{D}.json")
            profiles = sorted(a["profile"] for a in results["accounts"])
            attempts = {a["profile"]: a.get("attempt") for a in results["accounts"]}
            bad = []
            if profiles != [101, 102, 103]:
                bad.append(f"profiles={profiles}")
            if attempts != {101: 2, 102: 2, 103: 2}:
                bad.append(f"attempts={attempts}")
            if summary.get("mode") != "recheck":
                bad.append(f"mode={summary.get('mode')}")
            msg = summary.get("message_zh") or ""
            if "已查 2 次" not in msg:
                bad.append(f"msg={msg}")
            if "L105" in msg or any(a["profile"] == 105 for a in results["accounts"]):
                bad.append("checked account outside pending")
            if bad:
                fail("same_day_recheck_behavior", "; ".join(bad))
            else:
                ok("same_day_recheck_behavior")

        morning, proc = invoke(
            "new_day_first", "first", f"{D1}T09:05:00", [], 0,
        )
        if morning:
            results = load_out_json(morning, f"lovart-daily-credits-results-{D1}.json")
            summary = load_out_json(morning, f"summary-{D1}.json")
            state = load_out_json(morning, "lovart-daily-credits-state.json")
            bad = []
            if not results or results.get("date") != D1:
                bad.append("no D+1 results")
            else:
                profiles = sorted(a["profile"] for a in results["accounts"])
                attempts = {a["profile"]: a.get("attempt") for a in results["accounts"]}
                if profiles != [101, 102, 103, 105]:
                    bad.append(f"profiles={profiles}")
                if attempts != {101: 1, 102: 1, 103: 1, 105: 1}:
                    bad.append(f"attempts={attempts}")
                if 104 in profiles:
                    bad.append("deprecated 104 was scanned")
            if summary.get("mode") != "first":
                bad.append(f"mode={summary.get('mode')}")
            pt = (state or {}).get("pending_today") or {}
            if pt.get("date") != D1 or int(pt.get("attempt_done") or 0) < 1:
                bad.append(f"pending={pt}")
            if bad:
                fail("new_day_first_behavior", "; ".join(bad))
            else:
                ok("new_day_first_behavior")

        late_morning, proc = invoke(
            "recheck_1000_without_first", "recheck", f"{D1}T10:05:00", [], 4,
        )
        if late_morning:
            if names_with(late_morning, f"results-{D1}"):
                fail("recheck_1000_occupied_first", str(names_with(late_morning, D1)))
            else:
                ok("recheck_1000_does_not_occupy_first")

        forced, proc = invoke(
            "force_one", "recheck", f"{D}T10:05:00", ["--force", "--profiles", "101"], 0,
        )
        if forced:
            results = load_out_json(forced, f"lovart-daily-credits-results-{D}.json")
            summary = load_out_json(forced, f"summary-{D}.json")
            zh = (forced / f"lovart-daily-credits-report-{D}-zh.md").read_text(encoding="utf-8")
            attempts = {a["profile"]: a.get("attempt") for a in results["accounts"]}
            msg = summary.get("message_zh") or ""
            bad = []
            if attempts != {101: 2, 102: 1, 103: 1}:
                bad.append(f"attempts={attempts}")
            if summary.get("checked_this_run") != ["L101"]:
                bad.append(f"checked={summary.get('checked_this_run')}")
            if "L101、L102、L103 还没到账（已查 2 次）" in msg:
                bad.append("message treats everyone as attempt 2")
            if "L101 还没到账（已查 2 次）" not in msg or "L102、L103 还没到账（已查 1 次）" not in msg:
                bad.append(f"msg={msg}")
            if "已查 1 次" not in zh or "已查 2 次" not in zh:
                bad.append("zh missing per-account counts")
            if "未查账号不增加次数" not in zh:
                bad.append("zh header still sounds like a full round")
            per = summary.get("attempt_per_account") or {}
            if per.get("L101") != 2 or per.get("L102") != 1 or per.get("L103") != 1:
                bad.append(f"per={per}")
            if bad:
                fail("force_one_per_account", "; ".join(bad))
            else:
                ok("force_one_per_account")


def test_force_gate():
    name = "force_without_profiles_real_run_blocked"
    proc = run_auto(
        ["recheck", "--force", "--today", D],
        clean_env(),
    )
    text = (proc.stderr or "") + (proc.stdout or "")
    if proc.returncode == 2 and "only allowed with --dry-run" in text:
        ok(name)
    else:
        fail(name, f"exit={proc.returncode} text={text[:500]}")


def test_bad_today():
    name = "today_must_be_iso_date"
    with tempfile.TemporaryDirectory(prefix="lovart-today-fake-") as td:
        out = Path(td)
        state_path, _fake = prepare_counting(out, with_results=False)
        proc = run_auto(
            ["first", "--dry-run", "--out-dir", str(out / "x"), "--state-src", str(state_path), "--today", "15/01/2099"],
            clean_env(),
        )
    if proc.returncode == 2 and "YYYY-MM-DD" in (proc.stderr or ""):
        ok(name)
    else:
        fail(name, f"exit={proc.returncode} stderr={proc.stderr}")


def test_balance_integration(cases):
    name = "balance_integration"
    raw = {}
    state_accounts = {}
    for c in cases:
        raw[str(c["profile"])] = c["raw"]
        state_accounts[str(c["profile"])] = account(c["prior_class"], c["email"], c["state_balance"])
    state = {
        "_comment": "FAKE DATA / 假数据",
        "accounts": state_accounts,
        "pending_today": {"date": "2099-01-14", "attempt_done": 1, "profiles": []},
    }
    with tempfile.TemporaryDirectory(prefix="lovart-balance-fake-") as td:
        out = Path(td)
        state_path = out / "state-src.json"
        fake_path = out / "fake.json"
        run_out = out / "run"
        write_json(state_path, state)
        write_json(fake_path, raw)
        proc = run_auto(
            ["first", "--dry-run", "--out-dir", str(run_out), "--state-src", str(state_path), "--today", D],
            clean_env({
                "LOVART_AUTO_FAKE": str(fake_path),
                "LOVART_AUTO_FAKE_NOW": f"{D}T09:05:00",
            }),
        )
        if proc.returncode != 0:
            fail(name, f"exit={proc.returncode}\nstdout={proc.stdout}\nstderr={proc.stderr}")
            return
        results = load_out_json(run_out, f"lovart-daily-credits-results-{D}.json")
        summary = load_out_json(run_out, f"summary-{D}.json")
        saved = load_out_json(run_out, "lovart-daily-credits-state.json")
        zh = (run_out / f"lovart-daily-credits-report-{D}-zh.md").read_text(encoding="utf-8")
    by_p = {a["profile"]: a for a in results["accounts"]}
    sum_by = {a["account"]: a for a in summary["accounts"]}
    changed = {c["account"] for c in summary.get("class_changes") or []}
    bad = []
    if changed != {"L109"}:
        bad.append(f"class_changes={summary.get('class_changes')}")
    for c in cases:
        n = c["profile"]
        rec = by_p.get(n)
        if rec is None:
            bad.append(f"missing {n}")
            continue
        if rec.get("total_balance") != c["expect_total"] or rec.get("balance") != c["expect_total"]:
            bad.append(f"L{n} total={rec.get('total_balance')} balance={rec.get('balance')} expect={c['expect_total']}")
        if rec.get("class_after") != c["expect_class"]:
            bad.append(f"L{n} class {rec.get('class_before')}->{rec.get('class_after')} expect {c['expect_class']}")
        summ = sum_by.get(f"L{n}") or {}
        if summ.get("balance") != c["expect_total"] or bool(summ.get("balance_is_new_observation")) != (c["expect_total"] is not None):
            bad.append(f"L{n} summary balance={summ.get('balance')} new={summ.get('balance_is_new_observation')}")
        if "expect_historical" in c:
            if summ.get("balance_historical") != c["expect_historical"]:
                bad.append(f"L{n} historical={summ.get('balance_historical')}")
            st = saved["accounts"][str(n)]
            if st.get("balance") != c["expect_historical"] or st.get("balance_stale") is not True:
                bad.append(f"L{n} state balance={st.get('balance')} stale={st.get('balance_stale')}")
            if f"历史值 {c['expect_historical']}" not in zh:
                bad.append(f"L{n} zh missing historical label")
        if "expect_state_balance" in c:
            st = saved["accounts"][str(n)]
            if st.get("balance") != c["expect_state_balance"]:
                bad.append(f"L{n} state balance={st.get('balance')} expect {c['expect_state_balance']}")
        if c["expect_total"] is None and c["id"].startswith("email_local"):
            if rec.get("topbar_lightning") is not None:
                bad.append(f"L{n} topbar still {rec.get('topbar_lightning')}")
    if "123456789" in zh or "987654321" in zh or "123456789" in (summary.get("message_zh") or ""):
        bad.append("report shows email-local digits as a balance")
    reason_109 = [c for c in summary.get("class_changes") or [] if c.get("account") == "L109"]
    if not reason_109 or "total=80" not in (reason_109[0].get("reason") or ""):
        bad.append(f"legitimate api reclass reason={reason_109}")
    if bad:
        fail(name, "; ".join(bad))
    else:
        ok(name)


def test_node():
    name = "node_checker_balance"
    proc = subprocess.run(
        ["node", str(NODE_TEST)],
        cwd=str(ROOT),
        env=clean_env(),
        text=True,
        capture_output=True,
        timeout=30,
    )
    sys.stdout.write(proc.stdout)
    if proc.returncode != 0:
        fail(name, f"exit={proc.returncode}\n{proc.stderr}")
    else:
        ok(name)


def main():
    cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))["cases"]
    mod = load_mod()
    test_hard_skip(mod)
    test_resolve_units(mod, cases)
    test_snapshot_no_backfill(mod)
    test_cross_day_and_force()
    test_force_gate()
    test_bad_today()
    test_balance_integration(cases)
    test_node()
    if FAILURES:
        print(f"FAILED {len(FAILURES)}: {', '.join(FAILURES)}", file=sys.stderr)
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
