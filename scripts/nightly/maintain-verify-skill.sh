#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)"
log_dir="${XDG_STATE_HOME:-$HOME/.local/state}/inference-engineering/maintain-verify"
mkdir -p "$log_dir"

exec 9>"$log_dir/run.lock"
if ! flock -n 9; then
  echo "previous maintain-verify run still holds $log_dir/run.lock; skipping" >&2
  exit 0
fi

log="$log_dir/$(date +%F_%H%M%S).log"
ln -sfn "$log" "$log_dir/latest.log"
echo "maintain-verify: repo=$repo log=$log"

cd "$repo"
claude -p "/pstack:maintain-verification-skill verify-command-center" \
  --permission-mode bypassPermissions \
  --output-format text \
  >"$log" 2>&1
