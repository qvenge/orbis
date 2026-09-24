// apps/server/src/registry/actions.test.ts
// Валидатор декларации действия (§Б6-1/§Б6-3) против снимка ЖИВОЙ базы: привязки контрактов, по
// которым считается `touches_money`, и словарь действий, по которому проверяется занятость `key`,
// приезжают из сида, а не из литерала теста.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  type ActionDefinition,
  type ActionStep,
  actionDefinitionSchema,
  actionToolName,
  BUILTIN_ACTION_DEFS,
  type SensitivityFact,
} from '@orbis/shared';
import {
  ACTION_FIXTURES,
  GRANTS_AUTONOMY_UNDERDECLARED,
  UNSET_BY_EXPR_UNDERDECLARED,
} from '../../test/fixtures/action-seed';
import { appDb, mintGraph, personal, requireEnv, truncateAll } from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
// Имена реестровых тулов читаются, а не правятся (tools/* — задача 7): пин рулинга 6-1 обязан
// видеть и тулы, которые заведут следующие задачи, а не список, переписанный сюда руками.
import { REGISTRY_TOOL_NAMES } from '../tools/registry-tools';
import { actionExprScope, actionHash, assertAction, stepFactsOf, stepReversible } from './actions';
import { effectiveRegistry } from './cache';
import type { RegistrySnapshot } from './load';

requireEnv();
const { db, client } = appDb();
const owner = mintGraph();
let reg: RegistrySnapshot;

beforeAll(async () => {
  await truncateAll();
  reg = await withIdentity(db, personal(owner), (tx) => effectiveRegistry(tx, owner));
});
afterAll(async () => {
  await client.end();
});

test('оба сидовых действия проходят валидатор системного сида (§Б6-1)', () => {
  for (const decl of BUILTIN_ACTION_DEFS) {
    expect(() => assertAction(decl, { reg, systemSeed: true })).not.toThrow();
  }
});

/** Встроенная декларация по позиции; её отсутствие — дефект фикстуры, а не ветка пробы. */
function builtin(i: 0 | 1): ActionDefinition {
  const d = BUILTIN_ACTION_DEFS[i];
  if (d === undefined) throw new Error(`нет встроенного действия №${i}`);
  return d;
}
function firstStep(d: ActionDefinition): ActionStep {
  const step = d.steps[0];
  if (step === undefined) throw new Error(`у действия ${d.key} нет шагов`);
  return step;
}

/** Код и причина отказа: коды §С1-2 закрыты (errors.ts), причина VALIDATION едет в details. */
function verdict(decl: unknown): { code: string; reason?: string } | 'ok' {
  try {
    assertAction(decl, { reg, systemSeed: true });
    return 'ok';
  } catch (e) {
    const err = e as { code?: string; details?: { reason?: string } };
    return { code: String(err.code), reason: err.details?.reason };
  }
}

test('map-действие без капа — BATCH_UNBOUNDED; кап у одиночного — ACTION_CAP_WITHOUT_QUERY', () => {
  const map = { ...BUILTIN_ACTION_DEFS[1], batch_cap: null };
  expect(() => assertAction(map, { reg, systemSeed: true })).toThrow(/пакетное действие без капа/);
  const single = { ...BUILTIN_ACTION_DEFS[0], batch_cap: 10 };
  expect(() => assertAction(single, { reg, systemSeed: true })).toThrow(/капа у одиночного/);
});

test('в `over` запрещена проекция и «this», относительное время — законно (§Б6-3)', () => {
  const withLimit = {
    ...BUILTIN_ACTION_DEFS[1],
    over: { ...BUILTIN_ACTION_DEFS[1]?.over, limit: 5 },
  };
  expect(() => assertAction(withLimit, { reg, systemSeed: true })).toThrow(/проекц/);
  const withThis = {
    ...BUILTIN_ACTION_DEFS[1],
    over: { filter: { rel: { kind: 'children_of', of: 'this' } } },
  };
  expect(() => assertAction(withThis, { reg, systemSeed: true })).toThrow(/this/);
});

