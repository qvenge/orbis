// §9.1: совместимость клиента (Task 14) — клиент старше минимальной версии
// получает PRECONDITION_FAILED с cause { code: 'CLIENT_OUTDATED', min }.
export const MIN_COMPATIBLE_CLIENT_VERSION = '0.1.0';
export const CLIENT_VERSION_HEADER = 'x-orbis-client-version';

// §7.7/§9.2 (carried-решение плана 1b): максимум вызовов провайдера в одном
// tool-цикле ai.sendMessage. Превышение — не ошибка: принудительный финальный
// ответ с пометкой «[цикл остановлен: достигнут лимит шагов]» (Task 9).
export const MAX_AGENT_STEPS = 8;

/**
 * Системные роли рёбер v1 (§А4-3 реформы свойств): роль — единственная истина ребра, и она
 * ЗАМЕНИЛА закрытый список из четырёх типов (расщепление `parent` на пять разных отношений
 * — inv §1 п.8). Порядок — нормативный `rank` реестра.
 *
 * Колонка `relations.relation_type` ещё жива, но она ПРОИЗВОДНАЯ: её считает
 * `projectLegacyRelationType(role)` на каждой вставке, и снимает её contract-миграция 0017.
 * Собственного списка значений у неё больше нет — единственный он здесь.
 *
 * `alternative-of` и `supersedes` — роли карты работ: встроенные записи сида уже в v1, без
 * потребителя-кода (дешевле заложить при пересеве, чем досевать потом).
 *
 * Список живёт здесь, рядом с `BUILTIN_ASPECT_IDS`, а не в `registry/builtin-roles.ts`:
 * у имени должен быть ровно один дом, иначе `export *` из двух файлов пакета делает его
 * неоднозначным. Определения ролей ссылаются на этот список и пиннятся тестом.
 */
export const RELATION_ROLE_IDS = [
  'subitem',
  'ticket',
  'run',
  'envelope-binding',
  'category-parent',
  'dependency',
  'mention',
  'instance-of',
  'ref',
  'alternative-of',
  'supersedes',
] as const;
export type RelationRoleId = (typeof RELATION_ROLE_IDS)[number];

/**
 * Роли, которые код называет ПОИМЁННО, ЧТОБЫ ЧТО-ТО С НИМИ СДЕЛАТЬ (отфильтровать, создать
 * ребро, показать секцию), — и это их единственный дом: `apps/server`, `apps/web` и сам
 * `@orbis/shared` берут их отсюда.
 *
 * ЧЕМ ЭТО УТВЕРЖДЕНИЕ ОПРОВЕРГАЕТСЯ (иначе оно ничего не стоит): грепом по id ролей в
 * `apps/*` и `packages/*` без тестов. Совпадения останутся ровно трёх видов, и ни одно из
 * них не «второй дом»:
 *   • ОПРЕДЕЛЕНИЯ ролей — `registry/builtin-roles.ts`: там роль заводится, а не называется;
 *   • ТОТАЛЬНЫЕ таблицы ПО ВСЕМ ролям — `RELATION_ROLE_IDS` ниже и `RELATION_TYPE_BY_ROLE`
 *     (`executor/legacy-form.ts`, `satisfies Record<RelationRoleId, …>`). Они перечисляют
 *     одиннадцать имён по построению, и переименование обязано валить сборку именно там;
 *   • ТЕСТОВАЯ ОБВЯЗКА, где литерал — предмет проверки: `*.test.ts`, `src/test/*`
 *     (`agent-loop-helpers.ts`, `perf.ts`) и `query/ast-fixtures.ts`. Там литерал обязан
 *     остаться независимым от константы — иначе обе стороны поедут вместе и мутация станет
 *     ненаблюдаемой (проверено: repoint константы роняет web-сьюты именно потому, что их
 *     фикстуры называют роль сами).
 *
 * Греп даст и СЛОВА-ОМОНИМЫ — они не роли, и путать их не надо: `{ kind: 'ref' }` — тип
 * ссылочного СВОЙСТВА (§А2-1), а не роль `ref`; `'mention'` встречается как пометка
 * источника backlink (`BacklinkVia`, `entity-read.ts`) и как вид подсказки редактора
 * (`SuggestKind`, `entity-editor/slash`). Одиночное имя роли где-либо ещё — нарушение этой
 * декларации, а не исключение из неё.
 *
 * Дом здесь, а не в серверном `executor/relations.ts`, потому что роль нужна ВСЕМ ТРЁМ
 * пакетам, а `@orbis/shared` — единственный, кого видят двое других. `dependency`: сервер
 * фильтрует по ней `excludeBlocked` (`query/compile.ts`), парсер грамматики разворачивает в
 * неё тот же сахар (`query/parse-ast.ts`), web рисует ею секцию «Блокировки» и шлёт её в
 * `relation.create`/`relation.delete` (`entity-detail/Blocks.tsx`). `subitem`/`ticket`: их
 * называет секция подзадач (`entity-detail/Subtasks.tsx`) и быстрый захват
 * (`browser/QuickCapture.tsx`).
 *
 * Почему это не педантизм. У web компилятор роль НЕ СТЕРЕЖЁТ: в контракте она
 * `z.string().min(1)` (`contracts/tools.ts`), в `WireRelation.role` — обычная строка. Значит
 * переименование роли в реестре валит сборку `shared` и `server` (см. `satisfies` ниже), но
 * не web — и починивший по сигналу компилятора клиент не тронет. Секция «Блокировки» тогда
 * молча опустеет (фильтр по старому имени не найдёт ничего), а кнопки продолжат слать старую
 * роль и получать рантайм-`UNKNOWN_ROLE`. Ровно тот же сценарий у сеющегося смарт-листа с
 * `excludeBlocked=true` (`seed/smart-lists.ts`), если разъедутся оси парсера и сервера.
 *
 * ДВЕ ОСИ АДРЕСАЦИИ, и это надо знать, читая список. Здесь лежат `id` ролей — то, что
 * хранит колонка `relations.role` и чем оперирует сервер. Парсер же адресует роль по `key`
 * (§А5-3: `via=` принимает key). У встроенных ролей это одно и то же — `builtin-roles.ts`
 * выводит `key` из `id`, и равенство запиннено (`registry/builtin.test.ts`, «key = id»), —
 * поэтому одна константа честно служит обеим осям. Своя строка владельца с ДРУГИМ key даст
 * парсеру честный `UNKNOWN_ROLE`, ровно как явная запись `via=dependency`, а серверный
 * фильтр по id продолжит работать: оси разошлись — и это видно, а не молча.
 *
 * `satisfies RelationRoleId`: переименование роли в нормативном списке обязано валить
 * СБОРКУ. Молча оно поменяло бы поведение везде — бюджет считал бы пустое множество трат,
 * компилятор перестал бы отсекать заблокированное, секция «Связанное» опустела бы, — и
 * каждый из этих отказов выглядел бы как «просто ничего не нашлось».
 *
 * Кто их читает: `instance-of` — материализация повторений и агрегаты (§3.1);
 * `envelope-binding` — бюджет-хук и инвариант «один budget-parent» (§4.2); `run` — глаголы
 * исполнителя и планировщик рутин (V1.4); `category-parent` — дерево категорий (§2.10);
 * `mention` — секция «Связанное» (§3.5.8); `dependency` — `excludeBlocked` грамматики §6, её
 * сахар в парсере (до Задачи 9b, которая заводит `via=` для произвольной роли) и секция
 * «Блокировки» web; `subitem` и `ticket` — секция подзадач web и быстрый захват.
 *
 * Список ПОЛНЫЙ, и это проверяемое утверждение, а не обещание: грепом по репозиторию
 * литералов этих ролей вне этого файла нет (кроме фикстур тестов, где литерал — предмет
 * проверки), а что каждая константа указывает на ТУ роль, чьё имя носит, пиннит
 * `apps/server/src/registry/roles.test.ts` по подписям из сида.
 */
