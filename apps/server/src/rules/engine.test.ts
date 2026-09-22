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
import {
  attachToolName,
  type GraphId,
  newId,
  ROLE_DEPENDENCY,
  type RuleDefinitionInput,
} from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { GATE_FIN_ASPECT, GATE_PLAIN_ASPECT, GATE_PROPS } from '../../test/fixtures/gate-aspects';
import {
  adminDb,
  appDb,
  type CustomAspectSpec,
  freshGraph,
  personal,
  requireEnv,
  seedCustomAspect,
  truncateAll,
} from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import { ExecError } from '../errors';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { ExecuteOk, ExecuteResult, JournalSink, WireEntity } from '../executor/types';
import { undoAction } from '../executor/undo';
import { effectiveRegistry } from '../registry/cache';
import { assertConstraintRules } from './engine';

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

describe('режим отката — по ЭКЗЕМПЛЯРУ правила, а не по шаблону (Р-И-2)', () => {
  // Состояние «до» операции нарушает правило: запись заведена ДО того, как правило легло в реестр
  // (иначе исполнитель такую запись не пропустил бы вовсе). Операция — законное снятие свойства;
  // её откат восстанавливает нарушающее состояние, и вердикт решает поле `undo` экземпляра.
  const forbidVoidMoment = (undo: 'check' | 'skip'): RuleDefinitionInput => ({
    id: `gate_fin_void_moment_${undo}`,
    template: 'forbidden_when',
    undo,
    when: { op: '=', args: [{ prop: GATE_PROPS.finState }, { const: 'void' }] },
    params: { property: GATE_PROPS.finWhen },
  });
  async function undoOfUnset(undo: 'check' | 'skip'): Promise<ExecuteResult> {
    const w = await worldWith(GATE_FIN_ASPECT);
    const row = entityOf(await w.mk({ [GATE_PROPS.finState]: 'void', [GATE_PROPS.finWhen]: AT }));
    await seedCustomAspect(w.graph, { ...GATE_FIN_ASPECT, rules: [forbidVoidMoment(undo)] });
    const sink = makeChatJournalSink(); // undo ищет действие в журнале — NOOP_SINK ему не годится
    const unset = await w.run('entity_update', { id: row.id, unset: [GATE_PROPS.finWhen] }, sink);
    expect(refusalOf(unset)).toBe('ok'); // после снятия правило не нарушено
    return undoAction(db, { identity: personal(w.graph), actionId: (unset as ExecuteOk).actionId });
  }
  test("undo: 'skip' — откат в нарушающее состояние проходит", async () => {
    const undone = await undoOfUnset('skip');
    expect(refusalOf(undone)).toBe('ok');
    expect(entityOf(undone).props[GATE_PROPS.finWhen]).toBe(AT);
  });
  test("undo: 'check' — тот же откат отклонён INVARIANT с id правила", async () => {
    expect(refusalOf(await undoOfUnset('check'))).toBe('INVARIANT/gate_fin_void_moment_check');
  });
});

describe('fail-closed: область «контракт» и шаблон unique_among (Р-25, РЧ-3-2)', () => {
  test('scope {contract}: на записи-члене — VALIDATION RULE_SCOPE_UNSUPPORTED, на нечлене — молчит', async () => {
    const w = await worldWith({
      ...GATE_FIN_ASPECT,
      rules: [
        {
          id: 'gate_fin_contract_scope',
          template: 'requires_when',
          undo: 'check',
          scope: { contract: 'orbis/completable' },
          params: { property: GATE_PROPS.finWhen },
        },
      ],
    });
    expect(refusalOf(await w.mk({ [GATE_PROPS.finState]: 'todo' }))).toBe(
      'VALIDATION/RULE_SCOPE_UNSUPPORTED',
    );
    // Нечлен контракта (категория мира заведена так же — `worldWith`) правило не касается.
    expect(refusalOf(await w.run('entity_create', { title: 'Нечлен', tags: [] }))).toBe('ok');
  });
  test('unique_among до задачи 12: включённое правило — отказ RULE_TEMPLATE_UNSUPPORTED, а не пропуск', async () => {
    const w = await worldWith({
      ...GATE_FIN_ASPECT,
      rules: [
        {
          id: 'gate_fin_unique_amount',
          template: 'unique_among',
          undo: 'check',
          params: { properties: [GATE_PROPS.finAmount] },
        },
      ],
    });
    expect(refusalOf(await w.mk({}))).toBe('VALIDATION/RULE_TEMPLATE_UNSUPPORTED');
    // Запись без аспекта-носителя области правило не касается.
    expect(refusalOf(await w.run('entity_create', { title: 'Нечлен', tags: [] }))).toBe('ok');
  });
});