// Р-19: кап 0 — это не «кап есть», а испорченная форма: вердикт МЕНЯЕТСЯ на отказ формы, а не
// остаётся BATCH_UNBOUNDED и не проходит (схема `batch_cap` — целое ≥ 1).
test('кап 0 у пакетного — отказ формы ACTION_MALFORMED, а не «кап задан»', () => {
  expect(verdict({ ...BUILTIN_ACTION_DEFS[1], batch_cap: 0 })).toEqual({
    code: 'VALIDATION',
    reason: 'ACTION_MALFORMED',
  });
});

test('вход шага разбирается конвертом его тула, где любое значение может быть {$expr}', () => {
  const bogus = {
    ...BUILTIN_ACTION_DEFS[0],
    steps: [{ tool: 'entity_update', input: { id: { $expr: { ctx: '$self' } }, banana: 1 } }],
  };
  expect(() => assertAction(bogus, { reg, systemSeed: true })).toThrow(/шаг 1/);
  // Причина, а не только текст: «шаг 1» есть и в отказе ACTION_STEP_TOOL, и сообщение одно не различает.
  expect(verdict(bogus)).toEqual({ code: 'VALIDATION', reason: 'ACTION_STEP_INPUT' });
});

test('{param} неизвестного имени — EXPR_TYPE чекера (Р-К-24, отдельного кода нет)', () => {
  const bogus = {
    ...BUILTIN_ACTION_DEFS[0],
    steps: [
      {
        tool: 'entity_update',
        input: {
          id: { $expr: { ctx: '$self' } },
          props: { 'orbis/occurred_on': { $expr: { param: 'when' } } },
        },
      },
    ],
  };
  expect(() => assertAction(bogus, { reg, systemSeed: true })).toThrow();
  expect(verdict(bogus)).toMatchObject({ code: 'EXPR_TYPE' });
});

// Рулинг 6-1: вложенность — это вызов ДЕЙСТВИЯ (`run_action` или имя тула действия по форме
// `actionToolName`), а не любое имя с префиксом `action_`. Реестровые тулы — в т.ч. будущие
// `action_set`/`action_remove` задачи 10 — в шаге это «шаг вне словаря» (§Б6-3).
test('тул действия в шаге — ACTION_NESTED; реестровый тул action_set/action_remove — ACTION_STEP_TOOL', () => {
  const P2F = BUILTIN_ACTION_DEFS[0];
  const withTool = (tool: string) => ({ ...P2F, steps: [{ tool, input: {} }] });
  for (const key of ['planner/postpone_overdue', 'user/close-week', 'my-mod/x-y']) {
    expect([key, verdict(withTool(actionToolName(key)))]).toEqual([
      key,
      { code: 'ACTION_NESTED', reason: undefined },
    ]);
  }
  expect(verdict(withTool('run_action'))).toEqual({ code: 'ACTION_NESTED', reason: undefined });
  for (const tool of ['action_set', 'action_remove']) {
    expect([tool, verdict(withTool(tool))]).toEqual([
      tool,
      { code: 'VALIDATION', reason: 'ACTION_STEP_TOOL' },
    ]);
  }
});

test('ни один тул REGISTRY_TOOLS в шаге не читается вложенностью (рулинг 6-1)', () => {
  const P2F = BUILTIN_ACTION_DEFS[0];
  for (const tool of REGISTRY_TOOL_NAMES) {
    expect([tool, verdict({ ...P2F, steps: [{ tool, input: {} }] })]).toEqual([
      tool,
      { code: 'VALIDATION', reason: 'ACTION_STEP_TOOL' },
    ]);
  }
});

test('объявленный параметр, который не читает ни precondition, ни шаг, — ACTION_PARAM_UNUSED (Р-34)', () => {
  const bogus = {
    ...BUILTIN_ACTION_DEFS[1],
    params: [
      { name: 'to', type: { kind: 'date' } },
      { name: 'reason', type: { kind: 'text' } },
    ],
  };
  expect(() => assertAction(bogus, { reg, systemSeed: true })).toThrow(/reason/);
  expect(verdict(bogus)).toEqual({ code: 'VALIDATION', reason: 'ACTION_PARAM_UNUSED' });
});

