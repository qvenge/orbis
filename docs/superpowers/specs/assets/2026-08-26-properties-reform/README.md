# Эталоны проб П1 и П2 — реформа свойств/аспектов/контрактов (D43)

Спека `docs/superpowers/specs/2026-08-26-properties-reform-design.md` называет jsonc-эталоны проб
**отправной точкой реализации** (§Б5-4 — подписка Budget; §Б3-5 — канон узлов E-AST; §С9-0 —
задача 0-серии «перенос эталонов проб в репозиторий»). Сами пробы жили в `.superpowers/probe/`,
а весь `.superpowers/` — в `.gitignore:24`: норматив не может жить вне git (В6 ревью спеки).
Здесь лежат перенесённые файлы.

## Что это и чем НЕ является

Это **артефакты двух проб от 2026-08-25**, снятые до написания спеки. Спека их читала и местами
исправляла. Поэтому:

- **Не форма реестра.** Форму `property_definitions` задаёт §А2-1, форму `aspect_definitions` —
  §А3-1, форму `contract_definitions` — §Б1-1. Ни один файл здесь этим формам не соответствует.
- **Не таблица имён.** Имена свойств задаёт §А8. Расхождения перечислены ниже пофайлово.
- **Нормативно то, что спека прямо назвала нормативным**, и только оно: словарь типов (10+6),
  состав подписки Budget, замер индексов, форма кеша `spent`. Всё остальное — образец нотации.

При конфликте эталона и спеки **побеждает спека**.

## Провенанс

| Файл | Проба | Источник (gitignored) | Отчёт | Что нормативно |
|---|---|---|---|---|
| `p1-registry.json` | П1, 2026-08-25 | `.superpowers/probe/p1/registry.json` | `docs/superpowers/reviews/2026-08-25-probe-p1.md` | Словарь типов `type_dictionary` (10 базовых kind + 6 добавок) — §А2-2 взял его один-в-один, кроме двух переименований (ниже). Состав контрактов, подписок, шаблонов правил — образец нотации для части Б |
| `p1-schemas.json` | П1, 2026-08-25 | `.superpowers/probe/p1/schemas.json` | то же | JSON Schema конверта ответа и шести родов деклараций (`property_definition`, `aspect_delta`, `binding`, `action_definition`, `subscription_delta`, `rule`), `$defs.locstr/proptype/expr` — образец для схем деклараций части Б (срез Б-2), не для схем среза А |
| `p1-mutation-check.ts` | П1, 2026-08-25 | `.superpowers/probe/p1/mutation-check.ts` | то же, §1 | Исполняемое доказательство, что 100 % структурной валидности П1 — не артефакт слабой схемы: 17 из 17 испорченных ответов отвергнуты, оба валидных приняты |
| `p2-registry.json` | П2, 2026-08-25 | `.superpowers/probe/p2/registry.json` | `docs/superpowers/reviews/2026-08-25-probe-p2.md` | Мок-реестр ровно под подписку Budget — минимальный набор, на котором мерился прототип |
| `p2-subscription.budget.json` | П2, 2026-08-25 | `.superpowers/probe/p2/subscription.budget.json` | то же, §8.1 | **Нормативная подписка Budget** — §Б5-4 прямо называет этот файл отправной точкой реализации (срез Б-1) |
| `p2-01-new-form.sql` | П2, 2026-08-25 | `.superpowers/probe/p2/01-new-form.sql` | то же, §§1, 5 | DDL-прототип новой формы (`props jsonb` + массив аспектов + `relations.role`), на котором измерено **1,14×** к сегодняшним агрегатам (p95 291,1 / 254,7 мс) при нуле расхождений семантики |
| `p2-07-indexes-new.sql`, `p2-07-indexes-old.sql`, `p2-07-indexes-drop.sql` | П2, 2026-08-25 | `.superpowers/probe/p2/07-indexes-{new,old,drop}.sql` | то же, §7 | Доказательство решения §А1-4 «экспрессионные btree по `props` не заводим»: замер на 20k и 100k показал, что ни одна ведомость Budget их не берёт. `-old` — контроль на старой форме, `-drop` — откат замера |
| `p2-05-materialize.sql` | П2, 2026-08-25 | `.superpowers/probe/p2/05-materialize.sql` | то же, §§5, 10 | Прототип кеша `envelope_spent_cache` (§Б5-5, срез Б-1): именно **обычная таблица под RLS владельца**, а не MATERIALIZED VIEW — обоснование в шапке файла и в §Б5-5 |

