# Слайс 2 «Финансовый контур + время» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Полный финансовый контур и время поверх графа слайса 1: Budget-вкладка (Overview, конверты, quick-add, rollover), recurring-материализация с переходом planned→fact, CSV-импорт с дедупом на `entity_origins`, Agenda-lite, экран памяти AI с эскалацией исправлений в правила и полный detail-экран (блокировки, backlinks) — состав по 00-product §9.

**Architecture:** Budget — линза, не хранилище (03-budget §1.1): все данные — сущности графа, агрегаты (`spent`, баланс, темп) вычисляются на лету SQL'ем в новом tRPC-роутере `budget`. Recurring-инстансы материализуются лениво сервером с детерминированными uuidv5-ID (01-arch §5.4); авто-привязка транзакции к конверту — серверный хук executor'а, единый для всех путей ввода (fast-path, quick-add, CSV, LLM, MCP). Дедуп импорта — shared-константы SQL/JS + жёсткий `UNIQUE (owner_id, namespace, external_id)`.

**Tech Stack:** Bun-монорепо; сервер — Hono + tRPC + Drizzle + PostgreSQL (Supabase); web — React + TanStack Query + Zustand + Tailwind; LLM — `LLMProvider` поверх Vercel AI SDK (Anthropic, дефолт `claude-sonnet-5`); тесты — `bun test`, RLS — pgTAP.

## Глобальные ограничения

- **Деньги — только decimal-строки** (`"340.00"`): никакого `parseFloat`/IEEE-754; SQL-сравнения через `::numeric` (01-arch §3.3).
- **Один путь мутаций**: любая запись в граф — через executor (7 стадий); роутеры и UI бизнес-правил не содержат (impl-00 §1.1, правила 5, 8).
- **Детерминированные ID порождаемого**: инстанс = `uuidv5(ORBIS_NAMESPACE, "<template_id_lowercase>:<YYYY-MM-DD>")`; batch перехода planned→fact = `uuidv5(ORBIS_NAMESPACE, "post-financial:<instance_id>")`; `ORBIS_NAMESPACE = "cb339e97-82d7-4d16-91c6-942d42df7054"` (01-arch §3.3, §5.4; хелперы уже в `packages/shared/src/ids.ts`).
- **Групповые мутации — один `batch_execute`** с `batch_id`: импорт, rollover, рекатегоризация, перенос лимита, привязка к конверту вместе с create (03-budget §2.3, §3.4-4).
- **Undo импорта физически удаляет** строки `entity_origins`, не архивирует (01-arch §4.8).
- **`spent` не хранится** — только вычисление/кэш (01-arch §3.5); никаких материализованных агрегатов.
- **Грамматика запросов не расширяется** без нужды: агрегаты Budget — прямой SQL в роутере `budget`, списки — существующая грамматика (`children_of`, `aspect=`, relative-даты).
- **`packages/shared` не импортирует** React/Hono/Drizzle/tRPC-server/AI SDK (impl-00 §1.1, правило 2).
- Проверки перед каждым коммитом: `bun run typecheck && bun run lint && bun test` (из корня).
- Коммиты — conventional commits с русским описанием (`feat(budget): …`, `fix(executor): …`), footer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Дефолтная таймзона пользователя — `user_settings.timezone`; «сегодня» в финансовых формулах — локальная дата в ней, не UTC (03-budget §2.3).

## Декомпозиция

| Фаза | Что даёт на выходе (работающее ПО) | Задачи |
|---|---|---|
| **A. Серверный фундамент** | Архитектурные фиксы-вход (бэклог 2026-07-09), recurring-материализация + planned→fact, авто-привязка к конвертам, агрегаты Budget по tRPC | A1–A9 |
| **B. Budget UI** | Вкладка Budget целиком: Overview, экран категории, транзакции, quick-add, rollover, бейдж | B1–B7 |
| **C. CSV-импорт** | Полный флоу импорта выписки: shared-дедуп, серверный роутер, экран ревью, undo | C1–C5 |
| **D. Agenda + память + detail** | Agenda-lite с бейджем, экран «Память AI» + эскалация правил + правила в fast-path, блокировки и backlinks на detail-экране | D1–D6 |

Порядок: A строго первая (B, C, D стоят на её контрактах). B → C → D — рекомендованный порядок; C и D зависят только от A и могут идти параллельно с B при работе в ветках.

**Каждая фаза — отдельная ветка** (`slice2a-server-foundation`, `slice2b-budget-ui`, `slice2c-csv-import`, `slice2d-agenda-memory-detail`) с merge в `main` по завершении и ревью (superpowers:requesting-code-review).

## Карта новых/изменяемых файлов

```
packages/shared/src/
  recurrence.ts                    (A2)  expandRecurrence — раскрытие recurrence-правила в даты
  import/normalize.ts              (C1)  нормализация counterparty, similarity, порог, external_id
  index.ts                         (A2, C1)  реэкспорт

apps/server/src/
  executor/executor.ts             (A1, A4)  фикс attach-инварианта budget-parent; монотонный updated_at
  executor/invariants.ts           (A1)  ограниченный CTE ацикличности (BFS вместо путей)
  executor/undo.ts                 (C3)  inverse `entity_origin_delete` — физическое удаление origins
  llm/types.ts, llm/anthropic.ts   (A1)  stopReason: + 'refusal'
  ai/send-message.ts               (A1)  persist-маркер «in progress», wire-статус processing
  recurring/materialize.ts         (A3)  ленивая материализация инстансов, горизонт 14 дней
  recurring/post-due.ts            (A5)  системный batch перехода planned→fact
  budget/binding.ts                (A4)  селектор конверта §2.3 + ребиндинг при правках конвертов
  budget/aggregates.ts             (A6)  SQL: spent, баланс, unbudgeted, coming up, planned, тренд
  routers/budget.ts                (A6, A7)  overview / categoryScreen / rolloverPreview / rollover / postDue
  routers/import.ts                (C2)  analyze / review / confirm (гейт entitlement import.csv)
  routers/entity.ts                (A3, D5)  хук материализации в query/count; backlinks
  entitlements.ts                  (C2)  ключ import.csv
  router.ts                        (A6, C2)  подключение роутеров budget, import

apps/web/src/
  features/budget/                 (B1–B7)  BudgetScreen(Overview), EnvelopeCard, CategoryScreen,
                                   TransactionsScreen, QuickAddBar, RolloverScreen, PlannedToFactCard,
                                   useBudget.ts (хуки overview/rollover/postDue)
  features/import/                 (C4)  ImportFlow, csv-parse.ts (локальный парсинг), ReviewTable
  features/agenda/                 (D1–D2)  AgendaScreen, useAgenda.ts
  features/settings/MemoryScreen   (D3)  экран «Память AI»
  features/entity-detail/          (D5)  Blocks.tsx, Backlinks.tsx (полный detail §3.5.6–7)
  features/chat/useFastPath.ts     (D4)  correction-правила памяти в ctx парсера
  app/router.tsx                   (B1, D1)  включение вкладок budget/agenda
```

---

# Фаза A — серверный фундамент

### Task A1: Архитектурные фиксы-вход (бэклог ревью 2026-07-09)

Пять пунктов из раздела «Архитектурное (вход в слайс 2)» бэклога `docs/superpowers/reviews/2026-07-09-review-backlog.md`. Каждый пункт — свой цикл «тест → фикс → коммит» (пять коммитов).

**Files:**
- Modify: `apps/server/src/executor/executor.ts` (prepareAttach ~:799-861; optimistic-check ~:672-686)
- Modify: `apps/server/src/executor/invariants.ts:84-129`
- Modify: `apps/server/src/llm/types.ts`, `apps/server/src/llm/anthropic.ts:41-58`, `apps/server/src/llm/scripted.ts`
- Modify: `apps/server/src/ai/send-message.ts:145-179`
- Test: `apps/server/src/executor/executor.test.ts`, `apps/server/src/executor/invariants.test.ts`, `apps/server/src/llm/anthropic.test.ts`, `apps/server/src/ai/send-message.test.ts`

**Interfaces:**
- Produces: `LLMStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal'`; wire-ответ `ai.sendMessage` получает вариант `{ status: 'processing' }`.

