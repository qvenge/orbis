# Слайс 1b «AI + MCP» — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Работающая агентная петля на локальном стеке: внутренний AI-чат (`ai.sendMessage` с tool-циклом, политикой подтверждений §7.10 и метерингом) и MCP-сервер (PAT, тот же реестр тулов, паттерн «что нового») — всё поверх принятого ядра 1a, проверяемо интеграционными тестами без реального LLM в CI.

**Architecture:** Слайс 1 = три плана; 1a (серверное ядро) влит в main (fa3f3a4). 1b добавляет два транспорта к одному tool-executor'у (PRD 01 §9.2): LLM-петлю внутреннего чата (§7) и MCP-адаптер для внешних агентов (§9.3). Ни один транспорт не получает собственной бизнес-логики: tool-call любого происхождения → классификатор политики §7.10 → executor → журнал → Undo. LLM-провайдер — за интерфейсом `LLMProvider` (типы Вехи 0), реализация поверх Vercel AI SDK, типы SDK наружу не текут (D7/§7.7). План 1c (Web UI + прод + приёмка слайса) — после merge 1b.

**Tech Stack:** всё из 1a + Vercel AI SDK (`ai` + `@ai-sdk/anthropic`), `@modelcontextprotocol/sdk` (Streamable HTTP), SHA-256 PAT (Bun.CryptoHasher / crypto.subtle).

## Global Constraints

Наследуются все Global Constraints плана 1a (Bun 1.2.7, `bun run test` из корня, D11-нейминг, decimal-строки, «один путь мутаций», RLS-only, инъекция времени/провайдера в тестах, дословные значения из PRD, порт 3210 для смоуков, коммит на задачу). Дополнительно для 1b:

- **LLM-вызовы вне детерминированного CI** (carried-решение): CI гоняет только echo/скриптованный провайдер; реальный Anthropic-вызов — отдельный ручной смоук-скрипт, не тест.
- **Запрет free-form JSON extraction** (carried): структурированные данные — только через native tool calling; парсинг JSON из текста ответа модели запрещён.
- **Лимит multi-step-цикла** (carried): явная константа Orbis `MAX_AGENT_STEPS`, не дефолт SDK.
- **Версионированные промпты с fixture-тестами** (carried): системный промпт — версионированный модуль, изменение ломает snapshot-тест осознанно.
- **Типы Vercel AI SDK и MCP SDK не выходят** за пределы своих адаптеров (`llm/`, `mcp/`) — наружу только типы Orbis (§7.7, карта 00-архитектуры п.3).
- **Секреты**: `ANTHROPIC_API_KEY`, `ORBIS_PAT_HASH` — только env; сырой PAT нигде не логируется и не персистится (§9.3 hash-only).
- Версии `ai`/`@ai-sdk/anthropic`/`@modelcontextprotocol/sdk` пиннятся по факту установки; фактический API сверять с текущей документацией (context7), не с памятью — оба SDK быстро движутся.

---

## Контекст: что уже есть и что делает этот план

**Есть после 1a (main, CI зелёный):** executor 7 стадий (`apps/server/src/executor/`: `execute(db, req)`, `ExecutorDeps.sink`, `makeChatJournalSink`, internal-undo), envelope-схемы тулов в shared (`contracts/tools.ts`), журнал §7.8 + Undo, треды/сообщения (`chat/`), query-движок, роутеры entity/relation/chat/ai(undo)/user/aspect, реестр 7 аспектов в БД (`ai_instructions`, `tag_mappings`, JSON Schema), сидирование, экспорт, `entitlements.ts` (резолвер-скелет), `LLMProvider`-типы и echo-скелет Вехи 0 (`llm/types.ts`, `llm/provider.ts`), auth (JWKS hardened) + `errorFormatter`, таблица `ai_usage` (пустая).

**Делает 1b:** санитарные долги 1a, влияющие на контракты 1b (Task 1–2); PAT-аутентификация агентов (Task 3); реестр LLM/MCP-тулов поверх executor'а (Task 4); политика подтверждений §7.10 + pending-подтверждения (Task 5–6); реальный `LLMProvider` (Task 7); сборка контекста §7.1 + версионированные промпты (Task 8); `ai.sendMessage` с tool-циклом и метерингом (Task 9); MCP-сервер (Task 10); PRD-заплатка §12 (Task 11); сквозной e2e агентной петли (Task 12).

**НЕ делает (1c):** весь web-UI (чат-рендеринг карточек, confirmation-карточки в UI, fast-path-парсер, retry-wiring), auth-флоу клиента, PWA, деплой (re-point `render.yaml`), приёмка слайса 1 в проде, стриминг (Future, D7), suggestion chips (слайс 3), summary-сжатие истории (см. решение 6 ниже), экран памяти (слайс 2).

### Перенос из финального ревью 1a (обязательный — иначе molчаливый discard)

| Позиция триажа | Судьба в 1b |
|---|---|
| `MutationSource: 'ui'` (атрибуция журнала) | **Task 1** (код) |
| Инвариант «один action на сообщение» проверкой синка | **Task 1** (код) |
| Докстрока: лукахед вне interoperable-subset JSON Schema | **Task 1** (код, докстрока) |
| Устаревший коммент structured-ветки errorFormatter | **Task 1** (код, коммент) |
| pgTAP: user_settings/ai_usage/entity_origins поведенчески; relations SELECT/UPDATE-перенацеливание; INSERT/DELETE builtin; deny-by-default шире | **Task 2** (код) |
| Echo-тест LLM пиннит префикс/usage (обязательство Вехи 0 T8) | **Task 7** (код) |
| Вопросы PRD: `budget.limit` затенён reserved-ключом; кавычки не «гасят» date-токены; relation_delete последней derived_from + симметричный attach без ре-валидации §3.3 | **Task 11** (фиксация в PRD 01 §12 как известных ограничений с планом снятия) |
| Формат-валидация id/имён полей custom-аспектов на записи в реестр | **Task 11** (фиксация в §12; код — при появлении aspect-CRUD, Future) |
| Двойное правило коллизии id builtin/custom; асимметрия mergeAspects null-полей | **Task 11** (фиксация в §12; код — вместе с custom-аспектами) |

Группа «в план 1c» из триажа (CLIENT_OUTDATED-контракт, пагинация thread, ms-курсор, стриминг экспорта, двойной CI push+PR, NODE_ENV=production на деплое) — переносится в план 1c при его написании; продублирована в леджере.

### Ключевые проектные решения плана

