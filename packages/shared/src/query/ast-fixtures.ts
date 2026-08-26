/**
 * Эталонные Q-AST (§А5-1/§А5-7) — НОРМАТИВ, а не снимок вывода.
 *
 * Отличие от `fixtures.ts` (10 сущностей) названо в разведке: настоящий golden сегодня —
 * `apps/server/test/golden/query-sql.json`, и его докблок прямо запрещает «записать, что
 * вышло». Этот набор — того же рода опора для Задачи 9a («AST → SQL»): каждая запись
 * написана от канона §А5-7, а не срисована с парсера.
 *
 * Что в наборе:
 *  - `AST_FIXTURES` — по фикстуре на каждую конструкцию канона плюс те, что плоским текстом
 *    НЕ выражаются (`keyText: null`): OR между разными свойствами, двойное отрицание,
 *    `class` части Б — у них печать даёт скобочную форму, и обратный разбор обязан отказать;
 *  - `PRODUCTION_QUERY_TEXTS` — опись ВСЕХ боевых текстов запросов, живущих в коде сегодня,
 *    с вердиктом нового разбора на каждый: рабочее задание Задачам 9b/10c/21;
 *  - `AGENDA_QUERY_TEXTS` — key-формы трёх боевых запросов Agenda. Задача 10c подставит их
 *    в `useAgenda.ts` ДОСЛОВНО, поэтому они обязаны и разбираться, и печататься обратно
 *    байт-в-байт (`print.test.ts`);
 *  - `INEXPRESSIBLE_QUERY_TEXTS` — тексты за границей языка и опечатки: каждая обязана дать
 *    ОТКАЗ С КОДОМ, а не пустой список (§А5-3ж, приёмка §С8-3);
 *  - `FIXTURE_PARSE_REGISTRY` — реестр разбора без БД.
 *
 * Реестр фикстур = встроенные словари ПЛЮС три именованные добавки. Добавки нужны потому,
 * что во встроенном наборе нет двух свойств с одинаковой подписью (а разводка `aspect=` при
 * неоднозначном label — требование §А5-3б) и нет свойства-ловушки для эвристики `propType`.
 * Придумывать их «похоже на встроенные» нельзя: они помечены namespace `user/` и живут
 * только здесь.
 */
import { BUILTIN_ASPECT_DEFS } from '../registry/builtin-aspects';
import { BUILTIN_PROPERTY_META } from '../registry/builtin-properties';
import { BUILTIN_RELATION_ROLE_META } from '../registry/builtin-roles';
import {
  type AspectDefinition,
  aspectDefinitionSchema,
  type PropertyDefinition,
  propertyDefinitionSchema,
  type RelationRoleDefinition,
  relationRoleDefinitionSchema,
} from '../registry/property-type';
import type { QueryAst } from './ast';
import { type ParseRegistry, type QueryParseCode, toParseRegistry } from './parse-ast';

/** UUID сущности-родителя в реляционных фикстурах (значение из корпуса `fixtures.ts`). */
export const FIXTURE_PARENT_ID = '019d48ea-4188-765d-8e96-93a0ad9c262a';

/** id пользовательского свойства фикстур — uuid, как у всякого не-встроенного (§А2-1). */
export const FIXTURE_USER_PROPERTY_ID = '019d48ea-4188-7c02-8e96-1f0000000001';

