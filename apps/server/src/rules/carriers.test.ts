// apps/server/src/rules/carriers.test.ts
// Строки-носители: параметры движков живут в реестре, движки их читают. Тест — на НАСТОЯЩЕМ
// снимке (сид прогнан `db:prepare`): читатель, зелёный на выдуманном реестре, ничего не значит.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { appDb, freshGraph, personal, requireEnv } from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import { effectiveRegistry } from '../registry/cache';
import { materializeRuleOf, mirrorRuleOf, nearestAncestorRuleOf, rolloverRuleOf } from './carriers';

requireEnv();
const { db, client } = appDb();
afterAll(async () => {
  await client.end();
});

describe('строки-носители параметров (§Б4-3, Р-14)', () => {
  let reg: Awaited<ReturnType<typeof effectiveRegistry>>;
  beforeAll(async () => {
    const user = await freshGraph();
    reg = await withIdentity(db, personal(user), (tx) => effectiveRegistry(tx, user));
  });

  test('nearest_ancestor: цели и кап глубины — из строки на orbis/project', () => {
    const { rule, aspectId } = nearestAncestorRuleOf(reg);
    expect(aspectId).toBe('orbis/project');
    expect(rule.params).toEqual({
      targets: { parent: 'orbis/parent_project', root: 'orbis/root_project' },
      depth_cap: 32,
    });
  });

  test('materialize: горизонт, ретро-пол, триггеры, наследование и своё — из строки на orbis/schedule', () => {
    const { rule, aspectId } = materializeRuleOf(reg);
    expect(aspectId).toBe('orbis/schedule');
    expect(rule.params.horizon_days).toBe(14);
    expect(rule.params.retro_days).toBe(92);
    expect(rule.params.trigger_properties).toEqual([
      'orbis/start_at',
      'orbis/due_date',
      'orbis/occurred_on',
    ]);
    expect(rule.params.inherit['orbis/financial']).toContain('orbis/amount');
    expect(rule.params.own['orbis/occurred_on']).toBe('instance_date');
    expect(rule.params.origin_role).toBe('instance-of');
  });

  test('mirror_relation: ключ меты и пропуск вычисляемых — из строки на роли ref', () => {
    expect(mirrorRuleOf(reg).params).toEqual({ meta_key: 'property', skip_computed: true });
  });

  test('rollover: источник и переносимая величина — из строки на orbis/budget', () => {
    expect(rolloverRuleOf(reg).params).toEqual({
      source: 'exact_calendar_month',
      carry: { agg: 'remaining' },
    });
  });

  test('строки нет или она выключена → Error сборки, а не умолчание', () => {
    const empty = { ...reg, aspects: new Map(), roles: new Map() } as typeof reg;
    expect(() => materializeRuleOf(empty)).toThrow(/materialize/);
    expect(() => rolloverRuleOf(empty)).toThrow(/rollover/);
    expect(() => nearestAncestorRuleOf(empty)).toThrow(/nearest_ancestor/);
    expect(() => mirrorRuleOf(empty)).toThrow(/mirror_relation/);
    // Строка на месте, но ВЫКЛЮЧЕНА: для движка это то же «нечем работать» — второго, молчаливого
    // исхода «работаю по прежним числам» у читателя нет.
    const off = <T extends { rules: readonly { enabled: boolean }[] }>(m: Map<string, T>) =>
      new Map(
        [...m].map(([id, row]) => [
          id,
          { ...row, rules: row.rules.map((r) => ({ ...r, enabled: false })) },
        ]),
      );
    const disabled = { ...reg, aspects: off(reg.aspects), roles: off(reg.roles) } as typeof reg;
    expect(() => materializeRuleOf(disabled)).toThrow(
      /нет включённой строки правила «materialize»/,
    );
    expect(() => mirrorRuleOf(disabled)).toThrow(/нет включённой строки правила «mirror_relation»/);
  });

  test('два включённых носителя одного шаблона → Error сборки: у движка один горизонт', () => {
    const schedule = reg.aspects.get('orbis/schedule');
    const task = reg.aspects.get('orbis/task');
    if (schedule === undefined || task === undefined) throw new Error('встроенных аспектов нет');
    const twice = {
      ...reg,
      aspects: new Map([
        ...reg.aspects,
        ['orbis/task', { ...task, rules: [...task.rules, ...schedule.rules] }],
      ]),
    } as typeof reg;
    expect(() => materializeRuleOf(twice)).toThrow(
      /orbis\/schedule, orbis\/task|orbis\/task, orbis\/schedule/,
    );
  });
});
