# 02 — Ops Runbook (прод Orbis)

Операционный справочник прод-контура: деплой, секреты, выпуск PAT, бэкап/восстановление,
keep-warm против сна Render, пауза Supabase Free и health-мониторинг.

Топология (слайс 1c-2): один Render free web-сервис (Docker, Bun 1.2.7) раздаёт API
(Hono: `/trpc`, `/mcp`, `/health`) и статику веб-клиента (`apps/web/dist`) с одного origin.
БД — Supabase Free (eu-central-1) через Supavisor-пулер. Бэкап — `pg_dump` по cron GitHub Actions.

Плейсхолдеры: `<PROD_REF>` — reference прод-проекта Supabase (факт: `ceovqtdibalxnqkgedrl`);
`<pwd>` — пароль роли; `<prod-host>` — публичный хост Render-сервиса (факт: `orbis-64q4.onrender.com`);
`<POOLER_HOST>` — хост Supavisor-пулера проекта, смотреть в Supabase Dashboard → Connect
(факт для прода: `aws-0-eu-central-1.pooler.supabase.com`; кластер зависит от проекта — НЕ хардкодить:
spike-проект, например, жил на `aws-1-eu-central-1`).

---

## 1. Деплой (Render Blueprint)

Источник истины конфигурации — `render.yaml` в корне репозитория. Деплой описан как Blueprint,
секреты не хранятся в git (`sync: false` — значения задаются в Render UI).

> **Статус (Фаза B, 2026-07-08):** `render.yaml` — прод (main, same-origin, merge `f26fed7`);
> сервис задеплоен: https://orbis-64q4.onrender.com. Раздел описывает текущую конфигурацию.

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
| `DATABASE_URL` | боевой пул API (роль `orbis_app`) | `postgresql://orbis_app.<PROD_REF>:<pwd>@<POOLER_HOST>:5432/postgres` (session-пулер) |
| `PG_PREPARE` | prepared statements для session-пулера | `true` (не секрет; для transaction-режима `:6543` было бы `false`) |
| `ORBIS_PAT_HASH` | sha256 PAT приёмочного агента | вывод `scripts/issue-pat.ts` (см. §3) |
| `ORBIS_PAT_OWNER_ID` | владелец, от чьего имени действует агент | UUID из `auth.users` |
| `ANTHROPIC_API_KEY` | ключ LLM-провайдера | `sk-ant-...` |
| `ORBIS_LLM_PROVIDER` | явный выбор провайдера (в `render.yaml` = `anthropic`) | без него пустой ключ поднял бы сервис с echo-заглушкой |
| `ORBIS_LLM_MODEL` | (опц.) модель по умолчанию | иначе дефолт `claude-sonnet-5` (`DEFAULT_ANTHROPIC_MODEL`, `apps/server/src/llm/anthropic.ts`) |
| `SUPABASE_URL` | база JWT-верификации: issuer-пиннинг + из него выводится JWKS-адрес (`auth.ts`) | `https://<PROD_REF>.supabase.co` (без завершающего слэша) |
| `SUPABASE_JWT_SECRET` | верификация JWT (HS256, fallback к JWKS) | из Supabase `Project Settings → API`. Если проект на асимметричных ключах (ES256/JWKS) — **не задавать**: путь мёртв, а знающий секрет подделает токен владельца. Срабатывание фолбэка в проде пишет предупреждение в лог |
| `SUPABASE_JWKS_URL` | (опц.) явный override JWKS; в `render.yaml` НЕ задаётся — дефолт `{SUPABASE_URL}/auth/v1/.well-known/jwks.json` | обычно не нужен |
| `VITE_SUPABASE_URL` | build-env web-клиента | `https://<PROD_REF>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | build-env web-клиента | anon-ключ прод-проекта |

`VITE_API_URL` не задаётся (режим A same-origin: клиент бьёт в относительный `/trpc`).
`PORT` тоже не задаётся: его инжектит Render, а `index.ts` имеет дефолт `3001`.

Отдельно для бэкапа — GitHub Actions secret `ADMIN_DSN` и переменная `BACKUP_PUBLIC_KEY`
(см. §4), НЕ в Render.

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

> **Репозиторий `qvenge/orbis` — публичный.** Artifact любого Actions-рана в публичном
> репозитории скачивается посторонними, поэтому дамп выгружается **только зашифрованным**
> (OpenPGP, публичный ключ владельца). Незашифрованный дамп на раннер не попадает: гейт
> ключа стоит до `pg_dump`, а plain-файл удаляется сразу после шифрования.
> Альтернатива, снимающая проблему в корне, — сделать репозиторий приватным (решение владельца).

### 4.1 Автоматический (GitHub Actions cron)

Workflow `.github/workflows/backup.yml`: `pg_dump` прод-БД через session-пулер `:5432`
ежедневно в 03:00 UTC + ручной запуск (`workflow_dispatch`). Зашифрованный дамп грузится
как artifact `orbis-db-backup` (файл `orbis-backup-<ts>.sql.gpg`, retention 30 дней).

**Гейт 1 — секрет `ADMIN_DSN`** (Фаза B): `Settings → Secrets and variables → Actions →
Secrets → New repository secret`, значение — session-пулерный DSN роли `postgres`
(не `orbis_app` — для дампа нужна роль-владелец):

```
postgresql://postgres.<PROD_REF>:<pwd>@<POOLER_HOST>:5432/postgres
```

**Гейт 2 — переменная `BACKUP_PUBLIC_KEY`**: armored OpenPGP **публичный** ключ владельца
(`Settings → Secrets and variables → Actions → Variables`). Приватный ключ на GitHub не
хранится — компрометация аккаунта GitHub не раскрывает бэкапы, но и **потеря приватного
ключа делает все дампы нечитаемыми**: экспортируй его в надёжное место сразу.

```bash
# одноразово, на машине владельца
gpg --quick-generate-key "orbis-backup" default default never
gpg --armor --export orbis-backup > backup-pub.asc     # содержимое → в BACKUP_PUBLIC_KEY
gpg --armor --export-secret-keys orbis-backup > backup-priv.asc   # хранить офлайн, не в репо
```

Без любого из гейтов первый шаг workflow падает с явной ошибкой, а не молча.
Ручной прогон: `Actions → backup → Run workflow`.

### 4.2 Ручной бэкап

```bash
ADMIN_DSN='postgresql://postgres.<PROD_REF>:<pwd>@<POOLER_HOST>:5432/postgres' \
  BACKUP_DIR=./backups \
  bash scripts/backup.sh
