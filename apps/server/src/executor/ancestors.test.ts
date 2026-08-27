// apps/server/src/executor/ancestors.test.ts
// Движок вычисляемых предков `orbis/parent_project`/`orbis/root_project` (§А8, правило
// `nearest_ancestor`): пересчёт затронутого поддерева ТЕМ ЖЕ tx, что и правка ребра или
// аспекта `orbis/project`. Реальная БД под withIdentity (RLS enforced), без моков.
//
// Что здесь проверяется НЕ ЦВЕТОМ, А ПОПАДАНИЕМ В ПУТЬ (урок фикс-раунда 2 Задачи 7a:
// зелёный тест бывает зелёным потому, что исполнение в проверяемый путь не заходило):
// у каждого утверждения о значении свойства рядом стоит утверждение о СИСТЕМНОЙ СТРОКЕ
// журнала «пересчитано N сущностей» — она пишется только самим движком и только когда он
// действительно что-то пересчитал.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { newId, RULE_NEAREST_ANCESTOR } from '@orbis/shared';
import { eq, sql } from 'drizzle-orm';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { loadRegistry } from '../registry/load';
import { execute } from './executor';
import { makeChatJournalSink } from './journal';
import type {
  ActionOperation,
  ActionRecord,
  ExecuteOk,
  ExecuteRequest,
  ExecuteResult,
  JournalSink,
  WireEntity,
} from './types';
import { InMemoryJournalSink } from './types';
import { undoAction } from './undo';

requireEnv();

const { db, client } = appDb();
const T0 = new Date('2026-08-27T10:00:00.000Z');

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

function ok(r: ExecuteResult): ExecuteOk {
  if (!r.ok) throw new Error(`ожидался успех, получено: ${JSON.stringify(r.error)}`);
  return r;
}

function req(owner: string, tool: string, input: unknown, over: Partial<ExecuteRequest> = {}) {
  return {
    actorUserId: owner,
    actorKind: 'owner' as const,
    source: 'fast_path' as const,
    operations: [{ tool, input }],
    clock: () => T0,
    ...over,
  };
}

/**
 * Роли `run` и `instance-of` объявлены `created_by: system` — прямое действие владельца их
 * не ставит. В бою их рождают глаголы исполнителя и материализация; фикстура играет их роль
 * и обязана назвать это вслух.
 */
const AS_SYSTEM: Partial<ExecuteRequest> = { mechanism: 'seed' };

async function createEntity(
  owner: string,
  input: Record<string, unknown>,
  over: Partial<ExecuteRequest> = {},
): Promise<WireEntity> {
  const r = ok(await execute(db, req(owner, 'entity_create', { tags: [], ...input }, over)));
  return r.results[0] as WireEntity;
}

async function project(owner: string, title: string): Promise<WireEntity> {
  return createEntity(owner, { title, aspects: { 'orbis/project': { stage: 'active' } } });
}

async function relate(
  owner: string,
  sourceId: string,
  targetId: string,
  role: string,
  over: Partial<ExecuteRequest> = {},
  sink?: JournalSink,
): Promise<ExecuteOk> {
  return ok(
    await execute(
      db,
      req(owner, 'relation_create', { source_id: sourceId, target_id: targetId, role }, over),
      sink ? { sink } : {},
    ),
  );
}

/** Значения вычисляемых предков сущности прямо из строки (правда §А1-1 — `props`). */
async function ancestorsOf(owner: string, id: string): Promise<{ parent: unknown; root: unknown }> {
  return withIdentity(db, owner, async (tx) => {
    const rows = await tx.select().from(entities).where(eq(entities.id, id));
    const props = (rows[0]?.props ?? {}) as Record<string, unknown>;
    return { parent: props['orbis/parent_project'], root: props['orbis/root_project'] };
  });
}

/** Запись действия из БОЕВОГО журнала — там же её видит undo. */
async function actionFromJournal(owner: string, actionId: string): Promise<ActionRecord> {
  const rows = await withIdentity(db, owner, (tx) =>
    tx.execute(
      sql`SELECT metadata FROM chat_messages
           WHERE metadata @> ${JSON.stringify({ actions: [{ id: actionId }] })}::jsonb
           LIMIT 1`,
    ),
  );
  const meta = (rows as unknown as Array<{ metadata: { actions: ActionRecord[] } }>)[0]?.metadata;
  const action = meta?.actions.find((a) => a.id === actionId);
  if (action === undefined) throw new Error(`действие ${actionId} не найдено в журнале`);
  return action;
}