// Р-34, обход по E-позициям: `{param}` ВНУТРИ литерала json-значения — данные, а не чтение
// параметра. Второй обход сырого дерева засчитал бы его и пропустил неиспользуемый параметр.
test('{param} внутри литерала json-значения параметр не «читает» (Р-34)', () => {
  const bogus = {
    ...BUILTIN_ACTION_DEFS[1],
    steps: [
      {
        tool: 'entity_update',
        input: {
          id: { $expr: { ctx: '$self' } },
          props: { 'orbis/progress_source': { param: 'to' } },
        },
      },
    ],
  };
  expect(verdict(bogus)).toEqual({ code: 'VALIDATION', reason: 'ACTION_PARAM_UNUSED' });
});

test('шаг, пишущий свойство слота money-movement, несёт touches_money; декларация обязана его объявить', () => {
  expect([...stepFactsOf(reg, firstStep(builtin(0)))]).toEqual(['touches_money']);
  expect([...stepFactsOf(reg, firstStep(builtin(1)))]).toEqual([]);
  const under = { ...BUILTIN_ACTION_DEFS[0], sensitivity: [] };
  expect(() => assertAction(under, { reg, systemSeed: true })).toThrow(/touches_money/);
});

// `attach_*` пишет набор аспекта КЛЮЧАМИ свойств в `data` (§А9-1): факт шага обязан считаться и там.
test('attach_* с денежным свойством в data — тот же touches_money (§А9-1)', () => {
  const attach = {
    tool: 'attach_orbis_financial',
    input: { entity_id: { $expr: { ctx: '$self' } }, data: { 'orbis/amount': '1.00' } },
  };
  expect([...stepFactsOf(reg, attach)]).toEqual(['touches_money']);
  const under = {
    ...BUILTIN_ACTION_DEFS[0],
    sensitivity: [],
    params: [],
    precondition: null,
    steps: [attach],
  };
  expect(verdict(under)).toEqual({ code: 'SENSITIVITY_UNDERDECLARED', reason: undefined });
});

test('обратимость шага — статическая таблица; условные случаи необратимы (Р-10)', () => {
  for (const tool of [
    'entity_create',
    'entity_update',
    'relation_create',
    'relation_delete',
    'attach_orbis_task',
  ]) {
    expect([tool, stepReversible(tool)]).toEqual([tool, true]);
  }
  expect(stepReversible('property_update')).toBe(false);
});

test('actionHash: подпись и rank личности не меняют, шаги и кап — меняют (§Б6-7)', () => {
  const a = builtin(1);
  expect(actionHash({ ...a, label: { ru: 'Другая', en: 'Other' }, rank: 9 })).toBe(actionHash(a));
  expect(actionHash({ ...a, batch_cap: 5 })).not.toBe(actionHash(a));
  expect(actionHash({ ...a, steps: [] })).not.toBe(actionHash(a));
});

test('корпус деклараций действий: каждый вход даёт свой вердикт (§С8-24)', () => {
  // Пара «имя → вердикт» целиком: на расхождении видно, КАКАЯ строка корпуса поехала.
  const got = ACTION_FIXTURES.map((f) => {
    const v = verdict(f.decl);
    return [f.name, v === 'ok' ? { ok: true } : { ok: false, ...v }];
  });
  const want = ACTION_FIXTURES.map((f) => [
    f.name,
    f.verdict.ok ? { ok: true } : { ok: false, code: f.verdict.code, reason: f.verdict.reason },
  ]);
  expect(got).toEqual(want);
});

// Ступень 2: строка в E-позиции — второй язык, и отказ называет его ДО разбора формы (иначе схема
// сказала бы безликое ACTION_MALFORMED про «не тот тип», не назвав, что автор написал формулу текстом).
test('строка в E-позиции — SECOND_LANGUAGE, а не отказ формы (§Б3, ступень 2)', () => {
  expect(verdict({ ...builtin(0), precondition: 'orbis/planned = true' })).toEqual({
    code: 'SECOND_LANGUAGE',
    reason: undefined,
  });
  const textMarker = {
    ...builtin(1),
    steps: [
      {
        tool: 'entity_update',
        input: { id: { $expr: { ctx: '$self' } }, props: { 'orbis/due_date': { $expr: 'to' } } },
      },
    ],
  };
  expect(verdict(textMarker)).toEqual({ code: 'SECOND_LANGUAGE', reason: undefined });
});

