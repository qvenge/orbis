// apps/server/src/routers/day-groups.dataset.test.ts
// ГРУППИРОВКА ПО ДНЯМ НА НАСТОЯЩЕЙ БАЗЕ (спека 1в §5.2, §3.3, §8.2 п. 42; РП-11, РП-12): пачка
// `entity.blocks` над миром таблицы «когда» (`seedWhenWorld`) — «сегодня» `2026-07-15` (среда), пояс
// владельца `Asia/Novosibirsk` (+07:00: не запасной `Europe/Moscow` и не пояс процесса — `bun test`
// без `TZ` ведёт процесс в UTC, пин ниже; машина разработчика сама +07 (Asia/Barnaul), и прогон с `TZ`
// машины порчу «день в поясе процесса» не увидел бы). Часы пачки фиксированы входом `now`
// (`runBlocks`), пояс — строкой настроек владельца, как в бою.
//
// Порядок строк с РАВНЫМ ключом — по `id` (устойчивый порядок §3.5): ожидания таких пар строятся
// сортировкой по id, а не угадываются.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BlockDayGroup, BlockResult, GraphId } from '@orbis/shared';
import { appDb, freshGraph, personal, requireEnv } from '../../test/helpers';
import { localIso, seedWhenWorld, type WhenName, type WhenWorld } from '../../test/when-world';
import { userSettings } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { runBlocks } from './entity-blocks';

requireEnv();
const { db, client } = appDb();
afterAll(async () => {
  await client.end();
});

const TODAY = '2026-07-15';
const TZ = 'Asia/Novosibirsk';
/** Полдень 15.07 по Новосибирску. */
const NOW = new Date('2026-07-15T05:00:00Z');
const FEED = 'orbis/when=next_7d, !class=orbis/recurrence:templates, group=day:orbis/when';

let graph: GraphId;
let world: WhenWorld;

async function ownerIn(g: GraphId, timezone: string): Promise<void> {
  await withIdentity(db, personal(g), (tx) =>
    tx.insert(userSettings).values({ graphId: g, timezone }),
  );
}

beforeAll(async () => {
  graph = await freshGraph();
  await ownerIn(graph, TZ);
  world = await seedWhenWorld(graph, { today: TODAY, timeZone: TZ });
});

type Groups = Extract<BlockResult, { kind: 'groups' }>;

async function block(
  text: string,
  opts: { limit?: number; g?: GraphId; now?: Date } = {},
): Promise<{ result: BlockResult; today: string; timeZone: string }> {
  const res = await runBlocks(
    db,
    personal(opts.g ?? graph),
    [{ key: 'b', text, ...(opts.limit !== undefined && { limit: opts.limit }) }],
    opts.now ?? NOW,
  );
  return { result: res.results.b as BlockResult, today: res.today, timeZone: res.timeZone };
}

async function groupsOf(text: string, opts: { limit?: number } = {}): Promise<Groups> {
  const { result } = await block(text, opts);
  if (!result.ok) throw new Error(`«${text}»: ${result.error.code} — ${result.error.message}`);
  if (result.kind !== 'groups') throw new Error(`«${text}»: вид ответа ${result.kind}`);
  return result;
}

const nameOf = (id: string): WhenName | 'helper' => {
  if (world.helperIds.includes(id)) return 'helper';
  const name = world.nameOf.get(id);
  if (name === undefined) throw new Error(`в выдаче запись вне мира: ${id}`);
  return name;
};
/** Группы именами мира: `[день, [имена в порядке строк]]`. */
const named = (g: readonly BlockDayGroup[]) =>
  g.map((x) => [x.day, x.rows.map((r) => nameOf(r.entity.id))] as const);
/** Имена с РАВНЫМ ключом — в порядке их id (последний ключ сортировки, §3.5). */
const byId = (...names: WhenName[]) =>
  [...names].sort((a, b) => (world.ids[a] < world.ids[b] ? -1 : 1));
const rowOf = (g: Groups, name: WhenName) =>
  g.groups.flatMap((x) => x.rows).find((r) => r.entity.id === world.ids[name]);
const instant = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.NaN);

