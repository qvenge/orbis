// apps/server/src/test/volume-fixture.ts
// Корпус объёма для приёмки §С8-15 и сверки «ноль расхождений» подписки Budget (задачи 9, 12):
// 20 000 движений, 480 конвертов (12 × 40 = 30 RUB + 10 USD), 32 категории с деревом, 200
// шаблонов повторения плюс 2000 задач и 1000 событий — вторая половина гейта (Agenda, строка
// списка) обязана мериться на том же корпусе. Не тест сам по себе — библиотека для perf/.
//
// ПРЯМОЙ INSERT ПОД АДМИН-DSN — названное исключение из «мутации только через executor» (Р-К-2,
// отступление от буквы рамки Б1.11), и довод замером: 20 000 `entity_create` — это 20 000 строк
// журнала, столько же версий и минуты сева на прогон (докблок `graph-fixture.ts:8-16`).
// Единственное, ради чего исполнитель был бы нужен, — рёбра `envelope-binding`; но конверт хук
// выбирает ТЕМ ЖЕ `selectEnvelopes` (`binding.ts:66`, вызов хука `:451`), и здесь зовётся он же,
// а не переписанный SQL. Что это правда, проверяет не рассуждение, а сторож в `perf/volume.test.ts`.
//
// ЧАСЫ КОРПУСА ФИКСИРОВАНЫ (`VOLUME_TODAY`) — условие кеша: даты выведены из него, иначе корпус
// протухал бы каждую полночь. Отсюда правило потребителям: `computeOverview(tx, …, VOLUME_TODAY)`
// — да; `budgetOverview(db, …)` на системных часах — НЕТ: конвейер §2.8 нашёл бы просроченные
// инстансы (`post-due.ts`) и мутировал бы корпус между замерами.
//
// КОРПУС КЕШИРУЕТСЯ по детерминированному владельцу: повторный вызов считает строки и пропускает
// сев. `truncateAll` соседнего сьюта его сносит — норма: perf-сьюты вне CI и вне `bun run test`.
import {
  addDays,
  ORBIS_NAMESPACE,
  ROLE_CATEGORY_PARENT,
  ROLE_ENVELOPE_BINDING,
  ROLE_INSTANCE_OF,
} from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import { adminDb } from '../../test/helpers';
import { type EnvelopeCombination, type EnvelopeQuery, selectEnvelopes } from '../budget/binding';
import type { Db } from '../db/client';
import { entities, relations, userSettings } from '../db/schema';

export const VOLUME_OWNER_ID = uuidv5('volume-perf-fixture:owner', ORBIS_NAMESPACE);
/** Тот же seed, что у пробы П2 (`.superpowers/probe/p2/lib/world.ts:11`) — числа сравнимы. */
export const VOLUME_SEED = 20260825;
export const VOLUME_TODAY = '2026-08-25';
export const VOLUME_LAST_MONTH = '2026-08';
export const VOLUME_MONTHS = 12;
export const VOLUME_CATEGORIES = 32;
export const VOLUME_ENVELOPE_RUB_CATS = 30;
export const VOLUME_ENVELOPE_USD_CATS = 10;
export const VOLUME_ENVELOPES_PER_MONTH = VOLUME_ENVELOPE_RUB_CATS + VOLUME_ENVELOPE_USD_CATS;
export const VOLUME_ENVELOPES = VOLUME_ENVELOPES_PER_MONTH * VOLUME_MONTHS;
export const VOLUME_TXNS = 20_000;
/** Шаблонов — 1 % корпуса движений (раскладка пробы П2). */
export const VOLUME_TEMPLATES = 200;
export const VOLUME_TASKS = 2_000;
export const VOLUME_EVENTS = 1_000;
export const VOLUME_ENTITIES =
  VOLUME_CATEGORIES +
  VOLUME_ENVELOPES +
  VOLUME_TEMPLATES +
  VOLUME_TXNS +
  VOLUME_TASKS +
  VOLUME_EVENTS;
