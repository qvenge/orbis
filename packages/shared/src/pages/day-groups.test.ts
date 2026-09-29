// packages/shared/src/pages/day-groups.test.ts
// Раскладка строк группировки по дням (спека 1в §5.2, РП-11) — чистая функция без базы. Пояс
// владельца `Asia/Novosibirsk` (+07:00) — не запасной `Europe/Moscow` и не пояс ПРОЦЕССА: день группы
// обязан считаться в поясе ОТВЕТА. Пояс процесса — UTC: `bun test` без `TZ` ведёт процесс в UTC
// (пин ниже). Пояс машины здесь ни при чём — и он сам +07 (Asia/Barnaul): прогон с `TZ` машины
// порчу «день в поясе процесса» не увидел бы, поэтому пин и держит «процесс не в +07».
// Даты — вокруг `2026-07-15` (среда).
import { describe, expect, test } from 'bun:test';
import { BUILTIN_ASPECT_DEFS } from '../registry/builtin-aspects';
import { BUILTIN_CONTRACT_DEFS } from '../registry/builtin-contracts';
import type { AspectDefinition } from '../registry/property-type';
import type { Entity } from '../schemas/entity';
import {
  type DayGroupField,
  type DayGroupInputRow,
  layoutDayGroups,
  rowAtUntimed,
} from './day-groups';

const TZ = 'Asia/Novosibirsk';
const WHEN: DayGroupField = { kind: 'value', contract: 'orbis/when' };

const schedule = BUILTIN_ASPECT_DEFS.find((a) => a.id === 'orbis/schedule') as AspectDefinition;
/** Аспект владельца: `moment` привязан свойством ДАТЫ (без времени суток). */
const DATE_MOMENT: AspectDefinition = {
  ...schedule,
  id: 'user/when-date',
  key: 'user/when-date',
  implements: [
    { contract: 'orbis/when', bind: { moment: 'user/wd_day' }, value_map: [], fixed: {} },
  ],
};
const REG = {
  aspects: new Map([...BUILTIN_ASPECT_DEFS, DATE_MOMENT].map((a) => [a.id, a])),
  contracts: new Map(BUILTIN_CONTRACT_DEFS.map((c) => [c.id, c])),
};

function entity(id: string, aspects: string[], props: Record<string, unknown> = {}): Entity {
  return {
    id,
    graphId: '00000000-0000-4000-8000-000000000000',
    title: id,
    emoji: null,
    body: '',
    bodyRefs: [],
    tags: [],
    props,
    aspects,
    queryRefs: [],
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    archived: false,
  };
}

type Slot = 'done' | 'moment' | 'deadline';
/** Дата «когда» строки, как её отдаёт SQL: момент (UTC), день в поясе владельца, аспект привязки. */
const d = (slot: Slot, at: string, day: string, aspect: string) => ({ slot, at, day, aspect });

/** Полночь дня в поясе +07:00 — так SQL переводит дату в момент (`propertyValueExprs.at`). */
const midnight = (day: string) => new Date(`${day}T00:00:00+07:00`).toISOString();

function taskDue(id: string, due: string): DayGroupInputRow {
  return {
    entity: entity(id, ['orbis/task'], { 'orbis/task_status': 'planned', 'orbis/due_date': due }),
    keyAt: midnight(due),
    dates: [d('deadline', midnight(due), due, 'orbis/task')],
  };
}

function event(id: string, start: string, props: Record<string, unknown> = {}): DayGroupInputRow {
  const at = new Date(start).toISOString();
  const day = start.slice(0, 10);
  return {
    entity: entity(id, ['orbis/schedule'], { 'orbis/start_at': start, ...props }),
    keyAt: at,
    dates: [d('moment', at, day, 'orbis/schedule')],
  };
}

const layout = (
  rows: DayGroupInputRow[],
  period: { start: string; end: string } | null,
  more = 0,
  field: DayGroupField = WHEN,
) => layoutDayGroups({ rows, more, timeZone: TZ, period, reg: REG, field });

const days = (r: ReturnType<typeof layout>) => r.groups.map((g) => g.day);
const ids = (r: ReturnType<typeof layout>, day: string | null) =>
  r.groups.find((g) => g.day === day)?.rows.map((x) => x.entity.id);