describe('лента `orbis/when=next_7d, group=day:orbis/when` (§5.2)', () => {
  test('группы по дням в поясе владельца, пустые дни периода, today и пояс в ответе', async () => {
    const { result, today, timeZone } = await block(`${FEED}, display=list`);
    expect(today).toBe(TODAY);
    expect(timeZone).toBe(TZ);
    if (!result.ok || result.kind !== 'groups') throw new Error(JSON.stringify(result));
    expect(named(result.groups)).toEqual([
      ['2026-07-15', [...byId('E2', 'T11a'), 'T12', 'T3']],
      ['2026-07-16', ['T7', 'T9']],
      ['2026-07-17', byId('E1', 'T10')],
      ['2026-07-18', ['T1']],
      ['2026-07-19', []],
      ['2026-07-20', []],
      ['2026-07-21', []],
      ['2026-07-22', []],
    ]);
    expect(result.more).toBe(0);
  });

  test('колонка времени — дата, поставившая запись в день, и её подробности', async () => {
    const g = await groupsOf(FEED);
    expect(rowOf(g, 'E2')?.at).toMatchObject({
      slot: 'moment',
      end: null,
      allDay: true,
      untimed: true,
    });
    expect(rowOf(g, 'T11a')?.at).toEqual({
      slot: 'done',
      value: '2026-07-15',
      end: null,
      allDay: false,
      // done-дата: не «весь день», но без времени — «сделано» без часов, первой в дне.
      untimed: true,
    });
    // С1в-6: задача без срока, закрытая сегодня (T12), — в «сегодня» по времени закрытия.
    const t12 = rowOf(g, 'T12')?.at;
    expect(t12?.slot).toBe('done');
    expect(instant(t12?.value)).toBe(instant(localIso('2026-07-15', '11:20', TZ)));
    expect(t12?.untimed).toBe(false);
    const t3 = rowOf(g, 'T3')?.at;
    expect(t3?.slot).toBe('done');
    expect(instant(t3?.value)).toBe(instant(localIso('2026-07-15', '16:05', TZ)));
    expect(t3?.untimed).toBe(false);
    const e1 = rowOf(g, 'E1')?.at;
    expect(e1?.slot).toBe('moment');
    expect(instant(e1?.value)).toBe(instant(localIso('2026-07-17', '09:00', TZ)));
    expect(instant(e1?.end)).toBe(instant(localIso('2026-07-17', '10:30', TZ)));
    expect(e1?.untimed).toBe(false);
    expect(rowOf(g, 'T7')?.at).toEqual({
      slot: 'deadline',
      value: '2026-07-16',
      end: null,
      allDay: false,
      untimed: true,
    });
    // «Начать завтра, срок через три дня» — в дне начала, дата строки (срок 07-18) — у web.
    const t9 = rowOf(g, 'T9')?.at;
    expect(t9?.slot).toBe('moment');
    expect(instant(t9?.value)).toBe(instant(localIso('2026-07-16', '09:00', TZ)));
    // Два момента T10 (расписание 07-17, аспект владельца 07-19) — одна строка, в раннем дне.
    expect(
      g.groups.flatMap((x) => x.rows).filter((r) => r.entity.id === world.ids.T10),
    ).toHaveLength(1);
  });

  test('closedIds — записи набора «закрыто» (п. 42): T3, T11a и T12', async () => {
    const g = await groupsOf(FEED);
    expect(g.closedIds.map(nameOf).sort()).toEqual(['T11a', 'T12', 'T3']);
  });

  test('лимит 2 — две строки и «ещё N»; свободных дней после обрезки нет', async () => {
    const g = await groupsOf(FEED, { limit: 2 });
    expect(g.groups.flatMap((x) => x.rows)).toHaveLength(2);
    expect(g.more).toBe(7);
    expect(named(g.groups)).toEqual([['2026-07-15', byId('E2', 'T11a')]]);
  });
});