// Ступень 4: системная строка живёт в namespace СВОЕГО модуля, своя — только в `user/`; ключ
// встроенного действия владельцу не достаётся (иначе следующий пересев столкнулся бы с его строкой).
test('namespace ключа по писателю и занятый ключ — ACTION_NAMESPACE / ACTION_KEY_TAKEN (ступень 4)', () => {
  const own = (decl: unknown) => {
    try {
      assertAction(decl, { reg, systemSeed: false });
      return 'ok';
    } catch (e) {
      const err = e as { code?: string; details?: { reason?: string } };
      return { code: String(err.code), reason: err.details?.reason };
    }
  };
  const ns = { code: 'VALIDATION', reason: 'ACTION_NAMESPACE' };
  expect(own({ ...builtin(1), key: 'planner/mine', id: 'planner/mine' })).toEqual(ns);
  expect(verdict({ ...builtin(1), key: 'user/mine', id: 'user/mine', module: null })).toEqual(ns);
  expect(
    verdict({ ...builtin(1), key: 'planner/mine', id: 'planner/mine', module: 'finance' }),
  ).toEqual(ns);
  // Своя строка несёт ГРАФ владельца (m-3 гейта задачи 6, перенос в задачу 10): без графа она
  // читалась бы системной для всех владельцев сразу — отказ; с графом — законна.
  expect(
    own({ ...builtin(1), key: 'user/mine', id: 'user/mine', graphId: null, module: null }),
  ).toEqual(ns);
  expect(
    own({ ...builtin(1), key: 'user/mine', id: 'user/mine', graphId: owner, module: null }),
  ).toBe('ok');
  // …и обратная сторона той же связки: системный сид с графом — не системный.
  expect(
    verdict({ ...builtin(1), key: 'planner/mine', id: 'planner/mine', graphId: owner }),
  ).toEqual(ns);
  expect(verdict({ ...builtin(1), id: 'planner/twin' })).toEqual({
    code: 'VALIDATION',
    reason: 'ACTION_KEY_TAKEN',
  });
});

// Ступень 8: предикат — boolean. Тотальное, но не булево выражение в `precondition` или в
// `offered_by[].when` — отказ с причиной, а не «истинно, если непусто».
test('precondition и offered_by.when не предикатом — ACTION_PRECONDITION_TYPE (ступень 8)', () => {
  const reason = { code: 'VALIDATION', reason: 'ACTION_PRECONDITION_TYPE' };
  expect(verdict({ ...builtin(0), precondition: { const: 1 } })).toEqual(reason);
  expect(verdict({ ...builtin(1), offered_by: [{ llm: true, when: { ctx: '$today' } }] })).toEqual(
    reason,
  );
});

// ─────────────── фикс-раунд 1 гейта задачи 6 (I-1, I-2 + m-1, I-3, m-2) ───────────────

const SELF = { $expr: { ctx: '$self' } };
const VALUE_TYPE = { code: 'VALIDATION', reason: 'ACTION_VALUE_TYPE' };
const stepOf = (tool: string, input: Record<string, unknown>): ActionStep => ({ tool, input });

