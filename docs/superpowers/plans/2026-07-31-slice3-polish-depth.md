# Слайс 3 «Полировка и глубина» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Снять трение с уже работающих путей: ссылки и системный «назад», форматированный чат с продолжениями, редактор запросов формой, цели, считающие прогресс из графа — плюс гейты, которые не дают этому деградировать (спека `docs/superpowers/specs/2026-07-31-slice3-polish-depth-design.md`).

**Architecture:** Слайс не вводит новых доменов и не меняет ядро. Навигация получает второй источник правды — историю браузера, синхронизированную с существующим стором `useNav` в одну сторону за раз (флаг гасит петлю). Чипы приходят маркером в тексте ответа модели, без второго вызова LLM. Query-builder — обратная операция к существующему парсеру: строка блока в body остаётся единственным хранилищем. `orbis/goal` — восьмая запись реестра аспектов; прогресс считает существующий query-движок, нового механизма нет.

**Tech Stack:** Bun-монорепо; сервер — Hono + tRPC + Drizzle + PostgreSQL (Supabase); web — React + TanStack Query + Zustand + Tailwind v4 + Radix; LLM — `LLMProvider` поверх Vercel AI SDK (Anthropic, дефолт `claude-sonnet-5`); тесты — `bun test` (сервер, shared) и `vitest` (web), RLS — pgTAP.

## Глобальные ограничения

- **Один путь мутаций**: любая запись в граф — через executor (7 стадий); роутеры и UI бизнес-правил не содержат.
- **Деньги — только decimal-строки** (`"340.00"`), никакого `parseFloat`; SQL-сравнения через `::numeric`.
- **`packages/shared` не импортирует** React/Hono/Drizzle/tRPC-server/AI SDK.
- **Детерминированные ID порождаемого**: `uuidv5(ORBIS_NAMESPACE, …)`, `ORBIS_NAMESPACE = "cb339e97-82d7-4d16-91c6-942d42df7054"`; хелперы — `packages/shared/src/ids.ts`.
- **Изменение текста системного промпта = НОВЫЙ файл `vN`** + новая фикстура `vN.fixture.txt`; `v1` не правится (carried-решение, `apps/server/src/llm/prompts/v1.ts:2-4`).
- **Изменение схемы аспектов требует пересева реестра на проде** (`DATABASE_URL_ADMIN=… bun scripts/seed-aspects.ts`) — иначе фича приезжает мёртвой; стартовая проверка `/health` покажет `drift`.
- **Проверки перед каждым коммитом:** `bun run typecheck && bun run lint && bun test` из корня. **Код возврата lint проверять отдельным вызовом** — `bun run lint | tail` берёт exit code от `tail` и пропускает непрошедший линт (урок уборочной фазы).
- **Локальный стенд:** Docker + `npx supabase start`, иначе серверные тесты падают на `requireEnv`, а не на осмысленной ошибке.
- Коммиты — conventional commits с русским описанием (`feat(nav): …`, `fix(chat): …`), footer `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Каждая фаза — **отдельная ветка** с merge в `main` после ревью (`superpowers:requesting-code-review`).

## Декомпозиция

| Фаза | Ветка | Что даёт на выходе | Задачи |
|---|---|---|---|
| **A. Швы и гейты** | `slice3a-seams-gates` | Перф-гейт в CI, проверяемые сценарии на границах дат, сторож recurring-шаблонов | A1–A3 |
| **B. Ссылки и навигация** | `slice3b-deep-links` | Deep links, системный жест «назад», «Скопировать ссылку», полировка бейджей | B1–B6 |
| **C. Чат** | `slice3c-chat-polish` | Suggestion chips, markdown, карточки после перезагрузки | C1–C4 |
| **D. Query-builder** | `slice3d-query-builder` | Форма редактора query-блока с обратной сериализацией | D1–D4 |
| **E. Цели и горизонты** | `slice3e-goals` | `orbis/goal` с прогрессом из графа, горизонты планирования | E1–E5 |

Порядок: A → B → C → D → E. Жёсткая зависимость одна: **C зависит от B** (markdown делает `[[entity:…]]`-ссылки кликабельными — вести им некуда без маршрутов). D и E зависят только от A.

## Карта новых и изменяемых файлов

```
packages/shared/src/
  query/serialize.ts               (D1)  serializeQuery — AST → строка блока
  query/serialize.test.ts          (D1)  round-trip по всей грамматике
  nav/links.ts                     (B1)  parseAppUrl / buildAppPath — контракт маршрутов
  nav/links.test.ts                (B1)
  schemas/aspects.ts               (E1)  goalAspectSchema + ASPECT_SCHEMAS
  aspect-registry.ts               (E1)  запись orbis/goal
  constants.ts                     (E1)  BUILTIN_ASPECT_IDS += orbis/goal
  index.ts                         (B1, D1, E1)  реэкспорт

apps/server/src/
  budget/aggregates.ts             (A1)  clock-шов: localTodayTx/localToday + 6 агрегатов
  routers/budget.ts                (A1)  прокидывание clock (:113)
  test/perf.ts                     (A3)  measureMedian + сид объёма
  perf.test.ts                     (A3)  пороги шести операций
  budget/recurring-template.test.ts (A2) сторож: шаблон не входит в агрегаты
  executor/journal.ts              (C3)  audit-карточка получает kind
  llm/prompts/v2.ts                (C1)  промпт с протоколом чипов
  llm/prompts/v2.fixture.txt       (C1)
  llm/prompts/v2.test.ts           (C1)
  llm/context.ts                   (C1, E5)  переключение на vN
  ai/suggestions.ts                (C1)  extractSuggestions — вырезание маркера
  ai/send-message.ts               (C1)  metadata.suggestions (:398, :407)
  goals/progress.ts                (E2)  computeGoalProgress поверх query-движка
  routers/entity.ts                (E2)  goal.progress в ответе entity.get
  seed/smart-lists.ts              (E4)  пять горизонтов
  seed/onboarding.ts               (E4)  идемпотентный досев
  llm/prompts/v3.ts                (E5)  сценарии целей и горизонтов

apps/web/src/
  state/navigation.ts              (B2)  историю ведёт стор: pushState/popstate
  app/history.ts                   (B2)  синхронизатор + флаг «навигация из истории»
  app/NotFoundScreen.tsx           (B3)  экран «не найдено»
  app/router.tsx                   (B3)  ветка not-found
  features/entity-detail/DetailScreen.tsx  (B4, D2, E3)  «Скопировать ссылку», «настроить», прогресс цели
  ui/Badge.tsx                     (B5)  единый бейдж вкладки
  features/chat/cards/types.ts     (C3)  ActionCardData
  features/chat/cards/renderCards.tsx (C3)  ветка action_card
  features/chat/Suggestions.tsx    (C2)  чипы под последним ответом
  features/chat/MessageList.tsx    (C2, C4)  чипы + markdown
  lib/markdown/Markdown.tsx        (C4)  react-markdown + sanitize + entity-ссылки
  lib/query-blocks/QueryBlock.tsx  (D2)  кнопка «настроить»
  features/query-builder/          (D2, D3)  QueryBuilderForm, QueryTextEditor
  features/budget/TransactionsScreen.tsx (A2)  фильтр recurring-шаблонов
  features/entity-detail/GoalProgress.tsx (E3)  прогресс-бар цели

docs/prd/
  02-core-os.md                    (B6, D4)  §1.2, §1.3, §2.4, §3.4, §8
  00-product.md                    (E5)  §9 состав слайса 3
  03-budget.md                     (E5)  §7 приёмка
  04-decision-log.md               (B6, E5)  D18–D22
docs/implementation/02-ops-runbook.md (A3, E5)  чек-лист перф-замера, пересев реестра
```

---

# Фаза A — швы и гейты (`slice3a-seams-gates`)

### Task A1: Clock-шов в агрегатах + тесты границ дат

Сегодня «сегодня» берётся из системных часов внутри `localTodayTx` (`new Date()`, `aggregates.ts:58`), поэтому сценарии на границах дат непроверяемы. Шов приходит вместе с потребителями — тестами, которые его требуют.

**Files:**
- Modify: `apps/server/src/budget/aggregates.ts:50-63` (`localTodayTx`, `localToday`), `:527-537` (`preparePeriod`), `:541` (`budgetOverview`), `:557` (`budgetAlertCount`), `:571` (`budgetStatus`), `:604` (`envelopeForCategory`), `:642` (`categoryTrend`), `:748` (`rolloverPreview`)
- Modify: `apps/server/src/routers/budget.ts:113` (вызов `localToday`)
- Test: `apps/server/src/budget/aggregates.test.ts`

**Interfaces:**
- Produces: `type Clock = () => Date`; `localTodayTx(tx: Tx, ownerId: string, clock?: Clock): Promise<string>`; `localToday(db: Db, ownerId: string, clock?: Clock): Promise<string>`; шестая опция у агрегатов — последний необязательный параметр `clock?: Clock` (у `budgetOverview`/`budgetStatus` — после `month`, у `envelopeForCategory`/`categoryTrend`/`rolloverPreview` — после `args`/`month`).
- Дефолт везде — `() => new Date()`; прод-поведение не меняется.

- [ ] **Step 1: Написать падающий тест границы дня**

В `apps/server/src/budget/aggregates.test.ts` (следуй существующему стилю файла — живая БД, `freshUserId`, `requireEnv`):

```ts
test('clock-шов: планируемая покупка становится фактом в день наступления даты', async () => {
  const user = await freshUserId();
  await seedUserWithCategories(user); // хелпер файла
  // Покупка запланирована на 2026-09-05, «сегодня» подменяем на 2026-09-04 и 2026-09-05.
  const entityId = await createPlannedExpense(user, { occurredOn: '2026-09-05', amount: '1000.00' });

  const before = await budgetOverview(db, user, '2026-09', () => new Date('2026-09-04T10:00:00Z'));
  expect(before.planned.some((p) => p.entityId === entityId)).toBe(true);
  expect(before.envelopes.find((e) => e.categoryTitle === 'Еда')?.spent).toBe('0.00');

  const after = await budgetOverview(db, user, '2026-09', () => new Date('2026-09-05T10:00:00Z'));
  expect(after.envelopes.find((e) => e.categoryTitle === 'Еда')?.spent).toBe('1000.00');
});
```

- [ ] **Step 2: Запустить тест, убедиться, что он падает**

Run: `cd apps/server && bun test src/budget/aggregates.test.ts -t 'clock-шов'`
Expected: FAIL — `budgetOverview` принимает три аргумента, четвёртый игнорируется, обе ветки дают одинаковый результат.

- [ ] **Step 3: Ввести шов в двух базовых функциях**

```ts
/** Источник «сейчас» — подменяется в тестах границ дат; в проде системные часы. */
export type Clock = () => Date;
const SYSTEM_CLOCK: Clock = () => new Date();

