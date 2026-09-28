# Страницы, срез 1в «Повестка и язык контрактов»: план реализации

> **Для агентных исполнителей:** ОБЯЗАТЕЛЬНЫЙ САБ-СКИЛЛ — `superpowers:subagent-driven-development`
> (рекомендуется) либо `superpowers:executing-plans`. Шаги размечены чекбоксами (`- [ ]`).
> Исполнитель задачи видит ТОЛЬКО свою задачу — бриф самодостаточен, имена и типы соседних задач
> продублированы в блоке «Интерфейсы». Модели: все сабагенты — имплементеры, разведка, гейт-ревью задачи,
> ре-ревью и финальное ревью ветки — **только самый последний Opus, сейчас Opus 5.5** (`model: opus`; ниже
> последнего Opus результат не принимается); Fable 5.1 — вторая линза ревью по усмотрению оркестратора;
> sonnet и haiku — никогда (проверка по ID модели в ответе сабагента).
> Вместе с брифом имплементеру передаются `facts-plan.md` и нужный отчёт разведки (`recon-plan-core.md`,
> `recon-plan-web.md`, `recon-1v-core.md`, `recon-1v-web.md`) леджера `.superpowers/sdd/2026-09-27-pages-slice-1v/`
> и `handoff-1v.md` леджера 1б (`.superpowers/sdd/2026-09-24-pages-slice-1b/`).
> Каждый `file:line` плана снят на `origin/main ae3b710d` (прод 1б) и **опровергаем**: перед правкой —
> `git rev-parse HEAD`, адрес — ориентир, искать grep'ом по имени.

**Цель:** запрос страницы, агента и рутины спрашивает не только «какое свойство», но и «какая дата „когда“», «какая сумма
„движения денег“» — из любого расширения; страница получает первые общие механизмы сверх 1а — параметр «период» и
группировку по дням; на них Повестка становится обычной страницей хоста из блоков («всё, что во времени» по дням,
просроченное сверху, горизонт «7 дней | 14 дней»); Бюджет заложен целевой картиной и требованиями своему срезу; старые
экраны Бюджета, Повестки и импорта удалены.

**Архитектура:** первым — ядро языка сквозь все слои (реестр «когда» со слотами `done`/`end`/`all_day` и ролями
«план/факт», адрес слота и значение контракта в Q-AST, разбор, печать, компиляция в SQL по привязкам аспектов записи,
таблица случаев С1в-1, перечень обходчиков дерева со сторожем). Дальше снизу вверх: токены и два края → устойчивый порядок,
сумма по валютам, «последнее», провод `0.5.0` → параметр (канон и сервер, затем web) → группировка по дням (канон и сервер,
затем web) → строка через слоты → Повестка записью поставки → уход подписки Повестки и миграция `0023` → агент (описание
тула, промпты v9/routine-v5, снятие `import_csv_start`) → уборка web → прод-операция `migrate-1v` → документы. Финальное
ревью и прод — последними; перед продом жёсткая остановка.

**Стек:** Bun 1.2.7, Hono, tRPC 11, drizzle-orm/postgres (Supabase Postgres 17, RLS), zod, `@tiptap/*` 3.30.1 + `marked` 17
(модель документа), React 19 + TanStack Query + zustand (стор навигации), vite-plugin-pwa, vitest 4 + jsdom + testing-library
(web), `bun:test` (server, shared, scripts), biome.

**Спека:** `docs/superpowers/specs/2026-09-27-pages-slice-1v-design.md` (ревизия 3, принята владельцем; `main 73e67dc6`).
Контекст: концепция `specs/2026-09-11-pages-and-apps-concept.md` (ревизия 4), спека реформы
`specs/2026-08-26-properties-reform-design.md` (ревизия 8), спеки 1а и 1б; протокол решений —
`.superpowers/sdd/2026-09-27-pages-slice-1v/decisions.md` (Р-1…Р-12, К-1…К-3). План решения спеки не пересматривает;
расхождение спеки с кодом — раздел «Эрраты спеки». Требование спеки в шаге — ссылкой на §, не пересказом. **Словарь спеки §1
обязателен** (плюс словарь 1б §1): «адрес слота», «значение контракта», «даты „когда“», «токен даты» (второго термина нет),
«параметр», «группировка»; «запись», не «сущность»; «лента» — пояснение, не термин.

**Нумерация:** задачи 1–16. План исполняется только после коммита в `main` (задача 1, шаг 1 это проверяет). Жёсткая
остановка — после задачи 15; задача 16 (прод) — только отдельным словом владельца и вместе с ним.

---

## Что установила разведка HEAD (28.09.2026, `origin/main ae3b710d`)

Координатор — сервер вокруг Повестки, поставки, тулов, миграций, прод-операции (Ф-1в-1…13); два читателя Opus по
непересекающимся зонам — канон запросов и сервер (`recon-plan-core.md`) и web (`recon-plan-web.md`). Факты и рулинги —
`facts-plan.md` леджера (Ф-1в-1…29). Ниже — только то, что определяет форму задач.

| # | Факт | Следствие для плана |
|---|---|---|
| Д-1 | Узлы фильтра — цепочки `'x' in node` с тихим хвостом; TS ловит новый узел только в `compileNode` и `printNode`; три generic-обходчика ищут ключи `prop`/`has`/`field` (Ф-1в-15) | адрес — объединение типов `prop`/`field`, а не новый ключ узла: каждый обходчик, читающий поле строкой, получит ошибку типа (РП-2); перечень обходчиков со сторожем (РП-3) |
| Д-2 | `contractSlotSchema` — `.strict()`, загрузчик реестра — `parse` (Ф-1в-14) | роль слота внутри `slots` роняет старый код в окне «пересев → код» — простой на время сборки, как В-3 1б (В-2) |
| Д-3 | `static.ts` стережёт только `scope` и `ref.target`; все входы дерева делят одну `queryAstSchema` (Ф-1в-16) | `$` и `group` — только в схеме деревьев страниц; базовая схема и разбор без места их отвергают с подсказкой (РП-5) |
| Д-4 | `from=`/`to=` — не текстовые формы, а имена одностороннего `range` (`>=T`/`<=T`) (Ф-1в-17) | отдельной формы нет; правило двух краёв — в компиляторе и окне материализации (задача 2) |
| Д-5 | Общий помощник привязок `bindingIndexOf(reg).byContract()` — по рангу аспекта (Ф-1в-18) | компиляция адреса слота — на нём; «значение аспекта с меньшим рангом» — первой привязкой (задача 1) |
| Д-6 | `materializationWindow` реестра не видит; `completed_at` не триггер (Ф-1в-19) | окно от адреса — отображение «адрес → привязанные свойства ∩ триггеры» передаётся в функцию (задача 1) |
| Д-7 | Эталон SQL канона считается руками, 54 случая (Ф-1в-20) | добивка `id` — пересдача всех 54 руками (задача 3) |
| Д-8 | `agenda:horizon` меряет замороженный текст `entity.query` (Ф-1в-20) | он остаётся (база D21); новая Повестка — новый ключ `agenda:page` на пачке `entity.blocks` (задача 10) |
| Д-9 | Деревья с токенами лежат ещё и в `entity_versions`, и в журнале отката (Ф-1в-21) | счёт в `--report` — справочной строкой (задача 13, Э-6) |
| Д-10 | Вход пачки `.strict()`, клиент сверяет ту же схему; бейдж обходит не-`query` узлы (Ф-1в-23) | значения параметров — поле элемента пачки; `{{param}}` бейджу не мешает (задачи 4, 5) |
| Д-11 | `persistOf` не сохраняет `view` (Ф-1в-24) | параллельная карта `views` в `orbis:nav:v2` — совместима со старым клиентом (задача 5) |
| Д-12 | Вычислитель E — только на сервере (Ф-1в-25) | п. 42 — признак «закрыто» от сервера в ответе блока (`closedIds`, задачи 6, 8) |
| Д-13 | `supplyStatusOf` снятый ключ уже переживает; ломаются `revertToEtalon`, роутер `supply.*`, web `byKey` (Ф-1в-3) | список снятых ключей отдельно от эталонов (РП-10, задача 9) |
| Д-14 | `migrate-1b` стоит на эталонах кода, исполнен в проде (Ф-1в-4) | снимается в задаче 9, где меняются эталоны (РП-13, В-3) |
| Д-15 | У `ops.ts` нет входа DSN репетиции (Ф-1в-5, М-27) | `--rehearsal` с DSN из окружения и сторожем localhost (задача 13) |
| Д-16 | Строка токенов — и в v8, и в routine-v4 (Ф-1в-6) | новые версии v9 и routine-v5 (задача 11) |
| Д-17 | Запас замыкания экрана записи ≈1,1 КБ (Ф-1в-28) | переключатель и группы — ленивыми чанками (задачи 5, 7) |
| Д-18 | Настройка `weekStartDay` (`monday|sunday`) уже есть (Ф-1в-26) | посылка §13 спеки опровергнута; исполнение — по букве §3.4 (понедельник), решение — владельцу (Э-1, В-1) |
| Д-19 | Сирот больше, чем в спеке: `useBudget.ts`, `ui/Sheet.tsx`; Б-2 №73 — тест удаляемого модуля (Ф-1в-26) | задача 12 (Э-5) |
| Д-20 | Форматтеры дня и времени в поясе владельца — только `useAgenda.ts:55-77` (Ф-1в-29) | переносятся в ленивый чанк ленты `features/page/blocks/day-format.ts` (задача 7); модуль удаляет задача 10 (РП-22) |

## Решения плана РП-1…РП-22 (владелец может отменить; ход мысли — `facts-plan.md`)

- **РП-1. Задача 1 — сквозная** (shared + сервер): смена типа поля `prop`/`field` ломает сборку сервера до правки его
  обходчиков, поэтому ядро языка — одна задача; оркестратор вправе провести её двумя заходами одного имплементера (shared,
  затем сервер) под одним гейтом, промежуточный заход не коммитится.
- **РП-2. Форма адреса в Q-AST.** `QueryContractAddress = { contract: string; slot?: string }` (есть `slot` — адрес слота;
  нет — значение контракта). Тип поля `QueryFieldRef = string | QueryContractAddress`: `prop` у предиката свойства,
  `field` у `sortBy`, `aggregate` и `group`. `columns[].field` — только `string` (спека §3.1: в `columns` адрес — отказ). Текст:
  `orbis/when.deadline=today`, `orbis/when=overdue`, `sortBy=orbis/when:asc`, `aggregate=sum:orbis/money-movement.amount`,
  `group=day:orbis/when`. Разбор имени: есть свойство с ключом/подписью — свойство (как сегодня); иначе `<контракт>.<слот>` —
  адрес слота (контракт `kind:'slots'`, слот существует); иначе `<контракт>` с объявленным значением — значение контракта;
  иначе прежний `UNKNOWN_FIELD`. Новые коды отказа разбора: `UNKNOWN_SLOT`, `NO_CONTRACT_VALUE`.
- **РП-3. Перечень обходчиков и сторож.** Одна строка перечня = одно имя = один файл = одна пометка: строка-комментарий ровно
  `// ОБХОДЧИК-Q: <имя>` над ВХОДНОЙ функцией модуля, названной в строке (прочие функции того же модуля, читающие дерево,
  держат тесты этой строки). `scripts/query-walkers.test.ts` держит `QUERY_WALKERS: ReadonlyArray<{name: string; file:
  string}>` и требует взаимно-однозначного совпадения множества пар (имя, файл) с пометками `git grep -n '^\s*// ОБХОДЧИК-Q: '
  -- apps packages scripts`; число пиннится; пометка в прозе (не строкой-комментарием) — отказ. Новый вид узла, поля или
  значения — строка «что делает» в перечне и тест поведения у самого обходчика в той же задаче. Раздел «Обходчики дерева
  запроса» — ниже.
- **РП-4. Роль слота и значение контракта.** Поле слота `value_role?: 'plan' | 'fact'` внутри `slots` (спека §3.2, §18);
  схема: роль — только у слота с типом, содержащим `date`/`timestamp`, иначе отказ разбора реестра. Правило значения —
  закрытый набор в коде `CONTRACT_VALUE_RULES = { dates: … }` (`packages/shared/src/registry/contract-value.ts`); контракт с
  ролями получает правило `dates` (в 1в — единственное). Правило читает набор `closed` контракта `orbis/completable` (К-1).
- **РП-5. Только страницы: `$` и `group`.** Две схемы из одной фабрики: `queryAstSchema` (все входы, как сегодня) отвергает
  `{param}` и `group` с подсказкой «работает только в блоках страниц и шаблонов»; `pageQueryAstSchema` — атрибут query-блока
  тела (`bind-query.ts`) и web (`QueryWidget`). Разбор текста получает место: `parseQueryAst(text, reg, { place: 'page' })`;
  без места — отказ `PAGE_ONLY` с той же подсказкой. JSON Schema тула — без `$` и `group`.
- **РП-6. Значение `$`-ссылки** — `QueryParamValue = { param: string }` на месте значения-границы (там, где разрешён токен).
  Подстановка — на сервере до окна материализации и компиляции (`substituteParams`); значения приходят полем элемента пачки
  `params?: Record<string, string>`; сервер проверяет, что значение — токен даты (тип `period`); нет значения для имени —
  отказ блока `UNKNOWN_PARAM`. Печать — `$<имя>`; литерал, начинающийся с `$`, печать берёт в кавычки.
- **РП-7. Сумма по валютам и «последнее».** Провод: `{kind:'sum', count, sums: Array<{currency: string | null; sum: string;
  count: number}>}` (`currency: null` — не денежные строки) и `{kind:'latest', value, currency: string | null}`. Денежность
  свойства — по привязке слота `amount` «движения денег» у аспекта, стоящего на записи (первая по рангу); валюта — слот
  `currency` той же привязки, нет значения — валюта владельца (`CompileCtx.ownerCurrency`). По валютам — плитка
  страницы (`entity.blocks`) и `user_query` агента; прогресс цели считает сумму одним числом, как сегодня (В-5). «Последнее» — первая строка в
  порядке `sortBy` блока, без `sortBy` — по `updated_at` (и у прогресса цели: общий компилятор).
- **РП-8. Устойчивый порядок.** `compileOrderBy` всегда завершает `ORDER BY` ключом `e.id ASC`; без `sortBy` — `ORDER BY e.id`.
  Эталон SQL пересдаётся руками.
- **РП-9. Контракт клиента `0.5.0`** — один подъём в задаче 3 (первое изменение провода); покрывает и узел `{{param}}` (R-12
  1б). `DOC_SCHEMA_VERSION` не поднимается.
- **РП-10. Снятый ключ поставки.** `SUPPLY_KEYS` — ключи эталонов кода (`agenda` на месте `upcoming`);
  `RETIRED_SUPPLY_KEYS = ['upcoming']`; `SUPPLY_KEY_VALUES = [...SUPPLY_KEYS, ...RETIRED_SUPPLY_KEYS]` — варианты
  `orbis/supply_key` реестра, вход роутера `supply.*`, признак записи поставки в web. Род записи у снятого ключа — по аспекту
  `orbis/app` (как уже у неизвестного ключа в `supplyStatusOf`); `revertToEtalon` берёт род из записи. Id записи `agenda` —
  uuidv5 `graph:supply:agenda` (не список прежнего сева).
- **РП-11. Группировка — сервер считает.** Новый вид ответа `{kind:'groups', groups: Array<{day: string | null; rows:
  BlockGroupRow[]}>, more, closedIds}`, где `BlockGroupRow = {entity, at: BlockRowAt | null}`, `BlockRowAt = {slot: 'done' |
  'moment' | 'deadline' | null; value: string; end: string | null; allDay: boolean}`; верх `EntityBlocksResult` получает
  `today` и `timeZone`. Даты «когда» записи и её ключ SQL отдаёт колонками (`__when_dates` jsonb, `__key_at`), выбор даты в дне (приоритет
  `done > moment > deadline`) и подробности — чистой функцией `layoutDayGroups` в shared (под тестом без базы).
- **РП-12. Признак «закрыто» от сервера** (п. 42): ответы `rows` и `groups` несут `closedIds: string[]` — записи в наборе
  `closed` «завершаемости» (`compileClassMembership` в SELECT); `EntityRow` получает проп `closed` поверх проекции.
- **РП-13. `migrate-1b` снимается в задаче 9** (операция, модуль, тест, строка `ops.ts`, ранбук) — там же, где меняются
  эталоны: исполнена в проде 28.09, а её план стоит на эталонах, которые 1в меняет (иначе задача 9 не закроется зелёной). Фикстура `test/legacy-world.ts` остаётся для отказа `GRAPH_NEEDS_MIGRATION` (свой
  список прежних шести списков); текст отказа отсылает к ранбуку, не к `migrate-1b`.
- **РП-14. Прод-операция `migrate-1v`** (`apps/server/src/db/migrate-1v.ts`, белый список `ops.ts`): `--report` без загрузки
  реестра (сырые чтения и чистые функции: работает ДО миграции `0023`, когда в базе ещё строка `orbis/agenda`, которую
  загрузчик нового кода не разберёт); `--apply --i-understand` — одна пачка исполнителя (`source: 'system'`, механизм
  `supply`, `actorKind: 'owner'`); `--rehearsal` — DSN из `ORBIS_REHEARSAL_DSN`, только `localhost`/`127.0.0.1`.
- **РП-15. Параметр в истории.** Значение — `view['param:<имя>']` записи стопки экрана (действие `view`); сохранение
  `orbis:nav:v2` получает параллельную карту `views: Record<SectionKey, Record<string, string>>` — только ключи `param:*`
  корня раздела; старый клиент её не читает (лишний ключ), новый читает при старте.
- **РП-16. `/agenda`** — оверлей `legacy-supply` с ключом `agenda` (как `/browser` → «Записи»): открывает раздел Повестки хоста
  и заменяет адрес; `LegacyAddress.reserved.key` — только `'budget'`.
- **РП-17. Словарь токенов** — `QUERY_DATE_TOKEN_LABELS` в `packages/shared/src/query/tokens.ts` (сабпат `@orbis/shared/query`,
  уже эагерен в `DataBlock`); web `DATE_TOKEN_LABELS` удаляется. Подписи — таблица спеки §3.4.
- **РП-18. Ленивые чанки.** Переключатель параметра (`features/page/blocks/ParamSwitchSlot.tsx` → `ParamSwitch.tsx`) и лента по
  дням (`features/page/blocks/DayGroupsSlot.tsx` → `DayGroups.tsx`) — точки лени по образцу `RecordsBlockSlot.tsx`; в
  `LAZY_DETAIL_MODULES` `scripts/check-lazy-chunks.ts`.
- **РП-19. Токены и края.** Таблица спеки §3.4 — одна чистая функция `tokenEdges(token, today, weekStart) → {start?, end?}` в
  `packages/shared/src/query/tokens.ts`; её зовут компилятор, окно материализации и перепись. Отказ на несуществующем крае —
  код разбора `TOKEN_EDGE` и тот же текст у компилятора (`VALIDATION`, `reason: 'TOKEN_EDGE'`).
- **РП-20. Перф Повестки** — ключ `agenda:page` в `perf.test.ts`: пачка `entity.blocks` из трёх блоков тела Повестки с
  `params: {period: 'next_7d'}` на объёме `perf`; порог — бюджет прежней Повестки `agenda:horizon`, 120 мс (С1в-14: «база
  Повестки — бюджет `agenda:horizon`»); медиана × 3 выше 120 мс — СТОП и вопрос владельцу (В-7), порог не поднимается.
- **РП-21. Ключ многодатного адреса.** Правило ключа §3.3 («ранняя из дат, удовлетворяющих каждому положительному условию на
  том же адресе; нет такой — удовлетворяющая хоть одному; условий нет — ранняя») действует для значения «когда» И для адреса
  слота с датой (у слота с одной привязкой — совпадает с §3.1 «самое раннее»); у слота не-даты — значение привязки аспекта с
  меньшим рангом (`COALESCE` по рангу).
- **РП-22. Вес экрана записи — размещение заранее** (запас ≈1,1 КБ, Д-17): эагерно — только `features/page/params.tsx`
  (провайдер), `ParamSwitchSlot.tsx`, `DayGroupsSlot.tsx` (склейка по образцу `RecordsBlockSlot.tsx:15-40`) и правки ветвей
  `DataBlock`, `TileForm`, форм; переключатель, лента, подписи дней и колонки времени (`day-format.ts`) — в ленивых чанках;
  `lib/dates.ts` не растёт. Локальный замер `check-lazy-chunks` — в шаге реализации задач 3, 4, 5, 7, 8 (не только CI).

## Вопросы владельцу (исполнение идёт по умолчаниям; ответ «не по умолчанию» — правка плана до задетой задачи)

| # | Вопрос | Умолчание | Задевает |
|---|---|---|---|
| В-1 | Спека §3.4 фиксирует начало недели константой «понедельник» и откладывает настройку, но настройка `weekStartDay` (`monday|sunday`) уже есть в «Общих» (Д-18) | по букве спеки: понедельник константой (`CompileCtx.weekStart = 'monday'`; владелец с «воскресеньем» видит `this_week` с понедельника); альтернатива — `this_week` читает `weekStartDay` (правка одной строки `queryContext`) | 2 |
| В-2 | Окно «пересев → код»: роль слота внутри `slots` старый код не разберёт строго (Д-2) — сервер отвечает 500 на всём, что читает реестр, до живого нового кода | принять простой на время сборки (в 1б — 2 мин 40 с, В-3 1б); альтернатива — порядок «`0023` → код → пересев» (простоя нет; новый код минуты работает на старом реестре: «когда» без ролей — отказ адреса значения, Повестки ещё нет) — отступление от §10 спеки | 16 |
| В-3 | `migrate-1b` снимается из белого списка (РП-13) | снять (задача 9); альтернатива — оставить, заморозив ему эталоны 1б отдельной копией | 9 |
| В-4 | Подпись журнала прод-операции (одна пачка, в ленте скрыта) | «Повестка вместо Upcoming (срез 1в)» | 13, 16 |
| В-5 | §3.6 «сумма считается по валютам раздельно» — общее правило; прогресс цели сравнивает сумму с ОДНИМ числом цели | по валютам — плитка страницы и `user_query` агента (карточка ответа печатает суммы как плитка); прогресс цели — одним числом, как сегодня (сужение §3.6 для целей; остаток — срезу Бюджета) | 3 |
| В-6 | «Год» при статусе «изменено вами» получает только новый эталон, тело не трогается (§6.6 п. 3) — «Обновления» при этом ничего не предложат, а «Вернуть как было» вернёт уже НОВЫЙ эталон | так (буква §6.6) | 13 |
| В-7 | Бюджет перфа новой Повестки (`agenda:page`) — 120 мс прежней `agenda:horizon` (РП-20); если медиана × 3 выше | СТОП задачи 10 и решение владельца (оптимизация или иной бюджет); порог не поднимается молча | 10 |

## Предусловия владельца

Нет: ревизии живых документов §16 спеки внесены (`c493b1ce`: концепция — ревизия 4, реформа — ревизия 8). PRD (**D47**) и
`03-pending.md` — задача 14. Спеку, концепцию, спеки 1а, 1б и реформы план не правит.

## Глобальные ограничения

- **Ветка и дерево.** Ветка `pages-slice-1v` от ЛОКАЛЬНОГО `main` после его перемотки на `origin/main` (в `main` — коммиты спеки
  `73e67dc6`, ревизий `c493b1ce`, прода 1б `ae3b710d` и плана), работа только в worktree
  `/Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1v`; основное дерево не трогать (там бывают чужие незакоммиченные
  правки документов — не коммитить их, не прятать, не откатывать). Свой `bun install`; `apps/server/.env` и корневой `.env` —
  копии из основного дерева (R-1 1б: корневой `.env` = копия `apps/server/.env`). У ветки снять upstream
  (`git branch --unset-upstream`; Ф-Б2-2): иначе голый `git push` уйдёт в `main`. Далее `$W` — путь worktree, `$L` — леджер
  `/Users/birzhan/projects/orbis/.superpowers/sdd/2026-09-27-pages-slice-1v`, `$T` — `/private/tmp/claude-501/pages-1v`.
  cwd и переменные окружения между вызовами инструмента не живут — КАЖДАЯ команда в отдельном вызове начинается строкой
  присваиваний: `W=/Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1v; T=/private/tmp/claude-501/pages-1v;
  L=/Users/birzhan/projects/orbis/.superpowers/sdd/2026-09-27-pages-slice-1v`.
- **`main` до конца среза не меняется** (урок 24.09: мерж в `main` — один раз готовым срезом, в прод-задаче, вместе с владельцем);
  ветку пушить ради CI можно. Автодеплой Render не выключать (шаблон оркестратора): выкатывает пуш в `main` в задаче 16.
- **Закрытие задачи:** гейт-ревью APPROVE + зелёные локальные `test`/`lint`/`typecheck` → push ветки
  (`git push origin pages-slice-1v`) ради CI → CI ветки зелёный. Один имплементер в дереве в каждый момент.
- **Одна БД на все worktree.** Серверные сьюты и `db:prepare` делят одну локальную базу: полный прогон — один за раз во всём
  репозитории; не запускать его параллельно с другой сессией, работающей с той же базой (спросить координатора, если в
  соседнем worktree идёт прогон). С первого `db:prepare` задачи 1 реестр базы — нового вида (роль слота): код прочих деревьев
  (основное, `plan-1v-recon`) его не разберёт — серверные сьюты и `dev` до конца среза запускаются только из `$W`.
- **Одна миграция — `0023`, только данные** (спека §10): удаление встроенной строки `orbis/agenda` из `subscription_definitions`
  (задача 10). Любая найденная необходимость ещё одной миграции (например, поле верхнего уровня у контракта) — **СТОП и доклад
  владельцу**. На проде порядок — `--report` → `0023` → пересев → код → прод-операция (спека §10, задача 16).
- **Пересев реестров** после каждой правки сидов реестра (сид реестров меняют задачи 1, 2 — схема значения `orbis/progress_source` встраивает канон, — 9 и 10): `cd $W && bun run db:prepare > $T/<имя>.log 2>&1`; до
  пересева красные `test/seed-registries.test.ts` и дрейф `/health` — не поломка имплементера. **Сид реестров только добавляет и
  обновляет строки** — удалить строку может только миграция (задача 10).
- **Язык запросов меняется для страниц, агента и рутин сразу.** Новый узел или поле дерева, которого не знает хотя бы один
  обходчик, — тихий дефект. Перечень обходчиков — раздел «Обходчики дерева запроса» этого плана; каждый помечен в коде
  строкой `// ОБХОДЧИК-Q: <имя>` и сверяется сторожем `scripts/query-walkers.test.ts` (задача 1, РП-3). Новый обходчик — строка в
  перечне и пометка в коде в той же задаче.
- **`$`-ссылка и `group` — только в блоках страниц и шаблонов** (спека §3.8): в `entity_query`, рутинах, `orbis/progress_source`,
  `ref.target`, области правил — отказ разбора с подсказкой. Держат базовая `queryAstSchema` и разбор с явным местом (РП-5; задачи 4, 6).
- **Язык E не расширяется** (принцип владельца 14.09): правило значения «даты» — закрытый набор в коде (К-1), не выражение E.
- **Грамматика — одна копия правил** (РП-6 1а): маркеры `{{…}}` распознаёт только `packages/shared/src/doc/page-grammar.ts`;
  сторож `scripts/grammar-copies.test.ts` (счёт примет правит задача 4). `group=` — ключ текста запроса, не маркер.
- **Контракт клиента поднимается один раз** — `0.4.0` → `0.5.0` (`MIN_COMPATIBLE_CLIENT_VERSION`
  `packages/shared/src/constants.ts:11`, `APP_VERSION` `apps/web/src/app/version.ts:4`) в задаче 3: он покрывает все новые формы
  ответа `entity.blocks` и новый узел документа (рулинг R-12 1б). `DOC_SCHEMA_VERSION` (3) **не** поднимается.
- **Вес экрана записи.** Пороги: файл чанка `DetailScreen` — 34 889 Б gzip; эагерное замыкание — 329 400 Б gzip -9 (было 325 238 по R-36 1б; 327 800 — решение владельца 28.09, R-9; 329 400 — R-15, последний подъём среза: третье превышение — ленивый разбор канона);
  превышение — стоп и разбор, не подъём порога. Новое на экране записи (блок параметра, лента по дням) — ленивыми чанками рядом
  с блоком данных, эагерно только склейка; новые эагерные файлы — в список `save.test.tsx`. Сборка:
  `cd $W && bun run --filter @orbis/web build > $T/<имя>-build.log 2>&1` и `bun scripts/check-lazy-chunks.ts` с порогами CI.
- **Никаких тихих записей** (спека §0.2 п. 2, §10). В граф пишут только действия владельца и агента через исполнитель и одна
  прод-операция §6.6 (задача 13, одна пачка `source: 'system'`). Чтение ничего нового не пишет (материализация — правило
  владельца, как раньше).
- **TDD и прогоны.** Полный прогон — `bun run test` из корня worktree (голый `bun test` ЗАВИСАЕТ); `bun run lint`,
  `bun run typecheck` — отдельными вызовами. Точечно: shared — `cd $W/packages/shared && bun test src/<файл>`, server —
  `cd $W/apps/server && bun test src/<файл>`, web — `cd $W/apps/web && bun run test src/<файл>` (vitest), scripts — из корня
  `bun test scripts/<файл>`. **Вывод любого прогона — в файл** (`> $T/<имя>.log 2>&1`), затем чтение файла; **никаких
  `| head`/`| tail` на `bun test`** (висит часами и держит БД — Ф-Б2-12). После отчёта сабагента — `ps aux | grep "bun test"`,
  зомби убить. Перф — строго `test:perf:volume` → `test:perf:explain` → `test:perf:graph` ×3 → `test:perf` (Ф-Г-75), не в
  цепочке с `test`.
- **Сторожа на `git grep` видят только отслеживаемое** (Ф-Б2-11): новый файл — `git add` СРАЗУ при создании (сторож обходчиков
  и прочие сторожа прогоняются и внутри задачи, не только в полном прогоне).
- **Тестовая обвязка.** Server: в теле теста граф — `await freshGraph()` (мир НЕ сеется), `mintGraph()` — только модульные
  константы (Ф-Б2-9); идентичность — `personal(g)`; роутер-тест — `createCallerFactory(appRouter)` с
  `{identity: personal(g), actorKind:'owner', db, clientVersion: null}`; Финансы в сьютах — явно `enableFinanceForTest`
  (`apps/server/test/finance-on.ts`, РП-36 1б). Web: `renderWithProviders(ui, handler)` (`apps/web/src/test/harness.tsx`,
  оболочку НЕ рисует); `matchMedia` в jsdom нет — заглушка в самом тесте.
- **Эталоны пересдаются руками** (автообновления нет): `apps/server/test/golden/{tool-registry,surfaces}.json`, эталон SQL канона
  (задача 3), фикстуры промпта `v9.fixture.txt`, `routine-v5.fixture.txt` (задача 11), фикстура отказов
  `apps/server/test/fixtures/refusals.ts`; снимок экрана записи `features/entity-detail/golden/detail-structure.json` НЕ
  перезаписывается — отличия только поимённой функцией (как `INTENDED_1B`).
- **Мутационная проверка (С1в-11).** Каждая задача со сторожем держит шаг «порча деливерабла → красный → откат»; пин не
  трогается («согласованная порча» — не мутация, Ф-Б2-6). Раздел отчёта имплементера «Пины и мутации» обязателен.
- **Никаких `TODO`/«потом»** в коде; временное — только с докблоком «почему и кто снимает» (реестр §13 спеки).
- **Язык кода, комментариев, ошибок, коммитов — русский; комментарий объясняет «почему».** Словарь спеки §1 и 1б §1: «запись»,
  не «сущность»; «токен даты» (второго термина нет); «параметр», «группировка», «адрес слота», «значение контракта».
