#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077
[[ $# = 5 ]] || { echo 'usage: run-lane.sh N|P manifests output-parent handoff.json handoff-sha' >&2; exit 2; }
lane=$1
manifests=$2
out=$3
handoff=$4
digest=$5
[[ "$lane" = N || "$lane" = P ]]
[[ "$out" =~ ^/private/tmp/orbis-cutover-[np]\.[[:alnum:]]+$ && -d "$out" && ! -L "$out" ]]
for name in run trace.jsonl runner.stderr exit; do
  [[ ! -e "$out/$name" && ! -L "$out/$name" ]]
done
runner="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
bun_bin="$(command -v bun)"
set +e
ORBIS_CUTOVER_DISPOSABLE=1 "$bun_bin" run "$runner/rehearsal.ts" "$lane" "$manifests" \
  "$out/run" "$handoff" "$digest" > "$out/trace.jsonl" 2> "$out/runner.stderr"
run_exit=$?
printf '%s\n' "$run_exit" > "$out/exit"
exit "$run_exit"