export async function localTodayTx(tx: Tx, ownerId: string, clock: Clock = SYSTEM_CLOCK): Promise<string> {
  const rows = await tx
    .select({ timezone: userSettings.timezone })
    .from(userSettings)
    .where(eq(userSettings.ownerId, ownerId));
  const stored = rows[0]?.timezone ?? DEFAULT_TIMEZONE;
  const timezone = isValidTimeZone(stored) ? stored : DEFAULT_TIMEZONE;
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(clock());
}

export async function localToday(db: Db, ownerId: string, clock: Clock = SYSTEM_CLOCK): Promise<string> {
  return withIdentity(db, ownerId, (tx) => localTodayTx(tx, ownerId, clock));
}
```

- [ ] **Step 4: Прокинуть clock через все точки**

`preparePeriod(db, ownerId, clock)` → `localToday(db, ownerId, clock)`; затем последним необязательным параметром в `budgetOverview`, `budgetAlertCount`, `budgetStatus`, `envelopeForCategory`, `categoryTrend`, `rolloverPreview`. Ни одного вызова `new Date()` в этих функциях не остаётся.

Проверка полноты: `rg -an "new Date\(\)" apps/server/src/budget/aggregates.ts` — ожидается одно вхождение, в `SYSTEM_CLOCK`.

- [ ] **Step 5: Запустить тест, убедиться, что он проходит**

Run: `cd apps/server && bun test src/budget/aggregates.test.ts`
Expected: PASS, включая все существующие тесты файла (дефолт сохраняет прежнее поведение).

- [ ] **Step 6: Добавить тест границы месяца в rollover**

```ts
test('clock-шов: rollover-превью границы месяца считает остатки закрывающегося месяца', async () => {
  const user = await freshUserId();
  await seedEnvelope(user, { month: '2026-08', limit: '10000.00', spent: '7000.00' });
  const preview = await rolloverPreview(db, user, '2026-09', () => new Date('2026-09-01T00:30:00Z'));
  expect(preview.rows[0]?.carryover).toBe('3000.00');
});
```

- [ ] **Step 7: Прогнать весь серверный сьют и закоммитить**

Run: `bun run typecheck && bun run lint; echo "lint=$?" && bun test`

```bash
git add apps/server/src/budget/aggregates.ts apps/server/src/routers/budget.ts apps/server/src/budget/aggregates.test.ts
git commit -m "test(budget): шов подмены «сегодня» и сценарии на границах дат"
```

---

### Task A2: Сторож recurring-шаблонов

Решение D20: состояние «шаблон с `occurred_on`» остаётся валидным, но не должно ни попадать в агрегаты, ни показываться в списках транзакций.

**Files:**
- Create: `apps/server/src/budget/recurring-template.test.ts`
- Modify: `apps/web/src/features/budget/TransactionsScreen.tsx`
- Test: `apps/web/src/features/budget/budget.test.tsx` (существующий файл списка транзакций)

**Interfaces:**
- Consumes: `isRecurringTemplate(e)` — `apps/web/src/features/agenda/useAgenda.ts:81`; тип параметра расширить до структурной формы `{ aspects?: Record<string, unknown> }`, если тип экрана транзакций не совпадает с `AgendaEntity`.
- Produces: ничего нового наружу.

- [ ] **Step 1: Написать серверный тест-сторож**

```ts
// apps/server/src/budget/recurring-template.test.ts
// D20: шаблон с occurred_on — валидное состояние (флоу «Сделать повторяющейся»),
// но он НЕ факт траты: ни один агрегат его не считает.
test('recurring-шаблон с occurred_on не входит ни в один агрегат', async () => {
  const user = await freshUserId();
  await seedUserWithCategories(user);
  await createRecurringTemplate(user, {
    occurredOn: '2026-09-03',
    amount: '50000.00',
    recurrence: 'FREQ=MONTHLY;BYMONTHDAY=5',
  });

  const clock = () => new Date('2026-09-10T10:00:00Z');
  const overview = await budgetOverview(db, user, '2026-09', clock);
  const status = await budgetStatus(db, user, '2026-09', clock);

  expect(overview.envelopes.every((e) => e.spent === '0.00')).toBe(true);
  expect(overview.unbudgeted).toBe('0.00');
  expect(status.planned.every((p) => p.amount !== '50000.00')).toBe(true);
});
```

- [ ] **Step 2: Запустить тест**

Run: `cd apps/server && bun test src/budget/recurring-template.test.ts`
Expected: PASS — сокрытие держится «по построению». Тест фиксирует это свойство; если он красный, значит дыра живая и её чинит эта же задача (фильтр по `recurrence IS NOT NULL` в отборе транзакций агрегатов).

- [ ] **Step 3: Написать падающий web-тест списка транзакций**

```ts
test('шаблон recurring не показывается в списке транзакций', async () => {
  const rows = [
    { id: 'tpl', title: 'Аренда', aspects: { 'orbis/financial': { amount: '50000.00', direction: 'expense', occurred_on: '2026-09-05' }, 'orbis/schedule': { recurrence: 'FREQ=MONTHLY;BYMONTHDAY=5', start_at: '2026-09-05T00:00:00Z' } } },
    { id: 'fact', title: 'Обед', aspects: { 'orbis/financial': { amount: '340.00', direction: 'expense', occurred_on: '2026-09-05' } } },
  ];
  renderWithProviders(<TransactionsScreen />, handlerReturning(rows));
  expect(await screen.findByText('Обед')).toBeInTheDocument();
  expect(screen.queryByText('Аренда')).not.toBeInTheDocument();
});
```

- [ ] **Step 4: Запустить web-тест, убедиться, что он падает**

Run: `cd apps/web && bunx vitest run src/features/budget/budget.test.tsx -t 'шаблон recurring'`
Expected: FAIL — «Аренда» найдена в списке.

- [ ] **Step 5: Добавить фильтр в экран транзакций**

В `TransactionsScreen.tsx` отфильтровать строки через `isRecurringTemplate` перед рендером, с комментарием-ссылкой на D20.

- [ ] **Step 6: Запустить тесты, убедиться, что проходят**

Run: `cd apps/web && bunx vitest run src/features/budget/`
Expected: PASS

- [ ] **Step 7: Коммит**

```bash
git add apps/server/src/budget/recurring-template.test.ts apps/web/src/features/budget/
git commit -m "fix(budget): recurring-шаблон не притворяется тратой ни в агрегатах, ни в списке"
```

---

### Task A3: Перф-гейт в CI

Решение D21: серверные пороги — автотест, роняющий CI; числа печатаются всегда.

**Files:**
- Create: `apps/server/src/test/perf.ts` (сид объёма + измеритель)
- Create: `apps/server/src/perf.test.ts`
- Modify: `.github/workflows/ci.yml:37` (после `bun run test`)
- Modify: `docs/implementation/02-ops-runbook.md` (чек-лист ручного замера клиента)

**Interfaces:**
- Produces: `seedPerfFixture(db, ownerId): Promise<void>` — 2000 сущностей, 1000 транзакций, 12 конвертов; `measureMedian(label: string, runs: number, fn: () => Promise<unknown>): Promise<number>` — печатает `perf: <label> median=<n>ms runs=<runs>` и возвращает медиану в миллисекундах.

- [ ] **Step 1: Написать измеритель и сид**

```ts
// apps/server/src/test/perf.ts
export async function measureMedian(
  label: string,
  runs: number,
  fn: () => Promise<unknown>,
): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)] as number;
  // Печатаем ВСЕГДА: дрейф виден глазами и на зелёном прогоне (D21).
  console.log(`perf: ${label} median=${median.toFixed(1)}ms runs=${runs}`);
  return median;
}
```

Сид: `seedPerfFixture` создаёт данные ОДНИМ batch на группу (не по одной сущности) — иначе сам сид станет самой долгой частью прогона.

- [ ] **Step 2: Написать перф-тест с порогами**

```ts
// apps/server/src/perf.test.ts
// D21: гейт ловит грубую регрессию (потерянный индекс, N+1), а не колебания раннера,
// поэтому пороги заданы кратно измеренным значениям. Числа печатаются всегда.
const BUDGETS_MS: Record<string, number> = {
  'entity.query:list50': 400,
  'entity.count:badge': 250,
  'budget.overview': 900,
  'agenda:horizon': 600,
  'entity.backlinks': 400,
  'fastpath:create': 700,
};