- [ ] **A1.1 — attach `orbis/budget` обходит «один budget-parent»**. Тест: создать конверт K1 → транзакцию T с parent=K1 → сущность X → relation parent X→T → `attach_orbis_budget` на X. Ожидать: `INVARIANT`-ошибка «второй budget-parent» (сейчас проходит). Фикс в `prepareAttach`: при attach `orbis/budget` проверить исходящие `parent`-связи сущности; если среди целей есть сущность с `orbis/financial`, у которой уже есть другой budget-parent, — отказ. Тот же тест зеркально для attach на сущность, чьи financial-дети без другого конверта, — attach разрешён.
- [ ] **A1.2 — монотонный `updated_at`**. Тест: два последовательных `entity_update` с инъецированным `clock`, возвращающим одинаковый момент; ожидать `updated_at₂ > updated_at₁`. Фикс: `updatedAt = max(clock(), prev.updatedAt + 1ms)`.
- [ ] **A1.3 — ограниченный CTE ацикличности**. Тест: ромбовидный `blocks`-граф (30 рёбер: A→{B1..B15}→C→…, все пути сходятся) — проверка цикла завершается < 1 с (сейчас — экспоненциальный перебор путей). Фикс: рекурсивный CTE по множеству достижимых вершин (`UNION` дедупит посещённые), а не по массивам-путям; путь цикла для сообщения об ошибке восстанавливать вторым запросом только при обнаружении цикла.
- [ ] **A1.4 — `refusal` в `stopReason`**. Расширить тип: `'refusal'`; `anthropic.ts` мапит SDK `content-filter` → `'refusal'` (вместо `end_turn` + warn); `send-message.ts` на `refusal` возвращает `error_card` «модель отказалась отвечать» без tool-цикла. Переписать пиннящий тест `anthropic.test.ts:108-123`; прогнать фикстуры `scripted.ts`.
- [ ] **A1.5 — конкурентный ретрай `ai.sendMessage`**. Тест: два конкурентных вызова с одним client-UUID сообщения; ожидать один tool-цикл (мокнутый `LLMProvider` считает вызовы) и второй ответ `{ status: 'processing' }`. Фикс: в той же транзакции, что `appendMessageIdempotent`, писать системную строку-маркер `chat_messages` `{ role:'system', metadata: { type:'processing', replyTo:<userMsgId> } }` с детерминированным id `uuidv5(NS, "processing:<userMsgId>")`; на `replayed=true` без готового ответа: маркер моложе 10 мин → вернуть `{ status:'processing' }` (клиент перечитывает тред позже), старше → считать прогон умершим и перезапустить. Ответ-успех пишется как сейчас; клиентская обработка `processing` — refetch треда с backoff (правка `apps/web/src/features/chat/useChatThread.ts`).
- [ ] **A1.6 — Коммиты**: по одному на пункт, например `fix(executor): attach orbis/budget не может создать второго budget-parent (§4.2)`.

### Task A2: `expandRecurrence` — раскрытие правила повторения (shared)

**Files:**
- Create: `packages/shared/src/recurrence.ts`
- Modify: `packages/shared/src/index.ts` (реэкспорт)
- Test: `packages/shared/src/recurrence.test.ts`

**Interfaces:**
- Produces:
```ts
export interface RecurrenceRule {
  freq: 'daily' | 'weekly' | 'monthly';
  interval: number;                          // ≥ 1
  byweekday?: Array<'mo'|'tu'|'we'|'th'|'fr'|'sa'|'su'>; // только для weekly
  until?: string;                            // 'YYYY-MM-DD' включительно
}
/** Даты инстансов серии в [from; to] включительно. seriesStart — дата первого
 *  инстанса (= локальная дата start_at шаблона в его таймзоне, вычисляет вызывающий).
 *  Все аргументы и результат — 'YYYY-MM-DD'. Чистая date-арифметика без Date-таймзон:
 *  внутри — счёт дней от эпохи по календарным полям. */
export function expandRecurrence(rule: RecurrenceRule, seriesStart: string, from: string, to: string): string[];
```
- Правила: `daily` — каждые `interval` дней от `seriesStart`; `weekly` без `byweekday` — день недели `seriesStart` каждые `interval` недель; `weekly` с `byweekday` — перечисленные дни недель, отсчитываемых от недели `seriesStart` (неделя с понедельника, `weekStartDay` дефолт); `monthly` — число месяца `seriesStart` каждые `interval` месяцев, **при отсутствии числа в месяце — последний день месяца** (аренда 31-го постится 28/29 февраля — фиксируем это решение здесь); `until` и `to` ограничивают сверху, `seriesStart` и `from` — снизу.

- [ ] **Шаг 1: тесты** (минимум): daily interval=1 `2026-07-01..2026-07-04` от `2026-07-01` → 4 даты; daily interval=3; weekly от среды; weekly byweekday=['mo','fr'] interval=2 (проверить пропуск недели); monthly 31-е число → `['2026-01-31','2026-02-28','2026-03-31']`; `until` раньше `to` обрезает; `from` внутри серии не сдвигает фазу (interval=3 от 01 c from=03 → 04, не 03); пустой результат при `to < seriesStart`.
- [ ] **Шаг 2:** `bun test packages/shared` → FAIL (модуля нет).
- [ ] **Шаг 3:** реализация: календарная арифметика по `{y,m,d}` (helpers `toParts`/`fromParts`/`daysBetween`/`lastDayOfMonth`), без `new Date(str)`-парсинга с таймзонами.
- [ ] **Шаг 4:** `bun test packages/shared` → PASS.
- [ ] **Шаг 5:** Коммит `feat(shared): expandRecurrence — раскрытие recurrence-правила (01-arch §3.1)`.

### Task A3: Ленивая материализация recurring-инстансов

**Files:**
- Create: `apps/server/src/recurring/materialize.ts`
- Modify: `apps/server/src/routers/entity.ts` (хук в `query`/`count`)
- Test: `apps/server/src/recurring/materialize.test.ts`

**Interfaces:**
- Consumes: `expandRecurrence` (A2), `instanceId`-хелпер (добавить в `packages/shared/src/ids.ts`: `recurringInstanceId(templateId, date) = uuidv5(ORBIS_NAMESPACE, templateId.toLowerCase() + ':' + date)` — рядом с существующими uuidv5-формулами тредов), executor `execute()`.
- Produces:
```ts
/** Материализует инстансы всех recurring-шаблонов владельца в окне
 *  [from; min(to, today+14d)] (01-arch §5.4). Идемпотентна: инстансы с уже
 *  существующим детерминированным id пропускаются (SELECT id = ANY перед вставкой).
 *  Пишет через executor (source='system'), по одному batch на шаблон
 *  с batch_id = uuidv5(NS, "materialize:<template_id>:<from>:<to>"). */
export async function materializeInstances(deps: { db; ownerId: string; from: string; to: string; today: string }): Promise<{ created: number }>;
```
- Инстанс: копия title/emoji/tags шаблона; `orbis/schedule` инстанса — `start_at` даты инстанса (время из `start_at` шаблона), без `recurrence`; при `orbis/financial` на шаблоне — тот же аспект с `occurred_on=<дата>`, `planned=true`, `recurring=true`, без привязки к конверту (привязка — при переходе в факт, 03-budget §2.8); relation `derived_from` (source=шаблон, target=инстанс).
- Хук: в `entity.query`/`entity.count` после парсинга — если AST содержит условие по date/timestamp-полю аспектов `orbis/schedule`/`orbis/financial` (`start_at`, `occurred_on`) — перед компиляцией вызвать `materializeInstances` с окном запроса (relative-токены дают явный диапазон; `overdue`/открытый низ → from = today−0, материализуем только будущее и сегодня). Роутер `budget` (A6) вызывает материализацию явно с окном `[period_start; today+14]`.

- [ ] **Шаг 1: тесты**: (1) шаблон daily → материализация окна 3 дней создаёт 3 инстанса с byte-точными uuidv5-id (зафиксировать в тесте конкретный ожидаемый uuid для пары «шаблон-id, дата» — как пример 01-arch §5.4); (2) повторный вызов → `created: 0`, содержимое инстансов не перезаписано (правка инстанса переживает повторную материализацию — 02-core-os §6 «правка инстанса»); (3) окно дальше `today+14` обрезается; (4) financial-шаблон → инстансы `planned=true`, `occurred_on` = дата; (5) архивированный шаблон не материализуется; (6) `entity.query` со `start_at=next_7d` триггерит материализацию (интеграционный, через caller роутера).
- [ ] **Шаг 2:** `bun test apps/server -t materialize` → FAIL.
- [ ] **Шаг 3:** реализация + хук.
- [ ] **Шаг 4:** тесты PASS; `bun run typecheck`.
- [ ] **Шаг 5:** Коммит `feat(server): ленивая материализация recurring-инстансов, горизонт 14 дней (§5.4)`.

### Task A4: Авто-привязка транзакции к конверту (селектор §2.3)

**Files:**
- Create: `apps/server/src/budget/binding.ts`
- Modify: `apps/server/src/executor/executor.ts` (расширение batch связанными операциями привязки)
- Test: `apps/server/src/budget/binding.test.ts`

