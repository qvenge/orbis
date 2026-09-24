// apps/server/src/registry/rules.test.ts
// Валидатор декларации правила (§Б4-1/3, Р-И-21) — юнитом по снимку-пробе: правило кладётся на
// строку-носитель встроенного словаря так, как его увидит читатель ПОСЛЕ записи.
import { afterAll, describe, expect, test } from 'bun:test';
import {
  BUILTIN_ASPECT_DEFS,
  BUILTIN_CONTRACT_DEFS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
  BUILTIN_RULES_BY_CARRIER,
  RULE_FIXTURES,
  type RuleDefinition,
  type RuleDefinitionInput,
  ruleDefinitionSchema,
} from '@orbis/shared';
import { DEREF_IN_CONSTRAINT, SECOND_LANGUAGE } from '@orbis/shared/expr';
import { appDb, freshGraph, personal, requireEnv } from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import { ExecError } from '../errors';
import { effectiveRegistry } from './cache';
import { assertAcyclicGraph, dependencyGraph } from './deps-graph';
import type { RegistrySnapshot } from './load';
import {
  assertBuiltinRules,
  assertRule,
  assertRulesOfRow,
  type RuleCarrier,
  ruleConflictsOf,
  rulesOf,
} from './rules';

// Юниты файла БД не трогают; база нужна ОДНОМУ тесту — сторожу системных строк над живым снимком
// после `db:prepare` (Р-К-26).
requireEnv();
const { db, client } = appDb();
afterAll(async () => {
  await client.end();
});

/** Снимок встроенных словарей, где у названной строки лежат эти правила (форма колонки задачи 2). */
function probe(carrier: RuleCarrier, rules: readonly unknown[]): RegistrySnapshot {
  const properties = new Map(BUILTIN_PROPERTY_META.map((d) => [d.id, { ...d } as never]));
  const aspects = new Map(BUILTIN_ASPECT_DEFS.map((d) => [d.id, { ...d } as never]));
  const roles = new Map(BUILTIN_RELATION_ROLE_META.map((d) => [d.id, { ...d } as never]));
  const dict =
    carrier.kind === 'aspect' ? aspects : carrier.kind === 'property' ? properties : roles;
  const base = dict.get(carrier.id) as Record<string, unknown> | undefined;
  if (base === undefined) throw new Error(`нет строки-носителя ${carrier.id}`);
  dict.set(carrier.id, { ...base, rules } as never);
  return {
    properties,
    aspects,
    roles,
    contracts: new Map(BUILTIN_CONTRACT_DEFS.map((d) => [d.id, d])),
    subscriptions: new Map(),
    actions: new Map(),
    ownerVersion: 1,
    systemVersion: 1,
  };
}
/**
 * Снимок встроенных словарей ИЗ КОДА — тот же, что собирает `assertBuiltinRules`: по нему считается
 * пин числа системных правил (m-5).
 */
function codeSnapshot(): RegistrySnapshot {
  return {
    properties: new Map(BUILTIN_PROPERTY_META.map((d) => [d.id, d])),
    aspects: new Map(BUILTIN_ASPECT_DEFS.map((d) => [d.id, d])),
    roles: new Map(BUILTIN_RELATION_ROLE_META.map((d) => [d.id, d])),
    contracts: new Map(BUILTIN_CONTRACT_DEFS.map((d) => [d.id, d])),
    subscriptions: new Map(),
    actions: new Map(),
    ownerVersion: 0,
    systemVersion: 0,
  };
}
/**
 * Системных строк каталога правил — двадцать: задача 4 — два инварианта §А7-2 (financial — парой)
 * и переход `task_completed_at`, задача 12 — уникальность конверта (`duplicate_envelope`), задача 13 —
 * четыре носителя параметров движков (`nearest_ancestor`, `materialize`, `mirror_ref`,
 * `budget_rollover`) и три метки ролевых ограничений (`acyclic` ×2, `target_max_incoming`), задача 14 —
 * «чего ждём» парой (`waiting_for`, `waiting_for_only_when_waiting`), субъект прогона парой
 * (`run_subject`, `run_subject_forbidden`), условие гранта назначения парой
 * (`assignment_grant_required`, `assignment_grant_forbidden`), форма правила памяти
 * (`memory_rule_pattern`, `memory_rule_target`) и умолчание валюты конверта (`envelope_currency_default`).
 */
const BUILTIN_RULE_COUNT = 20;
const FIN: RuleCarrier = { kind: 'aspect', id: 'orbis/financial' };
const TASK: RuleCarrier = { kind: 'aspect', id: 'orbis/task' };
/** Код И `details.reason`: словарный VALIDATION без причины не адресует ничего. */
function err(fn: () => unknown): ExecError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ExecError) return e;
    throw e;
  }
  throw new Error('ожидался отказ валидатора, а его не было');
}
const reasonOf = (e: ExecError) => String((e.details as { reason?: unknown })?.reason ?? '');
/** Уровень `assign_level`: у союза шаблонов поле `level` есть только у этой ветки. */
const levelOf = (r: RuleDefinition) => (r.template === 'assign_level' ? r.level : undefined);
/** Правило кладётся в снимок-пробу — как его увидит читатель ПОСЛЕ записи (Р-И-21). */
const check = (c: RuleCarrier, rule: unknown, others: readonly unknown[] = []) =>
  assertRule(rule, { reg: probe(c, [rule, ...others]), carrier: c, systemSeed: true });

