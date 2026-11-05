#!/bin/bash
set -euo pipefail
umask 077
source /private/tmp/orbis-b-restore.oE4t8P/phase-env.sh
run() {
  local label=$1 code=0
  shift
  "$@" > "$restore_tmp/log/$label.log" 2>&1 || code=$?
  printf '%s %s\n' "$label" "$code" >> "$restore_tmp/log/exit-codes.txt"
  return "$code"
}
run target-business-post-A restore_bun target scripts/restore-rehearsal-business.ts
cmp "$restore_tmp/log/source-business-before.log" "$restore_tmp/log/target-business-post-A.log"
awk '/^[0-9]+; [0-9]+ [0-9]+ (ACL |DEFAULT ACL )/ {print}' "$restore_tmp/source-schema.toc" > "$restore_tmp/acl.toc"
test -s "$restore_tmp/acl.toc"
archive_sha=$(awk '$2=="source-schema.dump"{print $1}' "$restore_tmp/source-artifacts.sha256")
acl_toc_sha=$(shasum -a 256 < "$restore_tmp/acl.toc"); acl_toc_sha=${acl_toc_sha%% *}
run render-acl env RESTORE_APPROVED_PHASE=render-acl RESTORE_SCHEMA_SHA256="$archive_sha" RESTORE_ACL_TOC_SHA256="$acl_toc_sha" bash "$restore_runner" render-acl
printf '%s\n' 'Stock and legacy diagnostics captured; ACL only rendered.'
