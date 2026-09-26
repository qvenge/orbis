/**
 * Фикстуры эталона экрана записи (С1а-5, РП-10) и обработчик, отвечающий ВСЕМ путям экрана.
 *
 * Эталон снимается один раз, со старого экрана (задача 2), и сравнивается с новым (задачи 12,
 * 14) — поэтому фикстуры, обработчик и порядок съёмки общие: любая разница в ответах между
 * «до» и «после» была бы разницей обвязки, а не экрана.
 *
 * Обработчик обязан отвечать правдоподобно КАЖДОМУ пути, который экран спрашивает: блок,
 * которому не ответили, молча пуст (карточки аспектов без реестра, история без прогонов,
 * блок ожидания без последнего прогона), — и эталон зафиксировал бы эту пустоту как «так и
 * должно быть».
 *
 * Тела — текст БЕЗ блоков данных: путь тела меняет задача 11, а структура экрана от содержимого
 * тела не зависит (тело в снимке — один ориентир `body`).
 */
import { parseBody } from '@orbis/shared/doc';
import { act, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { noteRegistryVersion, resetRegistryVersionForTests } from '../../lib/registry/useRegistry';
import { useNav } from '../../state/navigation';
import {
  type MockHandler,
  renderWithProviders,
  trpcError,
  type WireEntityFixture,
  wireEntity,
} from '../../test/harness';
import { BUILTIN_REGISTRY, registryReply } from '../../test/registry';
import { queryClient, type RouterOutputs } from '../../trpc';
import { DetailScreen } from './DetailScreen';
import { type DetailStructure, snapshotDetailStructure } from './structure-snapshot';

/** Сущность в wire-форме производителя (фабрика `wireEntity` обвязки). */
export type WireEntity = WireEntityFixture;
/** Ответ `entity.get` экрана записи — как его объявляет сервер. */
export type EntityGetReply = RouterOutputs['entity']['get'];

export interface StructureFixture {
  name: string;
  entity: WireEntity;
  extra?: Partial<EntityGetReply>;
}

// --- Мир вокруг записей: то, на что записи ссылаются и что экран дочитывает сам ----------------

/** Id — формы uuid: боевые пути (текст запроса `children_of=…`) другой формы не видят. */
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const CREATED = '2026-09-01T09:00:00.000Z';
const UPDATED = '2026-09-20T10:00:00.000Z';

/** Категория, на которую ссылаются операция, конверт и правило памяти. */
const CATEGORY = wireEntity({
  id: id(900),
  title: 'Кофе',
  emoji: '☕',
  props: { 'orbis/icon': '☕', 'orbis/spend_class': 'discretionary' },
  aspects: ['orbis/category'],
});
const SUBTASK = wireEntity({
  id: id(901),
  title: 'Собрать чеки',
  props: { 'orbis/task_status': 'inbox' },
  aspects: ['orbis/task'],
});
const BLOCKER = wireEntity({
  id: id(902),
  title: 'Получить доступ к банку',
  props: { 'orbis/task_status': 'planned' },
  aspects: ['orbis/task'],
});
const MENTIONER = wireEntity({
  id: id(903),
  title: 'План на неделю',
  props: { 'orbis/content_type': 'markdown' },
  aspects: ['orbis/note'],
});

/** Доступ внешнего исполнителя — им подписаны прогон, карточка назначения и история. */
const GRANT_ID = id(950);
const GRANTS = [
  {
    id: GRANT_ID,
    kind: 'oauth',
    label: 'Claude Code',
    connected: true,
    scope: 'full',
    createdAt: CREATED,
    lastUsedAt: UPDATED,
    revokedAt: null,
  },
];

const SETTINGS = {
  graphId: 'u',
  plan: 'free',
  timezone: 'Europe/Moscow',
  defaultCurrency: 'RUB',
  weekStartDay: 'monday',
  tagColors: {},
  installedViews: [],
  pinnedEntities: [],
  viewPreferences: {},
  disabledModules: [],
  updatedAt: UPDATED,
};

/** Прогон в объёме строки `entity.query` (без bodyDoc): так его отдаёт производитель списка. */
function run(n: number, props: Record<string, unknown>): WireEntity {
  return wireEntity({
    id: id(n),
    title: `Прогон ${n}`,
    createdAt: '2026-09-20T08:00:00.000Z',
    updatedAt: '2026-09-20T08:30:00.000Z',
    props: {
      'orbis/run_started_at': '2026-09-20T08:00:00.000Z',
      'orbis/last_step_at': '2026-09-20T08:20:00.000Z',
      'orbis/step_count': 1,
      'orbis/run_steps': [
        { seq: 1, at: '2026-09-20T08:20:00.000Z', summary: 'Прочитал задачу', external: false },
      ],
      ...props,
    },
    aspects: ['orbis/agent-run'],
  });
}

/** Запись с телом: `bodyDoc` кладёт производитель ответа детали (include просит документ). */
function detailEntity(
  n: number,
  title: string,
  aspects: string[],
  props: Record<string, unknown>,
  over: Partial<WireEntity> = {},
): WireEntity {
  const body = over.body ?? `${title}: заметки к записи.`;
  return wireEntity({
    id: id(n),
    title,
    body,
    bodyDoc: parseBody(body),
    createdAt: CREATED,
    updatedAt: UPDATED,
    aspects,
    props,
    ...over,
  });
}

// --- Значения по аспектам (BUILTIN_PROPERTY_META): по одной правдоподобной записи на аспект ----

const SCHEDULE = {
  'orbis/start_at': '2026-09-25T07:00:00.000Z',
  'orbis/end_at': '2026-09-25T08:00:00.000Z',
  'orbis/location': 'Кабинет 4',
};
const TASK = {
  'orbis/task_status': 'planned',
  'orbis/priority': 'high',
  'orbis/due_date': '2026-09-26',
};
const FINANCIAL = {
  'orbis/amount': '340.00',
  'orbis/currency': 'RUB',
  'orbis/direction': 'expense',
  'orbis/finance_category': CATEGORY.id,
  'orbis/occurred_on': '2026-09-20',
};
const GOAL = {
  // Источник — ДЕРЕВО Q-AST (§А5-2), как его пишет производитель новой формы.
  'orbis/progress_source': {
    query: { filter: { aspect: 'orbis/financial', props: { 'orbis/direction': 'income' } } },
    aggregate: 'sum',
    field: 'orbis/amount',
  },
  'orbis/target_value': '300000.00',
  'orbis/unit': '₽',
};
const GOAL_PROGRESS = { current: '150000.00', target: '300000.00' };
const PROJECT = { 'orbis/project_stage': 'active' };
const ASSIGNMENT_AGENT = {
  'orbis/executor': 'agent',
  'orbis/grant': GRANT_ID,
  'orbis/may_close': false,
};

const TICKET_ID = id(111);
const ROUTINE_ID = id(113);
/** «Тикет + рутина» — запись с задачей, назначением и рутиной разом (`TICKET_ROUTINE_FIXTURE`). */
const TICKET_ROUTINE_ID = id(126);

/**
 * Прогоны по родителю — то, что экран читает запросом `children_of=<запись>, aspect=orbis/agent-run`
 * (useTicketRuns). Ни один не `running`: идущий прогон включает опрос, и экран не стабилизировался
 * бы никогда.
 */
const RUNS_BY_PARENT: Readonly<Record<string, WireEntity[]>> = {
  // Тикет ждёт ответа: последний прогон остановился вопросом (TicketWaitingBlock).
  [TICKET_ID]: [
    run(801, {
      'orbis/grant': GRANT_ID,
      'orbis/run_outcome': 'checkpoint',
      'orbis/run_checkpoint': {
        question: 'Какую ветку брать за основу?',
        asked_at: '2026-09-20T08:20:00.000Z',
      },
    }),
  ],
  // Рутина: вчерашний прогон завершился (RoutineStatusBlock, история без колонки гранта).
  [ROUTINE_ID]: [
    run(802, {
      'orbis/run_routine': ROUTINE_ID,
      'orbis/run_bucket': '2026-09-20T07:00',
      'orbis/run_outcome': 'finished',
      'orbis/run_finished_at': '2026-09-20T08:30:00.000Z',
      'orbis/run_report': 'Разобрал входящие.',
    }),
  ],
  // Тикет, он же рутина: прогон рутины завершился и ждёт проверки — тикет стоит в `waiting`
  // (TicketWaitingBlock с «Закрыть тикет»), рутина показывает его последним (RoutineStatusBlock).
  [TICKET_ROUTINE_ID]: [
    run(803, {
      'orbis/run_routine': TICKET_ROUTINE_ID,
      'orbis/run_bucket': '2026-09-20T07:00',
      'orbis/run_outcome': 'finished',
      'orbis/run_finished_at': '2026-09-20T08:30:00.000Z',
      'orbis/run_report': 'Входящие разобраны, проверьте.',
    }),
  ],
};

const WORLD: ReadonlyMap<string, WireEntity> = new Map(
  [CATEGORY, SUBTASK, BLOCKER, MENTIONER, ...Object.values(RUNS_BY_PARENT).flat()].map((e) => [
    e.id,
    e,
  ]),
);

// --- Фикстуры ----------------------------------------------------------------------------------

const MAIN_ID = id(120);

export const STRUCTURE_FIXTURES: readonly StructureFixture[] = [
  // 13 записей — по одному встроенному аспекту из первых тринадцати BUILTIN_ASPECT_IDS, в том же
  // порядке. Эталон снят ДО аспекта №14 `orbis/page` (срез 1а, задача 4): записи страницы здесь нет
  // намеренно — сверку ведёт `ASPECTS_AT_CAPTURE` (`structure.test.tsx`), эталоны не переснимаются.
  {
    name: 'schedule',
    entity: detailEntity(101, 'Встреча с бухгалтером', ['orbis/schedule'], SCHEDULE),
  },
  { name: 'task', entity: detailEntity(102, 'Оплатить интернет', ['orbis/task'], TASK) },
  {
    name: 'financial',
    entity: detailEntity(103, 'Кофе у дома', ['orbis/financial'], FINANCIAL),
  },
  {
    name: 'note',
    entity: detailEntity(
      104,
      'Идеи для отпуска',
      ['orbis/note'],
      { 'orbis/content_type': 'markdown', 'orbis/pinned': true },
      { emoji: '🏖️' },
    ),
  },
  {
    name: 'budget',
    entity: detailEntity(105, 'Кофе — сентябрь', ['orbis/budget'], {
      'orbis/finance_category': CATEGORY.id,
      'orbis/limit': '3000.00',
      'orbis/currency': 'RUB',
      'orbis/period_start': '2026-09-01',
      'orbis/period_end': '2026-09-30',
    }),
  },
  {
    name: 'category',
    entity: detailEntity(
      106,
      'Такси',
      ['orbis/category'],
      {
        'orbis/icon': '🚕',
        'orbis/color': '#AA5500',
        'orbis/aliases': ['яндекс го', 'ситимобил'],
        'orbis/spend_class': 'discretionary',
      },
      { emoji: '🚕' },
    ),
  },
  {
    name: 'memory',
    entity: detailEntity(107, 'Кофейня → Кофе', ['orbis/memory'], {
      'orbis/memory_kind': 'rule',
      'orbis/rule_pattern': 'кофейня',
      'orbis/rule_target': CATEGORY.id,
    }),
  },
  {
    name: 'goal',
    entity: detailEntity(108, 'Накопить на отпуск', ['orbis/goal'], GOAL),
    extra: { goalProgress: GOAL_PROGRESS },
  },
  { name: 'project', entity: detailEntity(109, 'Ремонт кухни', ['orbis/project'], PROJECT) },
  {
    name: 'repo',
    entity: detailEntity(110, 'orbis', ['orbis/repo'], {
      'orbis/repo_url': 'https://github.com/qvenge/orbis',
      'orbis/default_branch': 'main',
    }),
  },
  {
    // Назначение без задачи: сервер его так не запрещает, и карточка назначения стоит у любой
    // записи, где оно уже есть (DetailScreen, «Детали»).
    name: 'assignment',
    entity: detailEntity(112, 'Разобрать почту', ['orbis/assignment'], {
      'orbis/executor': 'human',
      'orbis/assignee': 'Анна',
    }),
  },
  {
    name: 'agent-run',
    entity: detailEntity(
      114,
      'Прогон: обновить зависимости',
      ['orbis/agent-run'],
      {
        'orbis/grant': GRANT_ID,
        'orbis/run_outcome': 'finished',
        'orbis/run_started_at': '2026-09-20T08:00:00.000Z',
        'orbis/run_finished_at': '2026-09-20T08:30:00.000Z',
        'orbis/last_step_at': '2026-09-20T08:25:00.000Z',
        'orbis/step_count': 2,
        'orbis/run_steps': [
          { seq: 1, at: '2026-09-20T08:10:00.000Z', summary: 'Прочитал задачу', external: false },
          { seq: 2, at: '2026-09-20T08:25:00.000Z', summary: 'Открыл PR', external: true },
        ],
        'orbis/run_report': 'Зависимости обновлены, PR открыт.',
      },
      { body: '' },
    ),
  },
  {
    name: 'routine',
    entity: detailEntity(113, 'Утренний разбор входящих', ['orbis/routine'], {
      'orbis/routine_stage': 'active',
      'orbis/routine_at': '07:00',
      'orbis/routine_days': ['mo', 'we', 'fr'],
      'orbis/routine_mode': 'propose',
      'orbis/allowed_tools': ['entity_query', 'entity_update'],
    }),
  },
  // Частые сочетания
  {
    name: 'ticket',
    entity: detailEntity(111, 'Обновить зависимости', ['orbis/task', 'orbis/assignment'], {
      'orbis/task_status': 'waiting',
      'orbis/priority': 'medium',
      'orbis/waiting_for': 'Какую ветку брать за основу?',
      ...ASSIGNMENT_AGENT,
    }),
  },
  {
    name: 'recurring-payment',
    entity: detailEntity(121, 'Подписка на музыку', ['orbis/financial', 'orbis/schedule'], {
      ...FINANCIAL,
      'orbis/amount': '299.00',
      'orbis/recurring': true,
      'orbis/start_at': '2026-09-28T09:00:00.000Z',
      'orbis/recurrence': { freq: 'monthly', interval: 1 },
    }),
  },
  {
    name: 'project-task',
    entity: detailEntity(122, 'Выбрать плитку', ['orbis/project', 'orbis/task'], {
      ...PROJECT,
      ...TASK,
    }),
  },
  {
    name: 'goal-schedule',
    entity: detailEntity(123, 'Пробежать полумарафон', ['orbis/goal', 'orbis/schedule'], {
      ...GOAL,
      ...SCHEDULE,
    }),
    extra: { goalProgress: GOAL_PROGRESS },
  },
  {
    // Задача-покупка: плановая операция с задачей — ради неё карточка «план → факт» (§2.7).
    name: 'financial-task',
    entity: detailEntity(124, 'Купить кофемолку', ['orbis/financial', 'orbis/task'], {
      ...FINANCIAL,
      'orbis/amount': '4500.00',
      'orbis/planned': true,
      ...TASK,
    }),
  },
  { name: 'note-plain', entity: detailEntity(125, 'Мысли вслух', [], {}) },
  {
    name: 'with-relations',
    entity: detailEntity(120, 'Сдать декларацию', ['orbis/task'], TASK),
    extra: {
      relations: [
        {
          id: id(701),
          sourceId: MAIN_ID,
          targetId: SUBTASK.id,
          role: 'subitem',
          meta: {},
          createdAt: CREATED,
          updatedAt: CREATED,
        },
        {
          id: id(702),
          sourceId: BLOCKER.id,
          targetId: MAIN_ID,
          role: 'dependency',
          meta: {},
          createdAt: CREATED,
          updatedAt: CREATED,
        },
      ],
      backlinks: [{ entity: MENTIONER, via: 'mention', viaLabel: 'Упоминание' }],
    },
  },
];

/**
 * «Тикет + рутина» (остаток 1а №29): задача с назначением, которая сама рутина. НЕ входит в
 * `STRUCTURE_FIXTURES`: эталон `golden/detail-structure.json` снят ровно с тех записей и не
 * переснимается (РП-24), а сверка «эталон снят с этих фикстур» требует совпадения имён.
 */
export const TICKET_ROUTINE_FIXTURE: StructureFixture = {
  name: 'ticket-routine',
  entity: detailEntity(
    126,
    'Разбирать входящие по утрам',
    ['orbis/task', 'orbis/assignment', 'orbis/routine'],
    {
      'orbis/task_status': 'waiting',
      'orbis/priority': 'medium',
      'orbis/waiting_for': 'Входящие разобраны, проверьте.',
      ...ASSIGNMENT_AGENT,
      'orbis/routine_stage': 'active',
      'orbis/routine_at': '07:00',
      'orbis/routine_days': ['mo', 'we', 'fr'],
      'orbis/routine_mode': 'propose',
      'orbis/allowed_tools': ['entity_query', 'entity_update'],
    },
  ),
};

// --- Обработчик ---------------------------------------------------------------------------------

/** Строка `entity.resolveRefs`: заголовок и завершаемость (секция блокировок, K17). */
function suggestion(e: WireEntity) {
  const status = e.props['orbis/task_status'];
  return {
    id: e.id,
    title: e.title,
    emoji: e.emoji,
    completable:
      typeof status === 'string'
        ? { class: status, closed: status === 'done' || status === 'cancelled' }
        : null,
    archived: e.archived,
  };
}

/**
 * Ответ на все пути экрана записи. Каждый путь — тем, что сервер отдал бы на эту запись; путь,
 * которого здесь нет, получает `{}` — соглашение корпуса (harness.tsx) для мутаций и прочего,
 * что экран при открытии не читает.
 */
export function structureHandler(f: StructureFixture): MockHandler {
  const main = f.entity;
  return (path, input) => {
    const reg = registryReply(path);
    if (reg !== undefined) return reg;
    switch (path) {
      case 'entity.get': {
        const wanted = (input as { id: string }).id;
        const base = {
          relations: [],
          backlinks: [],
          thread: { threadId: `thread-${wanted}`, messages: [] },
          // Версия реестра едет в каждом ответе детали (§А10-1); совпадает со снимком обвязки,
          // иначе экран перечитывал бы реестр и счёт запросов мерил бы расхождение фикстуры.
          registryVersion: BUILTIN_REGISTRY.version,
        };
        if (wanted === main.id) return { ...base, entity: main, ...f.extra };
        const other = WORLD.get(wanted);
        if (other === undefined) throw trpcError('NOT_FOUND');
        return { ...base, entity: other };
      }
      case 'entity.query': {
        const text = JSON.stringify(input);
        // История прогонов (useTicketRuns): дети записи с аспектом прогона.
        if (text.includes('orbis/agent-run')) return RUNS_BY_PARENT[main.id] ?? [];
        // Выдачи ссылочных свойств (RefField, бейдж категории, строка правила памяти).
        if (text.includes('orbis/category')) return [CATEGORY];
        return [];
      }
      case 'entity.resolveRefs':
        return (input as { ids: string[] }).ids.flatMap((rid) => {
          const e = WORLD.get(rid);
          return e === undefined ? [] : [suggestion(e)];
        });
      case 'entity.suggest':
        return [];
      case 'entity.count':
        return { count: 0 };
      case 'user.getSettings':
        return SETTINGS;
      case 'version.list':
        return [];
      case 'oauth.listGrants':
        return GRANTS;
      case 'agentRun.sweep':
        return { swept: 0 };
      case 'routine.overview':
        return {
          nextBucketAt: '2026-09-25T04:00:00.000Z',
          lastRun: null,
          waiting: 0,
          openProposal: false,
          undecided: 0,
        };
      case 'routine.proposalsForEntity':
        return [];
      case 'routine.runUnits':
        return [];
      case 'chat.ensureThread':
        return { threadId: `thread-${main.id}` };
      case 'chat.listMessages':
        return [];
      default:
        return {};
    }
  };
}

// --- Съёмка -------------------------------------------------------------------------------------

export interface DetailCapture {
  structure: DetailStructure;
  /** Число вызовов каждого пути tRPC до стабилизации экрана, ключи по алфавиту. */
  requests: Record<string, number>;
}

/** Сколько тихих проходов подряд считается «экран встал»; шаг прохода — `SETTLE_STEP_MS`. */
const SETTLE_QUIET_TICKS = 3;
const SETTLE_STEP_MS = 30;
const SETTLE_MAX_TICKS = 200;

/**
 * Рендер записи и ожидание стабилизации: подвисания нет, строка заголовка встала, а снимок и
 * число запросов не меняются несколько проходов подряд.
 *
 * Одного `waitFor(native-row)` мало, и это замерено устройством экрана, а не угадано: строка
 * заголовка встаёт с ответом `entity.get`, а карточки аспектов — только с ответом реестра,
 * история прогонов — с ответом `entity.query`. Снимок в момент «строка встала» зафиксировал бы
 * гонку ответов, а не экран.
 *
 * `ui` — экран, который снимают: по умолчанию сегодняшний `DetailScreen`; задачи 12 и 14
 * подают сюда новый экран с теми же фикстурами. Стек навигации, версию реестра и продуктовые
 * умолчания запросов ставит сама функция; на вызывающем тесте — только заглушка простоя
 * (`vi.stubGlobal('requestIdleCallback', …)` в `beforeEach`) и `localStorage.clear()`, см.
 * `structure.test.tsx`.
 */
export async function captureDetail(
  f: StructureFixture,
  ui: ReactNode = createElement(DetailScreen, { entityId: f.entity.id }),
): Promise<DetailCapture> {
  // Версия реестра живёт в МОДУЛЕ, а не в QueryClient, и переживает тест. Ставим её явно, как у
  // работающего приложения, где реестр уже прочитан до открытия записи: без этого счёт
  // `registry.effective` зависел бы от того, какая фикстура шла первой. Гонки холодного старта
  // (второй запрос реестра) больше нет — ключ снимка один, версия его только инвалидирует
  // (`useRegistry`, срез 1б); холодный старт проверяет отдельный тест `structure.test.tsx`.
  resetRegistryVersionForTests();
  noteRegistryVersion(BUILTIN_REGISTRY.version);
  useNav.setState({
    activeTab: 'browser',
    stacks: { chat: [], browser: [{ kind: 'entity', id: f.entity.id }], agenda: [], budget: [] },
  });
  // Умолчания запросов — ПРОДУКТОВЫЕ (trpc.ts): счёт запросов меряет экран, а не обвязку. С
  // нулевым `staleTime` обвязки поздний подписчик уже приехавшего ключа перезапрашивал бы его, и
  // эталон нёс бы повторы, которых продукт не делает, в числе, зависящем от порядка монтирования.
  const { container, calls, unmount } = renderWithProviders(ui, structureHandler(f), {
    queries: queryClient.getDefaultOptions().queries,
  });
  await waitFor(() => {
    if (container.querySelector('[data-testid="harness-suspended"]') !== null)
      throw new Error(`${f.name}: дерево подвисло под Suspense`);
    if (
      container.querySelector('[data-testid="native-row"],[data-testid="native-memory"]') === null
    )
      throw new Error(`${f.name}: строка заголовка не встала`);
  });
  let last = '';
  let quiet = 0;
  for (let tick = 0; quiet < SETTLE_QUIET_TICKS; tick++) {
    if (tick >= SETTLE_MAX_TICKS) throw new Error(`${f.name}: экран не стабилизировался`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_STEP_MS));
    });
    const now = JSON.stringify([calls.length, snapshotDetailStructure(container)]);
    quiet = now === last ? quiet + 1 : 0;
    last = now;
  }
  const structure = snapshotDetailStructure(container);
  const counts = new Map<string, number>();
  for (const c of calls) counts.set(c.path, (counts.get(c.path) ?? 0) + 1);
  const requests = Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)));
  unmount();
  return { structure, requests };
}