test('перф-бюджеты серверных операций', async () => {
  const user = await freshUserId();
  await seedPerfFixture(db, user);
  const caller = createCaller(await ctxFor(user));

  const results: [string, number][] = [
    ['entity.query:list50', await measureMedian('entity.query:list50', 7, () =>
      caller.entity.query({ query: 'aspect=orbis/task, status=!done, sortBy=updated_at:desc, limit=50' }))],
    ['entity.count:badge', await measureMedian('entity.count:badge', 7, () =>
      caller.entity.count({ query: 'aspect=orbis/task, status=inbox' }))],
    ['budget.overview', await measureMedian('budget.overview', 5, () => caller.budget.overview({}))],
    ['agenda:horizon', await measureMedian('agenda:horizon', 5, () =>
      caller.entity.query({ query: 'aspect=orbis/schedule, start_at=next_7d, sortBy=start_at:asc, limit=100' }))],
    ['entity.backlinks', await measureMedian('entity.backlinks', 7, () =>
      caller.entity.get({ id: hubEntityId }))],
    ['fastpath:create', await measureMedian('fastpath:create', 5, () =>
      caller.entity.create(fastPathPayload()))],
  ];

  const over = results.filter(([k, v]) => v > (BUDGETS_MS[k] as number));
  expect(over.map(([k, v]) => `${k}=${v.toFixed(0)}ms`)).toEqual([]);
});
```

- [ ] **Step 3: Прогнать на локальном стенде и откалибровать пороги**

Run: `cd apps/server && bun test src/perf.test.ts`
Ожидаемое: PASS; в логе — шесть строк `perf: …`. Если измеренное значение ближе чем в 2 раза к порогу — поднять порог в `BUDGETS_MS` до кратного запаса и записать измеренное число комментарием рядом с ключом.

- [ ] **Step 4: Проверить, что гейт умеет краснеть**

Временно занизь один порог до `1`, запусти тест.
Expected: FAIL со списком вида `["budget.overview=NNNms"]`. Верни порог обратно.

- [ ] **Step 5: Подключить в CI**

В `.github/workflows/ci.yml` перф-тест уже попадает в `bun run test` (он часть серверного сьюта) — отдельного шага не требуется; убедиться, что файл не исключён конфигом. Если прогон в CI занимает больше минуты — вынести сид в `beforeAll` одного describe и переиспользовать между операциями.

- [ ] **Step 6: Добавить чек-лист ручного замера клиента в runbook**

В `docs/implementation/02-ops-runbook.md` — раздел «Перф-чек-лист перед релизом»: замер time-to-log расхода в чате (цель < 5 сек, fast-path < 2 сек — 00-product §8), первая отрисовка Budget Overview и Agenda на телефоне владельца, запись измеренных чисел с датой релиза.

- [ ] **Step 7: Коммит**

```bash
git add apps/server/src/test/perf.ts apps/server/src/perf.test.ts docs/implementation/02-ops-runbook.md
git commit -m "test(perf): перф-бюджеты серверных операций как гейт CI + чек-лист клиента"
```

---

# Фаза B — ссылки и навигация (`slice3b-deep-links`)

### Task B1: Контракт маршрутов в shared

Чистые функции без React и DOM — тестируются в изоляции и переиспользуются сервером, если понадобится строить ссылки.

**Files:**
- Create: `packages/shared/src/nav/links.ts`, `packages/shared/src/nav/links.test.ts`
- Modify: `packages/shared/src/index.ts` (реэкспорт)

**Interfaces:**
- Produces:
  ```ts
  export type AppScreen =
    | { kind: 'tab-root'; tab: 'chat' | 'browser' | 'agenda' | 'budget' }
    | { kind: 'entity'; id: string }
    | { kind: 'thread'; threadId: string }
    | { kind: 'budget-category'; id: string };
  export function buildAppPath(screen: AppScreen): string;
  export function parseAppPath(path: string): AppScreen | null;
  export function tabOfScreen(screen: AppScreen): 'chat' | 'browser' | 'agenda' | 'budget';
  ```
- Маршруты (02-core-os §1.3): `/chat`, `/browser`, `/agenda`, `/budget`, `/entity/<uuid>`, `/thread/<uuid>`, `/budget/category/<uuid>`. Вкладка целевого экрана: `entity` → `browser`, `thread` → `browser` (тред сущности) либо `chat` (глобальный тред — решает вызывающий по данным), `budget-category` → `budget`.

- [ ] **Step 1: Написать падающий тест round-trip**

```ts
// packages/shared/src/nav/links.test.ts
import { describe, expect, test } from 'bun:test';
import { buildAppPath, parseAppPath, tabOfScreen } from './links';

const ID = '0198f0a1-1111-7000-8000-000000000001';