/** Системные строки журнала о пересчёте — их пишет ТОЛЬКО движок предков. */
function recomputeOps(sink: InMemoryJournalSink): ActionOperation[] {
  return sink.entries.flatMap((e) =>
    e.action.operations.filter((op) => op.op === 'props_recomputed'),
  );
}

test('проект → подпроект → задача → подзадача: parent_project = подпроект, root_project = проект; перенос подпроекта под другой проект пересчитывает всё поддерево в той же tx', async () => {
  const owner = freshUserId();
  const p = await project(owner, 'Проект');
  const sp = await project(owner, 'Подпроект');
  const task = await createEntity(owner, { title: 'Задача' });
  const sub = await createEntity(owner, { title: 'Подзадача' });

  await relate(owner, p.id, sp.id, 'subitem');
  await relate(owner, sp.id, task.id, 'subitem');
  const sink = new InMemoryJournalSink();
  await relate(owner, task.id, sub.id, 'subitem', {}, sink);

  // Движок ЗАШЁЛ в путь: строка пересчёта есть и она одна на действие
  expect(recomputeOps(sink)).toEqual([
    { op: 'props_recomputed', payload: { rule: 'nearest_ancestor', recomputed: 1 } },
  ]);

  expect(await ancestorsOf(owner, sp.id)).toEqual({ parent: p.id, root: p.id });
  expect(await ancestorsOf(owner, task.id)).toEqual({ parent: sp.id, root: p.id });
  expect(await ancestorsOf(owner, sub.id)).toEqual({ parent: sp.id, root: p.id });
  // У самого верхнего проекта предка-проекта нет — свойства не заводятся вовсе
  expect(await ancestorsOf(owner, p.id)).toEqual({ parent: undefined, root: undefined });

  // Перенос подпроекта под другой проект ОДНИМ batch: пересчёт обязан накрыть всё поддерево
  const p2 = await project(owner, 'Другой проект');
  const moveSink = new InMemoryJournalSink();
  ok(
    await execute(
      db,
      {
        actorUserId: owner,
        actorKind: 'owner',
        source: 'fast_path',
        batchId: newId(),
        clock: () => T0,
        operations: [
          {
            tool: 'relation_delete',
            input: { source_id: p.id, target_id: sp.id, role: 'subitem' },
          },
          {
            tool: 'relation_create',
            input: { source_id: p2.id, target_id: sp.id, role: 'subitem' },
          },
        ],
      },
      { sink: moveSink },
    ),
  );
  // Три сущности поддерева (подпроект, задача, подзадача) — одна строка журнала на batch
  expect(recomputeOps(moveSink)).toEqual([
    { op: 'props_recomputed', payload: { rule: 'nearest_ancestor', recomputed: 3 } },
  ]);
  expect(await ancestorsOf(owner, sp.id)).toEqual({ parent: p2.id, root: p2.id });
  expect(await ancestorsOf(owner, task.id)).toEqual({ parent: sp.id, root: p2.id });
  expect(await ancestorsOf(owner, sub.id)).toEqual({ parent: sp.id, root: p2.id });
});

test('прогон под тикетом под проектом получает parent_project = проект (через роли run/ticket)', async () => {
  const owner = freshUserId();
  const p = await project(owner, 'Проект прогонов');
  const ticket = await createEntity(owner, {
    title: 'Тикет',
    aspects: { 'orbis/task': { status: 'planned' } },
  });
  // Аспект прогона несёт `system_writable`-свойства (§А2-5): в бою его пишет глагол
  // исполнителя, поэтому фикстура называет механизм вслух.
  const run = await createEntity(
    owner,
    {
      title: 'Прогон',
      aspects: {
        'orbis/agent-run': {
          // Ровно один субъект прогона (V1.4) — иначе инвариант не пустит фикстуру
          routine_id: newId(),
          outcome: 'running',
          started_at: '2026-08-27T10:00:00.000Z',
          last_step_at: '2026-08-27T10:00:00.000Z',
          step_count: 0,
          steps: [],
        },
      },
    },
    AS_SYSTEM,
  );

  await relate(owner, p.id, ticket.id, 'ticket');
  const sink = new InMemoryJournalSink();
  await relate(owner, ticket.id, run.id, 'run', AS_SYSTEM, sink);

  expect(recomputeOps(sink)).toEqual([
    { op: 'props_recomputed', payload: { rule: 'nearest_ancestor', recomputed: 1 } },
  ]);
  expect(await ancestorsOf(owner, ticket.id)).toEqual({ parent: p.id, root: p.id });
  expect(await ancestorsOf(owner, run.id)).toEqual({ parent: p.id, root: p.id });
});