describe('пустые дни периода (§5.2)', () => {
  test('period next_7d — восемь групп подряд, пустые с rows: []', () => {
    const r = layout([taskDue('a', '2026-07-17')], { start: '2026-07-15', end: '2026-07-22' });
    expect(days(r)).toEqual([
      '2026-07-15',
      '2026-07-16',
      '2026-07-17',
      '2026-07-18',
      '2026-07-19',
      '2026-07-20',
      '2026-07-21',
      '2026-07-22',
    ]);
    expect(r.groups.filter((g) => g.rows.length === 0)).toHaveLength(7);
    expect(ids(r, '2026-07-17')).toEqual(['a']);
  });

  test('ровно 31 день — все дни; 32 и 40 дней — только непустые', () => {
    const rows = [taskDue('a', '2026-07-17'), taskDue('b', '2026-08-10')];
    expect(layout(rows, { start: '2026-07-15', end: '2026-08-14' }).groups).toHaveLength(31);
    for (const end of ['2026-08-15', '2026-08-23']) {
      expect(days(layout(rows, { start: '2026-07-15', end }))).toEqual([
        '2026-07-17',
        '2026-08-10',
      ]);
    }
  });

  test('периода нет — только непустые дни', () => {
    expect(days(layout([taskDue('a', '2026-07-20')], null))).toEqual(['2026-07-20']);
  });

  test('строка без ключа — группа «Без даты» (day: null) последней, строка без даты', () => {
    const r = layout(
      [taskDue('a', '2026-07-16'), { entity: entity('n', ['orbis/note']), keyAt: null, dates: [] }],
      null,
    );
    expect(days(r)).toEqual(['2026-07-16', null]);
    expect(r.groups[1]?.rows).toEqual([{ entity: entity('n', ['orbis/note']), at: null }]);
  });

  test('«ещё N» — поле ответа; обрезанный хвост не рисует «свободных» дней после последней строки', () => {
    const r = layout([taskDue('a', '2026-07-16')], { start: '2026-07-15', end: '2026-07-22' }, 5);
    expect(r.more).toBe(5);
    expect(days(r)).toEqual(['2026-07-15', '2026-07-16']);
  });
});

describe('какая дата поставила запись в день — done > moment > deadline (§5.2)', () => {
  test('расписание + задача в один день (Фокус ревью п. 4): moment, одна строка', () => {
    const row: DayGroupInputRow = {
      entity: entity('x', ['orbis/schedule', 'orbis/task'], {
        'orbis/start_at': '2026-07-19T10:00:00+07:00',
        'orbis/due_date': '2026-07-19',
        'orbis/task_status': 'planned',
      }),
      keyAt: midnight('2026-07-19'),
      dates: [
        d('deadline', midnight('2026-07-19'), '2026-07-19', 'orbis/task'),
        d('moment', '2026-07-19T03:00:00.000Z', '2026-07-19', 'orbis/schedule'),
      ],
    };
    const r = layout([row], null);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]?.rows).toHaveLength(1);
    expect(r.groups[0]?.rows[0]?.at).toEqual({
      slot: 'moment',
      value: '2026-07-19T10:00:00+07:00',
      end: null,
      allDay: false,
    });
  });

  test('done и moment в одном дне — done («сделано 16:05»)', () => {
    const row: DayGroupInputRow = {
      entity: entity('x', ['orbis/schedule', 'orbis/task'], {
        'orbis/start_at': '2026-07-15T09:00:00+07:00',
        'orbis/completed_at': '2026-07-15T16:05:00+07:00',
        'orbis/task_status': 'done',
      }),
      keyAt: '2026-07-15T02:00:00.000Z',
      dates: [
        d('moment', '2026-07-15T02:00:00.000Z', '2026-07-15', 'orbis/schedule'),
        d('done', '2026-07-15T09:05:00.000Z', '2026-07-15', 'orbis/task'),
      ],
    };
    expect(layout([row], null).groups[0]?.rows[0]?.at).toEqual({
      slot: 'done',
      value: '2026-07-15T16:05:00+07:00',
      end: null,
      allDay: false,
    });
  });

  test('дата другого дня не выбирается: в дне ключа — только его даты', () => {
    const row: DayGroupInputRow = {
      entity: entity('x', ['orbis/schedule', 'orbis/task'], {
        'orbis/start_at': '2026-07-16T09:00:00+07:00',
        'orbis/due_date': '2026-07-18',
      }),
      // Ключ — срок 07-18 (условие блока его выбрало), момент 07-16 в этот день не входит.
      keyAt: midnight('2026-07-18'),
      dates: [
        d('moment', '2026-07-16T02:00:00.000Z', '2026-07-16', 'orbis/schedule'),
        d('deadline', midnight('2026-07-18'), '2026-07-18', 'orbis/task'),
      ],
    };
    const r = layout([row], null);
    expect(days(r)).toEqual(['2026-07-18']);
    expect(r.groups[0]?.rows[0]?.at?.slot).toBe('deadline');
    expect(r.groups[0]?.rows[0]?.at?.value).toBe('2026-07-18');
  });
});