describe('контракт маршрутов (02-core-os §1.3)', () => {
  test('round-trip: путь ↔ экран', () => {
    const screens = [
      { kind: 'tab-root', tab: 'budget' },
      { kind: 'entity', id: ID },
      { kind: 'thread', threadId: ID },
      { kind: 'budget-category', id: ID },
    ] as const;
    for (const s of screens) expect(parseAppPath(buildAppPath(s))).toEqual(s);
  });

  test('чужой и битый путь — null, а не догадка', () => {
    expect(parseAppPath('/entity/not-a-uuid')).toBeNull();
    expect(parseAppPath('/nope')).toBeNull();
    expect(parseAppPath('/entity')).toBeNull();
  });

  test('вкладка экрана', () => {
    expect(tabOfScreen({ kind: 'entity', id: ID })).toBe('browser');
    expect(tabOfScreen({ kind: 'budget-category', id: ID })).toBe('budget');
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться, что он падает**

Run: `cd packages/shared && bun test src/nav/links.test.ts`
Expected: FAIL — модуль не существует.

- [ ] **Step 3: Реализовать links.ts**

Разбор строго по регэкспу с проверкой UUID (тот же `UUID_RE`, что в парсере запросов — скопировать константу локально, не тянуть зависимость из `query/`). Ничего не угадывать: неизвестный путь → `null`.

- [ ] **Step 4: Запустить тест, убедиться, что проходит**

Run: `cd packages/shared && bun test src/nav/links.test.ts`
Expected: PASS

- [ ] **Step 5: Реэкспорт и коммит**

```bash
git add packages/shared/src/nav packages/shared/src/index.ts
git commit -m "feat(nav): контракт маршрутов deep links (02-core-os §1.3)"
```

---

### Task B2: Синхронизация навигации с историей браузера

Ядро фазы. Решение D18: история — носитель пути; `push` пишет запись, `pop` откатывает историю, `switchTab` — тоже запись пути.

**Files:**
- Create: `apps/web/src/app/history.ts`
- Modify: `apps/web/src/state/navigation.ts` (весь стор), `apps/web/src/app/ScreenHeader.tsx:25-31` (кнопка «Назад» вызывает `goBack`)
- Test: `apps/web/src/app/history.test.tsx`, существующий `apps/web/src/app/back-nav.test.tsx`

**Interfaces:**
- Consumes: `buildAppPath`, `parseAppPath`, `tabOfScreen` (B1); существующий стор `useNav` (`activeTab`, `stacks`, `push`, `pop`, `switchTab`, `resetTabToRoot`).
- Produces:
  ```ts
  // apps/web/src/app/history.ts
  export function installHistorySync(): () => void; // подписка на popstate; возвращает отписку
  export function goBack(): void;                   // единственная точка «назад» для UI
  export type NavHistoryState = { tab: Tab; depth: number };
  ```
- Внутренние функции модуля (не экспортируются, но на них ссылаются шаги):
  ```ts
  function navState(): NavHistoryState;                       // {tab: activeTab, depth: stacks[activeTab].length}
  function currentScreen(): AppScreen;                        // верх стека активной вкладки либо корень
  function screenRefToAppScreen(ref: ScreenRef, tab: Tab): AppScreen; // ScreenRef стора → AppScreen контракта B1
  function applyState(state: NavHistoryState | null, path: string): void; // история → стор
  ```
  `ScreenRef`-варианты без собственного маршрута (`budget-transactions`, `budget-rollover`, `budget-import`, `memory`, `settings`) отображаются в `{ kind: 'tab-root', tab }` — у них нет внешней ссылки, и адресная строка показывает корень вкладки.
- Инвариант: ровно один источник инициативы за раз. Флаг модуля `applyingHistory` поднимается на время применения `popstate` к стору; пока он поднят, подписчик стора в историю не пишет.

- [ ] **Step 1: Написать падающий тест «push пишет историю, back снимает экран»**

```ts
// apps/web/src/app/history.test.tsx
test('push пишет запись истории, popstate снимает верхний экран', async () => {
  const uninstall = installHistorySync();
  useNav.getState().switchTab('browser');
  useNav.getState().push('browser', { kind: 'entity', id: E1 });
  expect(window.location.pathname).toBe(`/entity/${E1}`);

  // Эмуляция системного жеста «назад»
  window.history.back();
  await waitFor(() => expect(useNav.getState().stacks.browser).toHaveLength(0));
  uninstall();
});
```

- [ ] **Step 2: Написать падающий тест «back на корне возвращает на предыдущую вкладку» (D18)**

```ts
test('D18: back на корне вкладки возвращает на вкладку, с которой пришли', async () => {
  const uninstall = installHistorySync();
  useNav.getState().switchTab('chat');
  useNav.getState().switchTab('budget');
  window.history.back();
  await waitFor(() => expect(useNav.getState().activeTab).toBe('chat'));
  uninstall();
});
```

- [ ] **Step 3: Написать падающий тест «нет петли»**

```ts
test('применение popstate не порождает новых записей истории', async () => {
  const uninstall = installHistorySync();
  useNav.getState().switchTab('browser');
  useNav.getState().push('browser', { kind: 'entity', id: E1 });
  const lenBefore = window.history.length;
  window.history.back();
  await waitFor(() => expect(useNav.getState().stacks.browser).toHaveLength(0));
  expect(window.history.length).toBe(lenBefore);
  uninstall();
});
```

- [ ] **Step 4: Запустить тесты, убедиться, что падают**

Run: `cd apps/web && bunx vitest run src/app/history.test.tsx`
Expected: FAIL — модуля нет, `location.pathname` не меняется.

- [ ] **Step 5: Реализовать history.ts**

```ts
// apps/web/src/app/history.ts
// D18: история браузера — носитель пути навигации. Один источник инициативы за раз:
// пока applyingHistory поднят, подписчик стора в историю НЕ пишет (иначе petля push↔popstate).
let applyingHistory = false;

function currentScreen(): AppScreen {
  const { activeTab, stacks } = useNav.getState();
  const top = stacks[activeTab].at(-1);
  return top ? screenRefToAppScreen(top, activeTab) : { kind: 'tab-root', tab: activeTab };
}

export function installHistorySync(): () => void {
  // Стартовая запись: текущее состояние стора (после восстановления persist, §1.4).
  window.history.replaceState(navState(), '', buildAppPath(currentScreen()));

  const unsubscribe = useNav.subscribe(() => {
    if (applyingHistory) return;
    window.history.pushState(navState(), '', buildAppPath(currentScreen()));
  });

  const onPop = (e: PopStateEvent) => {
    const state = e.state as NavHistoryState | null;
    applyingHistory = true;
    try {
      applyState(state, window.location.pathname);
    } finally {
      applyingHistory = false;
    }
  };
  window.addEventListener('popstate', onPop);
  return () => {
    unsubscribe();
    window.removeEventListener('popstate', onPop);
  };
}

/** Единственная точка «назад» для UI: и кнопка шапки, и жест ведут через историю. */
export function goBack(): void {
  window.history.back();
}
```

`applyState` восстанавливает `activeTab` и глубину стека из `NavHistoryState`; экраны, которых в стеке уже нет (глубина в состоянии больше текущей), добираются из пути через `parseAppPath`.

- [ ] **Step 6: Перевести кнопку «Назад» на goBack**

`ScreenHeader.tsx`: `onClick={() => pop(activeTab)}` → `onClick={goBack}`. Кнопка и жест обязаны вести себя одинаково — это то, что проверяет тест шага 7.

- [ ] **Step 7: Тест эквивалентности кнопки и жеста**

```ts
test('кнопка «Назад» и системный жест дают одинаковый результат', async () => {
  // Ветка 1: кнопка
  // Ветка 2: window.history.back()
  // Оба раза — один и тот же стек и одна и та же вкладка.
});
```

- [ ] **Step 8: Запустить весь web-сьют**

Run: `cd apps/web && bunx vitest run`
Expected: PASS. Существующий `back-nav.test.tsx` мог опираться на прямой `pop` — обновить его под новую точку входа, сохранив проверяемое свойство («назад» снимает один уровень, а не сбрасывает до корня).

- [ ] **Step 9: Коммит**

```bash
git add apps/web/src/app/history.ts apps/web/src/app/history.test.tsx apps/web/src/app/ScreenHeader.tsx apps/web/src/app/back-nav.test.tsx apps/web/src/state/navigation.ts
git commit -m "feat(nav): историю браузера ведёт навигация — жест «назад» работает как back приложения"
```

---

### Task B3: Вход по внешней ссылке и экран «не найдено»

**Files:**
- Create: `apps/web/src/app/NotFoundScreen.tsx`
- Modify: `apps/web/src/App.tsx` (вызов `installHistorySync` + разбор стартового URL), `apps/web/src/app/router.tsx`
- Test: `apps/web/src/app/deep-link.test.tsx`

**Interfaces:**
- Consumes: `parseAppPath`, `tabOfScreen` (B1), `installHistorySync` (B2).
- Produces: `openDeepLink(path: string): boolean` в `history.ts` — сбрасывает стек целевой вкладки и пушит целевой экран (§1.3); `false`, если путь не разобран.

- [ ] **Step 1: Написать падающий тест входа по ссылке**

```ts
test('вход по ссылке сбрасывает стек целевой вкладки и открывает экран', async () => {
  useNav.setState({ activeTab: 'chat', stacks: { chat: [], browser: [{ kind: 'entity', id: OLD }], agenda: [], budget: [] } });
  openDeepLink(`/entity/${E1}`);
  expect(useNav.getState().activeTab).toBe('browser');
  expect(useNav.getState().stacks.browser).toEqual([{ kind: 'entity', id: E1 }]);
});
```

- [ ] **Step 2: Написать падающий тест «не найдено»**

```ts
test('чужой id даёт экран «не найдено» с возвратом на корень', async () => {
  renderWithProviders(<App />, (path) => {
    if (path === 'entity.get') throw trpcError('NOT_FOUND');
    return {};
  });
  openDeepLink(`/entity/${E1}`);
  expect(await screen.findByText('Не найдено')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'На главную' }));
  expect(useNav.getState().stacks.browser).toHaveLength(0);
});
```

- [ ] **Step 3: Запустить тесты, убедиться, что падают**

Run: `cd apps/web && bunx vitest run src/app/deep-link.test.tsx`
Expected: FAIL — `openDeepLink` не существует.

- [ ] **Step 4: Реализовать openDeepLink и NotFoundScreen**

`NotFoundScreen` — заголовок «Не найдено», пояснение «Запись удалена или недоступна», кнопка «На главную» (`resetTabToRoot(activeTab)`). В `DetailScreen` ошибка `NOT_FOUND` от `entity.get` рендерит этот экран вместо пустого состояния.

- [ ] **Step 5: Подключить в App.tsx**

```tsx
useEffect(() => {
  const uninstall = installHistorySync();
  // Стартовый URL: внешний вход имеет приоритет над восстановленным стеком (§1.3).
  openDeepLink(window.location.pathname);
  return uninstall;
}, []);
```

- [ ] **Step 6: Запустить тесты**

Run: `cd apps/web && bunx vitest run src/app/`
Expected: PASS

- [ ] **Step 7: Коммит**

```bash
git add apps/web/src/app/NotFoundScreen.tsx apps/web/src/app/deep-link.test.tsx apps/web/src/App.tsx apps/web/src/app/history.ts apps/web/src/app/router.tsx
git commit -m "feat(nav): вход по внешней ссылке и честный экран «не найдено»"
```

---

### Task B4: «Скопировать ссылку» в меню detail-экрана

**Files:**
- Modify: `apps/web/src/features/entity-detail/DetailScreen.tsx` (меню ⋮)
- Test: `apps/web/src/features/entity-detail/detail.test.tsx`

**Interfaces:**
- Consumes: `buildAppPath` (B1).
- Ссылка абсолютная: `window.location.origin + buildAppPath({ kind: 'entity', id })`.

- [ ] **Step 1: Написать падающий тест**

```ts
test('«Скопировать ссылку» кладёт абсолютный адрес сущности в буфер', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  renderWithProviders(<DetailScreen id={E1} />, handler);
  fireEvent.click(await screen.findByTestId('detail-menu'));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Скопировать ссылку' }));
  expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/entity/${E1}`);
});
```

- [ ] **Step 2: Запустить, убедиться в падении**

Run: `cd apps/web && bunx vitest run src/features/entity-detail/detail.test.tsx -t 'Скопировать ссылку'`
Expected: FAIL — пункта меню нет.

- [ ] **Step 3: Добавить пункт меню**

После копирования — короткий тост/подпись «Ссылка скопирована»; отказ `clipboard` (нет разрешения) показывает ссылку текстом для ручного копирования, а не молчит.

- [ ] **Step 4: Запустить тест**

Run: `cd apps/web && bunx vitest run src/features/entity-detail/`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add apps/web/src/features/entity-detail/
git commit -m "feat(nav): пункт «Скопировать ссылку» на detail-экране"
```

---

### Task B5: Полировка бейджей вкладок

Три бейджа уже работают (`router.tsx`: `chatBadge`, `agendaOverdue`, `budgetBadge`), но нарисованы каждый по-своему.

**Files:**
- Create: `apps/web/src/ui/Badge.tsx`
- Modify: `apps/web/src/app/router.tsx`, `apps/web/src/app/SidebarNav.tsx`
- Test: `apps/web/src/ui/badge.test.tsx`

**Interfaces:**
- Produces: `<Badge count={number} label={string} />` — не рендерит ничего при `count <= 0`, показывает `99+` при `count > 99`, несёт `aria-label` вида «3 просроченных».

- [ ] **Step 1: Написать тест компонента**

```ts
test('бейдж: ноль скрыт, 100 показывается как 99+, есть доступное имя', () => {
  const { rerender, container } = render(<Badge count={0} label="просроченных" />);
  expect(container).toBeEmptyDOMElement();
  rerender(<Badge count={100} label="просроченных" />);
  expect(screen.getByText('99+')).toBeInTheDocument();
  expect(screen.getByLabelText('100 просроченных')).toBeInTheDocument();
});
```

- [ ] **Step 2: Запустить, убедиться в падении**

Run: `cd apps/web && bunx vitest run src/ui/badge.test.tsx`
Expected: FAIL

- [ ] **Step 3: Реализовать Badge и перевести три места на него**

Единый стиль + мягкое появление (`animate-in fade-in`, при `prefers-reduced-motion` — без анимации).

- [ ] **Step 4: Запустить web-сьют**

Run: `cd apps/web && bunx vitest run`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add apps/web/src/ui/Badge.tsx apps/web/src/ui/badge.test.tsx apps/web/src/app/
git commit -m "refactor(ui): единый бейдж вкладок вместо трёх разных"
```

---

### Task B6: Правки PRD и решение D18

**Files:**
- Modify: `docs/prd/02-core-os.md` §1.2, §1.3
- Modify: `docs/prd/04-decision-log.md` (запись D18)

- [ ] **Step 1: Переписать §1.2**

Правило back формулируется по D18: back снимает верхний push-экран активной вкладки; на корне вкладки возвращает на вкладку, с которой на неё переключились; из приложения уводит только в конце пути. Прежняя формулировка помечается как отменённая ссылкой на D18.

- [ ] **Step 2: Обновить §1.3**

Добавить фактические маршруты PWA (`/entity/<id>` и прочие из B1), снять пометку «[слайс 3]» с пункта «Скопировать ссылку».

- [ ] **Step 3: Добавить D18 в decision log**

Формат — как у D13–D17: Решение / Статус (принято 2026-07-31, владелец подтвердил) / Обоснование / Заменяет / Детали.

- [ ] **Step 4: Коммит**

```bash
git add docs/prd/02-core-os.md docs/prd/04-decision-log.md
git commit -m "docs(prd): D18 — back идёт по фактическому пути; маршруты deep links"
```

---

# Фаза C — чат (`slice3c-chat-polish`)

### Task C1: Промпт v2 и серверная часть suggestion chips

Решение D19: маркер в конце ответа, второго вызова LLM нет.

**Files:**
- Create: `apps/server/src/llm/prompts/v2.ts`, `apps/server/src/llm/prompts/v2.fixture.txt`, `apps/server/src/llm/prompts/v2.test.ts`
- Create: `apps/server/src/ai/suggestions.ts`, `apps/server/src/ai/suggestions.test.ts`
- Modify: `apps/server/src/llm/context.ts:26,255`, `apps/server/src/ai/send-message.ts:395-411`
- Test: `apps/server/src/ai/send-message.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // apps/server/src/ai/suggestions.ts
  export const SUGGEST_MARKER_RE: RegExp; // строгая форма маркера
  export function extractSuggestions(text: string): { text: string; suggestions: string[] };
  ```
  Маркер — последняя строка ответа вида `[[suggest: что по бюджету? | поставить срок]]`; разделитель — `|`; берутся первые 4 непустые части после `trim`, каждая длиной ≤ 60 символов. Маркер вырезается из `text` вместе с ведущими переводами строк.
- `metadata` assistant-сообщения получает поле `suggestions?: string[]` — пишется только если непусто.

- [ ] **Step 1: Написать падающий тест парсера**

```ts
// apps/server/src/ai/suggestions.test.ts
test('маркер вырезается из текста, продолжения разбираются', () => {
  const raw = 'Записал 340 ₽ в Еду.\n\n[[suggest: что по бюджету? | сколько осталось на еду?]]';
  const r = extractSuggestions(raw);
  expect(r.text).toBe('Записал 340 ₽ в Еду.');
  expect(r.suggestions).toEqual(['что по бюджету?', 'сколько осталось на еду?']);
});

test('маркера нет — текст не тронут, продолжений нет', () => {
  const r = extractSuggestions('Готово.');
  expect(r).toEqual({ text: 'Готово.', suggestions: [] });
});

test('битый маркер остаётся частью текста, но продолжений не даёт', () => {
  const r = extractSuggestions('Готово.\n[[suggest:]]');
  expect(r.suggestions).toEqual([]);
  expect(r.text).toContain('Готово.');
});

test('больше четырёх продолжений усекается до четырёх', () => {
  const r = extractSuggestions('Ок.\n[[suggest: a | b | c | d | e]]');
  expect(r.suggestions).toHaveLength(4);
});
```

- [ ] **Step 2: Запустить, убедиться в падении**

Run: `cd apps/server && bun test src/ai/suggestions.test.ts`
Expected: FAIL — модуля нет.

- [ ] **Step 3: Реализовать extractSuggestions**

Строгий регэксп по последней строке; при неполном совпадении — вернуть исходный текст и пустой список (деградация без мусора в ленте).

- [ ] **Step 4: Создать промпт v2**

Копия `SYSTEM_PROMPT_V1` + блок:

```
Продолжения разговора:
- В КОНЦЕ ответа отдельной последней строкой добавляй 2–4 коротких продолжения в формате [[suggest: первое | второе | третье]] — это варианты следующей реплики ПОЛЬЗОВАТЕЛЯ, а не твои действия.
- Продолжения пиши от лица пользователя, коротко (до 60 символов): «что по бюджету?», «поставить срок», «показать все задачи».
- Если продолжать разговор нечем — строку не добавляй вовсе.
```

`v2.ts` экспортирует `SYSTEM_PROMPT_V2`, `SYSTEM_PROMPT_VERSION = 'v2'`, реэкспорт `TOOL_RESULT_MARKER`. `v2.fixture.txt` — точная копия текста. `v2.test.ts` — копия структуры `v1.test.ts` (фикстура + версия + семантические гарды, включая новый гард на блок продолжений). `v1.ts` и его тест **остаются нетронутыми**.

- [ ] **Step 5: Переключить context.ts на v2**

`import { SYSTEM_PROMPT_V2, TOOL_RESULT_MARKER } from './prompts/v2'` и `const sections: string[] = [SYSTEM_PROMPT_V2]`.

- [ ] **Step 6: Написать падающий тест send-message**

```ts
test('продолжения из ответа модели попадают в metadata.suggestions, а не в текст', async () => {
  const llm = scriptedLLM([{ content: 'Записал.\n\n[[suggest: что по бюджету? | отменить]]', stopReason: 'end_turn' }]);
  const r = await sendMessage({ /* … */ }, { llm });
  expect(r.assistantMessage.content).toBe('Записал.');
  expect((r.assistantMessage.metadata as { suggestions?: string[] }).suggestions).toEqual([
    'что по бюджету?', 'отменить',
  ]);
});
```

- [ ] **Step 7: Запустить, убедиться в падении, затем реализовать**

Run: `cd apps/server && bun test src/ai/send-message.test.ts -t 'продолжения'`
Expected: FAIL → в `send-message.ts` перед персистом прогнать `finalText` через `extractSuggestions`, писать `metadata: { cards, replyTo: input.id, ...(suggestions.length ? { suggestions } : {}) }`, обновить комментарий `:398` (пометка «слайс 3» снимается).

- [ ] **Step 8: Прогнать серверный сьют и закоммитить**

Run: `bun run typecheck && bun run lint; echo "lint=$?" && bun test`

```bash
git add apps/server/src/llm/prompts/ apps/server/src/ai/suggestions.ts apps/server/src/ai/suggestions.test.ts apps/server/src/ai/send-message.ts apps/server/src/llm/context.ts
git commit -m "feat(ai): продолжения разговора маркером в ответе модели (D19), промпт v2"
```

---

### Task C2: Чипы в ленте чата

**Files:**
- Create: `apps/web/src/features/chat/Suggestions.tsx`
- Modify: `apps/web/src/features/chat/MessageList.tsx`, `apps/web/src/features/chat/ChatScreen.tsx` и `ChatThread.tsx` (передача обработчика отправки)
- Test: `apps/web/src/features/chat/MessageList.test.tsx`

**Interfaces:**
- Consumes: `metadata.suggestions?: string[]` (C1).
- Produces: `<Suggestions items={string[]} onPick={(text: string) => void} />`.
- Правило показа: чипы рендерятся только у **последнего** сообщения ленты и только если оно `role === 'assistant'`.

- [ ] **Step 1: Написать падающие тесты**

```ts
test('чипы показываются под последним ответом ассистента', () => {
  render(<MessageList messages={[assistantWith(['что по бюджету?'])]} isTyping={false} onPick={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'что по бюджету?' })).toBeInTheDocument();
});

