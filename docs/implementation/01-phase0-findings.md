# Фаза 0 — результаты спайков (findings)

| Поле | Значение |
|---|---|
| Дата | 2026-07-03 |
| Статус | **Фаза 0 закрыта** — оба спайка доказаны |
| Код | `spikes/spike-01-rls/`, `spikes/spike-05-deploy/` (standalone bun-пакеты, история) |
| План | `docs/superpowers/plans/2026-07-03-phase0-spikes.md` |
| Решение по хостингу | `docs/prd/04-decision-log.md`, D12 |

---

## SPIKE-01: RLS через Drizzle/Bun — ДОКАЗАН

### Матрица (а)–(л) × три среды

| Проверка | local | hosted session :5432 | hosted transaction :6543 |
|---|---|---|---|
| (а) A видит только своё | ✅ | ✅ | ✅ |
| (б) чужое не читается/не пишется (42501 / 0 rows) | ✅ | ✅ | ✅ |
| (в) пул не путает identity (interleaved + A→B→A) | ✅ | ✅ | ✅ |
| (г) identity умирает с транзакцией | ✅ | ✅ | ✅ |
| (д) deny-by-default без identity | ✅ | ✅ | ✅ |
| (е) service-role вне продуктового пути | ✅ | ✅ | ✅ |
| (ж) роль без BYPASSRLS/SUPERUSER | ✅ | ✅ | ✅ |
| (з) generic plan (8 прогонов $1-запроса) | ✅ | ✅ | ✅ |
| (и) rollback-путь чист | ✅ | ✅ | ✅ |
| (к) session-гигиена; мусорные claims безопасны | ✅ | ✅ | ✅ |
| (л) контроль: admin видит данные обоих | ✅ | ✅ | ✅ |
| JWT (jose) → sub → RLS сквозной | ✅ (JWKS) | не гонялся (нет ключей в тесте; JWKS endpoint отвечает 200) | — |

Режимы: `:5432` — `prepare: true`; `:6543` — **`prepare: false` обязателен** (prepared statements несовместимы с transaction-режимом Supavisor). Кластер пулера новых проектов — **`aws-1-eu-central-1.pooler.supabase.com`** (на `aws-0` — «tenant not found»). Username кастомной роли через пулер: `orbis_app.<project-ref>` — **логинится, verify-блокер снят**.

### Принятая механика identity

`withIdentity(db, actorUserId, fn)`: `db.transaction` → `set_config('request.jwt.claims', '{"sub":…,"role":"authenticated"}', true)` → запросы. `is_local=true` гарантирует смерть контекста на commit И rollback (проверено (и)); claims — параметром, без инъекции. Роль подключения `orbis_app`: `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`. Политика — дословно шаблон PRD 01 §4.10 + `FORCE ROW LEVEL SECURITY`.

### B7-пробник: `SET LOCAL ROLE authenticated` — PASS

С членством `GRANT authenticated TO orbis_app`: изоляция держится, роль откатывается на границе транзакции, прямой `auth.uid()` доступен (у `authenticated` есть grants на схему `auth` из коробки).

**Рекомендация для Вехи 0 (T7):** модель PostgREST — `orbis_app` создавать **NOINHERIT** + членство в `authenticated` + в транзакции `SET LOCAL ROLE authenticated` вместе с claims. Это снимает граблю grants на схему auth, даёт default privileges Supabase на новые таблицы (не нужны ручные GRANT в каждой миграции) и не расширяет права `orbis_app` вне транзакций (NOINHERIT). Вариант «только claims + ручные гранты» тоже доказан и остаётся запасным.

### JWT в Bun (для T7)

Реальный access_token верифицируется **локально через jose по JWKS** (`/auth/v1/.well-known/jwks.json`) — сетевой `supabase.auth.getUser(token)` на каждый запрос не нужен. Рекомендация: T7 Вехи 0 заменить `auth.getUser` на jose-верификацию (fallback HS256 по legacy secret оставить для совместимости). Hosted JWKS отвечает 200.

### Грабли (обязательное чтение перед T5/T7)