describe('подробности колонки времени — привязки «когда» аспекта, поставившего moment', () => {
  test('moment со временем и end в тот же день — end = ISO конца', () => {
    const r = layout(
      [
        event('e', '2026-07-17T09:00:00+07:00', {
          'orbis/end_at': '2026-07-17T10:30:00+07:00',
        }),
      ],
      null,
    );
    expect(r.groups[0]?.rows[0]?.at).toEqual({
      slot: 'moment',
      value: '2026-07-17T09:00:00+07:00',
      end: '2026-07-17T10:30:00+07:00',
      allDay: false,
    });
  });

  test('end на другой день — задан (подпись «→ 30.09» рисует web); многодневное — в дне начала', () => {
    const r = layout(
      [
        event('e', '2026-07-16T20:00:00+07:00', {
          'orbis/end_at': '2026-07-18T10:00:00+07:00',
        }),
      ],
      { start: '2026-07-15', end: '2026-07-22' },
    );
    expect(ids(r, '2026-07-16')).toEqual(['e']);
    expect(ids(r, '2026-07-17')).toEqual([]);
    expect(ids(r, '2026-07-18')).toEqual([]);
    expect(r.groups.find((g) => g.day === '2026-07-16')?.rows[0]?.at?.end).toBe(
      '2026-07-18T10:00:00+07:00',
    );
  });

  test('all_day true — allDay', () => {
    const r = layout([event('e', '2026-07-15T00:00:00+07:00', { 'orbis/all_day': true })], null);
    expect(r.groups[0]?.rows[0]?.at).toEqual({
      slot: 'moment',
      value: '2026-07-15T00:00:00+07:00',
      end: null,
      allDay: true,
    });
  });

  test('moment, привязанный свойством типа date (аспект владельца) — allDay, значение — день', () => {
    const row: DayGroupInputRow = {
      entity: entity('o', ['user/when-date'], { 'user/wd_day': '2026-07-16' }),
      keyAt: midnight('2026-07-16'),
      dates: [d('moment', midnight('2026-07-16'), '2026-07-16', 'user/when-date')],
    };
    expect(layout([row], null).groups[0]?.rows[0]?.at).toEqual({
      slot: 'moment',
      value: '2026-07-16',
      end: null,
      allDay: true,
    });
  });
});

describe('внутри дня (§5.2): сначала без времени, затем по времени; равное — по порядку входа', () => {
  test('весь день, срок, done-дата — первыми в порядке входа; моменты — по времени', () => {
    const doneDate: DayGroupInputRow = {
      entity: entity('done-date', ['user/when-date'], { 'user/wd_day': '2026-07-15' }),
      keyAt: midnight('2026-07-15'),
      dates: [d('done', midnight('2026-07-15'), '2026-07-15', 'user/when-date')],
    };
    const rows = [
      event('t0900', '2026-07-15T09:00:00+07:00'),
      taskDue('due', '2026-07-15'),
      event('t0800a', '2026-07-15T08:00:00+07:00'),
      event('allday', '2026-07-15T00:00:00+07:00', { 'orbis/all_day': true }),
      doneDate,
      event('t0800b', '2026-07-15T08:00:00+07:00'),
    ];
    expect(ids(layout(rows, null), '2026-07-15')).toEqual([
      'due',
      'allday',
      'done-date',
      't0800a',
      't0800b',
      't0900',
    ]);
  });
});

