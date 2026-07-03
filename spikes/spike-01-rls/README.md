# SPIKE-01: RLS через Drizzle/Bun

Доказательство несущей ставки безопасности Orbis (PRD 01 §4.10, §5; carried «Механика RLS через Bun API», 04-decision-log): транзакционно-локальная identity работает на продакшен-стеке **Bun + drizzle-orm + postgres-js пул**, pooled-соединения не «текут», service-role не fallback.

## Что доказывается (матрица)

| # | Проверка |
|---|---|
| (а) | A видит только свои строки |
| (б) | Чужое не читается и не пишется (WITH CHECK 42501; UPDATE/SELECT чужого → 0 строк) |
| (в) | Interleaved- и последовательные транзакции A/B на пуле — identity не путается |
| (г) | После транзакции checkout чист: `auth.uid()` NULL, claims пусты |
| (д) | Deny-by-default: без identity — 0 строк, insert падает |
| (е) | Service-role только в тест-сетапе; `src/*` не знает admin-кред |
| (ж) | Роль `orbis_app`: NOSUPERUSER, NOBYPASSRLS |
| (з) | Generic plan: 8 прогонов параметризованного запроса не ломают изоляцию |
| (и) | Rollback-путь: исключение после `set_config` — строки нет, checkout чист |
| (к) | Session-гигиена: `current_user`/`search_path` не меняются; мусорные claims не открывают данные |
| (л) | Контроль анти-false-positive: admin видит данные обоих пользователей |

Плюс `jwt.test.ts`: реальный access_token → jose (JWKS → fallback HS256) → `sub` → `withIdentity` → RLS.

## Механика

`withIdentity(db, actorUserId, fn)`: транзакция → `set_config('request.jwt.claims', '{"sub":…,"role":"authenticated"}', true)` → запросы. `is_local=true` умирает на commit и rollback. Fallback-режим (`IDENTITY_MODE=app_setting` + `sql/02b`): политика на `current_setting('app.user_id')`.

Правило: **service key / admin DSN импортируется единственным файлом `test/setup.ts`** (и jwt-сетапом). Продуктовый путь знает только `DATABASE_URL_APP`.

## Запуск локально

```bash
bunx supabase start          # локальный стек (Docker)
cp .env.example .env         # заполнить ключи из вывода supabase start
bun install
bun scripts/setup-db.ts      # роль + таблица + политика (идемпотентно)
bun test
```

## Запуск против hosted (SPIKE-05, шаг C3)

В `.env`: hosted-DSN через Supavisor (`aws-0-<region>.pooler.supabase.com`), username вида `orbis_app.<project-ref>`.
- session-пулер `:5432` — `PG_PREPARE=true`
- transaction-пулер `:6543` — `PG_PREPARE=false` (prepared statements несовместимы с transaction-режимом)
