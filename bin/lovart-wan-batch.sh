#!/usr/bin/env bash
# 画布 Wan 批量入口。默认 dry-run。计费要同时 --no-dry-run --allow-create-once。
set -euo pipefail
BIN="$(cd "$(dirname "$0")" && pwd)"
exec node "$BIN/lovart-wan-batch.cjs" "$@"