Все файлы перенесены **побайтно**. Единственная правка — в `p1-mutation-check.ts`: четыре строки
шапки-комментария и путь `./schemas.json` → `./p1-schemas.json` (файл переименован при переносе).

## Как запустить мутационную проверку

```sh
cd docs/superpowers/specs/assets/2026-08-26-properties-reform
bun p1-mutation-check.ts
```

Ожидается 19 строк: 2 × `ПРОШЛО` (эталонный пустой ответ, валидная `binding`) и 17 ×
`ОТВЕРГНУТО`. `ajv`/`ajv-formats` берутся из корневого `node_modules` репозитория.

## Расхождения со спекой (проверено пофайлово 2026-08-26)

### `p1-registry.json`

**Форма записи свойства.** Каждый элемент `properties[]` несёт ровно четыре ключа —
`key`, `type`, `label`, `description`. Это **не** форма `property_definitions` §А2-1: нет
`id`, `owner_id`, `status`, `scope`, `merged_into`, `module`, `rank`, `flags`, `created_at`.

**Форма записи аспекта.** `aspects[]` несут `id`, `label`, `module`, `properties`, `implements`
(+ `service`, `note` у части) — против §А3-1, где у аспекта та же четвёрка `id/key/label/description`
плюс `ai_instructions`, `tag_mappings`, `view_config`, `rank`, `service`. Внутри —
`properties[].property` вместо `property_id` (§А3-1) и **без `rank`**, который §А3-1 требует.

**Словарь типов.** `type_dictionary` совпадает с §А2-2 по структуре (10 базовых + 6 добавок) и
по всем шести добавкам (`time`, `registry_ref`, `cardinality`, `exclusiveMin`,
`text.pattern|format|maxLength`, `bounds`). Два базовых kind спека переименовала:

| В П1 | В §А2-2 / §А8 |
|---|---|
| `integer` (`orbis/duration_min`, `orbis/effort_min`) | `number {integer, min: 1}` |
| `uuid` (`orbis/grant_id`) | `grant` — отдельный kind, ссылка в `agent_grants` |

**Имена свойств.** Сверены все 52 ключа `orbis/*` против §А8 (ещё 6 ключей — `user/*`, свойства
из заданий пробы, в §А8 их нет по построению). Расходятся ровно два:

| В П1 | В §А8 |
|---|---|
| `orbis/envelope_limit` | `orbis/limit` (аспект `orbis/budget`) |
| `orbis/grant_id` | `orbis/grant` (слито с `agent-run.grant_id`) |

Оговорка о самой спеке: §А5-3(а) приводит пример грамматики как `orbis/envelope_limit>1000`, а
§А8 в той же строке про `orbis/limit` пишет `orbis/limit>1000`. Это **расхождение внутри спеки**;
действует таблица §А8 — имя свойства `orbis/limit`.

Остальные 56 имён совпали, включая `orbis/finance_category` (то самое слияние
`financial.category_ref` + `budget.category_ref` из принципов §А8).

**Полнота.** П1 покрывает 58 свойств. §А8 сверх них называет служебные свойства прогона
(`orbis/run_*`, `orbis/step_count`, `orbis/last_step_at`), core-проекции §А1-3
(`orbis/archived`, `orbis/title`, `orbis/created_at`, `orbis/updated_at`), `orbis/bank_txn_id` и
новые свойства реформы (`orbis/weight`, `orbis/undecided`, `orbis/parent_project`,
`orbis/root_project`, `orbis/session_url`, `orbis/abandon_note`, `orbis/fail_note`, …).

**Контракты** (`contracts[]`) — форма и состав до §Б1:

- Форма: `slots[].slot` вместо `slots[].name`, `classes[].class` вместо `classes[].key`,
  `class_sets[]` массивом вместо `sets: {имя: …}` §Б1-1; нет `key`, `owner_id`, `module`, `rank`.
- `orbis/when`: слоты `moment`, `due`, `all_day` — §Б1-2 даёт **два** слота, `moment` и
  **`deadline`** (№16); слота `all_day` в контракте нет.