describe('forbidden_when — свойство запрещено при истинном условии (§Б4-3)', () => {
  const RULE_VOID_NO_MOMENT: RuleDefinitionInput = {
    id: 'gate_fin_forbidden_when',
    template: 'forbidden_when',
    undo: 'check',
    when: { op: '=', args: [{ prop: GATE_PROPS.finState }, { const: 'void' }] },
    params: { property: GATE_PROPS.finWhen },
  };
  let w: World;
  beforeAll(async () => {
    w = await worldWith({ ...GATE_FIN_ASPECT, rules: [RULE_VOID_NO_MOMENT] });
  });
  test('условие истинно и свойство есть — отказ с id правила; без свойства — проходит', async () => {
    const bad = await w.mk({ [GATE_PROPS.finState]: 'void', [GATE_PROPS.finWhen]: AT });
    expect(refusalOf(bad)).toBe('INVARIANT/gate_fin_forbidden_when');
    expect(bad.ok ? null : (bad.error.details as { rule_template?: string }).rule_template).toBe(
      'forbidden_when',
    );
    const row = entityOf(await w.mk({ [GATE_PROPS.finState]: 'void' }));
    expect(row.props[GATE_PROPS.finWhen]).toBeUndefined();
  });
  test('условие ложно — свойство законно', async () => {
    const row = entityOf(await w.mk({ [GATE_PROPS.finState]: 'todo', [GATE_PROPS.finWhen]: AT }));
    expect(row.props[GATE_PROPS.finWhen]).toBe(AT);
  });
});

/** Строка владельца «запись закрыта» по КЛАССУ: вход в done ставит момент закрытия, уход снимает. */
const RULE_PLAIN_CLOSED_AT: RuleDefinitionInput = {
  id: 'gate_plain_closed_at',
  template: 'on_enter_class',
  undo: 'check',
  params: {
    enter: { contract: 'orbis/completable', slot: 'status', in: ['done'] },
    set: { property: GATE_PROPS.plainAt, value: { prop: 'orbis/updated_at' } },
    on_leave: { unset: [GATE_PROPS.plainAt] },
  },
};

describe('on_enter_class по КЛАССУ — T-правило на трёх путях записи', () => {
  let w: World;
  const item = (state: string) =>
    w.run('entity_create', {
      title: 'Дело владельца',
      tags: [],
      aspects: [PLAIN],
      props: { [GATE_PROPS.plainState]: state },
    });
  const setState = (id: string, state: string) =>
    w.run('entity_update', { id, props: { [GATE_PROPS.plainState]: state } });
  beforeAll(async () => {
    w = await worldWith({ ...GATE_PLAIN_ASPECT, rules: [RULE_PLAIN_CLOSED_AT] });
  });

  test('update: open→closed ставит момент = штамп записи, closed→open снимает (on_leave)', async () => {
    const opened = entityOf(await item('open'));
    expect(opened.props[GATE_PROPS.plainAt]).toBeUndefined(); // в класс не входила
    const closed = entityOf(await setState(opened.id, 'closed'));
    // Штамп записи на update — `monotonicUpdatedAt`: при одном тике часов это T0+1ms, а не T0
    // (Р-И-3) — сравнение идёт со штампом СТРОКИ, а не с часами теста.
    expect(closed.updatedAt).not.toBe(T0.toISOString());
    expect(closed.props[GATE_PROPS.plainAt]).toBe(closed.updatedAt);
    const reopened = entityOf(await setState(opened.id, 'open'));
    expect(reopened.props[GATE_PROPS.plainAt]).toBeUndefined();
  });

  test('create: запись, рождённая в классе, входит в него на создании', async () => {
    const row = entityOf(await item('closed'));
    expect(row.props[GATE_PROPS.plainAt]).toBe(row.updatedAt);
  });

  test('attach: навешивание аспекта в классе done — тот же переход', async () => {
    const bare = entityOf(await w.run('entity_create', { title: 'Голая запись', tags: [] }));
    const row = entityOf(
      await w.run(attachToolName(PLAIN), {
        entity_id: bare.id,
        data: { [GATE_PROPS.plainState]: 'closed' },
      }),
    );
    expect(row.props[GATE_PROPS.plainAt]).toBe(row.updatedAt);
  });

  test('значение, пришедшее патчем, правило не перетирает (РЧ-3-3)', async () => {
    const opened = entityOf(await item('open'));
    const closed = entityOf(
      await w.run('entity_update', {
        id: opened.id,
        props: { [GATE_PROPS.plainState]: 'closed', [GATE_PROPS.plainAt]: AT },
      }),
    );
    expect(closed.props[GATE_PROPS.plainAt]).toBe(AT);
  });
});

