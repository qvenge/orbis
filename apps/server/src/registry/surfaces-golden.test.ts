// Снимки четырёх поверхностей (§С8-20, консервативность §С1-3 п.9). Жанр — как у
// `tools/registry-golden.test.ts`: эталон снимается ОДИН РАЗ на посчитанном руками мире и
// дальше ЗАЩИЩАЕТ. «Записать что вышло» запрещено — расхождение разбирается, а намеренная
// правка пересдаётся ОТДЕЛЬНЫМ движением с объяснением в коммите.
//
// ЧЕТЫРЕ СОСТОЯНИЯ (§С8-20, консервативность §С1-3 п.9). Словарь состояний — тот же, что у
// семантических гардов промпта (§Б7-4): эталон / выключенный модуль / пользовательский аспект с
// привязкой / переименованный label. Один словарь на два места намеренно: «четыре состояния»
// обязано означать одно и то же в приёмке поверхностей и в приёмке канала.
//
// Утверждение консервативности — НЕ «снимок отличается», а «отличается РОВНО в назначенном месте,
// остальное байт-в-байт». Поэтому у каждого состояния два теста: равенство своему эталону
// (регрессия) и адресное сравнение с `baseline` (смысл). Эталон снимается ОДИН раз и дальше
// защищает; при расхождении разбирается расхождение, а не пересдаётся эталон (тот же запрет и тот
// же довод, что в `tools/registry-golden.test.ts:11-20`).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { canonicalJson } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { GATE_SURFACE_SLUGS } from '../../test/fixtures/gate-aspects';
import GOLDEN from '../../test/golden/surfaces.json';
import { appDb, requireEnv, truncateAll } from '../../test/helpers';
import {
  applySurfaceState,
  compareSnapshots,
  SNAPSHOT_SURFACES,
  SURFACE_GATE_OWNER_ID,
  SURFACE_OWNER_ID,
  SURFACE_RELABEL_ASPECT,
  SURFACE_RELABEL_LABEL,
  SURFACE_SLUGS,
  SURFACE_STATE_OWNER,
  SURFACE_STATES,
  SURFACE_TODAY,
  type SurfacePayloads,
  type SurfaceSnapshot,
  type SurfaceState,
  seedSurfaceWorld,
  snapshotSurfaces,
  surfaceEntityId,
} from '../../test/surfaces';
import { withIdentity } from '../db/with-identity';
import { appRouter } from '../router';
import { createCallerFactory } from '../trpc';
import { effectiveRegistry } from './cache';

requireEnv();
const { db, client } = appDb();
// Счёт идёт ПОД ЛИЧНОСТЬЮ владельца: у роли подключения нет прямых грантов на `entities`
// (гранты выданы роли `authenticated` — `0001_rls_and_indexes.sql:97`), и голый
// `db.execute` отвечает `permission denied for table entities`. Заодно RLS скоупит счёт
// связей владельцем — «ровно одно ребро dependency» становится утверждением про ЕГО мир.
const countOf = async (q: ReturnType<typeof sql>): Promise<number> =>
  withIdentity(
    db,
    SURFACE_OWNER_ID,
    async (tx) => ((await tx.execute(q)) as unknown as { n: number }[])[0]?.n ?? -1,
  );

/**
 * Состояние 3 — единственное, чей мир другой: в него досеиваются аспекты гейта (0d/10). Опции
 * состояний 1 и 3 повторяют то, что сеяли 0b и 10, буква в букву: цикл ничего не меняет в их
 * мирах, он лишь перестаёт повторять сев дважды.
 */
const WORLD_OPTS: Readonly<Record<SurfaceState, { gateAspects?: boolean }>> = {
  baseline: {},
  'module-off': {},
  'custom-aspect': { gateAspects: true },
  relabeled: {},
};

const snapshots = new Map<SurfaceState, SurfaceSnapshot>();

/**
 * СОХРАНЁННЫЙ AST, а не текст: §С8-22 обещает, что запросы владельца не ломаются выключением
 * модуля, а хранится у него именно дерево (тела документов, `ref.target`, `scope`). Дерево
 * подаётся в `entity.query` напрямую (`{ast}` — вторая половина `querySignature`), мимо разбора
 * текста: разбор — отдельный слой, и его участие ослабило бы утверждение.
 */
