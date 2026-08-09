# Фильтр по полю-массиву — план реализации

> **Для агентных исполнителей:** ОБЯЗАТЕЛЬНАЯ СУБ-СКИЛЛ: `superpowers:subagent-driven-development`.

**Цель:** каталог полей перестаёт объявлять массивы строками; `aliases=такси` начинает
находить категорию, а `aliases=!такси` — перестаёт возвращать все категории подряд.

**Архитектура:** тип поля (`packages/shared/src/query/catalog.ts`) получает члены `array`
и `unfilterable`; парсер отказывает по `unfilterable` и по `sortBy` для обоих новых типов;
компилятор строит для `array` containment-предикат `aspects @> jsonb_build_object(...)`.
Спека: `docs/superpowers/specs/2026-08-09-alias-filter-design.md` (решения Р1–Р8).

**Стек:** bun-воркспейсы, drizzle `sql` шаблоны, PostgreSQL 17, Vitest/bun test.

## Глобальные ограничения

- Тесты ТОЛЬКО через `bun run test`; отдельный файл — `bun run --filter @orbis/server test -- <файл>`.
  Код возврата линта снимать отдельным вызовом.
- **Инвариант компилятора** (`apps/server/src/query/compile.ts:1-10`): все пользовательские
  значения — строго параметрами `${}`; `sql.raw` только для каталожных (id аспектов, имена
  полей, enum). Литеральный JSON `@> '{...}'` со словом пользователя писать НЕЛЬЗЯ.
- **Форма предиката только `@>`**: подпутевой `aspects->'A'->'f' ? $1` неиндексируем —
  остаётся Seq Scan даже при `enable_seqscan=off` (проверено EXPLAIN на живой БД).
- Локальный Supabase поднят: БД `postgresql://postgres:postgres@127.0.0.1:54322/postgres`.
  Серверный сьют делает `truncateAll` — не гонять его одновременно с ручными проверками.
- PRD §6.2 (`docs/prd/01-architecture.md:659`): новая конструкция грамматики добавляется
  в golden-фикстуры одновременно с реализацией.
- Факты плана проверены разведкой, но **могут быть неверны** — проверяй пробоем и опровергай.

---

### Task 1: Каталог перестаёт врать (типы + отказы парсера)

**Files:**
- Modify: `packages/shared/src/query/catalog.ts` (union `FieldType` :10-17, `propType` :73-89)
- Modify: `packages/shared/src/query/parse.ts` (ветка фильтра поля, `parseSortBy` :499-520)
- Test: `packages/shared/src/query/parse.test.ts`, `packages/shared/src/query/catalog.test.ts`
  (если второго нет — тесты каталога положить в первый)

**Interfaces:**
- Produces: `FieldType` пополняется членами `'array'` и `'unfilterable'` — Task 2 ветвится
  по ним в компиляторе. Имена именно такие.

Сегодня `propType` возвращает `'string'` для `array`/`object`/union с комментарием
«фильтрация по ним грамматикой не определена». Комментарий неверен: `aliases=такси`
парсится и даёт тихий ноль, `aliases=!такси` — все 12 категорий.

- [ ] **Шаг 1: Написать падающие тесты**

В `packages/shared/src/query/parse.test.ts` (каталог берётся так же, как в соседних тестах
файла — посмотри, как они его строят, и повтори):