describe('порядок T-правил на одном переходе: уход раньше входа (рулинг 1-3)', () => {
  // Пара, которую ключ `RULE_CONFLICT` не ловит: «set при входе в done» и «unset при уходе из active»
  // ОДНОГО свойства — обе срабатывают на переходе active→done. id подобраны так, что обход единым
  // списком по (носитель, id) исполнил бы set ПЕРВЫМ, а unset — следом и стёр бы его.
  const ENTER_DONE_SETS: RuleDefinitionInput = {
    id: 'a_enter_done_sets',
    template: 'on_enter_class',
    undo: 'check',
    params: {
      enter: { contract: 'orbis/completable', slot: 'status', in: ['done'] },
      set: { property: GATE_PROPS.plainAt, value: { prop: 'orbis/updated_at' } },
    },
  };
  const LEAVE_ACTIVE_UNSETS: RuleDefinitionInput = {
    id: 'b_leave_active_unsets',
    template: 'on_enter_class',
    undo: 'check',
    params: {
      enter: { contract: 'orbis/completable', slot: 'status', in: ['active'] },
      on_leave: { unset: [GATE_PROPS.plainAt] },
    },
  };
  test('переход active→done: свойство установлено — вход побеждает уход', async () => {
    const w = await worldWith({
      ...GATE_PLAIN_ASPECT,
      rules: [ENTER_DONE_SETS, LEAVE_ACTIVE_UNSETS],
    });
    const opened = entityOf(
      await w.run('entity_create', {
        title: 'Дело на переходе',
        tags: [],
        aspects: [PLAIN],
        props: { [GATE_PROPS.plainState]: 'open' },
      }),
    );
    const closed = entityOf(
      await w.run('entity_update', {
        id: opened.id,
        props: { [GATE_PROPS.plainState]: 'closed' },
      }),
    );
    expect(closed.props[GATE_PROPS.plainAt]).toBe(closed.updatedAt);
  });
});

describe('on_enter_class по ЗНАЧЕНИЮ свойства (форма {property, in}, Р-И-37)', () => {
  const RULE_BY_VALUE: RuleDefinitionInput = {
    id: 'gate_plain_closed_by_value',
    template: 'on_enter_class',
    undo: 'check',
    params: {
      enter: { property: GATE_PROPS.plainState, in: ['closed'] },
      set: { property: GATE_PROPS.plainAt, value: { prop: 'orbis/updated_at' } },
      on_leave: { unset: [GATE_PROPS.plainAt] },
    },
  };
  test('значение вошло в список — свойство поставлено; не вошло — нет; ушло — снято', async () => {
    const w = await worldWith({ ...GATE_PLAIN_ASPECT, rules: [RULE_BY_VALUE] });
    const mkItem = (state: string) =>
      w.run('entity_create', {
        title: 'Дело по значению',
        tags: [],
        aspects: [PLAIN],
        props: { [GATE_PROPS.plainState]: state },
      });
    const closed = entityOf(await mkItem('closed'));
    expect(closed.props[GATE_PROPS.plainAt]).toBe(closed.updatedAt);
    const opened = entityOf(await mkItem('open'));
    expect(opened.props[GATE_PROPS.plainAt]).toBeUndefined();
    const reopened = entityOf(
      await w.run('entity_update', { id: closed.id, props: { [GATE_PROPS.plainState]: 'open' } }),
    );
    expect(reopened.props[GATE_PROPS.plainAt]).toBeUndefined();
  });
});

