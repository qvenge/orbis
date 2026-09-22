// apps/server/src/registry/invariants-golden.test.ts
// ПРИЁМКА §С8-1, ВТОРАЯ ПОЛОВИНА: golden-корпус «сущность → вердикт» ДОМЕННЫХ ИНВАРИАНТОВ (§А7-2).
// Реестровую половину (`validateEntityProps`) держит `validator-golden.test.ts`; здесь — два
// инварианта, которые Б-2 переносит из кода в строки каталога правил: «не-шаблон `orbis/financial`
// обязан нести `occurred_on`» (+ его пара про `recurring`) и «вход задачи в `done` ставит
// `completed_at`, уход — снимает». Каждая запись корпуса прогоняется ЖИВЫМ исполнителем (`execute`) с
// фиксированными часами, а вердикт СТАРОГО кода лежит рядом замороженным литералом `legacy*`.
//
// ПОЧЕМУ СТАРЫЙ ВЕРДИКТ ЗАМОРОЖЕН. Порядок §А7-2 — «тесты-близнецы и golden-корпус на старом и новом
// валидаторе ДО замены»: корпус снят старым кодом (`assertFinancialInvariant`, `applyTaskCompletion`)
// ОДИН раз, до первой правки инвариантов, и записан литералом. Код снесён той же задачей — пересчитать
// `legacy*` больше нечем, и это намеренно: значение, которое нельзя пересчитать, нельзя и молча
// подогнать под новый результат. Живой вердикт (`verdict`/`code`/`invariant`/`writes`) считается
// прогоном и обязан совпасть с записанным АБСОЛЮТНО — иначе два одинаково сломанных пути прошли бы
// приёмку вдвоём.
//
// ЗАПИСАННОЕ ЗНАЧЕНИЕ — ТОЖЕ ВЕРДИКТ (РЧ-4-2). Половина инвариантов — T-правило, и `ok` о нём не
// говорит ничего: запись обязана нести ещё и то, что исполнитель дописал МИМО входа. `writes` —
// `orbis/completed_at` (нормализован: равен штампу строки — `'$updatedAt'`, нет значения — `null`,
// иначе литерал) плюс сам штамп строки под ключом `$updatedAt`. Часы фиксированы (`T0`), id не
// пишутся.
//
// КАК ПЕРЕСДАВАТЬ. `legacy*` не трогается НИКОГДА — он про мёртвый код. Меняется только живой
// вердикт: посчитать прогоном, вписать и ОБЪЯСНИТЬ каждое расхождение со старым причиной из закрытого
// списка `EXPECTED_DIFFS` (с числом записей на причине). Числа состава (`CORPUS_SIZE`,
// `NEGATIVE_RECORDS`) двигаются тем же коммитом. Каждое НЕ перечисленное расхождение — дефект
// перевода инварианта в декларацию, а не повод дописать строку в список.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { attachToolName, canonicalJson, newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import corpus from '../../test/golden/invariants-verdicts.json';
import {
  adminDb,
  appDb,
  executeWithFixtureCategories as execute,
  mintGraph,
  personal,
  requireEnv,
  truncateAll,
} from '../../test/helpers';
import type { ExecuteRequest, ExecuteResult, WireEntity } from '../executor/types';

requireEnv();
const { db, client } = appDb();
afterAll(async () => {
  await client.end();
});