- **Коммит** — `git commit -m "<сообщение>" -- <пути>` (**сообщение ДО `--`**, Ф-Б2-7). Трейлер среза фиксирован:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`; ID модели исполнителя — в `progress.md`.
- **Модели.** Имплементеры, гейт-ревью задачи, ре-ревью и финальное ревью ветки — только самый последний Opus (сейчас Opus 5.5,
  `model: opus`; ниже — результат не принимается, ID сверять по ответу); Fable 5.1 — вторая линза ревью; sonnet и haiku — никогда.
- **Ревью-пакет и учёт ревью** — по `docs/superpowers/templates/orchestrator-prompt.md` (экземпляр в леджере).
- **Прод-команды `scripts/ops.ts` — только `cd $W && …`** (в основном дереве после мержа — код, но cwd сбрасывается; урок 1а).

## Фокус ревью (пять входов, которые спека подразумевает, а тесты задач иначе не задели бы)

1. **Владелец не в Москве и запись около полуночи.** Часовой пояс владельца `Asia/Novosibirsk` (+7; любой, кроме запасного
   `Europe/Moscow`), задача закрыта в 23:40 по его времени, браузер — в другом поясе (UTC): запись
   стоит в группе «Сегодня» по времени владельца, колонка «сделано 23:40», дата строки внутри группы не печатается; назавтра
   в ленте её нет. Тест — задача 6, шаг 1 (раскладка, пояс ≠ браузера и ≠ запасного) и задача 7, шаг 1 (подписи дня и
   подавление даты строки в поясе ответа, не браузера).
2. **Старая вкладка после деплоя** (клиент `0.4.0`) открывает страницу, в теле которой `{{param}}` и `orbis/when=$period`: сервер
   отвечает `CLIENT_OUTDATED` на любой запрос, тело не стирается (редактор со старой схемой не открывается). Тест — задача 3,
   шаг 1 (клиент `0.4.0` → `CLIENT_OUTDATED`, `0.5.0` — проходит).
3. **Страница владельца с `$period` в ПЕРВОМ блоке и заметка с вставленным `{{param}}`.** Бейдж раздела страницы считается
   по умолчанию из `{{param}}` того же тела (не тихий отказ), заметка показывает плашку «работает на страницах и в шаблонах»,
   текст маркера сохраняется при правке соседнего абзаца. Тест — задача 4, шаг 1 (бейдж, плашка места, сохранение) и
   задача 5, шаг 1 (редактор заметки не стирает маркер).
4. **Одна запись с расписанием И задачей на один день плюс аспект владельца, привязавший тот же слот** (`moment` двумя
   аспектами, §С8-21): в ленте ровно одна строка, в своём дне, колонка времени — по приоритету `done > moment > deadline`,
   без дубля и без `SLOT_AMBIGUOUS`. Тест — задача 1, шаг 7 (таблица случаев: две привязки одного слота) и задача 6, шаг 1
   (б) — чистая функция, (в) — запись с `moment` и `deadline` в один день на базе.
5. **Снятая с поставки Upcoming, правленая владельцем**: её «⋯» и «Приложения и расширения» не падают на отсутствии эталона,
   «Обновления» её не предлагают, «Вернуть как было» возвращает хранимый текст эталона; закладка `/agenda` из старой вкладки
   открывает Повестку. Тест — задача 9, шаги 1 и 3 (механизм поставки и web).

## Обходчики дерева запроса (РП-3; перечень `QUERY_WALKERS` сторожа `scripts/query-walkers.test.ts`)

Столбцы: имя пометки — где — что обязан делать с адресом (`A`), `$`-ссылкой (`P`), `group` (`G`) — задача. «Отказ» —
структурный отказ с кодом, не тихий пропуск. Адреса — `recon-plan-core.md` «Перечень обходчиков», `recon-plan-web.md` §3.

| Имя (`// ОБХОДЧИК-Q: …`) | Где | A | P | G | Задача |
|---|---|---|---|---|---|
| `schema` | `packages/shared/src/query/ast.ts` (`queryAstSchema`; `pageQueryAstSchema` — задача 4) | принять | базовая — отказ с подсказкой; страниц — принять | так же | 1, 4, 6 |
| `json-schema` | `packages/shared/src/query/ast-json-schema.ts` (`queryAstJsonSchema`) | принять (`oneOf` строка/объект) | нет | нет | 1 |
| `parse` | `packages/shared/src/query/parse-ast.ts` (`parseQueryAst`; внутри — `dispatch`, `parseSortBy`, `parseAggregate`, `parseBound`) | резолв РП-2 | только `place:'page'`, иначе `PAGE_ONLY` | то же | 1, 4, 6 |
| `print` | `packages/shared/src/query/print.ts` (`printQueryAst`; внутри — `printNode`, `printBound`) | `контракт.слот` / `контракт` | `$имя`; литерал с `$` — в кавычках | `group=day:<адрес>` | 1, 4, 6 |
| `normalize` | `packages/shared/src/query/normalize.ts` (`normalizeQueryAst`) | контракт — ключ → id | как есть | `field` адреса | 1, 6 |
| `static` | `packages/shared/src/query/static.ts` (`assertStaticQuery`) | статичен (адрес — не токен) | отказ | отказ | 1, 4, 6 |
| `absolute-date` | `packages/shared/src/query/dates.ts` (`absoluteDateIn`) | литерал даты у адреса с типом даты — находка | не литерал | — | 1, 4 |
| `field-ref` | `packages/shared/src/query/field-ref.ts` (`resolvePropertyFieldId`) | `undefined` (зовущий отказывает) | — | — | 1 |
| `refs-index` | `packages/shared/src/doc/convert.ts` (`queryRefsFromDoc`) | объект адреса не индексируется | — | `field` строкой — как свойство | 1 |
| `bind-query` | `packages/shared/src/doc/bind-query.ts` (`bindQueryBlocks`) | через `pageQueryAstSchema` | принять (рода тела не знает — отказ в заметке держит web, задача 5) | принять | 4 |
| `placement-issue` | `packages/shared/src/doc/placement.ts` (`queryIssue`) | — | разбор с местом по роду тела (`page`/`template` → `'page'`) | то же | 4 |
| `token-boundary` | `packages/shared/src/query/tokens.ts` (`tokenBoundaryForms`, новый) | формы адреса учитываются | — | — | 2 |
| `page-only` | `packages/shared/src/query/page-only.ts` (`pageOnlyFeatureIn`, новый) | — | находит | находит | 4 |
| `compile` | `apps/server/src/query/compile-ast.ts` (`compileQueryAst`; внутри — `compileNode`, `sortItem`, `compileSumAst`, `compileLatestAst`, `walkNodes`) | ветка в `contract-sql` | до компиляции подставлен — иначе отказ | раскладка — `entity-blocks` | 1, 3, 6 |
| `contract-sql` | `apps/server/src/query/contract-sql.ts` (`addressCond`, новый) | SQL по привязкам, ключ РП-21 | — | колонки ключа и дат | 1, 6 |
| `materialize-window` | `apps/server/src/recurring/materialize.ts` (`materializationWindow`) | привязанные триггеры | подставлен до окна (иначе — ошибка программиста) | — | 1, 2, 4 |
| `substitute-params` | `apps/server/src/query/params.ts` (`substituteParams`, новый) | — | в токен / отказ `UNKNOWN_PARAM` | — | 4 |
| `rewrite-ast` | `apps/server/src/registry/ops.ts` (`rewriteAst`) | не трогать объект | — | `field` строкой — переписать | 1 |
| `property-names` | `apps/server/src/registry/ops.ts` (`propertyNamesInAst`) | не имя свойства | — | `field` строкой | 1 |
| `rewrite-text-keys` | `apps/server/src/registry/ops.ts` (`rewriteQueryTextKeys`) | часть до точки — не свойство | — | — | 1 |
| `scope-shape` | `apps/server/src/registry/ops.ts` (`assertScopeShape`) | отказ `SCOPE_SHAPE` | базовая схема | базовая схема | 1 |
| `scope-names-aspect` | `apps/server/src/registry/deltas.ts` (`scopeNamesAspect`) | только `aspect`, прочее — тихо (форму держит `scope-shape`) | базовая схема | базовая схема | 1 |
| `action-query` | `apps/server/src/registry/actions.ts` (`assertActionQuery`) | принять | базовая схема — отказ | то же | 1 |
| `goal-progress` | `apps/server/src/goals/progress.ts` (`computeGoalProgress`) | адрес в `field` — `invalid_field`; в дереве — компилятор | отказ схемы | отказ схемы | 1, 3 |
| `entity-blocks` | `apps/server/src/routers/entity-blocks.ts` (`prepareQuery`; внутри — `compileBlock`, `prepareBadges`) | компилятор | подстановка | раскладка | 3, 4, 6 |
| `entity-query-tool` | `apps/server/src/tools/dispatch.ts` (`runEntityQuery`) | принять | отказ `PAGE_ONLY` | отказ `PAGE_ONLY` | 1, 4, 6 |
| `probe-p3` | `scripts/probe-p3/runner.ts` (функция сверки узла) | отказ «форма вне пробы» | — | — | 1 |
| `web-builder-model` | `apps/web/src/features/query-builder/model.ts` (`fieldNodeView`; внутри — `withDisplay`, `aggregateFieldIds`, `sortableFieldIds`) | узел без строки формы — сохраняется | строка поля — только чтение | сброс при `table`/`tile` | 1, 5, 7 |
| `web-builder-form` | `apps/web/src/features/query-builder/QueryBuilderForm.tsx` (`aggregateOf`; внутри — `aggregateValue`, `SortRows`) | значение `<select>` — `fieldRefKey`, узел сохраняется | — | — | 1 |
| `web-form-parse` | `apps/web/src/features/query-builder/model.ts` (`parseForForm`) | — | место из рода тела | то же | 5 |
| `web-field-rows` | `apps/web/src/features/query-builder/FieldRows.tsx` (`BoundInput`; внутри — `literalText`) | — | подпись `$имя`, не `[object Object]` | — | 5 |
| `web-block-parse` | `apps/web/src/lib/query-blocks/parse.ts` (`parseBlock`) | — | место из рода тела | то же | 5 |
| `web-text-editor` | `apps/web/src/features/query-builder/QueryTextEditor.tsx` (живой разбор) | — | место из рода тела | то же | 5 |
| `web-ref-query` | `apps/web/src/lib/entity-ref/RefField.tsx` (`refQueryAst`) | дерево цели проезжает как есть | базовая схема цели — отказ на сервере | то же | 1 |
| `web-query-widget` | `apps/web/src/features/entity-editor/nodes/QueryWidget.tsx` (`astOf`) | — | `pageQueryAstSchema` | то же | 5 |
| `web-tile-form` | `apps/web/src/features/page/blocks/TileForm.tsx` (`tileValue`) | `latest` над адресом — значение без поиска свойства по строке (не падает); валюта — задача 3 | — | — | 1, 3 |

## Карта файлов

Пути web — от `apps/web/src/`, server — от `apps/server/`, shared — от `packages/shared/src/`.

| Область | Создать | Изменить | Задачи |
|---|---|---|---|
| shared / язык | `query/tokens.ts` (+ тест), `query/page-only.ts` (+ тест), `registry/contract-value.ts` (+ тест) | `query/{ast,ast-json-schema,parse-ast,print,normalize,static,dates,field-ref,index}.ts` (+ тесты), `query/ast-fixtures.ts`, `doc/{convert,bind-query}.ts`, `registry/{contract-type,builtin-contracts,builtin-aspects,bindings}.ts`, `registry/builtin.test.ts` | 1, 2, 3, 4, 6 |
| shared / провод, страница, поставка | `pages/day-groups.ts` (`layoutDayGroups`, + тест) | `contracts/blocks.ts`, `constants.ts`, `doc/{page-grammar,placement,schema,convert,manager,diff,types,index}.ts`, `doc/nodes/*`, `supply/{etalons,lists,print}.ts`, `registry/{row,builtin-properties,builtin-subscriptions,subscription-type,subscription-fixtures,extensions}.ts`, `nav/{address,history-model}.ts`, `index.ts` | 3, 4, 6, 8, 9, 10, 11 |
| server / язык | `query/params.ts` (+ тест), `test/when-world.ts` (фикстура таблицы случаев) | `query/{compile-ast,context}.ts` (+ тесты, `compile.dataset.test.ts`, `compile.golden.test.ts`), `test/golden/query-sql.json`, `recurring/{materialize,with-materialization}.ts`, `routers/entity-blocks.ts`, `goals/progress.ts`, `registry/{ops,actions,validate-props}.ts`, `tools/dispatch.ts`, `executor/props.ts`, `test/gate-c8-18.test.ts`, `perf/{graph,perf}.test.ts` | 1, 2, 3, 4, 6, 10 |
| server / Повестка, поставка, подписка | `db/migrations/0023_agenda_subscription_drop.sql` + `meta/0023_snapshot.json`, `db/migrate-1v.ts` (+ тест), `test/world-1b.ts` (фикстура прод-формы 1б) | `supply/{mechanism,records}.ts`, `routers/supply.ts`, `seed/{setup-graph,smart-lists}.ts`, `subscriptions/registry.ts`, `tools/{registry,registry-tools,dispatch}.ts`, `router.ts`, `import/review.ts`, `llm/{context}.ts`, `routines/context.ts`, `errors.ts`, `test/{surfaces,legacy-world}.ts`, `test/golden/{tool-registry,surfaces}.json`, `test/fixtures/refusals.ts`, ≈12 сьютов-образцов движка подписки | 9, 10, 11, 13 |
| server / удалить | — | `subscriptions/agenda{,.test}.ts`, `routers/agenda{,-acceptance.test}.ts` (задача 10); `db/migrate-1b{,.test}.ts` (задача 9) | 9, 10 |
| server / промпты | `llm/prompts/{v9,routine-v5}.{ts,fixture.txt,test.ts}` | `scripts/check-legacy-form.ts` (`FROZEN_PROMPTS`) | 11 |
| web / страница | `features/page/blocks/{ParamSwitchSlot,ParamSwitch,DayGroupsSlot,DayGroups}.tsx`, `features/page/blocks/day-format.ts`, `features/page/params.tsx` (контекст значений) | `features/page/{Renderer,PageView,RecordView,render-plan}.tsx`, `features/page/blocks/{DataBlock,TileForm,ListForm,CompactForm,TableForm}.tsx`, `lib/query-blocks/{batch,parse,useBadgeData}.ts(x)`, `features/entity-editor/{extensions,strip-ids,layout-parts,EditorShell}.ts(x)`, `features/entity-editor/nodes/{RecordBlockStub,QueryWidget}.tsx`, `features/query-builder/{model,FieldRows,QueryTextEditor}.ts(x)`, `features/browser/EntityRow.tsx`, `features/entity-detail/NativeRow.tsx`, `state/navigation.ts`, `app/{history,router,version,ReservedScreen}.ts(x)`, `features/apps/OpenPlaqueList.tsx`, `features/page/useSupplyRecords.ts`, `features/entity-detail/DetailMenu.tsx`, `features/chat/cards/ImportReviewCard.tsx`, `lib/invalidate.ts`, `test/harness.tsx`, `app/frame/frame-fixtures.ts` | 3, 4, 5, 7, 8, 9, 10, 12 |
| web / удалить | — | `legacy-1v/` целиком, сироты (задача 12) | 12 |
| scripts / docs | `scripts/query-walkers.test.ts`, `scripts/no-legacy-1v.test.ts` | `scripts/{grammar-copies.test,check-lazy-chunks,code-boundaries.test,ops,client-version.test,prompt-size}.ts`, `.github/workflows/ci.yml` (пороги не меняются), `biome.json`, `apps/web/{tsconfig.json,vite.config.ts}`, `docs/prd/{00-product,01-architecture,02-core-os,03-budget,04-decision-log}.md`, `docs/implementation/{00-architecture,02-ops-runbook,03-pending}.md` | 1, 4, 9, 11, 12, 13, 14 |

## Порядок и параллельность

Строго последовательно 1 → 16: одна локальная БД и правило «один имплементер в дереве». Логические зависимости: 1 (ядро
языка) → 2 (токены: окно и перепись читают адрес) → 3 (порядок, сумма, «последнее»; контракт клиента `0.5.0`) → 4 (параметр:
значение-токен и тип `period` стоят на токенах 2) → 5 (web параметра) → 6 (группировка: ключ записи — ключ сортировки 1) → 7
(web групп) → 8 (строка через слоты; `closedIds` из 6) → 9 (Повестка: тело стоит на 4 и 6) → 10 (уход подписки: гейт и перф
перевыражены на Повестке 9) → 11 (агент: описание тула говорит языком 1–2, промпт — «Повестка» 9) → 12 (уборка: форматтеры
перенесены в 7, `/agenda` — 9, `agenda.list` снят в 10) → 13 (прод-операция: эталоны 9, миграция 10) → 14 (документы) → 15
(финальное ревью ДО прода) → 16 (прод с владельцем).

Промежуточные состояния, которые НЕ ломаются: задачи 1–3 только добавляют формы языка (прежние тексты — прежний смысл; тела
поставки границ на токенах не содержат, Ф-1в-21); правило двух краёв (2) меняет смысл лишь форм с токеном-границей, которых в
данных поставки нет. Задачи 4 и 6 открывают `$`/`group` только в схеме страниц — до задачи 9 таких тел в данных нет, а web
учится их рисовать в 5 и 7, ДО появления тела Повестки. Подписка Повестки живёт до задачи 10 (её потребителя в web нет с 1б).
Реестр пересевается локально в задачах 1, 2, 9 и 10; на проде — один раз в задаче 16 после миграции `0023`, до кода.

Самая тяжёлая задача — 1 (ядро языка сквозь shared и сервер, ≈30 прод-файлов): оркестратор вправе провести её двумя
заходами одного имплементера (шаги 1–5 — shared; шаги 6–10 — сервер) под одним гейтом (РП-1).

---

## Задачи

### Задача 1: Ядро языка — «когда» в реестре, адрес слота и значение контракта в каноне, компиляция, таблица случаев С1в-1

**Зачем:** спека §3.1–§3.3, §4.1–§4.2, §3.8 (правило «абсолютная дата» — `dates.ts`), С1в-1, С1в-2, С1в-11 (часть), §6.5
(перевыражение гейта §С8-18), Р-5, Р-8, Р-11, К-1, К-2. На ядре стоят группировка, Повестка, агент и перепись. Адрес — объединение
типов поля (РП-2), чтобы TypeScript показал каждый обходчик (Д-1); перечень обходчиков — сторожем (РП-3). Роль слота —
поле внутри `slots` (РП-4; цена — окно В-2).

**Файлы:**
- shared, создать: `packages/shared/src/registry/contract-value.ts` (+ `contract-value.test.ts`).
- shared, изменить: `registry/contract-type.ts:30-39` (поле `value_role`, проверка «роль — только у слота с датой»),
  `registry/builtin-contracts.ts:50-57` (хелпер `s` — параметр роли), `:93-108` (`orbis/when`: пять слотов),
  `registry/builtin-aspects.ts:71` (расписание: `moment`, `end`, `all_day`), `:123` (задача: `deadline`, `done`),
  `registry/bindings.ts:780-812` (мемо `bindingIndexOf` по снимку — `WeakMap`), `query/ast.ts` (типы и схемы — «Интерфейсы»),
  `query/ast-json-schema.ts:31, 84, 93, 109-137` (`FIELD_REF`), `query/parse-ast.ts` (резолв адреса: `resolveProperty
  :461-497` → новый `resolveField`; `parseBound :645-659` и `parseScalar :595-640` — по виду адреса; `parseSortBy :777-800`,
  `parseAggregate :827-851`, `parseColumns :859-873`; коды `QUERY_PARSE_CODES :131-143` += `UNKNOWN_SLOT`,
  `NO_CONTRACT_VALUE`), `query/print.ts:118-146, 251-277, 314-327`, `query/normalize.ts:69-110`, `query/static.ts:46-77`,
  `query/dates.ts:36-73`, `query/field-ref.ts:56-62`, `query/index.ts` (экспорт), `doc/convert.ts:734-764`
  (`queryRefsFromDoc`), `query/ast-fixtures.ts` (+ фикстуры адреса).
- shared, тесты: `registry/builtin.test.ts` (`slotSig('orbis/when')` `:853`, снимок привязок `B2` `:176-216`, сторож «контракт
  со значением ≠ ключ свойства» — новый), `registry/contract-type.test.ts` (или ближайший тест схемы контракта),
  `query/{ast,parse-ast,print,normalize,static,dates}.test.ts`, `doc/convert.test.ts`.
- server, создать: `apps/server/src/query/contract-sql.ts` (SQL адреса слота и дат «когда»), `apps/server/test/when-world.ts`
  (фикстура таблицы случаев), `apps/server/src/query/when.dataset.test.ts` (таблица С1в-1).
- server, изменить: `query/compile-ast.ts` (`propCond :492-496`, `sortItem :866-888`, `compileOrderBy :890-896`, `numericRef
  :918-927`, `compileLatestAst :961-964` — адрес в `field`; `walkNodes`/`decidesArchived`/`namesServiceAspect :757-838` —
  пропуск адреса), `recurring/materialize.ts:144-268` (`materializationWindow` — окно от адреса), `recurring/with-materialization.ts:59`,
  `routers/entity-blocks.ts:113` (передать реестр в окно), `registry/ops.ts:219-235, 952-965, 973-998, 1535-1550` (типы и
  пометки), `registry/deltas.ts:287` (`scopeNamesAspect` — пометка), `registry/actions.ts:592-622`, `goals/progress.ts:402-410`, `tools/dispatch.ts:972-996` (пометка),
  `test/gate-c8-18.test.ts:215-306` (потребитель 2 — языком «когда»), `perf/graph.test.ts` (два случая).
- web, изменить (только чтобы собралось и не потеряло узел): `apps/web/src/features/query-builder/model.ts` (`fieldNodeView
  :140`, `fieldRef :182`, `sortableFieldIds :273`, `aggregateFieldIds :433` — адрес: строки формы нет, узел сохраняется),
  `QueryBuilderForm.tsx:54-63, 790-890` (значения `field` — `fieldRefKey`), `lib/entity-ref/RefField.tsx:73-91` (пометка), прочие
  места, где TS покажет `prop`/`field` строкой.
- scripts: создать `scripts/query-walkers.test.ts`; изменить `scripts/probe-p3/runner.ts:171-226` (адрес — отказ «форма вне
  пробы»).

**Интерфейсы:**
- Consumes: `bindingIndexOf(reg).byContract(contractId)` → `ResolvedBinding[]` в порядке ранга аспекта
  (`packages/shared/src/registry/bindings.ts:699-714, 780-812`: `aspectId`, `bind: Record<slot, propertyId>`, `fixed`);
  `compileClassMembership` (`apps/server/src/expr/compile.ts:595-602`); `dateExpr`/`castedExpr`/`tokenCond`
  (`compile-ast.ts:248-276, 413-449`); `RULE_MATERIALIZE.params.trigger_properties` (`builtin-rules.ts:316-343`).
- Produces (для задач 2–13):
```ts
// apps/server/test/when-world.ts — фикстура таблицы случаев (задачи 1, 2, 6, 9)
export function seedWhenWorld(graph: GraphId, at: { today: string; timeZone: string }): Promise<WhenWorld>;
// packages/shared/src/query/ast.ts
/** Адрес контракта: со `slot` — адрес слота (§3.1), без — значение контракта (§3.2). */
export interface QueryContractAddress { contract: string; slot?: string }
/** Поле запроса: id свойства (как до 1в) или адрес контракта. `columns[].field` — только строка (§3.1). */
export type QueryFieldRef = string | QueryContractAddress;
export function isContractAddress(f: unknown): f is QueryContractAddress;
/** Ключ поля одной строкой — для ключей React, `<select>`, печати key-формы: `orbis/when.deadline`, `orbis/when`. */
export function fieldRefKey(f: QueryFieldRef): string;
// узел свойства: { prop: QueryFieldRef; op: QueryPropOp; value: QueryPropValue }
// QuerySortField: { field: QueryFieldRef; dir }; QueryAggregate: { fn: 'count' } | { fn: 'sum' | 'latest'; field: QueryFieldRef }
// packages/shared/src/registry/contract-type.ts — поле слота:
//   value_role?: 'plan' | 'fact'   // роль слота в значении контракта (§3.2); только у слота с датой
// packages/shared/src/registry/contract-value.ts
export type ContractValueRule = 'dates';
export const COMPLETABLE_CLOSED = { contract: 'orbis/completable', set: 'closed' } as const; // К-1
export function contractValueRuleOf(c: ContractDefinition): ContractValueRule | null; // есть роль у слота → 'dates'
export function slotsWithRole(c: ContractDefinition, role: 'plan' | 'fact'): readonly string[];
/** Вид адреса для разбора и компиляции: тип слота или «даты» значения. */
export type AddressKind = { kind: 'slot'; kinds: readonly PropertyKind[] } | { kind: 'dates' };
export function addressKindOf(a: QueryContractAddress, reg: { contracts: ReadonlyMap<string, ContractDefinition> }): AddressKind | null;
// apps/server/src/query/contract-sql.ts
export function slotValuesSql(addr: Required<QueryContractAddress>, cctx: CompileCtx): SQL;   // (v) — значения слота по привязкам
export function whenDatesSql(contractId: string, cctx: CompileCtx): SQL;                    // (slot, at, day) — даты «когда»
export function addressCond(node: QueryPropNodeWithAddress, cctx: CompileCtx): SQL;
export function addressSortKey(addr: QueryContractAddress, positive: readonly QueryFilterNode[], cctx: CompileCtx): SQL;
// apps/server/src/recurring/materialize.ts
export function materializationWindow(ast: QueryAst, today: string, params: MaterializeParams, reg: RegistrySnapshot): Window | null;
```

- [ ] **Шаг 1: предусловия и ветка.**
```
cd /Users/birzhan/projects/orbis && git fetch origin && git log --oneline -1 -- docs/superpowers/specs/2026-09-27-pages-slice-1v-design.md   # → 73e67dc6
cd /Users/birzhan/projects/orbis && git log --oneline -1 -- docs/superpowers/plans/2026-09-28-pages-slice-1v.md   # коммит плана есть — иначе СТОП
cd /Users/birzhan/projects/orbis && git merge-base --is-ancestor origin/main main && echo MAIN_HAS_1B || echo MAIN_BEHIND   # MAIN_BEHIND → сперва `git merge --ff-only origin/main` в основном дереве (если мешают чужие незакоммиченные правки тех же файлов — СТОП, вопрос владельцу)
cd /Users/birzhan/projects/orbis && git worktree add -b pages-slice-1v .claude/worktrees/pages-slice-1v main && git -C .claude/worktrees/pages-slice-1v branch --unset-upstream 2>/dev/null; true
W=/Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1v; cp /Users/birzhan/projects/orbis/apps/server/.env $W/apps/server/.env && cp $W/apps/server/.env $W/.env && cd $W && bun install > /private/tmp/claude-501/pages-1v/install.log 2>&1; echo EXIT=$?
```
  Запись в `$L/progress.md`: `BASE_1V=<git rev-parse HEAD>`, ID модели имплементера. `mkdir -p $T`.

- [ ] **Шаг 2: красные тесты shared — реестр.** (а) `builtin.test.ts`: `slotSig('orbis/when')` →
  `['moment:any_of(timestamp|date):opt:plan', 'deadline:date:opt:plan', 'done:any_of(timestamp|date):opt:fact',
  'end:any_of(timestamp|date):opt', 'all_day:boolean:opt']` (формат `slotSig` дополняется суффиксом роли); снимок `B2`:
  расписание — `{moment: 'orbis/start_at', end: 'orbis/end_at', all_day: 'orbis/all_day'}`, задача — `{deadline:
  'orbis/due_date', done: 'orbis/completed_at'}`; новый тест «ни один контракт с объявленным значением не совпадает ключом ни с
  одним свойством» (`BUILTIN_CONTRACTS.filter(c => contractValueRuleOf(c) !== null)` × `BUILTIN_PROPERTIES` — пересечения ключей
  нет; `orbis/recurrence` значения не объявляет); (б) тест схемы контракта: `value_role: 'fact'` у слота `date` — принято; у слота
  `decimal` — отказ «роль — только у слота с датой»; неизвестное значение роли — отказ; (в) `contract-value.test.ts`:
  `contractValueRuleOf(orbis/when) === 'dates'`, `contractValueRuleOf(orbis/money-movement) === null`,
  `slotsWithRole(when,'plan') = ['moment','deadline']`, `'fact' = ['done']`, `addressKindOf({contract:'orbis/when'}) =
  {kind:'dates'}`, `addressKindOf({contract:'orbis/when', slot:'deadline'}) = {kind:'slot', kinds:['date']}`,
  `addressKindOf({contract:'orbis/completable'})` → `null` (значения нет). Прогон
  `cd $W/packages/shared && bun test src/registry/ > $T/t1a.log 2>&1` → FAIL.

- [ ] **Шаг 3: реестр в shared.** Поле слота и проверка:
```ts
// contract-type.ts — внутри contractSlotSchema (.strict() остаётся)
/** Роль слота в значении контракта (§3.2 спеки 1в): «план» или «факт». Нет роли — слот в значение не входит. */
value_role: z.enum(['plan', 'fact']).optional(),
// + superRefine на слот: value_role задана ⇒ тип слота содержит 'date' или 'timestamp' (kind или any_of.kinds),
//   иначе issue «роль в значении — только у слота с датой»
```
  `orbis/when` (подписи ru/en — по таблице спеки §4.1):
```ts
slots: [
  s('moment', anyOf('timestamp', 'date'), false, 'Момент', 'Moment', false, 'plan'),
  s('deadline', k('date'), false, 'Срок', 'Deadline', false, 'plan'),
  s('done', anyOf('timestamp', 'date'), false, 'Завершено', 'Done', false, 'fact'),
  s('end', anyOf('timestamp', 'date'), false, 'Конец', 'End'),
  s('all_day', k('boolean'), false, 'Весь день', 'All day'),
],
```
  Докблок контракта: значение «даты» — §3.2/§4.2 спеки 1в, правило — `contract-value.ts`. Привязки: расписание
  `bind: {moment: 'orbis/start_at', end: 'orbis/end_at', all_day: 'orbis/all_day'}`, задача `bind: {deadline: 'orbis/due_date',
  done: 'orbis/completed_at'}`. `contract-value.ts` — по «Интерфейсам»; докблок: правило «даты» (§3.2 п. 1–3) — закрытый набор
  в коде (К-1), читает набор `closed` ядрового `orbis/completable`; связь — часть правила, не данных. `bindingIndexOf` —
  `WeakMap<object, BindingIndex>` по объекту реестра (снимок кешируется по версиям — Ф-1в-18). Прогон шага 2 → PASS.

- [ ] **Шаг 4: красные тесты shared — канон.** (а) `parse-ast.test.ts` (реестр фикстур с контрактами `orbis/when`,
  `orbis/completable`, `orbis/money-movement` и аспектами расписания, задачи, финансов):
  `orbis/when.deadline=today` → `{prop:{contract:'orbis/when', slot:'deadline'}, op:'eq', value:{token:'today'}}`;
  `orbis/when=overdue` → `{prop:{contract:'orbis/when'}, …}`; `orbis/when=2026-07-17` — литерал дня принят;
  `orbis/when.deadline=2026-07-17T09:00` — `TYPE` (слот `date`); `orbis/money-movement.amount>1000` → `gt` с числом-строкой
  decimal; `orbis/when.nope=today` → `UNKNOWN_SLOT` с позицией; `orbis/completable=open` → `NO_CONTRACT_VALUE` с подсказкой
  «у контракта нет значения — адресуйте слот: orbis/completable.status»; `orbis/recurrence=…` — по-прежнему свойство;
  `sortBy=orbis/when:asc` → `{field:{contract:'orbis/when'}, dir:'asc'}`; `aggregate=sum:orbis/money-movement.amount` при
  `display=tile` — принято; `aggregate=sum:orbis/when` → `TYPE` («даты не суммируются»); `columns=orbis/when.deadline` → `TYPE`
  («в columns — только свойства»); `orbis/when.deadline>today` — `gt` с токеном (упорядоченный вид); (б) `print.test.ts`:
  обратный разбор напечатанного = исходное дерево для каждого нового случая (key- и label-формы; адрес печатается ключами
  всегда); (в) `normalize.test.ts`: адрес с ключом контракта → id контракта, адрес без контракта в реестре — как есть;
  (г) `static.test.ts`: `{prop: адрес, op:'eq', value:'2026-07-17'}` статичен, с токеном — отказ (как у свойства);
  (д) `dates.test.ts`: `absoluteDateIn` находит литерал у адреса слота с датой и у значения «когда»; у адреса суммы — нет;
  (е) `ast.test.ts`: схема принимает адрес в `prop`, `sortBy`, `aggregate`; отвергает адрес в `columns`; паритет zod ↔ JSON
  Schema на новых случаях (`:27, :48, :282`); `fieldRefKey` — `orbis/when.deadline`, `orbis/when`, `orbis/due_date`;
  (ж) `doc/convert.test.ts`: `queryRefsFromDoc` не кладёт объект адреса в индекс и не падает; (з) новый
  `scripts/query-walkers.test.ts` — по РП-3: `QUERY_WALKERS` (перечень раздела «Обходчики дерева запроса», строки задачи 1 —
  все, кроме `token-boundary` (задача 2), `bind-query`, `placement-issue`, `page-only`, `substitute-params` (задача 4),
  `web-form-parse`, `web-field-rows`, `web-block-parse`, `web-text-editor`, `web-query-widget` (задача 5)) ⇔ пары (имя, файл)
  строк `git grep -n '^\s*// ОБХОДЧИК-Q: ' -- apps packages scripts`, пометка вне строки-комментария (`ОБХОДЧИК-Q` в прозе) —
  отказ, число пиннится. Прогон
  `cd $W/packages/shared && bun test src/query/ src/doc/convert.test.ts > $T/t1b.log 2>&1` → FAIL;
  `cd $W && bun test scripts/query-walkers.test.ts > $T/t1c.log 2>&1` → FAIL.

