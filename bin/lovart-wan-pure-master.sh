#!/usr/bin/env bash
# Lovart 画布 Wan 纯请求流水线外壳。
# 默认 --dry-run：串到 upload-body 生成 create-body.json，绝不调用 create。
# 计费 create 只走 lovart-wan-create-once.cjs，且必须同时 --no-dry-run 与 --allow-create-once。
# create 成功（或账本里已有同一 intent 的 generator_task_id）后调用 lovart-wan-finish-item.cjs
# 做轮询、下载、写 GATE/RESULT、Mac 拷贝配方。本脚本不实现第二套 POST。
#
# 操作员批量入口是 lovart-wan-batch.sh（内部调用本脚本）。
#
# Exit: 透传子脚本；2=usage；6=拒绝（dry 却要求 create，或非 dry 却 --skip-sign）
set -euo pipefail
BIN="$(cd "$(dirname "$0")" && pwd)"

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
SKIP_SIGN=0
REUSE_URLS=0
ALLOW_CREATE=0
USER_SAID=0
ENV_SRC=""
FRONT_SRC=""
OBLIQUE_SRC=""
SIDE_SRC=""
AUDIO_SRC=""
WASM=""
OUT_MP4=""
ACCOUNT=""
EXPECT_EMAIL=""
MAC_PROD=""
MAC_PROJ=""

usage() {
  cat <<'U'
lovart-wan-pure-master.sh — pure-request pipeline shell (default --dry-run, NO create)
  --prompt PATH.md --staging DIR --project ID
  --profile N          Chrome profile (for extract-token / pick note)
  --duration N
  --intent NAME
  --token-file PATH
  --out-body PATH
  --out-mp4 PATH       passed to finish-item after a successful create
  --account ID --expect-email ADDR
  --mac-project-dir DIR
  --mac-product-dir DIR   兼容旧参数，忽略，不转发给收尾脚本
  --env/--front/--oblique/--side/--audio PATH   forwarded to prep-staging
  --wasm PATH
  --dry-run            default ON
  --no-dry-run         real upload+pricing; still no create unless --allow-create-once
  --allow-create-once  call lovart-wan-create-once.cjs once (BILLABLE); requires --no-dry-run
  --user-said-send     operator recorded that the user already said 发送 (special account)
  --skip-ensure --skip-pick --skip-token --reuse-urls
  --skip-sign          dry-run only: skip wasm self-test
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
    --out-mp4) OUT_MP4="${2:-}"; shift 2 ;;
    --account) ACCOUNT="${2:-}"; shift 2 ;;
    --expect-email) EXPECT_EMAIL="${2:-}"; shift 2 ;;
    --mac-product-dir) MAC_PROD="${2:-}"; shift 2 ;;
    --mac-project-dir) MAC_PROJ="${2:-}"; shift 2 ;;
    --env) ENV_SRC="${2:-}"; shift 2 ;;
    --front) FRONT_SRC="${2:-}"; shift 2 ;;
    --oblique) OBLIQUE_SRC="${2:-}"; shift 2 ;;
    --side) SIDE_SRC="${2:-}"; shift 2 ;;
    --audio) AUDIO_SRC="${2:-}"; shift 2 ;;
    --wasm) WASM="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --no-dry-run) DRY=0; shift ;;
    --allow-create-once) ALLOW_CREATE=1; shift ;;
    --user-said-send) USER_SAID=1; shift ;;
    --skip-ensure) SKIP_ENSURE=1; shift ;;
    --skip-pick) SKIP_PICK=1; shift ;;
    --skip-token) SKIP_TOKEN=1; shift ;;
    --skip-sign) SKIP_SIGN=1; shift ;;
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
if [ "$SKIP_SIGN" -eq 1 ] && [ "$DRY" -eq 0 ]; then
  echo "REFUSE: --skip-sign is dry-run only" >&2
  exit 6
fi

echo "[pure-master] dry=$DRY allow_create=$ALLOW_CREATE staging=$STAGING project=$PROJECT" >&2

if [ "$SKIP_ENSURE" -eq 0 ]; then
  if [ -x /home/box/bin/lovart-anti-cookie-ensure.sh ]; then
    /home/box/bin/lovart-anti-cookie-ensure.sh || true
  elif [ -x "$BIN/lovart-anti-cookie-ensure.sh" ]; then
    "$BIN/lovart-anti-cookie-ensure.sh" || true
  fi
fi

PREP_ARGS=(--prompt "$PROMPT" --staging "$STAGING" --force)
if [ -n "$DURATION" ]; then PREP_ARGS+=(--duration "$DURATION"); fi
if [ -n "$INTENT" ]; then PREP_ARGS+=(--slug "$INTENT"); fi
if [ -n "$ENV_SRC" ]; then PREP_ARGS+=(--env "$ENV_SRC"); fi
if [ -n "$FRONT_SRC" ]; then PREP_ARGS+=(--front "$FRONT_SRC"); fi
if [ -n "$OBLIQUE_SRC" ]; then PREP_ARGS+=(--oblique "$OBLIQUE_SRC"); fi
if [ -n "$SIDE_SRC" ]; then PREP_ARGS+=(--side "$SIDE_SRC"); fi
if [ -n "$AUDIO_SRC" ]; then PREP_ARGS+=(--audio "$AUDIO_SRC"); fi
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
      if [ "$DRY" -eq 0 ]; then exit "$ec"; fi
    }
  fi
fi

if [ "$SKIP_TOKEN" -eq 0 ] && [ -z "$TOKEN_FILE" ] && [ -n "$PROFILE" ] && [ "$DRY" -eq 0 ]; then
  TOKEN_FILE="/tmp/l${PROFILE}-usertoken.txt"
  node "$BIN/lovart-wan-extract-token.cjs" --profile "$PROFILE" --out "$TOKEN_FILE"
