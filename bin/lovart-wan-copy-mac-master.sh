#!/usr/bin/env bash
# 把 box 母片经 Mac ~/.grok-staging 拷到 成品/母片 + 项目/母片，三处 md5 一致。
# 本脚本在 **Mac 上**执行（文件已在 ~/.grok-staging/ 或传入 --src）。
# box 侧负责 CopyFromBox；Mac 不可达时调用方须失败，本脚本也绝不假成功。
#
# Usage:
#   lovart-wan-copy-mac-master.sh \
#     --name 07-xxx-wan-母片.mp4 \
#     --mac-project-dir "/Volumes/外接硬盘/短视频/项目/.../母片" \
#     --mac-product-dir "/Volumes/外接硬盘/短视频/成品/.../母片" \
#     [--src ~/.grok-staging/NAME | --staging-dir ~/.grok-staging] \
#     [--box-md5 HEX]
#
# Exit: 0 ok; 2 usage; 3 staging/src missing; 4 volume/dir unreachable; 5 md5 mismatch
set -euo pipefail

NAME=""
SRC=""
STAGING_DIR="${HOME}/.grok-staging"
MAC_PROJ=""
MAC_PROD=""
BOX_MD5=""
DRY=0

usage() {
  cat <<'U'
lovart-wan-copy-mac-master.sh — Mac-side: staging → 成品母片 + 项目母片, verify 3 md5
  --name FILE.mp4
  --mac-project-dir DIR   .../项目/.../母片
  --mac-product-dir DIR   .../成品/.../母片
  --src PATH              explicit source file (default: ~/.grok-staging/NAME)
  --staging-dir DIR       default ~/.grok-staging
  --box-md5 HEX           optional expected md5 from box
  --dry-run               only check paths / print plan, no copy
U
}

while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="${2:-}"; shift 2 ;;
    --src) SRC="${2:-}"; shift 2 ;;
    --staging-dir) STAGING_DIR="${2:-}"; shift 2 ;;
    --mac-project-dir) MAC_PROJ="${2:-}"; shift 2 ;;
    --mac-product-dir) MAC_PROD="${2:-}"; shift 2 ;;
    --box-md5) BOX_MD5="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown $1" >&2; usage; exit 2 ;;
  esac
done

if [ -z "$NAME" ] || [ -z "$MAC_PROJ" ] || [ -z "$MAC_PROD" ]; then
  usage; exit 2
fi
if [ -z "$SRC" ]; then
  SRC="${STAGING_DIR}/${NAME}"
fi

md5_of() {
  if command -v md5 >/dev/null 2>&1; then
    md5 -q "$1"
  else
    md5sum "$1" | awk '{print $1}'
  fi
}

# Volume reachability
for d in "$MAC_PROJ" "$MAC_PROD"; do
  root="$d"
  # climb to /Volumes/...
  while [ "$root" != "/" ] && [ "$root" != "." ]; do
    case "$root" in
      /Volumes/*)
        vol=$(echo "$root" | awk -F/ '{print "/"$2"/"$3}')
        if [ ! -d "$vol" ]; then
          echo "MAC_VOLUME_UNREACHABLE $vol (needed for $d)" >&2
          exit 4
        fi
        break
        ;;
    esac
    root=$(dirname "$root")
  done
done

if [ ! -f "$SRC" ]; then
  # maybe split parts
  if ls "${SRC}.part"* >/dev/null 2>&1; then
    echo "assembling parts for $SRC" >&2
    cat "${SRC}.part"* > "${SRC}.assembling"
    mv "${SRC}.assembling" "$SRC"
    rm -f "${SRC}.part"*
  else
    echo "SRC_MISSING $SRC" >&2
    exit 3
  fi
fi

SRC_MD5=$(md5_of "$SRC")
if [ -n "$BOX_MD5" ] && [ "$SRC_MD5" != "$BOX_MD5" ]; then
  echo "MD5_MISMATCH staging=$SRC_MD5 box=$BOX_MD5" >&2
  exit 5
fi

echo "plan src=$SRC md5=$SRC_MD5" >&2
echo "  → $MAC_PROD/$NAME" >&2
echo "  → $MAC_PROJ/$NAME" >&2

if [ "$DRY" -eq 1 ]; then
  echo "{\"ok\":true,\"dry_run\":true,\"src_md5\":\"$SRC_MD5\",\"mac_product\":\"$MAC_PROD/$NAME\",\"mac_project\":\"$MAC_PROJ/$NAME\"}"
  exit 0
fi

mkdir -p "$MAC_PROJ" "$MAC_PROD" || { echo "MKDIR_FAIL" >&2; exit 4; }
cp -f "$SRC" "$MAC_PROD/$NAME"
cp -f "$SRC" "$MAC_PROJ/$NAME"

PROD_MD5=$(md5_of "$MAC_PROD/$NAME")
PROJ_MD5=$(md5_of "$MAC_PROJ/$NAME")
if [ "$SRC_MD5" != "$PROD_MD5" ] || [ "$SRC_MD5" != "$PROJ_MD5" ]; then
  echo "MD5_MISMATCH after copy src=$SRC_MD5 prod=$PROD_MD5 proj=$PROJ_MD5" >&2
  exit 5
fi

# cleanup staging copy of this file (parts already gone)
rm -f "$SRC"

echo "{\"ok\":true,\"md5\":\"$SRC_MD5\",\"mac_product\":\"$MAC_PROD/$NAME\",\"mac_project\":\"$MAC_PROJ/$NAME\",\"three_md5_ok\":true}"