/**
 * Нижняя граница привязок. Точного числа здесь нет НАМЕРЕННО: сколько движений найдут конверт,
 * решает селектор, и вписать 16 211 значило бы пинить его выбор вторым способом. Проба П2 на той
 * же раскладке дала 16 211 (`.superpowers/probe/p2/load-20k.txt`).
 */
export const VOLUME_MIN_BINDINGS = 16_000;
export const VOLUME_DEFAULT_CURRENCY = 'RUB';
export const VOLUME_PROBE_COUNT = 100;

function volumeId(key: string): string {
  return uuidv5(`volume-perf-fixture:${key}`, ORBIS_NAMESPACE);
}
export function volumeCategoryId(i: number): string {
  return volumeId(`cat:${i}`);
}
export function volumeEnvelopeId(month: string, currency: string, catIdx: number): string {
  return volumeId(`env:${month}:${currency}:${catIdx}`);
}
function monthOfTotal(total: number): string {
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`;
}
/** k-й из VOLUME_MONTHS месяцев, оканчивающихся на VOLUME_LAST_MONTH; k=0 — самый старый. */
export function volumeMonth(k: number): string {
  if (!Number.isInteger(k) || k < 0 || k >= VOLUME_MONTHS) {
    throw new RangeError(`volumeMonth: k вне 0..${VOLUME_MONTHS - 1}: ${k}`);
  }
  const [y, m] = VOLUME_LAST_MONTH.split('-').map(Number) as [number, number];
  return monthOfTotal(y * 12 + (m - 1) - (VOLUME_MONTHS - 1 - k));
}
/** Конец месяца — сдвигом от первого числа следующего общей календарной арифметикой
 *  (`@orbis/shared/date`), а не через `Date.UTC`: вторая копия календаря — то, что запрещает Р-И-15. */
function monthRange(month: string): { start: string; end: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return { start: `${month}-01`, end: addDays(`${monthOfTotal(y * 12 + m)}-01`, -1) };
}
/** mulberry32 — детерминированный PRNG пробы П2 (`lib/world.ts:26`), перенесён дословно. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CREATED_AT = new Date('2026-08-01T00:00:00Z');
function entityRow(
  id: string,
  title: string,
  props: Record<string, unknown>,
  aspects: string[],
): typeof entities.$inferInsert {
  return {
    id,
    ownerId: VOLUME_OWNER_ID,
    title,
    body: '',
    tags: [],
    props,
    aspects,
    queryRefs: [],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

export interface VolumeWorld {
  entities: (typeof entities.$inferInsert)[];
  relations: (typeof relations.$inferInsert)[];
  months: readonly string[];
  stats: Record<string, number>;
}

export function buildVolumeWorld(): VolumeWorld {
  const r = rng(VOLUME_SEED);
  const months = Array.from({ length: VOLUME_MONTHS }, (_, k) => volumeMonth(k));
  const ents: (typeof entities.$inferInsert)[] = [];
  const rels: (typeof relations.$inferInsert)[] = [];
  const stats: Record<string, number> = {
    categories: VOLUME_CATEGORIES,
    envelopes: VOLUME_ENVELOPES,
  };

  // Категории: 0..5 — родители, 6..23 — дети по трое, 24..31 — плоские. Дерево нужно затем, что
  // агрегаты Budget обходят ТОЛЬКО `category-parent` (`aggregates.ts:261-270`).
  const categoryIds = Array.from({ length: VOLUME_CATEGORIES }, (_, i) => volumeCategoryId(i));
  for (let i = 0; i < VOLUME_CATEGORIES; i++) {
    const spendClass = i % 3 === 0 ? 'fixed' : i % 3 === 1 ? 'discretionary' : null;
    ents.push(
      entityRow(
        categoryIds[i] as string,
        `Категория ${String(i).padStart(2, '0')}`,
        {
          'orbis/icon': `i${i % 10}`,
          'orbis/color': `#${((i * 1234567) % 0xffffff).toString(16).padStart(6, '0')}`,
          ...(spendClass === null ? {} : { 'orbis/spend_class': spendClass }),
        },
        ['orbis/category'],
      ),
    );
  }
  for (let p = 0; p < 6; p++) {
    for (let k = 0; k < 3; k++) {
      const child = 6 + p * 3 + k;
      rels.push({
        id: volumeId(`cattree:${p}:${child}`),
        sourceId: categoryIds[p] as string,
        targetId: categoryIds[child] as string,
        role: ROLE_CATEGORY_PARENT,
      });
    }
  }

  // Конверты. Лимиты разведены так, чтобы в тревоге была МЕНЬШАЯ часть, — иначе ветка dailyPace
  // (только remaining ≥ 0) не участвовала бы в замере вовсе.
  for (const month of months) {
    const { start, end } = monthRange(month);
    for (const [cur, count] of [
      [VOLUME_DEFAULT_CURRENCY, VOLUME_ENVELOPE_RUB_CATS],
      ['USD', VOLUME_ENVELOPE_USD_CATS],
    ] as Array<[string, number]>) {
      for (let c = 0; c < count; c++) {
        const limit = (40000 + ((c * 3137 + month.charCodeAt(6) * 911) % 60000)).toFixed(2);
        const carryover = r() < 0.34 ? ((r() - 0.4) * 8000).toFixed(2) : null;
        const props: Record<string, unknown> = {
          'orbis/finance_category': categoryIds[c] as string,
          'orbis/limit': limit,
          'orbis/currency': cur,
          'orbis/period_start': start,
          'orbis/period_end': end,
        };
        if (carryover !== null) props['orbis/carryover'] = carryover;
        ents.push(
          entityRow(
            volumeEnvelopeId(month, cur, c),
            `Конверт «Категория ${String(c).padStart(2, '0')}» ${month} ${cur}`,
            props,
            ['orbis/budget'],
          ),
        );
      }
    }
  }
  // `orbis/recurrence` — ровно два ключа: схема свойства `additionalProperties:false`
  // (`builtin-properties.ts:58-68`), и `byMonthDay` пробы П2 сегодня незаконен.
  const templateIds: string[] = [];
  for (let i = 0; i < VOLUME_TEMPLATES; i++) {
    const id = volumeId(`tpl:${i}`);
    templateIds.push(id);
    ents.push(
      entityRow(
        id,
        `Шаблон ${i}`,
        {
          'orbis/amount': (100 + ((i * 733) % 20000) / 100).toFixed(2),
          'orbis/currency': VOLUME_DEFAULT_CURRENCY,
          'orbis/direction': 'expense',
          'orbis/finance_category': categoryIds[i % VOLUME_ENVELOPE_RUB_CATS] as string,
          'orbis/occurred_on': `${months[VOLUME_MONTHS - 1]}-15`,
          'orbis/planned': true,
          'orbis/recurrence': { freq: 'monthly', interval: 1 },
        },
        ['orbis/financial', 'orbis/schedule'],
      ),
    );
  }
  stats.templates = VOLUME_TEMPLATES;

  let planned = 0,
    instances = 0,
    usd = 0,
    income = 0,
    currencyImplicit = 0;
  for (let i = 0; i < VOLUME_TXNS; i++) {
    const id = volumeId(`txn:${i}`);
    const isPlanned = r() < 0.1;
    const isInstance = isPlanned && r() < 0.4;
    const month = months[Math.floor(r() * VOLUME_MONTHS)] as string;
    const { end } = monthRange(month);
    const day = 1 + Math.floor(r() * Number(end.slice(8, 10)));
    // Инстанс — planned с датой СТРОГО в будущем: `postDueInstances` его не тронет.
    const occurredOn = isInstance
      ? addDays(VOLUME_TODAY, 1 + Math.floor(r() * 30))
      : `${month}-${String(day).padStart(2, '0')}`;
    const direction = r() < 0.08 ? 'income' : 'expense';
    if (direction === 'income') income++;
    const isUsd = r() < 0.1;
    if (isUsd) usd++;
    const explicitCurrency = isUsd ? 'USD' : r() < 0.5 ? VOLUME_DEFAULT_CURRENCY : null;
    if (explicitCurrency === null) currencyImplicit++;
    // 10 % движений уходят в категории 30/31 — конверта у них нет НИКОГДА: без этого Unbudgeted
    // был бы пуст, и половина Overview не мерилась бы.
    const catIdx =
      r() < 0.9
        ? Math.floor(r() * VOLUME_ENVELOPE_RUB_CATS)
        : VOLUME_ENVELOPE_RUB_CATS + Math.floor(r() * 2);
    if (isPlanned) planned++;
    const props: Record<string, unknown> = {
      'orbis/amount': (10 + Math.floor(r() * 5_000_00) / 100).toFixed(2),
      'orbis/direction': direction,
      'orbis/finance_category': categoryIds[catIdx] as string,
      'orbis/occurred_on': occurredOn,
      'orbis/planned': isPlanned,
    };
    if (explicitCurrency !== null) props['orbis/currency'] = explicitCurrency;
    ents.push(entityRow(id, `Операция ${i}`, props, ['orbis/financial']));
    if (isInstance) {
      instances++;
      // Направление — шаблон → экземпляр (`recurring/materialize.ts:520-522`, РП-5); поле роли одно
      // (`role`), производной `relation_type` после 0017 нет — и греп-гейт стережёт это имя.
      rels.push({
        id: volumeId(`instance:${i}`),
        sourceId: templateIds[i % templateIds.length] as string,
        targetId: id,
        role: ROLE_INSTANCE_OF,
      });
    }
  }
  Object.assign(stats, {
    transactions: VOLUME_TXNS,
    planned,
    instances,
    usd,
    income,
    currencyImplicit,
  });

  const TASK_STATUSES = [
    'inbox',
    'planned',
    'in_progress',
    'waiting',
    'done',
    'cancelled',
  ] as const;
  const PRIORITIES = ['low', 'medium', 'high'] as const;
  for (let i = 0; i < VOLUME_TASKS; i++) {
    ents.push(
      entityRow(
        volumeId(`task:${i}`),
        `Задача ${i}`,
        {
          'orbis/task_status': TASK_STATUSES[i % TASK_STATUSES.length] as string,
          'orbis/priority': PRIORITIES[i % PRIORITIES.length] as string,
          // ±60 дней вокруг «сегодня» корпуса: окно Agenda обязано отсекать, а не брать всё
          'orbis/due_date': addDays(VOLUME_TODAY, (i % 121) - 60),
        },
        ['orbis/task'],
      ),
    );
  }
  for (let i = 0; i < VOLUME_EVENTS; i++) {
    const day = i % 2 === 0 ? addDays(VOLUME_TODAY, i % 8) : addDays(VOLUME_TODAY, (i % 61) - 30);
    ents.push(
      entityRow(
        volumeId(`event:${i}`),
        `Событие ${i}`,
        {
          'orbis/start_at': `${day}T${String(8 + (i % 12)).padStart(2, '0')}:00:00Z`,
        },
        ['orbis/schedule'],
      ),
    );
  }
  Object.assign(stats, { tasks: VOLUME_TASKS, events: VOLUME_EVENTS });

  return { entities: ents, relations: rels, months, stats };
}

