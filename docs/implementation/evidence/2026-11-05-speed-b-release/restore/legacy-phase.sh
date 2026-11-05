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
run target-stock-runtime restore_bun target scripts/restore-rehearsal-stock-read.ts
test "$(docker inspect --type=container "$RESTORE_SOURCE_CONTAINER_ID" --format '{{.Image}}')" = "$(cat "$restore_tmp/log/image-id.txt")"
printf '%s\n' "$RESTORE_SOURCE_PASSWORD" |
  docker exec -i --user 0 "$RESTORE_SOURCE_CONTAINER_ID" env -i PATH=/usr/lib/postgresql/17/bin:/usr/bin:/bin LC_ALL=C /bin/bash -c '
    IFS= read -r PGPASSWORD
    export PGPASSWORD PGCONNECT_TIMEOUT=5
    exec pg_dump -w -h /var/run/postgresql -p 5432 -U postgres -d postgres --schema-only --schema public --schema drizzle
  ' > "$restore_tmp/legacy-reference-schema.sql" 2> "$restore_tmp/log/legacy-reference-schema.stderr"
{
  echo 'GRANT USAGE ON SCHEMA public TO PUBLIC;'
  grep -E '^(GRANT|REVOKE) |^ALTER DEFAULT PRIVILEGES FOR ROLE postgres ' "$restore_tmp/legacy-reference-schema.sql"
} > "$restore_tmp/legacy-A-grants.sql"
grep -q 'TO orbis_change_feed_owner;' "$restore_tmp/legacy-A-grants.sql"
legacy_guard="DO \$\$BEGIN IF current_database() <> 'postgres' OR current_user <> 'supabase_admin' OR session_user <> 'supabase_admin' OR inet_server_addr() IS NOT NULL OR (SELECT system_identifier::text FROM pg_control_system()) <> '7704502933634711586' THEN RAISE EXCEPTION 'wrong legacy target'; END IF; END\$\$;"
if run target-A-recipe restore_psql target --single-transaction -c "$legacy_guard" -c "$(cat "$restore_tmp/legacy-A-grants.sql")"; then
  echo 'legacy grant recipe unexpectedly passed' >&2
  exit 1
fi
grep -q 'role "orbis_change_feed_owner" does not exist' "$restore_tmp/log/target-A-recipe.log"
cp "$restore_tmp/log/target-catalog.log" "$restore_tmp/log/target-catalog-post-stock-pre-A.log"
run target-migrate-noop restore_bun target run --filter @orbis/server db:migrate
run target-catalog-post-A bash "$restore_tmp/capture-catalog.sh" target catalog
cmp "$restore_tmp/log/target-catalog.log" "$restore_tmp/log/target-catalog-post-stock-pre-A.log" ||
  diff -u "$restore_tmp/log/target-catalog-post-stock-pre-A.log" "$restore_tmp/log/target-catalog.log" > "$restore_tmp/log/target-catalog-post-A.diff"
run target-business-post-A restore_bun target scripts/restore-rehearsal-business.ts
cmp "$restore_tmp/log/source-business-before.log" "$restore_tmp/log/target-business-post-A.log"
awk '/^[0-9]+; [0-9]+ [0-9]+ (ACL |DEFAULT ACL )/ {print}' "$restore_tmp/source-schema.toc" > "$restore_tmp/acl.toc"
test -s "$restore_tmp/acl.toc"
archive_sha=$(awk '$2=="source-schema.dump"{print $1}' "$restore_tmp/source-artifacts.sha256")
acl_toc_sha=$(shasum -a 256 < "$restore_tmp/acl.toc"); acl_toc_sha=${acl_toc_sha%% *}
run render-acl env RESTORE_APPROVED_PHASE=render-acl RESTORE_SCHEMA_SHA256="$archive_sha" RESTORE_ACL_TOC_SHA256="$acl_toc_sha" bash "$restore_runner" render-acl
printf '%s\n' 'Stock and legacy diagnostics captured; ACL only rendered.'
