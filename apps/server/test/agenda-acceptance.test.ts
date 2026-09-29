// apps/server/test/agenda-acceptance.test.ts
// ПРИЁМКА ПОВЕСТКИ (спека 1в С1в-6, §6.1–§6.2, §3.3, §4.2): запись поставки «Повестка» в графе,
// заведённом как у владельца (`seedOwnerGraph`), и три блока её тела — одной пачкой `entity.blocks`
// (`runBlocks`), с параметром горизонта, как их шлёт экран.
//
// Мир — таблица «когда» (`seedWhenWorld`) на НАСТОЯЩЕМ «сегодня» владельца в поясе
// `Asia/Novosibirsk` (+07:00: не запасной `Europe/Moscow` и не пояс процесса), плюс еженедельный
// шаблон повтора расписания: старт `today+1` — ВНУТРИ горизонта (гейт I-1 задачи 9: шаблон со стартом в
// прошлом лента и «Дальше» отсекали бы и без `!class=orbis/recurrence:templates`, и «шаблона нет» было бы
// истинно при любом теле), экземпляры `today+1` и `today+8` в горизонте материализации (14 дней),
// `today+15` — за ним. Сверх таблицы — `LONG`: «начать послезавтра, срок через 20 дней» — даты и в
// горизонте, и за ним; ровно она различает «Дальше» с отрицанием `=$period` и без него (без отрицания
// она стояла бы и в ленте, и в «Дальше»). Часы пачки — один момент `NOW` на весь сьют (вход `now` у `runBlocks`), «сегодня»
// мира считается от него же: сьют, начатый у полуночи, не разъедется на двое суток.
//
// Тексты блоков — из тела записи «Повестка» (`parsePageText`), а не литералы: приёмка держит ровно
// то, что сеет поставка, — в том числе каноническую форму ленты с `params` (перенос M-5 ревью
// задачи 6: подстановка → окно → группы).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  addDays,
  type BlockDayGroup,
  type BlockResult,
  type GraphId,
  recurringInstanceId,
} from '@orbis/shared';
import { parsePageText } from '@orbis/shared/doc/page-grammar';
import { AGENDA_BODY } from '@orbis/shared/supply';
import { eq, sql } from 'drizzle-orm';
import { userSettings } from '../src/db/schema';
import { withIdentity } from '../src/db/with-identity';
import { execute } from '../src/executor/executor';
import { runBlocks } from '../src/routers/entity-blocks';
import { seedOwnerGraph } from '../src/seed/onboarding';
import { supplyRecordId } from '../src/supply/records';
import { appDb, freshGraph, personal, requireEnv } from './helpers';
import { localIso, seedWhenWorld, type WhenName, type WhenWorld } from './when-world';

requireEnv();
const { db, client } = appDb();
afterAll(async () => {
  await client.end();
});

const TZ = 'Asia/Novosibirsk';
const NOW = new Date();
/** «Сегодня» владельца в его поясе — тем же способом, каким его считает сервер (en-CA = ISO). */
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(NOW);
const TOMORROW_NOW = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);

type Name = WhenName | 'I1' | 'I8' | 'TPL' | 'LONG';

let graph: GraphId;
let world: WhenWorld;
let agendaId: string;
let template: string;
let long: string;
/** Тексты трёх блоков тела Повестки по порядку: «Просрочено», лента, «Дальше». */
let texts: [string, string, string];