- [ ] **Шаг 5: канон в shared.** Типы и схемы — «Интерфейсы»; `addressSchema = z.object({contract: idSchema, slot:
  z.string().regex(SLOT_KEY_RE).optional()}).strict()`, `fieldRefSchema = z.union([idSchema, addressSchema])`; `columns` —
  `idSchema`. JSON Schema: `FIELD_REF = {oneOf: [PROP_ID, ADDRESS]}` в `prop`, `sortBy[].field`, `aggregate.field`. Разбор —
  `resolveField(name, keyOffset)`: свойство (как `resolveProperty` сегодня) → адрес слота `<ключ контракта>.<слот>` (деление по
  ПОСЛЕДНЕЙ точке; контракт `kind:'slots'`; слот есть — иначе `UNKNOWN_SLOT`) → значение `<ключ контракта>` (правило есть —
  иначе `NO_CONTRACT_VALUE`) → прежний `UNKNOWN_FIELD`. Значение-граница у адреса — по `addressKindOf`: `dates` и слот с
  `date`/`timestamp` принимают токены и литерал дня (`YYYY-MM-DD`); слот `timestamp` без `date` — литерал ISO; прочие виды
  слота — `parseScalar` по первому виду слота. Печать: адрес — `fieldRefKey` (контракт — ключом, как `class`). Нормализация:
  `prop`/`field` объектом — ключ контракта → id (`reg.contracts`). `static.ts`, `dates.ts`, `field-ref.ts`,
  `queryRefsFromDoc` — по таблице обходчиков; пометка `// ОБХОДЧИК-Q: <имя>` — одна на строку перечня, над входной функцией
  этой строки (РП-3).
  Докблок `ast.ts` над типом адреса: почему объединение типов, а не новый ключ узла (Д-1). Новые файлы (`contract-value.ts` и
  тест) — `git add` сразу. Прогон шага 4 → PASS.

- [ ] **Шаг 6: фикстура таблицы случаев.** `apps/server/test/when-world.ts`: `seedWhenWorld(graph, {today, timeZone}):
  Promise<WhenWorld>` (`WhenWorld` — id записей по именам таблицы; даты таблицы — СМЕЩЕНИЯМИ от `today`: задача 9 зовёт её с
  настоящим «сегодня» владельца) —
  записи через исполнитель (`execute`, механизм `user`, `source: 'ui'`), а не вставкой строк: так правило `task_completed_at`
  ставит и снимает `done`. Два аспекта владельца заводятся `seedCustomAspect` (образец `test/fixtures/gate-aspects.ts:141-171`):
  `user/when-plain` (свойство `user/wp_at` timestamp; `implements` — `orbis/when` `{moment: user/wp_at}` и `orbis/completable`
  как у `gate-plain`) и `user/when-done` (свойства `user/wd_status` select `open|done`, `user/wd_done` date; `implements` —
  `orbis/when` `{done: user/wd_done}`, `orbis/completable` со статусом `wd_status`: `done` → класс `done`). В этой задаче
  `today = 2026-07-15` (среда), пояс `Asia/Novosibirsk`; времена — местные этого пояса (в базу — ISO со смещением пояса).

| Имя | Аспекты | Значения | Даты «когда» (§4.2) |
|---|---|---|---|
| `E1` | расписание | `start_at 07-17 09:00`, `end_at 07-17 10:30` | `{moment 07-17}` |
| `E2` | расписание | `start_at 07-15 00:00`, `all_day true` | `{moment 07-15}` |
| `T1` | задача | `due_date 07-18`, `planned` | `{deadline 07-18}` |
| `T2` | задача | `due_date 07-14`, `planned` | `{deadline 07-14}` |
| `T3` | задача | `due_date 07-14`, `done`, `completed_at 07-15 16:05` | `{done 07-15}` |
| `T4` | задача | `due_date 07-20`, `done`, `completed_at 07-14 10:00` | `{done 07-14}` |
| `T5` | задача | `due_date 07-16`, `cancelled` | ∅ (закрыта без времени закрытия) |
| `T6` | задача | срока нет, `planned` | ∅ |
| `T7` | задача | `due_date 07-16`; `done`, затем обратно `planned` (правило снимает `done`) | `{deadline 07-16}` |
| `T8` | расписание + задача | `start_at 07-14 09:00`, `due_date 08-14`, `planned` | `{moment 07-14, deadline 08-14}` |
| `T9` | расписание + задача | `start_at 07-16 09:00`, `due_date 07-18`, `planned` | `{moment 07-16, deadline 07-18}` |
| `T10` | расписание + `user/when-plain` | `start_at 07-17 09:00`, `wp_at 07-19 12:00`, открыта | `{moment 07-17, moment 07-19}` |
| `T11a` | `user/when-done` | `wd_status done`, `wd_done 07-15` | `{done 07-15}` (дата-факт) |
| `T11b` | `user/when-done` | `wd_status done`, `wd_done` пусто | ∅ |
| `N1` | заметка | — | ∅ |
| `F1` | финансовая запись (Финансы включены `enableFinanceForTest`) | `amount 1500`, `currency USD` | — |

  Правило `task_completed_at` ставит `completed_at = updated_at`, то есть реальное «сейчас», а фикстура живёт в
  `2026-07-15`: у `T3`, `T4` статус `done` ставится обычной пачкой, затем `completed_at` переписывается ВТОРОЙ пачкой (механизм
  `user`): правило срабатывает только на входе в класс «сделано», и повторная правка штампа при статусе `done` его не будит
  (докблок фикстуры объясняет почему). Статусы задач — варианты `orbis/task_status` (`planned`, `done`, `cancelled`); «открыта»
  у аспекта владельца `user/when-plain` — его вариант класса `active`. `T7` проходит правило по-настоящему
  (`done`, затем `planned` — снятие проверяет отдельный тест (а) шага 7).

- [ ] **Шаг 7: красные тесты сервера — таблица случаев С1в-1.** `apps/server/src/query/when.dataset.test.ts` (граф
  `await freshGraph()`, `seedWhenWorld`, контекст компиляции с фиксированными `today: '2026-07-15'`, `timeZone:
  'Asia/Novosibirsk'` по образцу `compile.dataset.test.ts`; исполнение SQL `compileQueryAst` под идентичностью владельца).
  Каждая строка — `test.each`: текст запроса → множество имён (порядок — только там, где сказано). Токены — только формой
  `=T` (края — задача 2); сравнения — литералами:

| Запрос | Ожидание |
|---|---|
| `orbis/when=today` | `E2, T3, T11a` |
| `orbis/when=overdue` | `T2, T4` (у `T8` дата впереди; сделанное вчера — истинно, §3.3) |
| `orbis/when=overdue, class=orbis/completable:open` | `T2` |
| `orbis/when=next_7d` | `E1, E2, T1, T3, T7, T9, T10, T11a` |
| `orbis/when=2026-07-17` | `E1, T10` |
| `orbis/when=2026-07-16..2026-07-18` | `E1, T1, T7, T9, T10` |
| дерево `{prop:{contract:'orbis/when'}, op:'in', value:['2026-07-16','2026-07-18']}` | `T1, T7, T9` |
| `orbis/when<2026-07-15` | `T2, T4, T8` |
| `orbis/when<=2026-07-15` | `E2, T2, T3, T4, T8, T11a` |
| `orbis/when>2026-07-22` | `T8` |
| `orbis/when>=2026-07-18` | `T1, T8, T9, T10` |
| `orbis/when>=2026-07-15, orbis/when<=2026-07-22` | `E1, E2, T1, T3, T7, T8, T9, T10, T11a` (`T8` — два сравнения, не интервал: 07-14 ≤ 22 и 08-14 ≥ 15) |
| то же + `sortBy=orbis/when:asc` | `T8` ПЕРВЫМ (ни одна его дата не удовлетворяет обоим — запасной ключ «хоть одному»: 07-14) |
| `orbis/when>=2026-07-16, sortBy=orbis/when:asc` | порядок `T7, T9, E1, T10, T1, T8` (ключ `T8` — 08-14, не 07-14; `E1`/`T10` — равные ключи: до добивки `id` задачи 3 порядок между ними не проверяется) |
| `!orbis/when=next_7d` | `T2, T4, T5, T6, T8, T11b, N1, F1` (запись без дат проходит отрицание) |
| `orbis/when!=next_7d` | то же |
| `orbis/when>2026-07-22, !orbis/when=2026-07-15..2026-07-22` | `T8` («начал вчера, срок через месяц» — ровно в «Дальше») |
| `orbis/when=next_7d, sortBy=orbis/when:asc` | порядок по ключу: `E2`(07-15 00:00), `T11a`(07-15 00:00), `T3`(07-15 16:05), `T7`(07-16 00:00), `T9`(07-16 09:00), `E1`(07-17 09:00), `T10`(07-17 09:00), `T1`(07-18) — равные ключи по `id` (после задачи 3; здесь — сравнивать только разные ключи) |
| `orbis/when>2026-07-22, sortBy=orbis/when:asc` | `T8` с ключом `08-14` (ранняя из дат, удовлетворяющих условию) |
| `sortBy=orbis/when:asc, limit=50` (без условий) | записи без дат — в конце |
| `orbis/when.deadline=next_7d` | `T1, T4, T5, T7, T9` (адрес слота — сырые значения, правило значения не действует) |
| `orbis/when.done=today` | `T3, T11a` (`T11a` — привязка аспекта владельца, дата-факт) |
| `orbis/when.moment=2026-07-19` | `T10` (привязка аспекта владельца) |
| `orbis/when.moment=2026-07-17` | `E1, T10` (две привязки одного слота — хоть одна; строка одна) |
| `orbis/money-movement.amount>1000` | `F1`; то же при выключенных Финансах (маска `['finance']`) — `F1` (язык работает, §3.1) |
| `aspect=orbis/financial, display=tile, aggregate=sum:orbis/money-movement.amount` | `1500` (сумма числом; валюты — задача 3) |

  Отдельные тесты: (а) `T7` — перевод `done → planned` снимает `done`, запись возвращается на свои даты; (б) `T5` отменена —
  дат нет, ни в одной положительной форме; (в) `orbis/when.nope=today` в `entity.query` — `VALIDATION` `reason:'UNKNOWN_SLOT'`;
  (г) материализация: шаблон повтора расписания (`orbis/recurrence` weekly, `start_at` на прошлой неделе) и
  `entity.blocks` с блоком `orbis/when=next_7d, !class=orbis/recurrence:templates` → экземпляр этой недели создан и в ответе
  (окно от адреса значения: `start_at`, `due_date` ∩ триггеры); с `orbis/when.done=today` — окна нет (`completed_at` не
  триггер); (д) ранг у слота не-даты (РП-21): юнит-тест `slotValuesSql`/ключа сортировки — у слота с двумя привязками
  `COALESCE` идёт в порядке ранга аспектов (`bindingIndexOf`), не в порядке объявления. Прогон
  `cd $W/apps/server && bun test src/query/when.dataset.test.ts > $T/t1d.log 2>&1` → FAIL.

- [ ] **Шаг 8: компиляция.** `apps/server/src/query/contract-sql.ts` (создать и сразу `git add`; строка `// ОБХОДЧИК-Q:
  contract-sql` — над `addressCond`):
  - значения слота: для каждой привязки `b ∈ bindingIndexOf(reg).byContract(c)` со свойством `P = b.bind[slot]` —
    `CASE WHEN e.aspects @> ARRAY[<b.aspectId>] THEN <castedExpr(P)> END`; набор — `(VALUES (v1), (v2), …) AS sv(v)` с
    `sv.v IS NOT NULL`; условие — `EXISTS (SELECT 1 FROM <набор> WHERE <то же условие, что у свойства, над sv.v>)`
    (переиспользовать `scalarPropCond`/`dateExpr` с выражением значения вместо `props->>'id'` — вынести общий шаг «условие над
    выражением» из `propCond`, не копировать);
  - даты «когда» (`whenDatesSql`): строки `(slot, at, day)` по привязкам слотов с ролью; `at` — у `timestamp` —
    `(<значение>)::timestamptz`, у `date` — местная полночь `(<значение>::date)::timestamp AT TIME ZONE <tz>`; `day` —
    `(at AT TIME ZONE <tz>)::date`; фильтр правила (§3.2 п. 1–3):
```sql
WHERE w.at IS NOT NULL
  AND ( w.role = 'fact'
     OR ( w.role = 'plan'
          AND NOT (<есть значение у любого факт-слота на записи>)
          AND NOT COALESCE(<compileClassMembership(orbis/completable, closed)>, false) ) )
```
  - условие на значении: положительная форма — `EXISTS (SELECT 1 FROM <даты> d WHERE <форма над d.day>)`; `overdue` —
    `EXISTS (<даты>) AND NOT EXISTS (SELECT 1 FROM <даты> d WHERE d.day >= <today>)` (К-2); `ne` и `{not}` — прежний
    `negated(...)` над положительной формой (запись без дат проходит);
  - ключ (`addressSortKey`): положительные условия блока на ТОМ ЖЕ адресе — дети верхнего `and` (или сам фильтр) вида
    `{prop: адрес}` без `not`; ключ = `COALESCE((SELECT min(d.at) FROM <даты> d WHERE <все условия над d>), (SELECT min(d.at)
    … WHERE <хоть одно>), (SELECT min(d.at) FROM <даты> d))` — последний член только при отсутствии условий; у адреса слота с
    датой — то же над `sv`; у прочих слотов — `COALESCE(v1, v2, …)` в порядке ранга привязок; `NULLS LAST` как сейчас;
  - `compile-ast.ts`: `propCond` — ветка `isContractAddress(node.prop)` → `addressCond`; `sortItem` → `addressSortKey`;
    `numericRef` — адрес слота с числовым видом → `COALESCE(v1, v2, …)::numeric`, значение — отказ `TYPE`; `compileLatestAst` —
    `field`-адрес так же; `walkNodes`/`decidesArchived`/`namesServiceAspect` — адрес пропускают (не свойство);
  - окно материализации: `materializationWindow(ast, today, params, reg)` — `visitProp` для адреса берёт свойства, привязанные
    к слоту (значение — к слотам с ролью), ∩ `trigger_properties`; форма окна — как у свойства; оба вызывающих передают
    `cctx.reg`, тесты `materialize.test.ts` — новый аргумент.
  Прогон шага 7 → PASS.

- [ ] **Шаг 9: гейт §С8-18 языком «когда» и перф.** `test/gate-c8-18.test.ts`: потребитель 2 — вместо `agenda.list` пачка
  `entity.blocks` из двух блоков `orbis/when=next_7d, !class=orbis/recurrence:templates` и `orbis/when=overdue,
  class=orbis/completable:open` (`thisEntityId` не нужен): `world.windowId` — в первом, `world.overdueId` — во втором,
  `world.ambiguousId` (два `moment`) — ровно одной строкой; заголовок теста — «дела gate-plain попадают в Повестку языком
  «когда» (§С8-18, потребитель 2)»; шапка файла — строка «6 — Agenda» → «6 — Повестка языком «когда» (1в)». `perf/graph.test.ts`:
  случаи `when:value-next_7d` (`orbis/when=next_7d, sortBy=orbis/when:asc, limit=200`) и `when:slot-deadline`
  (`orbis/when.deadline=overdue`) на объёме набора; порог — p95 первого прогона × 3, округлённый вверх до 10 мс, записать в
  `BUDGETS_MS` с комментарием «калибровка 1в, задача 1». Прогон `cd $W/apps/server && bun test test/gate-c8-18.test.ts >
  $T/t1e.log 2>&1` → PASS.

- [ ] **Шаг 10: web и проба компилируются.** `bun run typecheck` покажет места, читающие `prop`/`field` строкой; правка — по
  таблице обходчиков (`web-builder-model`: адрес — строки формы нет, узел сохраняется при печати; `QueryBuilderForm` — ключ
  `fieldRefKey`); `scripts/probe-p3/runner.ts` — адрес → отказ «форма вне пробы». Тест
  `apps/web/src/features/query-builder/model.test.ts` (или ближайший): форма над `orbis/when=next_7d, aspect=orbis/task` —
  строка аспекта есть, узел адреса после печати на месте.

- [ ] **Шаг 11: пересев, эталоны и мутации (С1в-11).** `cd $W && bun run db:prepare > $T/t1prep.log 2>&1` (контракт `orbis/when`,
  привязки двух аспектов и схема значения `orbis/progress_source` — «расходится» до пересева). Эталон тулов
  `apps/server/test/golden/tool-registry.json` — пересдать вручную (JSON Schema `prop`/`field` у `entity_query`, `attach_*` с
  `orbis/progress_source`, `property_create/update`; правило файла `registry-golden.test.ts:11-19`). Мутации (каждая → красный → откат): (а) в `whenDatesSql` убрать «факт
  первым» (планы всегда) → красные `orbis/when=today` (`T3` пропал) и `overdue` (`T3` лишний); (б) убрать «закрытое без
  времени закрытия — без дат» → красный `T5`/`T11b`; (в) квантор «хоть одна» → «все» (`NOT EXISTS … NOT`) → красный
  `orbis/when=2026-07-17` (`T10`); (г) у `overdue` снять «и хотя бы одна есть» → красный: `T5, T6, N1` в `overdue`
  («пустое множество = истина»); (д) ключ сортировки без условий блока (самая ранняя дата вообще) → красный порядок строки
  `orbis/when>=2026-07-16, sortBy…` (`T8` с ключом 07-14 встаёт первым); (д′) `overdue` как «хоть одна дата позади»
  (`EXISTS (d.day < today)`) → красный `orbis/when=overdue` (лишний `T8`); (е) в
  `scripts/query-walkers.test.ts` — удалить пометку у `normalize` → красный сторож; (ж) в разборе поменять порядок
  «свойство → адрес» → красный `orbis/recurrence` (свойство пропало).

- [ ] **Шаг 12: полный прогон и коммит.**
```
cd $W && git add packages/shared/src/registry/contract-value.ts packages/shared/src/registry/contract-value.test.ts apps/server/src/query/contract-sql.ts apps/server/test/when-world.ts apps/server/src/query/when.dataset.test.ts scripts/query-walkers.test.ts
cd $W && bun run test > $T/t1-full.log 2>&1; echo EXIT=$? && bun run lint > $T/t1-lint.log 2>&1; echo EXIT=$? && bun run typecheck > $T/t1-tsc.log 2>&1; echo EXIT=$?
cd $W && bun scripts/check-legacy-form.ts --gate; echo EXIT=$?
cd $W && git commit -m "feat(query): язык контрактов — адрес слота и значение «когда» в каноне

Контракт «когда» получил слоты «завершено», «конец», «весь день» и роли «план/факт»; значение
«даты» — закрытое правило (факт первым, закрытое без времени закрытия — вне времени). Адрес
слота и значение контракта — поле запроса объединением типов: разбор, печать, нормализация,
компиляция по привязкам аспектов записи, окно материализации. Таблица случаев С1в-1, гейт
§С8-18 языком «когда», перечень обходчиков дерева со сторожем.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- packages/shared/src apps/server/src apps/server/test apps/server/perf apps/web/src scripts
```

### Задача 2: Токены дат и два края — четыре новых токена, одно правило краёв, словарь подписей, перепись форм

**Зачем:** спека §3.4 (новые токены, таблица краёв, отказ несуществующего края при разборе и при компиляции деревьев мимо
разбора, словарь подписей в shared, окно материализации от новых токенов), С1в-3, С1в-11 («два края»), РП-17, РП-19, В-1
(начало недели — настройка владельца). Правило одного якоря (`compile-ast.ts:462-466`, `materialize.ts:171-172`) снимается.

**Файлы:**
- shared, создать: `packages/shared/src/query/tokens.ts` (+ `tokens.test.ts`).
- shared, изменить: `query/ast.ts:38` (`QUERY_DATE_TOKENS` — новые В КОНЕЦ: `'this_week', 'next_14d', 'this_month',
  'last_month'`), `query/parse-ast.ts` (`parseBound :645-659`, `parsePropNode :906-999` — отказ `TOKEN_EDGE`; коды += `TOKEN_EDGE`),
  `query/dates.ts:21-24` (устаревший комментарий «токены периодов … 1б» → «с 1в — восемь токенов, словарь `tokens.ts`»),
  `doc/placement.ts:207` (`DATE_HINT` — перечень из словаря), `query/index.ts`.
- server, изменить: `apps/server/src/query/context.ts:42-71` (`CompileCtx.weekStart` — константа `'monday'` по букве §3.4, В-1),
  `query/compile-ast.ts:90-99, 437-466, 569-606` (`tokenCond`, `boundCond`, `rangeCond` через `tokenEdges`; `tokenAnchor`
  удалить), `apps/server/src/query/contract-sql.ts` (те же формы над датами «когда» и адресом слота),
  `recurring/materialize.ts:158-179` (`tokenWindow`, `boundDay` через `tokenEdges`; `tokenAnchor` удалить).
- server, тесты: `query/compile-ast.test.ts:526-545` (пины старого якоря — переписать на края), `recurring/materialize.test.ts:826-860`,
  новый `query/tokens.dataset.test.ts`; эталон SQL канона `test/golden/query-sql.json` — случаи с токенами (`=overdue`
  `:137-139, :468-470, :830-839, :1170-1172`; `=after_7d` `:565-598`; `range {to: today}` `:975-978`) пересдаются РУКАМИ по
  правилу файла (`compile.golden.test.ts:3-7`): смысл тот же, текст SQL — от краёв; эталон тулов `test/golden/tool-registry.json` (перечень токенов — 15 вхождений,
  Ф-1в-21 п. 10), строка реестра `orbis/progress_source` (схема значения встраивает `TOKEN.enum` — пересев).
- web: `apps/web/src/features/query-builder/FieldRows.tsx:40-46` (`DATE_TOKEN_LABELS` удалить → `QUERY_DATE_TOKEN_LABELS`), его тест.
- scripts: `scripts/query-walkers.test.ts` (строка `token-boundary`).

**Интерфейсы:**
- Consumes: `QueryContractAddress`, `addressCond` (задача 1).
- Produces (для задач 4, 5, 6, 7, 13):
```ts
// packages/shared/src/query/tokens.ts (сабпат @orbis/shared/query)
export type WeekStart = 'monday' | 'sunday';
export const QUERY_DATE_TOKEN_LABELS: Readonly<Record<QueryDateToken, string>>;
// today «сегодня», overdue «просрочено», next_7d «7 дней», next_14d «14 дней», after_7d «позже 7 дней»,
// this_week «эта неделя», this_month «этот месяц», last_month «прошлый месяц» (спека §3.4)
export interface TokenEdges { start: string | null; end: string | null } // YYYY-MM-DD включительно; null — края нет
export function tokenEdges(token: QueryDateToken, today: string, weekStart: WeekStart): TokenEdges;
/** Какой край читает форма: `=` — оба; `<` — start; `>=` (from) — start; `>` — end; `<=` (to) — end. */
export type TokenForm = 'eq' | 'lt' | 'gte' | 'gt' | 'lte';
export function edgeOf(form: TokenForm): 'both' | 'start' | 'end';
export const TOKEN_EDGE_MESSAGE: (token: QueryDateToken, form: TokenForm) => string; // «у токена overdue нет начала — …»
/** Перепись (задача 13): формы с токеном-границей в дереве — смысл меняется или станет отказом. */
export interface TokenBoundaryForm { token: QueryDateToken; form: Exclude<TokenForm, 'eq'>; verdict: 'changed' | 'refused' | 'same' }
export function tokenBoundaryForms(ast: unknown): TokenBoundaryForm[]; // чистый JSON-обход, реестр не нужен
// apps/server/src/query/compile-ast.ts — CompileCtx += weekStart: WeekStart
```

- [ ] **Шаг 1: красные тесты.** (а) `tokens.test.ts`: таблица спеки §3.4 для `today = 2026-07-15` (среда): `today` [07-15;
  07-15], `overdue` [—; 07-14], `next_7d` [07-15; 07-22], `next_14d` [07-15; 07-29], `after_7d` [07-23; —], `this_week` при
  `monday` [07-13; 07-19], при `sunday` [07-12; 07-18], `this_month` [07-01; 07-31], `last_month` [06-01; 06-30]; края
  месяца (`today = 2026-03-31` → `last_month` [02-01; 02-28]; `2028-02-29` → `this_month` [02-01; 02-29]; `2026-01-10` →
  `last_month` [2025-12-01; 12-31]); неделя на стыке месяцев; подписи — ровно спеки; `tokenBoundaryForms` — таблица
  `recon-plan-core.md` §12 («смысл меняют»: `>overdue`, `<=overdue`, `<next_7d`, `>=next_7d`, `<after_7d`, `>=after_7d`;
  «отказ»: `<overdue`, `>=overdue`, `>after_7d`, `<=after_7d`; `=`/`!=` — не граница), плюс `range` с токеном в `from`/`to`;
  (б) `parse-ast.test.ts`: `orbis/due_date<overdue`, `orbis/due_date>=overdue`, `orbis/due_date>after_7d`, `orbis/due_date<=after_7d`,
  `orbis/due_date=overdue..today` (`from` без начала) → `TOKEN_EDGE` с позицией и подсказкой; четыре новых токена
  разбираются у `date`, `timestamp`, у адреса «когда»; (в) новый `apps/server/src/query/tokens.dataset.test.ts` — записи задачи с
  `due_date` на днях `06-30, 07-01, 07-12, 07-13, 07-14, 07-15, 07-19, 07-20, 07-22, 07-23, 07-29, 07-30, 07-31, 08-01`
  (`today 2026-07-15`, пояс `Asia/Novosibirsk`, `weekStart = 'monday'`): для каждого из восьми токенов формы `=`, `<`, `<=`,
  `>`, `>=` (кроме отказных) дают ровно множества таблицы краёв; `this_week` → [07-13; 07-19] (воскресное начало проверяет
  только юнит (а) — В-1); те же формы над `orbis/when` (адрес значения) — на фикстуре задачи 1 (`seedWhenWorld`
  с `today 2026-07-15`): `orbis/when=this_week` → `E1, E2, T1, T2, T3, T4, T7, T8, T9, T10, T11a` (при `monday`); (г) компиляция
  деревьев мимо разбора: `compileQueryAst({filter:{prop:'orbis/due_date', op:'lt', value:{token:'overdue'}}}, cctx)` →
  `ExecError('VALIDATION')` `reason:'TOKEN_EDGE'`; то же — `entity.query({ast})`, тул `entity_query` с `ast`, `over` действия
  (`action_set` — отказ записи), значение `orbis/progress_source` цели (прогресс — `invalid_query`, не падение); дерево в
  `body_doc` сервер не компилирует — `bindQueryBlocks` печатает его в текст, и отказ даёт разбор: тест «атрибут `ast` с
  `{op:'lt', value:{token:'overdue'}}` → блок пачки — отказ `TOKEN_EDGE`»; формы `orbis/due_date=today..after_7d` (`to=after_7d`)
  и `orbis/when<overdue` (значение «когда») — отказ и при разборе, и при компиляции; (д) материализация: `orbis/start_at=next_14d` открывает окно [today; today+14] (экземпляр на `today+12` создан);
  `orbis/start_at=this_week` — [понедельник; воскресенье] ∩ ретро-пол; `orbis/start_at<next_7d` — окна «до сегодня» (пусто);
  (е) web `FieldRows.test.tsx` (или ближайший): выбор токена в строке даты предлагает восемь подписей словаря. Прогон
  `cd $W/packages/shared && bun test src/query/ > $T/t2a.log 2>&1` → FAIL;
  `cd $W/apps/server && bun test src/query/tokens.dataset.test.ts src/query/compile-ast.test.ts src/recurring/materialize.test.ts > $T/t2b.log 2>&1` → FAIL.

- [ ] **Шаг 2: реализация.** `tokens.ts` — по «Интерфейсам» (строка `// ОБХОДЧИК-Q: token-boundary` над `tokenBoundaryForms`);
  даты — строковая арифметика по UTC-полуночи (`Date.UTC`), без пояса (пояс уже учтён в `today`). Компилятор: `=T` —
  `BETWEEN start AND end` (открытый край — одностороннее сравнение), `<T` — `< start`, `>=T` — `>= start`, `>T` — `> end`,
  `<=T` — `<= end`; нужного края нет — `ExecError('VALIDATION', TOKEN_EDGE_MESSAGE(...), {reason:'TOKEN_EDGE'})`; то же в
  `contract-sql.ts` над `d.day`/`sv.v`. `queryContext` ставит `weekStart: 'monday'` с докблоком «§3.4 спеки 1в —
  константа; настройка `weekStartDay` владельца — вопрос В-1». Окно материализации: `=T` — `[start ?? today; end ?? горизонт]` (у `overdue` — прежнее
  `[today; today]`, пин `materialize.test.ts`), `>T` — `[end+1; горизонт]`, `<T` — `[today; start−1]`, `range` — края по
  `edgeOf`. Web — словарь вместо локального массива. Пересев (`db:prepare`: строка `orbis/progress_source` —
  «расходится»), эталон тулов — пересдать вручную (`registry-golden.test.ts:11-19`), эталон SQL — случаи с токенами (список
  «Файлы»). Новые файлы — `git add` сразу. Прогон шага 1 → PASS.

- [ ] **Шаг 3: мутации.** (а) вернуть якорь (`<next_7d` → `< today+7`) → красный (в); (б) `tokenEdges` игнорирует
  `weekStart` → красный (а) для `sunday`; (в) снять отказ `TOKEN_EDGE` в компиляторе → красный (г); (г) в
  `tokenBoundaryForms` пропустить `range` → красный (а). Откатить.

- [ ] **Шаг 4: полный прогон и коммит.**
```
cd $W && git add packages/shared/src/query/tokens.ts packages/shared/src/query/tokens.test.ts apps/server/src/query/tokens.dataset.test.ts
cd $W && bun run test > $T/t2-full.log 2>&1; echo EXIT=$? && bun run lint > $T/t2-lint.log 2>&1; echo EXIT=$? && bun run typecheck > $T/t2-tsc.log 2>&1; echo EXIT=$?
cd $W && git commit -m "feat(query): четыре новых токена дат и одно правило двух краёв

this_week (с начала недели владельца), next_14d, this_month, last_month; у всех восьми токенов
начало и конец по таблице спеки §3.4, несуществующий край — отказ и при разборе, и при
компиляции дерева. Словарь подписей — в shared, окно материализации — от краёв.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- packages/shared/src apps/server/src apps/server/test apps/web/src
```

### Задача 3: Устойчивый порядок, сумма по валютам, «последнее» по порядку блока, контракт клиента `0.5.0`, «кто ссылается»

**Зачем:** спека §3.5 (`id` — последний ключ, без `sortBy` — `id`), §3.6 (сумма по валютам, денежность по привязке),
§3.7 («последнее» — первая запись в порядке блока, с валютой; общий компилятор с прогрессом цели), §3.9 (тест
`parents_of=this via=ref`), §5.1 «Формат» (подъём версии контракта клиента), С1в-7, С1в-9, С1в-11 («сумма по валютам»),
РП-7, РП-8, РП-9, В-5. Закрывает 1а новое-12 и дефект `sum` (приложение А).

**Файлы:**
- shared: `packages/shared/src/contracts/blocks.ts:118-126` (`BlockResult` — `sum`, `latest`), `constants.ts:11`
  (`MIN_COMPATIBLE_CLIENT_VERSION = '0.5.0'`).