/**
 * Сто движений сторожа Р-К-2 — НЕ часть корпуса: их создаёт через `execute()` сам тест и сносит
 * после. Раскладка выбрана по веткам селектора: категории по кругу (30 и 31 конверта не имеют —
 * ветка «null»), валюта во всех трёх формах, даты — по всем двенадцати периодам.
 */
export interface VolumeProbe {
  id: string;
  title: string;
  categoryRef: string;
  currency: string | null;
  occurredOn: string;
  amount: string;
}
export function volumeProbes(): readonly VolumeProbe[] {
  return Array.from({ length: VOLUME_PROBE_COUNT }, (_, i) => ({
    id: volumeId(`probe:${i}`),
    title: `Проба сторожа ${i}`,
    categoryRef: volumeCategoryId(i % VOLUME_CATEGORIES),
    currency: i % 10 === 0 ? 'USD' : i % 3 === 0 ? null : VOLUME_DEFAULT_CURRENCY,
    occurredOn: `${volumeMonth(i % VOLUME_MONTHS)}-${String(1 + ((i * 7) % 28)).padStart(2, '0')}`,
    amount: (100 + i).toFixed(2),
  }));
}
export const VOLUME_PROBE_IDS: readonly string[] = volumeProbes().map((p) => p.id);

/** Свойства пробы (§А1-1) — одна форма и для `entity_create`, и для сверки. */
export function volumeProbeProps(p: VolumeProbe): Record<string, unknown> {
  return {
    'orbis/amount': p.amount,
    'orbis/direction': 'expense',
    'orbis/finance_category': p.categoryRef,
    'orbis/occurred_on': p.occurredOn,
    'orbis/planned': false,
    ...(p.currency === null ? {} : { 'orbis/currency': p.currency }),
  };
}