const OCCURRED: RuleDefinitionInput = {
  id: 'fin_occurred',
  template: 'requires_when',
  params: { property: 'orbis/occurred_on' },
  when: { op: 'not', args: [{ op: '=', args: [{ prop: 'orbis/recurring' }, { const: true }] }] },
};
// id — СВОЙ, не `mirror_ref`: с задачи 13 системная строка роли `ref` носит именно его, и проба на чужом
// носителе упёрлась бы в `RULE_ID_TAKEN` раньше, чем в проверяемую ступень носителя.
const MIRROR = {
  id: 'fx_mirror',
  template: 'mirror_relation',
  params: { meta_key: 'property', skip_computed: true },
};

describe('assertRule: порядок ступеней (Р-И-21, образец assertSubscription)', () => {
  test('законное правило разбирается и достраивает enabled/undo', () => {
    expect([check(FIN, OCCURRED).enabled, check(FIN, OCCURRED).undo]).toEqual([true, 'check']);
  });
  test('строка в E-позиции — SECOND_LANGUAGE, и ДО разбора формы', () => {
    expect(err(() => check(FIN, { ...OCCURRED, when: 'recurring != true' })).code).toBe(
      SECOND_LANGUAGE,
    );
  });
  test('форма — RULE_MALFORMED с issues: лишнее поле не уезжает в jsonb молча', () => {
    expect(reasonOf(err(() => check(FIN, { ...OCCURRED, срок: 1 })))).toBe('RULE_MALFORMED');
    expect(reasonOf(err(() => check(FIN, { ...OCCURRED, template: 'нет-такого' })))).toBe(
      'RULE_MALFORMED',
    );
  });
  test('id уникален среди ВСЕХ правил снимка — RULE_ID_TAKEN', () => {
    expect(
      reasonOf(
        err(() => check(FIN, OCCURRED, [{ ...OCCURRED, params: { property: 'orbis/currency' } }])),
      ),
    ).toBe('RULE_ID_TAKEN');
  });
  test('области, которой нет в реестре, — RULE_SCOPE_UNKNOWN; scope.contract принимается (Р-25)', () => {
    expect(reasonOf(err(() => check(FIN, { ...OCCURRED, scope: { aspect: 'orbis/нет' } })))).toBe(
      'RULE_SCOPE_UNKNOWN',
    );
    expect(check(FIN, { ...OCCURRED, scope: { contract: 'orbis/money-movement' } }).scope).toEqual({
      contract: 'orbis/money-movement',
    });
  });
  test('шаблон против носителя: ролевой — только на роли, C/T — на аспекте либо свойстве', () => {
    expect(check({ kind: 'role', id: 'ref' }, MIRROR).template).toBe('mirror_relation');
    expect(reasonOf(err(() => check(FIN, MIRROR)))).toBe('RULE_TEMPLATE_CARRIER');
    expect(reasonOf(err(() => check({ kind: 'role', id: 'ref' }, OCCURRED)))).toBe(
      'RULE_TEMPLATE_CARRIER',
    );
  });
});

describe('assertRule: ссылки параметров разрешаются по реестру', () => {
  const ENTER = {
    id: 'task_done',
    template: 'on_enter_class',
    params: {
      enter: { contract: 'orbis/completable', slot: 'status', in: ['done'] },
      set: { property: 'orbis/completed_at', value: { prop: 'orbis/updated_at' } },
    },
  };
  const ROLL = (agg: string) => ({
    id: 'roll',
    template: 'rollover',
    params: { source: 'exact_calendar_month', carry: { agg } },
  });
  test('свойства-цели нет — RULE_UNKNOWN_PROPERTY', () => {
    expect(
      reasonOf(err(() => check(FIN, { ...OCCURRED, params: { property: 'orbis/нет' } }))),
    ).toBe('RULE_UNKNOWN_PROPERTY');
  });
  test('событие on_enter_class: контракт, слот и классы — по реестру', () => {
    expect(check(TASK, ENTER).template).toBe('on_enter_class');
    for (const enter of [
      { contract: 'orbis/completable', slot: 'нет', in: ['done'] },
      { contract: 'orbis/completable', slot: 'status', in: ['нет'] },
    ]) {
      expect(
        reasonOf(err(() => check(TASK, { ...ENTER, params: { ...ENTER.params, enter } }))),
      ).toBe('RULE_UNKNOWN_CONTRACT_SLOT');
    }
  });
  test('событие on_enter_class: слот обязан быть статусом — иначе cause not_status (ревью FABLE M-2)', () => {
    const onMoney = (slot: string) => ({
      id: 'money_enter',
      template: 'on_enter_class',
      params: {
        enter: { contract: 'orbis/money-movement', slot, in: ['outflow'] },
        on_leave: { unset: ['orbis/planned'] },
      },
    });
    // Позитивный контроль: слот-статус контракта денег — `direction`.
    expect(check(FIN, onMoney('direction')).template).toBe('on_enter_class');
    const e = err(() => check(FIN, onMoney('amount')));
    expect([reasonOf(e), (e.details as { cause?: unknown }).cause]).toEqual([
      'RULE_UNKNOWN_CONTRACT_SLOT',
      'not_status',
    ]);
  });
  test('rollover: carry.agg — только ОПУБЛИКОВАННАЯ величина носителя (Р-И-16)', () => {
    const BUD: RuleCarrier = { kind: 'aspect', id: 'orbis/budget' };
    expect(check(BUD, ROLL('remaining')).template).toBe('rollover');
    expect(reasonOf(err(() => check(BUD, ROLL('нет'))))).toBe('RULE_ROLLOVER_AGG_UNPUBLISHED');
  });
});