describe('on_enter_class с when — срабатывает только на подмножестве (§С8-25)', () => {
  const RULE_BIG_DONE: RuleDefinitionInput = {
    id: 'gate_fin_big_done_at',
    template: 'on_enter_class',
    undo: 'check',
    when: { op: '>', args: [{ prop: GATE_PROPS.finAmount }, { const: '1000' }] },
    params: {
      enter: { contract: 'orbis/completable', slot: 'status', in: ['done'] },
      set: { property: GATE_PROPS.finWhen, value: { prop: 'orbis/updated_at' } },
    },
  };
  test('две записи входят в done, момент получает только крупная', async () => {
    const w = await worldWith({ ...GATE_FIN_ASPECT, rules: [RULE_BIG_DONE] });
    const big = entityOf(
      await w.mk({ [GATE_PROPS.finAmount]: '1500.00', [GATE_PROPS.finState]: 'done' }),
    );
    const small = entityOf(
      await w.mk({ [GATE_PROPS.finAmount]: '340.00', [GATE_PROPS.finState]: 'done' }),
    );
    expect(big.props[GATE_PROPS.finWhen]).toBe(big.updatedAt);
    expect(small.props[GATE_PROPS.finWhen]).toBeUndefined();
  });
});

describe('default — умолчание записи без when и с when (§Б4-3)', () => {
  const STATE_DEFAULT: RuleDefinitionInput = {
    id: 'gate_fin_state_default',
    template: 'default',
    undo: 'check',
    params: { property: GATE_PROPS.finState, value: { const: 'todo' } },
  };
  const INFLOW_MOMENT_DEFAULT: RuleDefinitionInput = {
    id: 'gate_fin_inflow_moment',
    template: 'default',
    undo: 'check',
    when: { op: '=', args: [{ prop: GATE_PROPS.finDirection }, { const: 'in' }] },
    params: { property: GATE_PROPS.finWhen, value: { prop: 'orbis/updated_at' } },
  };
  let w: World;
  beforeAll(async () => {
    w = await worldWith({ ...GATE_FIN_ASPECT, rules: [STATE_DEFAULT, INFLOW_MOMENT_DEFAULT] });
  });
  test('без when: отсутствующее свойство получает значение, присутствующее — сохраняется', async () => {
    const absent = entityOf(await w.mk({}));
    expect(absent.props[GATE_PROPS.finState]).toBe('todo');
    const given = entityOf(await w.mk({ [GATE_PROPS.finState]: 'done' }));
    expect(given.props[GATE_PROPS.finState]).toBe('done');
  });
  test('без when: и на update — свойство, снятое патчем, возвращается умолчанием', async () => {
    const row = entityOf(await w.mk({ [GATE_PROPS.finState]: 'done' }));
    const after = entityOf(
      await w.run('entity_update', { id: row.id, unset: [GATE_PROPS.finState] }),
    );
    expect(after.props[GATE_PROPS.finState]).toBe('todo');
  });
  test('с when: умолчание только там, где условие истинно', async () => {
    const inflow = entityOf(await w.mk({ [GATE_PROPS.finDirection]: 'in' }));
    expect(inflow.props[GATE_PROPS.finWhen]).toBe(inflow.updatedAt);
    const outflow = entityOf(await w.mk({ [GATE_PROPS.finDirection]: 'out' }));
    expect(outflow.props[GATE_PROPS.finWhen]).toBeUndefined();
  });
});