1. **PAT — env, без новой таблицы.** PRD §4 фиксирует ровно 8 таблиц; §9.3 говорит «выдача через CLI/env», MVP — один токен полного доступа. Решение: `scripts/issue-pat.ts` генерирует токен `orbis_pat_<32 hex>`, печатает его ОДИН раз + SHA-256-hash; hash кладётся в env `ORBIS_PAT_HASH` (+ `ORBIS_PAT_OWNER_ID` — uuid владельца, от чьего имени действует агент). Сравнение — constant-time. Отзыв = смена env. UI/скоупы/несколько токенов — Future (00-product §10).
2. **MCP-транспорт — Streamable HTTP на `/mcp`** тем же Hono-процессом (агент работает с ноутбука против Render — remote MCP; stdio не подходит). Аутентификация — `Authorization: Bearer orbis_pat_…` до создания MCP-сессии. Интеграция SDK с Hono/Bun — исследуемая точка: имплементер сверяет фактический API SDK (context7) и выбирает адаптер (fetch-совместимый транспорт SDK или мост через node:http-совместимость Bun); контракт задачи — поведение, не конкретный клей.
3. **Имена тулов**: `/` в id аспектов запрещён в именах тулов LLM/MCP → `attach_<aspect_id с заменой / и - на _>` (`attach_orbis_task`); маппинг имя→aspect_id хранит реестр тулов, обратная нормализация не нужна.
4. **Политика §7.10 — детерминированная таблица правил MVP** (не эвристика): чтения (`entity_query`/`entity_get`) → `execute`; одиночные мутации (`entity_create`, `entity_update`, `attach_*`, `relation_create/delete`) → `execute`; `batch_execute` (масштаб bounded по §7.10) → `preview`; мутация с `archived: true` (архивация — «мягкое удаление») при `actorKind != 'owner'` и без явной команды → `explicit-confirmation`; операций bulk/внешних эффектов в реестре MVP нет — классификатор возвращает `forbidden` для неизвестного тула (fail-closed). Вход «явность намерения»: флаг `explicitCommand` передаёт вызывающий слой (в 1b: tool-call из ai.sendMessage — всегда инициатива модели → false; MCP — false; UI-мутации политику не проходят, §9.2/00-карта). Таблица расширяется в §12-заметке.
5. **Pending-подтверждения — в `chat_messages` (append-only), без новой таблицы.** `explicit-confirmation` создаёт системное сообщение-карточку с `metadata.pending: {id, payload: {tool, input}, level, actor_kind, source}`; ничего не записано в граф и журнал (§7.10). `ai.approve({pendingId})` находит сообщение containment-запросом, проверяет «не исполнено и не отклонено» (нет audit-сообщения с детерминированным id `uuidv5('approval:<owner>:<pendingId>', NS)` и нет reject-сообщения), ревалидирует состояние и исполняет payload через executor **без вызова модели**; идемпотентность повторного approve — по PK детерминированного audit-id (тот же приём, что batch §7.8). `ai.reject` — системное сообщение `{type:'confirmation_rejected', rejects: pendingId}`.
6. **История треда — rolling-окно без summary в 1b.** §7.1/§7.3 говорят «rolling + summary»; summary требует отдельных LLM-вызовов и хранения — в 1b контекст берёт последние `CONTEXT_HISTORY_LIMIT = 30` сообщений треда; summary отложен до реального переполнения (кандидат — слайс 2, вместе с экраном памяти). Фиксируется в Task 11 (§12) как осознанная фазировка — вернуть при первом дискомфорте dogfooding.
7. **`user_query` — internal-only тул чата** (§9.2): доступен LLM-циклу, отсутствует в MCP-списке. В 1b реализуется как обёртка `entity_query` + серверная агрегация sum/count по decimal-строкам (точная арифметика через `::numeric` в SQL, не JS-float).
8. **Метеринг** — upsert `ai_usage` (`ON CONFLICT (owner_id, date, model) DO UPDATE ... + excluded`) в том же процессе после каждого LLM-вызова (не в tx executor'а — метеринг не должен откатываться вместе с бизнес-отказом); дата — UTC (§4.7). Лимиты — через `resolveEntitlement` ДО вызова провайдера (`ai.requests_per_day`, `ai.tokens_per_day`, `agents.requests_per_day`); план 'dev' безлимитен, механика проверяется тестом с инжектированным резолвером.
9. **Карточки** — `metadata.cards` ответных/audit-сообщений по типам 02 §2.3 (`entity_card`, `query_result`, `confirmation_card`, `error_card`); в 1b собираются сервером как данные (рендер — 1c). `entity_list` — частный случай `query_result` c развёрнутым списком id.
10. **Ошибка провайдера/лимита** (§7.9) — структурированная ошибка `ai.sendMessage` (`LLM_UNAVAILABLE`/`LIMIT`), пользовательское сообщение уже персистировано (не теряется), очереди нет.

### Как исполнять

Ветка `slice1b-ai-mcp` от main. Локальный Supabase запущен (54322); env как в 1a (`.env.example`). Интеграционные тесты — против живой БД; LLM — только echo/scripted. Леджер — та же механика.

---

### Task 1: Санитарные долги 1a — атрибуция source, инвариант синка, докстроки

**Files:**
- Modify: `apps/server/src/executor/types.ts` (MutationSource + 'ui'), `apps/server/src/routers/entity.ts`, `apps/server/src/routers/relation.ts`, `apps/server/src/executor/journal.ts` (инвариант один-action), `packages/shared/src/schemas/aspects.ts` (докстрока лукахеда), `apps/server/src/trpc.ts` (коммент structured-ветки)
- Test: `apps/server/src/executor/journal.test.ts` (расширить), `apps/server/src/routers/entity.test.ts` (расширить)

**Interfaces:**
- Consumes: всё из 1a.
- Produces: `MutationSource = 'chat' | 'fast_path' | 'quick_capture' | 'mcp' | 'ui' | 'system'`; `entity.update`/`relation.create`/`relation.delete` пишут в журнал `source: 'ui'` (а `entity.create` — как раньше, от клиента `fast_path|quick_capture`); `JournalSink.write` бросает `VALIDATION`, если `entry.actions.length !== 1` (инвариант «один action на сообщение», на который опирается `findLastUndoable`).

- [ ] **Step 1 (RED):** тест: `entity.update` через роутер → audit-сообщение имеет `actions[0].source === 'ui'`; тест синка: попытка `write` с двумя actions → `VALIDATION` (инвариант). Оба падают.
- [ ] **Step 2 (GREEN):** расширить union + роутеры (`source: 'ui'` в ExecuteRequest этих процедур); guard в `makeChatJournalSink.write`; докстрока к `positiveDecimal` («negative lookahead — вне interoperable-subset JSON Schema draft-07; корректно для ajv/ECMA-262; при не-ECMA потребителе реестра (RE2/Go) паттерн не скомпилируется»); коммент в `trpc.ts` про то, что structured-ветка — страховка на случай изменения коэрсии cause в tRPC (фактическая защита — первый guard не-INTERNAL shape).
- [ ] **Step 3:** полная цепочка (env как в 1a) + commit `chore(1a-debts): source='ui' в журнале, инвариант один-action в синке, докстроки`.

---

### Task 2: Расширение pgTAP-покрытия RLS перед MCP-экспозицией

**Files:**
- Modify: `apps/server/test/rls/rls.pgtap.sql`

**Interfaces:**
- Consumes: миграция 0001 (политики без изменений — только тесты).
- Produces: расширенная матрица; `plan(N)` пересчитан честно.

Добавить проверки (все — в той же транзакции с ROLLBACK, фикстуры под админом):
1. `user_settings`: A видит только свою строку; B не видит строку A; INSERT с чужим owner_id → 42501.
2. `ai_usage`: A видит только свои строки; INSERT с чужим owner_id → 42501.
3. `entity_origins`: то же (уникальность (owner, namespace, external_id) не трогаем — она проверена структурно).
4. `relations` SELECT-видимость: связь A-A невидима под B (0 строк).
5. `relations` UPDATE-перенацеливание: под A `UPDATE relations SET target_id = <сущность B>` → UPDATE 0 или 42501 (WITH CHECK) — строка не изменилась (проверить повторным SELECT состояния).
6. `aspect_definitions`: INSERT builtin (`owner_id NULL`) под authenticated → 42501; DELETE builtin → DELETE 0 + строка на месте.
7. deny-by-default (без claims): 0 строк / 42501 для `user_settings`, `chat_threads`, `relations` (не только entities).

- [ ] **Step 1 (RED):** дописать проверки + новый `plan(N)` → прогон `bun run test:rls` должен остаться зелёным, если политики верны, НО сначала запусти с намеренно неверным ожиданием одной новой проверки, чтобы убедиться, что раннер ловит падение (анти-false-green самопроверка, зафиксировать в отчёте), затем поставить верные ожидания.
- [ ] **Step 2 (GREEN):** `bun run test:rls` — N/N ok, дважды (идемпотентность ROLLBACK).
- [ ] **Step 3:** полная цепочка + commit `test(rls): поведенческое покрытие user_settings/ai_usage/entity_origins, relations-перенацеливание, builtin-запись, deny-by-default шире`.

---

### Task 3: PAT-аутентификация внешних агентов

**Files:**
- Create: `scripts/issue-pat.ts`, `apps/server/src/pat.ts`
- Modify: `apps/server/src/context.ts` (распознавание PAT в Bearer), `apps/server/src/trpc.ts` (Context: `actorKind`), `apps/server/.env.example`
- Test: `apps/server/src/pat.test.ts`, `apps/server/src/context.test.ts` (расширить)

**Interfaces:**
- Consumes: `context.ts`/`auth.ts` из 1a.
- Produces:
  - `issue-pat.ts`: печатает `token: orbis_pat_<64 hex>` (32 случайных байта, `crypto.getRandomValues`) один раз + `ORBIS_PAT_HASH=<sha256 hex>`; ничего не пишет на диск;
  - `verifyPat(token: string): { ownerId: string } | null` — SHA-256(token) constant-time-сравнение с `ORBIS_PAT_HASH` (`crypto.timingSafeEqual` над байтами хешей; сам хеш выравнивает длину — тайминг не течёт), owner из `ORBIS_PAT_OWNER_ID`; отсутствие любого из env → всегда null (fail-closed);
  - `Context` расширяется: `actorKind: 'owner' | 'agent'` — Bearer с префиксом `orbis_pat_` идёт в `verifyPat` (JWT-путь не пробуется), иначе — существующий JWT-путь (`actorKind: 'owner'`);
  - `protectedProcedure` не меняется (identity есть identity); появляется `ownerOnlyProcedure` (middleware: `actorKind === 'agent'` → FORBIDDEN) — им закрываются `user.exportData`, `user.updateSettings`, `ai.approve`/`ai.reject` (подтверждение — прерогатива владельца, §7.10) и `user.seedOnboarding`.

- [ ] **Step 1 (RED):** тесты: валидный PAT → ctx `{actorUserId: owner, actorKind: 'agent'}`; битый/чужой/без env → null → UNAUTHORIZED; тайминг не ассертим (конструктивно constant-time); `ownerOnlyProcedure` под agent → FORBIDDEN; JWT-путь не регрессировал (`actorKind: 'owner'`).
- [ ] **Step 2 (GREEN):** реализация; `.env.example` += `ORBIS_PAT_HASH=`, `ORBIS_PAT_OWNER_ID=` (закомментированные, с указанием `bun scripts/issue-pat.ts`).
- [ ] **Step 3:** полная цепочка + commit `feat(auth): PAT для внешних агентов — hash-only env, constant-time, ownerOnlyProcedure (§9.3)`.

---

### Task 4: Реестр LLM/MCP-тулов поверх executor'а

**Files:**
- Create: `apps/server/src/tools/registry.ts`, `apps/server/src/tools/dispatch.ts`
- Test: `apps/server/src/tools/registry.test.ts`, `apps/server/src/tools/dispatch.test.ts`

**Interfaces:**
- Consumes: envelope-схемы shared, `execute`, `compileQuery`/`loadCatalog`/`parseQuery`, `entityGet`-логику роутера (вынести общий хелпер, если она в роутере — переиспользуй, не копируй), реестр аспектов из БД.
- Produces (контракт для Task 9 ai.sendMessage и Task 10 MCP):

```ts
// tools/registry.ts
export interface OrbisToolDef {
  name: string;                       // 'entity_query' | ... | 'attach_orbis_task' | ...
  description: string;                // для LLM/MCP; у attach_* — ai_instructions аспекта
  inputJsonSchema: Record<string, unknown>; // JSON Schema (для LLM tool defs и MCP)
  kind: 'read' | 'mutate';
  internalOnly?: boolean;             // user_query: true — не отдаётся MCP
}

/** Карточка чата (02 §2.3) — собирается сервером как данные, рендерит 1c. */
export type Card =
  | { kind: 'entity_card'; entityId: string; title: string; aspects: string[]; keyFields: Record<string, unknown>; undoActionId?: string }
  | { kind: 'query_result'; title?: string; count: number; entityIds: string[]; aggregate?: { op: 'sum' | 'count'; value: string } }
  | { kind: 'confirmation_card'; mode: 'preview' | 'explicit'; pendingId?: string; summary: string; diff?: Record<string, { before: unknown; after: unknown }> }
  | { kind: 'error_card'; code: string; message: string };
/** Собирает реестр: core-тулы §9.2 + attach_<aspect> для каждого активного аспекта (§7.6). */
export async function buildToolRegistry(tx: Tx): Promise<OrbisToolDef[]>;

// tools/dispatch.ts
export interface ToolCallCtx {
  db: Db;
  actorUserId: string;
  actorKind: 'owner' | 'ai' | 'agent';
  source: 'chat' | 'mcp';
  threadId?: string;                  // тред диалога — туда лягут audit-сообщения
  explicitCommand: boolean;           // вход политики §7.10; в 1b всегда false
  clock?: () => Date;
}
export type ToolDispatchResult =
  | { status: 'ok'; result: unknown; card?: Card }
  | { status: 'pending_confirmation'; pendingId: string; card: Card }   // §7.10 explicit-confirmation
  | { status: 'error'; error: { code: string; message: string; details?: unknown } };
export async function dispatchTool(ctx: ToolCallCtx, name: string, input: unknown): Promise<ToolDispatchResult>;
```

Семантика `dispatchTool`: (1) резолв тула по реестру (неизвестный → `error`/`VALIDATION`); (2) чтения (`entity_query`, `entity_get`, `user_query`) — без политики, под `withIdentity`; (3) мутации — `classifyToolCall` (Task 5) → `execute` / pending (Task 6) / forbidden; (4) input-схемы: core-тулы — существующие envelope-схемы shared; `attach_*` — `{entity_id, data}` (envelope) + JSON Schema аспекта в `inputJsonSchema` для модели. JSON Schema core-тулов — написать вручную в registry.ts рядом с zod-envelope (дословно §9.2; парность закрепить тестом: каждый ключ zod-схемы присутствует в JSON Schema и наоборот — механическая сверка `Object.keys`).

`user_query` (решение 7): input `{ query: string, aggregate: 'sum' | 'count', field?: string }` — компилирует запрос движком и агрегирует на SQL (`SELECT count(*)` / `SELECT sum((aspects->'<asp>'->>'<field>')::numeric)::text`); поле резолвится каталогом (тот же путь, что компилятор); результат — строка decimal / число. `internalOnly: true`.

`thread_post` (минимальное расширение реестра §9.2 — без него сценарий 9 из 02 §5 невыполним: агент обязан «писать заметки в тред задачи», а chat-роутер MCP-агенту недоступен): input `{ entity_id: uuid, content: string }`, kind `mutate`, уровень политики — как одиночная мутация (`execute`); исполнение — `ensureEntityThread` + `appendMessage` (role `user`, от актора; в metadata пометка `{author_kind: 'agent'}` при actorKind='agent'). Расширение фиксируется в PRD-заплатке Task 11.

- [ ] **Step 1 (RED):** тесты реестра: builtin-реестр даёт 7 `attach_*` + 8 core (query/get/create/update/relation_create/relation_delete/batch_execute/user_query), имена без `/`, у `attach_orbis_task` description = ai_instructions из БД, парность zod↔JSON Schema; тесты dispatch: read-тул исполняется; `entity_create` через dispatch создаёт сущность + audit в переданный threadId с `actor_kind: 'ai'`; неизвестный тул → error.
- [ ] **Step 2 (GREEN):** реализация (политику до Task 5 заглушить константой `execute` с TODO-комментарием? НЕТ — плейсхолдеры запрещены: Task 4 реализует dispatch только для read-тулов и мутаций с прямым `execute`, а ветвление по уровням добавляет Task 5, меняя одну точку — вызов классификатора; зафиксируй это в коде честным комментарием «уровни §7.10 подключает следующая задача, до неё все мутации execute» и тестом, который Task 5 ужесточит).
- [ ] **Step 3:** полная цепочка + commit `feat(tools): реестр LLM/MCP-тулов из envelope-схем и реестра аспектов + dispatch поверх executor (§7.6, §9.2)`.

---

### Task 5: Политика подтверждений §7.10 — классификатор

**Files:**
- Create: `apps/server/src/policy/confirmation.ts`
- Modify: `apps/server/src/tools/dispatch.ts` (подключение), `packages/shared/src/contracts/confirmation-policy.test.ts` → удалить (контракт закрывается настоящими тестами здесь; сослаться в отчёте)
- Test: `apps/server/src/policy/confirmation.test.ts`

**Interfaces:**
- Consumes: типы dispatch (Task 4).
- Produces:

```ts
export type ConfirmationLevel = 'execute' | 'preview' | 'explicit-confirmation' | 'forbidden';
export interface ToolCallFacts {
  tool: string;
  kind: 'read' | 'mutate';
  known: boolean;               // тул есть в реестре
  actorKind: 'owner' | 'ai' | 'agent';
  explicitCommand: boolean;     // §7.10 вход «явность намерения»
  archives: boolean;            // input содержит archived: true (mутация архивации)
  isBatch: boolean;
  batchSize?: number;
}
export function classifyToolCall(facts: ToolCallFacts): ConfirmationLevel;
```

Таблица правил MVP (решение 4 плана — ДЕТЕРМИНИРОВАННАЯ, каждый ряд — тест):

| Условие (первое совпадение сверху) | Уровень | Обоснование §7.10 |
|---|---|---|
| `!known` | `forbidden` | fail-closed: незнакомый вызов не исполняется |
| `kind === 'read'` | `execute` | чтение без внешних эффектов |
| `archives && !explicitCommand` | `explicit-confirmation` | архивация = мягкое удаление; инициатива модели/агента без прямой команды — чувствительно |
| `isBatch && batchSize > 10` | `explicit-confirmation` | масштаб приближается к bulk |
| `isBatch` | `preview` | bounded-масштаб: исполнить + информационный diff |
| иначе (одиночная мутация) | `execute` | single, обратимо (inverse в журнале) |

Извлечение фактов из вызова (`factsFromToolCall(def, input)`) — в том же модуле: `archives` — `input.archived === true` (entity_update) или любая операция batch с ним; `batchSize` — `operations.length`.

- [ ] **Step 1 (RED):** тест на каждый ряд таблицы + границы (batchSize 10 → preview, 11 → explicit; archived: false → execute; explicitCommand: true + archives → execute); удалить skip-заглушку shared.
- [ ] **Step 2 (GREEN):** реализация + подключение в dispatch: `execute`-уровень — как было; `preview` — исполнить через executor и пометить карточку `card.kind='confirmation_card'`, `card.mode='preview'` с diff-данными (для entity_update — изменённые поля до/после из inverse); `forbidden` — `error` с кодом `FORBIDDEN_LEVEL` (маппинг в TRPC 403 уже есть в errors.ts); `explicit-confirmation` — пока `error 'NOT_IMPLEMENTED_PENDING'` с честным комментарием — Task 6 заменяет на pending (тест Task 5 фиксирует текущее поведение, Task 6 его перепишет — это явная схема двух шагов, не забытый хвост).
- [ ] **Step 3:** полная цепочка + commit `feat(policy): классификатор уровней подтверждения §7.10 — детерминированная таблица MVP`.

---

### Task 6: Pending-подтверждения — explicit-confirmation без повторного вызова модели

**Files:**
- Create: `apps/server/src/policy/pending.ts`
- Modify: `apps/server/src/tools/dispatch.ts`, `apps/server/src/routers/ai.ts` (`ai.approve`, `ai.reject`)
- Test: `apps/server/src/policy/pending.test.ts`, `apps/server/src/routers/ai.test.ts` (создать/расширить)

**Interfaces:**
- Consumes: dispatch/классификатор, `appendMessage`, `batchAuditMessageId`-приём (uuidv5), executor.
- Produces:
  - `createPending(tx, {threadId, actor, tool, input, level}) → { pendingId, card }` — системное сообщение `role='system'`, `metadata.pending = { id: pendingId (uuidv7), tool, input, actor_kind, source, created_at }` + `metadata.cards=[confirmation_card {mode:'explicit'}]`; **ничего в граф и журнал** (§7.10);
  - `ai.approve({ pendingId }) → ExecuteResult-обёртка` (ownerOnlyProcedure): найти pending-сообщение containment'ом (RLS скоупит владельцем), проверить не-исполненность (нет audit-сообщения с id `uuidv5('approval:<owner>:<pendingId>', ORBIS_NAMESPACE)`) и не-отклонённость (нет сообщения `{type:'confirmation_rejected', rejects: pendingId}`), **ревалидация текущего состояния** и исполнение сохранённого payload через executor (audit-сообщение с детерминированным id — идемпотентность повторного approve по PK, как batch §7.8), без обращения к LLM;
  - `ai.reject({ pendingId })` — reject-сообщение; повторный approve после reject → `VALIDATION` «отклонено».

- [ ] **Step 1 (RED):** тесты: explicit-уровень из dispatch создаёт pending-сообщение и НЕ трогает граф/журнал; approve исполняет payload (сущность заархивирована), audit-сообщение с детерминированным id, карточка; повторный approve → идемпотентный replay (не второй эффект); approve после reject → ошибка; approve чужого pendingId (userB) → NOT_FOUND (RLS); ревалидация: если сущность payload'а уже удалена/изменилась несовместимо — структурная ошибка, не тихий провал; PAT-агент не может approve (FORBIDDEN — ownerOnly, Task 3).
- [ ] **Step 2 (GREEN):** реализация; dispatch: `explicit-confirmation` → `{status:'pending_confirmation', pendingId, card}` (заменяет заглушку Task 5, тест Task 5 обновить).
- [ ] **Step 3:** полная цепочка + commit `feat(policy): pending-подтверждения — immutable payload, approve без LLM, идемпотентность по PK (§7.10)`.

---

### Task 7: LLMProvider — Anthropic поверх Vercel AI SDK + echo/scripted для тестов

**Files:**
- Create: `apps/server/src/llm/anthropic.ts`, `apps/server/src/llm/scripted.ts`
- Modify: `apps/server/src/llm/provider.ts` (echo остаётся; выбор провайдера — фабрика `makeLLMProvider()` по env), `apps/server/src/llm/provider.test.ts` (усилить: пин префикса/usage — обязательство Вехи 0), `apps/server/package.json` (deps `ai`, `@ai-sdk/anthropic`)
- Create: `scripts/llm-smoke.ts` (ручной смоук с реальным ключом — НЕ тест)
- Test: `apps/server/src/llm/anthropic.test.ts` (только маппинг типов, без сети)

**Interfaces:**
- Consumes: `LLMProvider`/`LLMRequest`/`LLMResponse`/`LLMToolCall` (типы Вехи 0 — НЕ менять: наружу только они, §7.7).
- Produces:
  - `AnthropicProvider implements LLMProvider` — `generateText` из `ai` с `tools` (JSON Schema тулов Orbis → формат SDK через `jsonSchema()`-хелпер SDK), маппинг ответа: `content`, `toolCalls[{id,name,input}]`, `usage{inputTokens,outputTokens}`, `stopReason` (`'end_turn'|'tool_use'|'max_tokens'` из finishReason SDK); модель — env `ORBIS_LLM_MODEL` (default `'claude-sonnet-4-5'`), ключ — `ANTHROPIC_API_KEY`; **вызов ровно одного шага** (без maxSteps SDK — цикл ведёт Task 9, лимит — наша константа);
  - `ScriptedProvider(script: LLMResponse[])` — отдаёт ответы по очереди, записывает полученные `LLMRequest` для ассертов (главный провайдер интеграционных тестов Task 9/12);
  - `makeLLMProvider(): LLMProvider` — env `ORBIS_LLM_PROVIDER` = `'anthropic' | 'echo'` (default echo при отсутствии ключа — fail-safe для dev);
  - фактический API SDK сверить с документацией (context7 `ai`, `@ai-sdk/anthropic`) — версии и нюансы (`finishReason`-значения, формат tool definitions) зафиксировать в отчёте.

- [ ] **Step 1 (RED):** усилить echo-тест: пин формата префикса ответа и usage (точные числа для известного входа — обязательство Вехи 0 T8); тесты маппинга AnthropicProvider — через инжекцию мок-`generateText`-функции? НЕТ моков сети: выдели чистую функцию `mapSdkResult(sdkResult) → LLMResponse` и тестируй её на литеральных структурах формата SDK (форму взять из доков и зафиксировать фикстурами); scripted-тесты.
- [ ] **Step 2 (GREEN):** реализация + `scripts/llm-smoke.ts` (один реальный вызов с ANTHROPIC_API_KEY из env, печатает ответ и usage; прогнать вручную один раз, вывод — в отчёт задачи; в CI не входит).
- [ ] **Step 3:** полная цепочка + commit `feat(llm): AnthropicProvider поверх Vercel AI SDK + scripted-провайдер; типы SDK не текут наружу (§7.7)`.

---

### Task 8: Сборка контекста §7.1 и версионированный системный промпт

**Files:**
- Create: `apps/server/src/llm/prompts/v1.ts`, `apps/server/src/llm/context.ts`
- Test: `apps/server/src/llm/prompts/v1.test.ts` (snapshot), `apps/server/src/llm/context.test.ts`

**Interfaces:**
- Consumes: треды/сообщения, memory-сущности (entity_query по аспекту), реестр аспектов (ai_instructions), `wire.ts`.
- Produces:
  - `SYSTEM_PROMPT_V1: string` — статика слоя 1: правила поведения (русский язык пользователя; создавай сущности тулами, не описывай намерения; деньги — decimal-строки; category_ref — только uuid реальной категории через entity_query; **соглашение meta-ключей §3.9 дословно**: имена ключей meta = имена полей аспектов) + плейс для инструкций аспектов; версия в имени — изменение промпта = новый файл vN + осознанное обновление snapshot (carried-решение);
  - `buildContext(tx, { ownerId, threadId, anchorEntityId?: string }) → { system: string; messages: LLMMessage[] }`:
    - слой 1: `SYSTEM_PROMPT_V1` + `ai_instructions` активных аспектов из реестра;
    - слой 2: активные (не archived) `orbis/memory`-сущности, кап `MEMORY_CAP = 50`, приоритет: `kind=rule` раньше `fact`, scoped — раньше глобальных (§7.4); формат инжекции — компактный список «— [rule|fact] title: body» в system;
    - слой 3: якорная сущность треда (title, tags, аспекты, превью body 500 симв.) — если тред сущности;
    - слой 4: последние `CONTEXT_HISTORY_LIMIT = 30` сообщений треда (user/assistant; system-audit — компактно как «[действие: entity_created …]», чтобы модель видела свою историю действий), решение 6 плана — без summary;
    - слой 5 — не здесь: определения тулов передаёт Task 9 из реестра.

- [ ] **Step 1 (RED):** snapshot-тест промпта (осознанная фиксация текста); тесты buildContext против живой БД: память инжектится с капом и приоритетом (создать 3 memory: глобальный fact, scoped rule, archived — archived не попадает, rule раньше fact); якорь появляется только для треда сущности; история обрезается до 30; audit-сообщения сжаты, а не как сырой JSON.
- [ ] **Step 2 (GREEN):** реализация.
- [ ] **Step 3:** полная цепочка + commit `feat(llm): пятислойный контекст §7.1 — версионированный промпт v1, память с капом, якорь, rolling-история`.

---

### Task 9: `ai.sendMessage` — tool-цикл, карточки, метеринг, деградация

**Files:**
- Create: `apps/server/src/ai/send-message.ts`, `apps/server/src/ai/metering.ts`
- Modify: `apps/server/src/routers/ai.ts`, `apps/server/src/index.ts` (провайдер в зависимостях), `packages/shared/src/constants.ts` (`MAX_AGENT_STEPS`)
- Test: `apps/server/src/ai/send-message.test.ts` (scripted-провайдер, живая БД)

**Interfaces:**
- Consumes: `LLMProvider` (Task 7), `buildContext` (Task 8), `buildToolRegistry`/`dispatchTool` (Task 4–6), `appendMessage`, `resolveEntitlement`, `ai_usage`-схема.
- Produces:
  - `ai.sendMessage({ id, threadId, content }) → { assistantMessage: WireChatMessage; actions: ActionSummary[]; pending: PendingSummary[] }` — обычная мутация, ответ целиком (D7, без стриминга);
  - `MAX_AGENT_STEPS = 8` (shared constants; carried-решение);
  - `recordUsage(db, { ownerId, model, usage })` — upsert `ai_usage` `ON CONFLICT (owner_id, date, model) DO UPDATE SET input_tokens = ai_usage.input_tokens + excluded...` (решение 8: вне tx executor'а, дата UTC).

Алгоритм sendMessage (каждый пункт — проверяемое поведение):
1. entitlements-гейт `ai.requests_per_day`/`ai.tokens_per_day` ДО вызова (dev безлимитен; тест — с инжектированным резолвером, отдающим лимит 0 → `LIMIT`/429, пользовательское сообщение при этом уже персистировано);
2. персист user-сообщения (идемпотентно по client-id — путь Task 12 1a);
3. `buildContext` + `buildToolRegistry` → первый вызов провайдера;
4. цикл: пока `stopReason === 'tool_use'` и шаг ≤ `MAX_AGENT_STEPS`: каждый tool-call → `dispatchTool(ctx с source:'chat', actorKind:'ai', explicitCommand:false)`; результат (`ok`→данные, `pending_confirmation`→карточка-заглушка «ждёт подтверждения», `error`→структурная ошибка) сериализуется в tool-result сообщение следующего запроса; превышение лимита шагов — принудительный финальный ответ с пометкой (не ошибка);
5. персист assistant-сообщения: `content` = финальный текст, `metadata.cards` = карточки всех действий цикла (audit-сообщения своих действий уже написал executor через dispatch — assistant-сообщение их НЕ дублирует в actions, только cards для рендера 1c);
6. `recordUsage` суммарно по всем шагам;
7. сбой провайдера (`throw` из provider.chat) → структурная ошибка `LLM_UNAVAILABLE` (маппинг 503 в errors.ts добавить), user-сообщение сохранено, ничего не потеряно (§7.9), очереди нет.

- [ ] **Step 1 (RED):** интеграционные тесты со ScriptedProvider: (а) сценарий «создай задачу»: script = [tool_use entity_create, end_turn «Готово»] → сущность в БД, audit-сообщение, assistant-сообщение с entity_card, `ai_usage` инкрементирован суммой двух шагов; (б) tool-цикл из 2 вызовов (query → create); (в) лимит шагов: script из 10 tool_use → цикл остановлен на 8, финал с пометкой; (г) провайдер бросает → `LLM_UNAVAILABLE`, user-сообщение в БД; (д) entitlements-лимит 0 → 429 до вызова провайдера (scripted не тронут — ассерт по записанным запросам); (е) explicit-confirmation внутри цикла (script: batch archived) → pending-карточка в ответе, граф не тронут; (ж) `user_query` sum по decimal — точная строка.
- [ ] **Step 2 (GREEN):** реализация.
- [ ] **Step 3:** полная цепочка + commit `feat(ai): sendMessage — tool-цикл с лимитом шагов, карточки, метеринг ai_usage, деградация §7.9 (D7)`.

---

### Task 10: MCP-сервер — тонкий адаптер над реестром тулов

**Files:**
- Create: `apps/server/src/mcp/server.ts`, `apps/server/src/mcp/transport.ts`
- Modify: `apps/server/src/index.ts` (маунт `/mcp`), `apps/server/package.json` (dep `@modelcontextprotocol/sdk`)
- Test: `apps/server/src/mcp/mcp.test.ts` (MCP-клиентом из того же SDK против поднятого сервера)

**Interfaces:**
- Consumes: `verifyPat` (Task 3), `buildToolRegistry`/`dispatchTool` (Task 4–6), реестр без `internalOnly`.
- Produces:
  - `/mcp` — Streamable HTTP endpoint в том же Hono-приложении; каждый запрос: Bearer `orbis_pat_…` → `verifyPat` → 401 при провале (ДО любой MCP-логики, fail-closed);
  - MCP `tools/list` = реестр минус `internalOnly` (7 attach + 7 core, без `user_query`); имена/описания/inputSchema — как в реестре;
  - MCP `tools/call` → `dispatchTool(ctx { actorKind:'agent', source:'mcp', explicitCommand:false, threadId: undefined → audit в глобальный тред владельца })`; результат — текстовый JSON-контент MCP; `pending_confirmation` — честный ответ агенту «действие ждёт подтверждения владельца, pendingId=…» (isError: false — это не сбой); ошибки — структурный текст (код+сообщение, без SQL — errorFormatter-гигиена сюда не достаёт, отдельно проверить, что dispatch не пропускает сырых ошибок);
  - решение 2 плана: фактический API SDK (`McpServer`, `StreamableHTTPServerTransport` или fetch-адаптер) сверить с context7-доками; выбранный клей и версию зафиксировать в отчёте; **никакой бизнес-логики в адаптере** (карта 00-арх, п. 7–8).

- [ ] **Step 1 (RED):** интеграционный тест: поднять Hono-приложение на свободном порту (in-test), MCP-клиент SDK с PAT: `tools/list` — состав и отсутствие `user_query`; `tools/call entity_create` → сущность в БД с audit `actor_kind:'agent'`, `source:'mcp'`, системное сообщение в глобальном треде владельца (02 §2.3 — действия агентов видимы владельцу); `tools/call` batch(11 операций archived) → pending-ответ, граф чист; без PAT/с битым PAT → 401; **паттерн «что нового» работает без нового механизма**: entity_update сущности владельцем → `tools/call entity_query {query: "updated_at>— курсор"}` находит её, `entity_get include:['thread']` отдаёт сообщение владельца из треда (§9.3, сценарий 2 дословно).
- [ ] **Step 2 (GREEN):** реализация.
- [ ] **Step 3:** полная цепочка + commit `feat(mcp): Streamable HTTP MCP-сервер — PAT, реестр тулов §9.2, политика §7.10, журнал с actor=agent (§9.3)`.

---

### Task 11: PRD-заплатка §12 — известные ограничения, вскрытые 1a

**Files:**
- Modify: `docs/prd/01-architecture.md` (§12 «Известные ограничения» — добавить пункты 7–10)

**Interfaces:** только документ; формулировки — в стиле существующих пунктов §12 («фиксируются честно — осознанные компромиссы»).

Добавить пункты (нумерация продолжается после 6):
7. **Поле `orbis/budget.limit` затенено reserved-ключом грамматики `limit`** — фильтрация/сравнение по лимиту конверта грамматикой §6.1 невыразимы (правило резолва «сначала зарезервированные ключи»). Снятие — вместе с Budget-view слайса 2 (алиас поля или переименование reserved-ключа) — решение при написании плана слайса 2.
8. **Кавычки не «гасят» относительные date-токены**: литеральное строковое значение `today`/`overdue`/`next_7d`/`after_7d` в поле типа date/timestamp невыразимо. Для встроенных аспектов коллизий нет; для будущих кастомных аспектов — пересмотреть лексику кавычек до их появления.
9. **`relation_delete` последней `derived_from`-связи не ре-валидирует §3.3 target-сущности** (достижима «сирота» с `recurring=true` без recurrence/derived_from; симметрично — attach `orbis/financial` к сущности с ранее накопленными budget-parent'ами). Точка enforcement — запись аспекта; следующая правка сущности упрётся в INVARIANT. Снятие — вместе с recurring-материализацией слайса 2.
10. **Кастомные аспекты: реестр не валидирует формат id/имён полей на записи, правила коллизии id builtin/custom различаются между attach-резолвом и валидатором, merge-семантика null-полей асимметрична create/update.** Всё недостижимо в MVP (aspect-CRUD отсутствует); обязательный чек-лист задачи, которая введёт пользовательские аспекты (Future, 00-product §10).

Плюс — примечание к §9.2 (не §12): реестр тулов дополнен `thread_post { entity_id, content }` — заметка в тред сущности; без него сценарий 9 (02 §5) невыполним для MCP-агента. Одна строка в таблице core-тулов §9.2 с той же нотацией.

- [ ] **Step 1:** внести пункты; `grep -n '^7\.\|^8\.\|^9\.\|^10\.' docs/prd/01-architecture.md` в секции §12 подтверждает.
- [ ] **Step 2:** commit `docs(prd): §12 — известные ограничения, вскрытые исполнением слайса 1a (грамматика, derived_from, кастомные аспекты)`.

---

### Task 12: Сквозной e2e агентной петли (сценарий 9 из 02 §5, локально)

**Files:**
- Create: `apps/server/test/e2e.slice1b.test.ts`

**Interfaces:**
- Consumes: всё собранное; MCP-клиент SDK; ScriptedProvider для внутреннего чата.

Сценарий (последовательные шаги, владелец = tRPC-caller, агент = MCP-клиент с PAT):
1. Сид владельца; агент через MCP создаёт проект «Orbis» + 2 задачи (`entity_create` + `relation_create parent`) + note-сущность с документацией — в глобальном треде владельца появились системные audit-сообщения с `actor_kind:'agent'` (02 §2.3);
2. Владелец пишет инструкцию в тред задачи 1 (`chat.ensureThread({entityId}) + appendUserMessage`);
3. Агент выполняет петлю «что нового»: `entity_query(updated_at > курсор₀)` находит задачу 1 (тред обновил `updated_at` сущности? НЕТ — сообщение треда не трогает `entities.updated_at`; агент находит задачу по своему прошлому знанию или по `updated_at` треда — **это известный нюанс §9.3**: инструкция в треде без правки сущности не двигает `entities.updated_at`. Разрешение для e2e и жизни: владелец, оставляя инструкцию, обычно меняет статус/поле задачи (в тесте: `entity.update` статуса на `in_progress` после сообщения) — курсор ловит; нюанс зафиксировать в отчёте задачи и в леджере для плана 1c/2 (кандидат: `touch`-семантика треда));
4. Агент: `entity_get(id, include:['thread'])` читает инструкцию → `entity_update` статуса в `done` (+`completed_at` нормализуется) → заметка в тред задачи (`chat.appendUserMessage`? нет — агент через MCP не имеет chat-тулов; заметка = `entity_update` body? По 02 §2.2 заметки агента живут в треде. В реестре §9.2 нет тула тредов! Сценарий 9 02 §5 говорит «пишет заметки в тред задачи». **Развилка плана**: добавить core-тул `thread_post` в реестр (input `{entity_id, content}`, kind mutate, уровень execute) — минимальное расширение §9.2, без него сценарий 9 невыполним по PRD-букве. Решение: добавить в Task 4 реестр (`thread_post` → `ensureEntityThread` + `appendMessage` от актора-агента) и зафиксировать расширение в Task 11 (§12 или прим. к §9.2). Тест здесь использует его);
5. Владелец: `ai.undoLast` гасит последнее действие агента (Undo для агентов — 02 §2.3), затем повторный `entity_update` возвращает статус;
6. Агент: bulk-попытка (batch 11 архиваций) → pending; владелец `ai.approve` → исполнено; журнал/карточки на месте;
7. Внутренний чат владельца (ScriptedProvider): «что по задачам?» → script `entity_query` → ответ с `query_result`-карточкой; `ai_usage` инкрементирован;
8. Экспорт владельца содержит проект/задачи/note/треды с сообщениями агента.

- [ ] **Step 1:** ВНИМАНИЕ — шаг 4 требует правки Task 4 (тул `thread_post`): если исполняешь этот план по порядку, Task 4 уже включил его (см. интерфейсы Task 4 — добавь `thread_post` туда при исполнении; это отражено здесь, чтобы порядок задач остался честным). Если Task 4 закоммичен без него — мини-дифф в рамках этой задачи с отдельным упоминанием в отчёте.
- [ ] **Step 2:** e2e-тест по шагам; полная CI-цепочка; HTTP-смоук `/mcp` (tools/list курлом с PAT — 200/401 без).
- [ ] **Step 3:** commit `test(e2e): агентная петля слайса 1b — MCP-агент ведёт проект, владелец подтверждает и откатывает (02 §5 сценарий 9)`.

---

## Verification (приёмка плана целиком)

1. CI зелёный на ветке `slice1b-ai-mcp` (живой прогон Actions — гейт, как в 1a).
2. Сценарий 9 из 02 §5 воспроизводим локально e2e-тестом (Task 12) — включая «что нового», политику, Undo действий агента.
3. Ни одного вызова реального LLM в CI (grep `ANTHROPIC_API_KEY` в тестах — только smoke-скрипт); scripted/echo покрывают цикл.
4. Политика §7.10: каждый ряд таблицы решений — именованный тест; `explicit-confirmation` не оставляет следа до approve; approve идемпотентен; MCP и внутренний чат проходят ОДИН классификатор (§7.10 «правила едины» — тест, вызывающий оба пути на одном payload).
5. Типы SDK не текут: grep импортов `'ai'`/`@ai-sdk/`/`@modelcontextprotocol/` вне `llm/`/`mcp/` — пусто.
6. Перенос триажа 1a: таблица «Перенос из финального ревью» — каждая строка закрыта своей задачей (Task 1/2/7/11); группа «в план 1c» остаётся в леджере.
7. `grep -rn 'TODO\|FIXME' apps/server/src packages/shared/src` — пусто.
8. Обязательство Вехи 0 «echo-тест пиннит префикс/usage» закрыто (Task 7).

## Критические файлы и документы

- `docs/prd/01-architecture.md` §7 (AI-слой: §7.1 контекст, §7.4 память, §7.6 динамические тулы, §7.7 модель/транспорт D7, §7.8 журнал, §7.9 деградация, §7.10 политика), §9.2–9.3 (реестр тулов, MCP, «что нового»), §8 (entitlements), §4.7 (ai_usage);
- `docs/prd/02-core-os.md` §2 (чат, карточки §2.3, треды §2.2), §5 сценарий 9 (приёмочный);
- `docs/prd/04-decision-log.md` D5–D7 (MCP, политика, транспорт), carried-решения (промпты, лимиты циклов, LLM вне CI);
- `.superpowers/sdd/progress.md` — секция slice1a: триаж финального ревью (перенос), нюанс «что нового» дописать в секцию slice1b;
- код 1a: `apps/server/src/executor/*`, `tools`-контракты shared, `chat/*`, `errors.ts`, `entitlements.ts`, `llm/types.ts` (НЕ менять типы).

## После merge 1b

План **1c «Web UI + прод + приёмка слайса 1»**: весь web (чат с карточками и confirmation-UI, fast-path-парсер + contracts/fast-path, retry-wiring + обязательства по retry-storage из Вехи 0, Browser-lite, detail+тред, настройки+экспорт-кнопка, auth-флоу + site_url-порты, PWA-иконки, radix-ui потребление, hex favicon), прод (re-point `render.yaml` на main, деплой API + статики, NODE_ENV=production, ORBIS_PAT_* на Render, бэкап-runbook), перенос группы «в план 1c» из триажа 1a (CLIENT_OUTDATED-контракт, пагинация thread, ms-курсор, стриминг экспорта, двойной CI push+PR), нюанс «что нового» (touch-семантика треда — решить), приёмка слайса 1 из 00-product §8: агент создаёт проект «Orbis» в проде, переносит документацию, разработка слайса 2 ведётся через Orbis.


