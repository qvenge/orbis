# 02 — Ops Runbook (прод Orbis)

Операционный справочник прод-контура: деплой, секреты, выпуск PAT, бэкап/восстановление,
keep-warm против сна Render, пауза Supabase Free и health-мониторинг.

Топология (слайс 1c-2): один Render free web-сервис (Docker, Bun 1.2.7) раздаёт API
(Hono: `/trpc`, `/mcp`, `/health`) и статику веб-клиента (`apps/web/dist`) с одного origin.
БД — Supabase Free (eu-central-1) через Supavisor-пулер. Бэкап — `pg_dump` по cron GitHub Actions.

Плейсхолдеры: `<PROD_REF>` — reference прод-проекта Supabase; `<pwd>` — пароль роли;
`<prod-host>` — публичный хост Render-сервиса (например `orbis.onrender.com`).

---

## 1. Деплой (Render Blueprint)

Источник истины конфигурации — `render.yaml` в корне репозитория. Деплой описан как Blueprint,
секреты не хранятся в git (`sync: false` — значения задаются в Render UI).

### Первичная настройка

1. `dashboard.render.com → New → Blueprint` → выбрать репозиторий Orbis и ветку `main`.
2. Render читает `render.yaml`, создаёт web-сервис (`runtime: docker`, `plan: free`,
   `region: frankfurt`, `healthCheckPath: /health`, `dockerfilePath: ./Dockerfile`).
3. Задать `sync: false`-секреты (см. §2) в Render UI перед первым деплоем.
4. `Apply` — Render собирает образ по корневому `Dockerfile` (web build + API) и запускает.

### Обновления

Push в `main` → Render авто-деплоит новый образ. Проверка после деплоя:

```bash
curl -fsS https://<prod-host>/health          # {"status":"ok"}
curl -fsS https://<prod-host>/ | head -c 200   # index.html веб-клиента (same-origin)
```

Роллбэк: в Render UI сервиса → `Deploys` → выбрать предыдущий зелёный деплой → `Redeploy`.

---

## 2. Секреты (Render Environment, `sync: false`)

Все значения задаются в Render UI (`Service → Environment`), НЕ в git. Перечень:

| Ключ | Назначение | Формат / источник |
|---|---|---|
| `DATABASE_URL` | боевой пул API (роль `orbis_app`) | `postgresql://orbis_app.<PROD_REF>:<pwd>@aws-1-eu-central-1.pooler.supabase.com:5432/postgres` (session-пулер) |
| `PG_PREPARE` | prepared statements для session-пулера | `true` (не секрет; для transaction-режима `:6543` было бы `false`) |
| `PORT` | порт сервера | `3001` |
| `ORBIS_PAT_HASH` | sha256 PAT приёмочного агента | вывод `scripts/issue-pat.ts` (см. §3) |
| `ORBIS_PAT_OWNER_ID` | владелец, от чьего имени действует агент | UUID из `auth.users` |
| `ANTHROPIC_API_KEY` | ключ LLM-провайдера | `sk-ant-...` |
| `ORBIS_LLM_MODEL` | (опц.) модель по умолчанию | иначе дефолт из `send-message.ts` |
| `SUPABASE_JWT_SECRET` | верификация JWT (HS) | из Supabase `Project Settings → API` |
| `SUPABASE_JWKS_URL` | верификация JWT (JWKS/RS) | `https://<PROD_REF>.supabase.co/auth/v1/.well-known/jwks.json` |
| `VITE_SUPABASE_URL` | build-env web-клиента | `https://<PROD_REF>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | build-env web-клиента | anon-ключ прод-проекта |

`VITE_API_URL` не задаётся (режим A same-origin: клиент бьёт в относительный `/trpc`).

Отдельно для бэкапа — GitHub Actions secret `ADMIN_DSN` (см. §4), НЕ в Render.

Правила: секреты не логируются и не коммитятся; ротация — заменить значение в UI и
передеплоить (Render перезапускает процесс с новым env).

---

## 3. Выпуск PAT приёмочного агента

PAT нужен внешнему агенту (Claude Code) для `/mcp`. Токен hash-only: сервер хранит только
sha256, сырой токен показывается ОДИН раз и не восстановим (потерял — выпусти новый).

```bash
bun scripts/issue-pat.ts
```

Вывод содержит:
- сырой токен `orbis_pat_<hex>` — отдать агенту (заголовок `Authorization: Bearer <токен>`),
  НЕ логировать и НЕ коммитить;
- `ORBIS_PAT_HASH=<sha256>` и `ORBIS_PAT_OWNER_ID=<uuid>` — положить в Render Environment (§2).

Отзыв токена: сменить/удалить `ORBIS_PAT_HASH` в Render и передеплоить (перезапуск сервера).

---

## 4. Бэкап БД

### 4.1 Автоматический (GitHub Actions cron)

Workflow `.github/workflows/backup.yml`: `pg_dump` прод-БД через session-пулер `:5432`
ежедневно в 03:00 UTC + ручной запуск (`workflow_dispatch`). Дамп грузится как artifact
`orbis-db-backup` (retention 30 дней).

Гейт: секрет репозитория `ADMIN_DSN` (Фаза B). Завести:
`Settings → Secrets and variables → Actions → New repository secret`, имя `ADMIN_DSN`,
значение — session-пулерный DSN роли `postgres` (не `orbis_app` — для дампа нужна роль-владелец):

```
postgresql://postgres.<PROD_REF>:<pwd>@aws-1-eu-central-1.pooler.supabase.com:5432/postgres
```

Без секрета первый шаг workflow падает с явной ошибкой (`::error::Секрет ADMIN_DSN не задан…`),
а не молча. Ручной прогон: `Actions → backup → Run workflow`.

### 4.2 Ручной бэкап

```bash
ADMIN_DSN='postgresql://postgres.<PROD_REF>:<pwd>@aws-1-eu-central-1.pooler.supabase.com:5432/postgres' \
  BACKUP_DIR=./backups \
  bash scripts/backup.sh
