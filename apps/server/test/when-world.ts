// apps/server/test/when-world.ts
// ФИКСТУРА ТАБЛИЦЫ СЛУЧАЕВ «КОГДА» (спека 1в С1в-1, §3.3, §4.2) — задачи 1, 2, 6, 9.
//
// Мир — записи с датами «когда» во всех формах, которые различает правило значения «даты»:
// события (момент), задачи (срок; время завершения — факт; задача без срока, закрытая сегодня — T12), запись с двумя аспектами, двумя
// привязками одного слота (расписание + аспект владельца), аспект владельца с датой-фактом,
// закрытое без времени закрытия, запись без дат вовсе и запись о деньгах (слот `amount`).
//
// ДАТЫ — СМЕЩЕНИЯМИ ОТ `today`: задача 9 зовёт фикстуру с настоящим «сегодня» владельца, эта
// задача — с `2026-07-15` (среда). Времена — местные пояса `timeZone`; в базу уходят ISO со
// смещением этого пояса на тот день (`localIso`), как их пишет клиент владельца.
//
// Записи — ЧЕРЕЗ ИСПОЛНИТЕЛЬ (`execute`, механизм `user`, `source: 'ui'`), а не вставкой строк:
// так правило каталога `task_completed_at` ставит и снимает `orbis/completed_at` по-настоящему.
// Правило ставит `completed_at = updated_at`, то есть реальное «сейчас», а мир живёт в `today`
// фикстуры: у `T3`, `T4`, `T12` статус `done` ставится первой пачкой, а время закрытия переписывается
// ВТОРОЙ. Правило срабатывает только на ВХОДЕ в класс «сделано» — повторная правка штампа при
// статусе `done` его не будит, и штамп фикстуры остаётся. `T7` проходит правило целиком: `done`,
// затем обратно `planned` — правило снимает штамп, и запись возвращается на свои даты.
import type { GraphId } from '@orbis/shared';
import { addDays } from '@orbis/shared';
import { execute } from '../src/executor/executor';
import { enableFinanceForTest } from './finance-on';
import { appDb, type CustomAspectSpec, personal, seedCustomAspect } from './helpers';

/** Аспект владельца: момент (timestamp) и завершаемость — как дело гейта §С8-18. */
export const WHEN_PLAIN_KEY = 'user/when-plain';
/** Аспект владельца с ДАТОЙ-фактом: `done` привязан к свойству `date`, статус — к завершаемости. */
export const WHEN_DONE_KEY = 'user/when-done';

export const WHEN_PROPS = {
  plainAt: 'user/wp_at',
  plainState: 'user/wp_state',
  doneStatus: 'user/wd_status',
  doneAt: 'user/wd_done',
} as const;

const opt = (key: string, ru: string, rank: number) => ({ key, label: { ru }, rank });

export const WHEN_PLAIN_ASPECT: CustomAspectSpec = {
  key: WHEN_PLAIN_KEY,
  label: { ru: 'Дело «когда»', en: 'When item' },
  description: { ru: 'Аспект владельца таблицы «когда»: момент.', en: 'Owner aspect: a moment.' },
  module: null,
  properties: [
    {
      key: 'wp_state',
      type: { kind: 'select', options: [opt('open', 'Открыто', 1), opt('closed', 'Закрыто', 2)] },
    },
    { key: 'wp_at', type: { kind: 'timestamp' } },
  ],
  implements: [
    {
      contract: 'orbis/completable',
      bind: { status: WHEN_PROPS.plainState },
      value_map: [
        { slot: 'status', variant: 'open', class: 'active' },
        { slot: 'status', variant: 'closed', class: 'done' },
      ],
      fixed: {},
    },
    // Тот же слот `moment`, что у расписания: запись с обоими аспектами несёт ДВЕ привязки слота.
    { contract: 'orbis/when', bind: { moment: WHEN_PROPS.plainAt }, value_map: [], fixed: {} },
  ],
};