describe('has_relation в when — рёбра $self предзагружены до вычисления (Р-И-7)', () => {
  // Правило читает входящее ребро роли: запись, которую что-то блокирует, обязана нести момент.
  const RULE_BLOCKED_NEEDS_MOMENT: RuleDefinitionInput = {
    id: 'gate_plain_blocked_moment',
    template: 'requires_when',
    undo: 'check',
    when: { has_relation: { role: ROLE_DEPENDENCY, alive: true } },
    params: { property: GATE_PROPS.plainAt },
  };
  test('без входящего ребра — проходит; с живым блокером — отказ; блокер в архиве — снова проходит', async () => {
    const w = await worldWith({ ...GATE_PLAIN_ASPECT, rules: [RULE_BLOCKED_NEEDS_MOMENT] });
    const target = entityOf(
      await w.run('entity_create', {
        title: 'Заблокированное дело',
        tags: [],
        aspects: [PLAIN],
        props: { [GATE_PROPS.plainState]: 'open' },
      }),
    );
    const blocker = entityOf(await w.run('entity_create', { title: 'Блокер', tags: [] }));
    const touch = () =>
      w.run('entity_update', { id: target.id, props: { [GATE_PROPS.plainState]: 'open' } });
    expect(refusalOf(await touch())).toBe('ok');
    const edge = await w.run('relation_create', {
      source_id: blocker.id,
      target_id: target.id,
      role: ROLE_DEPENDENCY,
    });
    expect(refusalOf(edge)).toBe('ok');
    expect(refusalOf(await touch())).toBe('INVARIANT/gate_plain_blocked_moment');
    expect(refusalOf(await w.run('entity_update', { id: blocker.id, archived: true }))).toBe('ok');
    expect(refusalOf(await touch())).toBe('ok'); // `alive` — «источник не архивен»
  });
});

// ─────────────────────────── фикс-раунд 1 ревью задачи 3 ───────────────────────────

/** Пачка операций одним вызовом исполнителя (§7.8): эффекты 1..N−1 видны операции N. */
function batchOf(w: World, operations: Array<{ tool: string; input: Record<string, unknown> }>) {
  return execute(db, {
    identity: personal(w.graph),
    actorKind: 'owner',
    source: 'ui',
    operations,
    batchId: newId(),
    clock: () => T0,
  });
}

describe('рёбра и архивность из ПАЧКИ в has_relation (Р-И-7, ревью I-1b/I-3)', () => {
  const RULE_BLOCKED: RuleDefinitionInput = {
    id: 'gate_plain_blocked_in_batch',
    template: 'requires_when',
    undo: 'check',
    when: { has_relation: { role: ROLE_DEPENDENCY, alive: true } },
    params: { property: GATE_PROPS.plainAt },
  };
  let w: World;
  const edge = (source: string, target: string) => ({
    source_id: source,
    target_id: target,
    role: ROLE_DEPENDENCY,
  });
  const touch = (id: string) => ({
    tool: 'entity_update',
    input: { id, props: { [GATE_PROPS.plainState]: 'open' } },
  });
  async function pair(): Promise<{ target: string; blocker: string }> {
    const target = entityOf(
      await w.run('entity_create', {
        title: 'Цель',
        tags: [],
        aspects: [PLAIN],
        props: { [GATE_PROPS.plainState]: 'open' },
      }),
    ).id;
    const blocker = entityOf(await w.run('entity_create', { title: 'Блокер', tags: [] })).id;
    return { target, blocker };
  }
  beforeAll(async () => {
    w = await worldWith({ ...GATE_PLAIN_ASPECT, rules: [RULE_BLOCKED] });
  });

  test('пачка [relation_create, entity_update] — ребро пачки видно, отказ', async () => {
    const { target, blocker } = await pair();
    const r = await batchOf(w, [
      { tool: 'relation_create', input: edge(blocker, target) },
      touch(target),
    ]);
    expect(refusalOf(r)).toBe('INVARIANT/gate_plain_blocked_in_batch');
  });
  test('пачка [relation_delete, entity_update] — удалённое пачкой ребро не видно, проходит', async () => {
    const { target, blocker } = await pair();
    expect(refusalOf(await w.run('relation_create', edge(blocker, target)))).toBe('ok');
    const r = await batchOf(w, [
      { tool: 'relation_delete', input: edge(blocker, target) },
      touch(target),
    ]);
    expect(refusalOf(r)).toBe('ok');
  });
  test('пачка «архивировать блокер; тронуть цель» — тот же вердикт, что по очереди (проходит)', async () => {
    const { target, blocker } = await pair();
    expect(refusalOf(await w.run('relation_create', edge(blocker, target)))).toBe('ok');
    const r = await batchOf(w, [
      { tool: 'entity_update', input: { id: blocker, archived: true } },
      touch(target),
    ]);
    expect(refusalOf(r)).toBe('ok');
  });
  test('виртуальное ребро от архивного источника — alive по строке источника, проходит', async () => {
    const { target, blocker } = await pair();
    expect(refusalOf(await w.run('entity_update', { id: blocker, archived: true }))).toBe('ok');
    const r = await batchOf(w, [
      { tool: 'relation_create', input: edge(blocker, target) },
      touch(target),
    ]);
    expect(refusalOf(r)).toBe('ok');
  });
  test('пачка «разархивировать блокер; тронуть цель» — живое ребро видно, отказ', async () => {
    const { target, blocker } = await pair();
    expect(refusalOf(await w.run('relation_create', edge(blocker, target)))).toBe('ok');
    expect(refusalOf(await w.run('entity_update', { id: blocker, archived: true }))).toBe('ok');
    const r = await batchOf(w, [
      { tool: 'entity_update', input: { id: blocker, archived: false } },
      touch(target),
    ]);
    expect(refusalOf(r)).toBe('INVARIANT/gate_plain_blocked_in_batch');
  });
});

