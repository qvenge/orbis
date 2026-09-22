// apps/server/test/test-seed.test.ts
// Синтетический словарь приёмки §С8-26: два аспекта `test/*`, четыре свойства и роль `participant`
// заведены ФИКСТУРОЙ (не сидом: `test/*` — строки владельца, системными им быть нельзя — иначе они
// уехали бы в дрейф `registry-drift.ts`, который читает `WHERE graph_id IS NULL`).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { TEST_IMPORT_ROUTINE_ID } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import type { Db } from '../src/db/client';
import { withIdentity } from '../src/db/with-identity';
import { effectiveRegistry } from '../src/registry/cache';
import {
  seedTestWorld,
  TEST_CALL_ASPECT,
  TEST_CONTACT_ASPECT,
  TEST_PROPS,
  TEST_ROLE_PARTICIPANT,
  TEST_ROLE_PARTICIPANT_KEY,
  type TestWorld,
} from './fixtures/test-seed';
import {
  adminDb,
  appDb,
  freshGraph,
  mintGraph,
  personal,
  requireEnv,
  seedCustomAspect,
  seedCustomRole,
  truncateAll,
} from './helpers';

requireEnv();
const { db, client } = appDb();
/** Владелец мира §С8-26 — на уровне модуля: его граф доводит до базы хук `ensureGraphs` файла. */
const owner = mintGraph();
afterAll(async () => {
  await client.end();
});

/** Есть ли уже колонка `rules` у строки аспекта: до миграции 0022 (задача 2) её нет. */
async function hasRulesColumn(adb: Db): Promise<boolean> {
  const rows = (await adb.execute(sql`SELECT 1 FROM information_schema.columns
    WHERE table_name = 'aspect_definitions' AND column_name = 'rules'`)) as unknown as unknown[];
  return rows.length > 0;
}

describe('хелпер сева роли владельца', () => {
  test('seedCustomRole кладёт строку роли и она видна снимком реестра владельца', async () => {
    const user = await freshGraph();
    await seedCustomRole(user, TEST_ROLE_PARTICIPANT);
    const reg = await withIdentity(db, personal(user), (tx) => effectiveRegistry(tx, user));
    const role = reg.roles.get(TEST_ROLE_PARTICIPANT_KEY);
    expect(role?.graphId).toBe(user);
    // `created_by: 'any'` — не деталь: `'system'` закрыл бы путь тула кодом ROLE_SYSTEM_ONLY, и
    // мир §С8-26 не смог бы поставить ребро `participant` владельческой операцией (дочитка §3).
    expect(role?.constraints).toEqual({ created_by: 'any' });
    expect(role?.symmetric).toBe(false);
  });
  test('повторный сев ПЕРЕЗАПИСЫВАЕТ подписи и ограничения (ловушка ON CONFLICT, Р12 Б-1)', async () => {
    const user = await freshGraph();
    await seedCustomRole(user, TEST_ROLE_PARTICIPANT);
    await seedCustomRole(user, {
      ...TEST_ROLE_PARTICIPANT,
      label: { ru: 'Участник встречи' },
      constraints: { created_by: 'any', acyclic: true },
    });
    const reg = await withIdentity(db, personal(user), (tx) => effectiveRegistry(tx, user));
    expect(reg.roles.get(TEST_ROLE_PARTICIPANT_KEY)?.label).toEqual({ ru: 'Участник встречи' });
    expect(reg.roles.get(TEST_ROLE_PARTICIPANT_KEY)?.constraints).toEqual({
      created_by: 'any',
      acyclic: true,
    });
  });
});