**Interfaces:**
- Produces:
```ts
/** Кандидат-конверт для транзакции по §2.3: период включает дату, валюта совпадает.
 *  Tie-break byte-точный: (1) минимум календарных дней периода, (2) более поздний
 *  period_start, (3) меньший UUID. Возвращает null, если конверта нет (Unbudgeted). */
export async function selectEnvelope(tx: Tx, args: { ownerId: string; categoryRef: string; currency: string; occurredOn: string }): Promise<string | null>;

/** Операции привязки для транзакции: удалить прежний budget-parent (если сменился),
 *  создать новый. Пустой массив — привязка актуальна. Вызывается executor'ом внутри
 *  того же batch, что породившая мутация (§2.3: «одним batch_execute»). */
export async function bindingOps(tx: Tx, args: { ownerId: string; entity: WireEntity }): Promise<Array<{ tool: string; input: unknown }>>;

/** Ребиндинг всех затронутых транзакций при создании/правке/архивации конверта:
 *  повторный прогон селектора для транзакций категории, чьи occurred_on попадают
 *  в старый ИЛИ новый период (§2.3 последний абзац). */
export async function rebindForEnvelope(tx: Tx, args: { ownerId: string; envelope: WireEntity; before: WireEntity | null }): Promise<Array<{ tool: string; input: unknown }>>;
```
- SQL селектора (внутри `selectEnvelope`; `$defCur` = `user_settings.defaultCurrency`):
```sql
SELECT id FROM entities
WHERE owner_id = $1 AND NOT archived
  AND aspects->'orbis/budget'->>'category_ref' = $2
  AND coalesce(aspects->'orbis/budget'->>'currency', $3) = $4
  AND (aspects->'orbis/budget'->>'period_start') <= $5
  AND (aspects->'orbis/budget'->>'period_end')   >= $5
ORDER BY ((aspects->'orbis/budget'->>'period_end')::date
        - (aspects->'orbis/budget'->>'period_start')::date) ASC,
         (aspects->'orbis/budget'->>'period_start') DESC,
         id ASC
LIMIT 1
```
- Точки интеграции в executor (стадия prepare, после валидации аспектов, до apply): (а) `entity_create`/`entity_update`/`attach_orbis_financial`, где итоговая сущность несёт `orbis/financial` c `occurred_on` (не шаблон) — дописать `bindingOps`; (б) операции, где итоговая сущность несёт `orbis/budget` (create/update периода-категории/archive) — дописать `rebindForEnvelope`. Дописанные операции входят в тот же action журнала → Undo откатывает целиком (§2.3). Executor уже валидирует «не более одного budget-parent» — порядок ops: сначала delete старой связи, затем create новой.
- Валидация уникальности конверта (03-budget §2.1): в `prepare` create/update/attach `orbis/budget` — отказ `INVARIANT`, если существует другой неархивный конверт с той же точной комбинацией `(category_ref, currency, period_start, period_end)`.

- [ ] **Шаг 1: тесты селектора**: месячный конверт включает дату → выбран; двух кандидатов (месячный + узкий отпускной) → узкий; равная длина → поздний `period_start`; полное равенство периодов невозможно (уникальность), но равная длина с разным стартом покрыта; чужая валюта → null; нет конверта → null.
- [ ] **Шаг 2: тесты интеграции**: (1) `entity_create` транзакции при существующем конверте → в одном action созданы сущность и relation parent (проверить журнал: `operations.length === 2`); Undo откатывает обе. (2) Создание узкого конверта перехватывает существующую транзакцию у месячного (relation переехала, атомарно). (3) Архивация узкого возвращает месячному. (4) Транзакция без конверта — без parent (Unbudgeted). (5) `planned=true` привязывается так же, но её `spent` не считает (проверка формулы — A6). (6) Приёмка 03-budget §7.3: порядок создания конвертов не влияет на результат.
- [ ] **Шаг 3:** `bun test apps/server -t binding` → FAIL → реализация → PASS.
- [ ] **Шаг 4:** тест уникальности конверта: повторный create той же комбинации → `INVARIANT`.
- [ ] **Шаг 5:** Коммит `feat(server): авто-привязка транзакций к конвертам и ребиндинг (03-budget §2.3)`.

### Task A5: Переход planned→fact recurring-инстансов

**Files:**
- Create: `apps/server/src/recurring/post-due.ts`
- Modify: `apps/server/src/routers/budget.ts` (процедура `postDue` — заготовка роутера здесь, наполнение в A6)
- Test: `apps/server/src/recurring/post-due.test.ts`

**Interfaces:**
- Consumes: `selectEnvelope`/`bindingOps` (A4), executor.
- Produces:
```ts
/** Для каждого неархивного financial-инстанса с planned=true, occurred_on <= today
 *  (локальная дата пользователя) — системный batch: planned=false + привязка к
 *  конверту. batch_id = uuidv5(NS, "post-financial:<instance_id>") — конкурентные
 *  вызовы с двух устройств сходятся к одному действию (01-arch §3.3). Только
 *  recurring-инстансы (есть derived_from); ручные planned-покупки НЕ трогает —
 *  их переводит явный флоу §2.7. */
export async function postDueInstances(deps: { db; ownerId: string; today: string }): Promise<{ posted: number }>;
```
- Вызов: tRPC `budget.postDue` (web зовёт при маунте Budget/Agenda) и автоматически в начале `budget.overview` (03-budget §2.8: «при первом открытии или финансовом запросе»).

- [ ] **Шаг 1: тесты**: (1) инстанс с `occurred_on=today` → `planned=false`, привязан к конверту, входит в `spent` (через A6-агрегат или прямой SQL в тесте); (2) будущий инстанс не тронут; (3) повторный вызов идемпотентен (batch_id детерминирован, `idempotentReplay=true`, `posted` не растёт); (4) заранее архивированный инстанс не постится (приёмка 03-budget §7.2); (5) Undo перехода восстанавливает `planned=true` и снимает привязку; (6) конкурентные два вызова — один action в журнале (гоночный тест по образцу существующего write-skew-теста approve∥reject).
- [ ] **Шаг 2:** FAIL → реализация → PASS.
- [ ] **Шаг 3:** Коммит `feat(server): переход planned→fact recurring-инстансов идемпотентным batch (§2.8)`.

### Task A6: Агрегаты Budget — SQL и tRPC-роутер

**Files:**
- Create: `apps/server/src/budget/aggregates.ts`, `apps/server/src/routers/budget.ts` (полный)
- Modify: `apps/server/src/router.ts` (подключить `budget`)
- Test: `apps/server/src/budget/aggregates.test.ts`

**Interfaces:**
- Produces (wire-типы в `packages/shared/src/contracts/budget.ts`, Zod):
```ts
export interface EnvelopeStatus {
  envelope: WireEntity;               // сущность конверта
  category: { id: string; title: string; icon: string | null; color: string | null };
  spent: string;                      // decimal-строки во всех суммах
  effectiveLimit: string;             // limit + carryover
  remaining: string;
  dailyPace: string | null;           // null вне активного периода И при remaining<0 («—/день»)
  phase: 'upcoming' | 'active' | 'closed';  // §2.9: сегодня до/в/после периода
}
export interface BudgetOverview {
  period: { start: string; end: string };   // запрошенный месяц
  balance: { income: string; expense: string; balance: string };
  envelopes: EnvelopeStatus[];               // месячные + произвольные, пересекающие месяц
  comingUp: Array<{ entity: WireEntity; occurredOn: string; amount: string; direction: string }>; // 14 дней
  planned: Array<{ entity: WireEntity; amount: string; categoryTitle: string }>;   // ручные planned
  unbudgeted: Array<{ category: { id: string; title: string; icon: string | null }; total: string }>;
  alertCount: number;                        // конверты spent > 85% effectiveLimit (бейдж §6.1)
}
```
- Процедуры (`ownerOnlyProcedure` — мутации, `protectedProcedure` — чтения):
  - `budget.overview({ month: 'YYYY-MM' })` → `BudgetOverview`. Сначала `postDueInstances` + `materializeInstances([today; today+14])`, затем агрегаты.
  - `budget.categoryTrend({ categoryId, months: number })` → `Array<{ period: string; spent: string; limit: string | null }>` — по конвертам категории прошлых периодов (§3.2).
  - `budget.envelopeForCategory({ categoryId, date })` → `EnvelopeStatus | null` — для карточки fast-path «осталось N ₽» (03-budget §4.1) и quick-add.
  - `budget.postDue()` (A5).
- Ключевой SQL (`spent` всех конвертов набора одним запросом — без N+1):
```sql
SELECT r.source_id AS envelope_id,
       coalesce(sum((e.aspects->'orbis/financial'->>'amount')::numeric), 0)::text AS spent
FROM relations r
JOIN entities e ON e.id = r.target_id
WHERE r.relation_type = 'parent'
  AND r.source_id = ANY($1)
  AND e.owner_id = $2 AND NOT e.archived
  AND e.aspects->'orbis/financial'->>'direction' = 'expense'
  AND coalesce((e.aspects->'orbis/financial'->>'planned')::boolean, false) = false
  AND (e.aspects->'orbis/financial'->>'occurred_on') <= $3            -- сегодня локально
  AND coalesce(e.aspects->'orbis/financial'->>'currency', $4) = $5    -- валюта конверта
GROUP BY r.source_id
```
  Баланс периода (§2.5) — аналогичный sum по всем financial владельца в `[start;end]`, `occurred_on <= today`, `planned=false`, валюта периода (= `defaultCurrency`), группировка по `direction`. Unbudgeted — фактические расходы периода `NOT EXISTS` budget-parent, группировка по `category_ref`. Coming up — financial-инстансы `planned=true` с `derived_from`, `occurred_on` в `[today; today+14]`. Planned — `planned=true` **без** `derived_from` (ручные покупки). Иерархия категорий §2.10 — агрегация детей поверх результата в TS (обход дерева categories по relations `parent`, decimal-суммирование строк).
