#!/usr/bin/env bash
# Lovart 画布 Wan 纯请求流水线外壳（省 Token）。
# 默认 --dry-run：串到 upload-body 生成 create-body.json，**绝不**调用 create。
# 正式计费 create 仍只走 lovart-wan-create-once.cjs（须显式 --no-dry-run 且另一步）。
#
# Usage:
#   lovart-wan-pure-master.sh \
#     --prompt PATH.md --staging DIR --project ID \
#     [--profile N] [--duration N] [--intent NAME] \
#     [--token-file PATH] [--out-body PATH] \
#     [--dry-run|--no-dry-run] [--skip-ensure] [--skip-pick] [--reuse-urls]
#
# Exit: 透传子脚本；本层 2=usage；6=拒绝非 dry 且未显式放行 create 链
set -euo pipefail
BIN="$(cd "$(dirname "$0")" && pwd)"
PATH_BIN="/home/box/bin:$BIN:${PATH:-}"

PROMPT=""
STAGING=""
PROJECT=""
PROFILE=""
DURATION=""
INTENT=""
TOKEN_FILE=""
OUT_BODY=""
DRY=1
SKIP_ENSURE=0
SKIP_PICK=0
SKIP_TOKEN=0
REUSE_URLS=0
ALLOW_CREATE=0

usage() {
  cat <<'U'
lovart-wan-pure-master.sh — pure-request pipeline shell (default --dry-run, NO create)
  --prompt PATH.md --staging DIR --project ID
  --profile N          Chrome profile (for extract-token / pick note)
  --duration N
  --intent NAME
  --token-file PATH
  --out-body PATH
  --dry-run            default ON: prep(+optional pick/token/sign) → upload-body --dry-run/--reuse-urls
  --no-dry-run         real upload+pricing; STILL does not create unless --allow-create-once
  --allow-create-once  after body ready, call lovart-wan-create-once.cjs (BILLABLE) — require --no-dry-run
  --skip-ensure --skip-pick --skip-token --reuse-urls
U
}

while [ $# -gt 0 ]; do
  case "$1" in
    --prompt) PROMPT="${2:-}"; shift 2 ;;
    --staging) STAGING="${2:-}"; shift 2 ;;
    --project) PROJECT="${2:-}"; shift 2 ;;
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --duration) DURATION="${2:-}"; shift 2 ;;
    --intent) INTENT="${2:-}"; shift 2 ;;
    --token-file) TOKEN_FILE="${2:-}"; shift 2 ;;
    --out-body) OUT_BODY="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --no-dry-run) DRY=0; shift ;;
    --allow-create-once) ALLOW_CREATE=1; shift ;;
    --skip-ensure) SKIP_ENSURE=1; shift ;;
    --skip-pick) SKIP_PICK=1; shift ;;
    --skip-token) SKIP_TOKEN=1; shift ;;
    --reuse-urls) REUSE_URLS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown $1" >&2; usage; exit 2 ;;
  esac
done

if [ -z "$PROMPT" ] || [ -z "$STAGING" ] || [ -z "$PROJECT" ]; then
  usage; exit 2
fi
if [ "$ALLOW_CREATE" -eq 1 ] && [ "$DRY" -eq 1 ]; then
  echo "REFUSE: --allow-create-once requires --no-dry-run" >&2
  exit 6
fi

echo "[pure-master] dry=$DRY staging=$STAGING project=$PROJECT" >&2

if [ "$SKIP_ENSURE" -eq 0 ]; then
  if [ -x /home/box/bin/lovart-anti-cookie-ensure.sh ]; then
    /home/box/bin/lovart-anti-cookie-ensure.sh || true
  fi
fi

PREP_ARGS=(--prompt "$PROMPT" --staging "$STAGING" --force)
if [ -n "$DURATION" ]; then PREP_ARGS+=(--duration "$DURATION"); fi
if [ -n "$INTENT" ]; then PREP_ARGS+=(--slug "$INTENT"); fi
node "$BIN/lovart-wan-prep-staging.cjs" "${PREP_ARGS[@]}"