describe('ключ группы (§3.3, РП-21)', () => {
  test('адрес слота `group=day:orbis/when.deadline` — дни по сырым срокам, at.slot = null', async () => {
    const g = await groupsOf(
      'orbis/when=next_7d, !class=orbis/recurrence:templates, group=day:orbis/when.deadline',
    );
    expect(named(g.groups)).toEqual([
      ['2026-07-14', ['T3']],
      ['2026-07-16', ['T7']],
      ['2026-07-18', byId('T1', 'T9')],
      [null, byId('E1', 'E2', 'T10', 'T11a', 'T12')],
    ]);
    expect(rowOf(g, 'T3')?.at).toEqual({
      slot: null,
      value: '2026-07-14',
      end: null,
      allDay: true,
      untimed: true,
    });
    expect(rowOf(g, 'E1')?.at).toBeNull();
  });

  test('`orbis/when>=2026-07-17` — ранняя из дат, удовлетворяющих условию: T9 в дне срока 07-18', async () => {
    const g = await groupsOf('orbis/when>=2026-07-17, group=day:orbis/when');
    expect(named(g.groups)).toEqual([
      ['2026-07-17', byId('E1', 'T10')],
      ['2026-07-18', byId('T1', 'T9')],
      ['2026-08-14', ['T8']],
    ]);
    expect(rowOf(g, 'T9')?.at?.slot).toBe('deadline');
  });

  test('без условия на адресе — записи без дат группой «Без даты» последней', async () => {
    const g = await groupsOf('aspect=orbis/task, group=day:orbis/when');
    const last = g.groups[g.groups.length - 1];
    expect(last?.day).toBeNull();
    expect(last?.rows.map((r) => nameOf(r.entity.id))).toEqual(byId('T5', 'T6'));
    expect(g.groups.filter((x) => x.day === null)).toHaveLength(1);
  });

  test('(перенос M-2) список `=a|b` — положительное условие ключа: T8 в дне 08-14, не 07-14', async () => {
    const g = await groupsOf('orbis/when=2026-07-17|2026-08-14, group=day:orbis/when');
    expect(named(g.groups)).toEqual([
      ['2026-07-17', byId('E1', 'T10')],
      ['2026-08-14', ['T8']],
    ]);
    // Тот же ключ у сортировки: T8 — последним, его дата 07-14 списку не удовлетворяет.
    const { result } = await block('orbis/when=2026-07-17|2026-08-14, sortBy=orbis/when:asc');
    if (!result.ok || result.kind !== 'rows') throw new Error(JSON.stringify(result));
    expect(result.rows.map((r) => nameOf(r.id))).toEqual([...byId('E1', 'T10'), 'T8']);
  });
});

describe('период блока — пересечение условий на адресе (М-2 ревью B1)', () => {
  // Ключ дня — дата, удовлетворяющая ВСЕМ условиям; период «свободных» дней — их пересечение, в любом
  // порядке условий. Прежний «первый годный интервал» дал бы здесь весь июль — 30 пустых дней.
  const TODAY_ROWS: WhenName[] = [...byId('E2', 'T11a'), 'T12', 'T3'];
  test('`=this_month, =today` и `=today, =this_month` — один день, без «свободного» месяца', async () => {
    for (const text of [
      'orbis/when=this_month, orbis/when=today, group=day:orbis/when',
      'orbis/when=today, orbis/when=this_month, group=day:orbis/when',
    ]) {
      const g = await groupsOf(text);
      expect([text, named(g.groups)]).toEqual([text, [['2026-07-15', TODAY_ROWS]]]);
    }
  });

  test('`=next_7d` и `range` 07-16..07-30 — период 07-16..07-22, пустые дни только внутри', async () => {
    const g = await groupsOf(
      'orbis/when=next_7d, orbis/when=2026-07-16..2026-07-30, !class=orbis/recurrence:templates, group=day:orbis/when',
    );
    expect(g.groups.map((x) => x.day)).toEqual([
      '2026-07-16',
      '2026-07-17',
      '2026-07-18',
      '2026-07-19',
      '2026-07-20',
      '2026-07-21',
      '2026-07-22',
    ]);
  });

  test('открытый край одного условия берёт край у другого: `=overdue, =this_month` — 07-01..07-14', async () => {
    const g = await groupsOf('orbis/when=overdue, orbis/when=this_month, group=day:orbis/when');
    expect(g.groups[0]?.day).toBe('2026-07-01');
    expect(g.groups.at(-1)?.day).toBe('2026-07-14');
    expect(g.groups).toHaveLength(14);
  });
});