describe('область E правила (§Б3-3, приёмка §С8-29)', () => {
  const D = { deref: { prop: 'orbis/finance_category', read: 'orbis/title' } };
  const lvl = (over: Record<string, unknown>) => ({
    id: 'lvl',
    template: 'assign_level',
    params: {},
    level: 'discuss',
    ...over,
  });
  test('deref в requires_when — DEREF_IN_CONSTRAINT; в assign_level он законен', () => {
    expect(
      err(() => check(FIN, { ...OCCURRED, when: { op: '=', args: [D, { const: 'Еда' }] } })).code,
    ).toBe(DEREF_IN_CONSTRAINT);
    expect(check(FIN, lvl({ when: { op: '=', args: [D, { const: 'Еда' }] } })).template).toBe(
      'assign_level',
    );
  });
  test('$sensitivity — только у assign_level (ступень чекера, не правила)', () => {
    const S = { op: 'in', args: [{ const: 'external' }, { ctx: '$sensitivity' }] };
    expect(levelOf(check(FIN, lvl({ when: S })))).toBe('discuss');
    expect(err(() => check(FIN, { ...OCCURRED, when: S })).code).toBe('EXPR_TYPE');
  });
  test('when — boolean; значение default — типа свойства-цели (RULE_VALUE_TYPE)', () => {
    expect(err(() => check(FIN, { ...OCCURRED, when: { prop: 'orbis/amount' } })).code).toBe(
      'EXPR_TYPE',
    );
    const def = (value: unknown) => ({
      id: 'amt',
      template: 'default',
      params: { property: 'orbis/amount', value },
    });
    // КОРНЕВОЙ литерал: `{const:'340.00'}` сам по себе типизируется `text` (соседа у него нет,
    // `check.ts` ветка `const`), и без приведения ПО ПОЗИЦИИ законная строка сида отказывала бы RULE_VALUE_TYPE.
    expect(check(FIN, def({ const: '340.00' })).template).toBe('default');
    expect(reasonOf(err(() => check(FIN, def({ const: 'не-число' }))))).toBe('RULE_VALUE_TYPE');
    // Род сошёлся, а граница схемы — нет (`exclusiveMin: '0'`): литерал сверяется и стадией 2 (финал Б-2
    // E-6). Прежде здесь стоял именно `'0.00'` — принятое правило, умолчание которого движок записать не мог.
    expect(reasonOf(err(() => check(FIN, def({ const: '0.00' }))))).toBe('RULE_VALUE_TYPE');
    // …а приведение — ТОЛЬКО литерала: у нелитерального узла тип свой, и text в позиции decimal — отказ.
    expect(reasonOf(err(() => check(FIN, def({ prop: 'orbis/counterparty' }))))).toBe(
      'RULE_VALUE_TYPE',
    );
    // Позитив без литерала: {param} типизируется по RULE_PARAM_TYPES и совпадает с типом цели.
    expect(
      check(
        { kind: 'aspect', id: 'orbis/budget' },
        {
          id: 'cur',
          template: 'default',
          params: { property: 'orbis/currency', value: { param: 'default_currency' } },
        },
      ).template,
    ).toBe('default');
  });
  test('отказ чекера несёт адрес правила: rule, template и site — договор details DEREF_IN_CONSTRAINT (0b)', () => {
    const e = err(() =>
      check(FIN, { ...OCCURRED, when: { op: '=', args: [D, { const: 'Еда' }] } }),
    );
    expect(e.details).toMatchObject({
      path: ['args', '0'],
      rule: 'fin_occurred',
      template: 'requires_when',
      site: 'aspect:orbis/financial.rules.fin_occurred.when',
    });
  });
  test('T-область закрыта для чужого состояния так же, как C (Р-К-13)', () => {
    const def = (value: unknown) => ({
      id: 'amt',
      template: 'default',
      params: { property: 'orbis/amount', value },
    });
    // `deref` в ЗНАЧЕНИИ T-правила — тот же чёрный ход, что в предикате C, и код у него тот же:
    // «constraint» здесь — ПРАВИЛО ЗАПИСИ, а не только его C-половина.
    expect(err(() => check(FIN, def(D))).code).toBe(DEREF_IN_CONSTRAINT);
    // `agg_via` по Р-И-10 отвечает EXPR_TYPE («область правила записи»), своего кода спека ему не завела —
    // словарь кодов §С1-2 закрыт, и пятнадцатый код ради второго чёрного хода не заводится.
    expect(
      err(() => check(FIN, def({ agg_via: { role: 'envelope-binding', name: 'remaining' } }))).code,
    ).toBe('EXPR_TYPE');
  });
});

