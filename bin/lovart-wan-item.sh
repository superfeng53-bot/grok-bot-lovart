#!/usr/bin/env bash
# 画布 Wan 单条：prep →（计费时）一次 create-once → poll/download → GATE/RESULT → Mac 配方。
# 默认 dry-run。计费要同时 --no-dry-run --allow-create-once。
set -euo pipefail
BIN="$(cd "$(dirname "$0")" && pwd)"
exec node "$BIN/lovart-wan-batch.cjs" --once "$@"