// I-1 (Р-И-25): доверенность рутины — факт шага ТЕМ ЖЕ предикатом, что поднимает уровень у политики.
test('шаг, правящий доверенность рутины, несёт grants_autonomy; подстановка — худший случай (Р-9)', () => {
  const facts = (tool: string, input: Record<string, unknown>) => [
    ...stepFactsOf(reg, stepOf(tool, input)),
  ];
  expect(facts('entity_update', { id: SELF, props: { 'orbis/routine_mode': 'act' } })).toEqual([
    'grants_autonomy',
  ]);
  expect(facts('entity_update', { id: SELF, unset: ['orbis/allowed_tools'] })).toEqual([
    'grants_autonomy',
  ]);
  expect(
    facts('attach_orbis_routine', { entity_id: SELF, data: { 'orbis/routine_mode': 'act' } }),
  ).toEqual(['grants_autonomy']);
  // Контроль: набор без доверенности (`propose`, белого списка нет) — не выдача, факт не «всегда».
  expect(
    facts('attach_orbis_routine', { entity_id: SELF, data: { 'orbis/routine_mode': 'propose' } }),
  ).toEqual([]);
  // Набор кладётся целиком, значение подстановки до прогона неизвестно — «вооружает».
  expect(
    facts('attach_orbis_routine', {
      entity_id: SELF,
      data: { 'orbis/routine_mode': { $expr: { param: 'mode' } } },
    }),
  ).toEqual(['grants_autonomy']);
  expect(
    facts('entity_create', {
      title: 'Рутина',
      tags: [],
      props: { 'orbis/allowed_tools': { $expr: { param: 'tools' } } },
    }),
  ).toEqual(['grants_autonomy']);
  // Подстановка в `unset` — снятие НЕИЗВЕСТНОГО свойства: и деньги, и доверенность.
  expect(facts('entity_update', { id: SELF, unset: [{ $expr: { param: 'which' } }] })).toEqual([
    'touches_money',
    'grants_autonomy',
  ]);
});

test('действие, взводящее рутину, обязано объявить grants_autonomy — SENSITIVITY_UNDERDECLARED', () => {
  expect(verdict(GRANTS_AUTONOMY_UNDERDECLARED)).toEqual({
    code: 'SENSITIVITY_UNDERDECLARED',
    reason: undefined,
  });
  expect(verdict({ ...GRANTS_AUTONOMY_UNDERDECLARED, sensitivity: ['grants_autonomy'] })).toBe(
    'ok',
  );
});

// I-2 (§1.6, ступень 8): `{$expr}` — выражение ТИПА СВОЕЙ ПОЗИЦИИ; четыре пробы гейта дословно.
test('{$expr} против типа позиции: date→boolean, boolean→decimal, number→id, свойства нет — ACTION_VALUE_TYPE', () => {
  const on = { $expr: { param: 'occurred_on' } };
  const withInput = (input: Record<string, unknown>) => ({
    ...builtin(0),
    steps: [{ tool: 'entity_update', input }],
  });
  expect(verdict(withInput({ id: SELF, props: { 'orbis/planned': on } }))).toEqual(VALUE_TYPE);
  expect(
    verdict(
      withInput({
        id: SELF,
        props: { 'orbis/amount': { $expr: { const: true } }, 'orbis/occurred_on': on },
      }),
    ),
  ).toEqual(VALUE_TYPE);
  expect(
    verdict(withInput({ id: { $expr: { const: 5 } }, props: { 'orbis/occurred_on': on } })),
  ).toEqual(VALUE_TYPE);
  expect(
    verdict(withInput({ id: SELF, props: { 'orbis/nope': 1, 'orbis/occurred_on': on } })),
  ).toEqual(VALUE_TYPE);
  // json-свойству выражения не положено: у вложенного объекта нет скалярного значения (§6.4).
  expect(
    verdict(
      withInput({
        id: SELF,
        props: { 'orbis/progress_source': { $expr: { const: 'x' } }, 'orbis/occurred_on': on },
      }),
    ),
  ).toEqual(VALUE_TYPE);
  // Контроль: decimal-литерал строкой в decimal-позиции законен — приведение по позиции, как у правил.
  expect(
    verdict(
      withInput({
        id: SELF,
        props: { 'orbis/amount': { $expr: { const: '1.00' } }, 'orbis/occurred_on': on },
      }),
    ),
  ).toBe('ok');
});

// m-1: заглушка ступени 7 — по типу позиции. Прежний uuid давал ложный отказ формы у `archived`.
test('archived из boolean-параметра — законно; из date-параметра — ACTION_VALUE_TYPE (m-1)', () => {
  const archivedFrom = (v: unknown) => [
    { tool: 'entity_update', input: { id: SELF, archived: v } },
  ];
  expect(
    verdict({
      ...builtin(1),
      params: [{ name: 'flag', type: { kind: 'boolean' } }],
      steps: archivedFrom({ $expr: { param: 'flag' } }),
    }),
  ).toBe('ok');
  expect(verdict({ ...builtin(1), steps: archivedFrom({ $expr: { param: 'to' } }) })).toEqual(
    VALUE_TYPE,
  );
});