- server: `query/context.ts` (`ownerCurrency` той же выборкой настроек, запасной — как `defaultCurrencyOf`,
  `budget/binding.ts:31-37`), `query/compile-ast.ts` (`CompileCtx.ownerCurrency`; `compileOrderBy :890-896` — добивка `e.id`;
  `compileSumAst :941-953` — вариант по валютам; `compileLatestAst :961-964` — порядок блока и валюта), `routers/entity-blocks.ts`
  (`compileBlock :208-224`, `executePlan :233-272` — новые формы; литерал `CURRENCY_PROPERTY :39` снять), `goals/progress.ts:414-419`
  (`latest` с `sortBy`), `tools/dispatch.ts:1028-1098` (`user_query` `sum` — по валютам, В-5; карточка `aggregateCard` несёт
  НЕОБЯЗАТЕЛЬНОЕ поле `sums` рядом с прежним `value`: карточки хранятся в `chat_messages.metadata.cards`, журнал только
  дополняется — `db/schema.ts:237-244`, — и старые карточки без `sums` рисуются историей чата), web-тип карточки
  `features/chat/cards/types.ts:18-24`, `packages/shared/src/query/ast.ts:66-83` (докблок `QUERY_AGGREGATE_FNS` «одна правда о „последнем“» — «первая строка
  в порядке блока, без `sortBy` — по правке», спека §16), тесты: `query/compile-ast.test.ts:585-600` (пин «sum без валюты дословно» — остаётся для
  прогресса цели), `query/compile.golden.test.ts` + `test/golden/query-sql.json` (все 54 — руками), новый
  `query/money.dataset.test.ts`, `query/refs.dataset.test.ts` (§3.9), `router.test.ts:59-72` (версия клиента), `goals/progress.test.ts`.
- web: `app/version.ts:4` (`APP_VERSION = '0.5.0'`), `features/page/blocks/TileForm.tsx:16-35, 54-68`,
  `features/chat/cards/QueryResultCard.tsx:15-33` (сумма `user_query` — по валютам, тем же форматом, что плитка; общий
  форматтер сумм — в `lib/format`, не копия), пины
  `scripts/client-version.test.ts:36-37`, `apps/web/src/trpc.test.tsx:21-24`, `features/page/blocks/forms.test.tsx:198-222`,
  обвязка `test/harness.tsx:246-290`, `app/frame/frame-fixtures.ts:199-214`, `features/search/{useSearch.ts:32,SearchPanel.tsx:222}`
  (тип `BlockResult`).

**Интерфейсы:**
- Consumes: `bindingIndexOf(reg).byContract('orbis/money-movement')` (`bind.amount`, `bind.currency`); `fieldRefKey`,
  `isContractAddress`, `slotValuesSql` (задача 1).
- Produces:
```ts
// packages/shared/src/contracts/blocks.ts
export interface BlockSum { currency: string | null; sum: string; count: number } // currency null — не денежные строки
export type BlockResult =
  | { ok: true; kind: 'rows'; rows: Entity[]; more: number; closedIds: string[] }   // closedIds — задача 6 (здесь [] )
  | { ok: true; kind: 'count'; count: number }
  | { ok: true; kind: 'sum'; count: number; sums: BlockSum[] }   // порядок: валюта владельца, прочие по алфавиту, null последней
  | { ok: true; kind: 'latest'; value: string | null; currency: string | null }
  | { ok: true; kind: 'none' }
  | { ok: false; error: BlockError };
// apps/server/src/query/compile-ast.ts
export interface CompileCtx { /* … */ weekStart: WeekStart; ownerCurrency: string }
export function compileSumByCurrencyAst(ast: QueryAst, field: QueryFieldRef, cctx: CompileCtx): SQL; // строки (currency, sum, count)
export function moneyCurrencyExpr(field: QueryFieldRef, cctx: CompileCtx): SQL | null; // null — поле ни у кого не денежное
// карточка user_query (сервер и web-тип): aggregate: { op: 'count' | 'sum'; value: string; sums?: BlockSum[] }
//   value — число одной валюты (или без валюты); при нескольких — сумма первой по правилу провода; sums — только у новых карточек
```
  Поле `closedIds` в `rows` появляется здесь пустым массивом, чтобы провод менялся один раз под одной версией клиента;
  заполняет его задача 6.

- [ ] **Шаг 1: красные тесты.** (а) `router.test.ts`: клиент `0.4.0` → `CLIENT_OUTDATED` на `entity.blocks` и на
  `entity.get`, `0.5.0` — проходит (Фокус ревью п. 2); `scripts/client-version.test.ts` — пины `0.5.0`;
  (б) `compile.golden.test.ts`: каждый эталон SQL с `ORDER BY` кончается `, e.id ASC`; без `sortBy` — `ORDER BY e.id ASC`
  (эталоны `count` — без изменений); (в) новый `money.dataset.test.ts` (граф `await freshGraph()`, `enableFinanceForTest`,
  валюта владельца `RUB`): записи `M1` `amount 12000` без валюты, `M2` `amount 50` `USD`, `M3` `amount 20` `EUR`, `M4` `amount 5`
  `KZT`; аспект владельца `user/cal` со свойством `user/kcal` (decimal, не денежное) — запись `K1 300`; аспект владельца
  `user/pay` (реализует `orbis/money-movement` всеми обязательными слотами: `amount: user/pay_sum`, `direction:
  user/pay_dir` (select `out|in` с `value_map` → классы `outflow|inflow`), `category: user/pay_cat` (ref), `date: user/pay_date`,
  необязательный `currency: user/pay_cur`; проверка `REQUIRED_SLOT_UNBOUND` — `bindings.ts:161-169`) — запись `P1 700 USD`, и
  то же свойство суммы на записи БЕЗ аспекта `user/pay` (`P2 100`) — не денежное (привязка не стоит на записи); плитка
  `aspect=orbis/financial, display=tile, aggregate=sum:orbis/amount` → `sums = [{RUB, 12000, 1}, {EUR, 20, 1}, {KZT, 5, 1},
  {USD, 50, 1}]`; `sum:user/kcal` → `[{null, 300, 1}]`; `sum:user/pay_sum` → `[{USD, 700, 1}, {null, 100, 1}]`;
  `sum:orbis/money-movement.amount` по всем → суммы по валютам с `P1`; `latest:orbis/amount` c `sortBy=orbis/occurred_on:desc` →
  значение и валюта первой строки порядка (не последней правки); без `sortBy` — по `updated_at`; `latest` у не денежного —
  `currency: null`; `user_query` агента с `aggregate: 'sum', field: 'orbis/amount'` → карточка с `sums` по валютам (не одно
  число), `user_query` над `user/kcal` — одна сумма без валюты; (г) `goals/progress.test.ts`: цель с `progress_source {query: {…, sortBy:[{field:'orbis/occurred_on',
  dir:'desc'}]}, aggregate:'latest', field:'orbis/amount'}` — «последнее» по порядку, не по правке; (д) устойчивый порядок:
  три записи с равным `orbis/priority` и `sortBy=orbis/priority:desc` — порядок по `id` в трёх прогонах; запрос без `sortBy` с
  `limit=2` над пятью записями — всегда два наименьших `id`; (е) новый `refs.dataset.test.ts` (§3.9): запись `X`; `A`, `B` со
  ссылочным свойством на `X` (свойство владельца `ref` без цели — `seedCustomAspect`), `C` без ссылки; `entity.blocks` блок
  `parents_of=this via=ref` c `thisEntityId = X` → ровно `A, B`; (ж) web `QueryResultCard` (`features/chat/cards/cards.test.tsx`): карточка прежней формы `aggregate: {op:'sum', value}` без
  `sums` из истории рисуется числом без падения, новая — суммами по валютам; web `forms.test.tsx`: плитка — одна валюта «12 000 ₽»;
  две–три — «12 000 ₽ · 50 $» (разделитель ` · `, порядок провода); больше трёх — плашка `data-testid="qb-currencies"` «разные
  валюты: RUB, EUR, KZT, USD»; `null` среди валют — число без символа в той же строке; «последнее» денежное — с символом валюты.
  Прогон — `cd $W/apps/server && bun test src/router.test.ts src/query/ src/goals/progress.test.ts > $T/t3a.log 2>&1` → FAIL;
  `cd $W/apps/web && bun run test src/features/page/blocks/forms.test.tsx src/features/chat/cards/cards.test.tsx > $T/t3b.log 2>&1` → FAIL.

- [ ] **Шаг 2: реализация.** Порядок — `compileOrderBy` всегда возвращает `ORDER BY …, e.id ASC` (алиас — тот, что у
  `compileQueryAst`); эталон `query-sql.json` — пересдать РУКАМИ по правилу файла (`:3-7`), каждое изменение — дописанный
  ключ. Валюта: `moneyCurrencyExpr(field)` — для привязок «движения денег», чей `bind.amount` = свойство поля (у адреса слота
  `amount` — все привязки), в порядке ранга: `CASE WHEN e.aspects @> ARRAY['A'] THEN COALESCE(NULLIF(e.props->>'<bind.currency
  A>', ''), <ownerCurrency>) … ELSE NULL END`; нет таких привязок — `null`, сумма — прежний `compileSumAst`. `compileSumByCurrencyAst`:
  `SELECT <валюта> AS currency, sum(<значение>::numeric)::text AS sum, count(*)::int AS count … GROUP BY 1`; сортировка — в JS по
  правилу провода. `compileLatestAst`: при `ast.sortBy` — `ORDER BY <compileOrderBy(ast)> LIMIT 1` среди строк со значением,
  иначе прежнее `updated_at DESC, id DESC`; вторая колонка — валюта (`moneyCurrencyExpr` или `NULL`). Прогресс цели зовёт прежнюю
  сумму одним числом (В-5; докблок у `compileSumAst`: «плитка и `user_query` — по валютам, `compileSumByCurrencyAst`»). Web:
  `TileForm` — по «Интерфейсам»; символы — `formatMoneyWithCurrency` (`lib/format`); строка сумм «12 000 ₽ · 50 $» — одна функция `formatSums(sums)` в
  `lib/format` для плитки и карточки `user_query`. `user_query`: `compileSumByCurrencyAst` вместо `compileSumAst`, ответ модели
  перечисляет суммы по валютам; прогресс цели — прежняя сумма одним числом (В-5). Версия клиента — две константы и пины.
  Локальный замер веса (РП-22): сборка и `check-lazy-chunks` — командами задачи 5, шаг 2.
  §3.9 — если (е) красный, код НЕ чинится (спека §3.9): тест переписывается на наблюдаемое поведение с докблоком «форма не
  работает: …, вход среза Бюджета», факт — в `progress.md` (его забирает `handoff-budget.md`, задача 14). Прогон шага 1 → PASS.

- [ ] **Шаг 3: мутации.** (а) в `compileSumByCurrencyAst` убрать `GROUP BY` валюты → красный (в); (б) запись без валюты —
  без `COALESCE` к валюте владельца → красный (`M1` пропал из `RUB`); (в) денежность по свойству без проверки аспекта на записи
  → красный (`P2` стал `USD`); (г) `compileLatestAst` игнорирует `sortBy` → красные (в) и (г); (д) снять добивку `id` →
  красный (д); (е) `QueryResultCard` читает только `sums` → красный (ж) (старая карточка). Откатить.

- [ ] **Шаг 4: полный прогон и коммит.**
```
cd $W && git add apps/server/src/query/money.dataset.test.ts apps/server/src/query/refs.dataset.test.ts
cd $W && bun run test > $T/t3-full.log 2>&1; echo EXIT=$? && bun run lint > $T/t3-lint.log 2>&1; echo EXIT=$? && bun run typecheck > $T/t3-tsc.log 2>&1; echo EXIT=$?
cd $W && git commit -m "feat(query): устойчивый порядок, сумма по валютам, «последнее» по порядку блока; клиент 0.5.0

id — последний ключ сортировки всех выборок канона; плитка суммы делит валюты по привязке
«движения денег» (нет валюты — валюта владельца); «последнее» — первая строка порядка блока с
валютой, и у прогресса цели. Контракт клиента поднят один раз на срез (R-12 1б).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- packages/shared/src apps/server/src apps/server/test apps/web/src scripts
```

### Задача 4: Параметр страницы — грамматика `{{param}}`, `$`-ссылка в каноне, схема страниц, подстановка на сервере, бейдж

**Зачем:** спека §5.1 (объявление и ключи, ссылка `$<имя>`, подстановка и проверка на сервере, бейдж по умолчаниям, место —
страница и шаблон, формат — новый узел документа во всех копиях правил, дифф Ш1 — единицей), §3.8 (`$` — только в блоках
страниц и шаблонов, отказ с подсказкой везде ещё), §10 (счёт примет `grammar-copies`), С1в-4 (серверная часть), С1в-8 (`$` в
`entity_query` — отказ), РП-5, РП-6, Д-3, Д-10, М-19 остатков 1б (бейдж — первый блок данных, `{{param}}` блоком данных не
является).

**Файлы:**
- shared, создать: `packages/shared/src/query/page-only.ts` (+ тест), `packages/shared/src/doc/nodes/param-block.ts`.
- shared, изменить: `doc/page-grammar.ts` (`PageNode` += `param`; `PARAM_RE`; разбор аргументов; `PARAM_NAME_RE`),
  `doc/placement.ts` (`PlacedBlock` += `'param'`, строка `MATRIX` `param: {note:false, page:true, template:true}`, `placedBlockOf`,
  `bodyIssues` — второй `{{param}}` с тем же именем → `SECOND_BLOCK`; `queryIssue :286-324` — разбор с местом по роду тела:
  `page`/`template` → `'page'`, пометка `placement-issue`), `doc/{schema,convert,manager,diff,types,index}.ts`
  (узел `paramBlock` — образец `hostBlock` 1б: `schema.ts:13,68-69`, `convert.ts:425-429, 539`, `manager.ts:46`,
  `diff.ts:195-204, 268-278`, `types.ts:49`), `doc/bind-query.ts:49-99` (дерево — `pageQueryAstSchema`, текст — место `page`),
  `query/ast.ts` (`QueryParamValue`, `QueryBound` += он; `queryAstSchema` — отказ `PAGE_ONLY` уточнением; `pageQueryAstSchema`),
  `query/parse-ast.ts` (опция места; `$<имя>` в `parseBound`; код `PAGE_ONLY`), `query/print.ts:48-74, 153-158` (`$имя`;
  `needsQuote` — литерал с ведущим `$`), `query/static.ts`, `query/dates.ts`, `query/normalize.ts` (пометки обходчиков),
  `contracts/blocks.ts:33-45` (`params` элемента).
- server, создать: `apps/server/src/query/params.ts` (+ `params.test.ts`).
- server, изменить: `routers/entity-blocks.ts:90-118` (`prepareQuery`: место `page` → `substituteParams` → окно и компиляция),
  `:136-200` (`prepareBadges`: умолчания `{{param}}` тела), `recurring/materialize.ts` (дерево с `{param}` — ошибка
  программиста, не тихий «сегодня»), `db/census-v3.ts` (узел страницы `param` — в счёте видов), тесты: `routers/entity-blocks.test.ts`,
  `tools/dispatch.test.ts` (отказ `$` в `entity_query`), `registry/ops.test.ts` (отказ в `scope`/`ref.target`),
  `registry/actions.test.ts` (отказ в `over`), `executor/props.test.ts` или `registry/validate-props.test.ts` (отказ в
  `orbis/progress_source`), `routers/entity.test.ts` (отказ в `entity.query({ast})`).
- web (только чтобы собралось и не потеряло узел; вид рисует задача 5): `features/page/Renderer.tsx:305-355` (вид `param` —
  докблок «переключатель рисует задача 5»: до неё — ничего, блоки с `$` показывают отказ сервера), `features/entity-editor/{extensions,strip-ids}.ts`
  (узел `paramBlock` в `EDITOR_EXTENSIONS`, умолчания атрибутов), `EditorShell.tsx:187-237` (первый кадр — текст маркера),
  `features/page/render-plan.ts`.
- scripts: `scripts/grammar-copies.test.ts` (счёт примет: `{{param:`), `scripts/query-walkers.test.ts` (строки `page-only`,
  `substitute-params`, `bind-query`, `placement-issue`).

**Интерфейсы:**
- Consumes: `QUERY_DATE_TOKENS`, `QUERY_DATE_TOKEN_LABELS` (задача 2); `QueryFieldRef` (задача 1).
- Produces (для задач 5, 6, 9, 11):
```ts
// packages/shared/src/doc/page-grammar.ts
export const PARAM_NAME_RE = /^[A-Za-z0-9_]+$/;
export const PARAM_TYPES = ['period'] as const;              // в 1в — один тип (§5.1, §14)
export interface PageParamDecl {
  name: string; type: 'period'; default: QueryDateToken; options: readonly QueryDateToken[]; title: string | null;
}
// PageNode += { kind: 'param'; raw: string; decl: PageParamDecl | null; problem: string | null }
//   problem — «ошибка блока параметра» (§5.1): неверный default, нет type, 0 или > 8 вариантов, чужой токен, плохое имя
export function paramDeclsOf(nodes: readonly PageNode[]): ReadonlyMap<string, PageParamDecl>; // обход в глубину, первое имя выигрывает
// packages/shared/src/query/ast.ts
export interface QueryParamValue { param: string }           // `$<имя>` на месте значения-границы
// QueryBound = QueryScalar | QueryTokenValue | QueryParamValue
export const PAGE_ONLY_HINT = '$-ссылка и group работают только в блоках страниц и шаблонов';
export const queryAstSchema: z.ZodType<QueryAst, z.ZodTypeDef, unknown>;     // `{param}` и `group` — отказ с PAGE_ONLY_HINT
export const pageQueryAstSchema: z.ZodType<QueryAst, z.ZodTypeDef, unknown>; // то же без отказа
// packages/shared/src/query/parse-ast.ts
export interface ParseOptions { place?: 'page' }              // нет места — `$` и `group` отказ PAGE_ONLY
export function parseQueryAst(text: string, reg: ParseRegistry, opts?: ParseOptions): ParseResult;
// packages/shared/src/query/page-only.ts
export function pageOnlyFeatureIn(ast: unknown): 'param' | 'group' | null;
export function paramNamesIn(ast: unknown): readonly string[];  // имена `$` в дереве — для входа пачки (задача 5)
// packages/shared/src/contracts/blocks.ts — элемент пачки:
//   params?: Record<string, string>   // имя → токен; ≤ 16 ключей; значение проверяет сервер ПО БЛОКУ (плохое — отказ блока, не пачки)
// apps/server/src/query/params.ts
export function substituteParams(ast: QueryAst, params: Readonly<Record<string, string>>): QueryAst;
//   нет значения — ExecError('VALIDATION', 'параметр «x» не объявлен на странице', {reason:'UNKNOWN_PARAM', name});
//   значение не токен даты — ExecError('VALIDATION', …, {reason:'PARAM_VALUE', name})
```
  Канон маркера (печать и эталон): `{{param: <имя>, type=period, default=<токен>, options=<т1>|<т2>…, title=<подпись>}}` —
  ключи в этом порядке, `title` — по правилу кавычек текста запроса (`quoteQueryValue`), без `title` — ключа нет.

- [ ] **Шаг 1: красные тесты.** (а) `page-grammar.test.ts`: `{{param: period, type=period, default=next_7d,
  options=next_7d|next_14d, title="Горизонт"}}` → узел `param` с `decl`; `problem`: `default=today` вне `options` («умолчание
  — один из вариантов»), без `default` («умолчание обязательно»), без `options` (0 вариантов), без `type`, `type=month`, девять
  вариантов, `options=soon`, имя `пери-од`; незакрытый `{{param:` без
  `}}` — текст; (б) `placement.test.ts`: `param` в заметке — `BLOCK_MISPLACED` с `MISPLACED_HINT`, на странице и в шаблоне — нет;
  два `{{param: period…}}` — второй `SECOND_BLOCK`; `{{param: a…}}` и `{{param: b…}}` — без проблем; `bodyIssues` страницы с
  блоком `{{query:orbis/due_date=$period, …}}` и литералом даты в другом блоке — `ABSOLUTE_DATE` только у второго, у первого —
  ни `QUERY_INVALID`, ни `PAGE_ONLY`; (в) `convert.test.ts`,
  `manager.test.ts`, `diff.test.ts`: тело ↔ документ ↔ тело без потерь (атом `paramBlock`, текст маркера дословно); дифф Ш1 —
  изменение `default` показывается одной единицей «параметр», не построчно; (г) `parse-ast.test.ts`: `orbis/when=$period` с
  `{place:'page'}` → `{param:'period'}`; без места → `PAGE_ONLY` с `PAGE_ONLY_HINT` и позицией; `orbis/title=$x` (текст) → `TYPE`
  («параметр типа period — только у дат»); литерал `orbis/title="$x"` → строка `$x`, печать → `orbis/title="$x"` (обратный
  разбор — литерал); (д) `ast.test.ts`: `queryAstSchema` на дереве с `{param}` → отказ с `PAGE_ONLY_HINT`, `pageQueryAstSchema`
  — принят; JSON Schema тула `{param}` не допускает; (е) `page-only.test.ts`: `pageOnlyFeatureIn` находит `{param}` в `range`,
  в `not`, в `or`; `paramNamesIn` — множество имён; (ж) `params.test.ts`: подстановка в `eq`/`gt`/`range.from`/`range.to`; нет
  значения — `UNKNOWN_PARAM`; `period: 'soon'` — `PARAM_VALUE`; дерево без `$` возвращается тем же объектом; (з)
  `entity-blocks.test.ts` (граф `await freshGraph()`): два блока с `$period` и одним `params: {period: 'next_14d'}` — одна
  пачка, оба посчитаны от `next_14d`; блок с `$period` без `params` → отказ блока `UNKNOWN_PARAM`, соседние блоки живы; бейдж
  страницы, чей ПЕРВЫЙ блок данных `orbis/due_date=$period` и тело `{{param: period, …, default=next_7d…}}`, считает `count` по
  `next_7d` (Фокус ревью п. 3); тело с `problem` у параметра → бейдж — отказ; `{{param}}` ПЕРЕД первым блоком данных бейджу не
  мешает; (и) отказ `$` вне страниц: `entity_query` текстом и деревом, `entity.query({ast})`, `orbis/progress_source`,
  `action_set` с `over`, `property_update` со `scope` и `ref.target` — у каждого структурный отказ с подсказкой (не 500);
  (к) `grammar-copies.test.ts`, `query-walkers.test.ts` — новые пины. Прогон
  `cd $W/packages/shared && bun test src/doc/ src/query/ > $T/t4a.log 2>&1` → FAIL;
  `cd $W/apps/server && bun test src/query/params.test.ts src/routers/entity-blocks.test.ts > $T/t4b.log 2>&1` → FAIL.

- [ ] **Шаг 2: грамматика и канон (shared).** Маркер — одна строка по образцу `CARD_RE`; разбор аргументов — запятая вне
  кавычек, первый аргумент — имя, прочие `ключ=значение` (кавычки `title` — теми же правилами, что у текста запроса;
  функция разбора кавычек берётся у `query/parse-ast.ts`, если она экспортируется, иначе переносится в общий модуль — вторая
  копия правил кавычек запрещена). Узел документа — атом `paramBlock {text}` (образец `hostBlock`). `queryAstSchema` =
  структурная схема + `superRefine`: `pageOnlyFeatureIn(ast) !== null` → issue `PAGE_ONLY_HINT`; `pageQueryAstSchema` — без
  уточнения. Разбор: опция места прокидывается до `parseBound`; значение `$<имя>` (`PARAM_NAME_RE`, без кавычек) — только
  где разрешён токен. Пометки обходчиков: `page-only`, `bind-query`, `placement-issue`, `static` (отказ `{param}`), `absolute-date` (не
  литерал). Докблок `bindQueryBlocks`: рода тела функция не знает — дерево с `$`/`group` осядет и в `body_doc` заметки; отказ в
  заметке держат плашка места и web (задача 5), сервер `entity.blocks` вернёт отказ блока `UNKNOWN_PARAM` (значений нет).
  `queryIssue`: блок страницы с `$`/`group` — без `QUERY_INVALID`, правило `ABSOLUTE_DATE` на нём работает (тест в (б)).
  Новые файлы — `git add` сразу. Прогон шага 1 (а)–(е), (к) → PASS.

- [ ] **Шаг 3: сервер.** `params.ts` (пометка `substitute-params`) — по «Интерфейсам»; `prepareQuery`: разбор
  `parseQueryText(text, reg, {place: 'page'})` → `substituteParams(ast, item.params ?? {})` → окно → компиляция (отказ — как
  прочие отказы блока, `compileFailure`); `prepareBadges`: `paramDeclsOf(parsePageText(body))` → умолчания → подстановка в
  текст первого блока; узел с `problem` или неизвестное имя → отказ бейджа. Остальные входы дерева защищены базовой схемой и
  разбором без места — отдельного кода не нужно, только тесты (и). `materializationWindow` на дереве с `{param}` бросает
  `Error('параметр не подставлен')` (недостижимо: пачка подставляет раньше). Прогон шага 1 (ж)–(и) → PASS.

- [ ] **Шаг 4: web собирается.** `bun run typecheck` покажет исчерпывающие ветви по `PageNode.kind`; вид `param` в показе и
  первом кадре — ничего не рисует (докблок: «переключатель параметра — задача 5 среза 1в»), редактор держит узел (`paramBlock`
  в расширениях, умолчания `strip-ids`); тест `editor.test.tsx`: тело с `{{param: …}}` проходит «открыть → правка соседнего
  абзаца → сохранить» без потери маркера (Фокус ревью п. 3). Прогон `cd $W/apps/web && bun run test src/features/entity-editor/editor.test.tsx > $T/t4c.log 2>&1` → PASS.
  Локальный замер веса (РП-22) — сборка и `check-lazy-chunks` командами задачи 5, шаг 2.

- [ ] **Шаг 5: мутации.** (а) `queryAstSchema` без уточнения `PAGE_ONLY` → красные (д), (и); (б) `substituteParams` молча
  подставляет `today` вместо отказа → красный (ж); (в) бейдж без умолчаний (`$` не подставлен) → красный (з); (г) `needsQuote`
  без `$` → красный (г); (д) матрица мест `param.note = true` → красный (б). Откатить.

- [ ] **Шаг 6: полный прогон и коммит.**
```
cd $W && git add packages/shared/src/query/page-only.ts packages/shared/src/query/page-only.test.ts packages/shared/src/doc/nodes/param-block.ts apps/server/src/query/params.ts apps/server/src/query/params.test.ts
cd $W && bun run test > $T/t4-full.log 2>&1; echo EXIT=$? && bun run lint > $T/t4-lint.log 2>&1; echo EXIT=$? && bun run typecheck > $T/t4-tsc.log 2>&1; echo EXIT=$?
cd $W && git commit -m "feat(pages): параметр страницы — {{param}}, \$-ссылка, подстановка на сервере, бейдж по умолчаниям

Объявление {{param: …, type=period …}} — новый узел документа во всех копиях правил; ссылка
\$<имя> — значение-граница только в схеме деревьев страниц; сервер подставляет значения пачки
и проверяет их по блоку; бейдж раздела считает первый блок по умолчаниям тела. Везде вне
страниц и шаблонов — отказ с подсказкой.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- packages/shared/src apps/server/src apps/web/src scripts
```

### Задача 5: Параметр страницы — web: переключатель на месте блока, значение в истории экрана, пачка с параметрами, плашки

**Зачем:** спека §5.1 (переключатель: до четырёх вариантов — сегменты, больше — выпадающий список; подписи из словаря;
значение — в истории экрана, у раздела переживает перезапуск, не в теле и не в адресе; все блоки — одной пачкой; плашки
заметки, неизвестного имени, второго и неверного умолчания), С1в-4 (web), С1в-11 («подстановка только на сервере», «параметр не
пишется в тело»), РП-15, РП-18, Д-11, Д-17.

**Файлы:**
- web, создать: `apps/web/src/features/page/params.tsx` (`PageParamsProvider`, `usePageParams`), `features/page/blocks/ParamSwitchSlot.tsx`
  (точка лени по образцу `features/browser/RecordsBlockSlot.tsx:15-40`), `features/page/blocks/ParamSwitch.tsx`, тесты
  `features/page/params.test.tsx`, `features/page/blocks/param-switch.test.tsx`.
- web, изменить: `features/page/Renderer.tsx` (вид `param` → `ParamSwitchSlot`; провайдер значений вокруг тела),
  `features/page/{PageView,RecordView}.tsx` (провайдер: объявления из разобранного тела, значения — из `view` текущей записи
  стопки), `features/entity-editor/EditorShell.tsx` (первый кадр — провайдер с умолчаниями), `features/entity-editor/nodes/QueryWidget.tsx`
  (`astOf` → `pageQueryAstSchema`; провайдер редактора — умолчания из документа), `features/entity-editor/nodes/RecordBlockStub.tsx`
  (вид узла `paramBlock` в редакторе — плашка «Параметр «<подпись>»: <варианты>», только чтение), `features/entity-editor/layout-parts.tsx`,
  `features/page/blocks/DataBlock.tsx` (имена `$` → значения из контекста → `useBlockData`; неизвестное имя — плашка),
  `lib/query-blocks/{batch.tsx,parse.ts}` (`BlockAsk.params`, ключ кеша `:217`, `placeholderData :238-241`; разбор с местом по
  роду тела), `features/query-builder/{model.ts,FieldRows.tsx,QueryTextEditor.tsx}` (разбор с местом; строка с `$` — только
  чтение, подпись `$имя`), `state/navigation.ts` (`setView` уже есть — `:108-109, 209`), `app/history.ts:91-94` (строковые
  значения `view` — без изменений), `scripts/check-lazy-chunks.ts:120-129` (`LAZY_DETAIL_MODULES` += `ParamSwitch`),
  `features/entity-editor/save.test.tsx:1483-1607` (эагерные файлы: `params.tsx`, `ParamSwitchSlot.tsx`).
- shared, изменить: `packages/shared/src/nav/history-model.ts:132-136, 524-605` (`NavPersisted.views`, `persistOf`, `restoreFrom`) + тест.
- scripts: `scripts/query-walkers.test.ts` (строки `web-form-parse`, `web-field-rows`, `web-block-parse`, `web-text-editor`,
  `web-query-widget`).

**Интерфейсы:**
- Consumes: `PageParamDecl`, `paramDeclsOf`, `paramNamesIn`, `pageQueryAstSchema`, `parseQueryAst(..., {place})` (задача 4);
  `QUERY_DATE_TOKEN_LABELS` (задача 2); `navReduce` действие `{type:'view', patch}` и `StackEntry.view`
  (`history-model.ts:82-88, 469-473`); стор `useNav().setView(patch)` (`state/navigation.ts:108-109`).
- Produces:
```ts
// apps/web/src/features/page/params.tsx
export const PARAM_VIEW_PREFIX = 'param:';                   // ключ view записи стопки: `param:<имя>` (чат держит `about`)
export interface PageParams { decls: ReadonlyMap<string, PageParamDecl>; values: Readonly<Record<string, string>> }
export function PageParamsProvider(p: { nodes: readonly PageNode[]; view?: Readonly<Record<string, string>>; children: ReactNode }): JSX.Element;
export function usePageParams(): PageParams;                  // вне провайдера — пустые карты (заметка, поиск)
// apps/web/src/lib/query-blocks/batch.tsx
export function useBlockData(text: string, opts?: { limit?: number; params?: Readonly<Record<string, string>> }): BlockQuery;
// packages/shared/src/nav/history-model.ts
export interface NavPersisted { /* …как было… */ views?: Readonly<Record<SectionKey, Readonly<Record<string, string>>>> }
//   только ключи `param:*` корня раздела; restoreFrom кладёт их в `view` корня
```