```

Скрипт: `pg_dump --no-owner --no-privileges` через session-пулер; требует `pg_dump >= PG17`
(иначе автоматически дампит через `docker run postgres:17-alpine`); проверяет, что дамп непуст
и содержит таблицу `entities` (маркер целостности прод-схемы); печатает путь строкой `dump: <path>`.
Пароль/DSN в вывод не попадают. Шифрование здесь не выполняется (это делает workflow):
`./backups` и `orbis-backup-*.sql` внесены в `.gitignore`/`.dockerignore`, но локальный
дамп — это открытые прод-данные, храни его соответственно.

### 4.3 Восстановление

Artifact из Actions расшифровывается приватным ключом владельца (§4.1):

```bash
gpg --decrypt orbis-backup-<ts>.sql.gpg > orbis-backup-<ts>.sql
```

Плейн-SQL дамп (`.sql`) восстанавливается через `psql`. Восстанавливать в ЧИСТУЮ БД
(новый Supabase-проект или пересозданная схема), иначе конфликты по существующим объектам.

> **`psql` обязан понимать `\restrict`.** Начиная с релизов 17.6 / 16.10 / 15.14 / 14.19 / 13.22
> (август 2025) `pg_dump` обрамляет дамп директивами `\restrict` … `\unrestrict`. Более старый
> `psql` встретит их как неизвестные мета-команды и с `ON_ERROR_STOP=1` оборвёт восстановление
> на первой же строке. Проверить: `psql --version`. Если версия ниже — восстанавливать через
> контейнер: `docker run --rm -i -v "$PWD:/in" postgres:17-alpine psql "<DSN>" -v ON_ERROR_STOP=1 -f /in/orbis-backup-<ts>.sql`.

```bash
psql 'postgresql://postgres.<TARGET_REF>:<pwd>@<POOLER_HOST>:5432/postgres' \
  -v ON_ERROR_STOP=1 -f orbis-backup-<ts>.sql
```

Проверка после восстановления — все 8 таблиц прод-схемы на месте:

```bash
psql "$ADMIN_DSN" -c "\dt public.*"
# ожидаемо: entities, relations, aspect_definitions, user_settings,
#           chat_threads, chat_messages, ai_usage, entity_origins
```

**Владелец получит НОВЫЙ UUID.** `owner_id` логически ссылается на `auth.users` (FK нет —
схемой auth владеет Supabase), а дамп её не содержит: после регистрации в новом проекте
RLS спрячет все восстановленные строки — база выглядит пустой при полных таблицах.
Перепривязать (7 таблиц с `owner_id`; `user_settings.owner_id` — PK, строки нового
пользователя не должны существовать):

```bash
psql "$ADMIN_DSN" -v ON_ERROR_STOP=1 <<'SQL'
\set old '<старый-uuid>'
\set new '<новый-uuid-из Authentication → Users>'
BEGIN;
UPDATE entities           SET owner_id = :'new' WHERE owner_id = :'old';
UPDATE relations          SET owner_id = :'new' WHERE owner_id = :'old';
UPDATE aspect_definitions SET owner_id = :'new' WHERE owner_id = :'old';
UPDATE user_settings      SET owner_id = :'new' WHERE owner_id = :'old';
UPDATE chat_threads       SET owner_id = :'new' WHERE owner_id = :'old';
UPDATE chat_messages      SET owner_id = :'new' WHERE owner_id = :'old';
UPDATE ai_usage           SET owner_id = :'new' WHERE owner_id = :'old';
COMMIT;
SQL
```

Затем обновить `ORBIS_PAT_OWNER_ID` в Render (старый UUID указывает в никуда).

**Про права.** Дамп снят без owner/privileges (`--no-owner --no-privileges`), но
`db:migrate` их не переприменит: журнал `drizzle.__drizzle_migrations` попадает в дамп,
и миграции считаются применёнными. Права на таблицы даёт не миграция, а `alter default
privileges` самого Supabase — они выдаются автоматически объектам, созданным ролью
`postgres` (именно ею идёт restore). Роль `orbis_app` и членство в `authenticated`
создаёт `scripts/setup-db.ts`, поэтому после restore всё равно прогоняем
`bun run db:prepare` против целевой БД: он же завершается RLS-тестом (31 pgTAP-проверка),
который упадёт, если прав не окажется.

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

> **Оба механизма отказывают вместе.** GitHub отключает cron-workflow в публичном репозитории
> после **60 дней без активности в репозитории** (прогоны cron активностью не считаются —
> нужны коммиты). Тихий проект: 60 дней → бэкапы прекращаются → ещё ~7 дней → БД на паузе,
> а artifacts старше 30 дней уже истекли. Перед отключением GitHub шлёт уведомление;
> включить обратно: `Actions → backup → Enable workflow`. Раз в пару месяцев стоит проверять,
> что последний прогон backup зелёный.

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