describe('правила в строке аспекта (§Б4-1) пишутся хелпером', () => {
  // ДВЕ формы записи, и обе обязательны: до миграции 0022 колонки `rules` НЕТ, и хелпер, пишущий
  // её всегда, уронил бы каждый сев вехи 0. Поэтому вторая форма — добивка отдельным UPDATE,
  // выполняемая ТОЛЬКО когда `spec.rules` задан.
  test('rules не задан → колонки не касаемся; задан → лежит в строке', async () => {
    const user = await freshGraph();
    const spec = {
      key: 'test/rules-probe',
      label: { ru: 'Проба правил' },
      properties: [{ key: 'rp_flag', type: { kind: 'boolean' } as const }],
    };
    // Первая форма проверяется СЕГОДНЯ и именно тем, что не падает: колонки `rules` в базе нет,
    // и сев без правил обязан её не касаться.
    await seedCustomAspect(user, spec); // без `rules` — до 0022 это единственный путь
    const { db: adb, client: ac } = adminDb();
    try {
      // Колонка приезжает миграцией 0022 (задача 2). До неё проба честно объявляет, чего ждёт, и
      // пропускается: пометка ожидаемого провала жила бы здесь до вехи I и размывала бы список
      // `PENDING_MARK_FILES`, который сторож сверяет поимённо. Сев С ПРАВИЛАМИ стоит ПОСЛЕ
      // условия, а не до него: он и есть тот самый UPDATE по несуществующей колонке (Р-К-77).
      if (!(await hasRulesColumn(adb))) {
        expect(await hasRulesColumn(adb)).toBe(false); // утверждение, а не тишина
        return;
      }
      await seedCustomAspect(user, {
        ...spec,
        rules: [
          { id: 'rp_requires', template: 'requires_when', params: { property: 'test/rp_flag' } },
        ],
      });
      const rows = (await adb.execute(sql`SELECT rules FROM aspect_definitions
        WHERE graph_id = ${user} AND id = 'test/rules-probe'`)) as unknown as Array<{
        rules: Array<{ id: string }>;
      }>;
      expect(rows[0]?.rules.map((r) => r.id)).toEqual(['rp_requires']);
    } finally {
      await ac.end();
    }
  });
});

describe('словарь §С8-26: два аспекта test/* и четыре свойства', () => {
  test('оба аспекта и четыре свойства видны снимком; test/caller и test/agreement — рода ref', async () => {
    const user = await freshGraph();
    await seedCustomAspect(user, TEST_CONTACT_ASPECT);
    await seedCustomAspect(user, TEST_CALL_ASPECT);
    const reg = await withIdentity(db, personal(user), (tx) => effectiveRegistry(tx, user));
    for (const id of Object.values(TEST_PROPS)) expect(reg.properties.has(id)).toBe(true);
    // Род `ref` — не украшение: `deref` чекера требует базы рода `ref` (`expr/check.ts:491-494`),
    // и без него правила 1, 2, 5, 7 §Б4-5 не прошли бы валидатор ни при каком сиде.
    expect(reg.properties.get(TEST_PROPS.caller)?.type.kind).toBe('ref');
    expect(reg.properties.get(TEST_PROPS.agreement)?.type.kind).toBe('ref');
    expect(reg.properties.get(TEST_PROPS.contactKind)?.type.kind).toBe('select');
    expect(reg.properties.get(TEST_PROPS.knownContact)?.type.kind).toBe('boolean');
  });
});