describe('assign_level и конфлюэнтность §Б4', () => {
  const low = (over: Record<string, unknown> = {}) => ({
    id: 'low',
    template: 'assign_level',
    params: {},
    level: 'silent',
    when: { op: '=', args: [{ prop: 'orbis/recurring' }, { const: true }] },
    ...over,
  });
  const dflt = (id: string, property: string) => ({
    id,
    template: 'default',
    params: { property, value: { const: 'RUB' } },
  });
  const byClass = (id: string) => ({
    id,
    template: 'on_enter_class',
    params: {
      enter: { contract: 'orbis/completable', slot: 'status', in: ['done'] },
      set: { property: 'orbis/completed_at', value: { prop: 'orbis/updated_at' } },
    },
  });
  const byValue = (id: string) => ({
    id,
    template: 'on_enter_class',
    params: {
      enter: { property: 'orbis/task_status', in: ['waiting'] },
      on_leave: { unset: ['orbis/waiting_for'] },
    },
  });

  test('понижающее без актора — RULE_LOWERING_UNSCOPED (Р-27)', () => {
    expect(reasonOf(err(() => check(FIN, low())))).toBe('RULE_LOWERING_UNSCOPED');
    expect(levelOf(check(FIN, low({ actor: 'owner' })))).toBe('silent');
    expect(
      levelOf(check(FIN, low({ actor: { routine: '11111111-1111-4111-8111-111111111111' } }))),
    ).toBe('silent');
    expect(levelOf(check(FIN, low({ level: 'never' })))).toBe('never'); // повышающее актора не требует
  });
  test('два default на одно свойство — RULE_CONFLICT; на разные — нет; выключенное не спорит (§Б4-4)', () => {
    // `dflt` пишется БЕЗ `enabled` — так его пишет владелец и так лежит input-форма сида: читатель
    // снимка обязан достроить умолчание схемы, иначе `!rule.enabled` пропустил бы оба правила молча.
    // Свойство — `orbis/payment_method`, а не валюта: у `orbis/currency` с задачи 14 есть системный
    // писатель того же события (`envelope_currency_default` на конверте), и пара правил владельца
    // спорила бы уже с ним — это отдельный пин ниже.
    expect(
      err(() =>
        check(FIN, dflt('pm_a', 'orbis/payment_method'), [dflt('pm_b', 'orbis/payment_method')]),
      ).code,
    ).toBe('RULE_CONFLICT');
    expect(
      check(FIN, dflt('pm_a', 'orbis/payment_method'), [dflt('cp_b', 'orbis/counterparty')]).id,
    ).toBe('pm_a');
    expect(
      check(FIN, dflt('pm_a', 'orbis/payment_method'), [
        { ...dflt('pm_b', 'orbis/payment_method'), enabled: false },
      ]).id,
    ).toBe('pm_a');
  });
  test('своё умолчание валюты спорит с системной строкой конверта — ключ события общий на весь снимок', () => {
    const e = err(() => check(FIN, dflt('cur_a', 'orbis/currency'), []));
    expect([e.code, (e.details as { other?: string }).other]).toEqual([
      'RULE_CONFLICT',
      'envelope_currency_default',
    ]);
  });
  test('on_enter_class: ключуются ОБЕ формы события, вход и уход — разные ключи (Р-К-5)', () => {
    expect(err(() => check(TASK, byClass('t_a'), [byClass('t_b')])).code).toBe('RULE_CONFLICT');
    expect(err(() => check(TASK, byValue('w_a'), [byValue('w_b')])).code).toBe('RULE_CONFLICT');
    expect(check(TASK, byClass('t_a'), [byValue('w_a')]).id).toBe('t_a');
    // Имя теста стережётся ЭТОЙ парой: тот же класс и то же свойство, но одно правило пишет при ВХОДЕ, а
    // другое снимает при УХОДЕ — события разные, писатели не спорят. Ключ ухода, склеенный с ключом входа,
    // дал бы здесь ложный RULE_CONFLICT (мутация `leave|` → `enter|`).
    expect(
      check(TASK, byClass('t_a'), [
        {
          id: 't_b',
          template: 'on_enter_class',
          params: {
            enter: { contract: 'orbis/completable', slot: 'status', in: ['done'] },
            on_leave: { unset: ['orbis/completed_at'] },
          },
        },
      ]).id,
    ).toBe('t_a');
  });
  test('ключ события — по КАЖДОМУ элементу in: перестановка и пересечение классов — RULE_CONFLICT (Ф-Б2-15)', () => {
    // `in` — множество: оба правила пишут `completed_at` на переходе `active→done`, и порядок записи
    // списка или его лишний элемент приоритета между ними не вводят.
    const writer = (id: string, classes: string[]) => ({
      id,
      template: 'on_enter_class',
      params: {
        enter: { contract: 'orbis/completable', slot: 'status', in: classes },
        set: { property: 'orbis/completed_at', value: { prop: 'orbis/updated_at' } },
      },
    });
    expect(
      err(() =>
        check(TASK, writer('p_a', ['done', 'cancelled']), [writer('p_b', ['cancelled', 'done'])]),
      ).code,
    ).toBe('RULE_CONFLICT');
    expect(
      err(() => check(TASK, writer('x_a', ['done']), [writer('x_b', ['done', 'cancelled'])])).code,
    ).toBe('RULE_CONFLICT');
    // Непересекающиеся классы — разные события, конфликта нет.
    expect(check(TASK, writer('d_a', ['done']), [writer('d_b', ['cancelled'])]).id).toBe('d_a');
  });
  test('повтор внутри одного правила — не второй писатель: unset [x, x] принимается', () => {
    expect(
      check(TASK, {
        id: 'w_dup',
        template: 'on_enter_class',
        params: {
          enter: { property: 'orbis/task_status', in: ['waiting', 'waiting'] },
          on_leave: { unset: ['orbis/waiting_for', 'orbis/waiting_for'] },
        },
      }).id,
    ).toBe('w_dup');
  });
  test('RULE_CONFLICT: details.rule — ПРОВЕРЯЕМОЕ правило, other — его пара, при любом порядке в снимке', () => {
    // Проверяется ВТОРОЕ по порядку снимка: первым на носителе лежит `cur_b`, и отказ, собранный
    // «по порядку обхода», назвал бы проверяемым чужое правило.
    const e = err(() =>
      assertRule(dflt('cur_a', 'orbis/currency'), {
        reg: probe(FIN, [dflt('cur_b', 'orbis/currency'), dflt('cur_a', 'orbis/currency')]),
        carrier: FIN,
        systemSeed: true,
      }),
    );
    expect(e.details).toEqual({
      rule: 'cur_a',
      other: 'cur_b',
      event: 'create|orbis/currency',
      property: 'orbis/currency',
    });
  });
  test('ruleConflictsOf — чистая функция: её же зовёт слияние дельт (задача 16)', () => {
    const rows = [dflt('cur_a', 'orbis/currency'), dflt('cur_b', 'orbis/currency')].map((r) =>
      ruleDefinitionSchema.parse(r),
    );
    expect(ruleConflictsOf(rows)).toEqual([
      { a: 'cur_a', b: 'cur_b', event: 'create|orbis/currency', property: 'orbis/currency' },
    ]);
  });
});