DUR_EFF="$DURATION"
if [ -z "$DUR_EFF" ] && [ -f "$STAGING/staging-manifest.json" ]; then
  DUR_EFF=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).duration||'')" "$STAGING/staging-manifest.json")
fi

if [ "$SKIP_PICK" -eq 0 ] && [ -n "$DUR_EFF" ]; then
  if [ -x "$BIN/lovart-cli-pick-recharge.sh" ]; then
    echo "[pure-master] pick canvas $DUR_EFF" >&2
    "$BIN/lovart-cli-pick-recharge.sh" canvas "$DUR_EFF" || {
      ec=$?
      echo "[pure-master] pick exit $ec (3=无号/门闩)" >&2
      # dry-run 继续用已有 token 做 body 形状；非 dry 则失败
      if [ "$DRY" -eq 0 ]; then exit "$ec"; fi
    }
  fi
fi

if [ "$SKIP_TOKEN" -eq 0 ] && [ -z "$TOKEN_FILE" ] && [ -n "$PROFILE" ] && [ "$DRY" -eq 0 ]; then
  TOKEN_FILE="/tmp/l${PROFILE}-usertoken.txt"
  node "$BIN/lovart-wan-extract-token.cjs" --profile "$PROFILE" --out "$TOKEN_FILE"
fi

# sign self-check always cheap
SIG_OUT="${STAGING}/sig-headers.json"
node "$BIN/lovart-wan-sign-headers.cjs" --out "$SIG_OUT" --self-test

UPLOAD_ARGS=(--staging "$STAGING" --project "$PROJECT")
if [ -n "$DUR_EFF" ]; then UPLOAD_ARGS+=(--duration "$DUR_EFF"); fi
if [ -n "$TOKEN_FILE" ]; then UPLOAD_ARGS+=(--token-file "$TOKEN_FILE"); fi
if [ -n "$OUT_BODY" ]; then UPLOAD_ARGS+=(--out-body "$OUT_BODY"); fi
if [ "$DRY" -eq 1 ]; then
  UPLOAD_ARGS+=(--dry-run --skip-pricing)
  if [ "$REUSE_URLS" -eq 1 ]; then UPLOAD_ARGS+=(--reuse-urls); fi
else
  if [ "$REUSE_URLS" -eq 1 ]; then UPLOAD_ARGS+=(--reuse-urls); fi
fi

node "$BIN/lovart-wan-upload-and-body.cjs" "${UPLOAD_ARGS[@]}"

BODY="${OUT_BODY:-$STAGING/create-body.json}"
node "$BIN/lovart-wan-write-gate-result.cjs" --staging "$STAGING" \
  --set "intent=${INTENT:-pure-master}" \
  --set "project_id=$PROJECT" \
  --set "duration=${DUR_EFF}" \
  --set "path=pure-request" \
  --set "profile=${PROFILE}" \
  --set "ok=true" \
  --set "stopped_short=$([ "$DRY" -eq 1 ] && echo 'dry-run:未create' || echo '')" \
  --set "billable_creates=0" \
  --set "dry_run=$DRY" \
  --title "${INTENT:-$(basename "$STAGING")}"

if [ "$ALLOW_CREATE" -eq 1 ]; then
  echo "[pure-master] BILLABLE create-once" >&2
  export LOVART_SIG_HEADERS_JSON
  LOVART_SIG_HEADERS_JSON=$(cat "$SIG_OUT")
  if [ -n "$TOKEN_FILE" ]; then export LOVART_TOKEN; LOVART_TOKEN=$(tr -d '\n' < "$TOKEN_FILE"); fi
  node "$BIN/lovart-wan-create-once.cjs" \
    --project "$PROJECT" \
    --intent "${INTENT:-default}" \
    --body "$BODY" \
    --out "${STAGING}/create-once-result.json"
else
  echo "[pure-master] stop before create (use lovart-wan-create-once.cjs separately when approved)" >&2
fi

echo "{\"ok\":true,\"dry_run\":$DRY,\"staging\":\"$STAGING\",\"body\":\"$BODY\",\"created\":$ALLOW_CREATE}"
