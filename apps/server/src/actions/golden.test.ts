// apps/server/src/actions/golden.test.ts
// ПРИЁМКА §С8-27: действие-декларация даёт БАЙТ-В-БАЙТ тот же результат, что код, который оно
// заменяет. Снимок — {состояние мира, строка журнала} с нормализованными id (Р-12).
//
// ЭТАЛОН СНИМАЕТСЯ ОДИН РАЗ и дальше ЗАЩИЩАЕТ (тот же жанр и тот же запрет, что у
// `tools/registry-golden.test.ts:11-20`): «записать что вышло» запрещено, расхождение
// разбирается, намеренная правка пересдаётся ОТДЕЛЬНЫМ движением с объяснением в коммите.
// Автообновления нет намеренно.
//
// ПРОЦЕДУРА СНЯТИЯ (новый случай, не правка старого): временная тест-снималка печатает объект
// случая `JSON.stringify({name, action, params, before, after, journal}, null, 2)` → объект
// вставляется в `cases` файла `apps/server/test/golden/actions.json` → `bunx biome check --write
// apps/server/test/golden/actions.json` (форматтер репозитория раскладывает JSON по-своему;
// сверка идёт по `canonicalJson` РАЗОБРАННОГО JSON, поэтому форматирование смысла не меняет).
// Снималка после вставки СНИМАЕТСЯ из файла — эталон, который умеет переписывать сам себя,
// ничего не защищает.
//
// ПОЧЕМУ ДВА ВЛАДЕЛЬЦА, А НЕ ОДИН. Сравниваются ДВА ПРОГОНА одной фикстуры, и оба пишут в граф;
// на одном владельце второй прогон видел бы последствия первого. Мир поэтому сеется дважды, у
// двух владельцев, id — `uuidv5` от владельца и слага (образец `test/surfaces.ts:76`), а снимок
// стабилизируется: id мира → слаг, graphId и оба таймстампа → метка рода. Только после этого две
// половины вообще сравнимы.
//
// ПОЧЕМУ ВЛАДЕЛЬЦЫ — КОНСТАНТЫ, А НЕ `freshGraph()`. Порядок в снимке местами решает uuid:
// входящие рёбра сортируются по `source_id`, цели map-действия — по `e.id` (`queryTargets`,
// `actions/resolve.ts`), и с ними — порядок операций в строке журнала. Со случайным владельцем
// эти порядки менялись бы от прогона к прогону, и эталон мигал бы. Модульная `mintGraph()` с
// `uuidv5` законна как константа (Ф-Б2-9): строку графа доводит до базы `truncateAll()` в
// `beforeAll`.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { batchAuditMessageId, canonicalJson, type GraphId, ORBIS_NAMESPACE } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import GOLDEN from '../../test/golden/actions.json';
import {
  appDb,
  executeWithFixtureCategories as execute,
  mintGraph,
  personal,
  requireEnv,
  truncateAll,
} from '../../test/helpers';
import { confirmPurchase } from '../budget/plan-to-fact';
import { withIdentity } from '../db/with-identity';
import { makeChatJournalSink } from '../executor/journal';
import type { ActionCard, ActionRecord } from '../executor/types';

requireEnv();
const { db, client } = appDb();
const sink = makeChatJournalSink();

/** Владельцы двух половин: `legacy` — сегодняшний код, `action` — декларация. */
const OWNER = {
  legacy: mintGraph(uuidv5('actions-golden:legacy', ORBIS_NAMESPACE)),
  action: mintGraph(uuidv5('actions-golden:action', ORBIS_NAMESPACE)),
} as const;
/** id мира — от владельца и слага: воспроизводим без обращения к БД (`surfaces.ts:76`). */
const worldId = (owner: GraphId, slug: string): string =>
  uuidv5(`${owner.toLowerCase()}:actions-golden:${slug}`, ORBIS_NAMESPACE);
/** batch одного прогона — тоже от владельца: `action.id === batchId` (executor.ts:701). */
const batchOf = (owner: GraphId, slug: string): string => worldId(owner, `batch:${slug}`);

interface GoldenState {
  id: string;
  title: string;
  archived: boolean;
  aspects: string[];
  props: Record<string, unknown>;
  /** Входящие рёбра: переселект конверта бюджет-хуком A4 виден ТОЛЬКО здесь. */
  incoming: Array<{ role: string; source: string }>;
}

