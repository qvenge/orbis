// apps/server/src/rules/engine.test.ts
// ДВИЖОК КАТАЛОГА ПРАВИЛ НА ИСПОЛНЕНИИ (§С8-25): каждый исполняемый шаблон — позитив и негатив, через
// исполнитель на боевых путях записи (create / update / attach), на аспектах ВЛАДЕЛЬЦА из фикстуры
// гейта §С8-18. Аспекты фикстуры НЕ мутируются: правила подмешиваются копией спека
// (`{ ...GATE_FIN_ASPECT, rules }`), и каждый мир — свой граф, чтобы строки правил одного сценария не
// попадали в снимок соседнего.
//
// Токены гейта в этом файле не пишутся ни в коде, ни в заголовках (сторож `gate-c8-18.test.ts` смотрит
// всё под `src/`): свойства адресуются только ключами `GATE_PROPS.*`.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { attachToolName, type GraphId, type RuleDefinitionInput } from '@orbis/shared';
import { GATE_FIN_ASPECT, GATE_PLAIN_ASPECT, GATE_PROPS } from '../../test/fixtures/gate-aspects';
import {
  appDb,
  type CustomAspectSpec,
  freshGraph,
  personal,
  requireEnv,
  seedCustomAspect,
  truncateAll,
} from '../../test/helpers';
import { execute } from '../executor/executor';
import type { ExecuteResult, JournalSink, WireEntity } from '../executor/types';

requireEnv();

const { db, client } = appDb();
beforeAll(async () => {
  await truncateAll();
});
afterAll(async () => {
  await client.end();
});

const T0 = new Date('2026-07-04T10:00:00.000Z');
const AT = '2026-07-04T12:00:00.000Z';
const FIN = GATE_FIN_ASPECT.key;
const PLAIN = GATE_PLAIN_ASPECT.key;

/** Мир одного сценария: свой граф, аспекты владельца со строками правил, категория для ссылки. */
interface World {
  graph: GraphId;
  run(tool: string, input: Record<string, unknown>, sink?: JournalSink): Promise<ExecuteResult>;
  /** Трата владельца: все обязательные поля аспекта + переданные поверх. */
  mk(props: Record<string, unknown>, extra?: Record<string, unknown>): Promise<ExecuteResult>;
  categoryId: string;
}

