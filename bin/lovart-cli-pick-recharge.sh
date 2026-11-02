#!/usr/bin/env bash
# Pick recharge account for CLI Seedance or canvas Wan.
# Usage: lovart-cli-pick-recharge.sh [cli|canvas]   (default cli)
# 「当天」= Asia/Shanghai 08:00 → next 08:00（跟日领对齐，不是日历 0 点）
# 2026-11-01：取消「当天出一次」。CLI: only skip Insufficient；prefer bal<100 then smaller. Canvas: only bal gate.
# 2026-11-01: NO day-once skip. Canvas: only bal >= duration*4+2.
set -euo pipefail
MODE="${1:-cli}"
DUR="${2:-}"
case "$MODE" in
  cli) ;;
  canvas)
    if [ -z "$DUR" ] || ! [[ "$DUR" =~ ^[0-9]+$ ]]; then
      echo "usage: $0 canvas <duration_seconds>   e.g. $0 canvas 12" >&2
      exit 2
    fi
    ;;
  *) echo "usage: $0 [cli|canvas [duration]]" >&2; exit 2 ;;
esac

CREDIT_DAY=$(TZ=Asia/Shanghai date +%F)
HOUR=$(TZ=Asia/Shanghai date +%H)
if [ "$HOUR" -lt 8 ]; then
  CREDIT_DAY=$(TZ=Asia/Shanghai date -d 'yesterday' +%F)
fi

credit_day_of() {
  # $1 = epoch seconds → credit day YYYY-MM-DD
  local ep="$1"
  local d h
  d=$(TZ=Asia/Shanghai date -d "@$ep" +%F)
  h=$(TZ=Asia/Shanghai date -d "@$ep" +%H)
  if [ "$h" -lt 8 ]; then
    TZ=Asia/Shanghai date -d "$d -1 day" +%F
  else
    echo "$d"
  fi
}

USED_CLI=$(
  find /workspace/项目 -path '*/04-生成/母片*chat*.log' -o -path '*/04-生成/*seedance*chat*.log' 2>/dev/null \
    | while read -r f; do
        mt_epoch=$(stat -c %Y "$f" 2>/dev/null || true)
        [ -n "$mt_epoch" ] || continue
        [ "$(credit_day_of "$mt_epoch")" = "$CREDIT_DAY" ] || continue
        if grep -qE 'generation_succeeded[=:] ?true|"generation_succeeded": true' "$f" 2>/dev/null; then
          bn=$(basename "$f")
          if [[ "$bn" =~ acc([0-9]+) ]]; then echo "acc${BASH_REMATCH[1]}"; fi
          grep -oE '"id": "acc[0-9]+"' "$f" 2>/dev/null | head -1 | grep -oE 'acc[0-9]+' || true
        fi
      done | sort -u | tr '\n' ' '
)

# Insufficient this credit day → skip for CLI (platform unusable)
INSUFF=$(
  find /workspace/项目 -path '*/04-生成/母片*chat*.log' 2>/dev/null \
    | while read -r f; do
        mt_epoch=$(stat -c %Y "$f" 2>/dev/null || true)
        [ -n "$mt_epoch" ] || continue
        [ "$(credit_day_of "$mt_epoch")" = "$CREDIT_DAY" ] || continue
        if grep -qiE 'Insufficient|don.t have enough Lovart credits' "$f" 2>/dev/null; then
          bn=$(basename "$f")
          if [[ "$bn" =~ acc([0-9]+) ]]; then echo "acc${BASH_REMATCH[1]}"; fi
        fi
      done | sort -u | tr '\n' ' '
)

# Canvas used: 项目卡变更行里同 credit_day 出现 L编号 + 画布/Wan
USED_CANVAS=$(
  find /workspace/项目 -name '00-项目卡.md' -o -name '项目卡-历史.md' 2>/dev/null \
    | while read -r f; do
        # lines containing CREDIT_DAY date and 画布|Wan|wan
        grep -E "$CREDIT_DAY" "$f" 2>/dev/null | grep -iE '画布|Wan|wan30|wan3' || true
      done \
    | { grep -oE 'L[0-9]+|acc[0-9]+' || true; } \
    | sed 's/^L/acc/' \
    | sort -u | tr '\n' ' '
)

python3 - "$MODE" "$CREDIT_DAY" "$USED_CLI" "$INSUFF" "$USED_CANVAS" "${DUR:-0}" <<'PY'
import json,sys
mode, credit_day = sys.argv[1], sys.argv[2]
used_cli=set(x for x in sys.argv[3].split() if x)
insuff=set(x for x in sys.argv[4].split() if x)
used_canvas=set(x for x in sys.argv[5].split() if x)
dur=int(sys.argv[6] or 0)

cli=json.load(open('/workspace/lovart-cli/.agents/skills/lovart-旧房换新/data/accounts.json'))
email_to_acc={a['email']:a['id'] for a in cli['accounts']}
st=json.load(open('/workspace/lovart-daily-credits-state.json'))
accs=st['accounts']
items=list(accs.values()) if isinstance(accs,dict) else list(accs)

# 2026-11-01: cancel day-once — do not skip used_cli / used_canvas
if mode=='cli':
  skip=set(insuff)
else:
  skip=set()

cands=[]
for a in items:
  if not isinstance(a,dict): continue
  if a.get('class')!='充值': continue
  em=a.get('email') or ''
  acc=email_to_acc.get(em)
  if not acc: continue
  bal=a.get('total_balance')
  if bal is None: bal=a.get('balance')
  if bal is None: bal=a.get('today_remaining')
  try: bal=float(bal)
  except: continue
  if bal<=0: continue
  if acc in skip: continue
  if mode=='canvas':
    need = dur * 4 + 2
    if bal < need: continue
  tier=0 if bal<100 else 1
  cands.append((tier, bal, acc, em))
cands.sort()
if not cands:
  need = (dur * 4 + 2) if mode=='canvas' else 0
  print('NONE', '', f'no_candidate mode={mode} credit_day={credit_day} need={need} used_cli={",".join(sorted(used_cli)) or "-"} used_canvas={",".join(sorted(used_canvas)) or "-"} insuff={",".join(sorted(insuff)) or "-"}')
  raise SystemExit(3)
extra = f' need={dur*4+2}' if mode=='canvas' else ''
print(cands[0][2], cands[0][3], f'picked mode={mode} tier={cands[0][0]} bal={cands[0][1]}{extra} credit_day={credit_day} skipped={",".join(sorted(skip)) or "-"} alt='+','.join(f'{c[2]}:{c[1]}' for c in cands[1:3]))
PY