```

Скрипт: `pg_dump --no-owner --no-privileges` через session-пулер; требует `pg_dump >= PG17`
(иначе автоматически дампит через `docker run postgres:17-alpine`); проверяет, что дамп непуст
и содержит таблицу `entities` (маркер целостности прод-схемы); печатает путь строкой `dump: <path>`.
Пароль/DSN в вывод не попадают.

### 4.3 Восстановление

Плейн-SQL дамп (`.sql`) восстанавливается через `psql`. Восстанавливать в ЧИСТУЮ БД
(новый Supabase-проект или пересозданная схема), иначе конфликты по существующим объектам.

```bash
psql 'postgresql://postgres.<TARGET_REF>:<pwd>@aws-1-eu-central-1.pooler.supabase.com:5432/postgres' \
  -v ON_ERROR_STOP=1 -f orbis-backup-<ts>.sql
```

Проверка после восстановления — все 8 таблиц прод-схемы на месте:

```bash
psql "$ADMIN_DSN" -c "\dt public.*"
# ожидаемо: entities, relations, aspect_definitions, user_settings,
#           chat_threads, chat_messages, ai_usage, entity_origins
```

Дамп снят без owner/privileges (`--no-owner --no-privileges`), поэтому GRANT-ы роли `orbis_app`
и RLS-политики восстанавливаются заново прогоном `bun run db:prepare` против целевой БД
(миграции + роль `orbis_app` + сид реестра аспектов + RLS-тест) — см. Task 9 плана 1c-2.

---

## 5. Keep-warm (сон Render free)

Render free усыпляет сервис после ~15 минут без HTTP; cold start ~1 минута (SPIKE-05).
Supavisor штатно переживает переустановку пула, данные не теряются — это только латентность
первого запроса.

Стратегии (по возрастанию стоимости):

1. **Polling агентной петли (по умолчанию).** Приёмочный агент днём периодически бьёт в `/mcp`
   (`entity_query` по `updated_at`) — эти запросы держат сервис тёплым в рабочие часы.
2. **Внешний keep-warm пинг** (если нужно 24/7 без апгрейда): любой бесплатный uptime-пингер
   раз в 10–14 минут дёргает `GET https://<prod-host>/health` (лёгкий, без БД). Ставить ниже
   15-минутного окна сна. Компромисс — держит free-инстанс занятым близко к лимиту часов.
3. **Апгрейд без сна:** Render Starter $7/мес (без сна, та же топология) ЛИБО миграция на
   Fly.io ~$2.24/мес (always-on, нужна карта). Решение по стоимости — владельческий гейт.

Замер cold-start фиксируется в приёмке (Task 12): первый запрос после 15+ мин простоя.

---

## 6. Пауза Supabase Free (неактивность ~7 дней)

Supabase Free ставит проект на паузу после ~7 дней без активности к БД. На паузе API/пулер
недоступны — сервис отдаёт ошибки подключения.

- **Профилактика:** ежедневный backup-cron (§4.1) сам обращается к БД и сбрасывает счётчик
  простоя; polling агента днём — тоже активность.
- **Снятие с паузы:** `dashboard.supabase.com → проект <PROD_REF> → Restore/Resume project`.
  После восстановления проверить связность: `psql "$ADMIN_DSN" -c 'select 1'` и `/health` сервиса.

---

## 7. Health-мониторинг

`GET /health` — liveness процесса без обращения к БД (`app.ts`: `{"status":"ok"}`). Используется
Render (`healthCheckPath: /health`) и внешним пингером (§5).

```bash
curl -fsS https://<prod-host>/health           # 200 {"status":"ok"} — процесс жив
```

Диагностика по симптому:

| Симптом | Вероятная причина | Действие |
|---|---|---|
| `/health` таймаут ~1 мин, затем 200 | Render уснул (cold start) | норма для free; keep-warm §5 |
| `/health` 200, но операции с данными падают | Supabase на паузе / DSN | §6 (resume) + сверить `DATABASE_URL` |
| 502/503 от Render стабильно | краш процесса / битый деплой | Render `Logs`; роллбэк §1 |
| backup-job красный | нет `ADMIN_DSN` / пауза Supabase | завести секрет §4.1 / resume §6 |

Логи прод-сервиса — Render UI `Service → Logs` (retention 7 дней на free).