- Формулы (§2.4, §2.9): `effectiveLimit = limit + carryover`; `remaining = effectiveLimit − spent`; `dailyPace = remaining / max(1, дней до period_end включительно)` — только в `phase='active'` и при `remaining ≥ 0`; decimal-арифметика по существующей утилите сервера (та же, что в executor-валидации денег), деление — 2 знака half-away-from-zero.

- [ ] **Шаг 1: тесты** на фикстурном графе (категории из сида, 2 конверта, 6 транзакций: факт/planned/чужая-валюта/доход/инстанс/unbudgeted): spent считает только факт-расходы своей валюты до сегодня; carryover входит в effectiveLimit; баланс включает unbudgeted, исключает чужую валюту (edge case §5); planned и coming up не пересекаются (derived_from — дискриминатор); alertCount по порогу 85%; **приёмка §7.1**: транзакция `occurred_on=2026-05-31`, импортированная в июне, входит в майский конверт и не входит в июньский; phase='upcoming'/'closed' конверта — dailyPace=null.
- [ ] **Шаг 2:** FAIL → реализация → PASS.
- [ ] **Шаг 3:** `budget.overview` дымово через tRPC-caller (авторизация: `protectedProcedure`, чужой owner не видит — покрыто RLS + ownerOnly-паттерном, тест по образцу существующих роутер-тестов).
- [ ] **Шаг 4: read-only тул `budget_status` в реестре тулов** (`apps/server/src/tools/registry.ts`): input `{ month?: 'YYYY-MM' }`, output = `BudgetOverview` + `spend_class` категорий — то, чем LLM отвечает на сценарии §4.3 («могу позволить?» — считает `discretionary_remaining − future_outflows`, категорию без `spend_class` называет явно), §4.5 (rollover из чата — данные `rolloverPreview`) и §4.7 («что по бюджету?» точной карточкой). Доступен и MCP (§9.3 — тот же реестр); политика подтверждений: чтение → `execute`. Тест: dispatch тула возвращает агрегаты; в system prompt (`llm/prompts/v1.ts`) — строка про использование `budget_status` для финансовых вопросов и запрет двойного вычета recurring (§4.3: future_outflows уже включает инстансы).
- [ ] **Шаг 5:** Коммит `feat(server): tRPC-роутер budget и тул budget_status — агрегаты на лету (03-budget §2, §3.1, §4)`.

### Task A7: Rollover — превью и создание конвертов нового периода

**Files:**
- Modify: `apps/server/src/routers/budget.ts`, `apps/server/src/budget/aggregates.ts`
- Test: `apps/server/src/budget/rollover.test.ts`

**Interfaces:**
- Produces:
```ts
// budget.rolloverPreview({ month: 'YYYY-MM' }) →
export interface RolloverPreview {
  month: string;
  rows: Array<{
    categoryId: string; categoryTitle: string; categoryIcon: string | null;
    prevSpent: string;          // факт закрытого месячного конверта прошлого периода
    carryover: string;          // remaining прошлого периода (§2.6)
    suggestedLimit: string;     // эвристика: limit прошлого конверта; нет истории лимита —
                                // spent, округлённый вверх до 100
  }>;
  needsSetup: boolean;          // первый месяц без истории (§3.5): rows пуст, есть категории с тратами
}
// budget.rollover({ month, rows: Array<{ categoryId; limit: string; carryover: string }>, batchId: string })
//   → один batch_execute: entity_create конверта на каждый row (период = календарный месяц,
//     валюта = defaultCurrency). Идемпотентно по batchId; Undo откатывает все конверты.
```
- Превью: категории, у которых есть **месячный** конверт прошлого календарного месяца без конверта-преемника в целевом (произвольные периоды §2.9 не участвуют). `carryover = remaining(прошлый)` — включая отрицательный. LLM в предложении лимитов не участвует — фиксируем эвристику (детерминированно, тестируемо); AI-путь «настрой бюджеты на июль» (сценарий §4.5) отвечает через чат тем же `rolloverPreview`-вычислением, вызов LLM-предложений — Future.

- [ ] **Шаг 1: тесты**: профицит → положительный carryover; дефицит → отрицательный (урезает); категория уже с конвертом июля → не в rows; произвольный конверт не в rows; `rollover` создаёт N конвертов одним action, повтор batchId → `idempotentReplay`; Undo сносит все; `needsSetup=true` при тратах без единого конверта прошлого месяца.
- [ ] **Шаг 2:** FAIL → реализация → PASS.
- [ ] **Шаг 3:** Коммит `feat(server): rollover — превью carryover и атомарное создание конвертов (§2.6, §3.5)`.

### Task A8: Перевод plan→fact ручной покупки (флоу §2.7)

**Files:**
- Modify: `apps/server/src/routers/budget.ts`
- Test: `apps/server/src/budget/plan-to-fact.test.ts`

**Interfaces:**
- Produces: `budget.confirmPurchase({ entityId, occurredOn: string, batchId: string })` — один batch: `entity_update` (`planned=false`, `occurred_on=<фактическая дата>`) + переселект конверта по новой дате (A4 подхватывает автоматически в executor-хуке). Отказ, если сущность не planned-financial. Undo восстанавливает план и прежнюю привязку целиком (приёмка §7.6).

- [ ] **Шаг 1: тесты**: перевод ставит факт и конверт по фактической дате (не по прежней); Undo возвращает `planned=true` + прежний `occurred_on` + прежний parent; уже-факт → `INVARIANT`.
- [ ] **Шаг 2:** FAIL → реализация → PASS.
- [ ] **Шаг 3:** Коммит `feat(server): перевод planned-покупки в факт одним batch (§2.7)`.

### Task A9: Включение view — `installedViews`, ревью фазы

**Files:**
- Modify: `apps/server/src/seed/onboarding.ts` (при сидировании: `installedViews: ["orbis-budget"]` — уже по §4.4; проверить и добить идемпотентный апдейт существующих пользователей: пустой `installedViews` → добавить `orbis-budget` при следующем `user.ensureOnboarding`)
- Test: `apps/server/src/seed/onboarding.test.ts`

- [ ] **Шаг 1:** тест: существующий пользователь без `orbis-budget` в `installedViews` получает его при повторном `ensureOnboarding`; повтор не дублирует.
- [ ] **Шаг 2:** FAIL → фикс → PASS.
- [ ] **Шаг 3:** Полный прогон: `bun run typecheck && bun run lint && bun test && bun run test:rls`.
- [ ] **Шаг 4:** Коммит `feat(server): orbis-budget в installedViews существующих пользователей`; запросить code-review фазы A (superpowers:requesting-code-review), merge ветки в main.

---

# Фаза B — Budget UI

Все экраны — внутри вкладки `budget` (стек `useNav`); тап по сущности пушит единый `DetailScreen`. Данные — только через tRPC-хуки; никакой доменной логики в компонентах (формулы уже посчитаны сервером в A6). Стиль — существующие `ui/`-примитивы (Card, Chip, Badge, Sheet, Tabs), Tailwind-токены как в Browser/Chat.

### Task B1: Включение вкладки Budget + каркас Overview

**Files:**
- Modify: `apps/web/src/app/router.tsx` (TABS: `budget.enabled` — по `installedViews` из `user.settings`; рендер `BudgetScreen` для вкладки budget)
- Create: `apps/web/src/features/budget/BudgetScreen.tsx`, `apps/web/src/features/budget/useBudget.ts`
- Test: `apps/web/src/features/budget/BudgetScreen.test.tsx`

**Interfaces:**
- Consumes: `trpc.budget.overview`, `trpc.budget.postDue` (A6/A5), `trpc.user.settings`.
- Produces:
```ts
// useBudget.ts
export function useBudgetOverview(month: string) // useQuery budget.overview; на mount один budget.postDue
export function monthShift(month: string, delta: -1 | 1): string  // 'YYYY-MM' арифметика без Date
export const invalidateBudget = (utils) => utils.budget.invalidate() // после любой мутации транзакций/конвертов
```
- `BudgetScreen`: хедер «Бюджет · <месяц>» + `[◀ ▶]` (state месяца — `useState`, дефолт текущий в таймзоне пользователя) + ⚙; секции по мокапу §3.1: карточка баланса, сетка `EnvelopeCard`, `[+ конверт]`, Coming up, Planned, Unbudgeted. Пустые секции скрываются. Skeleton на загрузке.