- `orbis/completable`: лишний слот `closed_at` — §Б1-2 оставляет один слот `status`.
- `orbis/money-movement`: 6 слотов — §Б1-2 требует **9** (нет `recurring`, `counterparty`,
  `bank_txn_id`); классы названы `expense`/`income`/`neutral`, тогда как §А8 и §Б1-2 требуют
  классы `outflow`/`inflow` (`expense→outflow`, `income→inflow`); наборы названы
  `counted_as_spending`/`counted_as_earning` вместо `outflow` и `facts` (§Б5-4).
- `orbis/sensitivity`: 4 факта — §Б1-2 требует **5** (нет `grants_autonomy`); плюс в П1 в тело
  контракта вложены `levels`, которых форма `{kind: "facts"}` §Б1-1 не содержит.
- Контракта ядра `orbis/recurrence` (§Б1-2) в П1 нет вовсе.

### `p1-schemas.json`

Схема писалась под словарь выражений, каким он был **до** §Б3-2, §Б3-2а и §Б3-5. Против канона
узлов E-AST §Б3-5:

- **Нет узлов**, добавленных спекой: `if` (в `op`), `{duration:…}`, `date_add`, `date_diff`,
  `days_inclusive`, `{has_relation:…}` (Е-1), `{agg:…}`, `{agg_via:…}` (Е-2), `{deref:…}` (Б3-3/Е-3).
- **`ctx`** знает `$today`, `$now`, `$owner`, `$entity`; канон §Б3-5 — `$today`, `$owner`,
  `$self`, `$sensitivity` (последний — только в `assign_level`).
- **Лишние узлы** относительно канона: `{core: title|tags|archived}` (§А1-3 переводит core-колонки
  в свойства реестра — адрес становится `{prop: "orbis/title"}`), `{slot: {contract, slot}}`,
  `{class_set: {contract, set}}`.

Совпало с каноном: `{const}`, `{prop}`, `{param}`, `{has}`, `{class: {contract}}` и набор
сравнений/арифметики/булевой логики/`in`.

### `p2-registry.json`

- **`roles` вместо `aspects`.** Верхний ключ — `roles`; §А1-1 и §А3 называют это аспектами
  (колонка `aspects text[]`). То же и в SQL-файлах П2 (см. ниже).
- **Тип свойства — голая строка** (`"decimal"`, `"string"`, `"bool"`, `"object"`, `"ref"`), а не
  объект `{kind, …конфиг}` §А2-1/§А2-2; трёх из этих имён в словаре §А2-2 нет вовсе:
  `string` → `text`, `bool` → `boolean`, `object` → `json`.
- **Имена:** `orbis/category_ref` — в §А8 это `orbis/finance_category` (суффикс `_ref` упразднён,
  свойства financial и budget слиты). При этом `orbis/limit` в П2 названо **правильно** — то есть
  два эталона расходятся между собой: у П1 `orbis/envelope_limit`, у П2 `orbis/limit`; норматив —
  §А8 (`orbis/limit`).
- **Роль ребра `derived-from`** — §А4-3 переименовывает её в **`instance-of`** (`derived_from` —
  старое имя из кода). Роли `envelope-binding` и `category-parent` совпадают с §А4-3.
- **Контракты**: форма `slots/class_sets/class_slot/implementations[].map` — не форма §Б1-1;
  `money-movement` несёт 7 слотов (в том числе `template_marker`), §Б1-2 требует 9 названных;
  `envelope` — 6 слотов, совпадает с §Б1-2.

### `p2-subscription.budget.json`

Состав ведомостей — **норматив**: §Б5-4 называет этот файл отправной точкой реализации.
Из шести исправлений §Б5-4 против буквального Ч8 файл несёт пять, и одного в нём нет:

| Исправление §Б5-4 | В файле |
|---|---|
| №1 класс «расход» в `spent` | есть — `where: in_class_set(money-movement, outflow)` |
| №2 второе правило валюты в `period_balance` | есть — `currency: "owner_default_only"` при верхнеуровневом `currency_rule: "owner_default_if_absent"` |
| №3 предикат «есть ребро роли» в списках | есть по существу, другой нотацией — `requires_relation`/`excludes_relation` (см. ниже) |
| №4 `on_raw` у порога тревоги | есть — `alerts: {warn_at: 0.85, on_raw: true}` |
| №5 «живой конверт» в `unbudgeted` | **нет** — в файле только `unbound_via: "envelope-binding"`; условие «ребро на архивный конверт ≠ unbudgeted» §Б5-4 добавляет сверх пробы |
| №6 разыменование в сортировке карточек | есть, узлом `{ref_title: "category"}` вместо `{deref: …}` §Б3-3 |