describe('день группы — в поясе ОТВЕТА, не процесса (Фокус ревью п. 1)', () => {
  test('пояс процесса — не +07 пояса ответа (иначе порча «пояс процесса» зелёная)', () => {
    expect(new Date('2026-07-15T12:00:00Z').getTimezoneOffset()).not.toBe(-420);
  });

  test('закрыто в 00:20 по Новосибирску (17:20Z накануне) — в своём дне, не во вчерашнем', () => {
    const row: DayGroupInputRow = {
      entity: entity('t', ['orbis/task'], { 'orbis/completed_at': '2026-07-15T00:20:00+07:00' }),
      keyAt: '2026-07-14T17:20:00.000Z',
      dates: [d('done', '2026-07-14T17:20:00.000Z', '2026-07-15', 'orbis/task')],
    };
    const r = layout([row], null);
    expect(days(r)).toEqual(['2026-07-15']);
    expect(r.groups[0]?.rows[0]?.at?.slot).toBe('done');
  });

  test('закрыто в 23:40 по Новосибирску — в этом же дне, не в следующем', () => {
    const row: DayGroupInputRow = {
      entity: entity('t', ['orbis/task'], { 'orbis/completed_at': '2026-07-15T23:40:00+07:00' }),
      keyAt: '2026-07-15T16:40:00.000Z',
      dates: [d('done', '2026-07-15T16:40:00.000Z', '2026-07-15', 'orbis/task')],
    };
    expect(days(layout([row], null))).toEqual(['2026-07-15']);
  });
});

describe('группировка по свойству и по адресу слота — at.slot = null', () => {
  test('свойство-дата: значение — день, allDay; момент — ISO, время', () => {
    const due = layout([taskDue('a', '2026-07-18')], null, 0, {
      kind: 'property',
      propertyId: 'orbis/due_date',
    });
    expect(due.groups[0]?.rows[0]?.at).toEqual({
      slot: null,
      value: '2026-07-18',
      end: null,
      allDay: true,
    });
    const start = layout([event('e', '2026-07-17T09:00:00+07:00')], null, 0, {
      kind: 'property',
      propertyId: 'orbis/start_at',
    });
    expect(start.groups[0]?.rows[0]?.at).toEqual({
      slot: null,
      value: '2026-07-17T09:00:00+07:00',
      end: null,
      allDay: false,
    });
  });

  test('адрес слота: значение той привязки, чей день — день группы (две привязки moment)', () => {
    const plain: AspectDefinition = {
      ...schedule,
      id: 'user/plain',
      key: 'user/plain',
      implements: [
        { contract: 'orbis/when', bind: { moment: 'user/p_at' }, value_map: [], fixed: {} },
      ],
    };
    const reg = { ...REG, aspects: new Map([...REG.aspects, [plain.id, plain]]) };
    const row: DayGroupInputRow = {
      entity: entity('t10', ['orbis/schedule', 'user/plain'], {
        'orbis/start_at': '2026-07-19T12:00:00+07:00',
        'user/p_at': '2026-07-17T09:00:00+07:00',
      }),
      keyAt: '2026-07-17T02:00:00.000Z',
      dates: [],
    };
    const r = layoutDayGroups({
      rows: [row],
      more: 0,
      timeZone: TZ,
      period: null,
      reg,
      field: { kind: 'slot', contract: 'orbis/when', slot: 'moment' },
    });
    expect(r.groups[0]?.day).toBe('2026-07-17');
    expect(r.groups[0]?.rows[0]?.at).toEqual({
      slot: null,
      value: '2026-07-17T09:00:00+07:00',
      end: null,
      allDay: false,
    });
  });
});

describe('rowAtUntimed — одна правда «без времени» для порядка сервера и подписи web', () => {
  const at = (slot: 'done' | 'moment' | 'deadline' | null, value: string, allDay = false) => ({
    slot,
    value,
    end: null,
    allDay,
  });
  test('весь день, срок, дата без часов (и у done, где allDay — false) — без времени', () => {
    expect(rowAtUntimed(at('moment', '2026-07-15T02:00:00.000Z', true))).toBe(true);
    expect(rowAtUntimed(at('deadline', '2026-07-15T02:00:00.000Z'))).toBe(true);
    expect(rowAtUntimed(at('done', '2026-07-15'))).toBe(true);
    expect(rowAtUntimed(at(null, '2026-07-15'))).toBe(true);
  });
  test('момент со временем — со временем (в т.ч. done: «сделано 16:05»)', () => {
    expect(rowAtUntimed(at('moment', '2026-07-15T02:00:00.000Z'))).toBe(false);
    expect(rowAtUntimed(at('done', '2026-07-15T09:05:00.000Z'))).toBe(false);
    expect(rowAtUntimed(at(null, '2026-07-15T02:00:00.000Z'))).toBe(false);
  });
});