- [ ] **Шаг 1: тест** (testing-library, mock tRPC как в существующих web-тестах): рендер с фикстурным `BudgetOverview` — виден баланс, две карточки конвертов, секции Coming up/Planned/Unbudgeted; переключатель месяца меняет аргумент запроса; вкладка budget активируется в TabBar при `installedViews` содержащем `orbis-budget`.
- [ ] **Шаг 2:** FAIL → реализация → PASS.
- [ ] **Шаг 3:** Коммит `feat(web): вкладка Budget — каркас Overview (§3.1)`.

### Task B2: EnvelopeCard + создание конверта

**Files:**
- Create: `apps/web/src/features/budget/EnvelopeCard.tsx`, `apps/web/src/features/budget/EnvelopeCreateSheet.tsx`
- Test: `apps/web/src/features/budget/EnvelopeCard.test.tsx`

**Interfaces:**
- Consumes: `EnvelopeStatus` (A6); `trpc.entity.create` (конверт = `entity_create` с `orbis/budget`; привязка накопленных транзакций — серверный хук A4, отдельного вызова не нужно).
- `EnvelopeCard`: иконка+имя категории; прогресс-бар `spent/effectiveLimit`; пороги подсветки §3.1: <60% цвет категории, 60–85% жёлтый, 85–100% оранжевый+⚠, ≥100% красный+🔴; `ост. <remaining>`; `~<dailyPace> ₽/день`, при `dailyPace=null` в active-фазе — «—/день»; carryover-бейдж `↩ ±N` при ненулевом; фазы §2.9: upcoming — пустой нейтральный бар + «начнётся DD.MM», closed — приглушённая карточка + «завершён». Тап → push экрана категории (B3).
- `EnvelopeCreateSheet` (`[+ конверт]` и из Unbudgeted): выбор категории (список категорий-сущностей), лимит (decimal-инпут строкой), период (дефолт — текущий месяц; произвольный диапазон дат — два date-инпута). Сабмит → `entity.create` → `invalidateBudget`. Ошибка уникальности конверта → тост с текстом сервера.

- [ ] **Шаг 1: тесты**: пороги цвета по данным (72% → norm, 91% → warn+⚠, 100% → 🔴); «—/день» при null-pace в active; «начнётся»/«завершён» по phase; carryover-бейдж; сабмит создания шлёт валидный `orbis/budget`-аспект.
- [ ] **Шаг 2:** FAIL → реализация → PASS.
- [ ] **Шаг 3:** Коммит `feat(web): карточка конверта с порогами и создание конверта (§3.1, §2.9)`.

### Task B3: Экран категории

**Files:**
- Create: `apps/web/src/features/budget/CategoryScreen.tsx`
- Modify: `apps/web/src/state/navigation.ts` (`ScreenRef` + `{ kind: 'budget-category'; id: string }`), `apps/web/src/app/router.tsx` (рендер)
- Test: `apps/web/src/features/budget/CategoryScreen.test.tsx`