describe('assertRule: unique_among (§Б4-3, строка 11 §С1-2)', () => {
  // Перенос из задачи 12 (рулинг Ф-Б2-14): снимок — проба `probe`, отказ — `err` этого файла.
  const carrier = { kind: 'aspect', id: 'orbis/budget' } as const;
  test('набор из свойств cardinality one принимается', () => {
    const rule = check(carrier, {
      id: 'u_ok',
      template: 'unique_among',
      params: { properties: ['orbis/period_start', 'orbis/currency'] },
    });
    expect(rule.template).toBe('unique_among');
  });
  test('свойство cardinality many в наборе → UNIQUE_ON_MANY с адресом свойства', () => {
    // `orbis/aliases` — text[] (`cardinality: many`, builtin-properties.ts): «то же значение» у
    // списка не определено, и правило, принявшее его, молча не сработало бы ни разу.
    const e = err(() =>
      check(
        { kind: 'aspect', id: 'orbis/category' },
        { id: 'u_many', template: 'unique_among', params: { properties: ['orbis/aliases'] } },
      ),
    );
    expect(e.code).toBe('UNIQUE_ON_MANY');
    expect(e.details).toMatchObject({ rule: 'u_many', property: 'orbis/aliases' });
  });
  test('when у unique_among → VALIDATION RULE_WHEN_UNSUPPORTED (рулинг 12-3)', () => {
    // Условие сделало бы вердикт зависимым от порядка записей: подмножество — это область-аспект.
    const e = err(() =>
      check(carrier, {
        id: 'u_when',
        template: 'unique_among',
        when: { op: '=', args: [{ prop: 'orbis/currency' }, { const: 'RUB' }] },
        params: { properties: ['orbis/period_start'] },
      }),
    );
    expect([e.code, reasonOf(e)]).toEqual(['VALIDATION', 'RULE_WHEN_UNSUPPORTED']);
  });
  test('json-свойство в наборе принимается: значение — один документ (рулинг 12-1)', () => {
    // `orbis/recurrence` — `kind: 'json'` без `cardinality`: равенство jsonb у документа определено,
    // и `UNIQUE_ON_MANY` о нём не говорит — он только про списки `cardinality: many`.
    const rule = check(
      { kind: 'aspect', id: 'orbis/schedule' },
      { id: 'u_json', template: 'unique_among', params: { properties: ['orbis/recurrence'] } },
    );
    expect(rule.template).toBe('unique_among');
  });
  test('правило на СВОЙСТВЕ без явного scope.aspect → RULE_TEMPLATE_CARRIER', () => {
    const e = err(() =>
      check(
        { kind: 'property', id: 'orbis/period_start' },
        { id: 'u_prop', template: 'unique_among', params: { properties: ['orbis/period_start'] } },
      ),
    );
    expect([e.code, (e.details as { reason?: string }).reason]).toEqual([
      'VALIDATION',
      'RULE_TEMPLATE_CARRIER',
    ]);
  });
});

