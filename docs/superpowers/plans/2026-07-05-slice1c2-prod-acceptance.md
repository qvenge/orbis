# Slice 1c-2 «Прод + приёмка слайса 1» Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **СТАТУС (актуализировано 2026-07-09): ПОЧТИ ЗАКРЫТ.** HOLD снят владельцем. **Фаза A (Tasks 1–8) — DONE & MERGED** (main `ba42576`, CI green, все ревью fable). **Фаза B: Tasks 9, 10, 12 — DONE** (деплой-конфиг merged `f26fed7`; прод задеплоен 2026-07-08: https://orbis-64q4.onrender.com; Supabase PROD_REF `ceovqtdibalxnqkgedrl`, db:prepare прод — 31/31 RLS pgTAP; секреты на Render; владелец UID `b47ea644-e604-467f-adc7-8a76b5c84c7c`; PAT выпущен; web/MCP-смоук зелёные). **Task 13 — приёмка §8 (минимум) пройдена 2026-07-08**: проект «Orbis» + 4 задачи созданы агентом через `/mcp`, §7.10 проверен (batch ≤10 = preview, >10 = explicit-confirmation). **ОТКРЫТО: Task 11** (llm-smoke реальным ключом; модель по умолчанию теперь `claude-sonnet-5`), **Task 12 Step 4** (замер cold-start) и **хвосты Task 13** (полная миграция доков, демо pending→approve, отметка приёмки в PRD §8 — после LLM-гейта). Детальный лог исполнения — `.superpowers/sdd/progress.md`.
>
> **Две фазы.** **Фаза A (Задачи 1–8)** — чистый код/CI/Docker/бэкап, БЕЗ владельческих гейтов. **Фаза B (Задачи 9–13)** — инфра, деплой, приёмка §8.

**Goal:** Довести слайс 1 до прода — задеплоить веб-клиент + API на Render (Frankfurt) поверх Supabase (eu-central-1), закрыть отложенный серверный хардненинг, и принять слайс 1 по критерию §8 (агент ведёт разработку Orbis внутри Orbis).

**Architecture:** Online-first: один Render free web-сервис (Docker, Bun 1.2.7) раздаёт и API (Hono: `/trpc`, `/mcp`, `/health`), и статику веб-клиента (`apps/web/dist`) с одного origin — относительный `/trpc` клиента работает без CORS. Postgres — Supabase Free через Supavisor-пулер (session `:5432` `prepare:true`; transaction `:6543` `prepare:false`). Секреты — на Render (`sync:false`). Бэкап — `pg_dump` через session-пулер, расписание через GitHub Actions cron (free).

**Tech Stack:** Render Blueprint (`render.yaml`, Docker `oven/bun:1.2`), Supabase (Supavisor-пулер, IPv4→pooler обязателен), Hono + `@hono/node-server` статик-раздача, GitHub Actions (CI + backup cron), MCP Streamable HTTP (PAT) для приёмочного агента.

## Global Constraints