**Interfaces:**
- Consumes: `trpc.budget.envelopeForCategory`, `trpc.budget.categoryTrend` (A6), `trpc.entity.get` (категория: body-правила), `trpc.entity.query` (`children_of=<конверт>, aspect=orbis/financial, sortBy=occurred_on:desc` — список транзакций), тред — существующий `ChatThread` с `thread_id` категории (кнопка `[Тред]`).
- Состав по мокапу §3.2: карточка текущего конверта (переиспользовать разметку EnvelopeCard в развёрнутом виде), секция «Правила» = `body` категории (markdown, как в DetailScreen), мини-тренд N месяцев (горизонтальные бары по `categoryTrend`, штрих лимита — простые div'ы, без чарт-библиотеки), список транзакций (native-рендеринг `NativeRow`, 🔁 у инстансов — признак: входящая `derived_from`; сервер отдаёт это флагом в query-ответе? Нет — используем `aspects['orbis/financial'].recurring === true`), `[+ запись в эту категорию]` → QuickAddBar (B4) с предзаданной категорией.

- [ ] **Шаг 1: тест**: рендер конверта/правил/тренда/списка по фикстурам; тап `[Тред]` открывает тред категории; `[+ запись]` показывает quick-add с зафиксированной категорией.
- [ ] **Шаг 2:** FAIL → реализация → PASS.
- [ ] **Шаг 3:** Коммит `feat(web): экран категории — конверт, правила, тренд, транзакции (§3.2)`.

### Task B4: Quick-add бар

**Files:**
- Create: `apps/web/src/features/budget/QuickAddBar.tsx`
- Modify: `apps/web/src/features/budget/BudgetScreen.tsx`, `CategoryScreen.tsx` (бар внизу)
- Test: `apps/web/src/features/budget/QuickAddBar.test.tsx`

**Interfaces:**
- Consumes: `trpc.entity.create` (source=`quick_capture`-класс пути; вход — структурированный `entity_create` c `orbis/financial`), `trpc.budget.envelopeForCategory` (остаток после записи), категории — `trpc.entity.query` (`aspect=orbis/category`).
- Поведение §3.6: переключатель `[−расход][+доход]`; числовая клавиатура (целые/десятичные, запятая = точка); пилюли 4–5 недавних категорий — вычислить из последних 20 транзакций (`entity.query aspect=orbis/financial, sortBy=occurred_on:desc, limit=20`, уникальные `category_ref` по порядку); полный выбор — раскрытием; title опционален (пусто → `<имя категории> <сумма>`); `[Записать]` → `entity.create` с client-UUIDv7 (**UUID генерируется один раз на открытие формы**, не на сабмит — идемпотентность ручного повтора, урок бэклога), `occurred_on` = сегодня локально; успех → тост-«карточка» с Undo (actionId из ответа) и остатком конверта; `invalidateBudget`.
- Привязка к конверту — сервер (A4); клиент ничего не связывает.

- [ ] **Шаг 1: тесты**: ввод «340» + категория → мутация с `amount:"340.00"`, `direction:'expense'`; переключение income; предзаданная категория на экране категории; повторный клик «Записать» после ошибки шлёт тот же id; после успеха показан остаток конверта.
- [ ] **Шаг 2:** FAIL → реализация → PASS.
- [ ] **Шаг 3:** Коммит `feat(web): quick-add бар Budget (§3.6)`.

### Task B5: Экран «Транзакции» — фильтры, свайпы, рекатегоризация

**Files:**
- Create: `apps/web/src/features/budget/TransactionsScreen.tsx`, `apps/web/src/features/budget/useRecategorize.ts`
- Modify: `apps/web/src/state/navigation.ts` (+`{ kind: 'budget-transactions' }`), `router.tsx`
- Test: `apps/web/src/features/budget/TransactionsScreen.test.tsx`

**Interfaces:**
- Consumes: `trpc.entity.query` (грамматика — потребитель №3: `aspect=orbis/financial` + фильтры категории `category_ref=<uuid>`, направления `direction=`, диапазона суммы `amount=500..2000`, `planned=`, поиска `search=`; период — по `occurred_on` относительными токенами или месяцем через SQL-агрегат не нужен: используем `occurred_on` c диапазоном месяца через два условия сравнения дат — **если грамматика не поддерживает абсолютный диапазон date-полей аспектов, добавить его в фазе B нельзя** → фильтр периода реализуем выбором месяца и клиентской передачей `occurred_on=<от>..<до>`: расширение грамматики диапазоном дат для date-полей — маленькая правка `packages/shared/src/query/parse.ts` + `apps/server/src/query/compile.ts` + golden-фикстура, включена в этот таск).
- Produces: `useRecategorize(entity)` → `trpc.budget.recategorize`? Нет — рекатегоризация уже атомарна на сервере: `entity.update` с новым `category_ref` — executor-хук A4 сам перепривязывает parent (edge case §5 «Рекатегоризация»). Клиент зовёт `entity.update` и инвалидирует budget+entity.
- Свайпы (§3.3): влево — выбор категории (Sheet) → `entity.update category_ref`; вправо — «пометить 🔁» → ставит `recurring=true` и открывает подсказку «завести шаблон» (создание шаблона — переход на detail с предложением добавить `orbis/schedule.recurrence`; полноценный мастер — не в MVP-объёме, достаточно перехода на detail).

- [ ] **Шаг 1: тест грамматики**: golden-фикстура `occurred_on=2026-06-01..2026-06-30` → SQL-диапазон по date-полю аспекта (packages/shared + compile-тест сервера).
- [ ] **Шаг 2:** тесты экрана: фильтры собирают корректную строку грамматики (юнит на билдер строки — отдельная чистая функция `buildTxQuery(filters): string` с тестами на кавычки/экранирование, урок бэклога об экранировании тегов); свайп-рекатегоризация зовёт `entity.update`; строка показывает 🔁 и бейдж категории раздельно.
- [ ] **Шаг 3:** FAIL → реализация → PASS.
- [ ] **Шаг 4:** Коммит `feat(web): экран Транзакции — финансовые фильтры и рекатегоризация свайпом (§3.3)`.

### Task B6: Rollover-экран + карточка plan→fact

**Files:**
- Create: `apps/web/src/features/budget/RolloverScreen.tsx`, `apps/web/src/features/budget/PlannedToFactCard.tsx`
- Modify: `apps/web/src/features/budget/BudgetScreen.tsx` (триггер), `apps/web/src/features/chat/cards/renderCards.tsx` (карточка plan→fact в чате при закрытии задачи-покупки)
- Test: `apps/web/src/features/budget/RolloverScreen.test.tsx`

**Interfaces:**
- Consumes: `trpc.budget.rolloverPreview`, `trpc.budget.rollover` (A7), `trpc.budget.confirmPurchase` (A8).
- Триггер rollover (§3.5): при открытии Budget в новом месяце — если `rolloverPreview(текущий месяц).rows.length > 0` → баннер «Новый месяц: настроить бюджеты» → push RolloverScreen; вручную из `⋮ → Rollover`. Экран: таблица факт/carryover/лимит (лимит — редактируемое поле), `[Обнулить переносы]` (все carryover → "0.00", покатегорийно — тап по значению), `[Создать N конв.]` → `budget.rollover` с client-batchId (UUIDv7, один на открытие экрана). `needsSetup` → форма первого месяца: поле дохода + оценки по категориям → те же rows.
- PlannedToFactCard (§2.7): при `entity.update` задачи в `done`, несущей `orbis/financial planned=true` (проверка на клиенте по данным сущности), показать карточку «Покупка совершена? <сумма> → <категория>» с date-инпутом (default сегодня) и `[Перевести в факт]` → `budget.confirmPurchase` / `[Оставить план]`. Точки показа: DetailScreen (чекбокс задачи) и чекбокс в списках (`NativeRow`) — через общий hook `usePlanToFactPrompt`.

- [ ] **Шаг 1: тесты**: превью рендерит строки, правка лимита уходит в мутацию; «Обнулить переносы» шлёт нули; повторный сабмит — тот же batchId; PlannedToFactCard появляется после done планируемой покупки и зовёт confirmPurchase с выбранной датой.
- [ ] **Шаг 2:** FAIL → реализация → PASS.
- [ ] **Шаг 3:** Коммит `feat(web): rollover-флоу и перевод покупки в факт (§3.5, §2.7)`.

### Task B7: Бейдж вкладки Budget, остаток в fast-path-карточке, ревью фазы

**Files:**
- Modify: `apps/web/src/app/router.tsx` (бейдж = `overview.alertCount` через лёгкий `trpc.budget.alertCount`-запрос — добавить процедуру count-only в `routers/budget.ts`), `apps/web/src/features/chat/cards/EntityCard.tsx` (для financial-карточки после подтверждения сервера — строка «→ <категория> · осталось N ₽» из `budget.envelopeForCategory`)
- Test: обновить `router`-тест и `EntityCard`-тест

- [ ] **Шаг 1:** тесты: бейдж виден при alertCount>0, скрыт при 0 (§6.1); fast-path-карточка financial показывает остаток после confirm (§4.1).
- [ ] **Шаг 2:** FAIL → реализация → PASS.
- [ ] **Шаг 3:** Полный прогон `bun run typecheck && bun run lint && bun test`; ручной смоук по `superpowers:verification-before-completion` — прогнать в браузере против локального сервера сценарий: создать конверт → «обед 340» в чате → остаток на карточке → Overview показывает spent.
- [ ] **Шаг 4:** Коммит `feat(web): бейдж Budget и остаток конверта в fast-path-карточке (§6.1, §4.1)`; code-review фазы, merge.

---

# Фаза C — CSV-импорт

### Task C1: Shared-библиотека дедупа и external_id

**Files:**
- Create: `packages/shared/src/import/normalize.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/import/normalize.test.ts`

**Interfaces (byte-точный контракт §3.4.1 — константы общие для JS и будущих SQL-проверок, фикстуры общие):**
```ts
export const DUP_SIMILARITY_THRESHOLD = 0.85;
export const SERVICE_TOKENS = ['sbol', 'payment', 'card', 'purchase', 'oplata'] as const;
/** NFKC → lowercase → ё→е → пунктуация→пробелы → схлопнуть пробелы → срезать
 *  ведущие SERVICE_TOKENS (повторно, пока матчатся). */
export function normalizeCounterparty(s: string): string;
/** max(1 − levenshtein/maxLen, tokenJaccard) на нормализованных строках. */
export function counterpartySimilarity(a: string, b: string): number;
/** Дубль по §3.4.1: amount+direction точно; |occurred_on разница| ≤ 1 день;
 *  similarity ≥ порога ИЛИ совпал bankTxnId. */
export function isProbableDuplicate(row: CanonicalRow, candidate: { amount: string; direction: string; occurredOn: string; title: string; counterparty?: string; bankTxnId?: string }): boolean;
/** Каноническая строка выписки после маппинга колонок. */
export interface CanonicalRow { occurredOn: string; amount: string; direction: 'income' | 'expense'; counterparty: string; bankTxnId?: string; raw: string; rowIndex: number; }
/** external_id = sha256hex(fileHashHex + ":" + rowIndex + ":" + normalizedRow),
 *  normalizedRow = JSON.stringify([occurredOn, amount, direction,
 *  normalizeCounterparty(counterparty), bankTxnId ?? null]). fileHashHex =
 *  sha256hex байтов файла (считает клиент и передаёт). Повтор byte-identical
 *  файла → те же id (§3.4.1). sha256 — WebCrypto (есть и в Bun, и в браузере),
 *  функция async. */
export function externalRowId(fileHashHex: string, row: CanonicalRow): Promise<string>;
```

- [ ] **Шаг 1: тесты**: нормализация `«SBOL ПЯТЁРОЧКА 1234»` → `пятерочка 1234`; `ё→е`; пунктуация; similarity `ПЯТЕРОЧКА 843` vs `Пятёрочка` ≥ 0.85 — и негативная пара < 0.85 (`OZON` vs `WILDBERRIES`); дубль: разница дат ровно 1 день — да, 2 дня — нет; bankTxnId перекрывает текст; external_id детерминирован (фикстура с точным hex), меняется от rowIndex.
- [ ] **Шаг 2:** FAIL → реализация (левенштейн — своя маленькая O(n·m), строки counterparty короткие) → PASS.
- [ ] **Шаг 3:** Коммит `feat(shared): дедуп-критерий импорта и external_id (03-budget §3.4.1)`.

### Task C2: Серверный роутер импорта

**Files:**
- Create: `apps/server/src/routers/import.ts`, `apps/server/src/import/review.ts`
- Modify: `apps/server/src/router.ts`, `apps/server/src/entitlements.ts` (ключ `import.csv`, `'dev'` → разрешено), `apps/server/src/executor/executor.ts` + `executor/types.ts` (внутренние операции `entity_origin_create` / inverse `entity_origin_delete`)
- Test: `apps/server/src/import/import.test.ts`

**Interfaces:**
- `import.analyze({ sampleRows: string[] })` → `{ mapping: { date: number; amount: number; counterparty: number; direction: 'sign'|'separate_columns'|…; dateFormat: string; encoding? }, confidence }` — один LLM-вызов через `LLMProvider` (промпт: образцы строк → JSON-маппинг; метрится в `ai_usage`); при недоступном LLM — структурированная ошибка (§7.9), пользователь мапит колонки вручную на клиенте.
- `import.review({ rows: CanonicalRow[], fileHash: string, namespace: string })` → `{ rows: Array<CanonicalRow & { externalId: string; status: 'new'|'already_imported'|'probable_duplicate'; duplicateOf?: string; suggestedCategoryRef?: string }> }`. Логика §3.4.1: (1) `externalId` есть в `entity_origins` по уникальному индексу → `already_imported`; (2) иначе скан financial-сущностей окна дат (`occurred_on` ± 1 день от диапазона строк) → `isProbableDuplicate` → `probable_duplicate`; (3) иначе `new`. Категоризация: резолв по aliases категорий (тот же словарь, что fast-path) + memory-правила `scope=orbis/financial`; неуверенно → без suggestion (клиент покажет `[❓ выбрать]`). LLM для категоризации не зовём (детерминированно и бесплатно; LLM-категоризация — Future).
- `import.confirm({ batchId, namespace, fileHash, items: Array<{ row; action: 'create'|'adopt'|'skip'; categoryRef?: string; adoptEntityId?: string }> })` → один `batch_execute`: для `create` — `entity_create` (financial: amount/direction/occurred_on/counterparty→title, category_ref) + `entity_origin_create`; для `adopt` — только `entity_origin_create` на существующую сущность («усыновление» источника); привязка к конвертам — хук A4. Undo: inverse `entity_origin_delete` **физически удаляет** строку origins (правка `executor/undo.ts`); созданные сущности — обычная архивация. Гейт: `entitlements.check('import.csv')`, actor=owner (LLM/MCP этот роутер не зовут — карточка `import_review` в чате инициирует тот же клиентский флоу).
- `namespace = "csv:" + <имя источника от клиента>` (нормализованное имя файла без даты — решает клиент, C4).

- [ ] **Шаг 1: тесты** (`import.test.ts`, tRPC-caller + тестовая БД): review статусы — повтор файла → все `already_imported` (приёмка §7 edge «Повторный импорт»); пересекающийся другой файл → `probable_duplicate` (приёмка §7.4); «создать всё равно» → две сущности, повтор файла после этого идемпотентен; confirm атомарен (невалидная строка валит весь batch, ничего не создано); origins создаются с правильным `(namespace, external_id)`; повторная вставка того же external_id отклонена БД (unique); Undo импорта: сущности архивированы, origins **физически удалены**, повторный review того же файла снова видит строки как `new` (§3.4.1 последний абзац).
- [ ] **Шаг 2:** FAIL → реализация → PASS.
- [ ] **Шаг 3:** Коммит `feat(server): роутер импорта CSV — review/confirm, origins в executor (§3.4)`.

### Task C3: Undo-происхождение в исполнителе — проверка сквозная

(Выделено из C2 отдельным тестовым таском, потому что цепочка «журнал → inverse → физическое удаление» ломается молча.)

**Files:**
- Test: `apps/server/src/executor/undo-origins.test.ts`

- [ ] **Шаг 1:** сквозной тест: импорт 3 строк (2 create + 1 adopt) → «отмени последнее» через существующий undo-путь → в `entity_origins` нет ни одной из 3 строк, adopt-сущность жива и не архивирована (усыновление откатилось, сущность — нет), 2 созданные — архивированы; повторный undo отклонён.
- [ ] **Шаг 2:** FAIL → дофиксить C2 → PASS.
- [ ] **Шаг 3:** Коммит `test(server): сквозной undo импорта — физическое удаление origins`.

### Task C4: Клиентский флоу импорта

**Files:**
- Create: `apps/web/src/features/import/ImportFlow.tsx`, `apps/web/src/features/import/csv-parse.ts`, `apps/web/src/features/import/ReviewTable.tsx`
- Modify: `apps/web/src/features/budget/BudgetScreen.tsx` (`⋮ → Импорт CSV`), `apps/web/src/features/chat/cards/renderCards.tsx` (тип `import_review` → кнопка «Открыть импорт»)
- Test: `apps/web/src/features/import/csv-parse.test.ts`, `ImportFlow.test.tsx`

**Interfaces:**
- `csv-parse.ts`: локальный парсинг файла (§3.4 шаг 1 — файл в LLM целиком не уходит): чтение как `ArrayBuffer` → декодирование UTF-8 c фолбэком Windows-1251 (`TextDecoder('windows-1251')`, эвристика: доля U+FFFD); разделитель `,`/`;`/`\t` — по максимуму колонок первых строк; `parseCsv(text, delimiter): string[][]` с поддержкой кавычек RFC 4180; `toCanonicalRows(rows, mapping): CanonicalRow[]` (нормализация дат по `mapping.dateFormat`, знака суммы). `fileHash` — sha256 байтов (WebCrypto).
- Флоу-шаги (state-машина в `ImportFlow`): file → sample в `import.analyze` (5 строк) → форма-подтверждение маппинга (правится вручную; работает и без LLM) → `import.review` → `ReviewTable` (счётчики ✓/⊘/⟳, inline-правка категории выпадашкой, переключение ⊘→«создать всё равно», `[Снять все дубли]`, `[Подтвердить N]`) → `import.confirm` (batchId UUIDv7 один на сессию флоу) → итог-карточка «Импортировано N, пропущено M» со ссылками (push Overview/категорий).

- [ ] **Шаг 1: тесты csv-parse**: кавычки/экранирование; `;`-разделитель; win-1251 фикстура (байтовая); даты `DD.MM.YYYY` → ISO; знак в колонке vs отдельные дебет/кредит.
- [ ] **Шаг 2:** тест флоу: фикстурный review → таблица статусов, `[Подтвердить]` шлёт только create/adopt (skip не уходит), повторный сабмит — тот же batchId.
- [ ] **Шаг 3:** FAIL → реализация → PASS.
- [ ] **Шаг 4:** Коммит `feat(web): флоу импорта CSV — локальный парсинг, ревью, подтверждение (§3.4)`.

### Task C5: Приёмка импорта и ревью фазы

- [ ] **Шаг 1:** прогнать приёмочные проверки 03-budget §7.1 и §7.4 руками против локального стенда (реальный CSV-файл из фикстуры, два пересекающихся файла) — по `superpowers:verification-before-completion`.
- [ ] **Шаг 2:** `bun run typecheck && bun run lint && bun test && bun run test:rls`.
- [ ] **Шаг 3:** Коммит при находках; code-review фазы, merge.

---

# Фаза D — Agenda-lite, память AI, полный detail

### Task D1: AgendaScreen — дни и «Просроченное»

**Files:**
- Create: `apps/web/src/features/agenda/AgendaScreen.tsx`, `apps/web/src/features/agenda/useAgenda.ts`
- Modify: `apps/web/src/app/router.tsx` (включить вкладку agenda, рендер экрана)
- Test: `apps/web/src/features/agenda/AgendaScreen.test.tsx`

**Interfaces:**
- Consumes (все — существующий `entity.query`; материализацию окна гарантирует серверный хук A3):
  - дневные секции: `aspect=orbis/schedule, start_at=today|next_7d, sortBy=start_at:asc, limit=200` — распределение по 8 дням на клиенте; **шаблоны скрыты**: фильтр на клиенте `!aspects['orbis/schedule'].recurrence` (§4.1);
  - просроченные задачи: `aspect=orbis/task, due_date=overdue, status=!done&!cancelled, sortBy=due_date:asc`;
  - просроченные scheduled-задачи: `aspect=orbis/task, aspect=orbis/schedule, start_at=overdue, status=!done&!cancelled` — **если парсер не принимает два `aspect=`**, использовать один `aspect=orbis/task, start_at=overdue, status=!done&!cancelled` (поле `start_at` резолвится по реестру; наличие `orbis/schedule` следует из наличия поля) — проверить на golden-фикстуре и зафиксировать рабочий вариант в `useAgenda.ts`.
- Слияние «Просроченного» (§4.2): один элемент на сущность, по более ранней из дат; чистые события без `orbis/task` не попадают. Секция всегда сверху, красный акцент; сортировка старейшие сверху.
- Рендер дня: `all_day` сверху с пометкой «весь день», далее по времени `start_at` (диапазон при `end_at`); native-иконки аспектов (`NativeRow`); пустой день — «день свободен», секция не скрывается. Тап — push DetailScreen.

- [ ] **Шаг 1: тесты** (фикстуры на приёмку 02-core-os §8.1–8.4): прошедшее чистое событие не в «Просроченном»; незакрытая задача с прошедшим due_date — в «Просроченном» независимо от schedule; task+schedule с прошедшими обеими датами — один раз; задача с одним due_date не в дневных секциях; recurring-шаблон скрыт, инстанс виден; пустой день рендерит «день свободен».
- [ ] **Шаг 2:** FAIL → реализация → PASS.
- [ ] **Шаг 3:** Коммит `feat(web): Agenda-lite — дневные секции и Просроченное (02 §4)`.

### Task D2: Бейдж вкладки Agenda

**Files:**
- Modify: `apps/web/src/app/router.tsx`
- Test: обновить router-тест

- [ ] **Шаг 1:** тест: бейдж = число элементов «Просроченного» (§1.5) — `entity.count` двумя запросами D1 с клиентским слиянием количества нельзя (пересечение) → использовать count по задачам `due_date=overdue|…` + count по scheduled-задачам с вычетом пересечения тем же приёмом, либо просто длина уже загруженной секции из `useAgenda` при смонтированной вкладке и `entity.count` первого запроса как приближение до открытия. **Решение: бейдж считает длину секции «Просроченное» из общего хука `useAgendaOverdue()`, который вкладка и бейдж разделяют** (один источник, без расхождений).
- [ ] **Шаг 2:** FAIL → реализация → PASS.
- [ ] **Шаг 3:** Коммит `feat(web): бейдж Agenda — счётчик Просроченного (§1.5)`.

### Task D3: Экран «Память AI» + эскалация исправлений в правила

**Files:**
- Create: `apps/web/src/features/settings/MemoryScreen.tsx`
- Create: `apps/server/src/ai/escalation.ts`
- Modify: `apps/web/src/features/settings/SettingsScreen.tsx` (раздел «Память AI»), `apps/server/src/executor/executor.ts` или `routers/entity.ts` (пост-коммит хук проверки эскалации на рекатегоризации), `apps/web/src/features/chat/cards/renderCards.tsx` (карточка-предложение правила)
- Test: `apps/server/src/ai/escalation.test.ts`, `apps/web/src/features/settings/MemoryScreen.test.tsx`

**Interfaces:**
- MemoryScreen (02 §2.7): пояснительный текст + список `entity.query aspect=orbis/memory, sortBy=updated_at:desc` (переиспользовать `EntityList` Browser); правка/архивация — обычный DetailScreen; отдельного редактора нет.
- Эскалация (01-arch §7.8): счётчик не хранится — вычисляется сканом журнала.
```ts
/** После успешной рекатегоризации (entity_update сменил category_ref, source ∈ ui|chat):
 *  скан chat_messages.metadata.actions за 30 дней; «одинаковое исправление» =
 *  та же пара (from_category, to_category) И counterpartySimilarity(title, title) ≥ 0.85
 *  (переиспользуем C1). При ≥ 2 совпадениях и отсутствии эквивалентного активного
 *  memory-правила — системное сообщение в глобальный тред с карточкой-предложением
 *  { type: 'memory_rule_suggestion', ruleText, fromCategoryId, toCategoryId }. */
export async function maybeSuggestRule(deps: { db; ownerId: string; action: ActionRecord }): Promise<void>;
```
- Карточка в чате: «Запомнить правило: „<нормализованный титул>“ → <категория>?» `[Запомнить]` → `entity.create` `orbis/memory {kind:'rule', scope:'orbis/financial'}`, title = правило текстом (формат, который парсит fast-path в D4: `«<паттерн> → <категория-title>»`), body — пояснение; `[Не надо]` → пометка в metadata карточки (повторное предложение той же пары подавляется наличием отклонённой карточки за 30 дней).

- [ ] **Шаг 1: тесты эскалации**: два одинаковых исправления за 30 дней → сообщение-предложение появилось; одно — нет; уже есть активное правило → нет; отклонённая карточка подавляет повтор; разные counterparty (similarity < 0.85) не суммируются.
- [ ] **Шаг 2:** тест MemoryScreen: рендер списка memory-сущностей, переход на detail.
- [ ] **Шаг 3:** FAIL → реализация → PASS.
- [ ] **Шаг 4:** Коммит `feat: экран памяти AI и эскалация повторных исправлений в правила (02 §2.7, 01-arch §7.8)`.

### Task D4: Correction-правила памяти в fast-path

**Files:**
- Modify: `apps/web/src/features/chat/useFastPath.ts` (загрузка правил в ctx), `packages/shared/src/fast-path/index.ts` (применение правил при резолве категории — если ctx-поле уже предусмотрено, только загрузка)
- Test: `packages/shared/src/fast-path/fast-path.test.ts` (дополнить), `apps/web/src/features/chat/useFastPath.test.ts`

**Interfaces:**
- Consumes: `entity.query aspect=orbis/memory, kind=rule, scope=orbis/financial` (кэш TanStack, staleTime 5 мин — правила меняются редко).
- Правило в ctx: `{ pattern: string; categoryRef: string }`, парсится из title правила формата D3; применение — **до** резолва по aliases: `normalizeCounterparty(вход).includes(pattern)` → категория правила (01-arch §7.5: «правило работает и в детерминированном пути»).

- [ ] **Шаг 1: тест shared**: ctx с правилом `бар → Развлечения` — ввод «бар 500» даёт categoryRef Развлечений, хотя alias «бар» указывает на Еду… (aliases Еды «бар» не содержат — взять реальный конфликт: правило перекрывает alias-резолв: «кофе 300» при правиле «кофе → Развлечения» уходит в Развлечения, без правила — в Еду по alias).
- [ ] **Шаг 2:** тест web: правила загружаются и передаются в ctx парсера.
- [ ] **Шаг 3:** FAIL → реализация → PASS.
- [ ] **Шаг 4:** Коммит `feat: memory-правила в fast-path-парсере (01-arch §7.5)`.

### Task D5: Полный detail-экран — блокировки и backlinks

**Files:**
- Create: `apps/web/src/features/entity-detail/Blocks.tsx`, `apps/web/src/features/entity-detail/Backlinks.tsx`
- Modify: `apps/web/src/features/entity-detail/DetailScreen.tsx` (секции 6–7 из 02 §3.5), `apps/server/src/routers/entity.ts` (процедура `backlinks`), `apps/server/src/entity-read.ts` (при необходимости include-расширение)
- Test: `apps/server/src/routers/entity-backlinks.test.ts`, `apps/web/src/features/entity-detail/Blocks.test.tsx`

**Interfaces:**
- Сервер: `entity.backlinks({ id })` → `{ explicit: WireEntity[]; byBodyRefs: WireEntity[] }` — явные `related_to`-связи (обе стороны) + сущности, чей `body_refs @> [id]` (GIN-индекс уже есть, 01-arch §4.9); неархивные, лимит 100.
- Blocks (02 §3.5.6): два списка — «блокирует» (исходящие `blocks`) и «заблокирована» (входящие `blocks` от незакрытых задач — фильтр статуса на клиенте по данным сущностей); данные — `entity.get(include:['relations'])` (проверить текущий include-контракт `entity-read.ts` и расширить, если relations не отдаются); `[+]` → выбор сущности (поиск по `entity.query search=`) → `relation.create blocks`; цикл → серверный отказ с путём цикла → показать плашкой (02 §6, A1.3 гарантирует, что проверка не деградирует).
- Backlinks (§3.5.7): объединённая секция с пометкой источника («связь» / «упоминание»).

- [ ] **Шаг 1: тест сервера**: body_refs-ссылка и related_to попадают в ответ; архивные исключены; чужие сущности недостижимы (RLS-паттерн).
- [ ] **Шаг 2:** тест web: секции рендерятся, скрыты при пустоте; создание blocks-связи; ошибка цикла показана с путём.
- [ ] **Шаг 3:** FAIL → реализация → PASS.
- [ ] **Шаг 4:** Коммит `feat: полный detail-экран — блокировки и backlinks (02 §3.5)`.

### Task D6: Приёмка слайса 2 целиком, ревью фазы

- [ ] **Шаг 1:** Прогнать **все шесть** приёмочных проверок финансового контура 03-budget §7 против локального стенда (§7.2 recurring-transition с двух «устройств» — два параллельных tRPC-вызова; §7.5 affordability — через чат: «могу позволить X?» с категорией без spend_class → явный запрос классификации).
- [ ] **Шаг 2:** Прогнать четыре приёмки Agenda 02-core-os §8.
- [ ] **Шаг 3:** `bun run typecheck && bun run lint && bun test && bun run test:rls`; смоук в браузере: полный «день пользователя» из 00-product §7 (обед 340 с остатком конверта → planned-покупка → закрытие → перевод в факт → «что по бюджету?» → рекатегоризация такси → на втором исправлении предложение правила).
- [ ] **Шаг 4:** code-review фазы (superpowers:requesting-code-review), merge; обновить `docs/implementation/02-ops-runbook.md` (новые env не появились — проверить) и памятку статуса в `docs/superpowers/plans/` при расхождениях.

---

## Осознанно НЕ входит в слайс 2 (зафиксировано, чтобы не всплывало ревью-сюрпризом)

- **Частичный tool-цикл `send-message`** (бэклог, Important): полноценный фикс требует переосмысления генерации id моделью; митигация (audit-контекст) остаётся, A1.5 закрывает соседний конкурентный ретрай. Кандидат в слайс 3 / отдельный RFC.
- **Append-only `chat_messages` на уровне БД** (defense-in-depth, недостижимо снаружи) — вместе с ревизией GRANT'ов.
- **Приоритизация scoped-памяти по якорю** (`llm/context.ts:118-127`) — грубое приближение §7.4 остаётся, кап 50.
- **LLM-предложение лимитов rollover** — эвристика A7; LLM-путь — Future.
- **LLM-категоризация строк импорта** — резолв aliases + memory-правила; LLM — Future.
- **Deep links, suggestion chips, query-builder-форма** — слайс 3 (00-product §9).
- **Ops-хвосты бэклога** (keepalive cron, `/ready`, digest-пиннинг) — отдельная ops-сессия, не блокируют слайс 2.

## Соответствие спеке (self-review прогнан)

| Требование 00-product §9 (слайс 2) | Задачи |
|---|---|
| Budget Overview и конверты (показывают историю слайса 1) | A4, A6, B1, B2 |
| Quick-add бар | B4 |
| Recurring-платежи/события, Coming up, planned→fact | A2, A3, A5, A6 (comingUp), B6 |
| Agenda-lite | D1, D2 |
| Rollover на границе месяца | A7, B6 |
| CSV-импорт с дедупом на entity_origins | C1–C5 |
| Экран памяти AI + эскалация исправлений | D3, D4 |
| Полный detail-экран (блокировки, backlinks) | D5 |
| Бейджи вкладок Budget/Agenda (02 §1.5, 03 §6.1) | B7, D2 |
| Приёмки 03 §7 (6 шт.) и 02 §8 (4 шт.) | A4–A8 (тесты), C2, D1, D6 (сквозные) |
| Вход в слайс 2 из бэклога ревью 2026-07-09 | A1 |