/**
 * Комбинация селектора по свойствам движения — ЕДИНСТВЕННАЯ копия правила `combinationOf`
 * (`binding.ts:258-271`) на стороне фикстуры, и зовут её ОБА потребителя: сев привязок и сторож
 * Р-К-2. Одна копия здесь не аккуратность, а условие проверяемости: разойдись это правило с
 * хуковым — сторож покраснеет, потому что его ожидание считается ИМЕННО отсюда, а фактические
 * рёбра ставит настоящий хук.
 */
export function volumeCombination(
  props: Record<string, unknown>,
  aspects: readonly string[],
): EnvelopeCombination | null {
  if (!aspects.includes('orbis/financial')) return null;
  // Шаблон повторения хук отвязывает, а не привязывает (`binding.ts:253`).
  if (aspects.includes('orbis/schedule') && props['orbis/recurrence'] !== undefined) return null;
  const categoryRef = props['orbis/finance_category'];
  const occurredOn = props['orbis/occurred_on'];
  if (typeof categoryRef !== 'string' || typeof occurredOn !== 'string') return null;
  const currency = props['orbis/currency'];
  return {
    categoryRef,
    currency: typeof currency === 'string' ? currency : VOLUME_DEFAULT_CURRENCY,
    occurredOn,
  };
}