const AMOUNT_AST = {
  filter: { prop: 'orbis/amount', op: 'gt' as const, value: '0' },
  sortBy: [{ field: 'orbis/title', dir: 'asc' as const }],
};
/** Ответы запроса — СЛАГАМИ, а не id: см. довод у сбора ниже. */
const amountNames = new Map<SurfaceState, string[]>();
/** Подпись аспекта состояния 4 в эффективном реестре КАЖДОГО владельца. */
const aspectLabels = new Map<SurfaceState, string | undefined>();

/**
 * ЧЕТЫРЕ МИРА СТОЯТ РЯДОМ, А НЕ СМЕНЯЮТ ДРУГ ДРУГА ЧЕРЕЗ `truncateAll`.
 *
 * Первое следствие — тесты 0b и 10 не теряют своих миров: они читают `SURFACE_OWNER_ID` и
 * `SURFACE_GATE_OWNER_ID` (счёт сева, «baseline равен эталону», два прогона подряд,
 * «custom-aspect равен эталону»), и фикстура состояний у них ничего не отбирает. Один владелец
 * на четыре состояния оставил бы им пустую базу — «зелёные тесты соседей» было бы неправдой.
 *
 * Второе — снимается вопрос кеша реестра целиком. Ключ снимка — `(владелец, его версия,
 * системная)` (`registry/cache.ts`), у четырёх владельцев ключи не пересекаются даже на нулевой
 * версии. Версию внутри владельца двигают САМИ боевые писатели: `setAspectDelta` зовёт
 * `bumpOwnerRegistryVersion` последним statement'ом (`registry/ops.ts`), сев кастомных аспектов
 * состояния 3 — там же. Доводить версию из фикстуры не нужно и нельзя: это был бы второй
 * механизм инвалидации, которого в бою нет, и зелень на нём ничего не говорила бы о проде.
 *
 * `truncateAll` — ОДИН, в начале (он же стоял в `beforeAll` 0b): база нужна чистая один раз, а
 * между состояниями чистить нечего — миры не пересекаются ни по владельцу, ни по id.
 *
 * Таймаута у хука нет — и не «забыт», а НЕВОЗМОЖЕН и НЕ НУЖЕН: `beforeAll` в bun 1.2.7 принимает
 * ровно один аргумент (`bun-types`; второй не проходит typecheck), и таймаут теста на хук не
 * распространяется — прецедент `perf/graph.test.ts:133`, где в том же `beforeAll` сеется корпус
 * на 50 000 сущностей. Ф-Б1-41 (явные `30_000`) — про ТЕЛА тестов; здесь все 76 операций
 * исполнителя стоят в хуке, а тела читают готовые снимки.
 */
beforeAll(async () => {
  await truncateAll();
  for (const state of SURFACE_STATES) {
    const owner = SURFACE_STATE_OWNER[state];
    await seedSurfaceWorld(owner, WORLD_OPTS[state]);
    await applySurfaceState(db, owner, state);
    snapshots.set(state, await snapshotSurfaces(db, owner, state, SURFACE_TODAY));
    const caller = createCallerFactory(appRouter)({
      actorUserId: owner,
      actorKind: 'owner',
      db,
      clientVersion: null,
    });
    // Сравниваются слаги, а не id: у каждого состояния свой владелец, а id мира считаются от него
    // (`surfaceEntityId`). Тот же перевод, что делает `stabilize` внутри снимка; на сырых id «то
    // же множество» было бы недостижимо по построению, а не по смыслу.
    const names = new Map(
      SURFACE_SLUGS.map((s) => [surfaceEntityId(owner, s).toLowerCase(), `@${s}`]),
    );
    const found = await caller.entity.query({ ast: AMOUNT_AST });
    amountNames.set(
      state,
      found.map((r) => names.get(r.id.toLowerCase()) ?? '<uuid>'),
    );
    // Подпись — строка, а не id, поэтому её значение сравнимо между владельцами напрямую;
    // читается она из эффективного реестра ИМЕННО этого владельца (дельта состояния 4 стоит
    // только у него).
    aspectLabels.set(
      state,
      await withIdentity(db, owner, async (tx) => {
        const reg = await effectiveRegistry(tx, owner);
        return reg.aspects.get(SURFACE_RELABEL_ASPECT)?.label.ru;
      }),
    );
  }
  // ПЕРЕСДАЧА ЭТАЛОНА — РУЧНАЯ И ОСОЗНАННАЯ, как у эталона тулов (`registry-golden.test.ts:11-20`):
  // «записать что вышло» при расхождении запрещено. Печать по явному требованию — НЕ
  // автообновление: она избавляет от одноразового скрипта, вставляет человек, и коммит обязан
  // объяснить, ЧТО изменилось. SURFACES_PRINT=module-off bun test src/registry/surfaces-golden.test.ts
  const printed = process.env.SURFACES_PRINT;
  if (printed !== undefined) {
    console.log(JSON.stringify(snap(printed as SurfaceState).surfaces, null, 2));
  }
});