```ts
test('поле-массив получает тип array, а не string', () => {
  const catalog = buildFieldCatalog(ASPECT_JSON_SCHEMAS);
  expect(catalog.fields.aliases?.[0]?.type).toBe('array');
});

test('поле-объект и union — unfilterable', () => {
  const catalog = buildFieldCatalog(ASPECT_JSON_SCHEMAS);
  expect(catalog.fields.recurrence?.[0]?.type).toBe('unfilterable');
  expect(catalog.fields.progress_source?.[0]?.type).toBe('unfilterable');
});

test('фильтр по unfilterable-полю — честный отказ с позицией, а не тихий ноль', () => {
  const r = parseQuery('aspect=orbis/schedule, recurrence=weekly', catalog);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.error.message).toMatch(/не поддерживается/);
    expect(typeof r.error.position).toBe('number');
  }
});

test('фильтр по полю-массиву разбирается как обычный anyOf', () => {
  const r = parseQuery('aspect=orbis/category, aliases=такси', catalog);
  expect(r.ok).toBe(true);
});

test('sortBy по массиву и по unfilterable — отказ', () => {
  for (const q of [
    'aspect=orbis/category, sortBy=aliases:asc',
    'aspect=orbis/schedule, sortBy=recurrence:asc',
  ]) {
    const r = parseQuery(q, catalog);
    expect(r.ok).toBe(false);
  }
});
```

- [ ] **Шаг 2: Прогнать, убедиться что падают**

Запуск: `bun run --filter @orbis/shared test -- parse.test.ts`
Ожидание: FAIL — сегодня `aliases` имеет тип `string`, а оба отказа не срабатывают.

- [ ] **Шаг 3: Расширить `FieldType` и `propType`**

`packages/shared/src/query/catalog.ts`:

```ts
export type FieldType =
  | 'string'
  | 'number'
  | 'integer'
  | 'decimal'
  | 'date'
  | 'timestamp'
  | 'boolean'
  // Массив скаляров внутри аспекта (orbis/category.aliases): фильтруется containment'ом
  // «массив содержит значение» — см. compile.ts. Раньше приезжал сюда как 'string',
  // и `->>'aliases'` сравнивал текст всего массива: положительный фильтр давал тихий
  // ноль, отрицательный — все строки подряд.
  | 'array'
  // Объект или union (orbis/schedule.recurrence, orbis/goal.progress_source): фильтра,
  // выразимого грамматикой, для них нет — парсер отказывает с позицией.
  | 'unfilterable';
```

```ts
/** Тип поля по его JSON Schema-описанию (эвристика по фактическому выводу zod-to-json-schema). */
function propType(prop: Record<string, unknown>): FieldType {
  if (prop.type === 'number') return 'number';
  if (prop.type === 'integer') return 'integer';
  if (prop.type === 'boolean') return 'boolean';
  if (prop.type === 'string') {
    // Явный формат — на случай будущих реестров, где decimal объявлен через format.
    if (prop.format === 'decimal') return 'decimal';
    const pattern = typeof prop.pattern === 'string' ? prop.pattern : '';
    if (pattern === DATE_PATTERN) return 'date';
    if (pattern.includes(TIMESTAMP_MARK)) return 'timestamp';
    if (pattern.endsWith(DECIMAL_TAIL)) return 'decimal';
    return 'string';
  }
  if (prop.type === 'array') {
    // Containment ищет элемент массива целиком, поэтому осмыслен только для скаляров:
    // массив объектов таким предикатом грамматика выразить не может.
    const items = prop.items as Record<string, unknown> | undefined;
    const itemType = typeof items?.type === 'string' ? items.type : '';
    return itemType === 'string' || itemType === 'number' || itemType === 'integer'
      ? 'array'
      : 'unfilterable';
  }
  // object и union (anyOf/oneOf) — фильтровать нечем.
  return 'unfilterable';
}
```

- [ ] **Шаг 4: Отказы в парсере**

`packages/shared/src/query/parse.ts` — найди ветку, где резолвится поле **фильтра**
(вызов `resolveField` без `allowTitle`), и сразу после резолва добавь:

```ts
  if (field.type === 'unfilterable') {
    fail(
      `фильтрация по полю '${field.name}' не поддерживается: это объект или union, а не скаляр или массив`,
      keyOffset,
    );
  }
```

(имя переменной со смещением ключа возьми то, что уже есть в этой функции).

В `parseSortBy` после `const field = resolveField(rawField.text, rawField.offset, ctx, true);`:

```ts
    if (field.type === 'array' || field.type === 'unfilterable') {
      fail(
        `sortBy: по полю '${field.name}' сортировать нельзя — ${field.type === 'array' ? 'это массив' : 'это объект или union'}`,
        rawField.offset,
      );
    }
```

- [ ] **Шаг 5: Прогнать тесты пакета**

Запуск: `bun run --filter @orbis/shared test`, затем `bun run --filter @orbis/web test`
(web импортирует каталог в query-builder).
Ожидание: зелено. Если где-то в web упадёт разбор по типу — это Task 3, зафиксируй в отчёте
и не чини здесь.

- [ ] **Шаг 6: Коммит**

```bash
git add packages/shared/src/query/catalog.ts packages/shared/src/query/parse.ts packages/shared/src/query/parse.test.ts
git commit -m "fix(query): каталог перестал выдавать массивы и объекты за строки"
```

---

### Task 2: Containment-предикат для полей-массивов

**Files:**
- Modify: `apps/server/src/query/compile.ts` (`FieldRef` :226-231, `fieldRef` :246-265,
  `compileAnyOf` :268-284, `compileNoneOf` :290-305, `sortCast` :402-415)
- Test: `apps/server/src/query/compile.test.ts`
- Test: `apps/server/test/golden/query-sql.json` (+ раннер `apps/server/src/query/compile.golden.test.ts`)

**Interfaces:**
- Consumes: `FieldType` с членами `'array'` и `'unfilterable'` (Task 1).
- Produces: SQL-форма containment — `aspects @> jsonb_build_object($a, jsonb_build_object($f, jsonb_build_array($v)))`.

- [ ] **Шаг 1: Написать падающие тесты компиляции**

В `apps/server/src/query/compile.test.ts` (структуру и хелперы возьми у соседних тестов файла):

```ts
test('фильтр по полю-массиву компилируется в containment, а не в текстовое равенство', () => {
  const c = compileFor('aspect=orbis/category, aliases=такси');
  expect(c.sql).toContain('aspects @> jsonb_build_object');
  expect(c.sql).not.toContain(`->>'aliases'`);
  expect(c.params).toContain('такси');
});

test('несколько значений массива — OR по containment', () => {
  const c = compileFor('aspect=orbis/category, aliases=такси|метро');
  expect(c.sql.match(/jsonb_build_object/g)?.length).toBeGreaterThanOrEqual(4);
  expect(c.params).toContain('такси');
  expect(c.params).toContain('метро');
});

test('отрицание по массиву — NOT containment (сущности без аспекта проходят)', () => {
  const c = compileFor('aspect=orbis/category, aliases=!такси');
  expect(c.sql).toContain('NOT (aspects @> jsonb_build_object');
});
```

- [ ] **Шаг 2: Прогнать, убедиться что падают**

Запуск: `bun run --filter @orbis/server test -- compile.test.ts`
Ожидание: FAIL — сегодня строится `aspects->'orbis/category'->>'aliases' IN ($2)`.

- [ ] **Шаг 3: Протащить аспект и имя поля в `FieldRef`**

```ts
/** Поле после резолва: SQL-выражение доступа, тип, признак core, порядок enum. */
interface FieldRef {
  expr: SQL;
  type: FieldType;
  core: boolean;
  enumValues?: string[];
  /** Для полей аспектов: id аспекта и имя поля — containment строит путь заново, а не поверх expr. */
  aspect?: string;
  fieldName?: string;
}
```

В `fieldRef` вернуть их для ветки полей аспектов: `aspect: info.aspect, fieldName: name`.

- [ ] **Шаг 4: Ветка containment**

Рядом с `compileAnyOf` добавить:

```ts
/**
 * «Массив внутри аспекта содержит значение» — единственная индексируемая форма.
 * Подпутевой `aspects->'A'->'f' ? $1` GIN-индексом entities_aspects_gin НЕ покрывается
 * (проверено EXPLAIN: Seq Scan даже при enable_seqscan=off), а литеральный `@> '{...}'`
 * запрещён инвариантом файла — пользовательское значение обязано ехать параметром.
 * jsonb_build_object принимает параметрами и ключи, поэтому sql.raw здесь не нужен.
 */
function arrayContains(ref: FieldRef, value: string): SQL {
  const aspect = ref.aspect as string;
  const field = ref.fieldName as string;
  return sql`aspects @> jsonb_build_object(${aspect}, jsonb_build_object(${field}, jsonb_build_array(${value}::text)))`;
}
```

В начало `compileAnyOf`, до сборки `IN`:

```ts
  if (ref.type === 'array') {
    const conds = values
      .filter((v) => v.kind === 'literal')
      .map((v) => arrayContains(ref, v.value));
    const first = conds[0] as SQL;
    return conds.length === 1 ? first : sql`(${sql.join(conds, sql` OR `)})`;
  }
```

В начало `compileNoneOf`:

```ts
  if (ref.type === 'array') {
    // Правило «NULL проходит» (решение 10) выполняется само: NOT (@>) истинно и для
    // сущностей без этого аспекта вовсе. Цена — NOT снимает индекс, отрицание по массиву
    // остаётся seq-scan'ом; это сознательно, отрицание редко и по одной сущности.
    const parts = values
      .filter((v) => v.kind === 'literal')
      .map((v) => sql`NOT (${arrayContains(ref, v.value)})`);
    const first = parts[0] as SQL;
    return parts.length === 1 ? first : sql`(${sql.join(parts, sql` AND `)})`;
  }
```

- [ ] **Шаг 5: `sortCast` — недостижимые типы падают громко**

```ts
    case 'array':
    case 'unfilterable':
      // Парсер такую сортировку отсекает (parse.ts, parseSortBy) — сюда попасть можно
      // только рассинхроном, и тогда молчать нельзя: раньше default сортировал по тексту JSON.
      throw new QueryCompileError(
        `сортировка по полю типа ${ref.type} — рассинхрон с парсером`,
      );
```

- [ ] **Шаг 6: Прогнать тесты компиляции**

Запуск: `bun run --filter @orbis/server test -- compile.test.ts`
Ожидание: PASS.

- [ ] **Шаг 7: Проверить предикат на ЖИВОЙ базе, а не только по строке SQL**

Скомпилируй `aspect=orbis/category, aliases=такси` и выполни получившийся SQL с параметрами
на `postgresql://postgres:postgres@127.0.0.1:54322/postgres` (psql или скрипт на bun).
Ожидание: найдена ровно категория «Транспорт». Затем `aliases=!такси` — «Транспорт»
в выдаче отсутствует, остальные категории на месте (сегодня возвращаются все 12).
Вывод обоих прогонов дословно положи в отчёт: это главное доказательство работы.

- [ ] **Шаг 8: Golden-фикстуры**

В `apps/server/test/golden/query-sql.json` добавить три записи в том же формате
(`name`, `query`, `sql`, `params`, `countSql`, `countParams`) — по одной на anyOf с одним
значением, anyOf с двумя, noneOf. Значения `sql`/`params` возьми из фактического
компилята, а не сочиняй руками. Раннер — `apps/server/src/query/compile.golden.test.ts`.

- [ ] **Шаг 9: Прогнать серверный сьют, типы, линт**

Запуск: `bun run --filter @orbis/server test`, `bun run typecheck`, `bun run lint`.

- [ ] **Шаг 10: Коммит**

```bash
git add apps/server/src/query/compile.ts apps/server/src/query/compile.test.ts apps/server/test/golden/query-sql.json
git commit -m "feat(query): фильтр по полю-массиву — containment по GIN, отрицание честное"
```

---

### Task 3: Модель узнаёт про фильтр, форма перестаёт предлагать сломанное