test('у не-последнего ответа чипов нет', () => {
  render(<MessageList messages={[userMsg('привет'), assistantWith(['что по бюджету?'])]} isTyping={false} onPick={vi.fn()} />);
  // messages в DESC: assistantWith — не последний в порядке показа
  expect(screen.queryByRole('button', { name: 'что по бюджету?' })).not.toBeInTheDocument();
});

test('тап по чипу отправляет его текст обычным сообщением', () => {
  const onPick = vi.fn();
  render(<MessageList messages={[assistantWith(['поставить срок'])]} isTyping={false} onPick={onPick} />);
  fireEvent.click(screen.getByRole('button', { name: 'поставить срок' }));
  expect(onPick).toHaveBeenCalledWith('поставить срок');
});

test('во время ответа модели чипы скрыты', () => {
  render(<MessageList messages={[assistantWith(['a'])]} isTyping onPick={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'a' })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Запустить, убедиться в падении**

Run: `cd apps/web && bunx vitest run src/features/chat/MessageList.test.tsx`
Expected: FAIL

- [ ] **Step 3: Реализовать Suggestions и встроить в MessageList**

Чипы — горизонтальный ряд кнопок под последним сообщением; переполнение скроллится по горизонтали, а не ломает раскладку.

- [ ] **Step 4: Прокинуть onPick в экранах чата**

`ChatScreen`/`ChatThread` передают ту же функцию отправки, что использует `Composer` — чип обязан пройти обычный путь (fast-path/LLM), а не отдельный.

- [ ] **Step 5: Запустить тесты**

Run: `cd apps/web && bunx vitest run src/features/chat/`
Expected: PASS

- [ ] **Step 6: Коммит**

```bash
git add apps/web/src/features/chat/
git commit -m "feat(chat): контекстные продолжения под ответом ассистента (02-core-os §2.4)"
```

---

### Task C3: Карточки действий переживают перезагрузку

Сегодня `journal.ts:39` пишет `cards: [entry.card]`, где `ActionCard = { tool, entity_id, title }` — без `kind`. `renderCards` уходит в `default: return null` (`renderCards.tsx:86`), и после перезагрузки от карточки остаётся голая строка.

**Files:**
- Modify: `apps/server/src/executor/journal.ts:37-50`
- Modify: `apps/web/src/features/chat/cards/types.ts`, `apps/web/src/features/chat/cards/renderCards.tsx`
- Test: `apps/server/src/executor/journal.test.ts`, `apps/web/src/features/chat/cards/cards.test.tsx`

**Interfaces:**
- Produces (сервер): в `metadata.cards` пишется `{ kind: 'entity_card', entityId, title, aspects: [], keyFields: {}, undoActionId }` при `entry.card.entity_id !== null`; при `entity_id === null` (batch) карточка не пишется — текст несёт `content`, как сейчас.
- Produces (web): ветка `entity_card` уже существует и переиспользуется — нового типа не заводим.

- [ ] **Step 1: Написать падающий серверный тест**

```ts
test('audit-карточка несёт kind и id действия для Undo', async () => {
  const { messageId } = await executeCreateAndJournal(user);
  const row = await readMessage(messageId);
  const cards = (row.metadata as { cards: { kind?: string; undoActionId?: string }[] }).cards;
  expect(cards[0]?.kind).toBe('entity_card');
  expect(cards[0]?.undoActionId).toBe((row.metadata as { actions: { id: string }[] }).actions[0]?.id);
});
```

- [ ] **Step 2: Запустить, убедиться в падении**

Run: `cd apps/server && bun test src/executor/journal.test.ts -t 'audit-карточка'`
Expected: FAIL — `kind` отсутствует.

- [ ] **Step 3: Реализовать маппинг в journal.ts**

```ts
// Карточка ленты — дискриминированный union клиента (02-core-os §2.3): без kind
// renderCards уходит в default и после перезагрузки от карточки остаётся голая строка.
const cards =
  entry.card.entity_id === null
    ? []
    : [{
        kind: 'entity_card' as const,
        entityId: entry.card.entity_id,
        title: entry.card.title,
        aspects: [],
        keyFields: {},
        undoActionId: actions[0]?.id,
      }];
const metadata: Record<string, unknown> = { actions, cards };
```

- [ ] **Step 4: Написать web-тест устойчивости**

```ts
test('карточка действия из истории рендерится после перезагрузки', () => {
  const msg = { id: 'm1', role: 'system', content: 'Создана задача', createdAt: NOW,
    metadata: { actions: [{ id: 'a1' }], cards: [{ kind: 'entity_card', entityId: E1, title: 'Купить кроссовки', aspects: [], keyFields: {}, undoActionId: 'a1' }] } };
  render(<>{renderCards(msg)}</>);
  expect(screen.getByText('Купить кроссовки')).toBeInTheDocument();
});
```

- [ ] **Step 5: Запустить оба сьюта**

Run: `cd apps/server && bun test src/executor/` затем `cd apps/web && bunx vitest run src/features/chat/cards/`
Expected: PASS

- [ ] **Step 6: Коммит**

```bash
git add apps/server/src/executor/journal.ts apps/server/src/executor/journal.test.ts apps/web/src/features/chat/cards/
git commit -m "fix(chat): карточка действия переживает перезагрузку — audit пишет kind и id для Undo"
```

---

### Task C4: Рендеринг markdown

**Files:**
- Create: `apps/web/src/lib/markdown/Markdown.tsx`, `apps/web/src/lib/markdown/markdown.test.tsx`
- Modify: `apps/web/src/features/chat/MessageList.tsx:77,86`, `apps/web/src/features/entity-detail/DetailScreen.tsx` (рендер body)
- Modify: `apps/web/package.json` (зависимости)

**Interfaces:**
- Produces: `<Markdown source={string} onEntityLink?={(id: string) => void} />`.
- Зависимости: `react-markdown`, `remark-gfm`, `rehype-sanitize`. `dangerouslySetInnerHTML` не используется нигде.
- `{{query:…}}`-блоки в `source` **не рендерятся** этим компонентом: `DetailScreen` уже вырезает их через `queryBlocks` и рендерит виджетами — в `Markdown` попадает остальной текст.
- `[[entity:<uuid>]]` превращается в ссылку на `buildAppPath({ kind: 'entity', id })` (B1); клик открывает detail-экран через `openDeepLink`.

- [ ] **Step 1: Установить зависимости**

Run: `cd apps/web && bun add react-markdown remark-gfm rehype-sanitize`

- [ ] **Step 2: Написать падающие тесты**

```ts
test('заголовки, списки и код рендерятся разметкой, а не текстом', () => {
  render(<Markdown source={'## Итоги\n\n- раз\n- два\n\n`code`'} />);
  expect(screen.getByRole('heading', { level: 2, name: 'Итоги' })).toBeInTheDocument();
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
});

test('html из источника не исполняется (санитизация)', () => {
  const { container } = render(<Markdown source={'<img src=x onerror="alert(1)">'} />);
  expect(container.querySelector('img')).toBeNull();
  expect(container.innerHTML).not.toContain('onerror');
});

test('[[entity:id]] становится ссылкой на detail-экран', () => {
  const onEntityLink = vi.fn();
  render(<Markdown source={`см. [[entity:${E1}]]`} onEntityLink={onEntityLink} />);
  fireEvent.click(screen.getByRole('link'));
  expect(onEntityLink).toHaveBeenCalledWith(E1);
});
```

- [ ] **Step 3: Запустить, убедиться в падении**

Run: `cd apps/web && bunx vitest run src/lib/markdown/`
Expected: FAIL — компонента нет.

- [ ] **Step 4: Реализовать Markdown.tsx**

`react-markdown` с `remarkPlugins={[remarkGfm]}` и `rehypePlugins={[rehypeSanitize]}`; предобработка `[[entity:<uuid>]]` → markdown-ссылка на путь из `buildAppPath` до передачи в парсер; `components.a` перехватывает клик по внутренней ссылке и зовёт `onEntityLink` вместо перезагрузки страницы.

- [ ] **Step 5: Подключить в двух местах**

Лента чата: `{m.content && <p>{m.content}</p>}` → `<Markdown source={m.content} onEntityLink={openEntity} />` — и для user-, и для assistant-сообщений (пользователь тоже пишет markdown). `DetailScreen`: body между query-блоками рендерится тем же компонентом.

- [ ] **Step 6: Запустить web-сьют**

Run: `cd apps/web && bunx vitest run`
Expected: PASS. Тесты, ожидавшие сырой текст в `<p>`, могут потребовать правки — проверять по доступному тексту (`getByText`), а не по структуре DOM.

- [ ] **Step 7: Коммит**

```bash
git add apps/web/src/lib/markdown/ apps/web/src/features/chat/MessageList.tsx apps/web/src/features/entity-detail/DetailScreen.tsx apps/web/package.json bun.lock
git commit -m "feat(web): markdown в ответах модели и body сущности, с санитизацией и живыми [[entity:…]]"
```

---

# Фаза D — query-builder (`slice3d-query-builder`)

### Task D1: Сериализатор запросов

**Files:**
- Create: `packages/shared/src/query/serialize.ts`, `packages/shared/src/query/serialize.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `QueryAst` и все типы узлов из `packages/shared/src/query/grammar.ts`; `parseQuery(input, catalog)` из `parse.ts`.
- Produces: `export function serializeQuery(ast: QueryAst): string` — строка БЕЗ обёртки `{{query: … }}` (обёртку ставит вызывающий, симметрично парсеру).
- Правила: конструкции разделяются `, `; порядок — фильтры в порядке массива, затем `sortBy`, `search`, `limit`, `display`, `title`; значение берётся в двойные кавычки, если содержит `,`, `=`, `|`, `&`, `>`, `<`, `"` или ведущий/хвостовой пробел; внутренние кавычки экранируются `\"`.

- [ ] **Step 1: Написать падающий round-trip тест**

```ts
// packages/shared/src/query/serialize.test.ts
import { buildFieldCatalog, parseQuery } from './parse';
import { serializeQuery } from './serialize';

const CASES = [
  'aspect=orbis/task, status=inbox, sortBy=created_at:desc, display=list, title=Inbox',
  'aspect=orbis/task, due_date=today|overdue, status=!done&!cancelled&!waiting, excludeBlocked=true, sortBy=priority:desc|due_date:asc, display=list, title=Сегодня',
  'aspect=orbis/financial, amount=500..2000, occurred_on=2026-06-01..2026-06-30',
  'children_of=this, archived=any, limit=30',
  'search=обед, tags=work|personal, excludeTags=archive',
  'aspect=orbis/financial, amount>1000, updated_at>2026-07-02T09:00:00Z',
];

test('round-trip: parse(serialize(parse(x))) даёт тот же AST', () => {
  const catalog = buildFieldCatalog(REGISTRY_FIXTURE);
  for (const q of CASES) {
    const first = parseQuery(q, catalog);
    expect(first.ok).toBe(true);
    if (!first.ok) continue;
    const again = parseQuery(serializeQuery(first.ast), catalog);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.ast).toEqual(first.ast);
  }
});

test('значения с запятой и кавычками экранируются', () => {
  const catalog = buildFieldCatalog(REGISTRY_FIXTURE);
  const r = parseQuery('search="обед, ужин"', catalog);
  expect(r.ok).toBe(true);
  if (r.ok) expect(serializeQuery(r.ast)).toBe('search="обед, ужин"');
});
```

`REGISTRY_FIXTURE` — существующая фикстура реестра из `packages/shared/src/query/fixtures.ts`.

- [ ] **Step 2: Добавить кейсы сидированных smart lists**

Тексты query-блоков трёх сидированных списков скопировать в тест **литералами** (кросс-пакетный импорт из `apps/server` в `packages/shared` запрещён глобальным ограничением). Многострочные блоки нормализовать так же, как это делает рендерер body.

- [ ] **Step 3: Запустить, убедиться в падении**

Run: `cd packages/shared && bun test src/query/serialize.test.ts`
Expected: FAIL — модуля нет.

- [ ] **Step 4: Реализовать serialize.ts**

Исчерпывающий `switch` по `QueryFilter['kind']` — все десять вариантов (`tags`, `excludeTags`, `aspect`, `field`, `comparison`, `range`, `children_of`, `parents_of`, `excludeBlocked`, `archived`); `never`-ветка в `default`, чтобы новый узел грамматики ломал типизацию, а не молча терялся.

- [ ] **Step 5: Запустить тесты**

Run: `cd packages/shared && bun test src/query/`
Expected: PASS

- [ ] **Step 6: Коммит**

```bash
git add packages/shared/src/query/serialize.ts packages/shared/src/query/serialize.test.ts packages/shared/src/index.ts
git commit -m "feat(query): сериализация AST обратно в строку блока (round-trip по всей грамматике)"
```

---

### Task D2: Форма редактора query-блока

**Files:**
- Create: `apps/web/src/features/query-builder/QueryBuilderForm.tsx`, `apps/web/src/features/query-builder/query-builder.test.tsx`
- Modify: `apps/web/src/lib/query-blocks/QueryBlock.tsx` (кнопка «настроить»), `apps/web/src/features/entity-detail/DetailScreen.tsx` (сохранение body)

**Interfaces:**
- Consumes: `parseQuery`, `serializeQuery`, `buildFieldCatalog` (D1); каталог аспектов web — `apps/web/src/lib/query-blocks/catalog.ts`.
- Produces: `<QueryBuilderForm initial={string} onSave={(query: string) => void} onCancel={() => void} onEditAsText={() => void} />`.
- Сохранение: `DetailScreen` заменяет **только текст этого блока** в body (по индексу блока из `queryBlocks`) и шлёт обычный `entity.update` с optimistic-check.

- [ ] **Step 1: Написать падающие тесты**

```ts
test('форма открывается разобранным запросом и сохраняет его без изменений байт-в-байт', () => {
  const initial = 'aspect=orbis/task, status=inbox, sortBy=created_at:desc, display=list, title=Inbox';
  const onSave = vi.fn();
  render(<QueryBuilderForm initial={initial} onSave={onSave} onCancel={vi.fn()} onEditAsText={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  expect(onSave).toHaveBeenCalledWith(initial);
});

test('смена лимита меняет сериализованную строку', () => {
  const onSave = vi.fn();
  render(<QueryBuilderForm initial="aspect=orbis/task, limit=30" onSave={onSave} onCancel={vi.fn()} onEditAsText={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Лимит'), { target: { value: '50' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  expect(onSave).toHaveBeenCalledWith('aspect=orbis/task, limit=50');
});

test('поля аспекта появляются после выбора аспекта', () => {
  render(<QueryBuilderForm initial="aspect=orbis/financial" onSave={vi.fn()} onCancel={vi.fn()} onEditAsText={vi.fn()} />);
  expect(screen.getByLabelText('amount')).toBeInTheDocument();
});
```

- [ ] **Step 2: Запустить, убедиться в падении**

Run: `cd apps/web && bunx vitest run src/features/query-builder/`
Expected: FAIL

- [ ] **Step 3: Реализовать форму**

Секции формы по §3.4: теги (включение/исключение), аспекты, поля выбранных аспектов (значение / отрицание / сравнение / диапазон — по типу поля из каталога), даты (относительные токены или конкретное значение), relation-фильтры (`children_of`/`parents_of` — `this` или выбор сущности), `excludeBlocked`, `archived`, сортировка (упорядоченный список «поле + направление» с перестановкой), лимит, режим отображения, заголовок. Состояние формы — распарсенный AST; при сохранении — `serializeQuery`.

- [ ] **Step 4: Добавить кнопку «настроить» на QueryBlock**

Кнопка видна на detail-экране (не в чат-карточках); открывает форму в модальном листе.

- [ ] **Step 5: Связать сохранение с body**

Замена подстроки конкретного блока по его индексу; результат уходит в `entity.update`. Конфликт `updated_at` → существующий `error_card` с предложением перезагрузить (§6, 01-architecture §5.2) — новой ветки обработки не заводить.

- [ ] **Step 6: Запустить web-сьют**

Run: `cd apps/web && bunx vitest run`
Expected: PASS

- [ ] **Step 7: Коммит**

```bash
git add apps/web/src/features/query-builder/ apps/web/src/lib/query-blocks/QueryBlock.tsx apps/web/src/features/entity-detail/DetailScreen.tsx
git commit -m "feat(query-builder): визуальный редактор query-блока с обратной сериализацией"
```

---

### Task D3: Строковый редактор и «редактировать как текст»

**Files:**
- Create: `apps/web/src/features/query-builder/QueryTextEditor.tsx`
- Modify: `apps/web/src/lib/query-blocks/QueryBlock.tsx`, `apps/web/src/features/query-builder/QueryBuilderForm.tsx`
- Test: `apps/web/src/features/query-builder/query-builder.test.tsx`

**Interfaces:**
- Produces: `<QueryTextEditor initial={string} error?={{ message: string; position: number }} onSave={(query: string) => void} onCancel={() => void} />` — textarea с показом ошибки парсинга и позиции; сохранение доступно всегда (невалидную строку тоже можно сохранить — красная плашка это покажет, §6.4).

- [ ] **Step 1: Написать падающие тесты**

```ts
test('у невалидного блока «настроить» открывает строковый редактор с текстом ошибки', () => {
  render(<QueryBlock query="aspect=orbis/task, status=" editable />);
  fireEvent.click(screen.getByRole('button', { name: 'Настроить' }));
  expect(screen.getByRole('textbox')).toHaveValue('aspect=orbis/task, status=');
  expect(screen.getByText(/позиция/i)).toBeInTheDocument();
});

test('из формы доступен режим «редактировать как текст»', () => {
  render(<QueryBuilderForm initial="aspect=orbis/task" onSave={vi.fn()} onCancel={vi.fn()} onEditAsText={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Редактировать как текст' })).toBeInTheDocument();
});
```

- [ ] **Step 2: Запустить, убедиться в падении**

Run: `cd apps/web && bunx vitest run src/features/query-builder/ -t 'текст'`
Expected: FAIL

- [ ] **Step 3: Реализовать**

`QueryBlock` при неуспешном парсе открывает `QueryTextEditor` (форма требует валидного AST); переключатель из формы ведёт в тот же редактор с текущей сериализацией.

- [ ] **Step 4: Запустить тесты**

Run: `cd apps/web && bunx vitest run src/features/query-builder/`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add apps/web/src/features/query-builder/ apps/web/src/lib/query-blocks/QueryBlock.tsx
git commit -m "feat(query-builder): строковый редактор для невалидного блока и режим «как текст»"
```

---

### Task D4: Снятие пометок «слайс 3» в PRD §3.4

**Files:**
- Modify: `docs/prd/02-core-os.md` §3.4, §2.4, §3.5 (пометки `[слайс 3]`)

- [ ] **Step 1: Обновить §3.4**

Убрать «— слайс 3» из заголовка и формулировки «визуальный редактор-форма, сериализация и режим „редактировать как текст" — слайс 3», заменив на описание реализованного поведения.

- [ ] **Step 2: Обновить §2.4 и §3.5**

§2.4 «Suggestion chips — слайс 3» → без пометки, с добавлением реализованного правила «продолжения приходят вместе с ответом; если модель их не вернула, чипов нет» (D19). В §3.5 снять `[слайс 3]` с «Скопировать ссылку» (если не снято в B6).

- [ ] **Step 3: Коммит**

```bash
git add docs/prd/02-core-os.md
git commit -m "docs(prd): §2.4 и §3.4 описывают реализованное поведение, пометки слайса сняты"
```

---

# Фаза E — цели и горизонты (`slice3e-goals`)

### Task E1: Аспект `orbis/goal` в реестре

**Files:**
- Modify: `packages/shared/src/constants.ts` (`BUILTIN_ASPECT_IDS`), `packages/shared/src/schemas/aspects.ts`, `packages/shared/src/aspect-registry.ts`
- Test: `packages/shared/src/schemas/aspects.test.ts`, `packages/shared/src/aspect-registry.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const goalAspectSchema = z.object({
    progress_source: z.object({
      query: z.string().min(1),
      aggregate: z.enum(['sum', 'count', 'latest']),
      field: z.string().optional(),   // обязателен для sum и latest
    }),
    target_value: decimalString,
    current_value: decimalString.optional(),   // КЭШ (правило 3 §10)
    unit: z.string().optional(),
  }).strict().refine(
    (v) => v.progress_source.aggregate === 'count' || !!v.progress_source.field,
    { message: 'field обязателен для aggregate sum и latest' },
  );
  export type GoalAspect = z.infer<typeof goalAspectSchema>;
  ```
- Запись реестра: `id: 'orbis/goal'`, `name: 'Goal'`, `icon: '🎯'`, `tagMappings: ['goal']`, `viewConfig: { keyFields: ['target_value', 'current_value', 'unit'] }`, `aiInstructions` — как считается прогресс и что `current_value` не задаётся вручную.

- [ ] **Step 1: Написать падающие тесты схемы**

```ts
test('goal: count не требует field, sum требует', () => {
  expect(goalAspectSchema.safeParse({ progress_source: { query: 'aspect=orbis/note', aggregate: 'count' }, target_value: '24' }).success).toBe(true);
  expect(goalAspectSchema.safeParse({ progress_source: { query: 'aspect=orbis/financial', aggregate: 'sum' }, target_value: '300000.00' }).success).toBe(false);
});

test('goal: суммы — decimal-строки, не числа', () => {
  expect(goalAspectSchema.safeParse({ progress_source: { query: 'q', aggregate: 'count' }, target_value: 24 as unknown as string }).success).toBe(false);
});
```

- [ ] **Step 2: Запустить, убедиться в падении**

Run: `cd packages/shared && bun test src/schemas/aspects.test.ts -t 'goal'`
Expected: FAIL

- [ ] **Step 3: Реализовать схему, добавить в ASPECT_SCHEMAS и BUILTIN_ASPECT_IDS**

- [ ] **Step 4: Добавить запись в BUILTIN_ASPECT_META**

- [ ] **Step 5: Прогнать сьют shared и серверный тест реестра**

Run: `cd packages/shared && bun test` затем `cd apps/server && bun test src/db/aspect-drift.test.ts`
Expected: PASS. Реестр локальной БД пересеять: `DATABASE_URL_ADMIN=$DATABASE_URL_ADMIN bun scripts/seed-aspects.ts`.

- [ ] **Step 6: Коммит**

```bash
git add packages/shared/src/constants.ts packages/shared/src/schemas/aspects.ts packages/shared/src/aspect-registry.ts packages/shared/src/schemas/aspects.test.ts
git commit -m "feat(aspects): orbis/goal — цель с progress_source (01-architecture §11.3)"
```

---

### Task E2: Серверный расчёт прогресса цели

**Files:**
- Create: `apps/server/src/goals/progress.ts`, `apps/server/src/goals/progress.test.ts`
- Modify: `apps/server/src/routers/entity.ts` (обогащение ответа `entity.get`)

**Interfaces:**
- Consumes: query-движок (`compileQuery`/исполнитель `entity.query` — та же точка, что используют существующие потребители), `goalAspectSchema` (E1).
- Produces:
  ```ts
  export type GoalProgress = { current: string; target: string; ratio: number; unsupported?: 'array_field' };
  export async function computeGoalProgress(db: Db, ownerId: string, goal: GoalAspect): Promise<GoalProgress>;
  ```
  `current` и `target` — decimal-строки; `ratio` — число 0..1+ для прогресс-бара (вычисляется на сервере через ту же decimal-арифметику, `decDivBy`).
- `entity.get` для сущности с `orbis/goal` возвращает дополнительное поле `goalProgress?: GoalProgress`.

- [ ] **Step 1: Написать падающие тесты**

```ts
test('aggregate=sum складывает поле по отобранным сущностям', async () => {
  const user = await freshUserId();
  await createIncomes(user, ['100000.00', '50000.00'], { tags: ['savings'] });
  const p = await computeGoalProgress(db, user, {
    progress_source: { query: 'aspect=orbis/financial, direction=income, tags=savings', aggregate: 'sum', field: 'amount' },
    target_value: '300000.00',
  });
  expect(p.current).toBe('150000.00');
  expect(p.ratio).toBeCloseTo(0.5, 3);
});

test('aggregate=count считает сущности', async () => { /* 3 заметки → current "3" */ });

test('aggregate=latest берёт значение последней по updated_at', async () => { /* вес 80.5 */ });

test('пустая выборка даёт 0, а не ошибку', async () => { /* current "0" */ });
```

- [ ] **Step 2: Запустить, убедиться в падении**

Run: `cd apps/server && bun test src/goals/progress.test.ts`
Expected: FAIL — модуля нет.

- [ ] **Step 3: Реализовать computeGoalProgress**

Запрос исполняется существующим движком с identity владельца (RLS); агрегация — в SQL, без выгрузки всех строк в память. Деньги — `::numeric`, никакого `parseFloat`.

- [ ] **Step 4: Тест на честное ограничение §12 п.6**

```ts
test('поле внутри JSONB-массива не поддерживается — честный флаг, а не тихий ноль', async () => {
  const p = await computeGoalProgress(db, user, {
    progress_source: { query: 'aspect=orbis/fitness', aggregate: 'sum', field: 'sets[].weight' },
    target_value: '100',
  });
  expect(p.unsupported).toBe('array_field');
});
```

- [ ] **Step 5: Подключить к entity.get**

Только для сущностей с аспектом `orbis/goal`; расчёт не должен утяжелять обычный `entity.get` (ветка по наличию аспекта).

- [ ] **Step 6: Прогнать серверный сьют**

Run: `cd apps/server && bun test`
Expected: PASS

- [ ] **Step 7: Коммит**

```bash
git add apps/server/src/goals/ apps/server/src/routers/entity.ts
git commit -m "feat(goals): прогресс цели считается из графа существующим query-движком"
```

---

### Task E3: Прогресс цели в UI

**Files:**
- Create: `apps/web/src/features/entity-detail/GoalProgress.tsx`
- Modify: `apps/web/src/features/entity-detail/AspectCards.tsx`, `apps/web/src/features/entity-detail/NativeRow.tsx` (generic-строка §3.6)
- Test: `apps/web/src/features/entity-detail/goal.test.tsx`

**Interfaces:**
- Consumes: `goalProgress` из `entity.get` (E2).
- Produces: `<GoalProgress progress={GoalProgress} unit?={string} />`.

- [ ] **Step 1: Написать падающие тесты**

```ts
test('карточка цели показывает прогресс и остаток', async () => {
  renderWithProviders(<DetailScreen id={G1} />, handlerWithGoal({ current: '150000.00', target: '300000.00', ratio: 0.5 }));
  expect(await screen.findByText('150 000 / 300 000')).toBeInTheDocument();
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
});

test('неподдерживаемый источник прогресса объясняется текстом, а не пустотой', async () => {
  renderWithProviders(<DetailScreen id={G1} />, handlerWithGoal({ current: '0', target: '100', ratio: 0, unsupported: 'array_field' }));
  expect(await screen.findByText(/не поддерживает/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Запустить, убедиться в падении**

Run: `cd apps/web && bunx vitest run src/features/entity-detail/goal.test.tsx`
Expected: FAIL

- [ ] **Step 3: Реализовать компонент и встроить в карточку аспекта**

`role="progressbar"` с `aria-valuenow/min/max`; при `ratio > 1` — визуально «перевыполнено», без переполнения полосы.

- [ ] **Step 4: Запустить web-сьют**

Run: `cd apps/web && bunx vitest run`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add apps/web/src/features/entity-detail/
git commit -m "feat(goals): прогресс-бар цели на detail-экране и в списках"
```

---

### Task E4: Горизонты планирования — сидированные smart lists

**Files:**
- Modify: `apps/server/src/seed/smart-lists.ts`, `apps/server/src/seed/onboarding.ts`
- Test: `apps/server/src/seed/onboarding.test.ts`

**Interfaces:**
- Produces: пять новых записей `SEED_SMART_LISTS` со слагами `horizon-day`, `horizon-week`, `horizon-month`, `horizon-year`, `horizon-life`; id — `uuidv5(ownerId:seed-smartlist:<slug>)` тем же хелпером, что три существующих.
- Досев идемпотентен: повторный вызов сидирования не создаёт дублей (существующий `ON CONFLICT DO NOTHING`).
- Body каждого горизонта — валидные query-блоки существующей грамматики. Для «жизни» — цели: `{{query: aspect=orbis/goal, sortBy=updated_at:desc, display=list, title=Цели}}`.

- [ ] **Step 1: Написать падающие тесты**

```ts
test('сидирование создаёт пять горизонтов', async () => {
  const user = await freshUserId();
  await seedUser(db, user);
  const titles = await smartListTitles(db, user);
  expect(titles).toEqual(expect.arrayContaining(['День', 'Неделя', 'Месяц', 'Год', 'Жизнь']));
});

test('повторное сидирование не создаёт дублей', async () => {
  const user = await freshUserId();
  await seedUser(db, user);
  await seedUser(db, user);
  expect(await smartListCount(db, user)).toBe(8); // 3 существующих + 5 горизонтов
});

test('все query-блоки горизонтов парсуются грамматикой', () => {
  for (const list of SEED_SMART_LISTS) {
    for (const block of queryBlocksOf(list.body)) {
      expect(parseQuery(block, catalog).ok).toBe(true);
    }
  }
});
```

- [ ] **Step 2: Запустить, убедиться в падении**

Run: `cd apps/server && bun test src/seed/onboarding.test.ts`
Expected: FAIL

- [ ] **Step 3: Добавить пять горизонтов**

- [ ] **Step 4: Запустить тесты**

Run: `cd apps/server && bun test src/seed/`
Expected: PASS

- [ ] **Step 5: Досеять горизонты существующему аккаунту владельца**

Выполняется при деплое фазы (см. E5, чек-лист): сидирование идемпотентно, поэтому повторный запуск для существующего пользователя безопасен.

- [ ] **Step 6: Коммит**

```bash
git add apps/server/src/seed/
git commit -m "feat(seed): горизонты планирования — день, неделя, месяц, год, жизнь"
```

---

### Task E5: Промпт v3, PRD, приёмка и деплой фазы

**Files:**
- Create: `apps/server/src/llm/prompts/v3.ts`, `v3.fixture.txt`, `v3.test.ts`
- Modify: `apps/server/src/llm/context.ts`
- Modify: `docs/prd/00-product.md` §9, `docs/prd/02-core-os.md` §8, `docs/prd/03-budget.md` §7, `docs/prd/04-decision-log.md` (D19–D22), `docs/implementation/02-ops-runbook.md`

**Interfaces:**
- Produces: `SYSTEM_PROMPT_V3`, `SYSTEM_PROMPT_VERSION = 'v3'`; блок про цели и горизонты.

- [ ] **Step 1: Создать промпт v3**

Копия v2 + блок:

```
Цели и горизонты:
- Цель пользователя («накопить 300 000», «прочитать 24 книги», «вес 80 кг») — сущность с аспектом orbis/goal: progress_source (query по графу + aggregate sum|count|latest + field), target_value. current_value НЕ заполняй — прогресс считает сервер.
- «Спланируй неделю», «как идут цели» — сначала посмотри существующие сущности через entity_query, потом предлагай; не заводи дубли уже существующих целей и задач.
```

`v3.test.ts` — по образцу `v2.test.ts`, включая семантический гард на блок целей.

- [ ] **Step 2: Переключить context.ts на v3, прогнать серверный сьют**

Run: `cd apps/server && bun test src/llm/`
Expected: PASS

- [ ] **Step 3: Записать решения D19–D22 в decision log**

D18 записан в B6; здесь — оставшиеся четыре, в том же формате.

- [ ] **Step 4: Обновить состав слайса 3 в 00-product §9 и статус аспекта в 01-architecture**

Формулировка §9 приводится в соответствие с фактическим составом (§2 спеки): бейджи вкладок — полировка; добавлены markdown и карточки после перезагрузки; граница целей по D22. В `01-architecture.md` §3.8 `orbis/goal` убирается из перечня будущих аспектов, в §11.3 добавляется пометка «реализовано в слайсе 3» со ссылкой на `apps/server/src/goals/progress.ts`; ограничение §12 п.6 остаётся в силе и получает ссылку на флаг `unsupported: 'array_field'`.

- [ ] **Step 5: Добавить раздел приёмочных проверок слайса 3**

В `02-core-os.md` — новый раздел с проверками фаз B, C, D (по §5 спеки); в `03-budget.md` §7 — проверки фазы A, касающиеся бюджета (границы дат, шаблоны).

- [ ] **Step 6: Дополнить runbook чек-листом деплоя фазы E**

Обязательные пункты: `DATABASE_URL_ADMIN=… bun scripts/seed-aspects.ts` (пересев реестра — иначе `orbis/goal` приедет мёртвым), досев горизонтов существующему пользователю, проверка `/health` → `ok` (не `drift`).

- [ ] **Step 7: Коммит**

```bash
git add apps/server/src/llm/prompts/ apps/server/src/llm/context.ts docs/prd/ docs/implementation/02-ops-runbook.md
git commit -m "feat(ai): промпт v3 — цели и горизонты; приёмка и решения слайса 3 в PRD"
```

- [ ] **Step 8: Приёмка на живом проде**

После деплоя фазы прогнать приёмочные проверки всех фаз (§5 спеки) на реальном аккаунте, включая живой прогон с настоящим ключом LLM (чипы, сценарии целей). Результат — в бэклог слайса `docs/superpowers/reviews/2026-XX-XX-slice3-backlog.md`.

- [ ] **Step 9: Неделя живого использования**

Неделя Orbis как единственного хранилища, без параллельных заметок. Найденное фиксируется в тот же бэклог и чинится следующим заходом, а не по ходу недели.

---

## Порядок и ревью

1. Каждая фаза начинается с ветки от свежего `main`: `git switch -c slice3a-seams-gates`.
2. По завершении фазы — `superpowers:requesting-code-review`, затем merge в `main` и push.
3. Фаза E — единственная, чей деплой требует ручного действия на проде (пересев реестра); остальные едут обычным деплоем Render.
4. Бэклог фазы (что осознанно не чинилось) пишется в `docs/superpowers/reviews/` по образцу предыдущих слайсов.
