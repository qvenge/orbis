// apps/server/src/rules/app-rules.test.ts
// Правила аспектов «приложение» и «поставка» (срез 1б, РП-3) на боевом пути записи: уникальность
// живой записи поставки на ключ (`supply_key_unique`, `unique_among` на своём аспекте-области, Д-7),
// «Открывать вместо» без себя (`app_opens_over_not_self`) и «Дом не указывает на оболочку хоста» —
// фильтром цели `ref`, который проверяет сервер (Д-20). Через `execute()`, а не вызовом движка:
// предмет — РУБЕЖ записи. Здесь же — что записи поставки НЕ служебные: служебность спрятала бы их
// из всех выдач (Ф-1а-1, Э-19).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  APP_ASPECT,
  APP_OPENS_OVER,
  type GraphId,
  HOME_PROPERTY,
  newId,
  PAGE_ASPECT,
  SUPPLY_ASPECT,
  SUPPLY_KEY,
} from '@orbis/shared';
import { appDb, freshGraph, personal, requireEnv, truncateAll } from '../../test/helpers';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { ExecuteRequest, ExecuteResult, WireEntity } from '../executor/types';
import { undoAction } from '../executor/undo';
import { appRouter } from '../router';
import { createCallerFactory } from '../trpc';

requireEnv();

const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);
beforeAll(async () => {
  await truncateAll();
});
afterAll(async () => {
  await client.end();
});

const T0 = new Date('2026-09-27T09:00:00.000Z');
// Боевой синк журнала: без него действие не легло бы в журнал, и откат (`undoAction`) его не нашёл бы.
const sink = makeChatJournalSink();

function run(
  graph: GraphId,
  tool: string,
  input: Record<string, unknown>,
  mechanism?: ExecuteRequest['mechanism'],
): Promise<ExecuteResult> {
  return execute(
    db,
    {
      identity: personal(graph),
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool, input }],
      clock: () => T0,
      ...(mechanism === undefined ? {} : { mechanism }),
    },
    { sink },
  );
}

/** Запись поставки так, как её заведёт сев графа: механизмом `supply` (флаг `writer`). */
function createSupply(
  graph: GraphId,
  key: string,
  aspects: readonly string[],
  over: Record<string, unknown> = {},
): Promise<ExecuteResult> {
  return run(
    graph,
    'entity_create',
    {
      title: `Поставка ${key}`,
      tags: [],
      aspects: [...aspects, SUPPLY_ASPECT],
      props: { [SUPPLY_KEY]: key },
      ...over,
    },
    'supply',
  );
}

function okId(r: ExecuteResult): string {
  if (!r.ok) throw new Error(`ожидался успех, получено ${JSON.stringify(r.error)}`);
  return (r.results[0] as WireEntity).id;
}

/** Отказ в форме «код/invariant-или-reason» — одна строка на сравнение, падение назовёт причину. */
function verdict(r: ExecuteResult): string {
  if (r.ok) return 'ok';
  const d = (r.error.details ?? {}) as { invariant?: string; reason?: string };
  return `${r.error.code}/${d.invariant ?? d.reason ?? '-'}`;
}

test('две живые записи поставки с одним ключом — INVARIANT supply_key_unique; при архивной первой — ок (Д-7)', async () => {
  const graph = await freshGraph();
  const first = okId(await createSupply(graph, 'home', [PAGE_ASPECT]));
  expect(verdict(await createSupply(graph, 'home', [PAGE_ASPECT]))).toBe(
    'INVARIANT/supply_key_unique',
  );
  // Другой ключ — не дубль: правило про комбинацию ключа, а не про «вторую запись поставки».
  expect(verdict(await createSupply(graph, 'records', [PAGE_ASPECT]))).toBe('ok');

  // Архивная не мешает: правило смотрит только неархивные записи области.
  const archived = await run(graph, 'entity_update', { id: first, archived: true });
  if (!archived.ok) throw new Error(`архивация не прошла: ${JSON.stringify(archived.error)}`);
  const second = await createSupply(graph, 'home', [PAGE_ASPECT]);
  expect(verdict(second)).toBe('ok');

  // `undo: 'check'`: откат архивации при живой замене дал бы две живые записи на ключ — отказ.
  const undone = await undoAction(db, { identity: personal(graph), actionId: archived.actionId });
  expect(verdict(undone)).toBe('INVARIANT/supply_key_unique');
});