// I-3: тип `{param}` — тем же `exprTypeOfKind`, что у `{prop}` (Produces-интерфейс задачи 7).
test('тип параметра — родом свойства: select сравним с select-свойством; json-параметр — отказ формы', () => {
  const p = builtin(1);
  const withSelect = {
    ...p,
    params: [...p.params, { name: 'st', type: { kind: 'select' } }],
    precondition: { op: '=', args: [{ prop: 'orbis/task_status' }, { param: 'st' }] },
  };
  expect(verdict(withSelect)).toBe('ok');
  const decl = actionDefinitionSchema.parse({
    ...p,
    params: [
      { name: 'to', type: { kind: 'date' } },
      { name: 'st', type: { kind: 'select' } },
      { name: 'at', type: { kind: 'time' } },
      { name: 'who', type: { contract: 'orbis/completable' } },
    ],
  });
  expect(actionExprScope(decl, reg).params).toEqual({
    to: { kind: 'date' },
    st: { kind: 'text' },
    at: { kind: 'text' },
    who: { kind: 'text' },
  });
  expect(
    verdict({ ...p, params: [...p.params, { name: 'blob', type: { kind: 'json' } }] }),
  ).toEqual({
    code: 'VALIDATION',
    reason: 'ACTION_MALFORMED',
  });
});

// m-2: маркер строгий на боевом пути — сосед у `$expr` не теряется молча.
test('маркер {$expr} с соседним ключом — ACTION_STEP_INPUT (m-2)', () => {
  const junk = {
    ...builtin(0),
    steps: [
      {
        tool: 'entity_update',
        input: {
          id: { $expr: { ctx: '$self' }, junk: 1 },
          props: { 'orbis/occurred_on': { $expr: { param: 'occurred_on' } } },
        },
      },
    ],
  };
  expect(verdict(junk)).toEqual({ code: 'VALIDATION', reason: 'ACTION_STEP_INPUT' });
});

// ─────────────── фикс-раунд 2 гейта задачи 6 (N-1) ───────────────

// N-1: маркер на месте ВСЕГО `unset` проходит конверт (позиция `list<text>`, заглушка `[]`), и
// чтение `unset` только как массива теряло оба факта — `SENSITIVITY_UNDERDECLARED` обходился и по
// деньгам, и по доверенности. Правило — худший случай Р-9, как у маркера-элемента.
test('весь unset выражением — снятие неизвестного: оба факта, иначе SENSITIVITY_UNDERDECLARED (N-1)', () => {
  const facts = (unset: unknown) => [
    ...stepFactsOf(reg, stepOf('entity_update', { id: SELF, unset })),
  ];
  const both: SensitivityFact[] = ['touches_money', 'grants_autonomy'];
  expect(facts({ $expr: { const: ['orbis/allowed_tools'] } })).toEqual(both);
  expect(facts({ $expr: { const: ['orbis/amount'] } })).toEqual(both);
  expect(facts([{ $expr: { const: 'orbis/amount' } }])).toEqual(both);
  // Пробы ре-ревью дословно: без фактов в декларации — отказ, с обоими — позитив.
  const underdeclared = { code: 'SENSITIVITY_UNDERDECLARED', reason: undefined };
  expect(verdict(UNSET_BY_EXPR_UNDERDECLARED)).toEqual(underdeclared);
  const money = {
    ...UNSET_BY_EXPR_UNDERDECLARED,
    steps: [
      { tool: 'entity_update', input: { id: SELF, unset: { $expr: { const: ['orbis/amount'] } } } },
    ],
  };
  expect(verdict(money)).toEqual(underdeclared);
  expect(verdict({ ...money, sensitivity: ['touches_money', 'grants_autonomy'] })).toBe('ok');
});

// ─────────────── фикс-раунд 1 задачи 7: рутины и прогоны действиями не сценарируются ───────────────