- [ ] **Шаг 1: красные тесты.** (а) `history-model.test.ts`: `persistOf` после `view {'param:period':'next_14d'}` на корне
  раздела пишет `views[раздел]`; ключ `about` не сохраняется; `restoreFrom` возвращает его в `view` корня; сохранение без `views`
  (старый клиент) читается как раньше; запись со старым клиентом новой формы — `restoreFrom` старой версии не падает (лишний
  ключ); (б) `params.test.tsx`: страница с объявлением и двумя блоками `$period` — один вызов `entity.blocks`, у обоих элементов
  `params: {period: 'next_7d'}` (умолчание); переключение на «14 дней» — второй вызов с `next_14d`, прежние строки видны до
  ответа (без «Загрузка…»); `view` записи стопки = `{'param:period':'next_14d'}`; ни одного `entity.updateBatch` (параметр не
  пишется в тело), адрес не меняется; «назад» и возврат на запись — значение на месте; страница, открытая ярлыком в чужом
  приложении и из «Записей», — значение живёт в ЕЁ записи стопки; (в) `param-switch.test.tsx`: два варианта — сегменты
  `role="radiogroup"` с подписями словаря «7 дней», «14 дней» и заголовком «Горизонт»; пять вариантов — нативный `<select>`;
  без `title` — имя; (г) плашки: заметка с `{{param}}` — «работает на страницах и в шаблонах», текст маркера сохраняется;
  блок с `$x` без объявления — плашка «параметр «x» не объявлен на странице» до запроса; заметка с `{{param: period…}}` и
  `{{query:orbis/when=$period}}` или `group=day:…` — плашка «работает на страницах и в шаблонах», запроса нет, неуместное
  объявление заметки провайдер НЕ отдаёт блокам; второй `{{param: period…}}` — плашка
  «второй»; `problem` — плашка ошибки блока параметра с текстом; (д) первый кадр (`EditorShell`) и редактор (`QueryWidget`):
  блок с `$period` запрашивается с умолчанием, не отказом; (е) конструктор: строка условия с `$period` показывает `$period`
  только для чтения (не «[object Object]»), печать формы сохраняет `{param}`; (ж) вес: `ParamSwitch` — отдельный чанк
  (`check-lazy-chunks`). Прогон `cd $W/apps/web && bun run test src/features/page/ src/lib/query-blocks/ src/features/query-builder/ > $T/t5a.log 2>&1` → FAIL;
  `cd $W/packages/shared && bun test src/nav/ > $T/t5b.log 2>&1` → FAIL.

- [ ] **Шаг 2: реализация.** Провайдер — по «Интерфейсам»: `values = {…умолчания, …view без префикса}` (значение `view`,
  которого нет среди вариантов объявления, игнорируется — умолчание); объявления берутся только при роде тела `page`/`template`
  (в заметке — пусто). Переключатель — `ParamSwitchSlot` (эагерная склейка,
  `lazy(() => import('./ParamSwitch'))` + скелетон высотой сегментов) → `ParamSwitch`: смена значения — `setView({[PARAM_VIEW_PREFIX +
  name]: token})`. `DataBlock`: `paramNamesIn(ast)` → значения из контекста только этих имён (ключ кеша не зависит от чужих
  параметров) → `useBlockData(text, {limit, params})`; имя без объявления — плашка без запроса. `batch.tsx`: `params` в элементе;
  ключ `[QUERY_BLOCK_KEY, text, this, limit, paramsKey]` (`paramsKey` — отсортированные пары); `placeholderData` держит прежние
  данные, если совпадают текст и `this`. Разбор в web — место `page` при роде тела `page`/`template` (`useBodyKind`), иначе без
  места. Стор истории — `persistOf`/`restoreFrom` по «Интерфейсам». Прогон шага 1 → PASS. Сборка и сторож веса:
```
cd $W && bun run --filter @orbis/web build > $T/t5-build.log 2>&1; echo EXIT=$?
cd $W && bun scripts/check-lazy-chunks.ts --max-gzip DetailScreen=34889 --max-closure-gzip DetailScreen=329400 > $T/t5-lazy.log 2>&1; echo EXIT=$?
```
  Превышение — СТОП и разбор (не подъём порога).

- [ ] **Шаг 3: мутации.** (а) `DataBlock` подставляет значение в ТЕКСТ блока на клиенте вместо `params` → красный (б) («вход
  пачки несёт `params`, текст — с `$`»); (б) смена значения зовёт `entity.updateBatch` → красный (б); (в) `persistOf` без
  `views` → красный (а); (г) ключ кеша без `params` → красный (б) (второй запрос не уходит). Откатить.

- [ ] **Шаг 4: полный прогон и коммит.**
```
cd $W && git add apps/web/src/features/page/params.tsx apps/web/src/features/page/params.test.tsx apps/web/src/features/page/blocks/ParamSwitchSlot.tsx apps/web/src/features/page/blocks/ParamSwitch.tsx apps/web/src/features/page/blocks/param-switch.test.tsx
cd $W && bun run test > $T/t5-full.log 2>&1; echo EXIT=$? && bun run lint > $T/t5-lint.log 2>&1; echo EXIT=$? && bun run typecheck > $T/t5-tsc.log 2>&1; echo EXIT=$?
cd $W && git commit -m "feat(web): параметр страницы — переключатель на месте блока, значение в истории экрана

Переключатель — сегменты до четырёх вариантов, больше — список; подписи из словаря токенов.
Значение живёт в записи стопки экрана (у раздела — и после перезапуска), в тело и адрес не
пишется; блоки с \$ уходят одной пачкой со значениями, подстановка — на сервере.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/web/src packages/shared/src scripts
```

### Задача 6: Группировка по дням — канон и сервер: `group=day:<адрес>`, раскладка в поясе владельца, признак «закрыто»

**Зачем:** спека §5.2 (ключ проекции, формы показа, день записи — день ключа §3.3, период блока, раскладку считает сервер,
ответ несёт `today` и пояс, пустые дни до 31 дня, приоритет `done > moment > deadline`, подробности колонки времени,
многодневное — в дне начала, внутри дня — сначала без времени, лимит 500 и «ещё N», шаблоны повторов — явно), §3.8 (`group`
вне страниц — отказ), §8.2 п. 42 (признак «закрыто» — РП-12), С1в-5 (сервер), С1в-11 («ключ группировки»), РП-11, Д-12.

**Файлы:**
- shared, создать: `packages/shared/src/pages/day-groups.ts` (`layoutDayGroups` + `day-groups.test.ts`).
- shared, изменить: `query/ast.ts` (`QueryAst.group`, схемы, `PROJECTION_RULE_MESSAGES.groupNeedsRows`), `query/parse-ast.ts`
  (`RESERVED_WORDS :370-394`, `NOT_NEGATABLE :1062-1073`, ветка `dispatch` — образец `aggregate`, `assignOnce` `K`,
  `assertProjectionShape :881-892`), `query/print.ts:305-331` (`group=day:<адрес>` — после `sortBy`), `query/ast-json-schema.ts`
  (без `group` — тул), `query/static.ts:87-95`, `query/normalize.ts:95-102`, `query/page-only.ts` (находит `group`),
  `contracts/blocks.ts` (`groups`, `today`, `timeZone`, `closedIds`).
- server, изменить: `routers/entity-blocks.ts` (`compileBlock :208-224` — ветка группировки; `executePlan :233-272`; верх ответа —
  `today`, `timeZone` из `queryContext` пачки `:337`), `query/contract-sql.ts` (колонки `__when_dates`, `__key_at`),
  `query/compile-ast.ts` (колонка `__closed` — `compileClassMembership(orbis/completable, closed)`; для строк и групп), тесты
  `routers/entity-blocks.test.ts`, новый `routers/day-groups.dataset.test.ts`, `tools/dispatch.test.ts` (`group` — отказ).
- web (собирается): `features/page/blocks/DataBlock.tsx:134-158` (вид `groups` — до задачи 7 плашка «обновите приложение»
  остаётся для незнакомого вида; докблок «ленту рисует задача 7»), `lib/query-blocks/batch.tsx` (тип ответа).

**Интерфейсы:**
- Consumes: `whenDatesSql`, `addressSortKey`, `slotValuesSql` (задача 1); `tokenEdges` (задача 2); `substituteParams`,
  `pageOnlyFeatureIn` (задача 4); `bindingIndexOf` (shared).
- Produces (для задач 7, 8, 9):
```ts
// packages/shared/src/query/ast.ts
export interface QueryGroup { by: 'day'; field: QueryFieldRef }  // адрес даты: свойство date/timestamp, адрес слота с датой, значение «когда»
// QueryAst += group?: QueryGroup   (только pageQueryAstSchema; display — list | compact | нет)
// packages/shared/src/contracts/blocks.ts
export interface BlockRowAt { slot: 'done' | 'moment' | 'deadline' | null; value: string; end: string | null; allDay: boolean }
//   slot null — группировка по свойству или по адресу слота (одна дата); value — ISO момента или YYYY-MM-DD даты
export interface BlockGroupRow { entity: Entity; at: BlockRowAt | null }
export interface BlockDayGroup { day: string | null; rows: BlockGroupRow[] } // day null — «Без даты» (последней)
// BlockResult += { ok: true; kind: 'groups'; groups: BlockDayGroup[]; more: number; closedIds: string[] }
// kind 'rows' — closedIds заполнен (задача 3 завела пустым)
export interface EntityBlocksResult { results: Record<string, BlockResult>; today: string; timeZone: string }
// packages/shared/src/pages/day-groups.ts
export interface DayGroupInputRow {
  entity: Entity;
  keyAt: string | null;                  // ключ записи §3.3 (ISO), null — без даты
  dates: ReadonlyArray<{ slot: 'done' | 'moment' | 'deadline'; at: string; day: string; aspect: string }>; // даты «когда» (значение)
}
export function layoutDayGroups(input: {
  rows: readonly DayGroupInputRow[]; more: number; today: string; timeZone: string;
  period: { start: string; end: string } | null;   // интервал условия `=T` на том же адресе (§5.2)
  reg: RowRegistry;                                 // привязки `end`, `all_day` аспекта, поставившего `moment`
}): { groups: BlockDayGroup[]; more: number };
```

- [ ] **Шаг 1: красные тесты.** (а) shared `parse-ast.test.ts`/`print.test.ts`: `group=day:orbis/when` при `{place:'page'}` →
  `{by:'day', field:{contract:'orbis/when'}}`; `group=day:orbis/due_date` — свойство; `group=day:orbis/title` → `TYPE`;
  `group=week:…` → `SYNTAX` («в 1в — только day»); `group` с `display=table` или `tile` → отказ со словами
  `PROJECTION_RULE_MESSAGES.groupNeedsRows`; без места — `PAGE_ONLY`; `!group=…` — `NOT_NEGATABLE`; печать ↔ разбор;
  (б) `day-groups.test.ts` (без базы, пояс `Asia/Novosibirsk`, `today 2026-07-15`): дни периода `next_7d` — восемь групп, пустые
  с `rows: []`; период 40 дней — только непустые; строка без ключа — группа `day: null` последней; запись с `moment` и
  `deadline` в одном дне → `at.slot = 'moment'`; с `done` и `moment` в одном дне → `'done'`; `moment` со временем и `end` в тот
  же день → `end` = ISO конца; `end` на другой день → `end` задан (подпись «→ 30.09» рисует web); `all_day true` → `allDay`;
  `moment`, привязанный свойством типа `date` (аспект владельца) → `allDay`; многодневное событие — в дне начала; внутри дня —
  сначала `allDay`/`deadline`/`done`-дата (без времени), затем по времени, равное — по порядку входа; `more` — у последней
  группы (поле ответа); (в) новый `day-groups.dataset.test.ts` (`seedWhenWorld` с `today 2026-07-15`): блок
  `orbis/when=next_7d, !class=orbis/recurrence:templates, group=day:orbis/when, display=list` с подстановкой — группы
  `07-15: E2 (весь день), T11a (сделано), T3 (сделано 16:05)`, `07-16: T7 (срок), T9 (09:00; дата строки — срок 07-18)`,
  `07-17: E1 (09:00–10:30), T10 (09:00)` (равные по времени — по `id`), `07-18: T1 (срок)`, `07-19…07-22: пусто`; `today`, `timeZone` в ответе;
  `closedIds` = `T3, T11a`; на том же мире: лимит 2 → две строки и `more`; `group=day:orbis/when.deadline` (адрес слота) — дни
  по сырым срокам, `at.slot = null`; блок `orbis/when>=2026-07-17, group=day:orbis/when` (период `null` — только непустые дни)
  ставит `T9` в день `07-18` — ранняя из дат, удовлетворяющих условию; блок без условия на адресе → записи без дат — группа
  «Без даты» последней. ОТДЕЛЬНЫМИ тестами на своём графе (`await freshGraph()`, мир не засеян — перечень дней выше не
  меняется): запись «расписание + задача» (`start_at 07-19 10:00`, `due_date 07-19`) — одна строка в дне `07-19` с
  `at.slot = 'moment'` («10:00»), без дубля (Фокус ревью п. 4); задача, закрытая в 23:40 по поясу владельца, — в группе своего
  дня, не следующего (Фокус ревью п. 1);
  (г) отказы вне страниц: `entity_query` с `group=` текстом и деревом, `entity.query({ast})` — структурный отказ с
  подсказкой. Прогон `cd $W/packages/shared && bun test src/query/ src/pages/ > $T/t6a.log 2>&1` → FAIL;
  `cd $W/apps/server && bun test src/routers/day-groups.dataset.test.ts src/routers/entity-blocks.test.ts src/tools/dispatch.test.ts > $T/t6b.log 2>&1` → FAIL.

- [ ] **Шаг 2: канон (shared).** `group` — проекция: `assignOnce`, `assertProjectionShape` (`group` ⇒ `display` ∈ {нет,
  `list`, `compact`}; поле — вид даты по `addressKindOf` или типу свойства), печать `group=day:<fieldRefKey>` после `sortBy`,
  `normalize` — `field` адреса, `static` — отказ, `page-only` — находит; JSON Schema тула `group` не знает. Пометки
  обходчиков — по таблице. `layoutDayGroups` — чистая функция по «Интерфейсам»; день группы — `keyAt` в поясе ответа
  (`Intl.DateTimeFormat('en-CA', {timeZone})`); выбор даты в дне — среди `dates` с тем же днём по приоритету `done > moment >
  deadline`; подробности — `end`, `all_day` той же привязки (`reg` → привязки аспекта `aspect` контракта `orbis/when`).
  Прогон шага 1 (а)–(б) → PASS.

- [ ] **Шаг 3: сервер.** В `compileBlock`: при `ast.group` — строковый план с колонками `__key_at` (`addressSortKey` поля
  группы с положительными условиями того же адреса) и `__when_dates` (`jsonb_agg` строк `whenDatesSql` — только у значения
  «когда»; у свойства и адреса слота — пусто, `at.slot = null`), `ORDER BY __key_at NULLS LAST, <sortBy блока>, e.id`; лимит
  `min(блок ?? текст ?? 500, 500)`, `limit+1` и счётчик — как у строк; период — края `tokenEdges` условия `=T` (или
  литерала/`range`) на ТОМ ЖЕ адресе среди детей верхнего `and` (после подстановки параметров), иначе `null`. Колонка
  `__closed` — во всех строковых планах; `closedIds` — id строк с `__closed = true`. Верх ответа — `today` и `timeZone` пачки.
  Прогон шага 1 (в)–(г) → PASS.

- [ ] **Шаг 4: мутации.** (а) день группы — в UTC, а не в поясе владельца → красный (в) (23:40); (б) приоритет `deadline >
  moment` → красный (б); (в) ключ группы — самая ранняя дата записи без учёта условий блока → красный (в): `T9` в
  дне `07-16` вместо `07-18`; (г)
  `closedIds` пусты → красный (в). Откатить.

- [ ] **Шаг 5: полный прогон и коммит.**
```
cd $W && git add packages/shared/src/pages/day-groups.ts packages/shared/src/pages/day-groups.test.ts apps/server/src/routers/day-groups.dataset.test.ts
cd $W && bun run test > $T/t6-full.log 2>&1; echo EXIT=$? && bun run lint > $T/t6-lint.log 2>&1; echo EXIT=$? && bun run typecheck > $T/t6-tsc.log 2>&1; echo EXIT=$?
cd $W && git commit -m "feat(pages): группировка по дням — group=day:<адрес>, раскладка на сервере

День записи — день её ключа (§3.3) в поясе владельца; пустые дни периода до 31 дня; приоритет
даты в дне done > moment > deadline; подробности колонки времени по привязкам «когда»; ответ
несёт today и пояс. Строки и группы несут признак «закрыто» от сервера (Б-2 №78 п. 42).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- packages/shared/src apps/server/src apps/web/src scripts
```

### Задача 7: Группировка по дням — web: лента по дням, подписи дней, колонка времени, «свободно»

**Зачем:** спека §5.2 (подписи «Сегодня · сб, 27 сентября», «Завтра · …», пустой — «свободно»; колонка времени «09:00»,
«14:00–15:30», «09:00 → 30.09», «весь день», «срок», «сделано 16:05», «сделано»; дата строки не печатается, если совпадает с
днём группы; зачёркивание закрытых; «ещё N» в конце последней группы), С1в-5 (web), РП-18, Д-17, Д-20.

**Файлы:**
- web, создать: `features/page/blocks/DayGroupsSlot.tsx` (точка лени), `features/page/blocks/DayGroups.tsx`, тест
  `features/page/blocks/day-groups.test.tsx`.
- web, создать: `features/page/blocks/day-format.ts` (+ тест) — перенос `localDay`, `localTime` из
  `features/agenda/useAgenda.ts:55-77` (`dayInTimeZone(iso, tz)`, `timeInTimeZone(iso, tz)` с тем же запасом на битую зону) и
  подписи дня и колонки времени; модуль импортирует ТОЛЬКО ленивый `DayGroups.tsx` (РП-22: `lib/dates.ts` эагерен и не растёт).
- web, изменить: `features/page/blocks/DataBlock.tsx:134-158` (вид
  `groups` → `DayGroupsSlot`; `isEmptyResult :69-84` — ветка групп: пусто, если во всех группах нет строк), `features/browser/EntityRow.tsx`
  (проп `closed?: boolean` поверх проекции; `showDate` уже есть — `:39`), `features/query-builder/model.ts:420-426` (`withDisplay`
  снимает `group` при `table`/`tile`), `scripts/check-lazy-chunks.ts` (`LAZY_DETAIL_MODULES` += `DayGroups`),
  `features/entity-editor/save.test.tsx` (эагерные: `DayGroupsSlot.tsx`).

**Интерфейсы:**
- Consumes: `BlockResult` вида `groups`, `EntityBlocksResult.today/timeZone` (задача 6); `QUERY_DATE_TOKEN_LABELS` (задача 2).
- Produces:
```ts
// apps/web/src/features/page/blocks/day-format.ts (только в ленивом чанке ленты)
export function dayInTimeZone(iso: string, timeZone: string): string;    // YYYY-MM-DD; дата без времени — как есть
export function timeInTimeZone(iso: string, timeZone: string): string;   // HH:MM
export function dayHeaderLabel(day: string, today: string): string;      // «Сегодня · сб, 27 сентября» | «Завтра · вс, 28 сентября» | «пн, 29 сентября»
export function rowTimeLabel(at: BlockRowAt, day: string, timeZone: string): string; // «09:00» | «14:00–15:30» | «09:00 → 30.09» | «весь день» | «срок» | «сделано 16:05» | «сделано»
// apps/web/src/features/browser/EntityRow.tsx — проп closed?: boolean (true/false — поверх проекции; нет — проекция)
```

- [ ] **Шаг 1: красные тесты.** (а) `day-format.test.ts`: `dayHeaderLabel('2026-09-27','2026-09-27')` → «Сегодня · сб, 27
  сентября»; `'2026-09-28'` → «Завтра · вс, 28 сентября»; `'2026-09-29'` → «пн, 29 сентября»; `rowTimeLabel` — все семь форм;
  пояс ответа, а не браузера (`vi.stubEnv('TZ', 'UTC')` или `process.env.TZ`; ответ — `Asia/Novosibirsk`: ISO `…T16:40Z` →
  «сделано 23:40»); битая зона — запасной вывод без исключения; (б) `day-groups.test.tsx` (ответ `blocksReply` обвязки с видом
  `groups`, `today`, `timeZone`): заголовки дней в порядке ответа; пустой день — «свободно»; группа «Без даты» — последней с
  подписью «Без даты»; колонка времени слева от строки; строка `T9` в дне `07-16` показывает дату срока `07-18`, строка `T7`
  (срок в своём дне) — даты не показывает; строки из `closedIds` зачёркнуты, прочие — нет, независимо от проекции; «ещё N» — после
  последней группы; первый кадр — скелетон чанка, не пустота; (в) `model.test.ts`: `withDisplay('table')` снимает `group`;
  (г) `check-lazy-chunks`: `DayGroups` — отдельный чанк. (д) сторож импорта (новый тест `scripts/day-format-import.test.ts`): единственный импортёр `day-format` вне тестов —
  `DayGroups.tsx` (`git grep -l "day-format" -- apps/web/src ':!*.test.*'`); рост замыкания держит порог `--max-closure-gzip`.
  Прогон
  `cd $W/apps/web && bun run test src/features/page/blocks/ src/features/query-builder/ > $T/t7a.log 2>&1` → FAIL.

- [ ] **Шаг 2: реализация.** `DayGroups` рисует `ListForm`/`CompactForm` построчно внутри группы (форма блока), `EntityRow`
  получает `closed={closedIds.has(id)}` и `showDate={rowDate(entity) !== group.day}` (день строки — `dayInTimeZone` в поясе
  ответа); подписи — по «Интерфейсам» (дни недели и месяцы — `Intl.DateTimeFormat('ru', {weekday:'short', day:'numeric',
  month:'long', timeZone:'UTC'})` над датой группы). Форматтеры переносятся из `useAgenda.ts` в `day-format.ts` (сам модуль удаляет задача 10). Новые файлы — `git add` сразу.
  Прогон шага 1 → PASS; сборка и `check-lazy-chunks` — командами задачи 5, шаг 2.

- [ ] **Шаг 3: мутации.** (а) день строки в поясе браузера → красный (а)/(б) (23:40); (б) `EntityRow` игнорирует `closed` →
  красный (б); (в) `withDisplay` оставляет `group` → красный (в). Откатить.

- [ ] **Шаг 4: полный прогон и коммит.**
```
cd $W && git add apps/web/src/features/page/blocks/DayGroupsSlot.tsx apps/web/src/features/page/blocks/DayGroups.tsx apps/web/src/features/page/blocks/day-groups.test.tsx apps/web/src/features/page/blocks/day-format.ts apps/web/src/features/page/blocks/day-format.test.ts scripts/day-format-import.test.ts
cd $W && bun run test > $T/t7-full.log 2>&1; echo EXIT=$? && bun run lint > $T/t7-lint.log 2>&1; echo EXIT=$? && bun run typecheck > $T/t7-tsc.log 2>&1; echo EXIT=$?
cd $W && git commit -m "feat(web): лента по дням — подписи дней, колонка времени, «свободно», зачёркивание от сервера

Группы рисуются ленивым чанком: «Сегодня · сб, 27 сентября», пустой день — «свободно», колонка
времени по дате, поставившей запись в день, в поясе владельца; дата строки не повторяет день.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/web/src scripts
```

### Задача 8: Строка списка через слоты — «весь день» слотом, имена слотов из правила, признак «закрыто» в формах блока

**Зачем:** спека §4.3 (подписи строк читают «весь день» и «конец» слотами), §8.2 (Б-2 №100 = №78 п. 45; п. 42 — формы
`list`/`compact`/`table` блока тоже берут `closedIds`; п. 43 — имена слотов из поля `slots` правила элемента), С1в-13, РП-12,
Д-12. Б-2 №73 закрывается удалением модуля в задаче 12 (Э-5).

**Файлы:**
- shared, изменить: `packages/shared/src/registry/row.ts` (`M14_ROW_ELEMENTS :21-34` — у элемента суммы `slots: ['amount',
  'direction', 'currency', 'category']`; чтение имён — через `declaredSlot(rule, name)`, бросающий, если слота нет в правиле:
  `:169-196`, `:229-241`; новый `rowAllDayOf(entity, reg): boolean` — слот `all_day` привязки `orbis/when` аспекта на записи) + тест.
- web, изменить: `features/entity-detail/NativeRow.tsx:285-286` (`rowAllDayOf` вместо `props['orbis/all_day']`),
  `features/page/blocks/{ListForm,CompactForm,TableForm}.tsx` (`closed` из `closedIds` ответа), `features/page/blocks/DataBlock.tsx`
  (прокинуть `closedIds`), тесты `NativeRow`, `forms.test.tsx`.

**Интерфейсы:**
- Consumes: `closedIds` ответа `rows` (задача 6), проп `EntityRow.closed` (задача 7).
- Produces: `rowAllDayOf(entity: RowEntity, reg: RowRegistry): boolean` (`packages/shared/src/registry/row.ts`).

- [ ] **Шаг 1: красные тесты.** (а) `row.test.ts`: аспект владельца, реализующий `orbis/when` со своим свойством «весь
  день» (`user/allday` boolean → слот `all_day`), — `rowAllDayOf` истинно; запись с `orbis/all_day = true`, но без аспекта
  расписания (значение пережило снятие аспекта) — ложно; правило элемента без `currency` в `slots` (подменённый реестр
  правил в тесте) → чтение валюты бросает «слот не объявлен правилом» (п. 43 — правило источник); (б) `NativeRow.test.tsx`:
  бейдж «весь день» у записи аспекта владельца; (в) `forms.test.tsx`: `list`/`compact`/`table` — строка из `closedIds`
  зачёркнута при проекции «открыто» (реестр, где набор `closed` задан предикатом, — `setClasses` отдаёт `[]`), и наоборот.
  Прогон `cd $W/packages/shared && bun test src/registry/row.test.ts > $T/t8a.log 2>&1` → FAIL;
  `cd $W/apps/web && bun run test src/features/entity-detail/ src/features/page/blocks/forms.test.tsx > $T/t8b.log 2>&1` → FAIL.
- [ ] **Шаг 2: реализация** по «Файлам»; докблок `row.ts` у `setClasses` — «предикатный набор строка не вычисляет; истина у
  блоков данных — `closedIds` сервера (1в, п. 42)». Прогон шага 1 → PASS. `row.ts` эагерен (строка списка): локальный замер
  веса (РП-22) — сборка и `check-lazy-chunks` командами задачи 5, шаг 2.
- [ ] **Шаг 3: мутации.** (а) `NativeRow` снова читает `props['orbis/all_day']` → красный (б); (б) формы игнорируют
  `closedIds` → красный (в); (в) `declaredSlot` не проверяет правило → красный (а). Откатить.
- [ ] **Шаг 4: полный прогон и коммит.**
```
cd $W && bun run test > $T/t8-full.log 2>&1; echo EXIT=$? && bun run lint > $T/t8-lint.log 2>&1; echo EXIT=$? && bun run typecheck > $T/t8-tsc.log 2>&1; echo EXIT=$?
cd $W && git commit -m "fix(rows): «весь день» слотом «когда», имена слотов из правила строки, «закрыто» от сервера в формах блока

Б-2 №100, №78 п. 42, п. 43: подпись строки читает контракт, а не сырые свойства расписания;
формы блока зачёркивают по признаку сервера, совпадающему с фильтром.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- packages/shared/src apps/web/src
```

### Задача 9: Повестка — запись поставки из блоков, место в навигации хоста, `/agenda`, снятый ключ `upcoming`, «Год»

**Зачем:** спека §6.1 (тело — запись поставки `agenda`, дом — хост), §6.2 (навигация хоста: Повестка на месте Upcoming; бейдж
— первый блок данных; адрес `/agenda`), §6.3 (Upcoming снята с поставки: новый граф её не получает, снятый ключ — отдельным
списком, «вернуть как было» — род из записи и хранимый текст), §6.4 (эталон «Года»), §6.1/§3.3 следствия (три блока делят
открытые записи с датами без остатка), С1в-6, РП-10, РП-16, Д-13, М-8 остатков 1б (признак R-18 при новом ключе).

**Файлы:**
- shared, изменить: `packages/shared/src/supply/lists.ts` (`AGENDA_BODY`; `SEED_SMART_LISTS` — `agenda` на месте `upcoming`;
  `LEGACY_SEED_LIST_SLUGS` — прежние шесть слагов сева; `UPCOMING_BODY` остаётся экспортом с докблоком «эталон 1б снятого
  ключа — поставкой не несётся»; `HORIZON_YEAR_BODY` — строка горизонтов), `supply/etalons.ts` (`SUPPLY_KEYS`,
  `RETIRED_SUPPLY_KEYS`, `SUPPLY_KEY_VALUES`, тип `SupplyKeyValue`; навигация `host-shell`; `LEGACY_ETALON_TEXTS` — тип по
  `SupplyKeyValue`), `supply/print.ts:128` (без изменения смысла; докблок про снятые ключи), `registry/builtin-properties.ts:1285-1305`
  (варианты `orbis/supply_key` = `SUPPLY_KEY_VALUES`, подпись `agenda` — «Повестка»), `nav/address.ts:42-45, 170-171`
  (`/agenda` → `{kind:'legacy-supply', key:'agenda'}`; `reserved.key` — только `'budget'`), тесты `supply/etalons.test.ts:92-113,
  137, 142-147, 247`, `nav/address.test.ts:64,74`, `registry/builtin.test.ts:492`.
- server, удалить (РП-13, В-3): `apps/server/src/db/migrate-1b.ts`, `migrate-1b.test.ts`; строка `migrate-1b` в `scripts/ops.ts`
  (`OPS :788-793`, обёртка `migrate1bOp :590-610`, справка `:23-24`); строки `migrate-1b` в `docs/implementation/02-ops-runbook.md`
  — «исполнена 28.09.2026, снята срезом 1в».
- server, изменить: `supply/records.ts:28-45` (`supplyRecordId(graph, key: SupplyKeyValue)`; `LIST_KEYS: ReadonlySet<SupplyKeyValue>`
  оставляет `upcoming` — id прежнего сева), `seed/setup-graph.ts:8, 115, 276, 297-298` (докблоки и текст отказа
  `GRAPH_NEEDS_MIGRATION`: «граф старой формы: его переводит только пересев мира — docs/implementation/02-ops-runbook.md, раздел
  reset-world»), комментарии `errors.ts:120, 205`, `wire.ts:206`, `test/legacy-world.ts:18`; web
  `features/onboarding/OnboardingGate.tsx:48` (текст экрана перевода — ссылка на ранбук вместо команды `migrate-1b`) и пин
  `OnboardingGate.test.tsx:148`, `supply/mechanism.ts:116-141` (М-8), `:442-526` (`revertToEtalon` — род из записи),
  `routers/supply.ts:18,25` (`revert` — `z.enum(SUPPLY_KEY_VALUES)`; прочие — `SUPPLY_KEYS`), `seed/setup-graph.ts:118-131`
  (признак мира старой формы — `LEGACY_SEED_LIST_SLUGS`), `seed/smart-lists.ts` (реэкспорт), `test/legacy-world.ts`
  (прежние шесть — `LEGACY_SEED_LIST_SLUGS` + `LEGACY_ETALON_TEXTS` + `UPCOMING_BODY`), тесты `seed/onboarding.test.ts`
  (`:232, 556-655, 822, 991-1010, 1312-1361`), `seed/seed-canon.test.ts:15-20`, `supply/mechanism.test.ts` (`:256, 889-893`),
  `routers/supply.test.ts`, `executor/props.test.ts:938-951`, `db/reset-world.test.ts:437`, `registry/ops.test.ts:3855`,
  новый `apps/server/test/agenda-acceptance.test.ts` (С1в-6).
- web, изменить: `app/router.tsx` (`LegacyRecords` → оверлей по ключу `records | agenda`), `app/history.ts:103-107, 265-270`,
  `state/navigation.ts:46-55`, `app/ReservedScreen.tsx:5-15` (ветка `agenda` снимается; текст `budget` меняет задача 12),
  `features/page/useSupplyRecords.ts:27-70` (`byKey` по `SUPPLY_KEY_VALUES`), `features/entity-detail/DetailMenu.tsx:338`
  (признак записи поставки — `SUPPLY_KEY_VALUES`), `app/frame/frame-fixtures.ts:41, 66, 97, 151` (Upcoming → Повестка), тесты
  `app/nav.test.tsx`, `app/deep-link.test.tsx`, `state/navigation.test.ts:135`, `features/supply/*.test.tsx`.

