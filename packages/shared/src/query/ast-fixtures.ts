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
/** То же для СПИСОЧНОГО свойства: ветка `contains` — отдельная точка записи id в дерево. */
export const FIXTURE_USER_LIST_ID = '019d48ea-4188-7c02-8e96-1f0000000002';

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
  // Списочное свойство с key ≠ id: через него проходят ветки `contains` и `!=` на списке —
  // в них id пишется в дерево ОТДЕЛЬНЫМИ строками кода, и скалярная фикстура их не задевает.
  {
    id: FIXTURE_USER_LIST_ID,
    key: 'user/labels',
    label: { ru: 'Метки', en: 'Labels' },
    description: { ru: 'Пользовательский список меток', en: 'A user list of labels' },
    type: { kind: 'text' as const, cardinality: 'many' as const, maxItems: 20 },
    rank: 1005,
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
  'orbis/task': ['user/task_status_alias', FIXTURE_USER_PROPERTY_ID, FIXTURE_USER_LIST_ID],
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
   * Дерево, которое даст обратный разбор `keyText`, если оно НЕ равно исходному.
   *
   * Таких классов ЧЕТЫРЕ, и все они — следствие того, что плоский текст беднее канона
   * (первая редакция этого докблока утверждала «случай ровно один» — неправда):
   *  1. `{op:'in'}` → `or`: у `in` и у `or` по одному свойству одна текстовая форма
   *     `p=a|b`; список из одного значения сворачивается в `eq`;
   *  2. `{or:[x]}` → `x`: одноэлементный OR печатается как сам элемент;
   *  3. `{and:[x]}` → `x`: то же на верхнем уровне (корневой `and` и есть список
   *     конструкций через запятую);
   *  4. **`eq`/`ne` ↔ `contains` на СПИСОЧНОМ свойстве** — и в прямой, и в отрицательной
   *     форме: `{prop:<список>, op:'eq'}` печатается `p=v` и читается назад как `contains`;
   *     `{op:'ne'}` печатается `p!=v` и читается как `{not:{contains}}`; `{not:{op:'eq'}}`
   *     печатается `p=!v` и читается туда же. Текст не различает равенство и вхождение,
   *     когда значение — список.
   *
   *  5. **`contains` на НЕсписочном свойстве → `eq`** — зеркало четвёртого:
   *     `{prop:'orbis/location', op:'contains'}` печатается `p=v` и читается как `eq`.
   *     Воспроизводится на всех скалярных типах и под `not`, внутри `or`, в `&`-форме.
   *     На text-свойстве `contains` естественнее всего прочитать как «подстрока» — и
   *     именно этот смысл теряется молча.
   *
   * Четвёртый и пятый классы — не косметика, и последствие названо вслух: дифф Ш1 меряет
   * правки key-печатью (§А5-2), а `eq`/`ne` и `contains` на списке дают ОДИН текст при
   * РАЗНЫХ деревьях — значит правка `eq`→`contains` в предложении станет невидимой.
   * Настоящая причина в том, что **канон не определяет `eq` и `ne` на списочном
   * свойстве**: §А5-7 даёт `contains` как оператор вхождения и молчит о том, значит ли
   * `eq` «список равен [v]» или «список содержит v». Это ДОЛГ Задачи 9a (компилятор):
   * пока значения нет, фикстуры фиксируют наблюдаемое поведение, а не выдают его за
   * решение. Тип свойства знает РЕЕСТР, а узел его не несёт (`ast.ts` разрешает любой
   * оператор любому prop-id — сузить нечем, не втащив реестр в схему канона), поэтому
   * пары `eq`/`contains` и `ne`/`not(contains)` неразличимы текстом в ОБЕ стороны.
   *
   * Перечень классов правился ТРИЖДЫ («ровно один» → «четыре» → «пять» → нынешний), и
   * каждый раз недоставало ветки вокруг `contains`. Следующему читателю: если ищете
   * шестую недостачу — начинайте оттуда же, с операторов, чья применимость зависит от
   * типа свойства, а не от формы узла.
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
    // Пользовательская запись: «нет входящих рёбер роли dependency». О СОСТОЯНИИ блокирующей
    // работы она не спрашивает — и условия состояния получать не должна.
    name: 'отрицание ребра роли: !has_relation via=dependency',
    ast: { filter: { not: { rel: { kind: 'has_relation', via: 'dependency' } } } },
    keyText: '!has_relation via=dependency',
    static: true,
  },
  {
    // А это — САХАР `excludeBlocked=true`, и дерево у него ДРУГОЕ: ребро плюс состояние
    // дальнего конца (`sourceNotIn`). Две записи рядом именно для того, чтобы разницу было
    // видно глазами: слить их значило бы либо потерять условие состояния у смарт-листов,
    // либо навязать его пользовательскому запросу.
    name: 'excludeBlocked=true — ребро dependency ПЛЮС состояние блокирующей работы',
    ast: {
      filter: {
        not: {
          rel: {
            kind: 'has_relation',
            via: 'dependency',
            sourceNotIn: { prop: 'orbis/task_status', values: ['done', 'cancelled'] },
          },
        },
      },
    },
    keyText: 'excludeBlocked=true',
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
    name: 'or из одного узла нормализуется в сам узел',
    ast: { filter: { or: [{ prop: 'orbis/task_status', op: 'eq', value: 'done' }] } },
    keyText: 'orbis/task_status=done',
    normalizedTo: { filter: { prop: 'orbis/task_status', op: 'eq', value: 'done' } },
    static: true,
  },
  {
    name: 'and из одного узла нормализуется в сам узел',
    ast: { filter: { and: [{ aspect: 'orbis/task' }] } },
    keyText: 'aspect=orbis/task',
    normalizedTo: { filter: { aspect: 'orbis/task' } },
    static: true,
  },
  {
    name: 'eq на СПИСОЧНОМ свойстве неразличим с contains: один текст, два дерева (долг 9a)',
    ast: { filter: { prop: 'orbis/aliases', op: 'eq', value: 'кофе' } },
    keyText: 'orbis/aliases=кофе',
    normalizedTo: { filter: { prop: 'orbis/aliases', op: 'contains', value: 'кофе' } },
    static: true,
  },
  {
    name: 'ne на СПИСОЧНОМ свойстве: тот же текст, что у not(contains) (долг 9a)',
    ast: { filter: { prop: 'orbis/aliases', op: 'ne', value: 'кофе' } },
    keyText: 'orbis/aliases!=кофе',
    normalizedTo: { filter: { not: { prop: 'orbis/aliases', op: 'contains', value: 'кофе' } } },
    static: true,
  },
  {
    name: 'not(eq) на СПИСОЧНОМ свойстве нормализуется в not(contains) (долг 9a)',
    ast: { filter: { not: { prop: 'orbis/aliases', op: 'eq', value: 'кофе' } } },
    keyText: 'orbis/aliases=!кофе',
    normalizedTo: { filter: { not: { prop: 'orbis/aliases', op: 'contains', value: 'кофе' } } },
    static: true,
  },
  {
    name: 'contains на НЕсписочном свойстве нормализуется в eq (зеркало класса 4, долг 9a)',
    ast: { filter: { prop: 'orbis/location', op: 'contains', value: 'Москва' } },
    keyText: 'orbis/location=Москва',
    normalizedTo: { filter: { prop: 'orbis/location', op: 'eq', value: 'Москва' } },
    static: true,
  },
  {
    name: 'OR однородных тегов выразим плоским текстом (дыра обратимости, найденная гейтом)',
    ast: { filter: { or: [{ tag: 'дом' }, { tag: 'дача' }] } },
    keyText: 'tags=дом|дача',
    static: true,
  },
  {
    name: 'excludeTags: отрицание OR однородных тегов',
    ast: { filter: { not: { or: [{ tag: 'дом' }, { tag: 'дача' }] } } },
    keyText: '!tags=дом|дача',
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

// ─────────────── Опись боевых текстов запросов (рабочее задание 9b/10c/19/21) ───────────────

/**
 * ВСЕ тексты запросов, живущие в коде на момент Задачи 8, — по строке на АДРЕС.
 *
 * Зачем список именно здесь и именно снимком: канон §А5-3 меняет адресацию имён (голое
 * `status=` → `orbis/task_status=`), вводит пробел как разделитель конструкций и оставляет
 * `title`/`limit`/`search` словами грамматики. Значит каждый из этих текстов придётся
 * переписать, закавычить или адресовать namespaced key. Пока перевода нет, единственная
 * защита от «переведём вслепую» — опись с вердиктом на каждый адрес; тест
 * `parse-ast.test.ts` прогоняет её, пересчитывает флаги из самого текста и пиннит ТОЧНЫЕ
 * числа: правка описи обязана быть видимым движением, а не тихим сдвигом.
 *
 * Копия текстов, а не импорт: `packages/shared` не зависит ни от `apps/web`, ни от
 * `apps/server` и зависеть не должен. Расхождение снимка с кодом ловит адрес в `where` —
 * при переводе его читают глазами.
 *
 * Собрано ГРЕПОМ по всем формам (`{{query:`, `aspect=`, `sortBy=`, `children_of=`, `tags=`,
 * потребители `entity.query`/`entity.count`, сиды, шпаргалки промптов и описание тула), а не
 * по памяти: первая редакция описи, собранная по памяти, потеряла семь живых адресов.
 *
 * ГРАНИЦА описи, названная точно: сюда входит текст, который осмысленно скормить
 * `parseQueryAst` целиком, — сохранённый запрос, строка конструктора и пример грамматики
 * в промпте или описании тула. Не входит и почему:
 *  - мёртвые версии промптов (`prompts/v1..v3`, `routine-v1`) — их не импортирует никто вне
 *    тестов (живые входы: `llm/context.ts:36` → `v4`, `routines/context.ts:29` → `routine-v2`);
 *  - плейсхолдеры шпаргалки (`children_of=<uuid>`, `sortBy=<поле>:asc`, `tags=<тег>|<тег>`,
 *    `limit=<число>` — `v4.ts:61-62`, `routine-v2.ts:86-87`): это форма, а не запрос;
 *  - **упоминания ПОЛЕЙ АСПЕКТА в прозе промпта** — `planned=true` (`v4.ts:50`, `:54`),
 *    `all_day=true` (`v4.ts:55`), `direction=expense` и `spend_class=discretionary`
 *    (`v4.ts:66`). Синтаксически они похожи на фильтр, но говорят, ЧТО ЗАПИСАТЬ в
 *    `entity_create`/что лежит в выдаче `budget_status`, а не что отобрать; целого запроса
 *    вокруг них нет, и собрать его пришлось бы выдумав. Переименование имён в этих строках
 *    — работа Задачи 19 (её бриф уже называет `v4.ts:57-62, :78` и `routine-v2.ts:82-87`),
 *    но опись запросов о них не свидетельствует;
 *  - `SmartListSave.tsx:18` собственного текста не имеет — он оборачивает в `{{query:…}}`
 *    строку из Browser, покрытую записями `browser/query.ts`.
 */
export type QueryTextOwner = '9b' | '10c' | '19' | '9b/21' | 'заморожен';

export interface ProductionQueryText {
  /** Файл и строка — по ним перевод сверяется с кодом. */
  where: string;
  text: string;
  /** Код отказа нового парсера или `null`, если текст разбирается уже сегодня. */
  verdict: QueryParseCode | null;
  /**
   * Есть ли в ЭТОМ тексте НЕЗАКАВЫЧЕННОЕ значение с пробелом. Такой адрес не чинится
   * переименованием полей: пробел — разделитель конструкций (§А5-3), значение обязано
   * поехать в кавычках. У большинства адресов первым падает имя поля, поэтому пробел
   * всплыл бы уже ПОСЛЕ перевода — тем и опасен.
   */
  spaceRisk: boolean;
  /**
   * Core-свойства (§А1-3), названные ГОЛЫМ именем. Их перевод — отдельная таблица:
   * `orbis/created_at`, `orbis/updated_at`, `orbis/title`. `title` попадает сюда только в
   * позиции `sortBy=title:` — в позиции фильтра `title=` остаётся словом грамматики
   * (параметр заголовка) и перевода не требует; `archived=` — тоже слово грамматики.
   */
  coreNames: readonly string[];
  /** Кто переводит адрес (Задача среза); `заморожен` — править нельзя вообще. */
  owner: QueryTextOwner;
  /**
   * Текст — ЗАМОРОЖЕННЫЙ образец сверки: `onboarding.ts:290` сравнивает тело владельца с
   * ним БАЙТ-В-БАЙТ (бэкфилл D42), и правка молча выключит бэкфилл. Перевод сида «Рутин»
   * обязан завести ВТОРУЮ константу рядом, а не трогать эту (`onboarding.ts:231-245`).
   */
  frozen?: true;
  /** Текст собирается из ввода: что именно ломает разбор. */
  dynamic?: string;
}

const TX_UUID = '019d48ea-4188-765d-8e96-93a0ad9c262a';

export const PRODUCTION_QUERY_TEXTS: readonly ProductionQueryText[] = [
  {
    where: 'apps/web/src/features/agenda/useAgenda.ts:38 (AGENDA_DAYS_QUERY)',
    text: 'aspect=orbis/schedule, start_at=today|next_7d, sortBy=start_at:asc, limit=200',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
    coreNames: [],
    owner: '10c',
  },
  {
    where: 'apps/web/src/features/agenda/useAgenda.ts:45 (AGENDA_OVERDUE_DUE_QUERY)',
    text: 'aspect=orbis/task, due_date=overdue, status=!done&!cancelled, sortBy=due_date:asc, limit=200',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
    coreNames: [],
    owner: '10c',
  },
  {
    where: 'apps/web/src/features/agenda/useAgenda.ts:52 (AGENDA_OVERDUE_START_QUERY)',
    text: 'aspect=orbis/task, aspect=orbis/schedule, start_at=overdue, status=!done&!cancelled, sortBy=start_at:asc, limit=200',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
    coreNames: [],
    owner: '10c',
  },
  {
    where:
      'apps/web/src/features/browser/query.ts:13-18,24 (buildFilterQuery+browserQuery, все фильтры)',
    text: 'tags=дом|дача, aspect=orbis/task, status=inbox, priority=high, created_at>2026-01-01, created_at<2026-12-31, sortBy=updated_at:desc, limit=50',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
    coreNames: ['created_at', 'updated_at'],
    owner: '10c',
  },
  {
    where:
      'apps/web/src/features/browser/query.ts:13 (тег владельца с пробелом; buildFilterQuery не квотирует вовсе)',
    text: 'tags=личные дела, sortBy=updated_at:desc, limit=50',
    verdict: 'SYNTAX',
    spaceRisk: true,
    coreNames: ['updated_at'],
    owner: '10c',
    dynamic: 'тег владельца с пробелом — buildFilterQuery склеивает теги без квотирования',
  },
  {
    where: 'apps/web/src/features/budget/QuickAddBar.tsx:29 (RECENT_QUERY)',
    text: 'aspect=orbis/financial, sortBy=occurred_on:desc, limit=20',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
    coreNames: [],
    owner: '10c',
  },
  {
    where: 'apps/web/src/features/budget/txQuery.ts:53-67 (buildTxQuery, все фильтры)',
    text: `aspect=orbis/financial, occurred_on=2026-06-01..2026-06-30, category_ref=${TX_UUID}, direction=expense, planned=!true, amount=0.10..99999.99, search=кофе, sortBy=occurred_on:desc, limit=50`,
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
    coreNames: [],
    owner: '10c',
  },
  {
    where: 'apps/web/src/features/budget/txQuery.ts:66 + quoteValue :45 (поиск с пробелом)',
    text: 'aspect=orbis/financial, search=кофе эклер, sortBy=occurred_on:desc, limit=50',
    verdict: 'SYNTAX',
    spaceRisk: true,
    coreNames: [],
    owner: '10c',
    dynamic:
      'поисковый ввод с пробелом: quoteValue (txQuery.ts:45) квотирует только , | & " — пробел уезжает голым',
  },
  {
    where: 'apps/web/src/features/budget/CategoryScreen.tsx:117 (транзакции конверта)',
    text: `children_of=${TX_UUID}, aspect=orbis/financial, sortBy=occurred_on:desc, limit=50`,
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
    coreNames: [],
    owner: '10c',
  },
  {
    where: 'apps/web/src/features/budget/categories.ts:8 (CATEGORIES_QUERY — 7 потребителей)',
    text: 'aspect=orbis/category, sortBy=title:asc, limit=200',
    verdict: 'RESERVED',
    spaceRisk: false,
    coreNames: ['title'],
    owner: '10c',
  },
  {
    where:
      'apps/web/src/features/budget/EnvelopeCreateSheet.tsx:55 (инлайн-дубль CATEGORIES_QUERY)',
    text: 'aspect=orbis/category, sortBy=title:asc, limit=200',
    verdict: 'RESERVED',
    spaceRisk: false,
    coreNames: ['title'],
    owner: '10c',
  },
  {
    where: 'apps/web/src/features/chat/memoryRules.ts:12 (MEMORY_RULES_QUERY)',
    text: 'aspect=orbis/memory, kind=rule, scope=orbis/financial',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
    coreNames: [],
    owner: '10c',
  },
  {
    where: 'apps/web/src/features/chat/useFastPath.ts:17 (CATEGORY_QUERY)',
    text: 'aspect=orbis/category',
    verdict: null,
    spaceRisk: false,
    coreNames: [],
    owner: '10c',
  },
  {
    where: 'apps/web/src/features/entity-detail/useTicketRuns.ts:45 (прогоны тикета и рутины)',
    text: `children_of=${TX_UUID}, aspect=orbis/agent-run, sortBy=created_at:desc, limit=20`,
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
    coreNames: ['created_at'],
    owner: '10c',
  },
  {
    where: 'apps/web/src/features/entity-editor/slash/items.ts:29 (NEW_QUERY_BLOCK)',
    text: ' sortBy=updated_at:desc, limit=10, title=Новый список',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: true,
    coreNames: ['updated_at'],
    owner: '10c',
  },
  {
    where: 'apps/web/src/features/settings/MemoryScreen.tsx:25 (MEMORY_FILTER)',
    text: 'aspect=orbis/memory',
    verdict: null,
    spaceRisk: false,
    coreNames: [],
    owner: '10c',
  },
  {
    where: 'apps/server/src/seed/smart-lists.ts:10 (daily-planning, блок 1 «Inbox»)',
    text: ' aspect=orbis/task, status=inbox,\n         sortBy=created_at:desc, display=list, title=Inbox',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
    coreNames: ['created_at'],
    owner: '9b',
  },
  {
    where: 'apps/server/src/seed/smart-lists.ts:13 (daily-planning, блок 2 «Сегодня»)',
    text: ' aspect=orbis/task, due_date=today|overdue, status=!done&!cancelled&!waiting,\n         excludeBlocked=true, sortBy=priority:desc|due_date:asc,\n         display=list, title=Сегодня',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
    coreNames: [],
    owner: '9b',
  },
  {
    where: 'apps/server/src/seed/smart-lists.ts:17 (daily-planning, блок 3 «Ожидание»)',
    text: ' aspect=orbis/task, status=waiting,\n         sortBy=updated_at:asc, display=compact, title=Ожидание',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
    coreNames: ['updated_at'],
    owner: '9b',
  },
  {
    where: 'apps/server/src/seed/smart-lists.ts:22 (upcoming, блок 1 «Ближайшие 7 дней»)',
    text: ' aspect=orbis/task, due_date=next_7d, status=!done&!cancelled,\n         sortBy=due_date:asc|priority:desc, display=list, title=Ближайшие 7 дней',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: true,
    coreNames: [],
    owner: '9b',
  },
  {
    where: 'apps/server/src/seed/smart-lists.ts:25 (upcoming, блок 2 «Позже»)',
    text: ' aspect=orbis/task, due_date=after_7d, status=!done&!cancelled,\n         sortBy=due_date:asc, limit=30, display=compact, title=Позже',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
    coreNames: [],
    owner: '9b',
  },
  {
    where: 'apps/server/src/seed/smart-lists.ts:28 (all-tasks)',
    text: ' aspect=orbis/task, status=!done&!cancelled,\n         sortBy=updated_at:desc, display=list, title=Все незакрытые задачи',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: true,
    coreNames: ['updated_at'],
    owner: '9b',
  },
  {
    where: 'apps/server/src/seed/smart-lists.ts:52 (horizon-year «Цели»)',
    text: ' aspect=orbis/goal, sortBy=updated_at:desc, display=list, title=Цели',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
    coreNames: ['updated_at'],
    owner: '9b',
  },
  {
    where: 'apps/server/src/seed/smart-lists.ts:62 (horizon-life)',
    text: ' tags=life, sortBy=updated_at:desc, display=list, title=Ценности и зоны ответственности',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: true,
    coreNames: ['updated_at'],
    owner: '9b',
  },
  {
    where: 'apps/server/src/seed/smart-lists.ts:95 (routines, блок 1 «Ждут ответа»)',
    text: ' aspect=orbis/agent-run, outcome=checkpoint, sortBy=started_at:asc, display=list, title=Ждут ответа',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: true,
    coreNames: [],
    owner: '9b',
  },
  {
    where: 'apps/server/src/seed/smart-lists.ts:97 (routines, блок 2 «Активные рутины»)',
    text: ' aspect=orbis/routine, stage=active, sortBy=updated_at:desc, display=list, title=Активные рутины',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: true,
    coreNames: ['updated_at'],
    owner: '9b',
  },
  {
    where: 'apps/server/src/seed/smart-lists.ts:99 (routines, блок 3 «Пачка решений»)',
    text: ' aspect=orbis/agent-run, undecided=true, sortBy=started_at:asc, display=list, title=Пачка решений',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: true,
    coreNames: [],
    owner: '9b',
  },
  {
    where: 'apps/server/src/seed/project-body.ts:31 (тело проекта, блок «В работе»)',
    text: ` children_of=${TX_UUID}, aspect=orbis/task, status=in_progress, sortBy=updated_at:desc, display=list, title=В работе`,
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: true,
    coreNames: ['updated_at'],
    owner: '9b',
  },
  {
    where: 'apps/server/src/seed/project-body.ts:35 (тело проекта, блок «Ждут меня»)',
    text: ` children_of=${TX_UUID}, aspect=orbis/task, status=waiting, sortBy=updated_at:asc, display=list, title=Ждут меня`,
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: true,
    coreNames: ['updated_at'],
    owner: '9b',
  },
  {
    where: 'apps/server/src/seed/project-body.ts:39 (тело проекта, блок «Бэклог»)',
    text: ` children_of=${TX_UUID}, aspect=orbis/task, status=inbox|planned, sortBy=priority:desc|created_at:asc, display=list, title=Бэклог`,
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
    coreNames: ['created_at'],
    owner: '9b',
  },
  {
    where: 'apps/server/src/seed/project-body.ts:43 (тело проекта, блок «Последние прогоны»)',
    text: ` aspect=orbis/agent-run, project_id=${TX_UUID}, sortBy=created_at:desc, limit=10, display=compact, title=Последние прогоны`,
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: true,
    coreNames: ['created_at'],
    owner: '9b',
  },
  {
    where:
      'apps/server/src/seed/onboarding.ts:248 (ROUTINES_LIST_BODY_BEFORE_BATCH, блок 1) — ПРАВИТЬ НЕЛЬЗЯ',
    text: ' aspect=orbis/agent-run, outcome=checkpoint, sortBy=started_at:asc, display=list, title=Ждут ответа',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: true,
    coreNames: [],
    owner: 'заморожен',
    frozen: true,
  },
  {
    where:
      'apps/server/src/seed/onboarding.ts:250 (ROUTINES_LIST_BODY_BEFORE_BATCH, блок 2) — ПРАВИТЬ НЕЛЬЗЯ',
    text: ' aspect=orbis/routine, stage=active, sortBy=updated_at:desc, display=list, title=Активные рутины',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: true,
    coreNames: ['updated_at'],
    owner: 'заморожен',
    frozen: true,
  },
  {
    where: 'apps/server/src/test/perf.ts:324 (progress_source перф-фикстуры цели, гейт D21)',
    text: 'aspect=orbis/financial, direction=expense',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
    coreNames: [],
    owner: '9b',
  },
  {
    where: 'apps/server/src/tools/registry.ts:846 (описание тула entity_query, пример 1)',
    text: 'aspect=orbis/category, search=Еда',
    verdict: null,
    spaceRisk: false,
    coreNames: [],
    owner: '9b/21',
  },
  {
    where: 'apps/server/src/tools/registry.ts:846 (описание тула entity_query, пример 2)',
    text: 'aspect=orbis/task, status=!done&!cancelled, sortBy=updated_at:desc, limit=20',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
    coreNames: ['updated_at'],
    owner: '9b/21',
  },
  {
    where: 'apps/server/src/tools/registry.ts:846 (описание тула entity_query, пример 3)',
    text: 'aspect=orbis/category, aliases=такси',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
    coreNames: [],
    owner: '9b/21',
  },
  {
    where: 'apps/server/src/llm/prompts/v4.ts:58 (шпаргалка грамматики, пример 1)',
    text: 'aspect=orbis/category, search=Еда',
    verdict: null,
    spaceRisk: false,
    coreNames: [],
    owner: '19',
  },
  {
    where: 'apps/server/src/llm/prompts/v4.ts:58 (шпаргалка грамматики, пример 2)',
    text: 'aspect=orbis/task, status=!done&!cancelled, sortBy=updated_at:desc, limit=20',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
    coreNames: ['updated_at'],
    owner: '19',
  },
  {
    where: 'apps/server/src/llm/prompts/v4.ts:61 (шпаргалка грамматики, пример «доходы с тегом»)',
    text: 'aspect=orbis/financial, direction=income, tags=savings',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
    coreNames: [],
    owner: '19',
  },
  {
    where: 'apps/server/src/llm/prompts/routine-v2.ts:83 (шпаргалка грамматики рутин, пример 1)',
    text: 'aspect=orbis/category, search=Еда',
    verdict: null,
    spaceRisk: false,
    coreNames: [],
    owner: '19',
  },
  {
    where: 'apps/server/src/llm/prompts/routine-v2.ts:83 (шпаргалка грамматики рутин, пример 2)',
    text: 'aspect=orbis/task, status=!done&!cancelled, sortBy=updated_at:desc, limit=20',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
    coreNames: ['updated_at'],
    owner: '19',
  },
  {
    where: 'apps/server/src/llm/prompts/v4.ts:59 (шпаргалка, пример |-списка)',
    text: 'status=planned|in_progress',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
    coreNames: [],
    owner: '19',
  },
  {
    where: 'apps/server/src/llm/prompts/v4.ts:59 (шпаргалка, пример &-формы)',
    text: 'status=!done&!cancelled',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
    coreNames: [],
    owner: '19',
  },
  {
    where: 'apps/server/src/llm/prompts/v4.ts:60 (шпаргалка, пример date-токенов)',
    text: 'due_date=today|overdue',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
    coreNames: [],
    owner: '19',
  },
  {
    where: 'apps/server/src/llm/prompts/v4.ts:78 (блок целей: «цели — aspect=orbis/goal»)',
    text: 'aspect=orbis/goal',
    verdict: null,
    spaceRisk: false,
    coreNames: [],
    owner: '19',
  },
  {
    where: 'apps/server/src/llm/prompts/routine-v2.ts:84 (шпаргалка рутин, пример |-списка)',
    text: 'status=planned|in_progress',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
    coreNames: [],
    owner: '19',
  },
  {
    where: 'apps/server/src/llm/prompts/routine-v2.ts:84 (шпаргалка рутин, пример &-формы)',
    text: 'status=!done&!cancelled',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
    coreNames: [],
    owner: '19',
  },
  {
    where: 'apps/server/src/llm/prompts/routine-v2.ts:85 (шпаргалка рутин, пример date-токенов)',
    text: 'due_date=today|overdue',
    verdict: 'UNKNOWN_FIELD',
    spaceRisk: false,
    coreNames: [],
    owner: '19',
  },
];

/**
 * Точная разбивка описи — пиннится тестом (образец: golden-корпус Задачи 2, где размер и
 * разбивка тоже точные). Любая правка описи обязана пройти через эти числа.
 */
export const PRODUCTION_QUERY_STATS = {
  total: 49,
  /** Разбирается новым парсером уже сегодня. */
  parses: 6,
  byVerdict: { UNKNOWN_FIELD: 39, SYNTAX: 2, RESERVED: 2 },
  /** Незакавыченное значение с пробелом — не чинится переименованием полей. */
  spaceRisk: 14,
  /** Называет core-свойство голым именем — перевод по отдельной таблице §А1-3. */
  coreNames: 20,
  /** Замороженные образцы сверки: править нельзя вообще. */
  frozen: 2,
  /** Текст собирается из ввода — ломает не сам литерал, а подстановка. */
  dynamic: 2,
} as const;