test('шаг, называющий рутину или прогон, — ACTION_STEP_TOOL: attach_*, aspects, aspects.attach|detach, выражение (Fable I-1а, I-4)', () => {
  const withStep = (step: ActionStep) => ({
    ...builtin(0),
    params: [],
    // Факты объявлены с запасом: отказ обязан прийти от ступени 5, а не от недообъявления.
    sensitivity: ['touches_money', 'grants_autonomy'],
    steps: [step],
  });
  const REFUSED = { code: 'VALIDATION', reason: 'ACTION_STEP_TOOL' };
  const expr = { $expr: { const: ['orbis/task'] } };
  const forms: Array<[string, ActionStep]> = [
    [
      'attach_orbis_routine',
      stepOf('attach_orbis_routine', {
        entity_id: SELF,
        data: { 'orbis/routine_mode': 'propose', 'orbis/routine_stage': 'active' },
      }),
    ],
    // Служебный аспект прогона тула модели не даёт, но в реестре он есть — шаг его не назовёт.
    ['attach_orbis_agent_run', stepOf('attach_orbis_agent_run', { entity_id: SELF, data: {} })],
    [
      'entity_create aspects',
      stepOf('entity_create', {
        title: 'Рутина',
        tags: [],
        aspects: ['orbis/routine'],
        props: { 'orbis/routine_mode': 'propose' },
      }),
    ],
    [
      'entity_update aspects.attach',
      stepOf('entity_update', { id: SELF, aspects: { attach: ['orbis/routine'] } }),
    ],
    [
      'entity_update aspects.detach',
      stepOf('entity_update', { id: SELF, aspects: { detach: ['orbis/agent-run'] } }),
    ],
    ['aspects выражением', stepOf('entity_create', { title: 'x', tags: [], aspects: expr })],
    ['aspects.attach выражением', stepOf('entity_update', { id: SELF, aspects: { attach: expr } })],
    [
      'элемент aspects.attach выражением',
      stepOf('entity_update', { id: SELF, aspects: { attach: [expr] } }),
    ],
  ];
  for (const [what, step] of forms) {
    expect([what, verdict(withStep(step))]).toEqual([what, REFUSED]);
  }
  // Отказ называет объект, а не только тул.
  const attach = forms[3]?.[1];
  if (attach === undefined) throw new Error('формы aspects.attach нет');
  expect(() => assertAction(withStep(attach), { reg, systemSeed: true })).toThrow(
    'рутины и прогоны действиями не сценарируются',
  );
  // Контроль: чужой аспект в `aspects.attach` ступень 5 пропускает — отказ адресован объекту.
  expect(
    verdict(
      withStep(
        stepOf('entity_update', {
          id: SELF,
          aspects: { attach: ['orbis/task'] },
          props: { 'orbis/task_status': 'inbox' },
        }),
      ),
    ),
  ).toBe('ok');
  // И сидовые действия — прежний вердикт.
  for (const decl of BUILTIN_ACTION_DEFS) expect(verdict(decl)).toBe('ok');
});

test('precondition с предикатным набором или has_relation.in_set — EXPR_TYPE: TS-интерпретатор их не считает (финал Б-2 E-5)', () => {
  const MM = { class: { contract: 'orbis/money-movement' } };
  const withPre = (p: unknown) => ({
    ...builtin(0),
    precondition: {
      op: 'and',
      args: [p, { op: '=', args: [{ prop: 'orbis/planned' }, { const: true }] }],
    },
  });
  expect(verdict(withPre({ op: 'in', args: [MM, { const: 'facts' }] }))).toEqual({
    code: 'EXPR_TYPE',
    reason: undefined,
  });
  expect(
    verdict(
      withPre({
        op: 'not',
        args: [
          {
            has_relation: {
              role: 'instance-of',
              in_set: { contract: 'orbis/recurrence', set: 'templates' },
            },
          },
        ],
      }),
    ),
  ).toEqual({ code: 'EXPR_TYPE', reason: undefined });
  // Набор СПИСКОМ — законен (им написан и сидовый plan-to-fact).
  expect(verdict(withPre({ op: 'in', args: [MM, { const: 'outflow' }] }))).toBe('ok');
});