**Интерфейсы:**
- Consumes: `{{param}}` и `$` (задача 4), `group=day:` (задача 6), `orbis/when` (задача 1), переключатель (задача 5), лента (задача 7).
- Produces (для задач 10, 11, 13):
```ts
// packages/shared/src/supply/etalons.ts
export const SUPPLY_KEYS = ['host-template','host-shell','home','records','daily-planning','agenda','all-tasks','horizon-year','horizon-life','routines'] as const;
export const RETIRED_SUPPLY_KEYS = ['upcoming'] as const;              // снятые с поставки: записи живут, эталона кода нет (§6.3)
export const SUPPLY_KEY_VALUES = [...SUPPLY_KEYS, ...RETIRED_SUPPLY_KEYS] as const; // = варианты orbis/supply_key
export type SupplyKeyValue = (typeof SUPPLY_KEY_VALUES)[number];
// host-shell: nav ['records','daily-planning','agenda','all-tasks','horizon-year','routines']
// packages/shared/src/supply/lists.ts
export const AGENDA_BODY: string;                                     // канон — ниже
export const LEGACY_SEED_LIST_SLUGS = ['daily-planning','upcoming','all-tasks','horizon-year','horizon-life','routines'] as const;
// SEED_SMART_LISTS[1] = { slug: 'agenda', title: 'Повестка', emoji: '🗓️', body: AGENDA_BODY }
```
  Тело Повестки — **каноническая печать** (что даст `parseBody → bindQueryBlocks → serializeBody`; сверка — `seed-canon.test.ts`);
  замысел (спека §6.1), от которого печать может отличаться только написанием одного и того же дерева:
```
Всё, что во времени: встречи, сроки и сделанное — по дням.

{{param: period, type=period, default=next_7d, options=next_7d|next_14d, title=Горизонт}}

{{query:orbis/when=overdue, class=orbis/completable:open, !class=orbis/recurrence:templates, sortBy=orbis/when:asc, display=list, hide_empty, title=Просрочено}}

{{query:orbis/when=$period, !class=orbis/recurrence:templates, group=day:orbis/when, display=list}}

{{query:orbis/when>$period, !orbis/when=$period, !class=orbis/recurrence:templates, sortBy=orbis/when:asc, limit=30, display=compact, title=Дальше}}
```
  «Год» (§6.4): строка горизонтов — «Лестница горизонтов целиком: день — список «Daily Planning», неделя и две — «Повестка», год —
  этот список, жизнь — список «Жизнь». «Жизни» нет в навигации хоста: её находят поиском.»

- [ ] **Шаг 1: красные тесты.** (а) `etalons.test.ts`: `SUPPLY_KEYS`, `RETIRED_SUPPLY_KEYS`; варианты `orbis/supply_key` =
  `SUPPLY_KEY_VALUES` (`budget` — нет); у каждого ключа `SUPPLY_KEYS` ровно один эталон, у снятого — ни одного; навигация
  `host-shell`; сев мира — десять записей поставки (без Upcoming); (б) `seed-canon.test.ts`: `AGENDA_BODY` проходит канон без
  изменений; разбор тела даёт ровно узлы `text`, `param`, три `query`; каждый блок разбирается с `{place:'page'}`;
  (в) `onboarding.test.ts`: новый граф — запись «Повестка» (ключ `agenda`, id `supplyRecordId(graph,'agenda')`) в навигации
  хоста третьей, записи Upcoming нет; признак мира старой формы по прежним шести id (отказ `GRAPH_NEEDS_MIGRATION` на фикстуре
  `legacy-world` — прежний); (г) `mechanism.test.ts`: запись с ключом `upcoming` и аспектом «поставка» — `listUpdates` её не
  предлагает; `revertToEtalon(ctx, 'upcoming')` у правленой — возвращает `supply_text` (печать страницы), у неправленой —
  «и так как в поставке», не бросает «эталона нет»; роутер `supply.revert({key:'upcoming'})` принят, `supply.accept({key:
  'upcoming'})` — отказ схемы; `supplyStatusOf` у `upcoming` — по аспекту; **М-8**: «Добавить из поставки: Повестка» → Undo →
  владелец правит и отменяет правку той же архивной записи → `listUpdates` снова даёт `{key:'agenda', kind:'new'}`, а `add`
  возвращает запись из архива; (д) новый `apps/server/test/agenda-acceptance.test.ts` (С1в-6): граф с поставкой
  (`seedOwnerGraph`), пояс владельца `Asia/Novosibirsk`, мир `seedWhenWorld(graph, {today: <сегодня владельца>, timeZone})` +
  еженедельный шаблон повтора расписания с `start_at = today−6` (экземпляры `I(today+1)`, `I(today+8)`; `today+15` — за
  горизонтом материализации 14); три блока тела записи «Повестка» (тексты — из `parsePageText(AGENDA_BODY)`) одной пачкой с
  `params: {period: 'next_7d'}`: «Просрочено» = `T2`; лента — `E1, E2, T1, T3, T7, T9, T10, T11a, I(today+1)` по дням,
  `closedIds` ⊇ `T3, T11a`, шаблона нет; «Дальше» = `I(today+8), T8` (по ключу; у `T8` — срок); каждая ОТКРЫТАЯ запись с датами
  (`E1, E2, T1, T2, T7, T8, T9, T10`, экземпляры) — ровно в одном блоке, без дат (`T5, T6, T11b, N1`) — ни в одном; `T4`
  (сделана вчера) — ни в одном; с `next_14d`: лента += `I(today+8)`, «Дальше» = `T8`;
  бейдж записи «Повестка» (`badgeOf`) = 1; компиляция тех же блоков с контекстом «завтра» — `T3` в ленте нет; (е) web
  `nav.test.tsx`/`deep-link.test.tsx`: `/agenda` открывает раздел Повестки хоста и заменяет адрес; нет записи ключа — домашняя;
  «⋯» и «Приложения и расширения» у записи с ключом `upcoming` рисуются без падения (Фокус ревью п. 5); лист разделов хоста
  (`frame-fixtures`) — Записи, Daily Planning, Повестка, All Tasks, Год, Рутины. Прогоны:
  `cd $W/packages/shared && bun test src/supply/ src/nav/ src/registry/builtin.test.ts > $T/t9a.log 2>&1` → FAIL;
  `cd $W/apps/server && bun test src/supply/ src/seed/ src/routers/supply.test.ts test/agenda-acceptance.test.ts > $T/t9b.log 2>&1` → FAIL;
  `cd $W/apps/web && bun run test src/app/ src/features/supply/ src/state/ > $T/t9c.log 2>&1` → FAIL.

- [ ] **Шаг 2: shared.** По «Интерфейсам»; `supplyStatusOf` — род по эталону только у ключей `SUPPLY_KEYS`, у снятых и
  неизвестных — по аспекту `orbis/app` (как сейчас; докблок называет снятые ключи). Адрес `/agenda` — оверлей поставки.
  Прогон шага 1 (а)–(б) → PASS.

- [ ] **Шаг 3: сервер.** `revertToEtalon`: род печати — `row.aspects.includes(APP_ASPECT) ? 'app' : 'page'` (не `etalonOf`); М-8
  — в `archivedByUndoneCreation` «последнее действие» ищется среди НЕотменённых: отменённые пропускаются (проба отмены — тем
  же `{type:'undo', undoes}`), затем прежняя проверка. Пересев (`db:prepare`: `orbis/supply_key` — «расходится»). Прогон шага 1
  (в)–(д) → PASS.

- [ ] **Шаг 4: web.** Оверлей `legacy-supply` по ключу (`records`, `agenda`): запись ключа есть — `settleOverlay({kind:'section',
  section: id})`, нет — домашняя; `useSupplyRecords.byKey` и `DetailMenu` — `SUPPLY_KEY_VALUES`; фикстуры рамки. Прогон шага 1
  (е) → PASS.

- [ ] **Шаг 5: мутации.** (а) вернуть `upcoming` в `SUPPLY_KEYS` → красные (а), (в); (б) `revertToEtalon` через `etalonOf` →
  красный (г); (в) М-8 без пропуска отменённых → красный (г); (в′) вернуть `migrate-1b` в `OPS` → красный typecheck (модуля нет); (г) в `AGENDA_BODY` у «Дальше» снять `!orbis/when=$period` →
  красный (д) (запись и в ленте, и в «Дальше»); (д) у «Просрочено» снять `class=orbis/completable:open` → красный (д) (`T4`).
  Откатить.

- [ ] **Шаг 6: полный прогон и коммит.**
```
cd $W && git add apps/server/test/agenda-acceptance.test.ts
cd $W && bun run test > $T/t9-full.log 2>&1; echo EXIT=$? && bun run lint > $T/t9-lint.log 2>&1; echo EXIT=$? && bun run typecheck > $T/t9-tsc.log 2>&1; echo EXIT=$?
cd $W && git commit -m "feat(supply): Повестка — запись поставки из блоков вместо Upcoming; /agenda; снятый ключ поставки

Тело Повестки — параметр горизонта и три блока над «когда» (просроченное, лента по дням,
«Дальше»); навигация хоста — Повестка на месте Upcoming; Upcoming снята с поставки, её
записи живут снятым ключом (§6.3); «Год» говорит о Повестке. М-8: признак отката «добавить»
не гаснет от чужого отменённого действия. migrate-1b снят: исполнен в проде 28.09, его план
стоял на эталонах, которые меняются здесь.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- packages/shared/src apps/server/src apps/server/test apps/web/src scripts/ops.ts docs/implementation/02-ops-runbook.md
```

### Задача 10: Уход подписки Повестки — миграция `0023`, движок, ручка, поверхность, образцы тестов; перф Повестки

**Зачем:** спека §6.5 (уходят декларация подписки, движок `agenda`, ручка `agenda.list`, контракт провода, фикстура, поверхность
`core/agenda` в `SURFACES`/`SURFACE_ENGINE`, вариант схемы и `subscription_set`, подписи; встроенная строка — миграцией `0023`
до кода), §10 (одна миграция, только данные; скрытые цены — фикстура отказов, эталоны, `surfaces.json`), С1в-10, С1в-14 (база
Повестки — перф на пачке `entity.blocks`), РП-20, Д-8, Ф-1в-1, Ф-1в-2, Ф-1в-22.

**Файлы:**
- server, создать: `apps/server/src/db/migrations/0023_agenda_subscription_drop.sql`, `meta/0023_snapshot.json`, строка
  `meta/_journal.json` — командой `cd $W/apps/server && bunx drizzle-kit generate --custom --name agenda_subscription_drop`
  (снимок — сгенерированный, SQL — рукописный; образец шапки — `0022_rules_actions.sql:1-10`); тест
  `apps/server/src/db/migration-0023.test.ts`.
- server, удалить: `subscriptions/agenda.ts`, `subscriptions/agenda.test.ts`, `routers/agenda.ts`, `routers/agenda-acceptance.test.ts`.
- server, изменить: `router.ts:9,43`, `subscriptions/registry.ts:68, 419` (ветки `agenda`), `tools/registry-tools.ts:510-536`
  (`subscription_set`: `engine` enum — `['budget']`, описание, подписи поверхностей), `tools/dispatch.ts:1513` (подпись),
  `db/seed-registries.ts:4` (докблок), `query/compile-ast.ts:429-431` (`propertyLocalDateExpr` — единственный потребитель уходит;
  снять экспорт или функцию), тесты-образцы движка подписки → Бюджет: `registry/ops.test.ts`, `subscriptions/registry.test.ts`,
  `registry/deltas.test.ts`, `tools/dispatch.test.ts`, `registry/load.test.ts`, `policy/confirmation.test.ts:675-683`,
  `registry/surfaces-golden.test.ts`, `static.test.ts:150-163`, `db/graphs.test.ts:248`, `registry/extension-off.test.ts`,
  `registry/extensions.test.ts`; `test/rls/rls.pgtap.sql:130-134, 599-607` (`surface` — `'budget'`), `test/surfaces.ts:34, 272,
  290, 413` + `test/golden/surfaces.json` (поверхность Повестки уходит), `test/fixtures/refusals.ts` (строка `SLOT_AMBIGUOUS` —
  перевыразить на движке Бюджета: `subscriptions/budget.ts:720`), `test/golden/tool-registry.json`, `perf/perf.test.ts:121-134,
  147-160, 350-390` (ключ `agenda:page`).
- shared, изменить: `registry/subscription-type.ts:20-30` (вариант `agenda` снят), `registry/builtin-subscriptions.ts:10, 22-31`,
  `registry/subscription-fixtures.ts:6, 22-44` (`AGENDA_DEF` снят), `registry/extensions.ts:20, 41` (`SURFACES =
  ['finance/budget-overview']`, `SURFACE_ENGINE`; `SURFACE_RE` НЕ меняется — голова `core` законна, запись действия и подписки
  стережёт словарь `SURFACES`, чтение — свободный текст, R-7 1б), `index.ts:3` (реэкспорт `contracts/agenda`), удалить `contracts/agenda{,.test}.ts`;
  тесты `subscription-type.test.ts`, `builtin-subscriptions.test.ts`, `extensions.test.ts`, `aspect-registry.test.ts`,
  `query/ast-fixtures.ts:17, 287` (докблоки).
- web, удалить: `features/agenda/useAgenda.ts`, `features/agenda/useAgenda.test.tsx` (каталог исчезает; модуль стоит на
  ручке `agenda.list` и типе `AgendaRow`, которые уходят здесь; форматтеры перенесла задача 7).
- web, изменить: `lib/invalidate.ts:3, 55-63` (вызов `utils.agenda.list.invalidate()` и докблоки), `lib/query-blocks/batch.tsx:100`
  (докблок).

**Интерфейсы:**
- Consumes: запись «Повестка» и её тело (задача 9); `seedWhenWorld` (задача 1).
- Produces: миграция `0023`; `SURFACES = ['finance/budget-overview']`; ключ перфа `agenda:page`.

- [ ] **Шаг 1: красные тесты.** (а) `migration-0023.test.ts`: в чистой транзакции (`adminDb`, откат в конце) СНАЧАЛА
  `DELETE FROM subscription_definitions WHERE id = 'orbis/agenda' AND graph_id IS NULL` (локальная база до `db:prepare`
  шага 3 ещё держит строку — иначе уникальный индекс `subscription_definitions_builtin_uniq`, `schema.ts:530`), затем вставить
  встроенную строку `('orbis/agenda', NULL, 'core/agenda', <AGENDA_DEF прежней формы литералом>, 900)` и строку владельца с тем
  же id на своём графе; выполнить SQL файла `0023_agenda_subscription_drop.sql` (чтение файла, `tx.execute(sql.raw(...))` по
  `--> statement-breakpoint`); встроенной строки нет, строка владельца на месте, `finance/budget-overview` на месте;
  (б) `builtin-subscriptions.test.ts`: встроенных подписок одна — `orbis/budget-overview` (`finance/budget-overview`);
  `subscription-type.test.ts`: `engine: 'agenda'` — отказ схемы; `extensions.test.ts`: `SURFACES` — одна; (в) `seed-registries.test.ts`
  после `db:prepare` — «подписок 1»; (г) `router.test.ts`: у `appRouter` нет `agenda`; (д) `perf.test.ts`: сверка ключей замеров
  с `BUDGETS_MS` (`:386`) — ключ `agenda:page` есть. Прогон
  `cd $W/apps/server && bun test src/db/migration-0023.test.ts src/router.test.ts > $T/t10a.log 2>&1` → FAIL.

- [ ] **Шаг 2: миграция.** Команда генерации — «Файлы»; SQL:
```sql
-- 0023_agenda_subscription_drop.sql — уход встроенной подписки Повестки (спека 1в §6.5, §10).
--
-- Файл РУКОПИСНЫЙ, снимок meta/0023_snapshot.json — сгенерированный (образец — 0022_rules_actions.sql:3-6): схема не
-- меняется, генерация нужна ради журнала. ЕДИНСТВЕННАЯ миграция среза 1в, только данные: сид реестров строки лишь
-- добавляет и обновляет, а загрузчик реестра строго разбирает каждую строку — оставленная строка с движком `agenda`,
-- которого больше нет в схеме, уронила бы загрузку реестра на каждом запросе. Строки владельца с `engine: 'agenda'` и
-- дельты на неё миграция НЕ трогает: их счёт — `migrate-1v --report` ДО миграции, ненулевой — СТОП (§6.5).
DELETE FROM "subscription_definitions" WHERE "graph_id" IS NULL AND "id" = 'orbis/agenda';
```
  Прогон шага 1 (а) → PASS.

- [ ] **Шаг 3: снять движок и окружение** по «Файлам»; тесты, где Повестка была образцом движка подписки, переписываются
  на Бюджет (тот же смысл проверки: дельта, откат, отказ записи, подпись поверхности), а не удаляются; строка
  `SLOT_AMBIGUOUS` фикстуры отказов — вызов движка Бюджета с двумя привязками слота. Эталоны `surfaces.json`,
  `tool-registry.json` — пересдать вручную. Пересев (`db:prepare`). Прогон шага 1 (б)–(г) → PASS.

- [ ] **Шаг 4: перф Повестки.** `perf.test.ts`: `AGENDA_PAGE_BLOCKS` — три текста блоков тела Повестки
  (`parsePageText(AGENDA_BODY)`), замер `agenda:page` — `measureMedian('agenda:page', 5, () => caller.entity.blocks({blocks:
  AGENDA_PAGE_BLOCKS.map((text, i) => ({key: String(i), text, params: {period: 'next_7d'}}))}))`; объём — мир `perf` с
  расписаниями и задачами (добавить в сев перфа по 100 задач со сроками в ближайшие 30 дней, если их нет — проверить
  `perf/seed*`); `agenda:horizon` НЕ трогается (база D21, Д-8). Порог `agenda:page` — 120 мс, бюджет прежней Повестки
  (С1в-14, РП-20), с комментарием «бюджет agenda:horizon; медиана 1в — N мс». Медиана × 3 выше 120 мс — СТОП задачи и вопрос
  владельцу (В-7); порог не поднимается. Прогон — строго порядок Ф-Г-75, отдельными вызовами:
```
cd $W && bun run test:perf:volume > $T/t10-vol.log 2>&1; echo EXIT=$?
cd $W && bun run test:perf:explain > $T/t10-exp.log 2>&1; echo EXIT=$?
cd $W && bun run test:perf:graph > $T/t10-graph1.log 2>&1; echo EXIT=$?   # ×3: graph2, graph3
cd $W && bun run test:perf > $T/t10-perf.log 2>&1; echo EXIT=$?
```

- [ ] **Шаг 5: web.** `lib/invalidate.ts` без `agenda.list`; докблоки; `features/agenda/` удалён (`git rm -r`). Перед удалением
  — `cd $W && git grep -n "features/agenda" -- apps/web/src ':!apps/web/src/legacy-1v'` → только сам каталог.
  `cd $W/apps/web && bun run test src/lib/ > $T/t10b.log 2>&1` → PASS; `cd $W && bun run typecheck > $T/t10c.log 2>&1` → 0.

- [ ] **Шаг 6: мутации.** (а) убрать `DELETE` из `0023` → красный (а); (б) вернуть `'core/agenda'` в `SURFACES` → красный (б);
  (в) удалить ключ `agenda:page` из `BUDGETS_MS` → красный (д). Откатить.

- [ ] **Шаг 7: полный прогон и коммит.**
```
cd $W && git add apps/server/src/db/migrations/0023_agenda_subscription_drop.sql apps/server/src/db/migrations/meta/0023_snapshot.json apps/server/src/db/migration-0023.test.ts
cd $W && bun run test > $T/t10-full.log 2>&1; echo EXIT=$? && bun run lint > $T/t10-lint.log 2>&1; echo EXIT=$? && bun run typecheck > $T/t10-tsc.log 2>&1; echo EXIT=$? && bun run test:rls > $T/t10-rls.log 2>&1; echo EXIT=$?
cd $W && git commit -m "refactor(subscriptions): уход подписки Повестки — миграция 0023, движок, ручка, поверхность

Настроить Повестку теперь значит править её тело; встроенная строка orbis/agenda удаляется
миграцией до кода (сид только добавляет, загрузчик строг). Тесты, где Повестка была образцом
движка подписки, перевыражены на Бюджете; перф Повестки — пачка entity.blocks (agenda:page).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/server packages/shared/src apps/web/src
```

### Задача 11: Агент — описание `entity_query`, промпты v9 и routine-v5, снятие `import_csv_start`

**Зачем:** спека §3.8 (пример «что у меня на этой неделе» и три правила в описании тула; схема тула растёт — перезамер
`prompt-size`, эталон тулов), §6.4 (строки горизонтов: Upcoming → Повестка; новая версия промпта), §7.4 (`import_csv_start`
снят из реестра тулов и манифеста; гейт `import.*` — на явном `finance`; описание Финансов), §13 (отступление), С1в-8, С1в-10
(часть), С1в-11 («гейт `import.*`»), Д-16, Ф-1в-6…8.

**Файлы:**
- server, создать: `apps/server/src/llm/prompts/{v9.ts,v9.fixture.txt,v9.test.ts,routine-v5.ts,routine-v5.fixture.txt,routine-v5.test.ts}`
  (копии v8 и routine-v4 с правками ниже; образцы тестов — `v8.test.ts`, `routine-v4.test.ts`).
- server, изменить: `llm/context.ts:48` (v9), `routines/context.ts:36` (routine-v5), `tools/registry.ts:1106-1128` (описание
  `entity_query`), `:1225-1236` (тул `import_csv_start` — снять), `:390` (схема входа — снять, если не осталось потребителей),
  `tools/dispatch.ts:709, 746-775` (ветка и `importCsvStart` — снять), `import/review.ts:104-123` (гейт — `const ext =
  'finance' as const`; докблок: «до среза Бюджет тула импорта нет — расширение названо явно»), `ai/send-message.ts:520`
  (комментарий), тесты `tools/registry.test.ts:161, 321-330, 397-400, 474, 717`, `tools/dispatch.test.ts:977-1036`,
  `mcp/mcp.test.ts:443`, `registry/extensions.test.ts:397`, `import/*.test.ts` (гейт при выключенных Финансах), эталон
  `test/golden/tool-registry.json`.
- shared, изменить: `registry/extensions.ts:130-134` (описание Финансов — «Расходы и доходы, категории и конверты бюджета»;
  `tools: ['budget_status', 'budget_rollover']`), тест `extensions.test.ts:83`; `contracts/tools.ts` (схема входа тула — снять,
  если есть).
- scripts: `scripts/check-legacy-form.ts:477-506` (`FROZEN_PROMPTS` += `'v8'`, `'v8.fixture'`, `'routine-v4'`,
  `'routine-v4.fixture'` с комментарием «замораживается срезом 1в вместе с v9/routine-v5: снимок до языка «когда»»), пин
  `scripts/check-legacy-form.test.ts:605-621`.

**Интерфейсы:**
- Consumes: язык «когда» и токены (задачи 1–2), Повестка (задача 9).
- Produces: `SYSTEM_PROMPT_VERSION = 'v9'`, `ROUTINE_PROMPT_VERSION = 'routine-v5'`; тул `import_csv_start` отсутствует.

  Текст описания `entity_query` (в конец существующей строки `description`, после примеров ядра):
```
 «Что у меня на этой неделе»: «orbis/when=this_week, !class=orbis/recurrence:templates» — orbis/when это даты «когда» записи из любого расширения (встречи, сроки, сделанное). О планах спрашивай незакрытое (!class=orbis/completable:closed): сделанное тоже стоит во времени — временем закрытия. Просроченное — «orbis/when=overdue, class=orbis/completable:open». Интервал — одним условием (=T или a..b), не двумя сравнениями. Адрес слота — «<контракт>.<слот>»: orbis/when.deadline, orbis/money-movement.amount.
```
  Строки промптов (v9 от v8, routine-v5 от routine-v4): токены — «Date-токены для любого свойства-даты и для orbis/when: today |
  overdue | next_7d | next_14d | after_7d | this_week | this_month | last_month (например, orbis/due_date=today|overdue,
  orbis/when=this_week). …» (остаток строки — как в v8); горизонты (только v9) — «день — «Daily Planning», неделя и две —
  «Повестка» (встречи, сроки и сделанное по дням), год — «Год», жизнь — «Жизнь» (вопросы ревизии). Страниц «День», «Неделя» и
  «Месяц» не существует — не предлагай их открыть и не создавай.»

- [ ] **Шаг 1: красные тесты.** (а) `v9.test.ts` (по образцу `v8.test.ts`): версия `v9`; фикстура `v9.fixture.txt` равна
  сборке промпта; строка горизонтов называет «Повестка», не называет «Upcoming»; строка токенов перечисляет восемь токенов
  словаря (`QUERY_DATE_TOKENS` — сверка с кодом, не литералом); `routine-v5.test.ts` — то же для строки токенов; (б)
  `tools/registry.test.ts`: описание `entity_query` содержит пример и три правила дословно; пример разбирается
  `parseQueryText` без отказа и компилируется; `import_csv_start` нет в реестре; `internalOnly` — только `user_query`,
  `undo_last`; (в) `extensions.test.ts`: тулы Финансов — `budget_rollover`, `budget_status`; (г) `import/*.test.ts`: при
  выключенных Финансах `import.analyze`, `import.review`, `import.confirm` → `MODULE_DISABLED` (`reason:'create'`), при
  включённых — проходят; (д) `check-legacy-form.test.ts` — `FROZEN_PROMPTS` с v8 и routine-v4. Прогон
  `cd $W/apps/server && bun test src/llm/prompts/ src/tools/registry.test.ts src/import/ > $T/t11a.log 2>&1` → FAIL.
- [ ] **Шаг 2: реализация** по «Файлам». Эталон тулов — пересдать вручную (`registry-golden.test.ts:11-19`). Прогон шага 1 →
  PASS; `cd $W && bun scripts/check-legacy-form.ts --gate; echo EXIT=$?` → 0.
- [ ] **Шаг 3: перезамер промпта.** `cd $W && bun scripts/prompt-size.ts > $T/t11-size.log 2>&1` — байты слоёв 1 и 5, число
  тулов чата; записать в `progress.md` рядом с базой 1б (слой 1 — 15 782 Б, слой 5 — 110 953 Б, тулов 44 из 51).
- [ ] **Шаг 4: мутации.** (а) гейт `import.*` снова по имени тула → красный (г) (расширение не найдено → пропуск гейта);
  (б) вернуть «Upcoming» в строку горизонтов v9 → красный (а); (в) удалить правило «интервал — одним условием» из описания →
  красный (б). Откатить.
- [ ] **Шаг 5: полный прогон и коммит.**
```
cd $W && git add apps/server/src/llm/prompts/v9.ts apps/server/src/llm/prompts/v9.fixture.txt apps/server/src/llm/prompts/v9.test.ts apps/server/src/llm/prompts/routine-v5.ts apps/server/src/llm/prompts/routine-v5.fixture.txt apps/server/src/llm/prompts/routine-v5.test.ts
cd $W && bun run test > $T/t11-full.log 2>&1; echo EXIT=$? && bun run lint > $T/t11-lint.log 2>&1; echo EXIT=$? && bun run typecheck > $T/t11-tsc.log 2>&1; echo EXIT=$?
cd $W && git commit -m "feat(agent): язык «когда» в описании entity_query, промпты v9 и routine-v5, снят import_csv_start

Агент спрашивает «что на этой неделе» одним запросом orbis/when=this_week и знает правила
(незакрытое, просроченное с class=open, интервал одним условием); горизонты — Повестка.
Инструмент импорта снят до среза Бюджет, гейт import.* — на явном расширении finance.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/server packages/shared/src scripts
```

### Задача 12: Уборка web — `legacy-1v`, осиротевшие модули, тексты «отдельным срезом»

**Зачем:** спека §8.1 (удаление каталога и его исключений; правило «модуль без живого импортёра — удаляется»), §7.4 (плашки
`/budget…`, `/a/budget…` и карточка импорта — «отдельным срезом»), С1в-10, О-6 и М-23 остатков 1б. Код экранов в сборку не
входит (`legacy-1v` вне `tsconfig`, vitest, biome) — веса удаление не даёт (разведка web §10); цель — нет мёртвого кода и нет
исключений в сторожах.

**Файлы:**
- Удалить: `apps/web/src/legacy-1v/` целиком (15 файлов: `README.md`, `agenda/AgendaScreen{,.test}.tsx`,
  `budget/{BudgetScreen,CategoryScreen,RolloverScreen,TransactionsScreen}{,.test}.tsx`, `budget/EnvelopeCard.budget.test.tsx`,
  `import/{ImportFlow,ReviewTable}.tsx`, `import/ImportFlow.test.tsx`); сироты (разведка web §7, пересняты на `ae3b710d`):
  `features/budget/{QuickAddBar,EnvelopeCreateSheet,txQuery,moneyInput,useBudget}.ts(x)` с тестами
  (`QuickAddBar.test.tsx`, `txQuery.test.ts`), `features/import/{csv-parse,money-movement,namespace}.ts` с тестами (каталог
  исчезает), `lib/recurrence.ts` (последний потребитель вне `legacy-1v` — тест `useAgenda`, снятый задачей 10), `ui/Sheet.tsx` (его
  единственный живой потребитель — `EnvelopeCreateSheet`; часть `ui/primitives.test.tsx:12,79-84` про Sheet — снять).
- Изменить: `biome.json:17`, `apps/web/tsconfig.json:9`, `apps/web/vite.config.ts:39-41` (исключения и комментарий);
  `scripts/code-boundaries.test.ts` (`OUT_OF_SCOPE` :51 — снять константу и её проверку охвата :535; `WEB_PATHSPEC` :170 и
  `ALL_PATHSPEC` :180 — без исключения; `EXTENSION_DIRS` :46-50 — без `features/import/`; шапка :25, :34);
  `scripts/check-lazy-chunks.ts` (докблоки :5-7, :44-47 — без ссылок на экраны Бюджета и `legacy-1v`);
  `features/budget/EnvelopeCard.test.tsx` (снять фикстуру `sheetHandler` и четыре теста `EnvelopeCreateSheet` :252-392,
  шапку :2-3 — Б-2 №73 закрывается удалением модуля, разведка web §7); `lib/query-blocks/production-queries.test.ts`
  (импорты :28-30 `CATEGORIES_QUERY` остаётся, `RECENT_QUERY` и `buildTxQuery` — нет; записи :113-130; число адресов
  `14` → `11` :214-217, комментарии :131-132, :204-213); `features/budget/categories.ts` (`RECENT_QUERY` — если объявлен там,
  снять); `app/ReservedScreen.tsx` (текст `budget`: «Бюджет придёт отдельным срезом»; ветку `agenda` сняла задача 9); `features/apps/OpenPlaqueList.tsx:47-48` (плашка `reserved` — тот же
  текст; спекой §7.4 не названа — Э-4); `features/chat/cards/ImportReviewCard.tsx:18-20` («Импорт откроется в
  приложении «Бюджет» — отдельным срезом», шапка :1-4); пины текстов: `app/nav.test.tsx:143-149`,
  `features/apps/open.test.tsx:267-271`, `state/navigation.test.ts:135`, `features/chat/cards/cards.test.tsx:604-606`;
  комментарии с именами удалённого: `app/router.tsx:32`, `app/lazy-screens.test.tsx:154`, `lib/invalidate.ts:55-60`,
  `features/budget/EnvelopeCard.tsx:125`, `features/browser/EntityRow.tsx:57-60`, `entity-detail/NativeRow.tsx:45,190`,
  `page/blocks/ListForm.tsx` (докблок :57-60 устарел).
- Не трогать: `features/budget/{categories,EnvelopeCard,PlannedToFactCard,usePlanToFactPrompt}.ts(x)` и `lib/dates.ts` —
  у них живые импортёры (`NativeRow`, `chat/cards/EntityCard`, `extensions/finance/FinancialCard`, `app/extension-registry`);
  их мёртвые экспорты (`EnvelopeCard` как компонент, `envelopeLevel`, `decMax`, `ddmm`, `CATEGORIES_QUERY`, `toOption`,
  `FINANCE_CATEGORY`) — в `remainders-1v.md` адресом «срез Бюджет» (правило §8.1 помодульное). Ручки `budget.*`, `import.*` и
  вызовы `utils.budget.invalidate()` остаются (§7.4).

**Интерфейсы:**
- Consumes: задача 9 (`/agenda` больше не `reserved`), задача 10 (`useAgenda.ts` удалён, вызов `agenda.list` в
  `lib/invalidate.ts:63` снят).
- Produces: `apps/web/src/legacy-1v/` нет; `LegacyAddress.reserved.key` — только `'budget'`.

- [ ] **Шаг 1: красные тесты.** (а) `scripts/code-boundaries.test.ts` — новый тест «в охвате сторожа нет исключений
  каталогов: `WEB_PATHSPEC`/`ALL_PATHSPEC` не содержат `:(exclude)`» и «каждый путь `EXTENSION_DIRS` существует в дереве»
  (второй тест до шага 2 зелёный; красный — после `git rm` шага 2, пока `EXTENSION_DIRS` не поправлен; красным до реализации
  шаг 1 держат «нет `:(exclude)`», (б) и (в));
  (б) новый `scripts/no-legacy-1v.test.ts`: `git ls-files apps/web/src/legacy-1v` пуст; в `biome.json`,
  `apps/web/tsconfig.json`, `apps/web/vite.config.ts` нет подстроки `legacy-1v`; (в) пины текстов плашек (список «Файлы»)
  переписаны на «отдельным срезом». Прогон
  `cd $W && bun test scripts/code-boundaries.test.ts scripts/no-legacy-1v.test.ts > $T/t12a.log 2>&1` → FAIL;
  `cd $W/apps/web && bun run test src/app/nav.test.tsx src/features/apps/open.test.tsx src/features/chat/cards/cards.test.tsx > $T/t12b.log 2>&1` → FAIL.