type Verdict = 'ok' | 'reject';
interface GoldenRecord {
  name: string;
  /** Путь записи: одиночный create, пачка со связью, правка, навешивание аспекта. */
  shape: 'create' | 'batch' | 'update' | 'attach';
  /**
   * Аспекты записи. У `attach` — ОДИН аспект, который навешивается вторым ходом (первый ход заводит
   * запись без аспектов, со свойствами `props`).
   */
  aspects: string[];
  props: Record<string, unknown>;
  /** Второй ход для shape update (свойства правки) / attach (`data` тула). */
  patch?: Record<string, unknown>;
  /**
   * Связи. У `update` — существуют ДО второго хода (источник «template» заводит фикстура, ребро —
   * исполнитель механизмом `seed`: роль `instance-of` — `created_by: system`); у `batch` — объявлены
   * той же пачкой ПОСЛЕ `entity_create`.
   */
  relations?: Array<{ role: string; from: 'template' }>;
  /**
   * Нарушитель, записанный ДО правила: после первого хода эти свойства снимаются у строки прямой
   * записью в БД (админ-DSN) — так в графе оказывается запись, которую исполнитель сегодня завести
   * не дал бы (импорт до инварианта, строка, заведённая при выключенном правиле).
   */
  rowWithout?: string[];
  /** Второй ход shape update — правка ЯДРА без свойств (`archived`/`title`), рулинг 3-4. */
  core?: { archived?: boolean; title?: string };
  /** Замороженный вердикт СТАРОГО кода (снят шагом 2, пересчитать нечем). */
  legacyVerdict: Verdict;
  legacyCode?: string;
  legacyInvariant?: string;
  legacyWrites?: Record<string, string | null>;
  /** Живой вердикт: считается прогоном и обязан совпасть. */
  verdict: Verdict;
  code?: string;
  invariant?: string;
  writes?: Record<string, string | null>;
  expectedDiff?: string;
}

/** Исход одной записи — то, что прогон кладёт рядом с корпусом. */
interface Outcome {
  verdict: Verdict;
  code?: string;
  invariant?: string;
  writes?: Record<string, string | null>;
}

/**
 * Законные расхождения живого вердикта со старым — закрытый список; `records` — СКОЛЬКО записей стоит
 * на причине, точно (без числа из двух записей одну можно было бы молча вернуть к старому).
 */
const EXPECTED_DIFFS: Record<string, { records: number }> = {
  // РЧ-3-3 (Р-К-12): присутствие значения — ОДНО правило на движок и интерпретатор, «не `undefined` и
  // не `null`»; им живёт и «свойство ещё не задано» у `on_enter_class.set`. Старый код спрашивал
  // `=== undefined`: явный `completed_at: null` во входе оставался в состоянии, и стадия 2 отвечала
  // `VALIDATION` (`TYPE`: момент обязан быть строкой). Правило видит `null` как «не задано» и ставит
  // штамп записи. Достижимо ТОЛЬКО явным `null` во входе и только у T-правил: они идут до стадии 2, а
  // C-правила — стадией 4, куда `null` не доезжает ни одним путём (записи «occurred_on: null» на
  // create, update и attach — `VALIDATION` у обоих). Прецедент той же семантики в старом коде —
  // подстановка валюты конверта «NULL → умолчание» до валидации.
  T_SET_NULL_IS_ABSENT: { records: 1 },
  // Р-И-3 (Р-К-2): значение `on_enter_class` — `{prop:'orbis/updated_at'}`, штамп, который ляжет в
  // колонку этой же операцией; снятый код писал чистый `clock()`. В проде разницы нет (у живого хода
  // часов `monotonicUpdatedAt(now, prev) === now`); с поддельными часами правка и attach в тот же тик
  // дают штамп `T0+1ms` (§5.2). Create в done расхождения не даёт: у него штамп и есть `now`.
  COMPLETED_AT_IS_WRITE_STAMP: { records: 2 },
};

/**
 * Состав — два числа точные (равенство, а не порог: молча выкинутая запись обязана красить приёмку).
 * Одиннадцать записей — таблица задачи 4 (по две на каждую ветку инварианта и по одной на путь записи
 * штампа); семь сверху — переносы ревью задачи 3: пачка с ребром ЧУЖОЙ роли (общий пре-пасс по ролям
 * не должен легитимировать `recurring`), нарушитель под правкой ядра и под правкой свойства (C-правила
 * на `entity_update` — Ф-Б2-17, рулинг 3-4) и четыре пробы явного `null` на трёх путях записи (движок
 * считает `null` отсутствием, старый код — `=== undefined`).
 */
const CORPUS_SIZE = 18;
const NEGATIVE_RECORDS = 8;

// `as unknown` — TS выводит из литерального JSON союз объектов с `field?: undefined`, несравнимый с
// объявленной формой; форму и состав корпуса стережёт тест состава, а не компилятор.
const records = corpus.records as unknown as GoldenRecord[];