1. **Тихий провал GRANT на чужую схему.** `GRANT USAGE ON SCHEMA auth` от `postgres` проходит как WARNING «no privileges were granted» — не ошибка. Никогда не глушить notices в админ-скриптах; после грантов проверять `has_schema_privilege()`. При этом `auth.uid()` **в политиках работает** (SQL-функция инлайнится), а прямой вызов под `orbis_app` — нет.
2. **drizzle-запросы — thenable, не Promise**: `expect(...).rejects` в bun test их не понимает; ловить try/catch, код ошибки — `e.code ?? e.cause.code`.
3. **`prepare: false` для `:6543`** — иначе named prepared statements умирают между транзакциями.
4. **RLS и владелец таблицы**: без `FORCE ROW LEVEL SECURITY` владелец обходит политики; миграции всегда включают оба флага.
5. **Прямой хост `db.<ref>.supabase.co` — IPv6-only**; всё (приложение, админ-скрипты, pg_dump) — через Supavisor.
6. **Тайм-ауты тестов против hosted**: дефолтных 5с bun test не хватает мульти-транзакционным тестам (~0.6с/транзакция из Казахстана); ставить явные таймауты.
7. **`supabase start` на macOS**: контейнер `vector` (analytics) нездоров — `[analytics] enabled = false` в config.toml.
8. **Локальный pg_dump 14 < PG17 hosted** — бэкап через `docker run postgres:17-alpine`.

### Мёртвое / вне скоупа

- Advisory locks и «PowerSync identity consistency» из AUTH-10 леджера — умерли с D1 (v3.1).
- Косвенные политики `relations`/`chat_messages` (доступ через владение связанными сущностями) — Слайс 1, покрываются pgTAP (carried-решение «pgTAP-тесты RLS в CI»).

---

## SPIKE-05: деплой-связность — ДОКАЗАН

### Итоговая топология

- **Supabase Free**, проект `Orbis`, регион **eu-central-1 (Франкфурт)** — выбор владельца без замера. **Data API отключён** при создании (принцип «один путь мутаций», PRD 01 §9.1); auto-expose новых таблиц отключён.
- **API-хостинг: Render free (Frankfurt)**, Docker (`oven/bun:1.2`), деплой Blueprint'ом (`render.yaml`) из GitHub-ветки. Прод: `https://orbis-spike05.onrender.com`.
- Подключение к БД — только Supavisor `aws-1-eu-central-1.pooler.supabase.com`: session `:5432` для персистентного API-пула; transaction `:6543` + `prepare:false` — работоспособен как запасной режим.

### Прод-проверки (2026-07-03)

| Проверка | Результат |
|---|---|
| `/health` | `{"ok":true}` |
| `/db-check` — латентность API↔DB | **3.9–4.2 мс** после прогрева (первый запрос 147 мс — установка пула); co-location подтверждён |
| `/spike-check` без токена | 401 (fail-closed + constant-time сравнение) |
| `/spike-check` с токеном | **pass: identity_via_policy, cross_user_hidden, deny_by_default, clean_checkout** — RLS-механика работает С хостинга |
| Бэкап `backup.sh` | Реальный дамп через session-пулер: 5277 строк, `spike_items` в дампе |
| Секреты | Render UI env vars (`DATABASE_URL`, `SPIKE_CHECK_TOKEN`) |
| Логи | Render: stdout, retention 7 дней (free) |
| Автодеплой | push в ветку → пересборка (проверено фиксом /spike-check) |

### Матрица провайдеров

Полная таблица с фактами на 02–03.07.2026 — `spikes/spike-05-deploy/README.md`. Сводка: Koyeb закрыт для новых (Mistral AI), Fly.io без free, Railway free не тянет 24/7 и без Франкфурта, Cloud Run троттлит idle-пул, Oracle Always Free — живой, но карта+ops. **Render** — единственное «free + без карты + Франкфурт + открытый egress».

### Принятые компромиссы и операционные правила

1. **Сон Render free**: через 15 мин без входящего HTTP; cold start ~1 мин (по докам; активно не замерялся). Митигация: polling агентной петли днём держит сервис тёплым; Supavisor штатно переживает переустановку пула. Путь апгрейда: Render Starter $7/мес или Fly.io ~$2.24/мес (нужна карта).
2. **Supabase Free пауза** после ~7 дней неактивности: при ежедневном dogfooding неактуально; после паузы — restore из dashboard.
3. **Бэкапы на Free** — только свои: `scripts/backup.sh` вручную (runbook в README спайка); автоматизация — вопрос Вехи 0/Слайса 1 (cron на Render — платный, GitHub Actions cron — бесплатная альтернатива).
4. Egress Render — IPv4: пулер обязателен (и так принято).

### Открытые вопросы для Вехи 0 / Слайса 1

1. Автоматизация бэкапа (GitHub Actions cron + артефакт?) — до первого реального массива данных.
2. Keep-warm стратегия для Render free (или ранний переход на $7/Starter при первых неудобствах cold start).
3. Мониторинг/алертинг (`/health` чекер) — минимальный, после слайса 1.
4. pgTAP-набор для косвенных политик — вместе с реальными RLS-миграциями Слайса 1.