async function worldWith(...specs: CustomAspectSpec[]): Promise<World> {
  const graph = await freshGraph();
  for (const spec of specs) await seedCustomAspect(graph, spec);
  const run = (tool: string, input: Record<string, unknown>, sink?: JournalSink) =>
    execute(
      db,
      {
        identity: personal(graph),
        actorKind: 'owner',
        source: 'ui',
        operations: [{ tool, input }],
        clock: () => T0,
      },
      sink === undefined ? {} : { sink },
    );
  const category = await run('entity_create', {
    title: 'Категория правил',
    tags: [],
    aspects: ['orbis/category'],
  });
  const categoryId = entityOf(category).id;
  const mk = (props: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    run('entity_create', {
      title: 'Трата владельца',
      tags: [],
      aspects: [FIN],
      props: {
        [GATE_PROPS.finAmount]: '340.00',
        [GATE_PROPS.finDirection]: 'out',
        [GATE_PROPS.finCategory]: categoryId,
        [GATE_PROPS.finDate]: '2026-07-04',
        ...props,
      },
      ...extra,
    });
  return { graph, run, mk, categoryId };
}

function entityOf(r: ExecuteResult): WireEntity {
  if (!r.ok)
    throw new Error(`ожидался успех исполнителя, пришёл отказ: ${JSON.stringify(r.error)}`);
  return r.results[0] as WireEntity;
}

/** Отказ исполнителя в форме «код + invariant + причина» — одна строка на сравнение. */
function refusalOf(r: ExecuteResult): string {
  if (r.ok) return 'ok';
  const d = (r.error.details ?? {}) as { invariant?: string; reason?: string };
  return `${r.error.code}/${d.invariant ?? d.reason ?? '-'}`;
}

const RULE_WHEN_DONE: RuleDefinitionInput = {
  id: 'gate_fin_requires_when',
  template: 'requires_when',
  undo: 'check',
  when: { op: '=', args: [{ prop: GATE_PROPS.finState }, { const: 'done' }] },
  params: { property: GATE_PROPS.finWhen },
};

describe('requires_when — C-правило на трёх путях записи', () => {
  let w: World;
  const mk = (props: Record<string, unknown>) => w.mk(props);
  beforeAll(async () => {
    w = await worldWith({ ...GATE_FIN_ASPECT, rules: [RULE_WHEN_DONE] });
  });

  test('requires_when: свойство обязательно, когда условие истинно (§Б4-3: позитив и негатив)', async () => {
    expect((await mk({ [GATE_PROPS.finState]: 'todo' })).ok).toBe(true); // условие ложно
    const bad = await mk({ [GATE_PROPS.finState]: 'done' }); // истинно, свойства нет
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.code).toBe('INVARIANT');
      expect((bad.error.details as { invariant?: string }).invariant).toBe(
        'gate_fin_requires_when',
      );
    }
    expect((await mk({ [GATE_PROPS.finState]: 'done', [GATE_PROPS.finWhen]: AT })).ok).toBe(true);
  });

  test('отказ несёт шаблон, свойство и область правила (§1.5, Р-К-1)', async () => {
    const bad = await mk({ [GATE_PROPS.finState]: 'done' });
    expect(bad.ok ? null : bad.error.details).toEqual({
      invariant: 'gate_fin_requires_when',
      rule_template: 'requires_when',
      property: GATE_PROPS.finWhen,
      scope: { aspect: FIN },
    });
  });

  test('entity_update: переход в done без свойства — отказ, со свойством — проходит', async () => {
    const row = entityOf(await mk({ [GATE_PROPS.finState]: 'todo' }));
    const refused = await w.run('entity_update', {
      id: row.id,
      props: { [GATE_PROPS.finState]: 'done' },
    });
    expect(refusalOf(refused)).toBe('INVARIANT/gate_fin_requires_when');
    const passed = await w.run('entity_update', {
      id: row.id,
      props: { [GATE_PROPS.finState]: 'done', [GATE_PROPS.finWhen]: AT },
    });
    expect(refusalOf(passed)).toBe('ok');
  });

  test('attach: навешивание аспекта в состоянии done без свойства — отказ, со свойством — проходит', async () => {
    const bare = entityOf(await w.run('entity_create', { title: 'Голая запись', tags: [] }));
    const data = {
      [GATE_PROPS.finAmount]: '340.00',
      [GATE_PROPS.finDirection]: 'out',
      [GATE_PROPS.finCategory]: w.categoryId,
      [GATE_PROPS.finDate]: '2026-07-04',
      [GATE_PROPS.finState]: 'done',
    };
    const refused = await w.run(attachToolName(FIN), { entity_id: bare.id, data });
    expect(refusalOf(refused)).toBe('INVARIANT/gate_fin_requires_when');
    const passed = await w.run(attachToolName(FIN), {
      entity_id: bare.id,
      data: { ...data, [GATE_PROPS.finWhen]: AT },
    });
    expect(refusalOf(passed)).toBe('ok');
  });
});

describe('параметры движка лениво — {param: default_currency} (Р-И-18)', () => {
  const CURRENCY_DEFAULT: RuleDefinitionInput = {
    id: 'gate_fin_currency_default',
    template: 'default',
    undo: 'check',
    params: { property: 'orbis/currency', value: { param: 'default_currency' } },
  };
  test('запись без валюты получает валюту владельца, запись с валютой её сохраняет', async () => {
    const w = await worldWith({
      ...GATE_FIN_ASPECT,
      carries: ['orbis/currency'],
      rules: [CURRENCY_DEFAULT],
    });
    // Строки `user_settings` у графа теста нет — `defaultCurrencyOf` отдаёт фолбэк схемы.
    const absent = entityOf(await w.mk({}));
    expect(absent.props['orbis/currency']).toBe('RUB');
    const given = entityOf(await w.mk({ 'orbis/currency': 'USD' }));
    expect(given.props['orbis/currency']).toBe('USD');
  });
});