describe('врезка на записи реестра (Р-3)', () => {
  const ping = {
    id: 'ping',
    template: 'default',
    params: { property: 'orbis/counterparty', value: { prop: 'orbis/payment_method' } },
  };
  const pong = {
    id: 'pong',
    template: 'default',
    params: { property: 'orbis/payment_method', value: { prop: 'orbis/counterparty' } },
  };
  test('круг «свойство → правило → свойство» — REGISTRY_CYCLE с путём', () => {
    const reg = probe(FIN, [ping, pong]);
    expect(() => assertRule(ping, { reg, carrier: FIN, systemSeed: true })).not.toThrow();
    const e = err(() => assertRulesOfRow(reg, FIN, true));
    expect([e.code, (e.details as { cycle: string[] }).cycle.length > 1]).toEqual([
      'REGISTRY_CYCLE',
      true,
    ]);
  });
  test('assertRulesOfRow проверяет ВСЕ правила строки', () => {
    expect(() => assertRulesOfRow(probe(FIN, [OCCURRED]), FIN, true)).not.toThrow();
    expect(
      reasonOf(err(() => assertRulesOfRow(probe(FIN, [OCCURRED, { ...OCCURRED }]), FIN, true))),
    ).toBe('RULE_ID_TAKEN');
  });
  test('assertBuiltinRules зелен на сиде с системными строками правил (задача 4)', () => {
    expect(() => assertBuiltinRules()).not.toThrow();
  });
  test('счёт системных правил: снимок из кода несёт ровно строки BUILTIN_RULES_BY_CARRIER (m-5)', () => {
    // Литерал, а не только равенство двух производных: снимок из кода собирается из той же карты, и
    // без числа молча пропавшая строка карты прошла бы оба счёта вдвоём. Равенство ловит обратное —
    // правило, доехавшее до снимка мимо карты (строкой в `builtin-*.ts`), или карту, которую сид
    // перестал читать.
    const declared = Object.values(BUILTIN_RULES_BY_CARRIER).flat();
    expect(declared.length).toBe(BUILTIN_RULE_COUNT);
    // Порядок `rulesOf` — порядок строк снимка, а не карты: сравнивается МНОЖЕСТВО id.
    expect(
      rulesOf(codeSnapshot())
        .map(({ rule }) => rule.id)
        .sort(),
    ).toEqual(declared.map((r) => r.id).sort());
  });
  test('живой снимок после db:prepare: каждое правило каждой системной строки проходит assertRule', async () => {
    // Сторож того, что БАЗА совпадает с кодом и после пересева: дрейф строк правил (`rules` — jsonb) не ловится
    // `registry-drift` по форме, только по содержимому — здесь оно и проверяется. Разобранный перечень
    // (`rulesOf`) здесь достаточен: неразобравшееся правило до снимка не доезжает вовсе — строку реестра
    // `load.ts` читает `.parse`'ом и падает на ней раньше (задача 2).
    const owner = await freshGraph();
    const reg = await withIdentity(db, personal(owner), (tx) => effectiveRegistry(tx, owner));
    // Свежий граф строк владельца не несёт — в снимке ровно системные правила, и их счёт обязан
    // совпасть с картой (m-5): база, не пересеянная после правки сида, красит этот пин.
    expect(rulesOf(reg).length).toBe(BUILTIN_RULE_COUNT);
    for (const { rule, carrier } of rulesOf(reg)) {
      expect(() => assertRule(rule, { reg, carrier, systemSeed: true })).not.toThrow();
    }
    expect(() => assertAcyclicGraph(dependencyGraph(reg, { queryRefs: new Map() }))).not.toThrow();
  });
});

describe('корпус RULE_FIXTURES (§С8-25, половина «валидатор»)', () => {
  test('RULE_FIXTURES: вердикт валидатора совпадает с объявленным, все 12 шаблонов покрыты', () => {
    // ИМЕННЫЕ фикстуры кодов (`RULE_CONFLICT`) кладут в `rule` ПАРУ правил МАССИВОМ: конфликт — свойство
    // СНИМКА, а не одной декларации, и одним объектом он невыразим. Первое идёт под проверку, остальные —
    // соседями по строке-носителю. Счёт шаблонов — только по не-массивным: поля `template` на верхнем
    // уровне у пары нет вовсе, и `undefined` раздул бы множество до тринадцати (тем же признаком такие
    // фикстуры исключает из счёта форм `ruleFormsOf`, 0c).
    expect(
      new Set(
        RULE_FIXTURES.filter((f) => !Array.isArray(f.rule)).map(
          (f) => (f.rule as { template: string }).template,
        ),
      ).size,
    ).toBe(12);
    for (const f of RULE_FIXTURES) {
      const c = f.carrier as RuleCarrier;
      const [head, ...rest] = Array.isArray(f.rule) ? f.rule : [f.rule];
      if (f.verdict.ok) {
        expect([f.name, check(c, head, rest).id]).toEqual([f.name, (head as { id: string }).id]);
        continue;
      }
      const e = err(() => check(c, head, rest));
      // `reason` сверяется, только когда фикстура его объявила: у словарного `VALIDATION` код один на
      // дюжину причин, и вердикт «VALIDATION» без причины подтвердил бы ЛЮБОЙ отказ валидатора.
      expect([f.name, e.code, f.verdict.reason === undefined ? undefined : reasonOf(e)]).toEqual([
        f.name,
        f.verdict.code,
        f.verdict.reason,
      ]);
    }
  });
});

