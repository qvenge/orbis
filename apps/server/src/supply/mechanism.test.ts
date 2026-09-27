// apps/server/src/supply/mechanism.test.ts
// Механизм поставки (срез 1б §9.1, РП-6, С1б-6): релиз записи поставки не трогает — новый эталон и новая
// запись поставки только ПРЕДЛАГАЮТСЯ; «принять» закрепляет прежнюю версию, «оставить своё» помнится до
// следующего эталона, «вернуть как было» возвращает печать эталона в записи. Против живой БД; записи
// поставки в фикстуре создаёт механизм `supply` (`supplyCreateOps`) — сам сев графа делает задача 12.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  APP_HOME,
  APP_NAV,
  APP_NAV_FORM,
  type GraphId,
  newId,
  SUPPLY_DECLINED,
  SUPPLY_HASH,
  SUPPLY_KEY,
  SUPPLY_TEXT,
} from '@orbis/shared';
import {
  APP_PRINT_PROPS,
  etalonOf,
  parseAppPrint,
  parsePagePrint,
  printPageRecord,
  SUPPLY_ETALONS,
  SUPPLY_KEYS,
  type SupplyEtalon,
  type SupplyKey,
  supplyStatusOf,
} from '@orbis/shared/supply';
import { sql } from 'drizzle-orm';
import { appDb, freshGraph, personal, requireEnv, truncateAll } from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import { ExecError } from '../errors';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import { undoAction } from '../executor/undo';
import { effectiveRegistry } from '../registry/cache';
import { dispatchTool } from '../tools/dispatch';
import { etalonHash } from './hash';
import {
  acceptAll,
  acceptUpdate,
  addSupplyRecord,
  declineUpdate,
  listUpdates,
  revertToEtalon,
} from './mechanism';
import { canonicalPageText, supplyCreateOps, supplyRecordId } from './records';

requireEnv();

const { db, client } = appDb();
const sink = makeChatJournalSink();

beforeAll(async () => {
  await truncateAll();
});
afterAll(async () => {
  await client.end();
});

const ctxOf = (graph: GraphId) => ({ db, identity: personal(graph) });

/** Эталоны кода с подменой одного — «новый релиз» для механизма (инъекция списка эталонов). */
function withEtalon(
  base: readonly SupplyEtalon[],
  key: SupplyKey,
  patch: Partial<Extract<SupplyEtalon, { kind: 'page' | 'template' }>> &
    Partial<Extract<SupplyEtalon, { kind: 'app' }>>,
): SupplyEtalon[] {
  return base.map((e) => (e.key === key ? ({ ...e, ...patch } as SupplyEtalon) : e));
}

function etalonIn(list: readonly SupplyEtalon[], key: SupplyKey): SupplyEtalon {
  const e = list.find((x) => x.key === key);
  if (e === undefined) throw new Error(`нет эталона ${key}`);
  return e;
}

/** Записи поставки механизмом `supply` — как их заводит сев графа (задача 12). */
async function seedSupply(
  graph: GraphId,
  keys: readonly SupplyKey[] = SUPPLY_KEYS,
  etalons: readonly SupplyEtalon[] = SUPPLY_ETALONS,
): Promise<void> {
  const reg = await withIdentity(db, personal(graph), (tx) => effectiveRegistry(tx, graph));
  const ops = supplyCreateOps(
    graph,
    keys,
    (k) => (keys.includes(k) ? supplyRecordId(graph, k) : null),
    reg,
    etalons,
  );
  const r = await execute(
    db,
    {
      identity: personal(graph),
      actorKind: 'owner',
      source: 'ui',
      mechanism: 'supply',
      batchId: newId(),
      operations: ops,
    },
    { sink },
  );
  if (!r.ok) throw new Error(`сев записей поставки: ${JSON.stringify(r.error)}`);
}

interface Row {
  title: string;
  emoji: string | null;
  body: string;
  aspects: string[];
  props: Record<string, unknown>;
  archived: boolean;
  updatedAt: string;
}