const owner = mintGraph();
const T0 = new Date('2026-07-04T10:00:00.000Z');
/** Цель ссылки `orbis/finance_category`: категорию под этим id заводит фикстурный исполнитель. */
const CATEGORY_REF = '019e4466-b4b4-7e07-b5d4-64be9721da51';
/** Шаблон повторения — источник рёбер `instance-of` (и чужой роли) в записях со связями. */
const TEMPLATE_PROPS = {
  'orbis/amount': '500.00',
  'orbis/direction': 'expense',
  'orbis/finance_category': CATEGORY_REF,
  'orbis/recurring': true,
  'orbis/start_at': '2026-07-01T10:00:00+03:00',
  'orbis/recurrence': { freq: 'monthly', interval: 1 },
};
/** Свойства, которые исполнитель дописывает МИМО входа (РЧ-4-2). */
const WRITTEN_PAST_INPUT = ['orbis/completed_at'] as const;

function req(operations: ExecuteRequest['operations'], over: Partial<ExecuteRequest> = {}) {
  return {
    identity: personal(owner),
    actorKind: 'owner',
    source: 'fast_path',
    operations,
    clock: () => T0,
    ...over,
  } satisfies ExecuteRequest;
}
const run = (tool: string, input: unknown, over: Partial<ExecuteRequest> = {}) =>
  execute(db, req([{ tool, input }], over));
/** Ход фикстуры обязан пройти: его отказ — дефект обвязки, а не вердикт записи. */
function entityOf(r: ExecuteResult, what: string): WireEntity {
  if (!r.ok) throw new Error(`фикстура «${what}»: отказ ${JSON.stringify(r.error)}`);
  return r.results[0] as WireEntity;
}

/** Литерал записанного значения: равен штампу строки — `'$updatedAt'`, нет — `null`. */
function writesOf(e: WireEntity): Record<string, string | null> {
  const out: Record<string, string | null> = { $updatedAt: e.updatedAt };
  for (const propertyId of WRITTEN_PAST_INPUT) {
    const value = e.props[propertyId];
    out[propertyId] =
      value === undefined ? null : value === e.updatedAt ? '$updatedAt' : String(value);
  }
  return out;
}
function outcomeOf(r: ExecuteResult): Outcome {
  if (r.ok) return { verdict: 'ok', writes: writesOf(r.results[0] as WireEntity) };
  const details = (r.error.details ?? {}) as Record<string, unknown>;
  const invariant = typeof details.invariant === 'string' ? details.invariant : undefined;
  return {
    verdict: 'reject',
    code: r.error.code,
    ...(invariant !== undefined && { invariant }),
  };
}

async function template(name: string): Promise<string> {
  const created = await run('entity_create', {
    title: `Шаблон: ${name}`,
    tags: [],
    props: TEMPLATE_PROPS,
    aspects: ['orbis/financial', 'orbis/schedule'],
  });
  return entityOf(created, `шаблон для «${name}»`).id;
}

/** Строка без названных свойств — прямой записью (нарушитель, заведённый до правила). */
async function stripRow(entityId: string, propertyIds: readonly string[]): Promise<void> {
  const { db: adb, client: ac } = adminDb();
  try {
    for (const propertyId of propertyIds) {
      await adb.execute(
        sql`UPDATE entities SET props = props - ${propertyId}::text WHERE id = ${entityId}::uuid`,
      );
    }
  } finally {
    await ac.end();
  }
}