export const WHEN_DONE_ASPECT: CustomAspectSpec = {
  key: WHEN_DONE_KEY,
  label: { ru: 'Сделанное «когда»', en: 'When done' },
  description: {
    ru: 'Аспект владельца таблицы «когда»: дата-факт.',
    en: 'Owner aspect: a done date.',
  },
  module: null,
  properties: [
    {
      key: 'wd_status',
      type: { kind: 'select', options: [opt('open', 'Открыто', 1), opt('done', 'Сделано', 2)] },
    },
    { key: 'wd_done', type: { kind: 'date' } },
  ],
  implements: [
    {
      contract: 'orbis/completable',
      bind: { status: WHEN_PROPS.doneStatus },
      value_map: [
        { slot: 'status', variant: 'open', class: 'active' },
        { slot: 'status', variant: 'done', class: 'done' },
      ],
      fixed: {},
    },
    { contract: 'orbis/when', bind: { done: WHEN_PROPS.doneAt }, value_map: [], fixed: {} },
  ],
};

/** Имена записей таблицы С1в-1 — ключи мира. */
export const WHEN_NAMES = [
  'E1',
  'E2',
  'T1',
  'T2',
  'T3',
  'T4',
  'T5',
  'T6',
  'T7',
  'T8',
  'T9',
  'T10',
  'T11a',
  'T11b',
  'T12',
  'N1',
  'F1',
] as const;
export type WhenName = (typeof WHEN_NAMES)[number];

export interface WhenWorld {
  /** id записей таблицы по именам. */
  ids: Readonly<Record<WhenName, string>>;
  /** Имя по id — для сравнения выдачи с таблицей. */
  nameOf: ReadonlyMap<string, WhenName>;
  /** Категория `F1` — служебная запись мира, в таблице её нет (ссылку требует `orbis/financial`). */
  helperIds: readonly string[];
}

/**
 * Момент `day` в местное время `hhmm` пояса `timeZone` — ISO со смещением этого пояса на тот день.
 * Смещение считается через `Intl` (как у `instantOfLocal`), а не константой: пояс с летним временем
 * дал бы другое смещение в другой день.
 */
export function localIso(day: string, hhmm: string, timeZone: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  // Смещение пояса в этот момент: разница «стенных часов» пояса и UTC для того же мгновения.
  const offsetAt = (instant: number): number => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date(instant));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    return (
      Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute')) - instant
    );
  };
  const offset = offsetAt(wall - offsetAt(wall));
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset) / 60000;
  const oh = String(Math.floor(abs / 60)).padStart(2, '0');
  const om = String(abs % 60).padStart(2, '0');
  return `${day}T${hhmm}:00${sign}${oh}:${om}`;
}

/**
 * Мир таблицы С1в-1 в графе `graph`. Финансы включаются здесь (`F1` — запись о деньгах), аспекты
 * владельца заводятся декларацией (`seedCustomAspect`), записи — исполнителем.
 */