async function rowOf(graph: GraphId, id: string): Promise<Row> {
  const rows = await withIdentity(db, personal(graph), (tx) =>
    tx.execute(
      sql`SELECT title, emoji, body, aspects, props, archived, updated_at FROM entities WHERE id = ${id}::uuid`,
    ),
  );
  const r = rows[0] as
    | {
        title: string;
        emoji: string | null;
        body: string;
        aspects: string[];
        props: Record<string, unknown>;
        archived: boolean;
        updated_at: Date | string;
      }
    | undefined;
  if (r === undefined) throw new Error(`запись ${id} не найдена`);
  return {
    title: r.title,
    emoji: r.emoji,
    body: r.body,
    aspects: r.aspects,
    props: r.props,
    archived: r.archived,
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

const statusOf = (r: Row) => supplyStatusOf(r);

/** Правка владельца обычным путём (механизм `user`). */
async function ownerEdit(graph: GraphId, input: Record<string, unknown>): Promise<void> {
  const r = await execute(
    db,
    {
      identity: personal(graph),
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool: 'entity_update', input }],
    },
    { sink },
  );
  if (!r.ok) throw new Error(`правка владельца: ${JSON.stringify(r.error)}`);
}

async function editBody(graph: GraphId, id: string, body: string): Promise<void> {
  const row = await rowOf(graph, id);
  await ownerEdit(graph, { id, body, expectedUpdatedAt: row.updatedAt });
}

async function versionsOf(graph: GraphId, id: string): Promise<{ label: string; body: string }[]> {
  const rows = await withIdentity(db, personal(graph), (tx) =>
    tx.execute(
      sql`SELECT label, body FROM entity_versions WHERE entity_id = ${id}::uuid ORDER BY created_at`,
    ),
  );
  return rows.map((r) => ({ label: r.label as string, body: r.body as string }));
}

/** Записи журнала с этим action: по одной на действие, заголовок карточки — подпись. */
async function journalOf(graph: GraphId, actionId: string): Promise<{ title: string }[]> {
  const probe = JSON.stringify({ actions: [{ id: actionId }] });
  const rows = await withIdentity(db, personal(graph), (tx) =>
    tx.execute(
      sql`SELECT metadata -> 'cards' -> 0 ->> 'title' AS title FROM chat_messages WHERE metadata @> ${probe}::jsonb`,
    ),
  );
  return rows.map((r) => ({ title: r.title as string }));
}

async function execErrorOf(p: Promise<unknown>): Promise<ExecError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ExecError) return e;
    throw e;
  }
  throw new Error('ожидался отказ ExecError, вызов успешен');
}

async function undo(graph: GraphId, actionId: string): Promise<void> {
  const r = await undoAction(db, { identity: personal(graph), actionId });
  if (!r.ok) throw new Error(`undo: ${JSON.stringify(r.error)}`);
}

async function canonical(graph: GraphId, text: string): Promise<string> {
  const reg = await withIdentity(db, personal(graph), (tx) => effectiveRegistry(tx, graph));
  return canonicalPageText(text, reg);
}

const HOME_V2 = 'Добро пожаловать.\n\n{{apps}}';
const HOME_V3 = 'Добро пожаловать домой.\n\n{{apps}}';