- [ ] **Шаг 2: удаление.** `git rm -r apps/web/src/legacy-1v` и модулей-сирот списка «Файлы»; правка исключений, сторожа,
  пинов и текстов. Перед удалением каждого модуля — проверка: `cd $W && git grep -n "<имя модуля без расширения>" -- apps/web/src ':!<сам модуль>' ':!<его тест>'`
  → пусто (иначе модуль не сирота — стоп, запись в отчёт). Прогон шага 1 → PASS.

- [ ] **Шаг 3: ни одного висящего импорта.** `cd $W && bun run typecheck > $T/t12-tsc.log 2>&1; echo EXIT=$?` → 0;
  `cd $W && bun run --filter @orbis/web build > $T/t12-build.log 2>&1; echo EXIT=$?` → 0; `bun scripts/check-lazy-chunks.ts
  --max-gzip DetailScreen=34889 --max-closure-gzip DetailScreen=329400 > $T/t12-lazy.log 2>&1; echo EXIT=$?` → 0.

- [ ] **Шаг 4: мутации.** (а) вернуть строку `"!apps/web/src/legacy-1v"` в `biome.json` → красный (б); (б) вернуть
  `apps/web/src/features/import/` в `EXTENSION_DIRS` → красный (а); (в) вернуть старый текст плашки в `ReservedScreen.tsx`
  → красный пин (в). Откатить.

- [ ] **Шаг 5: полный прогон и коммит.**
```
cd $W && git add scripts/no-legacy-1v.test.ts
cd $W && bun run test > $T/t12-full.log 2>&1; echo EXIT=$? && bun run lint > $T/t12-lint.log 2>&1; echo EXIT=$? && bun run typecheck > $T/t12-tsc2.log 2>&1; echo EXIT=$?
cd $W && git commit -m "chore(web): удалён legacy-1v и осиротевшие модули; плашки Бюджета и импорта — «отдельным срезом»

Каталог старых экранов Бюджета, Повестки и импорта снят вместе с исключениями biome, tsconfig,
vitest и сторожа границ; модули без живого импортёра удалены (спека §8.1). Б-2 №73 закрыт
удалением EnvelopeCreateSheet.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/web biome.json scripts
```

### Задача 13: Прод-операция `migrate-1v` — `--report` до миграции, `--apply` одной пачкой, вход репетиции

**Зачем:** спека §6.6 (одна пачка исполнителя с источником `system`: создать Повестку; в оболочке хоста Повестка на месте
Upcoming; «Год» по статусу поставки; Upcoming — в архив, если не правлена), §6.5 (счёт строк и дельт владельца на подписку
Повестки и действий владельца на `core/agenda` — ДО миграции; удаление строк — операцией `ops.ts` по слову владельца), §3.4
(перепись форм с токеном-границей), §3.7 (цели с `sortBy` и `latest`), §10 (порядок), §18 (состав `--report`), С1в-12,
РП-14, В-4, В-6, Д-9, Д-15, Э-6. (`migrate-1b` сняла задача 9 — РП-13.)

**Файлы:**
- server, создать: `apps/server/src/db/migrate-1v.ts` (+ `migrate-1v.test.ts`), `apps/server/test/world-1b.ts` (граф формы
  прода после 1б).
- scripts: `scripts/ops.ts` (строка `migrate-1v` в `OPS` — на месте снятой задачей 9 `migrate-1b`; обёртка `migrate1vOp` по
  образцу прежней `migrate1bOp` — `git show ae3b710d:scripts/ops.ts`, строки 590-610; справка `:13-24`),
  `docs/implementation/02-ops-runbook.md` (список операций; команды `migrate-1v`).

**Интерфейсы:**
- Consumes: `supplyCreateOps`, `supplyRecordId`, `supplyTextOf`, `appEtalonProps`, `etalonHash` (`apps/server/src/supply/*`);
  `supplyStatusOf`, `printPageRecord` (`@orbis/shared/supply/print`); `SUPPLY_ETALONS`, `LEGACY_ETALON_TEXTS`, `AGENDA_BODY`
  (задача 9); `tokenBoundaryForms` (задача 2); `execute` (исполнитель); `identitiesForScheduler` (`server/identity.ts:214`);
  образец гейта подтверждения — `resetWorldGate`, образец IO — прежний `runMigrate1b(args, io)`
  (`git show ae3b710d:apps/server/src/db/migrate-1b.ts`; модуль сняла задача 9).
- Produces:
```ts
// apps/server/src/db/migrate-1v.ts
export const MIGRATE_1V_LABEL = 'Повестка вместо Upcoming (срез 1в)';   // В-4
export interface Migrate1vReport {
  graph: string;
  agendaOwnerSubscriptions: string[];   // id строк subscription_definitions графа с definition->>'engine' = 'agenda' — ненулевой: СТОП
  agendaDeltas: string[];               // registry_deltas графа: target_kind 'subscription', target_id 'orbis/agenda' — ненулевой: СТОП
  coreAgendaActions: string[];          // action_definitions графа (все статусы) с offered_by → surface 'core/agenda' — владельцу
  tokenBoundaries: Array<{ where: 'body_doc' | 'body' | 'progress_source' | 'action_over' | 'entity_versions'; id: string;
                           forms: TokenBoundaryForm[] }>;   // 'entity_versions' — справочно (Э-6)
  goalsLatestSorted: string[];          // цели с progress_source.aggregate 'latest' и sortBy в query (§3.7)
  upcomingRefs: string[];               // свои приложения (orbis/app, не host-shell), где Upcoming — раздел или домашняя
  plan: { agenda: 'create' | 'exists'; shellNav: 'replace' | 'insert-after-daily' | 'append' | 'keep';
          year: 'body+etalon' | 'etalon-only' | 'absent'; upcoming: 'archive' | 'keep' | 'absent' };
}
export function reportMigrate1v(sql: SqlClient, graph: string): Promise<Migrate1vReport>; // сырые чтения, РЕЕСТР НЕ ГРУЗИТ
export function applyMigrate1v(db: Db, who: Identity): Promise<{ actionId: string } | { already: true }>;
export function dropAgendaRows(sql: SqlClient, graph: string): Promise<{ subscriptions: number; deltas: number }>;
export function assertAgendaRowGone(sql: SqlClient): Promise<void>; // встроенная строка orbis/agenda есть — отказ «сначала migrate (0023)»
export function runMigrate1v(args: string[], io: Migrate1vIo): Promise<number>;
// флаги: --report | --apply --i-understand | --drop-agenda-rows --i-understand | --rehearsal (DSN из ORBIS_REHEARSAL_DSN; хост только localhost/127.0.0.1)
```

- [ ] **Шаг 1: фикстура прод-формы.** `apps/server/test/world-1b.ts`: `seedWorld1b(graph, variant)` заводит граф так, как его
  оставил прод 1б: `setupGraph(db, who, {etalons: ETALONS_1B})`, где `ETALONS_1B` — эталоны 1б литералами в фикстуре
  (оболочка хоста с навигацией `records, daily-planning, upcoming, all-tasks, horizon-year, routines`; `upcoming` — страница с
  `UPCOMING_BODY`; «Год» — тело 1б дословно из `git show ae3b710d:packages/shared/src/supply/lists.ts`). Варианты:
  `'prod'` — Daily Planning, Upcoming, All Tasks, Год, Жизнь с ТЕЛАМИ и `supply_text` прежних эталонов (`LEGACY_ETALON_TEXTS`,
  как оставил перевод 1б после R-39: статус «как в поставке» прежней версии); `'edited'` — Upcoming и «Год» правлены
  владельцем; `'declined'` — «Год»: у записи `supply_declined` = отпечаток эталона 1б «Года» (отказ эпохи 1б — единственное достижимое
  на проде состояние; механизм помнит отказ «до следующего эталона», `mechanism.ts:212-214`, поэтому правило операции — «есть
  `supply_declined`», а не «равен отпечатку 1в»); `'own-app'` — своё приложение
  владельца с Upcoming в навигации и домашней.

- [ ] **Шаг 2: красные тесты.** `migrate-1v.test.ts` (граф `await freshGraph()` + `seedWorld1b`):
  (а) `--report` на графе `'prod'` с встроенной строкой `orbis/agenda` в `subscription_definitions` (вставить сырой строкой
  прежней формы — как в базе ДО `0023`) и строкой владельца `engine:'agenda'` — `DELETE` прежней встроенной строки (если
  есть), вставка и отчёт в ОДНОЙ откатываемой транзакции (`sql.begin` → `ROLLBACK`): строка, пережившая тест, уронила бы загрузку реестра всем следующим сьютам общей базы;
  отчёт считается без исключения (реестр не грузится), `agendaOwnerSubscriptions` = [эта строка], план — `agenda:create`, `shellNav:replace`, `year:'body+etalon'`,
  `upcoming:'archive'`; ни одной записи в граф и журнал (счётчики до/после); (б) перепись: тело страницы с
  `orbis/due_date<next_7d` в `body_doc` и в `body`, цель с `progress_source` `{query:{…, sortBy…}, aggregate:'latest'}`,
  действие владельца с `over` `orbis/due_date>=overdue`, закреплённая версия тела с `>after_7d` — каждая попадает в
  `tokenBoundaries`/`goalsLatestSorted` с формой и вердиктом; (в) `--apply` на `'prod'` (после `db:prepare`: реестр 1в):
  запись «Повестка» создана (`supplyRecordId(graph,'agenda')`, тело = `AGENDA_BODY` в каноне графа, статус «как в поставке»);
  навигация оболочки — Повестка на месте Upcoming, отпечаток и текст — эталона 1в, статус «как в поставке»; «Год» — тело и
  эталон 1в; Upcoming — в архиве; ОДНА запись журнала с подписью В-4, `source:'system'` (в ленте не видна — проверка тем же
  фильтром, что у ленты чата), Undo есть; прочие записи — `updated_at` до/после совпадает; настройки (`user_settings`) не
  тронуты; (г) `'edited'`: Upcoming правлена — не в архиве, из навигации ушла; «Год» правлен — тело прежнее, эталон новый
  (В-6); (д) `'declined'`: «Год» — только эталон; (е) навигация без Upcoming, но с Daily Planning — Повестка вставлена после
  неё; без обоих — в конец; (ж) `'own-app'`: `upcomingRefs` = [id своего приложения]; (з) повторный `--apply` — `{already:
  true}`, ноль записей; (и) `--apply` без `--i-understand` → код 2 и ни одной записи; предусловие `--apply` — `assertAgendaRowGone(sql)`:
  при встроенной строке `orbis/agenda` (`DELETE`-затем-вставка в откатываемой транзакции) → отказ «сначала migrate (0023)»; при ненулевых
  `agendaOwnerSubscriptions` → отказ «сначала --drop-agenda-rows по слову владельца»; (к) `--drop-agenda-rows --i-understand` —
  удаляет строки владельца с `engine:'agenda'` и дельты на `orbis/agenda` одной транзакцией, печатает их id, прочие строки на
  месте; (л) `--rehearsal` с `ORBIS_REHEARSAL_DSN=postgres://x@db.example.com/…` → отказ «репетиция — только локальная база»,
  с `127.0.0.1` — DSN принят (IO подменён, в базу не ходит); (м) после `--apply` вход владельца (`seedOwner`) — ноль записей.
  Прогон `cd $W/apps/server && bun test src/db/migrate-1v.test.ts > $T/t13a.log 2>&1` → FAIL.

- [ ] **Шаг 3: операция.** `reportMigrate1v` — только SQL и чистые функции (`supplyStatusOf`, `printPageRecord`,
  `tokenBoundaryForms` над `body_doc` → `jsonb_path_query(body_doc, 'strict $.**?(@.type == "queryBlock").attrs.ast')`, над `body` —
  разбор без реестра: блоки `{{query:…}}` → формы вида `<имя>(<|<=|>|>=)<токен>` и `a..b` с токеном по маске кавычек, образец —
  `census-v3.ts:84-101`; keyset-выборка по `id`, как у `census-v3`). `applyMigrate1v` — одна пачка `execute` (механизм
  `supply`, `source:'system'`, `actorKind:'owner'`, `batchLabel: MIGRATE_1V_LABEL`): `supplyCreateOps(graph, ['agenda'], …)`;
  `entity_update` оболочки (навигация по §6.6 п. 2, `supply_hash`/`supply_text` эталона 1в, предусловие `updated_at`); «Год» по
  §6.6 п. 3 в порядке: есть `supply_declined` — только `supply_hash`/`supply_text`; иначе статус `etalon` (на эталоне 1б или
  прежнем) — тело, заголовок, эмодзи и эталон новые (как `acceptOps`, без закрепления версии: тело владельцем не правлено);
  иначе — только эталон; Upcoming по п. 4 (`archived: true`). Признак «уже переведён» — запись с `supply_key = agenda` есть (с архивной). Обвязка `ops.ts` — по образцу
  прежней `migrate1bOp`; `--rehearsal` подменяет `readDsn`. Новые файлы — `git add` сразу. Прогон шага 2 → PASS.

- [ ] **Шаг 4: ранбук.** `docs/implementation/02-ops-runbook.md`: операции `migrate-1v --report`, `--drop-agenda-rows
  --i-understand`, `--apply --i-understand`, `--rehearsal`; раздел репетиции (§4.3) — «`ORBIS_REHEARSAL_DSN=<DSN локальной базы
  репетиции> bun scripts/ops.ts migrate-1v --rehearsal …`; права дампа — как в 1б (дамп без привилегий)». Чек-лист деплоя — задача 14.

- [ ] **Шаг 5: мутации.** (а) `reportMigrate1v` грузит реестр (`effectiveRegistry`) → красный (а) (строка `orbis/agenda`
  прежней формы роняет разбор); (б) Upcoming в архив без проверки статуса → красный (г); (в) «Год» «изменено вами» получает
  тело → красный (г); (г) пачка без `source:'system'` → красный (в) (запись в ленте видна); (д) снять сторож localhost →
  красный (л). Откатить.

- [ ] **Шаг 6: полный прогон и коммит.**
```
cd $W && git add apps/server/src/db/migrate-1v.ts apps/server/src/db/migrate-1v.test.ts apps/server/test/world-1b.ts
cd $W && bun run test > $T/t13-full.log 2>&1; echo EXIT=$? && bun run lint > $T/t13-lint.log 2>&1; echo EXIT=$? && bun run typecheck > $T/t13-tsc.log 2>&1; echo EXIT=$?
cd $W && git commit -m "feat(ops): прод-операция среза 1в — migrate-1v (--report до миграции, --apply одной пачкой, репетиция)

Отчёт без загрузки реестра: подписки и дельты владельца на Повестку, действия на core/agenda,
перепись форм с токеном-границей, цели с «последним» по порядку, ссылки своих приложений на
Upcoming. Перевод — одна пачка с источником system: Повестка, навигация хоста, «Год» по статусу,
Upcoming в архив, если не правлена.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/server scripts/ops.ts docs/implementation/02-ops-runbook.md
```

### Задача 14: Закрытие — PRD (D47), карта реализации, ранбук, `03-pending.md`, остатки, `handoff-budget.md`

**Зачем:** спека §16 («PRD — задача доков 1в»: D47, `03-budget.md`, `02-core-os.md`, `01-architecture.md`, глоссарий;
`03-pending.md` — переадресация хвостов §8.2, вычеркнуть 1а новое-12, новые вопросы; устаревшие комментарии кода), §13 (реестр
отступлений — в документы), §7.3 (требования срезу Бюджета), промпт планирования: `handoff-budget.md` — факты для автора спеки
среза «Бюджет». Концепцию, спеку реформы, спеки 1а, 1б, 1в задача НЕ правит.

**Файлы:**
- Изменить: `docs/prd/04-decision-log.md` (следующий номер после D46 — сверить `grep -n '^### D4' docs/prd/04-decision-log.md`;
  ожидается **D47** «Повестка и язык контрактов»), `docs/prd/00-product.md` (глоссарий по спеке §1: адрес слота, значение
  контракта, даты «когда», токен даты, параметр, группировка), `docs/prd/02-core-os.md` (Повестка — страница хоста из блоков;
  параметр; группировка по дням; горизонт «7 дней | 14 дней»), `docs/prd/01-architecture.md` (канон: адрес слота и значение
  контракта — поле `prop`/`field`, правило «даты», токены и края, `id` в каждом `ORDER BY`, сумма по валютам, «последнее»;
  провод `entity.blocks`: `params`, `groups`, `today`, `timeZone`, `closedIds`, `sums`; перечень обходчиков и сторож;
  контракт клиента `0.5.0`; числа реестра и тулов — из HEAD), `docs/prd/03-budget.md` («Бюджет — отдельным срезом», ссылка на
  целевую картину спеки §7), `docs/implementation/00-architecture.md` (модули: `packages/shared/src/{query/tokens,query/page-only,
  registry/contract-value,pages/day-groups}.ts`, `apps/server/src/{query/contract-sql,query/params,db/migrate-1v}.ts`,
  `apps/web/src/features/page/{params.tsx,blocks/ParamSwitch*,blocks/DayGroups*,blocks/day-format.ts}`; снятые:
  `subscriptions/agenda`, `routers/agenda`, `features/agenda`, `legacy-1v`, `db/migrate-1b`), `docs/implementation/02-ops-runbook.md` (строка релиза и чек-лист «Деплой среза 1в» — шаги
  задачи 16 одним списком, ожидаемый дрейф поимённо: контракт `orbis/when` «расходится» (слоты), аспекты `orbis/schedule`,
  `orbis/task` «расходится» (привязки), `orbis/supply_key` «расходится» (варианты), `orbis/progress_source` «расходится»
  (схема), подписка `orbis/agenda` «лишняя» до `0023` — сверить с `bun scripts/ops.ts check` на локальной базе ДО пересева),
  `docs/implementation/03-pending.md` (новый подраздел «1в — исполнение»: В-1…В-7 с ответами или «исполнено по умолчанию»;
  §1 живая проверка №4 — перевыражена: потребитель «Повестка» — языком «когда» на странице Повестки; хвосты §2.3.1/§2.3.2,
  адресованные 1в, — отметки «исполнено 1в, задача N» или переадресация по §8.2 спеки; 1а новое-12 — «исполнено 1в, задача 3»;
  Б-2 №78 п. 49 — вопрос владельцу (спека §8.2)).
- Создать (леджер `$L`): `remainders-1v.md` (отступления §13 с адресами снятия; мёртвые экспорты живых модулей Бюджета —
  «срез Бюджет»; эрраты плана; minor (deferred) из `progress.md`), `handoff-budget.md`.

**Интерфейсы:**
- Consumes: всё, что сделали задачи 1–13; `facts-plan.md`, `progress.md`, эрраты плана.
- Produces: документы в состоянии ПОСЛЕ 1в; `handoff-budget.md` — вход автора спеки среза «Бюджет».

- [ ] **Шаг 1: перезамер промпта** — `cd $W && bun scripts/prompt-size.ts > $T/t14size.log 2>&1`; байты слоёв 1 и 5 — в
  `01-architecture.md` (сверить с записью задачи 11).
- [ ] **Шаг 2: PRD и карта реализации** — по «Файлам»; D47: «Повестка и язык контрактов: запрос спрашивает даты „когда“ и
  слоты любого контракта из любого расширения; параметр страницы „период“ и группировка по дням — общие механизмы; Повестка —
  страница хоста из блоков вместо Upcoming и подписки; Бюджет — отдельным срезом с целевой картиной; старые экраны удалены» с
  обоснованием из спеки §0 и Р-1…Р-12, К-1…К-3; «Заменяет/уточняет» — концепция §3.2, §4.4, §13 (ревизия 4), D43 (канон, ревизия
  8 реформы), D46 (навигация хоста, `/agenda`). Числа — из фактического HEAD.
- [ ] **Шаг 3: ранбук** — чек-лист «Деплой среза 1в» по задаче 16.
- [ ] **Шаг 4: `03-pending.md`** — по «Файлам».
- [ ] **Шаг 5: леджер.** `$L/remainders-1v.md`; `$L/handoff-budget.md`:
  1. итоговая форма адреса слота, значения контракта и `$`-ссылки: типы `QueryContractAddress`, `QueryFieldRef`,
     `QueryParamValue` дословно; поле роли слота `value_role`; `contractValueRuleOf`, `CONTRACT_VALUE_RULES`;
  2. словарь токенов (`QUERY_DATE_TOKEN_LABELS`, `tokenEdges`) и правило краёв; начало недели (как решён В-1);
  3. форма ответа `entity.blocks`: `groups` (`BlockDayGroup`, `BlockGroupRow`, `BlockRowAt`), `sums` по валютам, валюта
     `latest`, `today`, `timeZone`, `closedIds`, вход `params` — дословно;
  4. результат проверки `parents_of=this via=ref` (§3.9; тест задачи 3, шаг 1 (е)) — работает или что наблюдается;
  5. что осталось отступлениями §13 (таблица с адресами снятия, касающимися Бюджета);
  6. список требований спеки §7.3, дополненный фактами исполнения (где лежат ручки `budget.*`, `import.*`, гейт `import.*`,
     `enableFinanceForTest`, `RESERVED_APP_KEYS`, вариант `budget` ключа поставки, мёртвые экспорты модулей Бюджета);
  7. новый HEAD ветки и числа сьютов; вес чанка `DetailScreen` и замыкания; размер промпта.
- [ ] **Шаг 6: комментарии кода с устаревшими сроками** — `git grep -n "1б\b.*токен\|следующим срезом\|legacy-1v\|agenda.list" -- apps packages scripts`
  → каждое вхождение либо снято задачами 2, 10, 12, либо правится здесь.
- [ ] **Шаг 7: коммит (в ветке; `main` не трогается).**
```
cd $W && bun run test > $T/t14-full.log 2>&1; echo EXIT=$? && bun run lint > $T/t14-lint.log 2>&1; echo EXIT=$?
cd $W && git commit -m "docs: срез «Страницы, срез 1в» — PRD (D47), карта реализации, ранбук деплоя, 03-pending

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- docs/prd docs/implementation apps packages scripts
```

### Задача 15: Финальное ревью ветки и фикс-волна

**Зачем:** поштучные гейты не видят сквозных осей: один запрос от текста до пикселя (текст → разбор с местом → подстановка →
окно материализации → SQL по привязкам → раскладка → провод → лента), одна запись во времени (правило «даты»: закрыть →
«Сегодня» зачёркнутой → назавтра ушла; отменить → ушла; вернуть в работу → на свои даты), одна запись поставки (эталон →
сев → прод-операция → «Вернуть как было» у снятого ключа). Ревью — после задачи 14 и ДО первой прод-команды задачи 16.
Исполнитель — координатор: собирает пакет, диспатчит, ведёт учёт; код появляется только в фикс-волне.

**Файлы:**
- Создать (леджер `$L/final/`): `final-review-pack.md`, `area-{A,B1,B2,C}.diff`, `paths-{A,B1,B2,C}.txt` (разбиение без
  пропусков и пересечений), `review-{A,B1,B2,C}.md`, `review-mutations.md`, `review-fable.md`, `refute-<id>.md`,
  `dispatch-final-fix.md`, `fix-wave.diff`, `fix-wave-report.md`, `fix-wave-review.md`.
- Изменить: код — только фикс-волной по находкам; `progress.md` — учёт ревью.

**Интерфейсы:**
- Consumes: `BASE_1V` (запись задачи 1 в `progress.md`); спека, план, `facts-plan.md`, `recon-plan-*.md`.
- Produces: APPROVE гейта фикс-волны; сводка находок.

- [ ] **Шаг 1: пакет.** `git diff --stat $BASE_1V..HEAD`; области: **A** — `packages/shared`; **B1** — `apps/server/src/query`,
  `recurring`, `routers/entity-blocks.ts`, `goals`, `tools`, `llm`, `routines`; **B2** — прочий `apps/server`, `scripts`;
  **C** — `apps/web`. Дифф области > 1 МБ — делить дальше. Пакет — по шаблону оркестратора; в промпте ревьюера обязательны
  «дифф — карта, не доказательство» и «перечисли, что ДОЛЖНО было измениться, но не изменилось» (перечень обходчиков —
  явно).
- [ ] **Шаг 2: ревьюеры областей** (`model: opus`), линзы: A — канон (таблица форм §3.3, кванторы, `overdue`, края §3.4,
  схема страниц, печать ↔ разбор), обходчики, раскладка групп; B1 — SQL по привязкам и правило «даты», подстановка, отказы
  вне страниц, окно материализации, сумма по валютам, «последнее», промпты и описание тула; B2 — поставка и снятый ключ,
  миграция `0023` и уход подписки, прод-операция (`--report` без реестра, одна пачка `system`), тесты-образцы на Бюджете;
  C — переключатель и история, лента по дням в поясе владельца, вес экрана записи, уборка и сторожа.
- [ ] **Шаг 3: мутационный ревьюер** (`model: opus`, в ОТДЕЛЬНОЙ копии worktree — рулинг 1а): ключевые сторожа С1в-11 —
  правило значения «когда» (`done`; закрытое без времени — без дат), квантор «хоть одна» и исключение `overdue`, «пустое
  множество дат = истина», два края, «ровно в одном блоке» (приёмка Повестки), подстановка параметра только на сервере,
  параметр не пишется в тело, ключ группировки, сумма по валютам, гейт `import.*`, сторож перечня обходчиков — каждый
  краснеет при поломке деливерабла (не пина).
- [ ] **Шаг 4: вторая линза Fable** (`model: fable`): сквозные оси из «Зачем».
- [ ] **Шаг 5: опровержение.** Каждая Critical/Important — отдельный опровергатель (`model: opus`) пробоем по коду; ложные —
  записью в `facts-plan.md`.
- [ ] **Шаг 6: фикс-волна** одним имплементером (`model: opus`) по `dispatch-final-fix.md`; гейт фикс-волны (`model: opus`);
  полный прогон, `lint`, `typecheck`, `test:rls`, перф в порядке Ф-Г-75, сборка + `check-lazy-chunks --max-gzip
  DetailScreen=34889 --max-closure-gzip DetailScreen=329400`, `check-legacy-form --gate`, локальный `bun scripts/ops.ts check`
  против пересеянной локальной базы (список дрейфа для задачи 16). Push ветки ради CI (`main` не трогается). **ЖЁСТКАЯ
  ОСТАНОВКА:** задача 16 — только отдельным словом владельца.

### Задача 16: Прод-процедура среза 1в, репетиция на копии графа, живая приёмка владельца, итог

**Зачем:** весь срез в ветке `pages-slice-1v` и отревьюирован; `main` и прод — на коде 1б. Порядок спеки §10: `--report`
(состав §18) → миграция `0023` → пересев реестра → код → прод-операция §6.6 — с репетицией на восстановленной копии прода
(С1в-12). Окно «пересев → live» — простой на время сборки (В-2). **Исполняется только вместе с владельцем.**

**Файлы:**
- Изменить: `docs/prd/04-decision-log.md` — статус D47 «и в проде <дата>».
- Создать (леджер): `$L/step-prod-1v.md` (сценарий — ДО первой команды; образец —
  `.superpowers/sdd/2026-09-24-pages-slice-1b/step-prod-1b.md` и чек-лист ранбука задачи 14), `$L/rehearsal-1v.md`,
  `$L/acceptance-1v.md`.
- Дописать: `progress.md` (хроника и «ИТОГ СРЕЗА 1в»).

**Интерфейсы:**
- Consumes: `scripts/ops.ts` — `ping`, `check`, `census`, `dump`, `migrate`, `seed-registries`, `migrate-1v` (задача 13);
  runbook §4.3 (восстановление дампа, права); Render MCP (сервис и workspace — ранбук); `gh workflow run backup.yml`.
- Produces: прод на коде 1в; `acceptance-1v.md` — С1в-1…14 + живая приёмка 1–5 + смоук.

> **Ловушки обвязки (Б-1, Б-2, 1а, 1б).** (1) cwd сбрасывается — свой `cd` в каждом `git`/`gh`. (2) Прод-команды `ops.ts` —
> только `cd $W && bun scripts/ops.ts …`. (3) Каждая прод-команда — отдельный вызов. (4) С момента пересева старый код
> отвечает 500 на всём, что читает реестр (В-2) — шаги пересева и пуша идут подряд.

- [ ] **Шаг 1:** сценарий `$L/step-prod-1v.md` из чек-листа ранбука; ожидания каждого шага выписаны ЗАРАНЕЕ; подпись журнала
  (В-4) — подтвердить у владельца.
- [ ] **Шаг 2: предпроверки.** Ветка перебазирована на свежий `origin/main` (ff возможен); CI ветки зелёный
  (`gh run list --branch pages-slice-1v --limit 3`); финальное ревью закрыто (`ls $L/final/` — APPROVE гейта фикс-волны);
  `mcp__render__get_service` → `autoDeploy: "yes"`, `branch: main`.
- [ ] **Шаг 3:** локально — перф в порядке Ф-Г-75 → `test` → `test:rls` → `check-legacy-form --gate` → сборка web +
  `check-lazy-chunks` оба порога (засчитывается прогон задачи 15, если HEAD не двигался — записать явно).
- [ ] **Шаг 4:** `cd $W && bun scripts/ops.ts ping` → PostgreSQL 17.x.
- [ ] **Шаг 5:** `cd $W && bun scripts/ops.ts check` → EXIT 1; дрейф ровно ожидаемый (ранбук, задача 14 шаг 3); иное — СТОП.
- [ ] **Шаг 6: отчёт.** `cd $W && bun scripts/ops.ts migrate-1v --report` → весь состав §18 — владельцу:
  `agendaOwnerSubscriptions`/`agendaDeltas` ненулевые — **СТОП** (удалить — `migrate-1v --drop-agenda-rows --i-understand` только
  по слову владельца, затем повторить отчёт); `coreAgendaActions`, `tokenBoundaries` (вердикты `changed`/`refused`),
  `goalsLatestSorted`, `upcomingRefs` ненулевые — владельцу до следующего шага; план операции (`agenda`, `shellNav`, `year`,
  `upcoming`) — владельцу; `census` → «тел всего: N» (счёт ВСЕХ строк `entities`: сверка шага 13 «N + 1» верна, только если
  владелец в окне между шагами ничего не создаёт — иначе сверять наличие записи `supply_key = agenda`).
- [ ] **Шаг 7: репетиция на копии (С1в-12).** `cd $W && bun scripts/ops.ts dump <каталог вне git>` → восстановление в локальную
  базу `orbis_rehearsal_1v` по ранбуку §4.3 (права — вручную, дамп без привилегий) → на ней В ПОРЯДКЕ §10 (С1в-12):
  `ORBIS_REHEARSAL_DSN=<DSN> bun scripts/ops.ts migrate-1v --rehearsal --report` (состояние ДО `0023`: встроенная строка
  `orbis/agenda` на месте — проверка, что отчёт не грузит реестр) →
  `DATABASE_URL_ADMIN=<DSN репетиции> bun run --filter @orbis/server db:migrate` (`0023`; запасной путь —
  `cd $W/apps/server && DATABASE_URL_ADMIN=<DSN> bunx drizzle-kit migrate`) →
  `DATABASE_URL_ADMIN=<DSN репетиции> bun scripts/seed-registries.ts` → `… migrate-1v --rehearsal --apply --i-understand` →
  повтор `--report` (план — `agenda: 'exists'`) → проверка: Повестка создана, навигация хоста — по §6.6 п. 2,
  «Год» — по статусу поставки, Upcoming в архиве или оставлена по правилу, ОДНА запись журнала с источником `system` (в видимой
  ленте ничего), прочие записи и настройки не тронуты (счётчики и `updated_at` до/после); повтор `--apply` — «уже переведён»;
  три блока Повестки на копии — каждая открытая запись с датами ровно в одном. Итог — `$L/rehearsal-1v.md`. **СТОП до слова
  владельца.** Дамп — удалить после репетиции (личные данные).