describe('признак «закрыто» у строк (РП-12, п. 42)', () => {
  test('ответ `rows` несёт closedIds — записи набора closed завершаемости', async () => {
    const { result } = await block('orbis/when=today, display=list');
    if (!result.ok || result.kind !== 'rows') throw new Error(JSON.stringify(result));
    expect(result.rows.map((r) => nameOf(r.id)).sort()).toEqual(['E2', 'T11a', 'T12', 'T3']);
    expect(result.closedIds.map(nameOf).sort()).toEqual(['T11a', 'T12', 'T3']);
    // Набор, заданный условием: строка «закрыта» по серверу, а не по проекции web.
    const cancelled = await block('class=orbis/completable:closed, aspect=orbis/task');
    if (!cancelled.result.ok || cancelled.result.kind !== 'rows') throw new Error('rows');
    expect(cancelled.result.rows.map((r) => nameOf(r.id)).sort()).toEqual([
      'T12',
      'T3',
      'T4',
      'T5',
    ]);
    expect(cancelled.result.closedIds.map(nameOf).sort()).toEqual(['T12', 'T3', 'T4', 'T5']);
  });
});

// ─── Отдельные графы: мир не засеян, перечень дней выше не меняется ───

async function run(g: GraphId, tool: string, input: Record<string, unknown>): Promise<string> {
  const r = await execute(db, {
    identity: personal(g),
    actorKind: 'owner',
    source: 'ui',
    mechanism: 'user',
    operations: [{ tool, input }],
  });
  if (!r.ok) throw new Error(`${tool}: ${r.error.code} — ${r.error.message}`);
  return (r.results[0] as { id: string }).id;
}

test('расписание + задача на один день (Фокус ревью п. 4): одна строка в дне 07-19, moment «10:00»', async () => {
  const g = await freshGraph();
  await ownerIn(g, TZ);
  const id = await run(g, 'entity_create', {
    title: 'Встреча со сроком',
    tags: [],
    aspects: ['orbis/schedule', 'orbis/task'],
    props: {
      'orbis/start_at': localIso('2026-07-19', '10:00', TZ),
      'orbis/due_date': '2026-07-19',
      'orbis/task_status': 'planned',
    },
  });
  const { result } = await block(FEED, { g });
  if (!result.ok || result.kind !== 'groups') throw new Error(JSON.stringify(result));
  const all = result.groups.flatMap((x) => x.rows);
  expect(all.map((r) => r.entity.id)).toEqual([id]);
  const day = result.groups.find((x) => x.rows.length > 0);
  expect(day?.day).toBe('2026-07-19');
  expect(day?.rows[0]?.at?.slot).toBe('moment');
  expect(instant(day?.rows[0]?.at?.value)).toBe(instant(localIso('2026-07-19', '10:00', TZ)));
});

test('пояс процесса — не +07 пояса владельца (иначе порча «пояс процесса» зелёная)', () => {
  expect(new Date('2026-07-15T12:00:00Z').getTimezoneOffset()).not.toBe(-420);
});

test('закрыто в 23:40 и в 00:20 по поясу владельца (Фокус ревью п. 1) — в своём дне; назавтра — вне ленты', async () => {
  const g = await freshGraph();
  await ownerIn(g, TZ);
  const closedAt = async (title: string, hhmm: string) => {
    const id = await run(g, 'entity_create', {
      title,
      tags: [],
      aspects: ['orbis/task'],
      props: { 'orbis/task_status': 'done' },
    });
    await run(g, 'entity_update', {
      id,
      props: { 'orbis/completed_at': localIso(TODAY, hhmm, TZ) },
    });
    return id;
  };
  const late = await closedAt('Закрыта поздно', '23:40');
  const early = await closedAt('Закрыта рано', '00:20');
  const { result } = await block(FEED, { g });
  if (!result.ok || result.kind !== 'groups') throw new Error(JSON.stringify(result));
  const today = result.groups.find((x) => x.day === TODAY);
  expect(today?.rows.map((r) => r.entity.id).sort()).toEqual([early, late].sort());
  expect(result.groups.flatMap((x) => x.rows)).toHaveLength(2);
  const tomorrow = await block(FEED, { g, now: new Date('2026-07-16T05:00:00Z') });
  if (!tomorrow.result.ok || tomorrow.result.kind !== 'groups') throw new Error('groups');
  expect(tomorrow.today).toBe('2026-07-16');
  expect(tomorrow.result.groups.flatMap((x) => x.rows)).toHaveLength(0);
});