/** Прогон одной записи по её пути; первый ход фикстуры обязан пройти. */
async function take(record: GoldenRecord): Promise<Outcome> {
  const title = record.name;
  if (record.shape === 'create') {
    return outcomeOf(
      await run('entity_create', {
        title,
        tags: [],
        props: record.props,
        aspects: record.aspects,
      }),
    );
  }
  if (record.shape === 'batch') {
    const id = newId();
    const operations: ExecuteRequest['operations'] = [
      {
        tool: 'entity_create',
        input: { id, title, tags: [], props: record.props, aspects: record.aspects },
      },
    ];
    for (const rel of record.relations ?? []) {
      operations.push({
        tool: 'relation_create',
        input: { source_id: await template(title), target_id: id, role: rel.role },
      });
    }
    return outcomeOf(
      await execute(db, req(operations, { batchId: newId(), mechanism: 'seed', source: 'chat' })),
    );
  }
  const first = entityOf(
    await run('entity_create', {
      title,
      tags: [],
      props: record.props,
      aspects: record.shape === 'attach' ? [] : record.aspects,
    }),
    title,
  );
  for (const rel of record.relations ?? []) {
    const linked = await run(
      'relation_create',
      { source_id: await template(title), target_id: first.id, role: rel.role },
      { mechanism: 'seed' },
    );
    if (!linked.ok) throw new Error(`фикстура «${title}»: ребро ${JSON.stringify(linked.error)}`);
  }
  if (record.rowWithout !== undefined) await stripRow(first.id, record.rowWithout);
  if (record.shape === 'attach') {
    const aspect = record.aspects[0];
    if (aspect === undefined || record.aspects.length !== 1) {
      throw new Error(`запись «${title}»: attach навешивает ровно один аспект`);
    }
    return outcomeOf(
      await run(attachToolName(aspect), { entity_id: first.id, data: record.patch ?? {} }),
    );
  }
  return outcomeOf(
    await run('entity_update', {
      id: first.id,
      ...(record.patch !== undefined && { props: record.patch }),
      ...record.core,
    }),
  );
}

const collected = new Map<string, Outcome>();
function taken(name: string): Outcome {
  const outcome = collected.get(name);
  if (outcome === undefined) throw new Error(`запись «${name}» не прогонялась`);
  return outcome;
}

beforeAll(async () => {
  await truncateAll();
  for (const record of records) collected.set(record.name, await take(record));
});

describe('golden «сущность → вердикт» доменных инвариантов (§А7-2, приёмка §С8-1)', () => {
  test('вердикт, код и записанные значения совпадают с корпусом; расхождения со старым — только перечисленные', () => {
    const wrong: string[] = [];
    for (const record of records) {
      const live = taken(record.name);
      if (
        `${live.verdict}/${live.code ?? ''}/${live.invariant ?? ''}` !==
        `${record.verdict}/${record.code ?? ''}/${record.invariant ?? ''}`
      ) {
        wrong.push(`${record.name}: живой ${live.verdict}/${live.code}/${live.invariant}`);
      }
      if (canonicalJson(live.writes ?? null) !== canonicalJson(record.writes ?? null)) {
        wrong.push(`${record.name}: записано ${canonicalJson(live.writes ?? null)}`);
      }
      const same =
        record.legacyVerdict === record.verdict &&
        record.legacyCode === record.code &&
        record.legacyInvariant === record.invariant &&
        canonicalJson(record.legacyWrites ?? null) === canonicalJson(record.writes ?? null);
      if (!same && record.expectedDiff === undefined) {
        wrong.push(`${record.name}: расхождение без expectedDiff`);
      }
      if (same && record.expectedDiff !== undefined) {
        wrong.push(`${record.name}: expectedDiff при совпадении`);
      }
      if (record.expectedDiff !== undefined && EXPECTED_DIFFS[record.expectedDiff] === undefined) {
        wrong.push(`${record.name}: причина вне закрытого списка`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test('состав корпуса точный: размер, отказы, уникальность имён и число записей на причине', () => {
    expect(records.length).toBe(CORPUS_SIZE);
    expect(records.filter((r) => r.verdict === 'reject').length).toBe(NEGATIVE_RECORDS);
    expect(new Set(records.map((r) => r.name)).size).toBe(CORPUS_SIZE);
    const perCause: Record<string, number> = {};
    for (const record of records) {
      if (record.expectedDiff === undefined) continue;
      perCause[record.expectedDiff] = (perCause[record.expectedDiff] ?? 0) + 1;
    }
    expect(perCause).toEqual(
      Object.fromEntries(Object.entries(EXPECTED_DIFFS).map(([cause, d]) => [cause, d.records])),
    );
  });
});