const SLUGS = ['envelope-july', 'envelope-aug', 'purchase', 'task-1', 'task-2', 'task-3'] as const;
/**
 * Слаг категории — ссылочная цель `orbis/finance_category` у конвертов и покупки. В снимок
 * сама категория не входит (её никто не правит), но её id едет в `props` снимаемых строк, и без
 * имени он лёг бы в эталон безымянным `<uuid>`.
 */
const CATEGORY = 'category';
// `UUID_RE`, `MASKED_KEYS`, `namesOf`, `stabilize` — КОПИЯ `apps/server/test/surfaces.ts:345-376`
// (тот же довод «маска, съевшая лишнее, и есть способ, которым эталон перестаёт что-то значить»),
// с двумя правками: `MASKED_KEYS` += `graph_id`/`actor_user_id` (строка журнала несёт их snake_case),
// а словарь имён строится из `SLUGS` этой фикстуры и `batchOf` плюс `owner → '<owner>'`.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MASKED_KEYS = new Set(['graphId', 'graph_id', 'actor_user_id', 'createdAt', 'updatedAt']);
function namesOf(owner: GraphId): ReadonlyMap<string, string> {
  const m = new Map<string, string>([[owner.toLowerCase(), '<owner>']]);
  m.set(worldId(owner, CATEGORY).toLowerCase(), `@${CATEGORY}`);
  for (const s of SLUGS) {
    m.set(worldId(owner, s).toLowerCase(), `@${s}`);
    m.set(batchOf(owner, s).toLowerCase(), `@batch:${s}`);
  }
  return m;
}

function stabilize(value: unknown, names: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((v) => stabilize(v, names));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const key = UUID_RE.test(k) ? (names.get(k.toLowerCase()) ?? '<uuid>') : k;
      out[key] = MASKED_KEYS.has(k) ? `<${k}>` : stabilize(v, names);
    }
    return out;
  }
  if (typeof value === 'string' && UUID_RE.test(value))
    return names.get(value.toLowerCase()) ?? '<uuid>';
  return value;
}

async function snapshotWorld(owner: GraphId, slugs: readonly string[]): Promise<GoldenState[]> {
  return await withIdentity(db, personal(owner), async (tx) => {
    const out: GoldenState[] = [];
    for (const slug of slugs) {
      const id = worldId(owner, slug);
      const rows = (await tx.execute(sql`
        SELECT e.id, e.title, e.archived, e.aspects, e.props,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('role', r.role, 'source', r.source_id)
                                     ORDER BY r.role, r.source_id)
                    FROM relations r WHERE r.target_id = e.id), '[]'::jsonb) AS incoming
        FROM entities e WHERE e.id = ${id}
      `)) as unknown as GoldenState[];
      const row = rows[0];
      if (row === undefined) throw new Error(`мир не сеян: ${slug}`);
      out.push(row);
    }
    return out;
  });
}

/** Строка журнала по детерминированному PK audit-сообщения (§7.8). */
async function journalOf(
  owner: GraphId,
  batchId: string,
): Promise<{ action: ActionRecord; card: ActionCard }> {
  const found = await withIdentity(db, personal(owner), (tx) =>
    sink.findByAuditId(tx, batchAuditMessageId(owner, batchId)),
  );
  if (found === undefined) throw new Error(`audit-сообщение ${batchId} не найдено`);
  return { action: found.action, card: found.card as ActionCard };
}

const caseOf = (name: string) => {
  const found = (GOLDEN as { cases: Array<{ name: string }> }).cases.find((c) => c.name === name);
  if (found === undefined) throw new Error(`в эталоне нет случая «${name}»`);
  return found as {
    name: string;
    before: unknown;
    after: unknown;
    journal: unknown;
    action: string;
    params: Record<string, unknown>;
  };
};

/**
 * Мир фикстуры: два конверта одной категории (июль и август), ручная planned-покупка на июль и
 * три просроченные задачи. Каждая строка — `entity_create` исполнителем с явным id (клиентский
 * uuid §7.8 принимает), `source:'ui'`, БЕЗ синка: audit-шум сева в снимок не нужен. Конверты
 * сеются ДО покупки — бюджет-хук A4 привязывает её к июльскому конверту уже на создании.
 */
