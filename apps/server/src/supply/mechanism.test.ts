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
  PAGE_ASPECT,
  SUPPLY_ASPECT,
  SUPPLY_DECLINED,
  SUPPLY_HASH,
  SUPPLY_KEY,
  SUPPLY_TEXT,
} from '@orbis/shared';
import { parsePageText } from '@orbis/shared/doc/page-grammar';
import {
  etalonOf,
  SUPPLY_ETALONS,
  SUPPLY_KEYS,
  type SupplyEtalon,
  type SupplyKey,
  UPCOMING_BODY,
} from '@orbis/shared/supply';
import {
  APP_PRINT_PROPS,
  parseAppPrint,
  parsePagePrint,
  printPageRecord,
  supplyStatusOf,
} from '@orbis/shared/supply/print';
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

/** Пункты «Обновлений» без печатей — форма, о которой спрашивают сценарии; печати — отдельный тест. */
async function updatesOf(ctx: ReturnType<typeof ctxOf>, etalons?: readonly SupplyEtalon[]) {
  return (await listUpdates(ctx, etalons)).map(({ etalonText: _e, recordText: _r, ...u }) => u);
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
        'agenda',
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
    expect(await updatesOf(ctxOf(graph))).toEqual([]);
  });

  test('новый эталон кода → {kind:update, edited:false}; правка владельца → edited:true; запись не тронута', async () => {
    const graph = await freshGraph();
    await seedSupply(graph);
    const id = supplyRecordId(graph, 'home');
    const before = await rowOf(graph, id);
    const next = withEtalon(SUPPLY_ETALONS, 'home', { text: HOME_V2 });
    expect(await updatesOf(ctxOf(graph), next)).toEqual([
      { key: 'home', kind: 'update', recordId: id, edited: false, declined: false },
    ]);
    // Предложение ничего не пишет: запись та же до байта.
    expect(await rowOf(graph, id)).toEqual(before);

    await editBody(graph, id, 'Моя домашняя\n\n{{apps}}');
    expect(await updatesOf(ctxOf(graph), next)).toEqual([
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
    expect(await updatesOf(ctxOf(graph), next)).toEqual([]);

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
    expect(await updatesOf(ctxOf(graph), v2)).toEqual([]);

    const v3 = withEtalon(SUPPLY_ETALONS, 'home', { text: HOME_V3 });
    expect(await updatesOf(ctxOf(graph), v3)).toEqual([
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
    expect(await updatesOf(ctxOf(graph), next)).toEqual([
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

  test('финал B1 m-3: оболочка изменилась после того, что видел клиент, — отказ STALE_VERSION, ничего не записано', async () => {
    const graph = await freshGraph();
    await seedSupply(graph);
    const id = supplyRecordId(graph, 'host-shell');
    const mine = await execute(
      db,
      {
        identity: personal(graph),
        actorKind: 'owner',
        source: 'ui',
        operations: [{ tool: 'entity_create', input: { title: 'Раздел A', tags: [] } }],
      },
      { sink },
    );
    if (!mine.ok) throw new Error('создание страницы');
    const a = (mine.results[0] as { id: string }).id;
    await ownerEdit(graph, { id, props: { [APP_NAV]: [supplyRecordId(graph, 'records'), a] } });
    // Клиент открыл диалог на этой версии («исчезнет: A»)…
    const seen = (await rowOf(graph, id)).updatedAt;
    // …а тем временем агент по просьбе владельца добавил раздел B.
    await new Promise((r) => setTimeout(r, 5));
    const other = await execute(
      db,
      {
        identity: personal(graph),
        actorKind: 'owner',
        source: 'ui',
        operations: [{ tool: 'entity_create', input: { title: 'Раздел B', tags: [] } }],
      },
      { sink },
    );
    if (!other.ok) throw new Error('создание страницы');
    const b = (other.results[0] as { id: string }).id;
    await ownerEdit(graph, { id, props: { [APP_NAV]: [supplyRecordId(graph, 'records'), a, b] } });
    const before = await rowOf(graph, id);

    const err = await execErrorOf(revertToEtalon(ctxOf(graph), 'host-shell', seen));
    expect(err.code).toBe('STALE_VERSION');
    expect(await rowOf(graph, id)).toEqual(before);
    // Та версия, что на сервере, — возврат проходит.
    await revertToEtalon(ctxOf(graph), 'host-shell', before.updatedAt);
    expect(statusOf(await rowOf(graph, id))).toBe('etalon');
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
    expect(await updatesOf(ctxOf(graph))).toEqual([
      { key: 'records', kind: 'new', recordId: null, edited: false, declined: false },
    ]);
    const { actionId } = await addSupplyRecord(ctxOf(graph), 'records');
    const row = await rowOf(graph, supplyRecordId(graph, 'records'));
    expect(statusOf(row)).toBe('etalon');
    expect(row.props[SUPPLY_HASH]).toBe(etalonHash(etalonOf('records')));
    expect(await journalOf(graph, actionId)).toEqual([{ title: 'Добавить из поставки: «Записи»' }]);
    expect(await updatesOf(ctxOf(graph))).toEqual([]);
  });

  test('архивная запись ключа → ничего не предлагается, и «добавить» — отказ', async () => {
    const graph = await freshGraph();
    await seedSupply(graph);
    const id = supplyRecordId(graph, 'home');
    await ownerEdit(graph, { id, archived: true });
    const next = withEtalon(SUPPLY_ETALONS, 'home', { text: HOME_V2 });
    expect(await updatesOf(ctxOf(graph), next)).toEqual([]);
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

// ─────────────────────────── Фикс-раунд 1 (R-16, R-17, R-18; Fable M-1, M-3; Opus m-2) ───────────────────────────

describe('R-16: «вернуть как было» оболочки при архивной странице эталона', () => {
  test('навигация эталона без архивной страницы; статус честно «изменено вами»', async () => {
    const graph = await freshGraph();
    await seedSupply(graph);
    const shell = supplyRecordId(graph, 'host-shell');
    await ownerEdit(graph, { id: supplyRecordId(graph, 'routines'), archived: true });
    // Правка владельца трогает только форму — архивный id в навигации лежит, как лежал.
    await ownerEdit(graph, { id: shell, props: { [APP_NAV_FORM]: 'home-hub' } });

    await revertToEtalon(ctxOf(graph), 'host-shell');
    const after = await rowOf(graph, shell);
    const etalonNav = parseAppPrint(after.props[SUPPLY_TEXT] as string).props[APP_NAV] as string[];
    expect(after.props[APP_NAV]).toEqual(
      etalonNav.filter((id) => id !== supplyRecordId(graph, 'routines')),
    );
    expect(after.props[APP_NAV_FORM]).toBe('header-list');
    expect(statusOf(after)).toBe('edited');
  });

  test('отличие от поставки — только архивная страница → отказ VALIDATION, ничего не записано', async () => {
    const graph = await freshGraph();
    await seedSupply(graph);
    const shell = supplyRecordId(graph, 'host-shell');
    const routines = supplyRecordId(graph, 'routines');
    await ownerEdit(graph, { id: routines, archived: true });
    const nav = (await rowOf(graph, shell)).props[APP_NAV] as string[];
    await ownerEdit(graph, {
      id: shell,
      props: { [APP_NAV]: nav.filter((id) => id !== routines) },
    });
    const before = await rowOf(graph, shell);
    expect((await execErrorOf(revertToEtalon(ctxOf(graph), 'host-shell'))).code).toBe('VALIDATION');
    expect(await rowOf(graph, shell)).toEqual(before);
  });
});

describe('R-17: снятый аспект «поставка» — запись выведена из поставки', () => {
  test('ни предложения, ни new; «принять все» её не трогает; accept/decline/revert — отказ', async () => {
    const graph = await freshGraph();
    await seedSupply(graph);
    const id = supplyRecordId(graph, 'home');
    await ownerEdit(graph, { id, aspects: { detach: [SUPPLY_ASPECT] } });
    const before = await rowOf(graph, id);
    const next = withEtalon(SUPPLY_ETALONS, 'home', { text: HOME_V2 });
    expect(await updatesOf(ctxOf(graph), next)).toEqual([]);
    expect(await acceptAll(ctxOf(graph), next)).toEqual({ actionId: null, accepted: [] });
    for (const call of [
      () => acceptUpdate(ctxOf(graph), 'home', next),
      () => declineUpdate(ctxOf(graph), 'home', next),
      () => revertToEtalon(ctxOf(graph), 'home'),
      () => addSupplyRecord(ctxOf(graph), 'home', next),
    ]) {
      expect((await execErrorOf(call())).code).toBe('VALIDATION');
    }
    expect(await rowOf(graph, id)).toEqual(before);
  });
});

describe('R-18: Undo «добавить» — как будто не добавляли', () => {
  test('add → Undo → снова new → add возвращает ту же запись из архива одним действием', async () => {
    const graph = await freshGraph();
    await seedSupply(
      graph,
      SUPPLY_KEYS.filter((k) => k !== 'records'),
    );
    const id = supplyRecordId(graph, 'records');
    const first = await addSupplyRecord(ctxOf(graph), 'records');
    await undo(graph, first.actionId);
    expect((await rowOf(graph, id)).archived).toBe(true);
    expect(await updatesOf(ctxOf(graph))).toEqual([
      { key: 'records', kind: 'new', recordId: null, edited: false, declined: false },
    ]);

    const again = await addSupplyRecord(ctxOf(graph), 'records');
    const row = await rowOf(graph, id);
    expect(row.archived).toBe(false);
    expect(statusOf(row)).toBe('etalon');
    expect(await journalOf(graph, again.actionId)).toEqual([
      { title: 'Добавить из поставки: «Записи»' },
    ]);
    const count = await withIdentity(db, personal(graph), (tx) =>
      tx.execute(
        sql`SELECT count(*)::int AS n FROM entities WHERE props @> ${JSON.stringify({ [SUPPLY_KEY]: 'records' })}::jsonb`,
      ),
    );
    expect(count[0]?.n).toBe(1);
    expect(await updatesOf(ctxOf(graph))).toEqual([]);
  });

  test('два круга: добавить → Undo → добавить (из архива) → Undo → снова new, третий «добавить» — та же запись', async () => {
    const graph = await freshGraph();
    await seedSupply(
      graph,
      SUPPLY_KEYS.filter((k) => k !== 'records'),
    );
    const id = supplyRecordId(graph, 'records');
    for (let round = 0; round < 2; round += 1) {
      const { actionId } = await addSupplyRecord(ctxOf(graph), 'records');
      expect((await rowOf(graph, id)).archived).toBe(false);
      await undo(graph, actionId);
      expect((await rowOf(graph, id)).archived).toBe(true);
      expect(await updatesOf(ctxOf(graph))).toEqual([
        { key: 'records', kind: 'new', recordId: null, edited: false, declined: false },
      ]);
    }
    await addSupplyRecord(ctxOf(graph), 'records');
    expect((await rowOf(graph, id)).archived).toBe(false);
    expect(await updatesOf(ctxOf(graph))).toEqual([]);
  });

  test('архив владельцем после «добавить» — ничего не предлагается, «добавить» — отказ', async () => {
    const graph = await freshGraph();
    await seedSupply(
      graph,
      SUPPLY_KEYS.filter((k) => k !== 'records'),
    );
    const id = supplyRecordId(graph, 'records');
    await addSupplyRecord(ctxOf(graph), 'records');
    await ownerEdit(graph, { id, archived: true });
    expect(await updatesOf(ctxOf(graph))).toEqual([]);
    expect((await execErrorOf(addSupplyRecord(ctxOf(graph), 'records'))).code).toBe('VALIDATION');
  });

  test('Undo «добавить», затем владелец восстановил и снова архивировал — это его архив', async () => {
    const graph = await freshGraph();
    await seedSupply(
      graph,
      SUPPLY_KEYS.filter((k) => k !== 'records'),
    );
    const id = supplyRecordId(graph, 'records');
    const first = await addSupplyRecord(ctxOf(graph), 'records');
    await undo(graph, first.actionId);
    await ownerEdit(graph, { id, archived: false });
    await ownerEdit(graph, { id, archived: true });
    expect(await updatesOf(ctxOf(graph))).toEqual([]);
  });
});

describe('Fable M-1: «принять» оболочки не перекрывает правку с другой вкладки', () => {
  test('правка навигации между чтением и пачкой → CONFLICT, правка владельца цела', async () => {
    const graph = await freshGraph();
    await seedSupply(graph);
    const shell = supplyRecordId(graph, 'host-shell');
    const next = withEtalon(SUPPLY_ETALONS, 'host-shell', { navForm: 'home-hub' });
    const mine = [supplyRecordId(graph, 'records')];
    const err = await execErrorOf(
      acceptUpdate(ctxOf(graph), 'host-shell', next, {
        afterRead: () => ownerEdit(graph, { id: shell, props: { [APP_NAV]: mine } }),
      }),
    );
    expect(err.code).toBe('CONFLICT');
    const row = await rowOf(graph, shell);
    expect(row.props[APP_NAV]).toEqual(mine);
    expect(row.props[SUPPLY_HASH]).toBe(etalonHash(etalonOf('host-shell')));
  });

  test('раунд 2 финала, m-1: «Вернуть как было» — правка навигации между чтением и пачкой → CONFLICT, правка цела', async () => {
    const graph = await freshGraph();
    await seedSupply(graph);
    const shell = supplyRecordId(graph, 'host-shell');
    const records = supplyRecordId(graph, 'records');
    // Оболочка изменена владельцем — возвращать есть что.
    await ownerEdit(graph, { id: shell, props: { [APP_NAV]: [records] } });
    const seen = (await rowOf(graph, shell)).updatedAt;
    // Между снимком механизма и пачкой агент по просьбе владельца меняет навигацию ещё раз.
    const later = [records, supplyRecordId(graph, 'home')];
    const err = await execErrorOf(
      revertToEtalon(ctxOf(graph), 'host-shell', seen, {
        afterRead: () => ownerEdit(graph, { id: shell, props: { [APP_NAV]: later } }),
      }),
    );
    expect(err.code).toBe('CONFLICT');
    expect((await rowOf(graph, shell)).props[APP_NAV]).toEqual(later);
  });
});

/**
 * Разметка тела без пустых строк между блоками: дерево препрохода без пробельных кусков текста и без
 * исходного текста узлов (`raw` контейнера несёт свои пустые строки).
 */
function blocksOf(text: string): unknown {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      return v.filter((x) => !isBlankText(x)).map(strip);
    }
    if (typeof v === 'object' && v !== null) {
      return Object.fromEntries(
        Object.entries(v)
          .filter(([k]) => k !== 'raw')
          .map(([k, x]) => [k, strip(x)]),
      );
    }
    return v;
  };
  const isBlankText = (x: unknown) =>
    typeof x === 'object' &&
    x !== null &&
    (x as { kind?: unknown }).kind === 'text' &&
    String((x as { text?: unknown }).text).trim() === '';
  return strip(parsePageText(text));
}

describe('Fable M-3: печати для «Сравнить» и неподвижность канона', () => {
  test('update несёт печать нового эталона в графе и нынешнюю печать записи; new — только эталона', async () => {
    const graph = await freshGraph();
    await seedSupply(
      graph,
      SUPPLY_KEYS.filter((k) => k !== 'records'),
    );
    const next = withEtalon(SUPPLY_ETALONS, 'home', { text: HOME_V2 });
    const home = await rowOf(graph, supplyRecordId(graph, 'home'));
    const [u, n] = await listUpdates(ctxOf(graph), next);
    expect(u?.key).toBe('home');
    expect(u?.etalonText).toBe(
      printPageRecord({ title: 'Домой', emoji: '🏠', body: await canonical(graph, HOME_V2) }),
    );
    expect(u?.recordText).toBe(home.props[SUPPLY_TEXT] as string);
    expect(n?.key).toBe('records');
    expect(n?.etalonText).toBe(
      printPageRecord({ title: 'Записи', emoji: '🗂️', body: await canonical(graph, '{{records}}') }),
    );
    expect(n?.recordText).toBeNull();
  });

  test('печать эталона — в КАНОНЕ графа: у шаблона хоста она отличается от сырого текста кода', async () => {
    const graph = await freshGraph();
    await seedSupply(graph);
    const tpl = etalonOf('host-template');
    if (tpl.kind === 'app') throw new Error('шаблон — не приложение');
    const text = tpl.text.replace('{{tab: Тред}}', '{{tab: Обсуждение}}');
    const next = withEtalon(SUPPLY_ETALONS, 'host-template', { text });
    const [u] = await listUpdates(ctxOf(graph), next);
    const canon = printPageRecord({
      title: tpl.title,
      emoji: tpl.emoji,
      body: await canonical(graph, text),
    });
    expect(u?.key).toBe('host-template');
    expect(u?.etalonText).toBe(canon);
    expect(u?.etalonText).not.toBe(
      printPageRecord({ title: tpl.title, emoji: tpl.emoji, body: text }),
    );
  });

  test('канон тела эталона страницы — сам эталон байт в байт; шаблон хоста — та же разметка в каноне', async () => {
    const graph = await freshGraph();
    await seedSupply(graph);
    for (const e of SUPPLY_ETALONS) {
      if (e.kind === 'app') continue;
      const canon = await canonical(graph, e.text);
      // После сева тело записи — канон эталона, и канон неподвижен: пересохранение его не сдвигает.
      expect([e.key, (await rowOf(graph, supplyRecordId(graph, e.key))).body]).toEqual([
        e.key,
        canon,
      ]);
      expect([e.key, await canonical(graph, canon)]).toEqual([e.key, canon]);
      if (e.key === 'host-template') {
        // Шаблон хоста НЕ неподвижная точка: канон ставит пустую строку между блоками вне контейнера.
        // Текст эталона остаётся строкой спеки 1а §8.1 (сверка задачи 17), а «Сравнить» берёт
        // `etalonText` сервера — шума канона в диффе нет. Разметка при этом та же самая.
        expect(blocksOf(canon)).toEqual(blocksOf(e.text));
      } else {
        expect([e.key, canon]).toEqual([e.key, e.text]);
      }
    }
  });
});

describe('Opus m-2: Undo каждого действия возвращает всё', () => {
  test('«оставить своё» → Undo: отказа нет, обновление снова предлагается', async () => {
    const graph = await freshGraph();
    await seedSupply(graph);
    const id = supplyRecordId(graph, 'home');
    const next = withEtalon(SUPPLY_ETALONS, 'home', { text: HOME_V2 });
    const { actionId } = await declineUpdate(ctxOf(graph), 'home', next);
    await undo(graph, actionId);
    expect((await rowOf(graph, id)).props[SUPPLY_DECLINED]).toBeUndefined();
    expect(await updatesOf(ctxOf(graph), next)).toHaveLength(1);
  });

  test('«принять все» → Undo: тела, отпечатки и тексты всех принятых — прежние', async () => {
    const graph = await freshGraph();
    await seedSupply(graph);
    const next = withEtalon(withEtalon(SUPPLY_ETALONS, 'home', { text: HOME_V2 }), 'records', {
      text: 'Все записи.\n\n{{records}}',
    });
    const ids = [supplyRecordId(graph, 'home'), supplyRecordId(graph, 'records')];
    const before = await Promise.all(ids.map((id) => rowOf(graph, id)));
    const r = await acceptAll(ctxOf(graph), next);
    if (r.actionId === null) throw new Error('ожидался action');
    await undo(graph, r.actionId);
    const after = await Promise.all(ids.map((id) => rowOf(graph, id)));
    const content = (x: Row) => ({
      body: x.body,
      hash: x.props[SUPPLY_HASH],
      text: x.props[SUPPLY_TEXT],
    });
    expect(after.map(content)).toEqual(before.map(content));
    for (const id of ids) expect(await versionsOf(graph, id)).toEqual([]);
  });

  test('«принять» оболочки → Undo: свойства места и эталона — прежние', async () => {
    const graph = await freshGraph();
    await seedSupply(graph);
    const id = supplyRecordId(graph, 'host-shell');
    const before = await rowOf(graph, id);
    const next = withEtalon(SUPPLY_ETALONS, 'host-shell', {
      nav: ['records'],
      navForm: 'home-hub',
    });
    const { actionId } = await acceptUpdate(ctxOf(graph), 'host-shell', next);
    await undo(graph, actionId);
    const after = await rowOf(graph, id);
    expect(after.props).toEqual(before.props);
    expect(statusOf(after)).toBe('etalon');
  });

  test('«вернуть как было» страницы → Undo: заголовок и тело владельца, версия снята', async () => {
    const graph = await freshGraph();
    await seedSupply(graph);
    const id = supplyRecordId(graph, 'agenda');
    await editBody(graph, id, 'Моё\n\n{{query:aspect=orbis/task, title=Все}}');
    await ownerEdit(graph, { id, title: 'Моя неделя' });
    const edited = await rowOf(graph, id);
    const { actionId } = await revertToEtalon(ctxOf(graph), 'agenda');
    await undo(graph, actionId);
    const back = await rowOf(graph, id);
    expect({ title: back.title, emoji: back.emoji, body: back.body }).toEqual({
      title: edited.title,
      emoji: edited.emoji,
      body: edited.body,
    });
    expect(await versionsOf(graph, id)).toEqual([]);
  });

  test('«добавить» → Undo: записи в выдаче нет (в архиве)', async () => {
    const graph = await freshGraph();
    await seedSupply(
      graph,
      SUPPLY_KEYS.filter((k) => k !== 'home'),
    );
    const { actionId } = await addSupplyRecord(ctxOf(graph), 'home');
    await undo(graph, actionId);
    expect((await rowOf(graph, supplyRecordId(graph, 'home'))).archived).toBe(true);
  });
});

// ─────────────────────────── Срез 1в: снятый ключ поставки (§6.3, РП-10, Д-13) ───────────────────────────

/**
 * Запись Upcoming ТАКОЙ, какой её оставил сев 1б: страница с аспектом «поставка», ключ `upcoming`, эталон
 * 1б (`UPCOMING_BODY`) печатью в записи, id прежнего сева. Эталона кода у ключа больше нет — записать
 * её можно только механизмом `supply` напрямую, как это сделал сев 1б.
 */
async function seedRetiredUpcoming(graph: GraphId): Promise<string> {
  const id = supplyRecordId(graph, 'upcoming');
  const title = 'Upcoming';
  const emoji = '🗓️';
  const r = await execute(
    db,
    {
      identity: personal(graph),
      actorKind: 'owner',
      source: 'ui',
      mechanism: 'supply',
      batchId: newId(),
      operations: [
        {
          tool: 'entity_create',
          input: {
            id,
            title,
            emoji,
            tags: [],
            body: UPCOMING_BODY,
            aspects: [PAGE_ASPECT, SUPPLY_ASPECT],
            props: {
              [SUPPLY_KEY]: 'upcoming',
              [SUPPLY_HASH]: etalonHash({
                key: 'upcoming' as unknown as SupplyKey,
                kind: 'page',
                title,
                emoji,
                text: UPCOMING_BODY,
              }),
              [SUPPLY_TEXT]: printPageRecord({
                title,
                emoji,
                body: await canonical(graph, UPCOMING_BODY),
              }),
            },
          },
        },
      ],
    },
    { sink },
  );
  if (!r.ok) throw new Error(`запись Upcoming 1б: ${JSON.stringify(r.error)}`);
  return id;
}

describe('снятый с поставки ключ upcoming (1в §6.3)', () => {
  test('«Обновления» его не предлагают — ни обновлением, ни новой записью', async () => {
    const graph = await freshGraph();
    await seedSupply(graph);
    await seedRetiredUpcoming(graph);
    expect(await updatesOf(ctxOf(graph))).toEqual([]);
    // Правленая — тоже: эталона, от которого считать обновление, у снятого ключа нет.
    await ownerEdit(graph, { id: supplyRecordId(graph, 'upcoming'), title: 'Моя неделя' });
    expect(await updatesOf(ctxOf(graph))).toEqual([]);
  });

  test('«вернуть как было» у правленой: род — из записи, тело и заголовок — из supply_text', async () => {
    const graph = await freshGraph();
    await seedSupply(graph);
    const id = await seedRetiredUpcoming(graph);
    await editBody(graph, id, 'Моя неделя\n\n{{query:aspect=orbis/task, title=Все}}');
    await ownerEdit(graph, { id, title: 'Неделя' });
    const edited = await rowOf(graph, id);
    expect(statusOf(edited)).toBe('edited');

    const { actionId } = await revertToEtalon(ctxOf(graph), 'upcoming');
    const after = await rowOf(graph, id);
    expect({ title: after.title, emoji: after.emoji, body: after.body }).toEqual(
      parsePagePrint(edited.props[SUPPLY_TEXT] as string),
    );
    expect(after.body).toBe(await canonical(graph, UPCOMING_BODY));
    expect(statusOf(after)).toBe('etalon');
    // Эталон записи (ключ, отпечаток, текст) возврат не трогает.
    expect(after.props).toEqual(edited.props);
    expect(await versionsOf(graph, id)).toEqual([{ label: 'Прежняя версия', body: edited.body }]);
    expect(await journalOf(graph, actionId)).toEqual([{ title: 'Вернуть как было: «Неделя»' }]);
  });

  test('«вернуть как было» у неправленой — «и так как в поставке», не «эталона нет»', async () => {
    const graph = await freshGraph();
    await seedSupply(graph);
    await seedRetiredUpcoming(graph);
    const err = await execErrorOf(revertToEtalon(ctxOf(graph), 'upcoming'));
    expect([err.code, err.message]).toEqual(['VALIDATION', 'запись и так как в поставке']);
  });

  test('«добавить», «принять», «оставить своё» снятого ключа — отказ', async () => {
    const graph = await freshGraph();
    await seedSupply(graph);
    const id = await seedRetiredUpcoming(graph);
    await ownerEdit(graph, { id, title: 'Неделя' });
    const upcoming = 'upcoming' as unknown as SupplyKey;
    for (const call of [
      () => acceptUpdate(ctxOf(graph), upcoming),
      () => declineUpdate(ctxOf(graph), upcoming),
    ]) {
      const e = await execErrorOf(call());
      expect([e.code, e.message]).toEqual([
        'VALIDATION',
        'эталона поставки с ключом «upcoming» нет',
      ]);
    }
    // «Добавить» живую запись не создаёт второй — отказ раньше, чем дело дойдёт до эталона.
    expect((await execErrorOf(addSupplyRecord(ctxOf(graph), upcoming))).code).toBe('VALIDATION');
  });
});

describe('М-8 остатков 1б: признак отката «добавить» не гаснет от чужого отменённого действия', () => {
  test('«Добавить: Повестка» → Undo → правка владельца архивной записи → Undo правки → снова new; «добавить» возвращает ту же', async () => {
    const graph = await freshGraph();
    await seedSupply(
      graph,
      SUPPLY_KEYS.filter((k) => k !== 'agenda'),
    );
    const id = supplyRecordId(graph, 'agenda');
    const added = await addSupplyRecord(ctxOf(graph), 'agenda');
    expect(await journalOf(graph, added.actionId)).toEqual([
      { title: 'Добавить из поставки: «Повестка»' },
    ]);
    await undo(graph, added.actionId);
    expect((await rowOf(graph, id)).archived).toBe(true);

    // Владелец правит архивную запись и отменяет правку: последнее НЕотменённое действие над ней —
    // всё то же отменённое «добавить». Без пропуска отменённых признак гас бы, и поставка молча
    // перестала бы предлагать Повестку.
    const edit = await execute(
      db,
      {
        identity: personal(graph),
        actorKind: 'owner',
        source: 'ui',
        operations: [{ tool: 'entity_update', input: { id, title: 'Моя повестка' } }],
      },
      { sink },
    );
    if (!edit.ok) throw new Error(`правка владельца: ${JSON.stringify(edit.error)}`);
    await undo(graph, edit.actionId);
    expect((await rowOf(graph, id)).title).toBe('Повестка');

    expect(await updatesOf(ctxOf(graph))).toEqual([
      { key: 'agenda', kind: 'new', recordId: null, edited: false, declined: false },
    ]);
    const again = await addSupplyRecord(ctxOf(graph), 'agenda');
    expect((await rowOf(graph, id)).archived).toBe(false);
    expect(await journalOf(graph, again.actionId)).toEqual([
      { title: 'Добавить из поставки: «Повестка»' },
    ]);
    const count = await withIdentity(db, personal(graph), (tx) =>
      tx.execute(
        sql`SELECT count(*)::int AS n FROM entities WHERE props @> ${JSON.stringify({ [SUPPLY_KEY]: 'agenda' })}::jsonb`,
      ),
    );
    expect(count[0]?.n).toBe(1);
  });

  test('правка владельца архивной записи НЕ отменена — это его действие, предложения нет', async () => {
    const graph = await freshGraph();
    await seedSupply(
      graph,
      SUPPLY_KEYS.filter((k) => k !== 'agenda'),
    );
    const id = supplyRecordId(graph, 'agenda');
    const added = await addSupplyRecord(ctxOf(graph), 'agenda');
    await undo(graph, added.actionId);
    await ownerEdit(graph, { id, title: 'Моя повестка' });
    expect(await updatesOf(ctxOf(graph))).toEqual([]);
  });
});