/** Снимок состояния — с внятным отказом вместо `undefined` в глубине сравнения. */
function snap(state: SurfaceState): SurfaceSnapshot {
  const s = snapshots.get(state);
  if (s === undefined) throw new Error(`снимок состояния ${state} не снят — сломан beforeAll`);
  return s;
}
afterAll(async () => {
  await client.end();
});

describe('снимки поверхностей: консервативность §С1-3 п.9', () => {
  test('мир снимков засеян целиком: 18 сущностей и ребро dependency', async () => {
    expect(
      await countOf(
        sql`SELECT count(*)::int AS n FROM entities WHERE owner_id = ${SURFACE_OWNER_ID}`,
      ),
    ).toBe(SURFACE_SLUGS.length);
    // Счёт по ВЛАДЕЛЬЦУ, а не по базе: рядом стоят ещё три мира состояний, и «одно ребро на всю
    // таблицу» проверяло бы число миров в фикстуре, а не полноту сева этого мира. Своей колонки
    // владельца у `relations` нет (`db/schema.ts`) — владение приходит концами ребра. RLS под
    // личностью владельца скоупит выдачу и сама, но условие стоит в запросе: сторож не должен
    // зависеть от того, чьей личностью открыта tx.
    expect(
      await countOf(sql`SELECT count(*)::int AS n FROM relations r
      JOIN entities e ON e.id = r.source_id
      WHERE r.role = 'dependency' AND e.owner_id = ${SURFACE_OWNER_ID}`),
    ).toBe(1);
  });

  test('снимок Budget снимается на той же tx, что чтения графа', async () => {
    const snap = await snapshotSurfaces(db, SURFACE_OWNER_ID, 'baseline', SURFACE_TODAY);
    const ov = snap.surfaces['finance/budget-overview'];
    expect(ov.alertCount).toBe(1);
    expect(ov.balance).toEqual({ income: '50000.00', expense: '10700.00', balance: '39300.00' });
    expect(ov.envelopes.map((e) => [e.category.title, e.spent, e.remaining, e.dailyPace])).toEqual([
      ['Еда', '9000.00', '1000.00', '100.00'],
      ['Транспорт', '1000.00', '4000.00', '400.00'],
    ]);
    expect(ov.unbudgeted).toEqual([
      { category: { id: '@cat-coffee', title: 'Кофе', icon: '☕' }, total: '700.00' },
    ]);
    expect(ov.comingUp).toEqual([]);
  });
  test('снимок Agenda — движок подписки §Б5-6: окно и просроченное на прибитом today', async () => {
    const snap = await snapshotSurfaces(db, SURFACE_OWNER_ID, 'baseline', SURFACE_TODAY);
    expect(snap.surfaces['planner/agenda']).toEqual([
      // `@tpl-weekly` (08:00) выборкой возвращён и снят фильтром шаблона.
      { section: 'window', id: '@event-today', title: 'Событие сегодня', at: '2026-07-03' },
      // Слияние двух выборок: min(due_date '2026-07-02', локальный день start_at '2026-07-01').
      { section: 'overdue', id: '@task-open', title: 'Задача просроченная', at: '2026-07-01' },
    ]);
  });
  test('снимок строки — четыре элемента M14 §1.8, и excludeBlocked прячет ровно одну цель', async () => {
    const snap = await snapshotSurfaces(db, SURFACE_OWNER_ID, 'baseline', SURFACE_TODAY);
    const rows = snap.surfaces['core/row'];
    expect(Object.keys(rows).length).toBe(SURFACE_SLUGS.length);
    // Полная форма — целиком, а не по полю: «поля нет» и «поле пусто» обязаны быть различимы,
    // иначе задача 7 могла бы потерять элемент, и эталон этого не заметил бы.
    expect(rows['@task-done']).toEqual({
      checkbox: { closed: true, cls: 'done' },
      date: { value: '2026-07-01', slot: 'deadline' },
      amount: null,
      progress: null,
      badges: [],
    });
    // Класс — не сырой статус: `planned` относится к классу `active` картой привязки задачи 2.
    // Бейдж важности — единственный бейдж мира (мир не содержит отменённой задачи).
    expect(rows['@task-blocked']).toEqual({
      checkbox: { closed: false, cls: 'active' },
      date: { value: '2026-07-10', slot: 'deadline' },
      amount: null,
      progress: null,
      badges: [{ kind: 'priority' }],
    });
    // Два аспекта на одной записи: срок СИЛЬНЕЕ момента — тот же порядок, что задаёт `slots` M14.
    expect(rows['@task-open']?.date).toEqual({ value: '2026-07-02', slot: 'deadline' });
    expect(rows['@mv-food-1']?.amount).toEqual({
      amount: '3000.00',
      direction: 'outflow',
      currency: 'RUB',
    });
    expect(rows['@mv-salary']?.amount?.direction).toBe('inflow');
    // У операции даты нет: `orbis/occurred_on` слотом контракта «Когда» не объявлен (§Б5-6).
    expect(rows['@mv-food-1']?.date).toBeNull();
    expect(rows['@event-today']?.date).toEqual({
      value: '2026-07-03T10:00:00+03:00',
      slot: 'moment',
    });
    // Категория: ни одного контракта M14 её аспект не реализует — все пять полей пусты.
    expect(rows['@cat-food']).toEqual({
      checkbox: null,
      date: null,
      amount: null,
      progress: null,
      badges: [],
    });
    const visible = snap.surfaces['core/exclude-blocked'];
    expect(visible).not.toContain('@task-blocked');
    expect(visible.length).toBe(SURFACE_SLUGS.length - 1);
  });
  test('в снимке нет ни сырых uuid, ни машинных отметок времени: сравнимы два прогона и два состояния', async () => {
    const a = await snapshotSurfaces(db, SURFACE_OWNER_ID, 'baseline', SURFACE_TODAY);
    const b = await snapshotSurfaces(db, SURFACE_OWNER_ID, 'baseline', SURFACE_TODAY);
    expect(compareSnapshots(a, b)).toEqual([]);
    const text = canonicalJson(a.surfaces);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    // Ловится РОВНО форма `createdAt`/`updatedAt` базы (UTC с миллисекундами), а не всякий ISO:
    // моменты мира (`2026-07-03T10:00:00+03:00`) — данные снимка и обязаны в нём стоять.
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    expect(text).not.toContain('<uuid>'); // ни одного id мимо словаря слагов
  });
  test('baseline равен эталону surfaces.json по canonicalJson', async () => {
    const snap = await snapshotSurfaces(db, SURFACE_OWNER_ID, 'baseline', SURFACE_TODAY);
    const golden = (GOLDEN as { states: Record<string, Record<string, unknown>> }).states.baseline;
    // Сначала по поверхностям: расхождение читается человеком, дифф двух больших JSON — нет.
    for (const surface of SNAPSHOT_SURFACES) {
      expect(`${surface}: ${canonicalJson(snap.surfaces[surface])}`).toBe(
        `${surface}: ${canonicalJson(golden?.[surface])}`,
      );
    }
    expect(canonicalJson(snap.surfaces)).toBe(canonicalJson(golden));
  });
  test('снимок custom-aspect снят и лежит в эталоне', async () => {
    const snap = await snapshotSurfaces(db, SURFACE_GATE_OWNER_ID, 'custom-aspect', SURFACE_TODAY);
    const golden = (GOLDEN as { states: Record<string, Record<string, unknown>> }).states[
      'custom-aspect'
    ];
    for (const surface of SNAPSHOT_SURFACES) {
      expect(`${surface}: ${canonicalJson(snap.surfaces[surface])}`).toBe(
        `${surface}: ${canonicalJson(golden?.[surface])}`,
      );
    }
  });

  /** Пути расходящихся листьев двух значений — читаемая форма «где именно отличается». */
  function diffPaths(a: unknown, b: unknown, prefix = ''): string[] {
    if (canonicalJson(a) === canonicalJson(b)) return [];
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return [prefix];
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    return [...keys]
      .flatMap((k) =>
        diffPaths(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
          prefix === '' ? k : `${prefix}.${k}`,
        ),
      )
      .sort();
  }
  const isGate = (s: string) => GATE_SURFACE_SLUGS.some((g) => s === `@${g}`);

  test('custom-aspect отличается от baseline ровно строками гейта и ровно в spent конверта', () => {
    const states = (GOLDEN as { states: Record<string, Record<string, unknown> | undefined> })
      .states;
    const base = states.baseline;
    const cust = states['custom-aspect'];
    // Оба состояния обязаны БЫТЬ: без явной проверки терпимое чтение ниже превратило бы
    // «состояния в эталоне нет» в «состояния совпали», и тест зеленел бы на пустом эталоне.
    if (base === undefined || cust === undefined)
      throw new Error('в эталоне нет обоих состояний: baseline и custom-aspect');
    // Три поверхности: убираем строки гейта — остаток обязан совпасть с baseline байт-в-байт.
    const rows = Object.fromEntries(
      Object.entries(cust['core/row'] as Record<string, unknown>).filter(([k]) => !isGate(k)),
    );
    expect(canonicalJson(rows)).toBe(canonicalJson(base['core/row']));
    expect(
      canonicalJson((cust['core/exclude-blocked'] as string[]).filter((s) => !isGate(s))),
    ).toBe(canonicalJson(base['core/exclude-blocked']));
    expect(
      canonicalJson((cust['planner/agenda'] as { id: string }[]).filter((r) => !isGate(r.id))),
    ).toBe(canonicalJson(base['planner/agenda']));
    // Budget вычитанием не разделить: аспект гейта обязан ДВИГАТЬ числа конверта — в этом и есть
    // §С8-18. Поэтому утверждается СПИСОК мест, которые сдвинулись, и он закрытый. Порядковый
    // индекс `envelopes.0` — карточка `@env-food`: порядок карточек задан ключом
    // `title periodStart id` и зафиксирован эталоном `baseline`.
    expect(diffPaths(base['finance/budget-overview'], cust['finance/budget-overview'])).toEqual([
      'balance.balance',
      'balance.expense',
      'envelopes.0.dailyPace',
      'envelopes.0.remaining',
      'envelopes.0.spent',
    ]);
    // И строки гейта действительно есть — иначе три сравнения выше стали бы тавтологией.
    expect(
      Object.keys(cust['core/row'] as object)
        .filter(isGate)
        .sort(),
    ).toEqual(['@gate-spend', '@gate-todo']);
  });

  test('эталон держит ровно объявленные состояния и все четыре поверхности', () => {
    const states = Object.keys((GOLDEN as { states: Record<string, unknown> }).states);
    // Список ЛИТЕРАЛОМ, а сторож новой группы («ровно четыре состояния») сверяет ключи эталона с
    // `SURFACE_STATES`: вместе они пиннят и сам словарь состояний — состояние, вычеркнутое разом
    // из эталона и из `SURFACE_STATES`, покраснело бы здесь.
    expect(states.sort()).toEqual(['baseline', 'custom-aspect', 'module-off', 'relabeled']);
    for (const state of states) {
      expect(SURFACE_STATES).toContain(state as SurfaceState);
      const payload = (GOLDEN as { states: Record<string, Record<string, unknown>> }).states[state];
      expect(Object.keys(payload ?? {}).sort()).toEqual([...SNAPSHOT_SURFACES].sort());
    }
  });
});