test('запись-приложение с «Открывать вместо» на себя — INVARIANT app_opens_over_not_self, не сырая ошибка БД', async () => {
  const graph = await freshGraph();
  const other = okId(
    await run(graph, 'entity_create', { title: 'Чтение', tags: [], aspects: [APP_ASPECT] }),
  );
  const self = newId();
  const bad = await run(graph, 'entity_create', {
    id: self,
    title: 'Работа',
    tags: [],
    aspects: [APP_ASPECT],
    props: { [APP_OPENS_OVER]: [other, self] },
  });
  expect(verdict(bad)).toBe('INVARIANT/app_opens_over_not_self');

  // Позитив той же формы: без себя выбор законен, и страж `not(empty)` пускает приложение без списка.
  const good = await run(graph, 'entity_create', {
    title: 'Работа',
    tags: [],
    aspects: [APP_ASPECT],
    props: { [APP_OPENS_OVER]: [other] },
  });
  expect(verdict(good)).toBe('ok');
});

test('«Дом» = оболочка хоста — VALIDATION «цель не в множестве target»; «Дом» = обычное приложение — ок (Д-20)', async () => {
  const graph = await freshGraph();
  const hostShell = okId(await createSupply(graph, 'host-shell', [APP_ASPECT]));
  const bad = await run(graph, 'entity_create', {
    title: 'Заметки о книгах',
    tags: [],
    aspects: [PAGE_ASPECT],
    props: { [HOME_PROPERTY]: hostShell },
  });
  if (bad.ok) throw new Error('ожидался отказ, получен успех');
  expect(bad.error.code).toBe('VALIDATION');
  expect(bad.error.details).toMatchObject({
    property: HOME_PROPERTY,
    value: hostShell,
    cause: 'цель не в множестве target',
  });

  // Своё приложение владельца ключа поставки не несёт — отрицание тотально, и в цель оно входит.
  const reading = okId(
    await run(graph, 'entity_create', { title: 'Чтение', tags: [], aspects: [APP_ASPECT] }),
  );
  const good = await run(graph, 'entity_create', {
    title: 'Заметки о книгах',
    tags: [],
    aspects: [PAGE_ASPECT],
    props: { [HOME_PROPERTY]: reading },
  });
  expect(verdict(good)).toBe('ok');
  // Запись поставки, но не оболочка («Домой» — страница) — тоже не приложение: цель держит аспект.
  const homePage = okId(await createSupply(graph, 'home', [PAGE_ASPECT]));
  const notApp = await run(graph, 'entity_create', {
    title: 'Ещё страница',
    tags: [],
    aspects: [PAGE_ASPECT],
    props: { [HOME_PROPERTY]: homePage },
  });
  expect(verdict(notApp)).toBe('VALIDATION/REF_TARGET');
});

test('записи поставки видны в обычной выдаче: «поставка» не служебная (Ф-1а-1, Э-19)', async () => {
  const graph = await freshGraph();
  const records = okId(await createSupply(graph, 'records', [PAGE_ASPECT], { title: 'Записи' }));
  const caller = createCaller({
    identity: personal(graph),
    actorKind: 'owner',
    db,
    clientVersion: null,
  });
  const byPage = await caller.entity.query({ query: `aspect=${PAGE_ASPECT}` });
  expect(byPage.map((r) => r.id)).toContain(records);
  const bySupply = await caller.entity.query({ query: `aspect=${SUPPLY_ASPECT}` });
  expect(bySupply.map((r) => r.id)).toContain(records);
});