// Одна константа (`RULE_NEAREST_ANCESTOR`) держит имя правила на обеих сторонах — во флаге
// встроенного свойства и в строке журнала. Но между константой и БОЕВЫМ реестром стоит СИД,
// и сверить их может только живая база: отставший сид развёл бы «пересчитано по правилу X» с
// правилом, которое реестр объявляет у свойства.
test('имя правила в журнале — то же, что во flags.computed.rule строки реестра', async () => {
  const owner = freshUserId();
  const p = await project(owner, 'Проект имени правила');
  const task = await createEntity(owner, { title: 'Задача имени правила' });
  const sink = new InMemoryJournalSink();
  await relate(owner, p.id, task.id, 'subitem', {}, sink);

  const reg = await withIdentity(db, owner, (tx) => loadRegistry(tx, owner));
  const fromRegistry = reg.properties.get('orbis/parent_project')?.flags.computed?.rule;
  // Отсутствие флага — это НЕ «правило не задано», а сломанный сид: без него движок не
  // объявлен вовсе. Проверяем строкой, а не `?.`, иначе тест был бы зелен на пустом реестре.
  expect(fromRegistry).toBe(RULE_NEAREST_ANCESTOR);
  // …и корневое свойство считает ТО ЖЕ правило: два имени означали бы два движка
  expect(reg.properties.get('orbis/root_project')?.flags.computed?.rule).toBe(
    RULE_NEAREST_ANCESTOR,
  );
  expect(recomputeOps(sink)).toEqual([
    { op: 'props_recomputed', payload: { rule: RULE_NEAREST_ANCESTOR, recomputed: 1 } },
  ]);
});

test('неиерархическая связь пересчёт не запускает: строки «пересчитано» в журнале нет', async () => {
  const owner = freshUserId();
  const p = await project(owner, 'Проект тишины');
  const note = await createEntity(owner, { title: 'Заметка' });
  const sink = new InMemoryJournalSink();
  await relate(owner, p.id, note.id, 'mention', {}, sink);
  // Ни строки журнала, ни свойства: у роли `mention` иерархии нет
  expect(recomputeOps(sink)).toEqual([]);
  expect(await ancestorsOf(owner, note.id)).toEqual({ parent: undefined, root: undefined });
});

test('навешивание и снятие аспекта orbis/project пересчитывает всё поддерево', async () => {
  const owner = freshUserId();
  const top = await project(owner, 'Верхний проект');
  const mid = await createEntity(owner, { title: 'Середина' });
  const leaf = await createEntity(owner, { title: 'Лист' });
  await relate(owner, top.id, mid.id, 'subitem');
  await relate(owner, mid.id, leaf.id, 'subitem');
  expect(await ancestorsOf(owner, leaf.id)).toEqual({ parent: top.id, root: top.id });

  // Середина СТАЛА проектом: у листа ближайший проект теперь она, корневой — прежний
  const attachSink = new InMemoryJournalSink();
  ok(
    await execute(
      db,
      req(owner, 'attach_orbis_project', { entity_id: mid.id, data: { stage: 'active' } }),
      { sink: attachSink },
    ),
  );
  // Пересчитан ровно ЛИСТ: у самой середины ближайший проект как был верхним, так и остался
  expect(recomputeOps(attachSink)).toEqual([
    { op: 'props_recomputed', payload: { rule: 'nearest_ancestor', recomputed: 1 } },
  ]);
  expect(await ancestorsOf(owner, leaf.id)).toEqual({ parent: mid.id, root: top.id });

  // …и перестала им быть: лист возвращается под верхний проект
  const detachSink = new InMemoryJournalSink();
  ok(
    await execute(
      db,
      req(owner, 'entity_update', { id: mid.id, aspects: { detach: ['orbis/project'] } }),
      { sink: detachSink },
    ),
  );
  expect(recomputeOps(detachSink)).toEqual([
    { op: 'props_recomputed', payload: { rule: 'nearest_ancestor', recomputed: 1 } },
  ]);
  expect(await ancestorsOf(owner, leaf.id)).toEqual({ parent: top.id, root: top.id });
});