// Типизация эталона — как у эталона SQL (`query/compile.golden.test.ts:85`): JSON приезжает
// структурно, тип навешивается один раз здесь. Имя своё (не `GOLDEN`): импорт эталона уже занят
// тестами 0b/10, и переименовывать его задача 18 не вправе.
const GOLDEN_STATES = (GOLDEN as unknown as { states: Record<SurfaceState, SurfacePayloads> })
  .states;

describe('четыре состояния: отличие ровно в назначенном месте (§С8-20)', () => {
  test('эталон несёт ровно четыре состояния SURFACE_STATES и ни одного лишнего', () => {
    // §С8-20 называет число состояний приёмкой. Ключи эталона — единственное место, где это
    // число наблюдаемо: пятое состояние, дописанное «на всякий случай», и пропавшее четвёртое
    // выглядели бы одинаково зелёными, если бы тесты проверяли только те состояния, что помнят.
    expect(Object.keys(GOLDEN_STATES).sort()).toEqual([...SURFACE_STATES].sort());
  });

  test('module-off снят и равен эталону states["module-off"]', () => {
    // Сверка по КАНОНИЧЕСКОЙ форме (порядок ключей объекта не значим, порядок элементов списка —
    // значим): тот же довод, что у `registry-golden.test.ts`.
    expect(canonicalJson(snap('module-off').surfaces)).toBe(
      canonicalJson(GOLDEN_STATES['module-off']),
    );
  });

  test('module-off: finance/budget-overview пуст, в baseline — непуст (§С8-22)', () => {
    const base = snap('baseline').surfaces['finance/budget-overview'];
    const off = snap('module-off').surfaces['finance/budget-overview'];
    // Непустота baseline — половина утверждения: без неё «пусто при выключенном модуле» было бы
    // зелёным и на мире, где конвертов нет вовсе.
    expect(base.envelopes.length).toBeGreaterThan(0);
    expect(off.envelopes).toEqual([]);
    expect(off.comingUp).toEqual([]);
    expect(off.planned).toEqual([]);
    expect(off.unbudgeted).toEqual([]);
    expect(off.alertCount).toBe(0);
  });

  test('module-off: planner/agenda, core/row, core/exclude-blocked — байт-в-байт как baseline', () => {
    const base = snap('baseline');
    const off = snap('module-off');
    // §Б8-3: маска включённости стоит на ПОВЕРХНОСТЯХ-потребителях (реестр тулов, промпт-фрагменты,
    // подписки, `entity_create`/`attach`), а не внутри эффективного реестра — определения остаются
    // резолвимыми на чтение. Поэтому строка списка продолжает показывать сумму уже записанной
    // транзакции: выключение модуля — не потеря данных на экране.
    for (const surface of ['planner/agenda', 'core/row', 'core/exclude-blocked'] as const) {
      expect(canonicalJson(off.surfaces[surface])).toBe(canonicalJson(base.surfaces[surface]));
    }
    // И то же утверждение целиком: расходится РОВНО одна поверхность, а не «ещё какая-то тоже».
    expect(compareSnapshots(base, off).map((d) => d.surface)).toEqual(['finance/budget-overview']);
  });

  test('module-off: сохранённый AST с orbis/amount возвращает то же, что в baseline (§С8-22)', () => {
    const base = amountNames.get('baseline') ?? [];
    expect(base.length).toBeGreaterThan(0); // иначе утверждение пустое
    // Ни одного `<uuid>`: иначе сравнивались бы две маски, а не два ответа на запрос.
    expect(base).not.toContain('<uuid>');
    expect(amountNames.get('module-off')).toEqual(base);
  });

  test('relabeled снят и равен эталону states["relabeled"]', () => {
    expect(canonicalJson(snap('relabeled').surfaces)).toBe(canonicalJson(GOLDEN_STATES.relabeled));
  });

  test('relabeled: ни одна из четырёх поверхностей не сдвинулась', () => {
    // Подпись живёт в реестре и рисуется КЛИЕНТОМ (`classLabel`, `effectiveLabel`); ни отбор, ни
    // вычисление её не читают.
    expect(compareSnapshots(snap('baseline'), snap('relabeled'))).toEqual([]);
  });

  test('relabeled: подпись аспекта в эффективном реестре ДРУГАЯ — состояние не пустое', () => {
    // Без этого сторожа «снимки совпали» означало бы что угодно, включая «дельта молча не легла».
    const base = aspectLabels.get('baseline');
    expect(base).toBeDefined();
    expect(aspectLabels.get('relabeled')).toBe(SURFACE_RELABEL_LABEL.ru);
    expect(aspectLabels.get('relabeled')).not.toBe(base);
  });
});