describe('отпечаток эталона (РП-6, Э-2)', () => {
  test('смена одного заголовка эталона меняет отпечаток; тот же эталон — тот же отпечаток', () => {
    for (const key of SUPPLY_KEYS) {
      const e = etalonOf(key);
      expect(etalonHash({ ...e })).toBe(etalonHash(e));
      expect(etalonHash({ ...e, title: `${e.title}!` })).not.toBe(etalonHash(e));
    }
    // Кодовая форма — по ключам: отпечаток оболочки одинаков в любом графе и не зависит от id.
    expect(etalonHash(etalonOf('host-shell'))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('(а) запись поставки после создания', () => {
  test('страница, шаблон и оболочка — «как в поставке», отпечаток = etalonHash(эталон)', async () => {
    const graph = await freshGraph();
    await seedSupply(graph);
    for (const key of SUPPLY_KEYS) {
      const row = await rowOf(graph, supplyRecordId(graph, key));
      expect([key, statusOf(row)]).toEqual([key, 'etalon']);
      expect(row.props[SUPPLY_KEY]).toBe(key);
      expect(row.props[SUPPLY_HASH]).toBe(etalonHash(etalonOf(key)));
      expect(row.props[SUPPLY_DECLINED]).toBeUndefined();
    }
    // Печать страницы в графе — с каноническим телом этого графа; оболочки — с id вместо ключей.
    const home = await rowOf(graph, supplyRecordId(graph, 'home'));
    expect(home.props[SUPPLY_TEXT]).toBe(
      printPageRecord({ title: 'Домой', emoji: '🏠', body: await canonical(graph, '{{apps}}') }),
    );
    const shell = await rowOf(graph, supplyRecordId(graph, 'host-shell'));
    expect(parseAppPrint(shell.props[SUPPLY_TEXT] as string).props).toEqual({
      [APP_HOME]: supplyRecordId(graph, 'home'),
      [APP_NAV]: [
        'records',
        'daily-planning',
        'upcoming',
        'all-tasks',
        'horizon-year',
        'routines',
      ].map((k) => supplyRecordId(graph, k as SupplyKey)),
      [APP_NAV_FORM]: 'header-list',
    });
    // Списки — прежние id сева (`seedSmartListId`): ссылки на них у владельца переживают перевод.
    expect(supplyRecordId(graph, 'daily-planning')).not.toBe(supplyRecordId(graph, 'home'));
  });
});

describe('(б) обновления — только предложения', () => {
  test('эталоны кода = эталоны записей → обновлений нет', async () => {
    const graph = await freshGraph();
    await seedSupply(graph);
    expect(await listUpdates(ctxOf(graph))).toEqual([]);
  });

  test('новый эталон кода → {kind:update, edited:false}; правка владельца → edited:true; запись не тронута', async () => {
    const graph = await freshGraph();
    await seedSupply(graph);
    const id = supplyRecordId(graph, 'home');
    const before = await rowOf(graph, id);
    const next = withEtalon(SUPPLY_ETALONS, 'home', { text: HOME_V2 });
    expect(await listUpdates(ctxOf(graph), next)).toEqual([
      { key: 'home', kind: 'update', recordId: id, edited: false, declined: false },
    ]);
    // Предложение ничего не пишет: запись та же до байта.
    expect(await rowOf(graph, id)).toEqual(before);

    await editBody(graph, id, 'Моя домашняя\n\n{{apps}}');
    expect(await listUpdates(ctxOf(graph), next)).toEqual([
      { key: 'home', kind: 'update', recordId: id, edited: true, declined: false },
    ]);
  });
});

describe('(в) «принять»', () => {
  test('страница: прежняя версия закреплена, тело = новый эталон, hash/text новые, declined снят, один action; Undo возвращает', async () => {
    const graph = await freshGraph();
    await seedSupply(graph);
    const id = supplyRecordId(graph, 'home');
    const next = withEtalon(SUPPLY_ETALONS, 'home', { text: HOME_V2 });
    await declineUpdate(ctxOf(graph), 'home', next);
    const before = await rowOf(graph, id);
    expect(before.props[SUPPLY_DECLINED]).toBe(etalonHash(etalonIn(next, 'home')));

    const { actionId } = await acceptUpdate(ctxOf(graph), 'home', next);
    const after = await rowOf(graph, id);
    const body = await canonical(graph, HOME_V2);
    expect(after.body).toBe(body);
    expect(after.props[SUPPLY_HASH]).toBe(etalonHash(etalonIn(next, 'home')));
    expect(after.props[SUPPLY_TEXT]).toBe(printPageRecord({ title: 'Домой', emoji: '🏠', body }));
    expect(after.props[SUPPLY_DECLINED]).toBeUndefined();
    expect(statusOf(after)).toBe('etalon');
    expect(await versionsOf(graph, id)).toEqual([{ label: 'Прежняя версия', body: before.body }]);
    expect(await journalOf(graph, actionId)).toEqual([
      { title: 'Принять обновление поставки «Домой»' },
    ]);
    expect(await listUpdates(ctxOf(graph), next)).toEqual([]);

    await undo(graph, actionId);
    const back = await rowOf(graph, id);
    expect(back.body).toBe(before.body);
    expect(back.props[SUPPLY_HASH]).toBe(before.props[SUPPLY_HASH]);
    expect(back.props[SUPPLY_TEXT]).toBe(before.props[SUPPLY_TEXT]);
    expect(back.props[SUPPLY_DECLINED]).toBe(before.props[SUPPLY_DECLINED]);
    expect(await versionsOf(graph, id)).toEqual([]);
  });

  test('оболочка: свойства места = новый эталон с id этого графа', async () => {
    const graph = await freshGraph();
    await seedSupply(graph);
    const id = supplyRecordId(graph, 'host-shell');
    const next = withEtalon(SUPPLY_ETALONS, 'host-shell', {
      nav: ['records', 'horizon-life'],
      navForm: 'home-hub',
    });
    await acceptUpdate(ctxOf(graph), 'host-shell', next);
    const after = await rowOf(graph, id);
    expect(after.props[APP_NAV]).toEqual([
      supplyRecordId(graph, 'records'),
      supplyRecordId(graph, 'horizon-life'),
    ]);
    expect(after.props[APP_NAV_FORM]).toBe('home-hub');
    expect(statusOf(after)).toBe('etalon');
    expect(after.props[SUPPLY_HASH]).toBe(etalonHash(etalonIn(next, 'host-shell')));
  });

  test('обновления нет — отказ VALIDATION, ничего не записано', async () => {
    const graph = await freshGraph();
    await seedSupply(graph);
    const err = await execErrorOf(acceptUpdate(ctxOf(graph), 'home'));
    expect(err.code).toBe('VALIDATION');
    expect(await versionsOf(graph, supplyRecordId(graph, 'home'))).toEqual([]);
  });
});

describe('(г) «оставить своё»', () => {
  test('declined = отпечаток нового эталона, больше не предлагается; ещё более новый эталон — снова', async () => {
    const graph = await freshGraph();
    await seedSupply(graph);
    const id = supplyRecordId(graph, 'home');
    const v2 = withEtalon(SUPPLY_ETALONS, 'home', { text: HOME_V2 });
    const { actionId } = await declineUpdate(ctxOf(graph), 'home', v2);
    const row = await rowOf(graph, id);
    expect(row.props[SUPPLY_DECLINED]).toBe(etalonHash(etalonIn(v2, 'home')));
    // Отказ — не принятие: эталон записи прежний, содержимое не тронуто.
    expect(row.props[SUPPLY_HASH]).toBe(etalonHash(etalonOf('home')));
    expect(await journalOf(graph, actionId)).toEqual([{ title: 'Оставить своё: «Домой»' }]);
    expect(await listUpdates(ctxOf(graph), v2)).toEqual([]);

    const v3 = withEtalon(SUPPLY_ETALONS, 'home', { text: HOME_V3 });
    expect(await listUpdates(ctxOf(graph), v3)).toEqual([
      { key: 'home', kind: 'update', recordId: id, edited: false, declined: true },
    ]);
  });
});

describe('(д) «принять все»', () => {
  test('принимает только неправленые — одним action', async () => {
    const graph = await freshGraph();
    await seedSupply(graph);
    const next = withEtalon(withEtalon(SUPPLY_ETALONS, 'home', { text: HOME_V2 }), 'records', {
      text: 'Все записи.\n\n{{records}}',
    });
    await editBody(graph, supplyRecordId(graph, 'records'), 'Моё\n\n{{records}}');
    const r = await acceptAll(ctxOf(graph), next);
    expect(r.accepted).toEqual(['home']);
    if (r.actionId === null) throw new Error('ожидался action');
    expect(await journalOf(graph, r.actionId)).toHaveLength(1);
    expect(await listUpdates(ctxOf(graph), next)).toEqual([
      {
        key: 'records',
        kind: 'update',
        recordId: supplyRecordId(graph, 'records'),
        edited: true,
        declined: false,
      },
    ]);
  });

  test('неправленых обновлений нет → {actionId: null, accepted: []}', async () => {
    const graph = await freshGraph();
    await seedSupply(graph);
    expect(await acceptAll(ctxOf(graph))).toEqual({ actionId: null, accepted: [] });
  });
});

describe('(е) «вернуть как было»', () => {
  test('страница: заголовок, эмодзи и тело = parsePagePrint(supply_text), прежнее тело закреплено версией', async () => {
    const graph = await freshGraph();
    await seedSupply(graph);
    const id = supplyRecordId(graph, 'horizon-year');
    await editBody(graph, id, 'Мои цели\n\n{{query:aspect=orbis/goal, title=Цели}}');
    await ownerEdit(graph, { id, title: 'Мой год', emoji: '🏔️' });
    const edited = await rowOf(graph, id);
    expect(statusOf(edited)).toBe('edited');

    const { actionId } = await revertToEtalon(ctxOf(graph), 'horizon-year');
    const after = await rowOf(graph, id);
    const print = parsePagePrint(after.props[SUPPLY_TEXT] as string);
    expect({ title: after.title, emoji: after.emoji, body: after.body }).toEqual(print);
    expect(statusOf(after)).toBe('etalon');
    // Свойства эталона «вернуть как было» не трогает.
    expect(after.props[SUPPLY_HASH]).toBe(edited.props[SUPPLY_HASH]);
    expect(await versionsOf(graph, id)).toEqual([{ label: 'Прежняя версия', body: edited.body }]);
    expect(await journalOf(graph, actionId)).toEqual([{ title: 'Вернуть как было: «Мой год»' }]);
  });

  test('оболочка хоста: свойства места = parseAppPrint(supply_text); Undo возвращает правку владельца', async () => {
    const graph = await freshGraph();
    await seedSupply(graph);
    const id = supplyRecordId(graph, 'host-shell');
    const mine = await execute(
      db,
      {
        identity: personal(graph),
        actorKind: 'owner',
        source: 'ui',
        operations: [{ tool: 'entity_create', input: { title: 'Моя страница', tags: [] } }],
      },
      { sink },
    );
    if (!mine.ok) throw new Error('создание страницы');
    const myPage = (mine.results[0] as { id: string }).id;
    await ownerEdit(graph, {
      id,
      props: { [APP_NAV]: [supplyRecordId(graph, 'records'), myPage], [APP_NAV_FORM]: 'home-hub' },
    });
    const edited = await rowOf(graph, id);
    expect(statusOf(edited)).toBe('edited');

    const { actionId } = await revertToEtalon(ctxOf(graph), 'host-shell');
    const after = await rowOf(graph, id);
    const print = parseAppPrint(after.props[SUPPLY_TEXT] as string);
    const place = (props: Record<string, unknown>) =>
      Object.fromEntries(
        APP_PRINT_PROPS.filter((p) => props[p] !== undefined).map((p) => [p, props[p]]),
      );
    expect(place(after.props)).toEqual(print.props);
    expect(statusOf(after)).toBe('etalon');

    await undo(graph, actionId);
    const back = await rowOf(graph, id);
    expect(place(back.props)).toEqual(place(edited.props));
  });

  test('запись и так как в поставке — отказ VALIDATION', async () => {
    const graph = await freshGraph();
    await seedSupply(graph);
    expect((await execErrorOf(revertToEtalon(ctxOf(graph), 'home'))).code).toBe('VALIDATION');
  });
});

describe('(ж) новая запись поставки', () => {
  test('нет записи ключа → {kind:new}; «добавить» создаёт её «как в поставке»', async () => {
    const graph = await freshGraph();
    await seedSupply(
      graph,
      SUPPLY_KEYS.filter((k) => k !== 'records'),
    );
    expect(await listUpdates(ctxOf(graph))).toEqual([
      { key: 'records', kind: 'new', recordId: null, edited: false, declined: false },
    ]);
    const { actionId } = await addSupplyRecord(ctxOf(graph), 'records');
    const row = await rowOf(graph, supplyRecordId(graph, 'records'));
    expect(statusOf(row)).toBe('etalon');
    expect(row.props[SUPPLY_HASH]).toBe(etalonHash(etalonOf('records')));
    expect(await journalOf(graph, actionId)).toEqual([{ title: 'Добавить из поставки: «Записи»' }]);
    expect(await listUpdates(ctxOf(graph))).toEqual([]);
  });

  test('архивная запись ключа → ничего не предлагается, и «добавить» — отказ', async () => {
    const graph = await freshGraph();
    await seedSupply(graph);
    const id = supplyRecordId(graph, 'home');
    await ownerEdit(graph, { id, archived: true });
    const next = withEtalon(SUPPLY_ETALONS, 'home', { text: HOME_V2 });
    expect(await listUpdates(ctxOf(graph), next)).toEqual([]);
    expect((await execErrorOf(addSupplyRecord(ctxOf(graph), 'home'))).code).toBe('VALIDATION');
  });

  test('запись есть — «добавить» — отказ VALIDATION', async () => {
    const graph = await freshGraph();
    await seedSupply(graph);
    expect((await execErrorOf(addSupplyRecord(ctxOf(graph), 'records'))).code).toBe('VALIDATION');
  });
});

describe('(з) свойства эталона пишет только механизм supply', () => {
  test('агент (dispatchTool entity_update) пишет orbis/supply_key → COMPUTED_WRITE', async () => {
    const graph = await freshGraph();
    await seedSupply(graph);
    const d = await dispatchTool(
      { db, identity: personal(graph), actorKind: 'agent', source: 'mcp', explicitCommand: false },
      'entity_update',
      { id: supplyRecordId(graph, 'home'), props: { [SUPPLY_KEY]: 'records' } },
    );
    expect(d.status).toBe('error');
    if (d.status !== 'error') return;
    expect(d.error.code).toBe('COMPUTED_WRITE');
    expect((await rowOf(graph, supplyRecordId(graph, 'home'))).props[SUPPLY_KEY]).toBe('home');
  });
});