describe('фазы T: default после входа и ухода (ревью I-1c)', () => {
  const AT_DEFAULT = '2026-01-01T00:00:00.000Z';
  const DEFAULT_AT: RuleDefinitionInput = {
    id: 'gate_plain_default_at',
    template: 'default',
    undo: 'check',
    params: { property: GATE_PROPS.plainAt, value: { const: AT_DEFAULT } },
  };
  const create = (w: World, state: string) =>
    w.run('entity_create', {
      title: 'Дело с умолчанием',
      tags: [],
      aspects: [PLAIN],
      props: { [GATE_PROPS.plainState]: state },
    });
  test('default + set входа на одном свойстве — побеждает set входа', async () => {
    const w = await worldWith({ ...GATE_PLAIN_ASPECT, rules: [RULE_PLAIN_CLOSED_AT, DEFAULT_AT] });
    const row = entityOf(await create(w, 'closed'));
    expect(row.props[GATE_PROPS.plainAt]).toBe(row.updatedAt);
  });
  test('default + on_leave.unset — после ухода умолчание возвращает значение', async () => {
    const LEAVE_DONE_UNSETS: RuleDefinitionInput = {
      id: 'gate_plain_leave_done',
      template: 'on_enter_class',
      undo: 'check',
      params: {
        enter: { contract: 'orbis/completable', slot: 'status', in: ['done'] },
        on_leave: { unset: [GATE_PROPS.plainAt] },
      },
    };
    const w = await worldWith({ ...GATE_PLAIN_ASPECT, rules: [LEAVE_DONE_UNSETS, DEFAULT_AT] });
    const closed = entityOf(await create(w, 'closed'));
    const reopened = entityOf(
      await w.run('entity_update', { id: closed.id, props: { [GATE_PROPS.plainState]: 'open' } }),
    );
    expect(reopened.props[GATE_PROPS.plainAt]).toBe(AT_DEFAULT);
  });
});

describe('присутствие одним правилом в движке (РЧ-3-3, ревью I-1d)', () => {
  test('значение T-правила «отсутствие» свойство не ставит — ни null, ни отказа', async () => {
    const SET_FROM_ABSENT: RuleDefinitionInput = {
      id: 'gate_plain_set_from_absent',
      template: 'on_enter_class',
      undo: 'check',
      params: {
        enter: { contract: 'orbis/completable', slot: 'status', in: ['done'] },
        // Свойство, которого у записи нет: выражение даёт отсутствие.
        set: { property: GATE_PROPS.plainAt, value: { prop: GATE_PROPS.finWhen } },
      },
    };
    const w = await worldWith({ ...GATE_PLAIN_ASPECT, rules: [SET_FROM_ABSENT] });
    const row = entityOf(
      await w.run('entity_create', {
        title: 'Дело без источника значения',
        tags: [],
        aspects: [PLAIN],
        props: { [GATE_PROPS.plainState]: 'closed' },
      }),
    );
    expect(Object.hasOwn(row.props, GATE_PROPS.plainAt)).toBe(false);
  });
  test('null в props — «нет» у requires_when (движок напрямую: исполнитель null не пропускает)', async () => {
    const w = await worldWith({ ...GATE_FIN_ASPECT, rules: [RULE_WHEN_DONE] });
    const outcome = await withIdentity(db, personal(w.graph), async (tx) => {
      const registry = await effectiveRegistry(tx, w.graph);
      const id = newId();
      try {
        await assertConstraintRules({
          ctx: {
            tx,
            registry,
            graphId: w.graph,
            clock: () => T0,
            mechanism: 'user',
            internalUndo: false,
          },
          entityId: id,
          before: { props: {}, aspects: [] },
          state: {
            props: { [GATE_PROPS.finState]: 'done', [GATE_PROPS.finWhen]: null },
            aspects: [FIN],
          },
          patch: {},
          core: { id, title: 'Прямой вызов', archived: false, createdAt: T0, updatedAt: T0 },
        });
        return 'ok';
      } catch (e) {
        if (!(e instanceof ExecError)) throw e;
        return `${e.code}/${(e.details as { invariant?: string }).invariant}`;
      }
    });
    expect(outcome).toBe('INVARIANT/gate_fin_requires_when');
  });
});

