#!/usr/bin/env bash
# Бэкап hosted Supabase через session-пулер (прямой db.<ref>.supabase.co — IPv6-only).
# Использование: ADMIN_DSN='postgresql://postgres.<ref>:<pwd>@aws-0-eu-central-1.pooler.supabase.com:5432/postgres' ./backup.sh
set -euo pipefail

: "${ADMIN_DSN:?Нужен ADMIN_DSN (session-пулер, роль postgres.<project-ref>)}"

out="orbis-backup-$(date +%F).sql"

# pg_dump должен быть не старше мажорной версии сервера (Supabase — PG15/17); иначе: brew install libpq
pg_dump "$ADMIN_DSN" --no-owner --no-privileges -f "$out"
echo "dump: $out ($(wc -l < "$out") строк)"
grep -q 'spike_items' "$out" && echo "OK: дамп содержит spike_items" || { echo "FAIL: spike_items нет в дампе"; exit 1; }