const EXTRA_PROPERTIES: readonly PropertyDefinition[] = [
  // Две подписи «Статус» на разных аспектах — единственный способ проверить §А5-3б
  // («неоднозначность лечится aspect=») на данных, а не на выдуманном реестре целиком.
  {
    id: 'user/task_status_alias',
    key: 'user/task_status_alias',
    label: { ru: 'Статус', en: 'Status' },
    description: { ru: 'Подпись-двойник на задаче', en: 'A duplicate label on a task' },
    type: {
      kind: 'select' as const,
      options: [
        { key: 'todo', label: { ru: 'В работе', en: 'Todo' }, rank: 1 },
        { key: 'done', label: { ru: 'Сделано', en: 'Done' }, rank: 2 },
      ],
    },
    rank: 1001,
  },
  {
    id: 'user/project_status_alias',
    key: 'user/project_status_alias',
    label: { ru: 'Статус', en: 'Status' },
    description: { ru: 'Подпись-двойник на проекте', en: 'A duplicate label on a project' },
    type: {
      kind: 'select' as const,
      options: [
        { key: 'open', label: { ru: 'Открыт', en: 'Open' }, rank: 1 },
        { key: 'done', label: { ru: 'Закрыт', en: 'Done' }, rank: 2 },
      ],
    },
    rank: 1002,
  },
  // Ловушка эвристики: паттерн содержит ровно маркер `T\d{2}:` (`catalog.ts:73`), по
  // которому `propType` объявил бы поле timestamp'ом. Тип в реестре — text.
  // Свойство, у которого **key ≠ id** — так выглядит ЛЮБОЕ пользовательское свойство
  // (§А2-1: id пользовательского — uuid, key — слаг). Во встроенном словаре key = id, и без
  // этой записи инвариант §А5-2 «в дереве лежат id, имя подставляется на печати» не
  // проверяется ничем: подмена `.id` → `.key` в парсере прошла бы зелёной.
  {
    id: FIXTURE_USER_PROPERTY_ID,
    key: 'user/effort_points',
    label: { ru: 'Баллы усилия', en: 'Effort points' },
    description: { ru: 'Пользовательская оценка усилия', en: 'A user estimate of effort' },
    type: { kind: 'number' as const, integer: true, min: 1 },
    rank: 1004,
  },
  {
    id: 'user/timestamp_trap',
    key: 'user/timestamp_trap',
    label: { ru: 'Ловушка эвристики', en: 'Heuristic trap' },
    description: {
      ru: 'Текст, который старый каталог принял бы за момент',
      en: 'Text the old catalog would take for a timestamp',
    },
    type: { kind: 'text' as const, pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$' },
    rank: 1003,
  },
].map((entry) =>
  propertyDefinitionSchema.parse({ ...entry, ownerId: null, status: 'active', module: null }),
);

/** Аспекты-носители добавок: без них `aspect=` не развёл бы одинаковые подписи. */
const EXTRA_REFS: Readonly<Record<string, readonly string[]>> = {
  'orbis/task': ['user/task_status_alias', FIXTURE_USER_PROPERTY_ID],
  'orbis/project': ['user/project_status_alias'],
  'orbis/note': ['user/timestamp_trap'],
};

/**
 * Аспект и роль с ЧУЖОЙ подписью: во встроенных наборах все 13 подписей аспектов и все 11
 * подписей ролей различны, поэтому разводку `AMBIGUOUS_LABEL` у них не на чем проверить.
 * Подписи выбраны так, чтобы не задеть однозначные `aspect="Задача"` и `via="Подпункт"`,
 * на которых стоят другие тесты.
 */
const EXTRA_ASPECT: AspectDefinition = aspectDefinitionSchema.parse({
  id: 'user/note_alias',
  ownerId: null,
  key: 'user/note-alias',
  label: { ru: 'Заметка', en: 'Note alias' },
  description: { ru: 'Двойник подписи «Заметка»', en: 'A duplicate of the Note label' },
  properties: [],
  aiInstructions: null,
  tagMappings: [],
  viewConfig: { keyFields: [] },
  module: null,
  service: false,
  rank: 101,
});

const EXTRA_ROLE: RelationRoleDefinition = relationRoleDefinitionSchema.parse({
  id: 'user/mention_alias',
  ownerId: null,
  key: 'user/mention-alias',
  label: { ru: 'Упоминание', en: 'Mention alias' },
  description: { ru: 'Двойник подписи «Упоминание»', en: 'A duplicate of the Mention label' },
  sourceLabel: { ru: 'Откуда', en: 'From' },
  targetLabel: { ru: 'Куда', en: 'To' },
  hierarchical: false,
  module: null,
  rank: 101,
});

const FIXTURE_ASPECTS: readonly AspectDefinition[] = BUILTIN_ASPECT_DEFS.map((aspect) => {
  const extra = EXTRA_REFS[aspect.id];
  if (!extra) return aspect;
  return {
    ...aspect,
    properties: [
      ...aspect.properties,
      ...extra.map((propertyId, index) => ({
        propertyId,
        required: false,
        rank: aspect.properties.length + index + 1,
      })),
    ],
  };
});

/** Реестр разбора для тестов без БД: встроенные словари + добавки, локаль `ru`. */
export const FIXTURE_PARSE_REGISTRY: ParseRegistry = toParseRegistry(
  {
    properties: new Map(
      [...BUILTIN_PROPERTY_META, ...EXTRA_PROPERTIES].map((prop) => [prop.id, prop]),
    ),
    aspects: new Map([...FIXTURE_ASPECTS, EXTRA_ASPECT].map((aspect) => [aspect.id, aspect])),
    roles: new Map([...BUILTIN_RELATION_ROLE_META, EXTRA_ROLE].map((role) => [role.id, role])),
  },
  'ru',
);

export interface AstFixture {
  name: string;
  ast: QueryAst;
  /**
   * Канонический текст key-формы или `null`, если дерево плоской грамматикой v1 не
   * выражается (§А5-3д) — тогда печать даёт скобочную форму, и обратный разбор ОБЯЗАН
   * отказать (это пиннит `print.test.ts`, иначе «невыразимость» была бы словом).
   * Для непустого текста держится `print(ast) === keyText`.
   */
  keyText: string | null;
  /**
   * Дерево, которое даст обратный разбор `keyText`, если оно НЕ равно исходному. Такой
   * случай ровно один и он нормативный: у `in` и у `or` по одному свойству в плоской
   * грамматике ОДНА форма `p=a|b`, и разбор канонически нормализует её в `or` (а список
   * из одного значения — в `eq`). Поле существует, чтобы это правило было записано и
   * проверено, а не пряталось за пометкой «не выражается».
   */
  normalizedTo?: QueryAst;
  /**
   * Для `keyText: null` — код, которым обязан ответить разбор напечатанного текста.
   * Без него пометка «невыразимо» ничего не значила бы: отказать текст может и по
   * посторонней причине, а обещано ровно одно — печать даёт СКОБОЧНУЮ форму, и отказ
   * приходит про скобки (§А5-3д).
   */
  printRejects?: QueryParseCode;
  /** Годится ли запрос в `ref.target`/`scope` (§А6-1, §А2-1). */
  static: boolean;
}

/** Три key-формы боевых запросов Agenda (§А5-5; сегодняшние тексты — `useAgenda.ts:38,45,52`). */
export const AGENDA_QUERY_TEXTS = {
  days: 'aspect=orbis/schedule, orbis/start_at=today|next_7d, sortBy=orbis/start_at:asc, limit=200',
  overdueDue:
    'aspect=orbis/task, orbis/due_date=overdue, orbis/task_status=!done&!cancelled, sortBy=orbis/due_date:asc, limit=200',
  overdueStart:
    'aspect=orbis/task, aspect=orbis/schedule, orbis/start_at=overdue, orbis/task_status=!done&!cancelled, sortBy=orbis/start_at:asc, limit=200',
} as const;

const NOT_CLOSED = {
  not: {
    or: [
      { prop: 'orbis/task_status', op: 'eq' as const, value: 'done' },
      { prop: 'orbis/task_status', op: 'eq' as const, value: 'cancelled' },
    ],
  },
};

export const AST_FIXTURES: readonly AstFixture[] = [
  { name: 'пустой фильтр', ast: { filter: null }, keyText: '', static: true },
  {
    name: 'членство в аспекте',
    ast: { filter: { aspect: 'orbis/task' } },
    keyText: 'aspect=orbis/task',
    static: true,
  },
  {
    name: 'тег и отрицание тега',
    ast: { filter: { and: [{ tag: 'дом' }, { not: { tag: 'скрытое' } }] } },
    keyText: 'tags=дом, !tags=скрытое',
    static: true,
  },
  {
    name: 'has(prop) — закрытие дыры «свойство есть» (§А5-1)',
    ast: { filter: { has: 'orbis/recurrence' } },
    keyText: 'has=orbis/recurrence',
    static: true,
  },
  {
    name: 'сравнение и диапазон по decimal',
    ast: {
      filter: {
        and: [
          { prop: 'orbis/limit', op: 'gt', value: '1000' },
          { prop: 'orbis/amount', op: 'range', value: { from: '10.00', to: '99.99' } },
        ],
      },
    },
    keyText: 'orbis/limit>1000, orbis/amount=10.00..99.99',
    static: true,
  },
  {
    name: 'ne — «не равно» отдельным оператором',
    ast: { filter: { prop: 'orbis/task_status', op: 'ne', value: 'done' } },
    keyText: 'orbis/task_status!=done',
    static: true,
  },
  {
    name: 'contains — элемент списка скаляров',
    ast: { filter: { prop: 'orbis/aliases', op: 'contains', value: 'кофе' } },
    keyText: 'orbis/aliases=кофе',
    static: true,
  },
  {
    name: 'дети по одной роли',
    ast: { filter: { rel: { kind: 'children_of', of: FIXTURE_PARENT_ID, via: 'subitem' } } },
    keyText: `children_of=${FIXTURE_PARENT_ID} via=subitem`,
    static: true,
  },
  {
    name: 'терминальная задача — отрицание через дерево (§А5-1)',
    ast: { filter: { not: { rel: { kind: 'has_children', via: 'subitem' } } } },
    keyText: '!has_children via=subitem',
    static: true,
  },
  {
    name: 'excludeBlocked как отрицание ребра роли',
    ast: { filter: { not: { rel: { kind: 'has_relation', via: 'dependency' } } } },
    keyText: '!has_relation via=dependency',
    static: true,
  },
  {
    name: 'рекурсивный обход по роли (кап 32 — константа компилятора)',
    ast: { filter: { rel: { kind: 'descendants_of', via: 'subitem', of: 'this' } } },
    keyText: 'descendants_of=this via=subitem',
    static: false,
  },
  {
    name: 'поиск и архив',
    ast: { filter: { and: [{ search: 'кофе' }, { archived: 'any' }] } },
    keyText: 'search=кофе, archived=any',
    static: false,
  },
  {
    name: 'дерево and/not/or с включающим range из `<=`',
    ast: {
      filter: {
        and: [
          { aspect: 'orbis/task' },
          NOT_CLOSED,
          { prop: 'orbis/due_date', op: 'range', value: { to: { token: 'today' } } },
        ],
      },
      sortBy: [{ field: 'orbis/priority', dir: 'desc' }],
      limit: 20,
    },
    keyText:
      'aspect=orbis/task, orbis/task_status=!done&!cancelled, orbis/due_date<=today, sortBy=orbis/priority:desc, limit=20',
    static: false,
  },
  {
    name: 'проекция целиком',
    ast: {
      filter: { aspect: 'orbis/task' },
      sortBy: [{ field: 'orbis/due_date', dir: 'asc' }],
      limit: 5,
      display: 'table',
      title: 'Мои задачи',
    },
    keyText:
      'aspect=orbis/task, sortBy=orbis/due_date:asc, limit=5, display=table, title="Мои задачи"',
    static: false,
  },
  {
    name: 'Agenda: дневное окно',
    ast: {
      filter: {
        and: [
          { aspect: 'orbis/schedule' },
          {
            or: [
              { prop: 'orbis/start_at', op: 'eq', value: { token: 'today' } },
              { prop: 'orbis/start_at', op: 'eq', value: { token: 'next_7d' } },
            ],
          },
        ],
      },
      sortBy: [{ field: 'orbis/start_at', dir: 'asc' }],
      limit: 200,
    },
    keyText: AGENDA_QUERY_TEXTS.days,
    static: false,
  },
  {
    name: 'Agenda: просрочено по сроку',
    ast: {
      filter: {
        and: [
          { aspect: 'orbis/task' },
          { prop: 'orbis/due_date', op: 'eq', value: { token: 'overdue' } },
          NOT_CLOSED,
        ],
      },
      sortBy: [{ field: 'orbis/due_date', dir: 'asc' }],
      limit: 200,
    },
    keyText: AGENDA_QUERY_TEXTS.overdueDue,
    static: false,
  },
  {
    name: 'Agenda: просрочено по началу',
    ast: {
      filter: {
        and: [
          { aspect: 'orbis/task' },
          { aspect: 'orbis/schedule' },
          { prop: 'orbis/start_at', op: 'eq', value: { token: 'overdue' } },
          NOT_CLOSED,
        ],
      },
      sortBy: [{ field: 'orbis/start_at', dir: 'asc' }],
      limit: 200,
    },
    keyText: AGENDA_QUERY_TEXTS.overdueStart,
    static: false,
  },
  // ── Дальше — то, что плоским текстом v1 не выражается (§А5-3д) ──
  {
    name: 'in — список значений; вход только AST (§А5-4), разбор нормализует его в or',
    ast: { filter: { prop: 'orbis/task_status', op: 'in', value: ['planned', 'in_progress'] } },
    keyText: 'orbis/task_status=planned|in_progress',
    normalizedTo: {
      filter: {
        or: [
          { prop: 'orbis/task_status', op: 'eq', value: 'planned' },
          { prop: 'orbis/task_status', op: 'eq', value: 'in_progress' },
        ],
      },
    },
    static: true,
  },
  {
    name: 'in из одного значения нормализуется в eq',
    ast: { filter: { prop: 'orbis/task_status', op: 'in', value: ['planned'] } },
    keyText: 'orbis/task_status=planned',
    normalizedTo: { filter: { prop: 'orbis/task_status', op: 'eq', value: 'planned' } },
    static: true,
  },
  {
    name: 'свойство с key ≠ id: в дереве id (uuid), в тексте key (§А5-2)',
    ast: { filter: { prop: FIXTURE_USER_PROPERTY_ID, op: 'gt', value: 3 } },
    keyText: 'user/effort_points>3',
    static: true,
  },
  {
    name: 'двойное отрицание — печать скобками, разбор отказывает',
    ast: { filter: { not: { not: { aspect: 'orbis/task' } } } },
    keyText: null,
    printRejects: 'SYNTAX',
    static: true,
  },
  {
    name: 'OR между РАЗНЫМИ свойствами — то, чего сегодняшняя грамматика не умеет вовсе',
    ast: {
      filter: {
        or: [
          { prop: 'orbis/task_status', op: 'eq', value: 'done' },
          { prop: 'orbis/priority', op: 'eq', value: 'high' },
        ],
      },
    },
    keyText: null,
    printRejects: 'SYNTAX',
    static: true,
  },
  {
    name: 'class — узел части Б: в схеме есть, парсер среза А отвергает',
    ast: { filter: { class: { contract: 'orbis/completable', set: 'done' } } },
    keyText: null,
    printRejects: 'CLASS_NOT_AVAILABLE',
    static: true,
  },
];

/** Текст → код отказа: невыразимое и опечатки (§А5-3ж, §С8-3 «ошибка разбора, не пустота»). */
export const INEXPRESSIBLE_QUERY_TEXTS: readonly { text: string; code: QueryParseCode }[] = [
  { text: 'descendants_of=this', code: 'QUERY_MULTI_ROLE' },
  { text: 'ancestors_of=this', code: 'QUERY_MULTI_ROLE' },
  { text: `children_of=aspect=orbis/project`, code: 'QUERY_JOIN' },
  { text: `parents_of=orbis/task_status=done`, code: 'QUERY_JOIN' },
  { text: 'aspect=orbis/tsk', code: 'UNKNOWN_ASPECT' },
  { text: 'orbis/task_statuz=done', code: 'UNKNOWN_FIELD' },
  { text: 'status=done', code: 'UNKNOWN_FIELD' },
  { text: '!has_children via=subitm', code: 'UNKNOWN_ROLE' },
  { text: '"статус"=done', code: 'AMBIGUOUS_LABEL' },
  { text: 'orbis/task_status=готово', code: 'TYPE' },
  { text: 'orbis/recurrence=x', code: 'TYPE' },
  { text: 'class=orbis/completable:done', code: 'CLASS_NOT_AVAILABLE' },
  { text: 'archived>1', code: 'RESERVED' },
  // Слово грамматики в позиции ИМЕНИ СВОЙСТВА — второй путь к тому же коду (§А5-3а/В11).
  { text: 'sortBy=limit:asc', code: 'RESERVED' },
  { text: 'tags>дом', code: 'RESERVED' },
  { text: 'limit=x', code: 'SYNTAX' },
  { text: '(orbis/task_status=done | orbis/priority=high)', code: 'SYNTAX' },
];

// ─────────────── Опись боевых текстов запросов (рабочее задание 9b/10c/21) ───────────────

/**
 * ВСЕ тексты запросов, которые живут в коде на момент Задачи 8, с адресом каждого.
 *
 * Зачем список именно здесь и именно снимком: канон §А5-3 меняет адресацию имён (голое
 * `status=` → `orbis/task_status=`) и вводит пробел как разделитель конструкций, а значит
 * КАЖДЫЙ из этих текстов придётся переписать или закавычить. Пока перевода нет, единственная
 * защита от «переведём вслепую» — опись с вердиктом разбора на каждый текст; тест
 * `parse-ast.test.ts` прогоняет её и падает, если вердикт разошёлся с записанным.
 *
 * Копия текстов, а не импорт: `packages/shared` не зависит ни от `apps/web`, ни от
 * `apps/server` и зависеть не должен. Расхождение снимка с кодом ловит адрес в поле `where` —
 * при переводе его читают глазами.
 *
 * **Владелец перевода и интервал.** Тексты Agenda переводит Задача 10c (ключ-формы уже
 * лежат в `AGENDA_QUERY_TEXTS`), сидированные тела смарт-листов — Задача 9b вместе с
 * переключением сервера, конструкторы web (`browser/query.ts`, `txQuery.ts`) — Задача 10c,
 * остальные точечные строки — Задача 21 вместе со сносом старой грамматики. До этого
 * момента живут ОБА разбора (РП-11), и ни один из этих текстов новым парсером не читается
 * в бою.
 */
export interface ProductionQueryText {
  where: string;
  text: string;
  /** Код отказа нового парсера или `null`, если текст разбирается уже сегодня. */
  verdict: QueryParseCode | null;
  /**
   * Есть ли в тексте НЕЗАКАВЫЧЕННОЕ значение с пробелом. Такой текст не починится
   * переименованием полей: пробел — разделитель конструкций (§А5-3), и значение обязано
   * поехать в кавычках. Это тот класс, который иначе всплыл бы уже на переключении.
   */
  spaceRisk: boolean;
}

const TX_UUID = '019d48ea-4188-765d-8e96-93a0ad9c262a';

export const PRODUCTION_QUERY_TEXTS: readonly ProductionQueryText[] = [
  // ── apps/web ──
  {
    where: 'apps/web/src/features/agenda/useAgenda.ts:38 (AGENDA_DAYS_QUERY)',
    text: 'aspect=orbis/schedule, start_at=today|next_7d, sortBy=start_at:asc, limit=200',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
  },
  {
    where: 'apps/web/src/features/agenda/useAgenda.ts:45 (AGENDA_OVERDUE_DUE_QUERY)',
    text: 'aspect=orbis/task, due_date=overdue, status=!done&!cancelled, sortBy=due_date:asc, limit=200',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
  },
  {
    where: 'apps/web/src/features/agenda/useAgenda.ts:52 (AGENDA_OVERDUE_START_QUERY)',
    text: 'aspect=orbis/task, aspect=orbis/schedule, start_at=overdue, status=!done&!cancelled, sortBy=start_at:asc, limit=200',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
  },
  {
    where: 'apps/web/src/features/browser/query.ts:13-18,24 (buildFilterQuery+browserQuery)',
    text: 'tags=дом|дача, aspect=orbis/task, status=inbox, priority=high, created_at>2026-01-01, created_at<2026-12-31, sortBy=updated_at:desc, limit=50',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
  },
  {
    where: 'apps/web/src/features/browser/query.ts:13 (тег с пробелом — теги владельца свободны)',
    text: 'tags=личные дела, sortBy=updated_at:desc, limit=50',
    verdict: 'SYNTAX',
    spaceRisk: true,
  },
  {
    where: 'apps/web/src/features/budget/QuickAddBar.tsx:29 (RECENT_QUERY)',
    text: 'aspect=orbis/financial, sortBy=occurred_on:desc, limit=20',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
  },
  {
    where: 'apps/web/src/features/budget/txQuery.ts:53-67 (buildTxQuery, все фильтры)',
    text: `aspect=orbis/financial, occurred_on=2026-06-01..2026-06-30, category_ref=${TX_UUID}, direction=expense, planned=!true, amount=0.10..99999.99, search="кофе, эклер", sortBy=occurred_on:desc, limit=50`,
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
  },
  {
    where: 'apps/web/src/features/budget/CategoryScreen.tsx:117 (транзакции конверта)',
    text: `children_of=${TX_UUID}, aspect=orbis/financial, sortBy=occurred_on:desc, limit=50`,
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
  },
  {
    where: 'apps/web/src/features/chat/memoryRules.ts:12 (правила памяти)',
    text: 'aspect=orbis/memory, kind=rule, scope=orbis/financial',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
  },
  {
    where: 'apps/web/src/features/entity-detail/useTicketRuns.ts:45 (прогоны тикета)',
    text: `children_of=${TX_UUID}, aspect=orbis/agent-run, sortBy=created_at:desc, limit=20`,
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
  },
  {
    where: 'apps/web/src/features/entity-editor/slash/items.ts:29 (NEW_QUERY_BLOCK)',
    text: ' sortBy=updated_at:desc, limit=10, title=Новый список',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: true,
  },
  {
    where: 'apps/web/src/features/settings/MemoryScreen.tsx:25 (MEMORY_FILTER)',
    text: 'aspect=orbis/memory',
    verdict: null,
    spaceRisk: false,
  },
  // `SmartListSave.tsx:18` фиксированного текста не имеет: он оборачивает в `{{query:…}}`
  // строку, пришедшую из Browser, — она уже покрыта записью `browser/query.ts` выше.
  // ── apps/server/src/seed/smart-lists.ts (тела шести сидированных смарт-листов) ──
  {
    where: 'apps/server/src/seed/smart-lists.ts (daily-planning, блок 1)',
    text: ' aspect=orbis/task, status=inbox,\n         sortBy=created_at:desc, display=list, title=Inbox',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
  },
  {
    where: 'apps/server/src/seed/smart-lists.ts (daily-planning, блок 2)',
    text: ' aspect=orbis/task, due_date=today|overdue, status=!done&!cancelled&!waiting,\n         excludeBlocked=true, sortBy=priority:desc|due_date:asc,\n         display=list, title=Сегодня',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
  },
  {
    where: 'apps/server/src/seed/smart-lists.ts (daily-planning, блок 3)',
    text: ' aspect=orbis/task, status=waiting,\n         sortBy=updated_at:asc, display=compact, title=Ожидание',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
  },
  {
    where: 'apps/server/src/seed/smart-lists.ts (upcoming, блок 1)',
    text: ' aspect=orbis/task, due_date=next_7d, status=!done&!cancelled,\n         sortBy=due_date:asc|priority:desc, display=list, title=Ближайшие 7 дней',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: true,
  },
  {
    where: 'apps/server/src/seed/smart-lists.ts (upcoming, блок 2)',
    text: ' aspect=orbis/task, due_date=after_7d, status=!done&!cancelled,\n         sortBy=due_date:asc, limit=30, display=compact, title=Позже',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
  },
  {
    where: 'apps/server/src/seed/smart-lists.ts (all-tasks)',
    text: ' aspect=orbis/task, status=!done&!cancelled,\n         sortBy=updated_at:desc, display=list, title=Все незакрытые задачи',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: true,
  },
  {
    where: 'apps/server/src/seed/smart-lists.ts (horizon-year)',
    text: ' aspect=orbis/goal, sortBy=updated_at:desc, display=list, title=Цели',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
  },
  {
    where: 'apps/server/src/seed/smart-lists.ts (horizon-life)',
    text: ' tags=life, sortBy=updated_at:desc, display=list, title=Ценности и зоны ответственности',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: true,
  },
  {
    where: 'apps/server/src/seed/smart-lists.ts (routines, блок 1)',
    text: ' aspect=orbis/agent-run, outcome=checkpoint, sortBy=started_at:asc, display=list, title=Ждут ответа',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: true,
  },
  {
    where: 'apps/server/src/seed/smart-lists.ts (routines, блок 2)',
    text: ' aspect=orbis/routine, stage=active, sortBy=updated_at:desc, display=list, title=Активные рутины',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: true,
  },
  {
    where: 'apps/server/src/seed/smart-lists.ts (routines, блок 3)',
    text: ' aspect=orbis/agent-run, undecided=true, sortBy=started_at:asc, display=list, title=Пачка решений',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: true,
  },
];