/** Строк в одном INSERT — как в graph-fixture: мало round-trip'ов, пакет не разрастается. */
const BATCH = 2000;
/** Комбинаций в одном вызове селектора: 500 × 5 параметров — далеко от предела PG. */
const SELECTOR_BATCH = 500;
const probeIdList = () =>
  sql.join(
    VOLUME_PROBE_IDS.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

async function countRows(
  db: Db,
): Promise<{ entities: number; envelopes: number; bindings: number }> {
  const rows = (await db.execute(sql`
    SELECT (SELECT count(*) FROM entities WHERE owner_id = ${VOLUME_OWNER_ID}::uuid) AS e,
           (SELECT count(*) FROM entities WHERE owner_id = ${VOLUME_OWNER_ID}::uuid
                             AND 'orbis/budget' = ANY(aspects)) AS env,
           (SELECT count(*) FROM relations r JOIN entities s ON s.id = r.source_id
             WHERE s.owner_id = ${VOLUME_OWNER_ID}::uuid AND r.role = ${ROLE_ENVELOPE_BINDING}) AS b
  `)) as unknown as Array<{ e: string; env: string; b: string }>;
  const row = rows[0];
  return {
    entities: Number(row?.e ?? 0),
    envelopes: Number(row?.env ?? 0),
    bindings: Number(row?.b ?? 0),
  };
}

/**
 * Привязки конверт→движение — одним проходом ТОГО ЖЕ селектора, что зовёт бюджет-хук
 * (`binding.ts:451` → `selectEnvelopes`), и по тому же правилу комбинации. Проход идёт под
 * админ-DSN: RLS здесь ничего не меняет — селектор и так фильтрует `owner_id = $1`, а вторая
 * приложенческая коннекция ради этого не нужна.
 */
async function seedBindings(db: Db, world: VolumeWorld): Promise<number> {
  const targets: Array<{ txnId: string; key: string } & EnvelopeCombination> = [];
  for (const e of world.entities) {
    const c = volumeCombination(e.props as Record<string, unknown>, e.aspects as string[]);
    if (c === null) continue;
    targets.push({
      txnId: e.id as string,
      key: `${c.categoryRef}|${c.currency}|${c.occurredOn}`,
      ...c,
    });
  }
  const unique: EnvelopeQuery[] = [];
  const seen = new Set<string>();
  for (const t of targets) {
    if (seen.has(t.key)) continue;
    seen.add(t.key);
    unique.push({
      key: t.key,
      categoryRef: t.categoryRef,
      currency: t.currency,
      occurredOn: t.occurredOn,
    });
  }
  const picked = new Map<string, string | null>();
  for (let i = 0; i < unique.length; i += SELECTOR_BATCH) {
    const won = await db.transaction(async (tx) =>
      selectEnvelopes(tx, {
        ownerId: VOLUME_OWNER_ID,
        defaultCurrency: VOLUME_DEFAULT_CURRENCY,
        rows: unique.slice(i, i + SELECTOR_BATCH),
      }),
    );
    for (const [k, v] of won) picked.set(k, v);
  }
  const edges = targets.flatMap((t) => {
    const envelopeId = picked.get(t.key) ?? null;
    return envelopeId === null
      ? []
      : [
          {
            id: volumeId(`bind:${t.txnId}`),
            sourceId: envelopeId,
            targetId: t.txnId,
            role: ROLE_ENVELOPE_BINDING,
          },
        ];
  });
  for (let i = 0; i < edges.length; i += BATCH) {
    await db.insert(relations).values(edges.slice(i, i + BATCH));
  }
  return edges.length;
}

export async function ensureVolumeFixture(): Promise<{
  entities: number;
  envelopes: number;
  bindings: number;
  seeded: boolean;
}> {
  const { db, client } = adminDb();
  try {
    // Хвост оборванного сторожа сносится ДО пересчёта: иначе сотня лишних строк читалась бы как
    // «корпус не тот» и гнала бы полный пересев на каждом прогоне.
    await db.execute(sql`DELETE FROM entities WHERE id IN (${probeIdList()})`);
    const before = await countRows(db);
    if (
      before.entities === VOLUME_ENTITIES &&
      before.envelopes === VOLUME_ENVELOPES &&
      before.bindings >= VOLUME_MIN_BINDINGS
    ) {
      return { ...before, seeded: false };
    }
    // Неполный корпус не досевается, а пересевается: досев обязан знать, какие строки уже есть, а
    // знать этого он не может — прошлый прогон могли оборвать (`graph-fixture.ts:180-182`).
    await db.execute(sql`DELETE FROM entities WHERE owner_id = ${VOLUME_OWNER_ID}::uuid`);
    // Часы владельца — UTC: «сегодня» корпуса обязано быть воспроизводимым, а не зависеть от
    // зоны машины (`localToday` читает user_settings.timezone).
    await db
      .insert(userSettings)
      .values({
        ownerId: VOLUME_OWNER_ID,
        timezone: 'UTC',
        defaultCurrency: VOLUME_DEFAULT_CURRENCY,
      })
      .onConflictDoNothing();

    const world = buildVolumeWorld();
    for (let i = 0; i < world.entities.length; i += BATCH) {
      await db.insert(entities).values(world.entities.slice(i, i + BATCH));
    }
    // ANALYZE ДО прохода селектора, а не только в конце: LATERAL по 480 конвертам на свежезалитой
    // таблице планировщик считает по умолчаниям статистики, и сев упирался бы в его неведение
    // (урок `src/test/perf.ts:376-388`: 64 против 464 мс).
    await db.execute(sql`ANALYZE entities`);
    for (let i = 0; i < world.relations.length; i += BATCH) {
      await db.insert(relations).values(world.relations.slice(i, i + BATCH));
    }
    await seedBindings(db, world);
    await db.execute(sql`ANALYZE entities, relations`);
    return { ...(await countRows(db)), seeded: true };
  } finally {
    await client.end();
  }
}