async function seedWorld(owner: GraphId): Promise<void> {
  const create = async (slug: string, input: Record<string, unknown>): Promise<void> => {
    const r = await execute(db, {
      identity: personal(owner),
      actorKind: 'owner',
      source: 'ui',
      operations: [
        { tool: 'entity_create', input: { id: worldId(owner, slug), tags: [], ...input } },
      ],
    });
    if (!r.ok) throw new Error(`сев ${slug}: ${r.error.code} — ${r.error.message}`);
  };
  const category = worldId(owner, CATEGORY);
  const envelope = (start: string, end: string) => ({
    title: `Конверт ${start}`,
    props: {
      'orbis/finance_category': category,
      'orbis/limit': '30000.00',
      'orbis/currency': 'RUB',
      'orbis/period_start': start,
      'orbis/period_end': end,
    },
    aspects: ['orbis/budget'],
  });
  await create('envelope-july', envelope('2026-07-01', '2026-07-31'));
  await create('envelope-aug', envelope('2026-08-01', '2026-08-31'));
  await create('purchase', {
    title: 'Купить кроссовки',
    props: {
      'orbis/amount': '8000.00',
      'orbis/currency': 'RUB',
      'orbis/direction': 'expense',
      'orbis/finance_category': category,
      'orbis/occurred_on': '2026-07-15',
      'orbis/planned': true,
    },
    aspects: ['orbis/financial'],
  });
  for (const n of [1, 2, 3]) {
    await create(`task-${n}`, {
      title: `Задача ${n}`,
      props: { 'orbis/task_status': 'inbox', 'orbis/due_date': `2026-06-0${n}` },
      aspects: ['orbis/task'],
    });
  }
}

/**
 * Снимки, собранные `beforeAll` ПОСЛЕ сева и прогона: тела тестов читают собранное, походов в БД
 * в телах нет (образец `test/gate-c8-18.test.ts`). Заполняются ровно одним `beforeAll` файла.
 */
const BEFORE = { legacy: [] as GoldenState[] };
const AFTER = { legacy: [] as GoldenState[] };
const JOURNAL = { legacy: undefined as { action: ActionRecord; card: ActionCard } | undefined };

/** Снимаемые строки случая `plan-to-fact`: покупка и оба конверта (переселект виден по рёбрам). */
const PURCHASE_WORLD = ['envelope-july', 'envelope-aug', 'purchase'] as const;
const OCCURRED_ON = '2026-08-10';

beforeAll(async () => {
  await truncateAll();
  for (const owner of [OWNER.legacy, OWNER.action]) await seedWorld(owner);

  // Половина `legacy`: `confirmPurchase` — тот путь, которым ручка `budget.confirmPurchase`
  // переводит покупку сегодня.
  BEFORE.legacy = await snapshotWorld(OWNER.legacy, PURCHASE_WORLD);
  const legacy = await confirmPurchase(db, personal(OWNER.legacy), {
    entityId: worldId(OWNER.legacy, 'purchase'),
    occurredOn: OCCURRED_ON,
    batchId: batchOf(OWNER.legacy, 'purchase'),
  });
  if (legacy.idempotentReplay) throw new Error('половина legacy: неожиданный replay');
  AFTER.legacy = await snapshotWorld(OWNER.legacy, PURCHASE_WORLD);
  JOURNAL.legacy = await journalOf(OWNER.legacy, batchOf(OWNER.legacy, 'purchase'));
});

afterAll(async () => {
  await client.end();
});

describe('§С8-27 plan-to-fact: код и декларация дают один результат', () => {
  test('сегодняшний confirmPurchase равен эталону (регрессия)', () => {
    const g = caseOf('plan-to-fact/legacy');
    const names = namesOf(OWNER.legacy);
    expect(canonicalJson(stabilize(BEFORE.legacy, names))).toBe(canonicalJson(g.before));
    expect(canonicalJson(stabilize(AFTER.legacy, names))).toBe(canonicalJson(g.after));
    expect(canonicalJson(stabilize(JOURNAL.legacy, names))).toBe(canonicalJson(g.journal));
  });
});