- [ ] **Шаг 8:** бэкап — `cd /Users/birzhan/projects/orbis && gh workflow run backup.yml`, дождаться `success`.
- [ ] **Шаг 9:** `cd $W && bun scripts/ops.ts migrate` → «применено 1» (миграция `0023`).
- [ ] **Шаг 10:** `cd $W && bun scripts/ops.ts seed-registries` → «подписок 1 … контрактов 7», версия system-реестров +1,
  конфликтов нет. **С этого момента старый код отвечает 500** (В-2) — шаг 11 немедленно.
- [ ] **Шаг 11:** мерж и деплой: `cd /Users/birzhan/projects/orbis && git push origin pages-slice-1v:main` → автодеплой →
  `mcp__render__list_deploys`/`get_deploy` до `live`; время окна (пересев → live) — в `progress.md`.
- [ ] **Шаг 12:** `cd $W && bun scripts/ops.ts migrate-1v --apply --i-understand` → итог как в репетиции.
- [ ] **Шаг 13:** `cd $W && bun scripts/ops.ts check` — все ✓; `census` — N шага 6 + 1 (запись «Повестка»);
  `curl -s https://orbis-64q4.onrender.com/health` — `status: ok` без `registryDrift`.
- [ ] **Шаг 14: смоук и живая приёмка владельца** (Chrome владельца и PWA на телефоне; после деплоя — «Обновить»): пять
  сценариев спеки §11 «Живая приёмка владельца» по порядку (для п. 5 — подготовка по слову владельца: Финансы включены, есть
  записи двух валют и страница с плиткой `aggregate=sum:orbis/amount`; иначе — «НЕ ВЫПОЛНЕН» с причиной); старая вкладка до «Обновить» — `CLIENT_OUTDATED`, не стёртое тело;
  MCP-клиент (переподключить): нет `import_csv_start`, `subscription_set` знает только движок `budget`; первый вход после деплоя
  не пишет ничего (`census` и счётчик журнала до/после входа). Спросить агента «что у меня на этой неделе» — «НЕ ВЫПОЛНЕН по
  кредитам», если кредитов нет.
- [ ] **Шаг 15:** `acceptance-1v.md` — таблица «№ | приёмка | носитель | исход | ссылка» по С1в-1…14 (носители — маппинг (б)
  плана) + живая приёмка + смоук; невыполнимое — «НЕ ВЫПОЛНЕН» с причиной.
- [ ] **Шаг 16:** статус D47 «и в проде <дата> (`main <хеш>`)» — docs-коммит в `main`; итог в `progress.md` (что в проде, счёт
  ревью, остатки владельцу, уроки); `git worktree remove .claude/worktrees/pages-slice-1v` (ветка остаётся); доклад владельцу.

---

## Эрраты спеки (спеку правит владелец ревизией; план исполняет по правой колонке)

| # | Адрес спеки | Что опровергнуто | Предложенная правка |
|---|---|---|---|
| Э-1 | §3.4 «Начало недели — понедельник (константа 1в)»; §13 «настройка графа, когда понадобится» | посылка §13 опровергнута: настройка уже есть — `user_settings.weekStartDay` (`monday|sunday`, `db/schema.ts:192`), ручка `routers/user.ts:40`, выбор в «Общих» (`settings/GeneralForm.tsx:29-72`) (Д-18) | предложение владельцу: «`this_week` начинается с `weekStartDay` владельца (запасной — понедельник)», строку §13 снять; до ответа (В-1) план исполняет букву §3.4 — константу (задача 2) |
| Э-2 | §3.8 «сторож статичности `static.ts` получает новые узлы» | `static.ts` зовёт только `registry/ops.ts:197` (`scope`, `ref.target`); `entity_query`, `user_query`, `orbis/progress_source`, `over` через него не идут (Д-3) | «`$` и `group` отвергает базовая схема дерева и разбор без места страницы — на всех входах вне тел страниц и шаблонов» (РП-5, задачи 4, 6) |
| Э-3 | §3.3, §3.4 формы `from=T`, `to=T` | текстовых форм `from=`/`to=` нет: это односторонний `range`, текстом `>=T`/`<=T`, печать та же (Д-4) | «`>=T` (он же `range {from:T}`) и `<=T` (`range {to:T}`)» |
| Э-4 | §7.4 плашки «отдельным срезом» — два места | третье место текста «следующим срезом» — плашка правила открытия `features/apps/OpenPlaqueList.tsx:47-48` (`/a/budget/r/…`) | добавить третье место (задача 12) |
| Э-5 | §8.1 перечень модулей-сирот; §8.2 Б-2 №73 → «1в» | сироты также `features/budget/useBudget.ts`, `ui/Sheet.tsx`; тест с устаревшим отказом (№73) — тест самого `EnvelopeCreateSheet` (`EnvelopeCard.test.tsx:372-389`), модуль-сирота уходит (Д-19) | «№73 закрывается удалением `EnvelopeCreateSheet`»; перечень сирот — «план переснимает» (уже сказано) |
| Э-6 | §3.4 перепись «тела страниц, шаблонов и заметок, `progress_source`, `over`» | деревья с токенами лежат ещё в закреплённых версиях (`entity_versions`) и в журнале отката: восстановление вернёт дерево со старым смыслом (Д-9) | версии — справочной строкой `--report`; журнал отката — цена в §9 (задача 13) |
| Э-7 | §10 порядок «пересев → код» и «скрытые цены» | роль слота внутри `slots` при строгой схеме слота и строгом загрузчике роняет старый код между пересевом и живым новым (Д-2) | в «скрытые цены» — «окно пересев → live: простой на время сборки (как В-3 1б)» (В-2) |
| Э-8 | С1в-14 «база Повестки — бюджет `agenda:horizon`, перевыраженный на пачку» | `agenda:horizon` меряет замороженный текст `entity.query` (база D21), не движок; перевыражение сломало бы сравнение медиан (Д-8) | «`agenda:horizon` остаётся; база Повестки — новый ключ `agenda:page` на пачке `entity.blocks` с его бюджетом 120 мс; превышение — вопрос владельцу» (РП-20, В-7, задача 10) |
| Э-9 | §6.5 радиус «фикстура `AGENDA_DEF`, их тесты» | строка `SLOT_AMBIGUOUS` фикстуры канонических отказов и ≈10 сьютов держат Повестку как ОБРАЗЕЦ движка подписки (Ф-1в-1, Ф-1в-22) | «…перевыражаются на движке Бюджета, а не удаляются» (задача 10) |
| Э-10 | §5.2, §8.2 п. 42 «строка `EntityRow` делает зачёркивание верным и для набора, заданного условием» | вычислитель предикатов E есть только на сервере; строка, считаемая в браузере, предикатный набор не вычислит (Д-12) | «признак „закрыто“ блока данных — от сервера (`closedIds`); прочие списки (Browser, строка экрана записи) — по списку классов, остаток» (РП-12, задачи 6, 8) |
| Э-11 | §3.8 «`entity_query` и запросы рутин понимают…» | отдельного входа запросов у рутин нет: рутина зовёт тот же тул через `dispatchTool` (`routines/runner.ts:409`) | «…рутины — через те же тулы» (справочно) |
| Э-12 | §6.6 п. 2 «статус „как в поставке / изменено вами“ — по сравнению отпечатков» | статус считается сравнением печати записи с текстом эталона (`supplyStatusOf`, `print.ts:139-157`); отпечаток отличает версии эталона, не правку владельца | «…по сравнению печати записи с текстом эталона» |
| Э-13 | §8.1 «`features/agenda/useAgenda.ts` … удаляется» | в нём единственные в web форматтеры дня и времени в поясе владельца, нужные колонке времени (Д-20); сервер и тип провода, на которых он стоит, уходят в задаче 10 | «…удаляется вместе с ручкой `agenda.list` после переноса форматтеров в чанк ленты (`day-format.ts`)» (задачи 7, 10) |
| Э-14 | §6.5 «вызовы `agenda.list` в `lib/invalidate.ts` и тестовой обвязке web» | в обвязке вызова нет с 1б (только комментарий `harness.tsx:138-140`) | справочно |

## Маппинг (а): нормативные утверждения спеки §3–§10 → задача и шаг

| § | Утверждение | Задача / шаг |
|---|---|---|
| 3.1 | адрес `<контракт>.<слот>` — значения свойств, привязанных к слоту аспектами на записи; тип адреса — тип слота | 1 / ш. 4–5, 7–8 |
| 3.1 | работает у любого контракта со слотами (`money-movement` — закладка Бюджета) | 1 / ш. 7 (`orbis/money-movement.amount`) |
| 3.1 | места: условие, `sortBy`, `group`, `aggregate`; `columns` — только свойства | 1 / ш. 4 (а), (е); 6 / ш. 1 (а) |
| 3.1 | несколько привязок: условие — хоть одна; сортировка и группировка — самая ранняя (даты) или меньший ранг | 1 / ш. 7 (`T10`), ш. 7 (д) (ранг, РП-21), ш. 8; 6 / ш. 1 (б), (в) (`group=day:` по адресу слота) |
| 3.1 | выключенное расширение: привязки адресуются | 1 / ш. 7 (`F1` при маске) |
| 3.1 | запись через точку; сторож «контракт со значением ≠ ключ свойства» | 1 / ш. 2 (а), ш. 4 (а) (`orbis/recurrence`) |
| 3.2 | значение объявляет контракт; целиком адресуется только объявивший | 1 / ш. 4 (а) (`NO_CONTRACT_VALUE`) |
| 3.2 | хранение — признак роли внутри `slots`, без поля верхнего уровня | 1 / ш. 2–3 (РП-4) |
| 3.2 | правило значения — закрытый набор в коде, одно правило «даты» (три пункта) | 1 / ш. 3, ш. 8 |
| 3.2 | правило читает набор `closed` «завершаемости» (К-1) | 1 / ш. 8 (фильтр правила), ш. 11 (б) |
| 3.3 | хоть одна дата; исключение — `overdue`; каждое условие отдельно; интервал — одним условием | 1 / ш. 7, ш. 11 (в), (г), (д′) |
| 3.3 | таблица форм (`=`, `in`, литерал; `<`; `<=`; `>`; `>=`; `range`; `overdue`; `!`, `!=`) | 1 / ш. 7; 2 / ш. 1 (в) (токены) |
| 3.3 | ключ `sortBy` — ранняя из дат, удовлетворяющих каждому положительному условию; запасные правила; без дат — в конце | 1 / ш. 7 (строки `>=2026-07-16, sortBy` и «два сравнения + sortBy»), ш. 8, ш. 11 (д) |
| 3.3 | `group=day:` — тот же ключ по дню; без даты — «Без даты» последней | 6 / ш. 1 (б), (в) |
| 3.3 | запись без дат — ни в одной положительной форме, отрицания проходит | 1 / ш. 7 (`!orbis/when=next_7d`), ш. 11 (г) |
| 3.3 | для периода от сегодня три блока Повестки делят открытые записи без остатка и пересечений | 9 / ш. 1 (д) |
| 3.3 | «начать во вторник, срок в четверг» — во вторнике, строка показывает срок | 6 / ш. 1 (в) (`T9`); 7 / ш. 1 (б) |
| 3.3 | «начал вчера, срок через месяц» — не просрочена, в «Дальше» с ключом по сроку | 1 / ш. 7 (`T8`); 9 / ш. 1 (д) |
| 3.3 | `this_week` Повестке не предлагается | 9 / «Интерфейсы» (`options=next_7d|next_14d`), ш. 1 (б) |
| 3.3 | `overdue` у свойства и у значения — разный смысл; `overdue` истинно для сделанного — «просроченное» с `class=open` | 1 / ш. 7 (`T4`); 9 (тело); 11 (описание тула) |
| 3.4 | четыре новых токена; смысл `=` у прежних не меняется; разрешаются на сервере по «сегодня» и поясу | 2 / ш. 1 (а), (в) |
| 3.4 | таблица краёв; одно правило двух краёв; отказ несуществующего края при разборе и компиляции (`ast`, `body_doc`, `progress_source`); правило якоря снимается | 2 / ш. 1 (б), (г), ш. 2, ш. 3 (а), (в) |
| 3.4 | перепись деревьев с токеном-границей до выкатки; ненулевой счёт — владельцу | 2 (`tokenBoundaryForms`); 13 / ш. 2 (б); 16 / ш. 6 |
| 3.4 | подписи — один словарь в shared; web-список уходит | 2 / ш. 1 (а), (е) (РП-17) |
| 3.4 | начало недели — понедельник | 2 / ш. 1 (в) (Э-1, В-1) |
| 3.4 | окно материализации от новых токенов и от адреса «когда»; горизонт и ретро-пол прежние | 1 / ш. 7 (г), ш. 8; 2 / ш. 1 (д) |
| 3.5 | `id` — последний ключ во всех выборках канона; без `sortBy` — `id`; эталон SQL пересдаётся | 3 / ш. 1 (б), (д), ш. 2 |
| 3.6 | денежное — по привязке `amount` аспекта на записи; валюта — слот `currency` той же привязки; нет — валюта владельца; не денежное — числом | 3 / ш. 1 (в), ш. 3 (б), (в) |
| 3.6 | сумма по валютам раздельно; плитка: одна / две–три / больше — плашка | 3 / ш. 1 (в) (плитка и `user_query`), (ж); прогресс цели — одним числом (В-5) |
| 3.7 | «последнее» — первая запись порядка блока; без `sortBy` — по правке; денежное — с валютой; общий компилятор с прогрессом цели; цели с `sortBy` — в перепись | 3 / ш. 1 (в), (г); 13 / ш. 2 (б) (`goalsLatestSorted`) |
| 3.8 | `entity_query` и рутины понимают адрес, значение и новые токены | 1 (канон), 2; 11 / ш. 1 (б) (Э-11) |
| 3.8 | `$` и `group` — только в блоках страниц и шаблонов; отказ с подсказкой в `entity_query`, рутинах, `progress_source`, `ref.target`, области правил | 4 / ш. 1 (и); 6 / ш. 1 (г) (Э-2) |
| 3.8 | правило «абсолютная дата на странице» — и для адреса слота и значения | 1 / ш. 4 (д) |
| 3.8 | описание `entity_query`: пример и три правила | 11 / ш. 1 (б) |
| 3.8 | схема тула растёт — перезамер `prompt-size`, эталон тулов | 1 / ш. 11; 2 / ш. 2; 11 / ш. 2–3; 14 / ш. 1 |
| 3.9 | серверный тест `parents_of=this via=ref`; не чинить — результат во вход Бюджета | 3 / ш. 1 (е), ш. 2; 14 / ш. 5 п. 4 |
| 4.1 | слоты `moment`, `deadline`, `done`, `end`, `all_day` — типы, роли, привязки поставки | 1 / ш. 2–3 |
| 4.1 | `done` ставит `task_completed_at` при входе в «сделано», снимает при уходе; отмена не ставит | 1 / ш. 6 (`T7`), ш. 7 (а), (б) |
| 4.1 | новые слоты необязательны; слоты и привязки — jsonb, миграции нет | 1 / ш. 3; «Глобальные ограничения» |
| 4.2 | значение «даты»: `done` → только `done`; закрытое без него — дат нет; иначе `moment`, `deadline`; `end`/`all_day` не входят | 1 / ш. 7, ш. 8, ш. 11 (а), (б) |
| 4.2 | следствия: закрытое сегодня — в «Сегодня»; сделанное раньше и отменённое уходят; вернул в работу — на свои даты; событие без «завершаемости» — на своих датах | 1 / ш. 7; 9 / ш. 1 (д) |
| 4.3 | строки читают «весь день» и «конец» слотами | 8 / ш. 1; 6 (подробности времени по привязкам) |
| 4.3 | движок подписки Повестки уходит; параметры `inherit` правила материализации не меняются | 10; `inherit` не трогается (сторож — существующие тесты `materialize.test.ts` в полном прогоне задачи 1) |
| 5.1 | объявление `{{param}}` и таблица ключей (имя, `type`, `options` 1–8, `default` ∈ `options`, `title`) | 4 / ш. 1 (а) |
| 5.1 | переключатель на месте блока: ≤ 4 — сегменты, больше — список; подписи из словаря | 5 / ш. 1 (в) |
| 5.1 | ссылка `$<имя>`; одна пачка; подстановка на сервере; проверка значения | 4 / ш. 1 (ж), (з); 5 / ш. 1 (б), ш. 3 (а) |
| 5.1 | бейдж раздела — первый блок данных по умолчаниям; неизвестное имя — отказ бейджа | 4 / ш. 1 (з) |
| 5.1 | текущее значение — в истории экрана (раздел, ссылка, «Записи», ярлык); у раздела переживает перезапуск; не в теле и не в адресе | 5 / ш. 1 (а), (б), ш. 3 (б), (в) |
| 5.1 | место: страница и шаблон; заметка — плашка, текст сохраняется; неизвестное имя, неверное умолчание — плашки | 4 / ш. 1 (б), ш. 4; 5 / ш. 1 (г) |
| 5.1 | формат: подъём версии контракта клиента, не `DOC_SCHEMA_VERSION`; все копии правил грамматики; дифф Ш1 — единицей | 3 / ш. 1 (а); 4 / ш. 1 (в), (к) |
| 5.2 | ключ `group=day:<адрес даты>`; формы `list`/`compact`; с `table`/`tile` — ошибка разбора | 6 / ш. 1 (а) |
| 5.2 | день записи — день ключа; период блока — интервал `=T` на том же адресе | 6 / ш. 1 (б), (в), ш. 3 |
| 5.2 | раскладку считает сервер в поясе владельца; ответ несёт `today` и пояс; клиент рисует подписи | 6 / ш. 1 (в); 7 / ш. 1 (а), (б) |
| 5.2 | пустые дни до 31 дня — «свободно»; иначе только непустые | 6 / ш. 1 (б); 7 / ш. 1 (б) |
| 5.2 | какая дата поставила запись в день — `done > moment > deadline` | 6 / ш. 1 (б), ш. 4 (б) |
| 5.2 | колонка времени (время, диапазон, «→ дата», «весь день», «срок», «сделано …») | 6 / ш. 1 (б) (данные); 7 / ш. 1 (а) (подписи) |
| 5.2 | многодневное — в дне начала; внутри дня — сначала без времени, затем по времени | 6 / ш. 1 (б) |
| 5.2 | дата строки не печатается, если совпадает с днём группы | 7 / ш. 1 (б) |
| 5.2 | закрытые зачёркнуты (п. 42) | 6 / ш. 1 (в) (`closedIds`); 7 / ш. 1 (б); 8 / ш. 1 (в) |
| 5.2 | лимит 500 на блок; «ещё N» в конце последней группы | 6 / ш. 1 (в), ш. 3; 7 / ш. 1 (б) |
| 5.2 | шаблоны повторов исключаются явно | 9 (тело), ш. 1 (д) |
| 6.1 | тело Повестки — запись поставки `agenda`, дом — хост; смысл трёх блоков; варианты горизонта — только от сегодня; лента только показывает | 9 / «Интерфейсы», ш. 1 (б), (д); 7 (тап — как у строк блока) |
| 6.2 | навигация хоста: Повестка на месте Upcoming | 9 / ш. 1 (а), (в), (е); 13 / ш. 2 (в), (е) |
| 6.2 | бейдж — число первого блока данных («Просрочено») | 9 / ш. 1 (д) |
| 6.2 | `/agenda` открывает запись поставки `agenda` в хосте | 9 / ш. 1 (е), ш. 4 |
| 6.3 | поставка не несёт Upcoming; снятый ключ — отдельным списком; «Обновления» не предлагают; «вернуть как было» — род из записи и `supply_text` | 9 / ш. 1 (а), (г), ш. 3 |
| 6.3 | Daily Planning, All Tasks, Жизнь, Рутины не меняются | 9 / ш. 1 (а) (эталоны прочих ключей — прежние) |
| 6.4 | промпт: Upcoming → Повестка; новая версия | 11 / ш. 1 (а) |
| 6.4 | эталон «Года» — Повестка | 9 / «Интерфейсы», ш. 1 (а) |
| 6.5 | встроенная строка `orbis/agenda` — миграцией `0023` до кода | 10 / ш. 1 (а), ш. 2; 16 / ш. 9 |
| 6.5 | строки и дельты владельца — счёт в `--report` до миграции; ненулевой — СТОП, удаление операцией `ops.ts` по слову владельца | 13 / ш. 2 (а), (и), (к); 16 / ш. 6 |
| 6.5 | поверхность, `SURFACE_ENGINE`, вариант схемы, `subscription_set`, подписи — уходят | 10 / ш. 1 (б), ш. 3 |
| 6.5 | `SURFACE_RE` — в радиусе | 10 / «Файлы» — не меняется (голова `core` законна; запись стережёт словарь `SURFACES`, R-7 1б) |
| 6.5 | действия владельца на `core/agenda` — счёт в `--report`; `core/postpone_overdue` не трогаем | 13 / ш. 2 (а); 10 (действие не меняется) |
| 6.5 | движок, ручка, контракт провода, фикстура, их тесты; `agenda.list` в web | 10 / ш. 3, ш. 5 (Э-9, Э-14) |
| 6.5 | гейт §С8-18 и живая проверка №4 перевыражаются на `orbis/when` | 1 / ш. 9; 14 / «Файлы» (`03-pending` §1) |
| 6.6 | одна пачка исполнителя, источник `system`, Undo есть; п. 1–4 | 13 / ш. 2 (в)–(ж), ш. 3; 16 / ш. 7, ш. 12 |
| 7.1–7.3 | целевая картина и требования Бюджету | 14 / ш. 2 (`03-budget.md`), ш. 5 (`handoff-budget.md` п. 6) |
| 7.4 | Финансы выключены по умолчанию — 1в не меняет | не меняется (сторож — тесты заведения графа в задаче 9, ш. 1 (в)) |
| 7.4 | `import_csv_start` снят из реестра тулов и манифеста; гейт `import.*` — на `finance`; описание Финансов | 11 / ш. 1 (б)–(г), ш. 4 (а) |
| 7.4 | ручки `budget.*`, `import.*` остаются; плашки «отдельным срезом» | 12 / «Файлы» (не трогать), ш. 1 (в) (Э-4) |
| 8.1 | `legacy-1v` и исключения удаляются; модуль без живого импортёра удаляется; тесты `EnvelopeCreateSheet` разделяются | 12 / ш. 1–3 (Э-5) |
| 8.2 | Б-2 №100 | 8 / ш. 1 (а), (б) |
| 8.2 | Б-2 №78 п. 42 | 6 / ш. 1 (в); 8 / ш. 1 (в) (Э-10) |
| 8.2 | Б-2 №78 п. 43 | 8 / ш. 1 (а) |
| 8.2 | Б-2 №73 | 12 (удаление модуля, Э-5) |
| 8.2 | 1а новое-12, дефект `sum` | 3 / ш. 1 (в), (ж) |
| 8.2 | №72, №94 — снимаются удалением | 12; 10 |
| 8.2 | хвосты Бюджета, среза 2, п. 49 — адресуются | 14 / ш. 4, ш. 5 |
| 10 | одна миграция `0023` — только данные; ещё одна — СТОП | 10 / ш. 2; «Глобальные ограничения» |
| 10 | скрытые цены (пины слотов, эталоны, `surfaces.json`, фикстура отказов, эталон SQL, `prompt-size`, счёт примет, матрица мест, гейт §С8-18, сьюты движка) | 1 / ш. 2, ш. 9, ш. 11; 2 / ш. 2; 3 / ш. 2; 4 / ш. 1 (б), (к); 10 / ш. 3; 11 / ш. 2–3 |
| 10 | порядок выкатки: `--report` → `0023` → пересев → код → прод-операция | 16 / ш. 6–12 |
| 10 | нет тихих записей сверх прод-операции | 13 / ш. 2 (а), (в), (м); «Глобальные ограничения» |

## Маппинг (б): приёмка С1в-1…14 → задача и шаг

| № | Приёмка | Задача / шаг |
|---|---|---|
| С1в-1 | значение и слоты «когда»: таблица случаев, формы, без дат, два сравнения, `overdue` у сделанного, `done`-дата, «Дальше», ключ, свой аспект владельца (гейт §С8-18), выключенное расширение | 1 / ш. 7, ш. 9; 2 / ш. 1 (в) |
| С1в-2 | адрес слота: любой контракт, несколько привязок, тип, места, разбор ↔ печать, сторож ключей | 1 / ш. 2 (а), ш. 4, ш. 7 |
| С1в-3 | токены: четыре новых в поясе владельца, неделя, края всех восьми, отказ края при разборе и компиляции, перепись, словарь, окно материализации | 2 / ш. 1; 13 / ш. 2 (б) |
| С1в-4 | параметр: объявление, переключатель, одна пачка, подстановка и проверка на сервере, история, перезапуск, не в теле и адресе, бейдж, плашки | 4 / ш. 1; 5 / ш. 1 |
| С1в-5 | группировка: «Без даты», дни в поясе, «свободно», приоритет, колонка времени, без времени первыми, дата строки, зачёркивание, «ещё N», группы — сервер, `table`/`tile` — ошибка, `group` вне страниц — отказ | 6 / ш. 1; 7 / ш. 1 |
| С1в-6 | Повестка: сделанное сегодня зачёркнуто, сделанное раньше и отменённое ушли, ровно в одном блоке, бейдж, `/agenda`, место в навигации | 9 / ш. 1 (д), (е) |
| С1в-7 | сумма, «последнее», порядок | 3 / ш. 1 (в)–(д), (ж) |
| С1в-8 | агент: описание, эталон тулов, `prompt-size`, `$`/`group` в `entity_query` — отказ; поведение модели — живьём | 11 / ш. 1–3; 4 / ш. 1 (и); 6 / ш. 1 (г); 16 / ш. 14 |
| С1в-9 | «кто ссылается» — тест и вход Бюджета | 3 / ш. 1 (е); 14 / ш. 5 п. 4 |
| С1в-10 | удаление: `legacy-1v`, сироты, нет висящих импортов, сторож без `OUT_OF_SCOPE`, подписки Повестки нет, `import_csv_start` нет, `import.*` при выключенных Финансах — `MODULE_DISABLED`, плашки | 12 / ш. 1–3; 10 / ш. 1 (б), (г); 11 / ш. 1 (б)–(г) |
| С1в-11 | мутационная проверка: правило «когда», квантор и `overdue`, пустое множество, два края, «ровно в одном блоке», подстановка на сервере, не в теле, ключ группировки, сумма по валютам, гейт `import.*` | 1 / ш. 11; 2 / ш. 3; 3 / ш. 3; 4 / ш. 5; 5 / ш. 3; 6 / ш. 4; 9 / ш. 5; 11 / ш. 4; 15 / ш. 3 |
| С1в-12 | прод-операция на копии графа в порядке §10 | 13 / ш. 2; 16 / ш. 7, ш. 12 |
| С1в-13 | хвосты Б-2 №78 п. 42, п. 43, №73 | 8 / ш. 1; 12 (№73, Э-5) |
| С1в-14 | скорость: адрес и значение «когда» в `test:perf:graph`; база Повестки; вес чанков | 1 / ш. 9; 10 / ш. 4 (Э-8); 5 / ш. 2; 7 / ш. 2 |

## Маппинг (в): открытые пункты §18 спеки → где решены

| Пункт §18 | Где решён |
|---|---|
| форма признака роли слота в `slots` и её проверка схемой; сторож «контракт со значением ≠ ключ свойства» | РП-4; задача 1, ш. 2–3 (В-2 — цена окна) |
| узел адреса слота и значения в Q-AST; перечень обходчиков | РП-2, РП-3; раздел «Обходчики дерева запроса»; задача 1 |
| узел `$`-ссылки; поле параметров во входе `entity.blocks` (блок); `CompileCtx`; разбор `{{param}}` для бейджа | РП-6; задача 4 (параметры подставляются до компиляции — `CompileCtx` их не несёт; бейдж — `paramDeclsOf`) |
| форма ответа с группами (`today`, пояс, какая дата поставила строку, подробности времени) | РП-11; задача 6 («Интерфейсы») |
| компиляция значения «когда» и адреса слота в SQL (самая ранняя, «все позади», исключение закрытого) и замеры | задача 1, ш. 8–9 |
| перечень форм с токеном-границей и перепись корпуса | задача 2 (`tokenBoundaryForms`, таблица `recon-plan-core.md` §12); задача 13 (`--report`) |
| новая версия промпта и рутины; эталон тулов | задача 11 (v9, routine-v5) |
| представление снятого ключа `upcoming`; тест «у каждого ключа ровно один эталон»; размер сева мира | РП-10; задача 9, ш. 1 (а) |
| состав `--report` прод-процедуры | РП-14; задача 13 (`Migrate1vReport`) |
| сверка фактов с `handoff-1v.md` (имена аспектов поставки, `host-shell`, `SUPPLY_KEYS`, `RESERVED_APP_KEYS`, `LegacyAddress`, версия клиента, номер миграции) | «Что установила разведка HEAD», Ф-1в-3, Ф-1в-27: подтверждено на `ae3b710d` — аспекты `orbis/app`/`orbis/supply`, эталон `host-shell` (навигация с `upcoming`), десять `SUPPLY_KEYS`, `RESERVED_APP_KEYS = ['budget']`, `LegacyAddress {reserved: budget|agenda}`, клиент `0.4.0` → `0.5.0` (задача 3), следующая миграция `0023` |

## Самопроверка плана

- **Покрытие спеки:** маппинги (а)–(в) без пустых строк; §9 (натяжения) — не норматив, цены вынесены в D47 (задача 14) и
  «Вопросы владельцу»; §11 «живая приёмка» — задача 16, шаг 14; §12–§17 — порядок (раздел «Порядок»), отступления §13 —
  `remainders-1v.md` (задача 14), путь §14 — форма `group`/`param`/адреса его не закрывает (`QueryGroup.by`, `PARAM_TYPES`,
  `contractValueRuleOf` — расширяемы без смены формы).
- **Заглушки:** «TBD», «TODO», «потом» в плане нет; временная заглушка одна — вид `param` в показе до задачи 5 (задача 4,
  шаг 4, с докблоком «снимает задача 5»).
- **Согласованность имён:** `QueryContractAddress`, `QueryFieldRef`, `isContractAddress`, `fieldRefKey` (1 → 3, 6);
  `formatSums` (3, плитка и карточка `user_query`); `dayInTimeZone`, `timeInTimeZone`, `dayHeaderLabel`, `rowTimeLabel` — модуль
  `features/page/blocks/day-format.ts` (7); `LIST_KEYS: ReadonlySet<SupplyKeyValue>` (9); снятие `migrate-1b` — задача 9, образец IO
  для `migrate-1v` — `git show ae3b710d:…/migrate-1b.ts` (13);
  `whenDatesSql`, `slotValuesSql`, `addressCond`, `addressSortKey` (1 → 3, 6); `seedWhenWorld(graph, {today, timeZone})` (1 → 2,
  6, 9); `tokenEdges`, `QUERY_DATE_TOKEN_LABELS`, `tokenBoundaryForms`, `CompileCtx.weekStart` (2 → 4, 5, 6, 13);
  `CompileCtx.ownerCurrency`, `BlockSum`, `closedIds` (3 → 6, 7, 8); `PageParamDecl`, `paramDeclsOf`, `paramNamesIn`,
  `pageOnlyFeatureIn`, `pageQueryAstSchema`, `PAGE_ONLY_HINT`, `substituteParams` (4 → 5, 6); `PARAM_VIEW_PREFIX` (5);
  `QueryGroup`, `BlockRowAt`, `BlockGroupRow`, `BlockDayGroup`, `layoutDayGroups`, `EntityBlocksResult.today/timeZone` (6 → 7);
  `rowAllDayOf` (8); `SUPPLY_KEYS`, `RETIRED_SUPPLY_KEYS`, `SUPPLY_KEY_VALUES`, `AGENDA_BODY`, `LEGACY_SEED_LIST_SLUGS` (9 → 13);
  `MIGRATE_1V_LABEL`, `Migrate1vReport` (13 → 16) — сверено по «Интерфейсам».
- **Фокус ревью:** пять входов — у каждого тест в задаче-владельце (п. 1 — 6/ш. 1 (в), 7/ш. 1 (а); п. 2 — 3/ш. 1 (а); п. 3 —
  4/ш. 1 (з), ш. 4, 5/ш. 1 (г); п. 4 — 1/ш. 7, 6/ш. 1 (б); п. 5 — 9/ш. 1 (г), (е)).
- **Промежуточные состояния:** раздел «Порядок и параллельность»; единственная нерабочая форма между задачами — `{{param}}`
  до задачи 5 (данных с ним нет до задачи 9).