fi

SIG_OUT="${STAGING}/sig-headers.json"
if [ "$SKIP_SIGN" -eq 1 ]; then
  echo "[pure-master] skip-sign (dry-run; wasm self-test not run)" >&2
  printf '%s\n' '{"skipped":true,"dry_run":true}' > "$SIG_OUT"
else
  SIGN_ARGS=(--out "$SIG_OUT" --self-test)
  if [ -n "$WASM" ]; then SIGN_ARGS+=(--wasm "$WASM"); fi
  node "$BIN/lovart-wan-sign-headers.cjs" "${SIGN_ARGS[@]}"
fi

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
  --set "account=${ACCOUNT}" \
  --set "expect_email=${EXPECT_EMAIL}" \
  --set "ok=true" \
  --set "stopped_short=$([ "$DRY" -eq 1 ] && echo 'dry-run:未create' || echo '')" \
  --set "billable_creates=0" \
  --set "dry_run=$DRY" \
  --set "mac_copy_status=not_run" \
  --set "mac_md5_ok=false" \
  --title "${INTENT:-$(basename "$STAGING")}"

run_finish() {
  local args=(
    node "$BIN/lovart-wan-finish-item.cjs"
    --staging "$STAGING"
    --result "${STAGING}/create-once-result.json"
    --project "$PROJECT"
    --intent "${INTENT:-default}"
  )
  if [ -n "${DUR_EFF:-}" ]; then args+=(--duration "$DUR_EFF"); fi
  if [ -n "$PROFILE" ]; then args+=(--profile "$PROFILE"); fi
  if [ -n "$TOKEN_FILE" ]; then args+=(--token-file "$TOKEN_FILE"); fi
  if [ -n "$OUT_MP4" ]; then args+=(--out-mp4 "$OUT_MP4"); fi
  if [ -n "$ACCOUNT" ]; then args+=(--account "$ACCOUNT"); fi
  if [ -n "$EXPECT_EMAIL" ]; then args+=(--expect-email "$EXPECT_EMAIL"); fi
  if [ -n "$MAC_PROD" ]; then echo "WARN: --mac-product-dir 已废弃，忽略" >&2; fi
  if [ -n "$MAC_PROJ" ]; then args+=(--mac-project-dir "$MAC_PROJ"); fi
  if [ -n "$WASM" ]; then args+=(--wasm "$WASM"); fi
  "${args[@]}"
}

CREATED=0
if [ "$ALLOW_CREATE" -eq 1 ]; then
  CHECK_ARGS=(
    node "$BIN/lovart-wan-batch.cjs" --check-before-create
    --staging "$STAGING"
    --project "$PROJECT"
    --intent "${INTENT:-default}"
    --out "${STAGING}/pre-create-check.json"
  )
  if [ -n "${DUR_EFF:-}" ]; then CHECK_ARGS+=(--duration "$DUR_EFF"); fi
  if [ -n "$ACCOUNT" ]; then CHECK_ARGS+=(--account "$ACCOUNT"); fi
  if [ "$USER_SAID" -eq 1 ]; then CHECK_ARGS+=(--user-said-send); fi
  set +e
  "${CHECK_ARGS[@]}"
  check_ec=$?
  set -e
  if [ "$check_ec" -eq 20 ]; then
    echo "[pure-master] existing generator_task_id; not creating again" >&2
    run_finish
    CREATED=0
  elif [ "$check_ec" -ne 0 ]; then
    echo "[pure-master] pre-create check exit $check_ec (no POST)" >&2
    exit "$check_ec"
  else
    echo "[pure-master] BILLABLE create-once" >&2
    export LOVART_SIG_HEADERS_JSON
    LOVART_SIG_HEADERS_JSON=$(cat "$SIG_OUT")
    if [ -n "$TOKEN_FILE" ]; then export LOVART_TOKEN; LOVART_TOKEN=$(tr -d '\n' < "$TOKEN_FILE"); fi
    BAL=""
    PRICE=""
    if [ -f "${STAGING}/pre-create-check.json" ]; then
      BAL=$(node -e "const j=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); if(j.balance_before!=null) process.stdout.write(String(j.balance_before));" "${STAGING}/pre-create-check.json")
      PRICE=$(node -e "const j=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); if(j.price!=null) process.stdout.write(String(j.price));" "${STAGING}/pre-create-check.json")
    fi
    CREATE_ARGS=(
      node "$BIN/lovart-wan-create-once.cjs"
      --project "$PROJECT"
      --intent "${INTENT:-default}"
      --body "$BODY"
      --out "${STAGING}/create-once-result.json"
    )
    if [ -n "$BAL" ]; then CREATE_ARGS+=(--balance-before "$BAL"); fi
    if [ -n "$PRICE" ]; then CREATE_ARGS+=(--max-price "$PRICE"); fi
    set +e
    "${CREATE_ARGS[@]}"
    create_ec=$?
    set -e
    if [ "$create_ec" -eq 0 ] || [ "$create_ec" -eq 6 ]; then
      # 0 = this POST returned generator_task_id. 6 = ledger already has this intent; finish downloads, no second POST.
      if [ "$create_ec" -eq 0 ]; then CREATED=1; fi
      run_finish
    else
      echo "[pure-master] create-once exit $create_ec (no retry, no second POST)" >&2
      exit "$create_ec"
    fi
  fi
else
  echo "[pure-master] stop before create (batch/item passes --no-dry-run --allow-create-once when the user approved)" >&2
fi

echo "{\"ok\":true,\"dry_run\":$DRY,\"staging\":\"$STAGING\",\"body\":\"$BODY\",\"created\":$CREATED}"