beforeAll(async () => {
  graph = await freshGraph();
  await seedOwnerGraph(db, personal(graph));
  await withIdentity(db, personal(graph), (tx) =>
    tx.update(userSettings).set({ timezone: TZ }).where(eq(userSettings.graphId, graph)),
  );
  world = await seedWhenWorld(graph, { today: TODAY, timeZone: TZ });
  const r = await execute(db, {
    identity: personal(graph),
    actorKind: 'owner',
    source: 'ui',
    mechanism: 'user',
    operations: [
      {
        tool: 'entity_create',
        input: {
          title: 'Еженедельная планёрка',
          tags: [],
          aspects: ['orbis/schedule'],
          props: {
            'orbis/start_at': localIso(addDays(TODAY, 1), '09:00', TZ),
            'orbis/timezone': TZ,
            'orbis/recurrence': { freq: 'weekly', interval: 1 },
          },
        },
      },
    ],
  });
  if (!r.ok) throw new Error(`шаблон повтора: ${r.error.code} — ${r.error.message}`);
  template = (r.results[0] as { id: string }).id;
  const l = await execute(db, {
    identity: personal(graph),
    actorKind: 'owner',
    source: 'ui',
    mechanism: 'user',
    operations: [
      {
        tool: 'entity_create',
        input: {
          title: 'LONG начать послезавтра, срок через 20 дней',
          tags: [],
          aspects: ['orbis/schedule', 'orbis/task'],
          props: {
            'orbis/start_at': localIso(addDays(TODAY, 2), '09:00', TZ),
            'orbis/due_date': addDays(TODAY, 20),
            'orbis/task_status': 'planned',
          },
        },
      },
    ],
  });
  if (!l.ok) throw new Error(`запись LONG: ${l.error.code} — ${l.error.message}`);
  long = (l.results[0] as { id: string }).id;

  agendaId = supplyRecordId(graph, 'agenda');
  const rows = await withIdentity(db, personal(graph), (tx) =>
    tx.execute(sql`SELECT body FROM entities WHERE id = ${agendaId}::uuid`),
  );
  const body = rows[0]?.body as string | undefined;
  // Тело записи — эталон как есть: канон его не двигает (`seed-canon.test.ts`).
  expect(body).toBe(AGENDA_BODY);
  const queries = parsePageText(body as string).flatMap((n) =>
    n.kind === 'query' ? [n.text] : [],
  );
  if (queries.length !== 3) throw new Error(`в теле Повестки ${queries.length} блоков, а не 3`);
  texts = queries as [string, string, string];
});

const I = (offset: number) => recurringInstanceId(template, addDays(TODAY, offset));

function nameOf(id: string): Name {
  if (id === template) return 'TPL';
  if (id === long) return 'LONG';
  if (id === I(1)) return 'I1';
  if (id === I(8)) return 'I8';
  const name = world.nameOf.get(id);
  if (name === undefined) throw new Error(`в выдаче запись вне мира: ${id}`);
  return name;
}
const idOf = (name: Name): string =>
  name === 'TPL'
    ? template
    : name === 'LONG'
      ? long
      : name === 'I1'
        ? I(1)
        : name === 'I8'
          ? I(8)
          : world.ids[name];
/** Имена с РАВНЫМ ключом — в порядке их id (последний ключ сортировки, §3.5). */
const byId = (...names: Name[]) => [...names].sort((a, b) => (idOf(a) < idOf(b) ? -1 : 1));

type Rows = Extract<BlockResult, { kind: 'rows' }>;
type Groups = Extract<BlockResult, { kind: 'groups' }>;

interface Agenda {
  overdue: Rows;
  feed: Groups;
  later: Rows;
}

/** Три блока Повестки ОДНОЙ пачкой — с параметром горизонта, как их шлёт экран. */
async function agenda(period: string, now: Date = NOW): Promise<Agenda> {
  const params = { period };
  const res = await runBlocks(
    db,
    personal(graph),
    [
      { key: 'overdue', text: texts[0], params },
      { key: 'feed', text: texts[1], params },
      { key: 'later', text: texts[2], params },
    ],
    now,
  );
  const pick = <K extends 'rows' | 'groups'>(key: string, kind: K) => {
    const r = res.results[key];
    if (!r?.ok || r.kind !== kind) throw new Error(`${key}: ${JSON.stringify(r)}`);
    return r as Extract<BlockResult, { kind: K }>;
  };
  return {
    overdue: pick('overdue', 'rows'),
    feed: pick('feed', 'groups'),
    later: pick('later', 'rows'),
  };
}

const rowNames = (r: Rows) => r.rows.map((x) => nameOf(x.id));
const feedNames = (g: Groups) => g.groups.flatMap((x) => x.rows.map((r) => nameOf(r.entity.id)));
const days = (g: readonly BlockDayGroup[]) =>
  g.map((x) => [x.day, x.rows.map((r) => nameOf(r.entity.id))] as const);