Расходится и **нотация выражений** — файл писался до §Б3-5:

- Операции названы словами: `eq`, `lte`, `lt`, `gt`, `gte`, `add`, `sub`, `mul` — канон §Б3-5
  использует символы `=`, `<=`, `<`, `>`, `>=`, `+`, `-`, `*`.
- Узел-литерал `{lit: …}` — в каноне `{const: …}`.
- Операции `coalesce`, `div_round2`, `lit_default`, `in_class_set` в перечне §Б3-5 отсутствуют
  (канон даёт `in`, `class(contract)` и деление `/`).
- `{op: "has", args: [...]}` — канон требует узел `{has: <prop-id>}`.
- `{ctx: "today"}`, `"month_start"`, `"month_end"`, `"horizon_14d"` — без `$` и вне закрытого
  перечня контекстов §Б3-5.
- Узлы `{slot: …}`, `{phase: …}`, `{ref_title: …}`, `{core: "id"}` в каноне §Б3-5 не перечислены.
- Списки `coming_up`/`planned` разводят «инстанс vs ручная» через
  `requires_relation`/`excludes_relation` по роли **`derived-from`**; §Б5-4 предписывает предикат
  `has_relation(instance-of)` (Е-1), роль — `instance-of` (§А4-3).
- Слоты в селекторе конверта названы `category`/`date`/`limit` — это имена слотов мок-контрактов
  П2; §Б5-4 в той же строке пишет `finance_category`, `occurred_on` (имена свойств). Соответствие
  «слот ↔ свойство» живёт в привязке контракта (§Б2), а не в подписке.
- `surface: "budget/overview"` — §Б5-1 берёт перечень поверхностей из манифестов модулей;
  в реестре П1 та же поверхность названа просто `budget`.

### `p2-01-new-form.sql`

- **Колонка `roles text[]` = `aspects text[]` спеки.** Оговорка стоит в самом файле, строки 4–6:
  «в задании колонка названа `aspects text[]`; здесь она называется `roles text[]`… Это та же
  колонка». Норматив имени — §А1-1.
- **Нет колонки `query_refs`**, которую §А1-1 добавляет к body-слою.
- **Нет реестровых таблиц** (`property_definitions`, `aspect_definitions`,
  `relation_role_definitions`, `registry_deltas`): прототип мерил форму хранения, а не реестр.
- Схема `newf` рядом с `public` — площадка замера, не целевая схема.

Совпадает со спекой (и потому переносится как образец): отсутствие `entities.meta` (§А1-1
удаляет колонку), сохранённая системная `relations.meta` (§А1-1), `relations.role text NOT NULL`
с `UNIQUE (source_id, target_id, role)` (§А4-1), индексы `(source_id, role)` / `(target_id, role)`
(§А4-1: «несущие — доказано П2 §7»), GIN по `props` и по массиву аспектов (§А1-4).

### `p2-07-indexes-new.sql` / `-old.sql` / `-drop.sql`

Это **отрицательный результат**, а не образец для миграции 0017: заведённые здесь экспрессионные
и частичные btree по `props` (`n_props_envelope_period`, `n_props_movement_date`,
`n_props_movement_catref`) §А1-4 прямо запрещает заводить — П2 §7 показал на 20k и 100k, что ни
одна ведомость Budget их не использует. `-old.sql` — тот же набор на старой форме (контроль
«выигрыш даёт форма или индекс»), `-drop.sql` — снятие обоих наборов.
Имена свойств внутри — те же, что в `p2-registry.json` (`orbis/category_ref` вместо
`orbis/finance_category`), и предикаты идут по колонке `roles`.

### `p2-05-materialize.sql`

Форма совпадает с решением §Б5-5 в главном: **обычная таблица под RLS владельца**, не
MATERIALIZED VIEW (matview нельзя обновить частично и он живёт вне политик). Расходится в двух
местах:

- **Нет колонки `registry_version`**, которую §А10-1 требует от кешей агрегатов («кеши агрегатов
  (§Б5-5) несут `registry_version` и инвалидируются его сменой»).
- `spent numeric` — §А2-2 хранит денежные величины типом `decimal` (decimal-строка,
  `budget/decimal.ts`); `numeric` здесь взят для скорости замера.

Схема `newf` и отсутствие точки инвалидации (бюджет-хук — §Б5-5) — тоже свойства площадки, не
проекта таблицы.