export async function seedWhenWorld(
  graph: GraphId,
  at: { today: string; timeZone: string },
): Promise<WhenWorld> {
  await enableFinanceForTest(graph);
  await seedCustomAspect(graph, WHEN_PLAIN_ASPECT);
  await seedCustomAspect(graph, WHEN_DONE_ASPECT);
  const day = (offset: number) => addDays(at.today, offset);
  const moment = (offset: number, hhmm: string) => localIso(day(offset), hhmm, at.timeZone);

  const { db, client } = appDb();
  try {
    const run = async (tool: string, input: Record<string, unknown>): Promise<string> => {
      const r = await execute(db, {
        identity: personal(graph),
        actorKind: 'owner',
        source: 'ui',
        mechanism: 'user',
        operations: [{ tool, input }],
      });
      if (!r.ok) throw new Error(`мир «когда» ${tool}: ${r.error.code} — ${r.error.message}`);
      return (r.results[0] as { id: string }).id;
    };
    const create = (title: string, aspects: string[], props: Record<string, unknown> = {}) =>
      run('entity_create', { title, tags: [], aspects, props });
    const update = (id: string, props: Record<string, unknown>) =>
      run('entity_update', { id, props });

    const category = await create('Категория мира «когда»', ['orbis/category']);
    const task = (status: string, due?: number) => ({
      'orbis/task_status': status,
      ...(due === undefined ? {} : { 'orbis/due_date': day(due) }),
    });

    const E1 = await create('E1 событие послезавтра', ['orbis/schedule'], {
      'orbis/start_at': moment(2, '09:00'),
      'orbis/end_at': moment(2, '10:30'),
    });
    const E2 = await create('E2 весь день сегодня', ['orbis/schedule'], {
      'orbis/start_at': moment(0, '00:00'),
      'orbis/all_day': true,
    });
    const T1 = await create('T1 срок через три дня', ['orbis/task'], task('planned', 3));
    const T2 = await create('T2 срок вчера', ['orbis/task'], task('planned', -1));
    const T3 = await create('T3 срок вчера, сделана сегодня', ['orbis/task'], task('done', -1));
    await update(T3, { 'orbis/completed_at': moment(0, '16:05') });
    const T4 = await create('T4 сделана вчера, срок впереди', ['orbis/task'], task('done', 5));
    await update(T4, { 'orbis/completed_at': moment(-1, '10:00') });
    const T5 = await create('T5 отменена', ['orbis/task'], task('cancelled', 1));
    const T6 = await create('T6 без срока', ['orbis/task'], task('planned'));
    const T7 = await create('T7 сделана и возвращена', ['orbis/task'], task('planned', 1));
    await update(T7, { 'orbis/task_status': 'done' });
    await update(T7, { 'orbis/task_status': 'planned' });
    const T8 = await create('T8 начал вчера, срок через месяц', ['orbis/schedule', 'orbis/task'], {
      'orbis/start_at': moment(-1, '09:00'),
      ...task('planned', 30),
    });
    const T9 = await create(
      'T9 начать завтра, срок через три дня',
      ['orbis/schedule', 'orbis/task'],
      {
        'orbis/start_at': moment(1, '09:00'),
        ...task('planned', 3),
      },
    );
    const T10 = await create('T10 два момента', ['orbis/schedule', WHEN_PLAIN_KEY], {
      'orbis/start_at': moment(2, '09:00'),
      [WHEN_PROPS.plainAt]: moment(4, '12:00'),
      [WHEN_PROPS.plainState]: 'open',
    });
    const T11a = await create('T11a дата-факт сегодня', [WHEN_DONE_KEY], {
      [WHEN_PROPS.doneStatus]: 'done',
      [WHEN_PROPS.doneAt]: day(0),
    });
    const T11b = await create('T11b сделана без даты', [WHEN_DONE_KEY], {
      [WHEN_PROPS.doneStatus]: 'done',
    });
    // С1в-6 «сделанное сегодня без срока» (M-4 финального ревью B2b): встроенная задача без срока, закрытая
    // сегодня, — единственная её дата — время закрытия; стоит в ленте «Сегодня» зачёркнутой.
    const T12 = await create('T12 без срока, сделана сегодня', ['orbis/task'], task('done'));
    await update(T12, { 'orbis/completed_at': moment(0, '11:20') });
    const N1 = await create('N1 заметка', ['orbis/note']);
    const F1 = await create('F1 трата', ['orbis/financial'], {
      'orbis/amount': '1500',
      'orbis/currency': 'USD',
      'orbis/direction': 'expense',
      'orbis/finance_category': category,
      'orbis/occurred_on': day(0),
    });

    const ids: Record<WhenName, string> = {
      E1,
      E2,
      T1,
      T2,
      T3,
      T4,
      T5,
      T6,
      T7,
      T8,
      T9,
      T10,
      T11a,
      T11b,
      T12,
      N1,
      F1,
    };
    const nameOf = new Map(Object.entries(ids).map(([name, id]) => [id, name as WhenName]));
    return { ids, nameOf, helperIds: [category] };
  } finally {
    await client.end();
  }
}