describe('E-3 (б): адрес, поглощённый слиянием, — RULE_UNKNOWN_PROPERTY с cause: merged (финал Б-2, Ф-Б2-32)', () => {
  const SRC = 'user/e3-src';
  const INTO = 'user/e3-into';
  const due = BUILTIN_PROPERTY_META.find((d) => d.id === 'orbis/due_date');
  /** Проба, где у SRC `merged_into = INTO` (строка жива, §А10-3); правило лежит на `c`. */
  const mergedProbe = (c: RuleCarrier, rule: unknown): RegistrySnapshot => {
    const reg = probe(TASK, c.kind === 'aspect' ? [rule] : []);
    const row = (id: string, over: Record<string, unknown>) =>
      ({ ...due, id, key: id, graphId: 'g', module: null, rules: [], ...over }) as never;
    const properties = new Map(reg.properties)
      .set(
        SRC,
        row(SRC, { status: 'deprecated', mergedInto: INTO, rules: c.id === SRC ? [rule] : [] }),
      )
      .set(INTO, row(INTO, { status: 'active', mergedInto: null }));
    return { ...reg, properties };
  };
  const verdict = (c: RuleCarrier, rule: unknown) => {
    const e = err(() =>
      assertRule(rule, { reg: mergedProbe(c, rule), carrier: c, systemSeed: false }),
    );
    const d = e.details as { cause?: string; at?: string };
    return [reasonOf(e), d.cause, d.at];
  };
  const FORBID_DUE = { template: 'forbidden_when', params: { property: 'orbis/due_date' } };
  const merged = (at: string) => ['RULE_UNKNOWN_PROPERTY', 'merged', at];

  test('параметр, носитель, область, when и член $touched — отказ; цель слияния — принята', () => {
    expect(
      verdict(TASK, { id: 'e3_param', template: 'requires_when', params: { property: SRC } }),
    ).toEqual(merged('параметр'));
    // Область явная (аспект) — ловит именно ступень носителя, а не умолчательную область.
    expect(
      verdict(
        { kind: 'property', id: SRC },
        { id: 'e3_carrier', ...FORBID_DUE, scope: { aspect: 'orbis/task' } },
      ),
    ).toEqual(merged('носитель'));
    expect(verdict(TASK, { id: 'e3_scope', ...FORBID_DUE, scope: { property: SRC } })).toEqual(
      merged('область'),
    );
    expect(verdict(TASK, { id: 'e3_when', ...FORBID_DUE, when: { has: SRC } })).toEqual(
      merged('aspect:orbis/task.rules.e3_when.when'),
    );
    expect(
      verdict(TASK, {
        id: 'e3_touched',
        template: 'assign_level',
        params: {},
        level: 'show',
        when: { op: 'in', args: [{ const: SRC }, { ctx: '$touched' }] },
      }),
    ).toEqual(merged('aspect:orbis/task.rules.e3_touched.when'));
    const live = { id: 'e3_ok', template: 'requires_when', params: { property: INTO } };
    expect(
      assertRule(live, { reg: mergedProbe(TASK, live), carrier: TASK, systemSeed: false }).id,
    ).toBe('e3_ok');
  });
});

