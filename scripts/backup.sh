#!/usr/bin/env bash
# Бэкап hosted Supabase (прод Orbis) через Supavisor session-пулер (:5432).
# Прямой db.<ref>.supabase.co — IPv6-only, а egress Render/GitHub-Actions — IPv4,
# поэтому дамп идёт ТОЛЬКО через session-пулер (роль postgres.<PROD_REF>).
#
# Использование (хост пулера — per-project, из Supabase Dashboard → Connect;
# для прода ceovqtdibalxnqkgedrl это aws-0-eu-central-1.pooler.supabase.com):
#   ADMIN_DSN='postgresql://postgres.<PROD_REF>:<pwd>@<POOLER_HOST>:5432/postgres' \
#     scripts/backup.sh
#
# Опциональные env:
#   BACKUP_DIR — каталог для дампа (по умолчанию текущий каталог).
#   BACKUP_TS  — метка времени в имени файла (по умолчанию UTC, детерминируема извне).
#
# Пароль/DSN НЕ печатается. Последняя строка вывода — «dump: <path>»,
# по ней воркфлоу забирает файл как artifact.
set -euo pipefail

: "${ADMIN_DSN:?ADMIN_DSN обязателен (session-пулер :5432, роль postgres.<PROD_REF>); секрет заводится в Фазе B}"

backup_dir="${BACKUP_DIR:-.}"
mkdir -p "$backup_dir"
backup_dir="$(cd "$backup_dir" && pwd)" # абсолютный путь нужен docker-фолбэку (volume mount)
ts="${BACKUP_TS:-$(date -u +%Y%m%dT%H%M%SZ)}"
out="$backup_dir/orbis-backup-$ts.sql"

# Реальная таблица прод-схемы (apps/server/src/db/schema.ts §4.1) — маркер целостности дампа.
# Её DDL обязан присутствовать; иначе дамп неполон/пуст → падаем.
expect_table='entities'

# Дампим ТОЛЬКО свои схемы. Без --schema pg_dump забирает и managed-схемы Supabase
# (auth, storage, extensions…): в дамп попадали бы auth.users с email и хэшами паролей,
# а restore в свежий проект обрывался бы на «CREATE SCHEMA auth уже существует»
# (ON_ERROR_STOP=1). drizzle нужен: его журнал миграций делает db:migrate после
# восстановления no-op'ом — иначе миграции покатились бы по готовой схеме.
schemas=(--schema public --schema drizzle)

# pg_dump ДОЛЖЕН быть той же мажорной версии, что сервер (Supabase — PG17), иначе
# «server version mismatch». Локальный pg_dump >= 17 — берём его; иначе postgres:17-alpine.
major="$(pg_dump --version 2>/dev/null | grep -oE '[0-9]+' | head -n1 || true)"
major="${major:-0}"

if [[ "$major" -ge 17 ]]; then
  # DSN попадает в argv pg_dump (штатный способ libpq); в лог/echo его не выводим.
  pg_dump "$ADMIN_DSN" --no-owner --no-privileges "${schemas[@]}" -f "$out"
else
  echo "локальный pg_dump < PG17 (обнаружено: ${major}) — дамплю через docker postgres:17-alpine"
  # DSN передаётся контейнеру ТОЛЬКО как env (-e ADMIN_DSN), не как аргумент —
  # чтобы пароль не светился в host ps/логах. Имя файла — позиционный аргумент.
  docker run --rm -e ADMIN_DSN -v "$backup_dir:/out" postgres:17-alpine \
    sh -c 'pg_dump "$ADMIN_DSN" --no-owner --no-privileges --schema public --schema drizzle -f "/out/$1"' _ "$(basename "$out")"
fi

# Верификация: файл непуст, содержит ожидаемую таблицу прод-схемы и дописан до конца.
[[ -s "$out" ]] || { echo "FAIL: дамп пуст ($out)"; exit 1; }
grep -qE "CREATE TABLE ([[:alnum:]_]+\.)?\"?${expect_table}\"? " "$out" \
  || { echo "FAIL: в дампе нет таблицы '${expect_table}' — дамп неполон"; exit 1; }
# Обрыв на середине (сеть, диск, OOM) оставляет валидный DDL без части данных:
# завершающий маркер pg_dump — единственный признак, что файл целиком.
grep -q '^-- PostgreSQL database dump complete' "$out" \
  || { echo "FAIL: дамп оборван (нет завершающего маркера pg_dump)"; exit 1; }

lines="$(wc -l < "$out" | tr -d ' ')"
echo "OK: дамп содержит таблицу '${expect_table}' (${lines} строк)"
echo "dump: $out"
