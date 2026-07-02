#!/usr/bin/env bash
# Бэкап hosted Supabase через session-пулер (прямой db.<ref>.supabase.co — IPv6-only).
# Использование: ADMIN_DSN='postgresql://postgres.<ref>:<pwd>@aws-1-eu-central-1.pooler.supabase.com:5432/postgres' ./backup.sh
set -euo pipefail

: "${ADMIN_DSN:?Нужен ADMIN_DSN (session-пулер, роль postgres.<project-ref>)}"

out="orbis-backup-$(date +%F).sql"

# pg_dump должен быть >= мажорной версии сервера (Supabase — PG17).
# Локальный подходит — используем его; иначе — контейнер postgres:17-alpine.
if pg_dump --version 2>/dev/null | grep -qE '\) (1[7-9]|[2-9][0-9])\.'; then
  pg_dump "$ADMIN_DSN" --no-owner --no-privileges -f "$out"
else
  echo "локальный pg_dump старее PG17 — использую docker postgres:17-alpine"
  docker run --rm -v "$PWD:/out" postgres:17-alpine \
    pg_dump "$ADMIN_DSN" --no-owner --no-privileges -f "/out/$out"
fi

echo "dump: $out ($(wc -l < "$out" | tr -d ' ') строк)"
grep -q 'spike_items' "$out" && echo "OK: дамп содержит spike_items" || { echo "FAIL: spike_items нет в дампе"; exit 1; }