**Files:**
- Modify: `apps/server/src/tools/registry.ts` (описание `entity_query` :296-305)
- Modify: `apps/server/src/tools/registry.test.ts` (пин старого примера)
- Modify: `apps/web/src/features/query-builder/model.ts` (`visibleFieldNames` :89-98)
- Test: `apps/web/src/features/query-builder/*.test.ts` (файл рядом с моделью)

Описание тула живёт **в коде**, а не в `aspect_definitions`, поэтому правка примера
пересева реестра на проде НЕ требует. Системный промпт не трогаем: слова «alias» в нём нет
вовсе (`rg -i alias` по `apps/server/src/llm/prompts/` — ноль совпадений), значит новый
файл `v5` и перенос гардов не нужны.

- [ ] **Шаг 1: Добавить пример резолва категории по алиасу**

В `description` тула `entity_query` дописать третий пример, сохранив два существующих:

```
«aspect=orbis/category, aliases=такси» (резолв категории по синониму: aliases — массив, фильтр ищет вхождение)
```

Полную строку собери сам, не ломая существующие примеры и не выходя за стиль соседних
описаний. Затем поправь `registry.test.ts`, который пиннит подстроку примера.

- [ ] **Шаг 2: Убрать нефильтруемые поля из формы query-builder**

`visibleFieldNames` сегодня отдаёт все имена каталога выбранного аспекта, поэтому форма
рисует пользователю контрол для `recurrence`, печатающий заведомо нерабочий фильтр.
Отфильтруй `unfilterable`. Поля типа `array` **оставь** — после Task 2 они работают.

- [ ] **Шаг 3: Тест на форму**

Написать тест: для аспекта с `unfilterable`-полем оно не предлагается, а `array`-поле —
предлагается. Имя аспекта и поля возьми фактические (`orbis/schedule.recurrence`,
`orbis/category.aliases`).

- [ ] **Шаг 4: Прогнать сьюты**

Запуск: `bun run --filter @orbis/server test -- registry.test.ts`, затем
`bun run --filter @orbis/web test`, `bun run lint`, `bun run typecheck`.

- [ ] **Шаг 5: Коммит**

```bash
git add apps/server/src/tools/registry.ts apps/server/src/tools/registry.test.ts apps/web/src/features/query-builder/model.ts
git commit -m "feat(query): модель видит пример фильтра по алиасу, форма не предлагает нефильтруемое"
```

---

### Task 4: Живой смоук и бэклог (исполняет контроллер)

- [ ] Стенд: `cd apps/server && PORT=3000 WEB_DIST_DIR=../web/dist SUPABASE_URL=http://127.0.0.1:54321 bun run src/index.ts`;
      вход magic link'ом; SW снимать дважды (он перерегистрируется).
- [ ] **Главный гейт:** сказать модели «потратил 300 на такси» — категория «Транспорт»
      находится **с первого запроса**, без серии промахов. Это отличает «починили грамматику»
      от «починили поведение».
- [ ] Бэклог: регистр и «ё» в containment (нужен функциональный GIN-индекс = миграция);
      сведение трёх резолвов (LLM, web fast-path, CSV-импорт) к одному коду; дубликаты
      алиасов между категориями; `NOT (@>)` не индексируется.

## Самопроверка плана

- **Покрытие спеки:** Р2, Р5 → Task 1; Р3, Р4, Р8 → Task 2; Р6 → Task 3; Р1 (выбор варианта)
  зафиксирован спекой; Р7 (типовая страховка) — в Task 1 через union и в Task 2 через
  падающий `sortCast`; приёмка → Task 4.
- **Плейсхолдеров нет:** код приведён целиком для всех изменяемых функций.
- **Согласованность имён:** `'array'` и `'unfilterable'` объявлены в Task 1 и используются
  под теми же именами в Task 2 и Task 3; `arrayContains` — единственная новая функция
  компилятора; `aspect`/`fieldName` добавлены в `FieldRef` в Task 2 и там же используются.