describe('Повестка на 7 дней (С1в-6, §6.1)', () => {
  test('«Просрочено» — открытое, у которого все даты позади: только T2', async () => {
    const a = await agenda('next_7d');
    expect(rowNames(a.overdue)).toEqual(['T2']);
  });

  test('лента по дням: встречи, сроки и сделанное сегодня; шаблона нет; закрытые — в closedIds', async () => {
    const { feed } = await agenda('next_7d');
    expect(days(feed.groups)).toEqual([
      [TODAY, [...byId('E2', 'T11a'), 'T3']],
      [addDays(TODAY, 1), ['T7', ...byId('T9', 'I1')]],
      [addDays(TODAY, 2), byId('E1', 'T10', 'LONG')],
      [addDays(TODAY, 3), ['T1']],
      [addDays(TODAY, 4), []],
      [addDays(TODAY, 5), []],
      [addDays(TODAY, 6), []],
      [addDays(TODAY, 7), []],
    ]);
    expect(feed.more).toBe(0);
    const closed = feed.closedIds.map(nameOf);
    expect(closed).toEqual(expect.arrayContaining(['T3', 'T11a']));
    // Шаблон стоит в горизонте (старт завтра) — фильтр шаблонов в ленте несущий: без него шаблон стоял
    // бы в ленте рядом со своим экземпляром.
    expect(feedNames(feed)).not.toContain('TPL');
  });

  test('«Дальше» — дата за горизонтом и ни одной в нём, по ключу: экземпляр +8, затем T8 по сроку', async () => {
    const { later } = await agenda('next_7d');
    // T8 начат вчера: ключ «самая ранняя дата» поставил бы его первым — ключ здесь — срок (+30).
    expect(rowNames(later)).toEqual(['I8', 'T8']);
  });

  test('три блока делят открытые записи с датами без остатка и пересечений (§3.3)', async () => {
    const a = await agenda('next_7d');
    const seen = [...rowNames(a.overdue), ...feedNames(a.feed), ...rowNames(a.later)];
    const count = (n: Name) => seen.filter((x) => x === n).length;
    const openNames = [
      'E1',
      'E2',
      'T1',
      'T2',
      'T7',
      'T8',
      'T9',
      'T10',
      'LONG',
      'I1',
      'I8',
    ] as const;
    for (const open of openNames) {
      expect([open, count(open)]).toEqual([open, 1]);
    }
    // Без дат «когда» — ни в одном; сделанное вчера (T4) ушло; шаблон повтора — ни в одном.
    for (const none of ['T5', 'T6', 'T11b', 'N1', 'T4', 'TPL', 'F1'] as const) {
      expect([none, count(none)]).toEqual([none, 0]);
    }
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe('Повестка на 14 дней и «завтра»', () => {
  test('горизонт 14 дней: экземпляр +8 уходит в ленту, «Дальше» — только T8', async () => {
    const a = await agenda('next_14d');
    expect(rowNames(a.overdue)).toEqual(['T2']);
    expect(feedNames(a.feed)).toContain('I8');
    expect(
      a.feed.groups.find((g) => g.day === addDays(TODAY, 8))?.rows.map((r) => nameOf(r.entity.id)),
    ).toEqual(['I8']);
    // `next_14d` — сегодня и 14 дней вперёд (края токена, §3.4): пятнадцать дней ленты.
    expect(a.feed.groups).toHaveLength(15);
    expect(rowNames(a.later)).toEqual(['T8']);
  });

  // После тестов, где считаются экземпляры: пачка «назавтра» материализует горизонт от завтра — экземпляр
  // `today+15`, которого «Дальше» на 14 дней выше не ждёт. Ниже в сьюте — только бейдж: он считает
  // «Просрочено», экземпляр за горизонтом его не касается.
  test('назавтра сделанное сегодня (T3) из ленты уходит', async () => {
    const { feed } = await agenda('next_7d', TOMORROW_NOW);
    expect(feedNames(feed)).not.toContain('T3');
    expect(feed.groups[0]?.day).toBe(addDays(TODAY, 1));
  });
});

describe('бейдж раздела «Повестка» (§6.2)', () => {
  test('число первого блока данных — «Просрочено» по умолчаниям параметра: 1', async () => {
    const res = await runBlocks(db, personal(graph), [{ key: 'badge', badgeOf: agendaId }], NOW);
    expect(res.results.badge).toEqual({ ok: true, kind: 'count', count: 1 });
  });
});