describe('мир §С8-26', () => {
  let world: TestWorld;
  beforeAll(async () => {
    await truncateAll();
    await seedCustomAspect(owner, TEST_CONTACT_ASPECT);
    await seedCustomAspect(owner, TEST_CALL_ASPECT);
    await seedCustomRole(owner, TEST_ROLE_PARTICIPANT);
    world = await seedTestWorld(owner);
  });
  test('в мире есть цели всех одиннадцати правил §Б4-5', async () => {
    const rows = (await withIdentity(db, personal(owner), (tx) =>
      tx.execute(sql`SELECT id FROM entities WHERE graph_id = ${owner}::uuid`),
    )) as unknown as Array<{ id: string }>;
    const ids = new Set(rows.map((r) => r.id));
    // Поля мира — либо даты (`today`, `month`), либо id сущностей; фильтр по форме uuid отделяет
    // одно от другого, и добавленное позже поле-id проверяется САМО, без правки этого теста.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const seeded = Object.values(world).filter((v) => UUID_RE.test(String(v)));
    expect(seeded.length).toBe(15); // точное число: потерянное поле не должно молчать
    for (const id of seeded) expect(`${id}: ${ids.has(String(id))}`).toBe(`${id}: true`);
  });
  test('deref правил 1/5/7 находит цель: у звонка есть живой звонящий с тегами и полями', async () => {
    const rows = (await withIdentity(db, personal(owner), (tx) =>
      tx.execute(
        sql`SELECT c.tags AS tags, c.props ->> ${TEST_PROPS.contactKind} AS kind
            FROM entities e JOIN entities c ON c.id = (e.props ->> ${TEST_PROPS.caller})::uuid
           WHERE e.id = ${world.callCourierId}::uuid`,
      ),
    )) as unknown as Array<{ tags: string[]; kind: string }>;
    expect(rows[0]?.kind).toBe('courier');
    // Рутина импорта посеяна ровно под тем id, который называет `actor` правила 6.
    expect(world.routineId).toBe(TEST_IMPORT_ROUTINE_ID);
  });
  test('рёбра: participant ВХОДИТ в событие (Р-И-7), envelope-binding поставил хук', async () => {
    const rows = (await withIdentity(db, personal(owner), (tx) =>
      tx.execute(
        // У `relations` своей колонки `graph_id` нет: графом ребро скоупится ЧЕРЕЗ КОНЦЫ
        // (политика `current_graph_select`, 0021_graph_rls.sql), и отбор идёт тем же джойном.
        sql`SELECT r.role, r.source_id, r.target_id FROM relations r
              JOIN entities e ON e.id = r.source_id
             WHERE e.graph_id = ${owner}::uuid
               AND r.role IN (${TEST_ROLE_PARTICIPANT_KEY}, 'envelope-binding')`,
      ),
    )) as unknown as Array<{ role: string; source_id: string; target_id: string }>;
    // Участник — ИСТОЧНИК, событие — ЦЕЛЬ; у второго события ребра нет, иначе правила 8a и 8b
    // дали бы один ответ на обеих записях.
    expect(rows.filter((r) => r.role === TEST_ROLE_PARTICIPANT_KEY)).toEqual([
      {
        role: TEST_ROLE_PARTICIPANT_KEY,
        source_id: world.contactFamilyId,
        target_id: world.eventSharedId,
      },
    ]);
    // Привязка к конверту — правила 4 и 9 читают настоящую величину, а не выдуманную.
    expect(
      rows.some(
        (r) =>
          r.role === 'envelope-binding' &&
          r.source_id === world.envelopeId &&
          r.target_id === world.smallSpendId,
      ),
    ).toBe(true);
    // ОСТАТОК КОНВЕРТА СЧИТАЕТСЯ ЧИСЛОМ, А НЕ ОБЕЩАЕТСЯ КОММЕНТАРИЕМ (Ф-Б2-10). Хук привязывает
    // к конверту ВСЕ четыре расхода мира, и при прежнем лимите 20000 остаток был отрицателен —
    // `remaining >= amount` правила 4 и `amount <= remaining` правила 9 были ложны на каждой
    // записи, а мир молча обещал обратное. Предикат — тот же, что у агрегата
    // (`budget/aggregates.ts` spentByEnvelope): сумма привязанных `expense`, не шаблонов
    // повторения, не плановых, с `occurred_on <= today`. Арифметика — в numeric постгреса, а не
    // в JS: decimal здесь строка (§Б3), и сравнивать его через float нельзя.
    const [budget] = (await withIdentity(db, personal(owner), (tx) =>
      tx.execute(sql`
        WITH spent AS (
          SELECT coalesce(sum((e.props->>'orbis/amount')::numeric), 0) AS total
            FROM relations r
            JOIN entities e ON e.id = r.target_id
           WHERE r.role = 'envelope-binding' AND r.source_id = ${world.envelopeId}::uuid
             AND e.graph_id = ${owner}::uuid AND NOT e.archived
             AND 'orbis/financial' = ANY(e.aspects)
             AND NOT ('orbis/schedule' = ANY(e.aspects) AND e.props->'orbis/recurrence' IS NOT NULL)
             AND e.props->>'orbis/direction' = 'expense'
             AND coalesce((e.props->>'orbis/planned')::boolean, false) = false
             AND (e.props->>'orbis/occurred_on') <= ${world.today}
        )
        SELECT ((env.props->>'orbis/limit')::numeric - spent.total)::text AS remaining,
               (small.props->>'orbis/amount') AS small_amount,
               (big.props->>'orbis/amount') AS big_amount,
               ((env.props->>'orbis/limit')::numeric - spent.total)
                 >= (small.props->>'orbis/amount')::numeric AS small_fits,
               ((env.props->>'orbis/limit')::numeric - spent.total)
                 < (big.props->>'orbis/amount')::numeric AS big_over
          FROM spent, entities env, entities small, entities big
         WHERE env.id = ${world.envelopeId}::uuid
           AND small.id = ${world.smallSpendId}::uuid
           AND big.id = ${world.bigSpendId}::uuid`),
    )) as unknown as Array<{
      remaining: string;
      small_amount: string;
      big_amount: string;
      small_fits: boolean;
      big_over: boolean;
    }>;
    // Пин стережёт ОБЕ стороны: позитив правил 4 и 9 на мелком расходе и их негатив на крупном —
    // правило, истинное на каждой записи, приёмку §С8-26 не прошло бы.
    expect(
      `остаток ${budget?.remaining}: мелкий ${budget?.small_amount} входит — ${budget?.small_fits}`,
    ).toBe(`остаток ${budget?.remaining}: мелкий ${budget?.small_amount} входит — true`);
    expect(
      `остаток ${budget?.remaining}: крупный ${budget?.big_amount} не входит — ${budget?.big_over}`,
    ).toBe(`остаток ${budget?.remaining}: крупный ${budget?.big_amount} не входит — true`);
  });
});
