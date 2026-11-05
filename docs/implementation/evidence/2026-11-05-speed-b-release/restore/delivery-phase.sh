#!/bin/bash
set -euo pipefail
set +x
umask 077
source /private/tmp/orbis-b-restore.oE4t8P/phase-env.sh
test ! -e "$restore_tmp/log/post-rebase-delivery.log"
case "$(date -u +%H:%M)" in 03:1[5-9]|03:2[0-9]) echo 'too close to the old cleanup schedule' >&2; exit 1 ;; esac
cmp "$restore_tmp/log/rebase-business-after.log" "$restore_tmp/log/target-business-after-witness.log"
openssl rand -hex 32 > "$restore_tmp/secret/delivery-jwt"
admin_password="$(cat "$restore_tmp/secret/target-admin")"
app_password="$(cat "$restore_tmp/secret/target-app")"
jwt_secret="$(cat "$restore_tmp/secret/delivery-jwt")"
code=0
(cd "$restore_tmp/src" &&
  env -i PATH="$PATH" LC_ALL=C TZ=UTC ORBIS_ROUTINE_SCHEDULER=0 \
    SUPABASE_JWT_SECRET="$jwt_secret" \
    DATABASE_URL_ADMIN="postgresql://supabase_admin:$admin_password@127.0.0.1:54343/postgres" \
    DATABASE_URL="postgresql://orbis_app:$app_password@127.0.0.1:54343/postgres" \
    bun test apps/server/test/restore-rehearsal-delivery.test.ts) \
    > "$restore_tmp/log/post-rebase-delivery.log" 2>&1 || code=$?
printf 'post-rebase-delivery %s\n' "$code" >> "$restore_tmp/log/phase-three-exits.txt"
test "$code" -eq 0
sed -n 's/^RESTORE_DELIVERY_WITNESS //p' "$restore_tmp/log/post-rebase-delivery.log" > "$restore_tmp/log/post-rebase-delivery.json"
test -s "$restore_tmp/log/post-rebase-delivery.json"
restore_bun target scripts/restore-rehearsal-business.ts > "$restore_tmp/log/post-rebase-delivery-business.log"
printf 'post-rebase-delivery-business 0\n' >> "$restore_tmp/log/phase-three-exits.txt"
printf '%s\n' 'Actual Hono/SSE/reconcile/MCP witness completed.'