test('undo relation_create иерархического ребра: parent_project возвращается (пересчёт по восстановленным рёбрам); inverse пересчёта не существует', async () => {
  const owner = freshUserId();
  const p = await project(owner, 'Проект отката');
  const task = await createEntity(owner, { title: 'Задача отката' });
  // Боевой синк, а не InMemory: undo ищет действие в журнале БД, и на памяти теста
  // проверялся бы не откат, а его отсутствие (NOT_FOUND).
  const created = await relate(owner, p.id, task.id, 'subitem', {}, makeChatJournalSink());
  expect(await ancestorsOf(owner, task.id)).toEqual({ parent: p.id, root: p.id });

  // Строка пересчёта записана, а обратной операции у неё НЕТ: откат пересчитывает заново
  const action = await actionFromJournal(owner, created.actionId);
  expect(action.operations.filter((op) => op.op === 'props_recomputed')).toHaveLength(1);
  expect(action.inverse.some((op) => op.op === 'props_recomputed')).toBe(false);

  ok(await undoAction(db, { actorUserId: owner, actionId: created.actionId }));
  // Ребра больше нет — предка тоже: свойство СНЯТО, а не оставлено висеть
  expect(await ancestorsOf(owner, task.id)).toEqual({ parent: undefined, root: undefined });
});

test('entity_update props.orbis/parent_project из тула → COMPUTED_WRITE', async () => {
  const owner = freshUserId();
  const p = await project(owner, 'Проект гейта');
  const task = await createEntity(owner, { title: 'Задача гейта' });
  const r = await execute(
    db,
    req(owner, 'entity_update', { id: task.id, props: { 'orbis/parent_project': p.id } }),
  );
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error('недостижимо');
  expect(r.error.code).toBe('COMPUTED_WRITE');
  expect((r.error.details as { property?: string }).property).toBe('orbis/parent_project');
  expect(await ancestorsOf(owner, task.id)).toEqual({ parent: undefined, root: undefined });
});

test('цикл в иерархии не вешает пересчёт: обход ограничен капом глубины', async () => {
  const owner = freshUserId();
  const p = await project(owner, 'Проект цикла');
  const a = await createEntity(owner, { title: 'A' });
  const b = await createEntity(owner, { title: 'B' });
  await relate(owner, p.id, a.id, 'subitem');
  await relate(owner, a.id, b.id, 'subitem');
  // Замыкание цикла: роль `subitem` ацикличностью не ограничена (её стерегут только
  // `category-parent` и `dependency`, §А4-2) — значит движок обязан переживать цикл сам
  await relate(owner, b.id, a.id, 'subitem');
  expect(await ancestorsOf(owner, a.id)).toEqual({ parent: p.id, root: p.id });
  expect(await ancestorsOf(owner, b.id)).toEqual({ parent: p.id, root: p.id });
});

test('чужое поддерево пересчёт не трогает (RLS)', async () => {
  const owner = freshUserId();
  const stranger = freshUserId();
  const p = await project(owner, 'Мой проект');
  const mine = await createEntity(owner, { title: 'Моя задача' });
  const alien = await createEntity(stranger, { title: 'Чужая задача' });
  await relate(owner, p.id, mine.id, 'subitem');
  // Ребро от моего проекта к чужой сущности не создать (RLS) — проба идёт с другого конца:
  // чужая строка обязана остаться без вычисленных предков
  expect(await ancestorsOf(stranger, alien.id)).toEqual({ parent: undefined, root: undefined });
  const rows = await withIdentity(db, stranger, (tx) =>
    tx.execute(sql`SELECT count(*)::int AS n FROM entities WHERE props ? 'orbis/parent_project'`),
  );
  expect((rows as unknown as Array<{ n: number }>)[0]?.n).toBe(0);
});