describe('формы, которых исполнитель правил не умеет, — отказ на записи правила (финал Б-2, Ф-Б2-33)', () => {
  test('E-5: предикатный набор и has_relation.in_set — EXPR_TYPE с адресом правила; набор списком — законен', () => {
    const MM = { class: { contract: 'orbis/money-movement' } };
    const facts = { op: 'in', args: [MM, { const: 'facts' }] };
    const inSet = {
      has_relation: {
        role: 'instance-of',
        in_set: { contract: 'orbis/recurrence', set: 'templates' },
      },
    };
    // Правило «факт требует категорию»: принятое, оно отказывало бы EXPR_BACKEND_UNSUPPORTED каждой записи финансов.
    const e = err(() =>
      check(FIN, {
        id: 'facts_need_category',
        template: 'requires_when',
        when: facts,
        params: { property: 'orbis/finance_category' },
      }),
    );
    expect([e.code, (e.details as { site?: string }).site]).toEqual([
      'EXPR_TYPE',
      'aspect:orbis/financial.rules.facts_need_category.when',
    ]);
    expect(err(() => check(FIN, { ...OCCURRED, when: inSet })).code).toBe('EXPR_TYPE');
    // T-правило и assign_level исполняет тот же интерпретатор (`rules/engine.ts`, `policy/assign-level.ts`).
    expect(
      err(() =>
        check(FIN, {
          id: 'def_cp',
          template: 'default',
          when: facts,
          params: { property: 'orbis/counterparty', value: { const: 'банк' } },
        }),
      ).code,
    ).toBe('EXPR_TYPE');
    expect(
      err(() =>
        check(FIN, {
          id: 'lvl',
          template: 'assign_level',
          params: {},
          level: 'discuss',
          when: facts,
        }),
      ).code,
    ).toBe('EXPR_TYPE');
    // Набор СПИСКОМ — законен.
    expect(
      check(FIN, { ...OCCURRED, when: { op: 'in', args: [MM, { const: 'outflow' }] } }).id,
    ).toBe('fin_occurred');
  });

  test('E-6: литерал значения T-правила — по схеме свойства тем же валидатором, что стадия 2 (RULE_VALUE_TYPE)', () => {
    const status = (value: unknown) => ({
      id: 'own_status',
      template: 'default',
      params: { property: 'orbis/task_status', value },
    });
    // Метка варианта вместо ключа: род тот же (select → text), варианта «Inbox» нет — стадия 2 отказала бы каждой задаче без статуса.
    const e = err(() => check(TASK, status({ const: 'Inbox' })));
    expect([e.code, reasonOf(e)]).toEqual(['VALIDATION', 'RULE_VALUE_TYPE']);
    expect(e.details).toMatchObject({
      property: 'orbis/task_status',
      violations: [{ code: 'TYPE', propertyId: 'orbis/task_status' }],
    });
    expect(check(TASK, status({ const: 'inbox' })).id).toBe('own_status');
    // Плечо if — тоже литерал, который движок пишет буквально.
    expect(
      reasonOf(
        err(() =>
          check(
            TASK,
            status({
              op: 'if',
              args: [{ has: 'orbis/due_date' }, { const: 'planned' }, { const: 'Inbox' }],
            }),
          ),
        ),
      ),
    ).toBe('RULE_VALUE_TYPE');
    // Дата-литерал в timestamp: чекер приводит его к timestamp (для сравнения законно), стадия 2 — нет.
    expect(
      reasonOf(
        err(() =>
          check(
            { kind: 'aspect', id: 'orbis/schedule' },
            {
              id: 'own_start',
              template: 'default',
              params: { property: 'orbis/start_at', value: { const: '2026-01-01' } },
            },
          ),
        ),
      ),
    ).toBe('RULE_VALUE_TYPE');
    // ref без uuid и set перехода — та же сверка.
    expect(
      reasonOf(
        err(() =>
          check(FIN, {
            id: 'own_cat',
            template: 'default',
            params: { property: 'orbis/finance_category', value: { const: 'Еда' } },
          }),
        ),
      ),
    ).toBe('RULE_VALUE_TYPE');
    expect(
      reasonOf(
        err(() =>
          check(TASK, {
            id: 'own_enter',
            template: 'on_enter_class',
            params: {
              enter: { property: 'orbis/task_status', in: ['waiting'] },
              set: { property: 'orbis/priority', value: { const: 'Высокий' } },
            },
          }),
        ),
      ),
    ).toBe('RULE_VALUE_TYPE');
  });

  test('E-7: core-проекция в адресе параметра шаблона записи — RULE_UNKNOWN_PROPERTY с cause core; в when и значении — законна', () => {
    const NOTE: RuleCarrier = { kind: 'aspect', id: 'orbis/note' };
    const WHEN = { op: '=', args: [{ prop: 'orbis/archived' }, { const: false }] };
    const refused = (carrier: RuleCarrier, rule: unknown) => {
      const e = err(() => check(carrier, rule));
      return [e.code, reasonOf(e), (e.details as { cause?: string }).cause];
    };
    const CORE = ['VALIDATION', 'RULE_UNKNOWN_PROPERTY', 'core'];
    const enterDone = { property: 'orbis/task_status', in: ['done'] };
    expect(
      refused(NOTE, { id: 'u', template: 'unique_among', params: { properties: ['orbis/title'] } }),
    ).toEqual(CORE);
    expect(
      refused(NOTE, {
        id: 'r',
        template: 'requires_when',
        when: WHEN,
        params: { property: 'orbis/title' },
      }),
    ).toEqual(CORE);
    expect(
      refused(NOTE, {
        id: 'f',
        template: 'forbidden_when',
        params: { property: 'orbis/archived' },
      }),
    ).toEqual(CORE);
    expect(
      refused(NOTE, {
        id: 'd',
        template: 'default',
        params: { property: 'orbis/title', value: { const: 'Без названия' } },
      }),
    ).toEqual(CORE);
    expect(
      refused(TASK, {
        id: 'e',
        template: 'on_enter_class',
        params: { enter: enterDone, set: { property: 'orbis/archived', value: { const: true } } },
      }),
    ).toEqual(CORE);
    expect(
      refused(TASK, {
        id: 'l',
        template: 'on_enter_class',
        params: { enter: enterDone, on_leave: { unset: ['orbis/archived'] } },
      }),
    ).toEqual(CORE);
    expect(
      refused(TASK, {
        id: 'v',
        template: 'on_enter_class',
        params: {
          enter: { property: 'orbis/title', in: ['x'] },
          set: { property: 'orbis/due_date', value: { const: '2026-12-31' } },
        },
      }),
    ).toEqual(CORE);
    // Область {property} правила записи (здесь — умолчанием носителя-свойства) — тот же адрес.
    expect(
      refused(
        { kind: 'property', id: 'orbis/updated_at' },
        {
          id: 'p',
          template: 'default',
          params: { property: 'orbis/due_date', value: { const: '2026-12-31' } },
        },
      ),
    ).toEqual(CORE);
    // Законно (Р-И-3): core в when и в ЗНАЧЕНИИ — `entityEvalScope` кладёт её в область.
    expect(
      check(NOTE, {
        id: 'w',
        template: 'requires_when',
        params: { property: 'orbis/task_status' },
        when: { op: '=', args: [{ prop: 'orbis/title' }, { const: 'x' }] },
      }).id,
    ).toBe('w');
    expect(
      check(TASK, {
        id: 's',
        template: 'on_enter_class',
        params: {
          enter: enterDone,
          set: { property: 'orbis/completed_at', value: { prop: 'orbis/updated_at' } },
        },
      }).id,
    ).toBe('s');
  });
});