describe('C-правила на ЛЮБОМ entity_update — и без props (рулинг Ф-Б2-17, ревью I-2)', () => {
  const archivedIs = (v: boolean) =>
    ({ op: '=', args: [{ prop: 'orbis/archived' }, { const: v }] }) as const;
  test('forbidden_when по orbis/archived: архивация без props — отказ; без свойства — проходит', async () => {
    const FORBID_ARCHIVED_MOMENT: RuleDefinitionInput = {
      id: 'gate_fin_archived_no_moment',
      template: 'forbidden_when',
      undo: 'check',
      when: archivedIs(true),
      params: { property: GATE_PROPS.finWhen },
    };
    const w = await worldWith({ ...GATE_FIN_ASPECT, rules: [FORBID_ARCHIVED_MOMENT] });
    const withMoment = entityOf(await w.mk({ [GATE_PROPS.finWhen]: AT }));
    expect(refusalOf(await w.run('entity_update', { id: withMoment.id, archived: true }))).toBe(
      'INVARIANT/gate_fin_archived_no_moment',
    );
    const bare = entityOf(await w.mk({}));
    expect(refusalOf(await w.run('entity_update', { id: bare.id, archived: true }))).toBe('ok');
  });
  test('requires_when по orbis/archived: разархивация без props — отказ; со свойством — проходит', async () => {
    const w = await worldWith(GATE_FIN_ASPECT);
    const row = entityOf(await w.mk({}));
    expect(refusalOf(await w.run('entity_update', { id: row.id, archived: true }))).toBe('ok');
    await seedCustomAspect(w.graph, {
      ...GATE_FIN_ASPECT,
      rules: [
        {
          id: 'gate_fin_live_needs_moment',
          template: 'requires_when',
          undo: 'check',
          when: archivedIs(false),
          params: { property: GATE_PROPS.finWhen },
        },
      ],
    });
    expect(refusalOf(await w.run('entity_update', { id: row.id, archived: false }))).toBe(
      'INVARIANT/gate_fin_live_needs_moment',
    );
    expect(
      refusalOf(
        await w.run('entity_update', {
          id: row.id,
          archived: false,
          props: { [GATE_PROPS.finWhen]: AT },
        }),
      ),
    ).toBe('ok');
  });
});