export const ROLE_SUBITEM = 'subitem' satisfies RelationRoleId;
export const ROLE_TICKET = 'ticket' satisfies RelationRoleId;
export const ROLE_INSTANCE_OF = 'instance-of' satisfies RelationRoleId;
export const ROLE_ENVELOPE_BINDING = 'envelope-binding' satisfies RelationRoleId;
export const ROLE_RUN = 'run' satisfies RelationRoleId;
export const ROLE_CATEGORY_PARENT = 'category-parent' satisfies RelationRoleId;
export const ROLE_MENTION = 'mention' satisfies RelationRoleId;
export const ROLE_DEPENDENCY = 'dependency' satisfies RelationRoleId;

/**
 * Семейство иерархии (§А4-3): `children_of`/`descendants_of` без `via=` компилятор
 * разворачивает в `role IN (…)` по этому списку. `envelope-binding` в него НЕ входит —
 * конверт не родитель транзакции, он её счётчик (Ч10-С1).
 */
export const HIERARCHICAL_ROLE_IDS = [
  'subitem',
  'ticket',
  'run',
  'category-parent',
] as const satisfies readonly RelationRoleId[];

/**
 * Имя правила вычисления предков (§А8, Ч9): значение `flags.computed.rule` у
 * `orbis/parent_project`/`orbis/root_project` И имя правила в системной строке журнала о
 * пересчёте (`executor/ancestors.ts`).
 *
 * ОДНА константа на обе стороны, а не два одинаковых литерала: строка правила в реестре
 * каталога появится только в части Б (Б-2), и до неё имя живёт исключительно в коде. Пиши
 * его дважды — и переименование правила развело бы флаг свойства с журналом, а нашлось бы
 * это не сборкой и не тестом, а владельцем, читающим «пересчитано по правилу», которого в
 * реестре нет. Дом константы здесь, рядом с `RELATION_ROLE_IDS`, по той же причине: у имени
 * должен быть ровно один дом, иначе `export *` из двух файлов пакета делает его
 * неоднозначным.
 */
export const RULE_NEAREST_ANCESTOR = 'nearest_ancestor';

export const BUILTIN_ASPECT_IDS = [
  'orbis/schedule',
  'orbis/task',
  'orbis/financial',
  'orbis/note',
  'orbis/budget',
  'orbis/category',
  'orbis/memory',
  'orbis/goal',
  'orbis/project',
  'orbis/repo',
  'orbis/assignment',
  'orbis/agent-run',
  'orbis/routine',
] as const;
export type AspectId = (typeof BUILTIN_ASPECT_IDS)[number];

/** Служебные аспекты (02-core-os §3.9): не в основных выдачах, без attach_*-тула — их
 *  создаёт и правит только сервер. Одна константа на компилятор запросов и реестр тулов. */
export const SERVICE_ASPECT_IDS = ['orbis/agent-run'] as const satisfies readonly AspectId[];

/** Область гранта агента (С2): full — весь граф владельца (сегодняшнее поведение и DEFAULT
 *  колонки `agent_grants.scope`), worker — сужение до выданного тикета. Гейт по скоупу ставит
 *  Задача 7; список заведён здесь, чтобы он был один на сервер и web. */
export const GRANT_SCOPES = ['full', 'worker'] as const;
export type GrantScope = (typeof GRANT_SCOPES)[number];