- **HOLD-дисциплина.** Не исполнять Фазу B без явного открытия владельческих гейтов (см. раздел «Владельческие гейты»). Фазу A исполнять только по отдельному «go».
- **Модель сабагентов/ревью:** минимум opus, fable свободно; ВСЕ ревью — fable (стоячая политика владельца). Коммит-трейлер `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Ветка:** новая `slice1c2-prod-acceptance` от `main` (`273e051`). Merge — no-ff в main по паттерну 1a/1b/1c-1, после зелёного CI.
- **Инварианты не ломать:** RLS-only без admin-DSN фолбэка в продуктовом коде; единственный путь мутаций агента — `/mcp`→`dispatchTool`→§7.10 (executor-мутации tRPC под `ownerOnly`); PAT hash-only/constant-time/fail-closed; деньги — decimal-строки; секреты не логируются/не персистятся в открытом виде.
- **DSN-режимы (обязательно):** боевой пул API — session-пулер `:5432` c `PG_PREPARE=true`; любой transaction-режим `:6543` — только `PG_PREPARE=false` (prepared statements несовместимы). Хост пулера — **per-project, брать из Supabase Dashboard → Connect**, кластер НЕ хардкодить: spike-проект жил на `aws-1-eu-central-1.pooler.supabase.com`, а прод `ceovqtdibalxnqkgedrl` — на `aws-0-eu-central-1.pooler.supabase.com`. Username кастомной роли через пулер — `orbis_app.<PROD_REF>`. Прямой `db.<ref>.supabase.co` — IPv6-only, НЕ используется (Render egress IPv4).
- **Bun 1.2.7 пин** везде (CI `ci.yml:30`, прод-Dockerfile) — bun 1.3.x бракует integrity lock-файла от 1.2.x.
- **CI-контракт:** каждая задача Фазы A оставляет зелёными `bun run lint` (0), `bun run typecheck` (0), `bun run test` (`--filter '*'`: web Vitest + shared bun:test + server), и `bun run db:prepare` (миграции+роль+сид+RLS) в CI. Прод-деплой не должен трогать сервер/схему/RLS сверх заявленного в задаче.
- **Владельческие гейты (вне кода, блокируют Фазу B):** Render-аккаунт + Blueprint; секреты на Render (`DATABASE_URL` прод, `ORBIS_PAT_HASH`, `ORBIS_PAT_OWNER_ID`, реальный `ANTHROPIC_API_KEY`, `SUPABASE_JWT_SECRET`/JWKS, `VITE_SUPABASE_*` build-env); решение прод-vs-spike проекта Supabase; решение по стоимости/апгрейду при неудобном cold-start.

---

## File Structure

**Фаза A (код):**
- `apps/server/src/ai/send-message.ts` — `defaultAiDeps()`→throw (Task 1); `metadata.replyTo` + replay-по-replyTo + идемпотентность retry (Task 3).
- `apps/server/src/routers/chat.ts` + `apps/web/src/features/chat/useChatThread.ts` — составной курсор `(createdAt,id)` (Task 2).
- `apps/server/src/mcp/transport.ts` — платформенный body-limit `/mcp` (Task 4).
- `.github/workflows/ci.yml` — дедуп push↔PR (Task 5); `.github/workflows/backup.yml` — cron-бэкап (Task 8).
- `Dockerfile` (НОВЫЙ, корень монорепо) — прод-образ API+статика (Task 6).
- `apps/server/src/index.ts` + `apps/server/src/server.ts` — раздача `apps/web/dist` статикой same-origin (Task 7); `apps/web/src/trpc.ts` — опциональный `VITE_API_URL` для fallback-режима B (Task 7).
- `scripts/backup.sh` (перенос из `spikes/spike-05-deploy/scripts/`), `docs/implementation/02-ops-runbook.md` (НОВЫЙ) — бэкап/восстановление/keep-warm (Task 8).

**Фаза B (инфра/деплой/приёмка):**
- `render.yaml` — полный re-point на прод (Task 10).
- `docs/implementation/02-ops-runbook.md` — деплой-runbook, секреты, PAT-выпуск (Task 10/12).
- `docs/prd/00-product.md` §8 — отметка приёмки; приёмочный лог как артефакт (Task 13).

---

# ФАЗА A — Код/CI/Docker/бэкап (без владельческих гейтов)

### Task 1: `defaultAiDeps()` → fail-fast throw

**Files:**
- Modify: `apps/server/src/ai/send-message.ts:80-86` (ленивый `defaultAiDeps()`)
- Modify: `apps/server/src/routers/ai.ts:40` (`ctx.ai ?? defaultAiDeps()`)
- Test: `apps/server/src/ai/send-message.test.ts`

**Interfaces:**
- Consumes: боевой путь всегда инжектит `ai = makeAiDeps()` в контекст (`index.ts:14`, `context.ts` поле `ai?`).
- Produces: `defaultAiDeps()` больше не собирает молчаливо боевые deps — бросает `Error('ai deps must be injected; ctx.ai is required')`.

**Контекст:** В проде `ctx.ai` всегда задан. Ленивый фолбэк — мёртвый код, маскирующий отсутствие DI. Финальное ревью 1b (`progress.md:348`) требует сузить до throw.

- [x] **Step 1: Падающий тест** — вызвать процедуру `ai.sendMessage` с `ctx.ai = undefined` → ожидать проброс ошибки (а не тихую сборку). Пример:
```ts
test('ai.sendMessage без ctx.ai — fail-fast, не тихий фолбэк', async () => {
  const caller = makeCaller({ ai: undefined });
  await expect(caller.ai.sendMessage({ threadId, id: newId(), content: 'x' }))
    .rejects.toThrow(/ai deps/i);
});
```
- [x] **Step 2: Запустить — падает** (`bunx bun test apps/server/src/ai/send-message.test.ts` — сейчас фолбэк собирается и падает иначе/не падает).
- [x] **Step 3: Реализация** — заменить тело `defaultAiDeps()` на `throw new Error('ai deps must be injected; ctx.ai is required')`; в `ai.ts:40` оставить `ctx.ai ?? defaultAiDeps()` (теперь бросит при отсутствии). Убедиться, что тесты, которым нужен `ai`, инжектят его.
- [x] **Step 4: Прогнать** server-тесты — зелёные.
- [x] **Step 5: Commit** `fix(server): defaultAiDeps fail-fast throw вместо ленивой сборки (§DI hardening)`.

---

### Task 2: Составной курсор thread `(createdAt, id)`

**Files:**
- Modify: `apps/server/src/routers/chat.ts:44-60` (`listMessages` `before`-фильтр)
- Modify: `apps/web/src/features/chat/useChatThread.ts` (клиентский курсор)
- Test: `apps/server/src/routers/chat.test.ts` (+ web: `apps/web/src/features/chat/*.test.tsx`)

**Interfaces:**
- Consumes: эталон composite-семантики — `findAnswerAfter` (`send-message.ts:294-317`, `or(gt(createdAt,after), and(eq(createdAt,after), gt(id,...)))`).
- Produces: `before`-курсор listMessages принимает `(createdAt, id)` (напр. строка `"<iso>|<id>"` или два поля) — устойчив к коллизии ms.

**Контекст:** `listMessages` сортирует `desc(createdAt), desc(id)`, но `before` фильтрует только `lt(createdAt, before)` (`chat.ts:53`). Два сообщения в одну ms на границе страницы теряются/задваиваются. Backlog Task 12 slice1a (`progress.md:162`).

- [x] **Step 1: Падающий golden-тест** — тред с ДВУМЯ сообщениями в одну и ту же `createdAt` (разные id), пагинация по границе именно между ними → оба должны появиться ровно один раз (без пропажи/дубля). Ассерт по стабильному порядку `(createdAt desc, id desc)`.
- [x] **Step 2: Запустить — падает** (текущий ms-курсор теряет одно из двух).
- [x] **Step 3: Реализация сервер** — расширить `before` до составного: принимать `before: { createdAt: string; id: string }` (или `"<iso>|<id>"`), фильтр `or(lt(createdAt, c.createdAt), and(eq(createdAt, c.createdAt), lt(id, c.id)))`. Сохранить `limit max(200)`, DESC.
- [x] **Step 4: Реализация клиент** — `useChatThread` формирует курсор из `(oldest.createdAt, oldest.id)` вместо только `createdAt`; типы wire обновить.
- [x] **Step 5: Прогнать** server + web тесты — зелёные (проверить, что существующие chat-тесты не сломаны сменой формы курсора).
- [x] **Step 6: Commit** `fix(chat): составной курсор (createdAt,id) в listMessages — устойчивость к ms-коллизии`.

---

### Task 3: Retry/idempotency contract — `metadata.replyTo`

**Files:**
- Modify: `apps/server/src/ai/send-message.ts:155-174` (replay), `:275-283` (assistant metadata), `:294-317` (`findAnswerAfter`)
- Test: `apps/server/src/ai/send-message.test.ts:469-525`

**Interfaces:**
- Consumes: `appendMessageIdempotent` (`chat/messages.ts:63-96`, ON CONFLICT по client-id → `{message, replayed}`); wire `SendMessageResult.replayed`.
- Produces: assistant-сообщение несёт `metadata.replyTo = <userMessageId>`; replay матчится по `replyTo`, не по временно́му `findAnswerAfter`.

**Контекст:** ТОП-приоритет отложенного (финал 1b `progress.md:346`). При out-of-order ретрае СТАРОГО упавшего user-сообщения `findAnswerAfter` (ближайший по времени assistant) может вернуть ЧУЖОЙ более поздний ответ. Фикс — детерминированный матч по `replyTo`. Смежное: идемпотентность `thread_post` на ретрае агента; pending-dedup по исходному `batch_id` (`progress.md:250-251`).

- [x] **Step 1: Падающий тест (out-of-order replay)** — user-сообщение A (упало без ответа), затем идёт B и получает ответ Rb; ретрай A с тем же client-id → replay НЕ должен вернуть Rb (чужой ответ). Ассерт: replay для A возвращает либо свой ответ Ra (если есть), либо честно проходит в провайдер, но НИКОГДА Rb.
- [x] **Step 2: Запустить — падает** (текущий `findAnswerAfter` вернёт Rb).
- [x] **Step 3: Реализация** — при создании assistant-сообщения писать `metadata:{ cards, replyTo: userMessage.id }` (`:281`); в replay-ветке (`:167`) искать ответ по `metadata.replyTo === appended.message.id`, а не по временно́му курсору; `findAnswerAfter` оставить как фолбэк/удалить по факту.
- [x] **Step 4: thread_post идемпотентность** — тест: ретрай агентского `thread_post` с тем же client-id не создаёт второй пост (ON CONFLICT). Дореализовать при необходимости.
- [x] **Step 5: pending-dedup по batch_id** — тест: ретрай моделью того же batch на explicit-уровне не плодит вторую pending-карточку (`progress.md:250-251`); дедуп по исходному `batch_id`.
- [x] **Step 6: Прогнать** — зелёные.
- [x] **Step 7: Commit** `fix(ai): детерминированный replay по metadata.replyTo + thread_post/pending идемпотентность (§7.9 retry contract)`.

**Смежное решение (touch-семантика треда):** сообщение в тред НЕ двигает `entities.updated_at`, поэтому курсор «что нового» (по `updated_at`) не ловит задачу, к которой пришла только инструкция без смены статуса (`progress.md:326-329`). РЕШЕНИЕ КОНТРОЛЛЕРА (ревизуемо): НЕ вводить авто-touch (это размыло бы семантику «что изменилось по существу»); «что нового» ловит смену статуса/полей, а инструкции в треде владелец видит через сам тред/бейджи. Зафиксировать это как явное поведение в приёмке §8 (Task 13), не как баг. Если владелец захочет touch — отдельный флаг в `thread_post`.

---

### Task 4: Платформенный body-limit `/mcp`

**Files:**
- Modify: `apps/server/src/mcp/transport.ts:19,62-75`
- Test: `apps/server/src/mcp/transport.test.ts`

**Interfaces:**
- Consumes: `MCP_MAX_BODY_BYTES = 1_000_000`; текущий ручной 413 по `content-length`.
- Produces: лимит применяется платформенно (Hono `bodyLimit`-middleware или рантайм-лимит), закрывая chunked-тело без `content-length`.

**Контекст:** Ручной nit (`transport.ts:62-66`, Task 10b `progress.md:307,310`): chunked без `content-length` обходит гейт. Финал 1b (`progress.md:349`).

- [x] **Step 1: Падающий тест** — POST `/mcp` с телом > лимита БЕЗ `content-length` (chunked/stream) → ожидать 413 (сейчас проскакивает).
- [x] **Step 2: Запустить — падает.**
- [x] **Step 3: Реализация** — подключить `@hono/hono` `bodyLimit({ maxSize: MCP_MAX_BODY_BYTES, onError: → 413 })` на роут `/mcp` (считает фактически прочитанные байты, не доверяя заголовку); удалить ручной NaN-nit или оставить как быстрый пред-чек. Сохранить 405-method-gate.
- [x] **Step 4: Прогнать** — зелёные (413 и для content-length, и для chunked).
- [x] **Step 5: Commit** `fix(mcp): платформенный bodyLimit /mcp закрывает chunked-обход (§MCP hardening)`.

---

### Task 5: Дедуп двойного CI (push↔PR)

**Files:**
- Modify: `.github/workflows/ci.yml:2-7`

**Контекст:** `concurrency` группирует по `github.ref`, у push и pull_request он разный → same-repo PR даёт 2 прогона (Веха-0 триаж `progress.md:51`).

- [x] **Step 1: Решение** — ограничить `push` только ветками, которые НЕ покрыты PR: напр. `on: push: {branches: [main]}` + `pull_request: {}` (feature-ветки проверяются через PR, main — через push). ЛИБО `concurrency.group: ci-${{ github.event.pull_request.number || github.ref }}` + отмена. Выбрать первый (проще, детерминированнее).
- [x] **Step 2: Правка** `ci.yml`: `on: { push: { branches: [main] }, pull_request: {} }`. (Проверить: слайсовые ветки исполняются через PR → CI на PR; прямой push в main — CI на push; двойного прогона нет.)
- [x] **Step 3: Verify** — на тестовом PR ровно один CI-ран; push в main — ровно один.
- [x] **Step 4: Commit** `ci: дедуп push↔PR (push только main, feature — через PR)`.

> Примечание: это меняет привычку «CI на любой ветке при push». Если владелец предпочитает CI на push слайсовых веток БЕЗ PR — вернуть `branches:['**']` и вместо этого дедуплить concurrency-группой. Ревизуемо владельцем.

---

### Task 6: Прод-Dockerfile монорепо

**Files:**
- Create: `Dockerfile` (корень)
- Create: `.dockerignore` (корень)

**Контекст:** Прод-Dockerfile НЕ существует — только `spikes/spike-05-deploy/Dockerfile` (standalone). Нужен образ, собирающий workspace (`@orbis/shared` + `@orbis/server`) и запускающий `apps/server/src/index.ts` (порт `PORT || 3001`, `index.ts:24`).

- [x] **Step 1: Dockerfile** (пример; уточнить по факту зависимостей):
```dockerfile
FROM oven/bun:1.2.7 AS base
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile
COPY . .
# Сборка web-статики для same-origin раздачи (Task 7)
RUN cd apps/web && bun run build
ENV NODE_ENV=production
EXPOSE 3001
CMD ["bun", "apps/server/src/index.ts"]
```
- [x] **Step 2: `.dockerignore`** — `node_modules`, `**/dist` (кроме собираемого в образе), `.git`, `supabase/.temp`, `spikes/**/.env`, `apps/server/.env`.
- [x] **Step 3: Verify локально** — `docker build -t orbis .` успешно; `docker run -e DATABASE_URL=... -e PORT=3001 -p 3001:3001 orbis` → `curl localhost:3001/health` = `{status:'ok'}` (нужен доступ к БД; допускается smoke без БД на /health, если он не бьёт в БД).
- [x] **Step 4: Commit** `feat(ops): прод-Dockerfile монорепо (Bun 1.2.7, web build + API)`.

> Зависит от Task 7 (web-раздача) — Dockerfile собирает `apps/web/dist`, а Task 7 учит API его отдавать. Порядок: 7 перед финальной проверкой 6, либо совместить.

---

### Task 7: Same-origin раздача web-статики + опц. `VITE_API_URL`

**Files:**
- Modify: `apps/server/src/index.ts` / `apps/server/src/server.ts` (роут статики)
- Modify: `apps/web/src/trpc.ts:56` (опц. абсолютный `VITE_API_URL`)
- Test: `apps/server/src/server.test.ts` (или соответствующий)

**Interfaces:**
- Consumes: собранная `apps/web/dist` (Task 6/16 slice1c1 — `dist/index.html`, ассеты, `sw.js`, `manifest.webmanifest`); клиент бьёт в относительный `/trpc` (`trpc.ts:56`).
- Produces: API отдаёт статику dist с SPA-fallback на `index.html`; `/trpc`, `/mcp`, `/health` не затронуты; клиент опц. поддерживает `VITE_API_URL` для режима B.

**Контекст (РЕШЕНИЕ КОНТРОЛЛЕРА — Вариант A same-origin, ревизуемо владельцем):** клиент уже использует относительный `/trpc` без `VITE_API_URL`. Раздача dist с того же origin из Hono → CORS не нужен, один Render-сервис, минимум подвижных частей. Вариант B (раздельные origins + CORS + `VITE_API_URL`) оставлен как fallback: добавить `VITE_API_URL` в `httpBatchLink url` (если задан — абсолютный, иначе относительный) — реализуется в этой же задаче, но CORS-middleware и второй хостинг — только если владелец выберет B.

- [x] **Step 1: Падающий тест (статика)** — GET `/` возвращает `index.html`; GET `/assets/<x>.js` отдаёт ассет; неизвестный не-API путь → SPA-fallback `index.html`; `/trpc/*`, `/mcp`, `/health` НЕ перехвачены статик-роутом.
- [x] **Step 2: Запустить — падает** (API сейчас не раздаёт статику, `index.ts` только `/trpc/*`,`/mcp`,`/health`).
- [x] **Step 3: Реализация сервер** — подключить `serveStatic` (`@hono/node-server/serve-static` или встроенный Bun-статик) с корнем `apps/web/dist`; порядок роутов: API-роуты ПЕРЕД статикой; SPA-fallback (`notFound → index.html`) ТОЛЬКО для не-API GET (не ломать 404 API). Учесть, что PWA `sw.js`/`manifest.webmanifest` отдаются с корректным content-type.
- [x] **Step 4: Реализация клиент (опц. режим B)** — `trpc.ts`: `const apiBase = import.meta.env.VITE_API_URL ?? ''; url: `${apiBase}/trpc``. Пусто → относительный (режим A). Не менять поведение по умолчанию.
- [x] **Step 5: Прогнать** server + web тесты — зелёные; `cd apps/web && bunx vite build` даёт dist; локально `docker run` (Task 6) → `curl /` = html, `curl /health` = ok, `curl -XPOST /trpc/...` работает.
- [x] **Step 6: Commit** `feat(server): same-origin раздача web-dist (SPA-fallback) + опц. VITE_API_URL клиента`.

---

### Task 8: Бэкап — перенос + cron + runbook

**Files:**
- Create: `scripts/backup.sh` (перенос из `spikes/spike-05-deploy/scripts/backup.sh`, адаптация)
- Create: `.github/workflows/backup.yml` (cron)
- Create: `docs/implementation/02-ops-runbook.md`

**Контекст:** `backup.sh` живёт в спайке, проверяет `spike_items`, `pg_dump` через session-пулер `:5432` (`--no-owner --no-privileges`, требует `pg_dump ≥ PG17`). Render cron платный → GitHub Actions cron (free). Открытые вопросы SPIKE-05 (findings:98-103).

- [x] **Step 1: Перенести + адаптировать `scripts/backup.sh`** — заменить проверку `spike_items` на реальные таблицы (напр. проверять непустоту `entities`/наличие ожидаемых таблиц в дампе); DSN через `ADMIN_DSN` env (session-пулер `postgresql://postgres.<PROD_REF>:<pwd>@<POOLER_HOST>:5432/postgres`, хост — из Dashboard проекта); пред-чек версии pg_dump (иначе `docker run postgres:17-alpine pg_dump`).
- [x] **Step 2: `.github/workflows/backup.yml`** — `on: schedule: [{cron: '0 3 * * *'}] + workflow_dispatch`; шаг `pg_dump` через `ADMIN_DSN` (secret); дамп в артефакт Actions (retention 7–30 дней). Секрет `ADMIN_DSN` — владельческий гейт (Фаза B), поэтому workflow добавляется, но реальный секрет заводится позже.
- [x] **Step 3: Runbook `docs/implementation/02-ops-runbook.md`** — секции: деплой (Blueprint, секреты, PAT-выпуск `bun scripts/issue-pat.ts`); бэкап (ручной `backup.sh` + cron + восстановление `psql < dump`); keep-warm (polling петли / апгрейд $7); пауза Supabase Free ~7 дней (restore из dashboard); health-мониторинг `/health`.
- [x] **Step 4: Verify** — `bash scripts/backup.sh` синтаксически валиден (shellcheck); workflow-yaml валиден; runbook без TBD/TODO.
- [x] **Step 5: Commit** `feat(ops): backup.sh в scripts/ + GH Actions cron + ops-runbook`.

---

# ФАЗА B — Инфра / деплой / приёмка (владельческие гейты)

> НЕ НАЧИНАТЬ без открытых гейтов: Render-аккаунт/Blueprint, секреты, реальный `ANTHROPIC_API_KEY`, решение прод-проекта Supabase.

### Task 9: Прод-Supabase — проект, роль, миграции, сид

**Владельческий гейт:** решение прод-vs-spike проекта; прод `DATABASE_URL_ADMIN` + пароль `orbis_app`.

- [x] **Step 1: Владельческое решение** — прод-проект Supabase eu-central-1 (чистый прод ИЛИ переиспользовать spike-проект `bmxofoqkksofqojnwpjx`, очистив `spike_items`). Зафиксировать `PROD_REF`. Data API — ОТКЛЮЧЁН (один путь мутаций). **РЕШЕНО: новый чистый прод-проект `ceovqtdibalxnqkgedrl` (Frankfurt, Data API off; пулер `aws-0-eu-central-1`).**
- [x] **Step 2: `db:prepare` против прода** — `DATABASE_URL_ADMIN='postgresql://postgres.<PROD_REF>:<pwd>@<POOLER_HOST>:5432/postgres' bun run db:prepare` (хост пулера — из Dashboard; прод — `aws-0-eu-central-1.pooler.supabase.com`) (миграции + роль `orbis_app` (пароль из env) + сид реестра аспектов + сид онбординга + RLS-тест). Проверить `has_schema_privilege` на `auth` (тихий провал GRANT — грабля findings:50).
- [x] **Step 3: Verify** — RLS-матрица зелёная против прод-пулера на `:5432` (`prepare:true`) И `:6543` (`prepare:false`); `pg_roles`: `orbis_app` `rolbypassrls=false,rolsuper=false`; логин `orbis_app.<PROD_REF>` через пулер проходит.
- [x] **Step 4: Зафиксировать** прод `DATABASE_URL` (session-пулер, `orbis_app`) для Render-секрета (Task 10).

### Task 10: `render.yaml` re-point на прод + секреты

**Владельческий гейт:** Render-аккаунт, Blueprint, все `sync:false` секреты.

- [x] **Step 1: Переписать `render.yaml`** — `branch: main`, `rootDir: .` (корень), `dockerfilePath: ./Dockerfile` (Task 6), `healthCheckPath: /health`, `region: frankfurt`, `plan: free`. Убрать `SPIKE_CHECK_TOKEN` и spike-rootDir.
- [x] **Step 2: envVars** (`sync:false` где секрет): `DATABASE_URL` (прод orbis_app session-пулер), `PG_PREPARE=true`, `PORT=3001`, `ORBIS_PAT_HASH`, `ORBIS_PAT_OWNER_ID`, `ANTHROPIC_API_KEY`, `ORBIS_LLM_MODEL` (опц.), `SUPABASE_JWT_SECRET`/`SUPABASE_JWKS_URL`, а также build-env для web: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (прод), `VITE_API_URL` пусто (режим A same-origin). Сверить `healthCheckPath` payload (`/health` отдаёт `{status:'ok'}`).
- [x] **Step 3: PAT-выпуск** — `bun scripts/issue-pat.ts` (печатает `ORBIS_PAT_HASH` + сырой токен ОДИН раз); сырой токен — владельцу для агента Claude Code; hash+owner_id — в Render-секреты. НЕ логировать/не коммитить сырой токен.
- [x] **Step 4: Blueprint apply** (владелец) — подключить репо, создать сервис из `render.yaml`, задать `sync:false` секреты в Render UI.
- [x] **Step 5: Commit** `feat(ops): render.yaml re-point на main — прод API+web same-origin, прод-секреты`. *(Факт: коммит `866489f`, merge `f26fed7`.)*

> **Фактическая секвенция Task 10 (как исполнено; план изначально ставил PAT-выпуск до Blueprint apply — так не работает):** Blueprint/деплой БЕЗ PAT-секретов (`/mcp` fail-closed при отсутствии `ORBIS_PAT_HASH`) → первый логин владельца в прод-web → `ORBIS_PAT_OWNER_ID` из Supabase → Authentication → Users → `bun scripts/issue-pat.ts` (генерирует только токен+хеш; owner_id скрипт НЕ знает) → `ORBIS_PAT_HASH`+`ORBIS_PAT_OWNER_ID` в Render Environment → redeploy.

### Task 11: Гейт llm-smoke реальным ключом

**Владельческий гейт:** реальный `ANTHROPIC_API_KEY`.

> **Модель:** с 2026-07-09 дефолт — `claude-sonnet-5` (`DEFAULT_ANTHROPIC_MODEL`, `apps/server/src/llm/anthropic.ts`); гейт прогонять с ней (или с явным `ORBIS_LLM_MODEL`).

- [ ] **Step 1: Прогнать** `ANTHROPIC_API_KEY=sk-... bun scripts/llm-smoke.ts` — единственный прогон живого Anthropic-маппинга (tool defs → toolCalls/stopReason/usage). Модель — `ORBIS_LLM_MODEL` или дефолт `DEFAULT_ANTHROPIC_MODEL` (`send-message.ts:76`).
- [ ] **Step 2: Verify** — content/toolCalls/stopReason/usage непусты и осмысленны; при провале — НЕ деплоить, разобраться (модель/ключ/маппинг).
- [ ] **Step 3: Зафиксировать** результат smoke в приёмочный лог (не в git-секреты).

### Task 12: Деплой + прод-smoke

- [x] **Step 1: Deploy** через Render (авто по push main после Blueprint) — дождаться живого сервиса.
- [x] **Step 2: Прод-smoke** — `curl https://<prod>/health` = `{status:'ok'}`; открыть web в браузере → login (Supabase прод) → онбординг (сид) → fast-path «обед 340» → мгновенная «⚡ без AI» → Browser список/бейджи → detail → чекбокс task → настройки (смена timezone) → «Экспорт данных» скачивает `orbis-export`. (= ручной прогон из Verification 1c-1, но на ПРОДЕ.)
- [x] **Step 3: MCP-smoke** — агентом с прод-PAT: `/mcp` initialize + `entity_query` (по `updated_at`) + один `entity.create` через §7.10 → появляется в web владельца с `actor_kind=agent`.
- [ ] **Step 4: Замер cold-start** — после 15+ мин простоя первый запрос; зафиксировать латентность в runbook; решить keep-warm vs апгрейд. *(Открыто: замер не логировался; free + polling keep-warm принят по умолчанию.)*

### Task 13: Приёмка §8 слайса 1

**Источник:** `docs/prd/00-product.md` §8/§9. Всё — в ПРОДЕ, реальным агентом Claude Code через MCP/PAT.

- [x] **Step 1:** Агент через `/mcp` (PAT) создаёт проект-сущность **«Orbis»** (`title==='Orbis'`) в проде.
- [ ] **Step 2:** Агент переносит документацию — спеки/планы как **note-сущности** (`entity.create`, note), связанные `parent` с проектом. *(Открыто: перенесён минимум — pinned-note проекта; полная миграция доков — хвост приёмки.)*
- [x] **Step 3:** Разработка слайса 2 ведётся через **задачи в Orbis**: агент двигает статусы (`entity.update`), пишет заметки (`thread_post`) в тредах.
- [x] **Step 4:** Владелец с телефона (PWA) **наблюдает** (карточки/аудит `actor_kind=agent`) и **отвечает в тредах**.
- [ ] **Step 5:** Проверить видимость/атрибуцию/обратимость действий агента (журнал §7.8, Undo, `actor_kind=agent`, `source=mcp`). *(Частично: атрибуция и §7.10-pending проверены 2026-07-08; демо pending→approve и прод-Undo — открыты.)*
- [ ] **Step 6:** Отметить приёмку в `docs/prd/00-product.md` §8 + приёмочный лог как артефакт; зафиксировать явное поведение touch-семантики треда (Task 3) как принятое. *(Открыто: отметка §8 — только после закрытия LLM-гейта, Task 11.)*

---

## Verification (вся ветка 1c-2)

- **Фаза A (автономно):** `bun run lint` (0), `bun run typecheck` (0), `bun run test` (все зелёные, включая новые тесты Task 1–4), `bun run db:prepare` (CI, зелёный), `docker build .` + `docker run` → `/health` ok и `/` отдаёт web. CI ветки/PR — ровно один прогон (Task 5).
- **Фаза B (с гейтами):** RLS-матрица зелёная против прод-пулера (Task 9); llm-smoke зелёный реальным ключом (Task 11); прод-smoke + MCP-smoke (Task 12); чек-лист §8 закрыт (Task 13).
- `grep -rn 'TBD\|TODO' docs/implementation/02-ops-runbook.md render.yaml Dockerfile` — пусто.

## Владельческие гейты (сводка — статус на 2026-07-09)

1. ✅ Render-аккаунт + Blueprint — сервис `orbis` создан из `render.yaml`, прод: https://orbis-64q4.onrender.com.
2. ✅ Секреты на Render (`sync:false`) заведены: `DATABASE_URL` (прод, orbis_app), `ORBIS_PAT_HASH`, `ORBIS_PAT_OWNER_ID`, `ANTHROPIC_API_KEY`, `SUPABASE_URL`+`SUPABASE_JWT_SECRET`, `VITE_SUPABASE_*`. Отдельно GH-секрет `ADMIN_DSN` для backup cron — проверить, что заведён (workflow падает с явной ошибкой, если нет).
3. ✅ Решение прод-vs-spike: новый чистый прод-проект `PROD_REF=ceovqtdibalxnqkgedrl`.
4. ✅ Топология web: Вариант A same-origin (реализовано в Task 7, работает в проде).
5. ✅ (по умолчанию) Стоимость/cold-start: принят free + keep-warm polling'ом агентной петли; замер cold-start (Task 12 Step 4) не логировался — при неудобстве путь апгрейда прежний (Render Starter $7 / Fly ~$2.24).
6. ✅ Бэкап: GH Actions cron + artifact (retention 30 дней).
7. ⏳ Реальный `ANTHROPIC_API_KEY` для llm-smoke локально (гейт Task 11; ключ уже стоит на Render).

## После 1c-2

**Хвосты до закрытия слайса 1 (помимо открытых шагов Tasks 11–13 выше):**
- Сброс паролей, засветившихся в транскрипте деплой-сессии 2026-07-08 (пометка в `.superpowers/sdd/progress.md`).
- RAW PAT сохранён файлом `prod-pat.txt` в scratchpad сессии деплоя — перенести в надёжное хранилище владельца и удалить файл; при сомнении — ротировать PAT (`issue-pat.ts` → сменить `ORBIS_PAT_HASH` на Render).
- Полная миграция доков в Orbis note-сущностями + демо pending→approve (хвосты Task 13).
- План слайса 2.

Слайс 1 закрыт (§8 принят) — после LLM-гейта и хвостов выше. Далее — **Слайс 2** (Budget view, recurring, Agenda-lite, CSV-импорт с дедупом через `entity_origins` — стабы уже в `packages/shared`), который по критерию §8 ведётся уже ЧЕРЕЗ Orbis (агент двигает задачи в проде). Отложенное низкого приоритета: стриминг экспорта (если упрётся в память на объёме доков), health-мониторинг/алертинг, pgTAP косвенных политик.