describe('правка без свойств — только C-правила, читающие изменённое ядро (рулинг 3-4)', () => {
  test('запись-нарушительница: правка тела, эмодзи и заголовка проходит, если правило ядро не читает', async () => {
    const w = await worldWith(GATE_FIN_ASPECT);
    // Нарушение «задним числом»: запись в done без момента заведена ДО правила.
    const row = entityOf(await w.mk({ [GATE_PROPS.finState]: 'done' }));
    await seedCustomAspect(w.graph, { ...GATE_FIN_ASPECT, rules: [RULE_WHEN_DONE] });
    const body = await w.run('entity_update', {
      id: row.id,
      body: 'Заметка к трате',
      expectedUpdatedAt: row.updatedAt,
    });
    expect(refusalOf(body)).toBe('ok');
    expect(refusalOf(await w.run('entity_update', { id: row.id, emoji: '💸' }))).toBe('ok');
    expect(refusalOf(await w.run('entity_update', { id: row.id, title: 'Новое имя' }))).toBe('ok');
    // Правка СВОЙСТВ — все применимые правила, как у старого кода: нарушение называется.
    expect(
      refusalOf(
        await w.run('entity_update', { id: row.id, props: { [GATE_PROPS.finAmount]: '1.00' } }),
      ),
    ).toBe('INVARIANT/gate_fin_requires_when');
  });
  test('правило, читающее orbis/title, проверяется на переименовании', async () => {
    const FORBID_BY_TITLE: RuleDefinitionInput = {
      id: 'gate_fin_title_no_moment',
      template: 'forbidden_when',
      undo: 'check',
      when: { op: '=', args: [{ prop: 'orbis/title' }, { const: 'Без момента' }] },
      params: { property: GATE_PROPS.finWhen },
    };
    const w = await worldWith({ ...GATE_FIN_ASPECT, rules: [FORBID_BY_TITLE] });
    const row = entityOf(await w.mk({ [GATE_PROPS.finWhen]: AT }));
    expect(refusalOf(await w.run('entity_update', { id: row.id, title: 'Без момента' }))).toBe(
      'INVARIANT/gate_fin_title_no_moment',
    );
    expect(refusalOf(await w.run('entity_update', { id: row.id, title: 'С моментом' }))).toBe('ok');
  });
});

describe('fail-closed: область {role} у шаблона записи (ревью I-4)', () => {
  test('носитель на записи — VALIDATION RULE_SCOPE_UNSUPPORTED; запись без носителя — молчит', async () => {
    const w = await worldWith({
      ...GATE_FIN_ASPECT,
      rules: [
        {
          id: 'gate_fin_role_scope',
          template: 'requires_when',
          undo: 'check',
          scope: { role: ROLE_DEPENDENCY },
          params: { property: GATE_PROPS.finWhen },
        },
      ],
    });
    expect(refusalOf(await w.mk({}))).toBe('VALIDATION/RULE_SCOPE_UNSUPPORTED');
    expect(refusalOf(await w.run('entity_create', { title: 'Нечлен', tags: [] }))).toBe('ok');
  });
});

describe('C-правила обходятся детерминированно — по (носитель, id) (ревью FABLE M-1)', () => {
  test('нарушены правило аспекта и правило свойства — отказ называет правило первого по id носителя', async () => {
    // Порядок `rulesOf` — «сначала все аспекты, потом свойства», и внутри половины — по id строки.
    // Носитель-свойство `aux/marker` по id РАНЬШЕ носителя-аспекта траты, но в `rulesOf` идёт ПОЗЖЕ:
    // без сортировки по (носитель, id) отказ назвал бы правило аспекта.
    const holder: CustomAspectSpec = {
      key: 'aux/holder',
      label: { ru: 'Держатель метки' },
      properties: [{ key: 'marker', type: { kind: 'text' } }],
    };
    const w = await worldWith(holder);
    const { db: adb, client: ac } = adminDb();
    try {
      // Правило на строке СВОЙСТВА: хелпер сева пишет `rules` только аспекту, поэтому — прямой
      // записью фикстуры в строку владельца (версия реестра сдвигается севом аспекта ниже).
      await adb.execute(
        sql`UPDATE property_definitions SET rules = ${JSON.stringify([
          {
            id: 'b_marker_requires_moment',
            template: 'requires_when',
            undo: 'check',
            params: { property: GATE_PROPS.finWhen },
          },
        ])}::jsonb WHERE graph_id = ${w.graph} AND id = 'aux/marker'`,
      );
    } finally {
      await ac.end();
    }
    await seedCustomAspect(w.graph, {
      ...GATE_FIN_ASPECT,
      rules: [
        {
          id: 'z_fin_requires_moment',
          template: 'requires_when',
          undo: 'check',
          params: { property: GATE_PROPS.finWhen },
        },
      ],
    });
    expect('aux/marker' < FIN).toBe(true); // предпосылка: носитель-свойство раньше по id
    const r = await w.mk({ 'aux/marker': 'm' }, { aspects: [FIN, 'aux/holder'] });
    expect(refusalOf(r)).toBe('INVARIANT/b_marker_requires_moment');
  });
});
