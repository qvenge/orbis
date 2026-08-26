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
 *    НЕ выражаются (`keyText: null`): `in`, OR между разными свойствами, `class` части Б;
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
  type PropertyDefinition,
  propertyDefinitionSchema,
} from '../registry/property-type';
import type { QueryAst } from './ast';
import { type ParseRegistry, type QueryParseCode, toParseRegistry } from './parse-ast';

/** UUID сущности-родителя в реляционных фикстурах (значение из корпуса `fixtures.ts`). */
export const FIXTURE_PARENT_ID = '019d48ea-4188-765d-8e96-93a0ad9c262a';

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
  'orbis/task': ['user/task_status_alias'],
  'orbis/project': ['user/project_status_alias'],
  'orbis/note': ['user/timestamp_trap'],
};

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
    aspects: new Map(FIXTURE_ASPECTS.map((aspect) => [aspect.id, aspect])),
    roles: new Map(BUILTIN_RELATION_ROLE_META.map((role) => [role.id, role])),
  },
  'ru',
);

export interface AstFixture {
  name: string;
  ast: QueryAst;
  /**
   * Канонический текст key-формы или `null`, если дерево плоской грамматикой v1 не
   * выражается (§А5-3д). Для непустого текста держатся ОБА направления:
   * `print(ast) === keyText` и `parse(keyText) ≡ ast`.
   */
  keyText: string | null;
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
    name: 'in — список значений; вход только AST (§А5-4)',
    ast: { filter: { prop: 'orbis/task_status', op: 'in', value: ['planned', 'in_progress'] } },
    keyText: null,
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
    static: true,
  },
  {
    name: 'class — узел части Б: в схеме есть, парсер среза А отвергает',
    ast: { filter: { class: { contract: 'orbis/completable', set: 'done' } } },
    keyText: null,
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
