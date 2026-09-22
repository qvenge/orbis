// apps/server/src/registry/rules.test.ts
// Валидатор декларации правила (§Б4-1/3, Р-И-21) — юнитом по снимку-пробе: правило кладётся на
// строку-носитель встроенного словаря так, как его увидит читатель ПОСЛЕ записи.
import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_ASPECT_DEFS,
  BUILTIN_CONTRACT_DEFS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
  type RuleDefinition,
  type RuleDefinitionInput,
} from '@orbis/shared';
import { DEREF_IN_CONSTRAINT, SECOND_LANGUAGE } from '@orbis/shared/expr';
import { ExecError } from '../errors';
import type { RegistrySnapshot } from './load';
import { assertRule, type RuleCarrier } from './rules';

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
    ownerVersion: 1,
    systemVersion: 1,
  };
}
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
const MIRROR = {
  id: 'mirror_ref',
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
    // КОРНЕВОЙ литерал: `{const:'0.00'}` сам по себе типизируется `text` (соседа у него нет,
    // `check.ts` ветка `const`), и без приведения ПО ПОЗИЦИИ законная строка сида отказывала бы RULE_VALUE_TYPE.
    expect(check(FIN, def({ const: '0.00' })).template).toBe('default');
    expect(reasonOf(err(() => check(FIN, def({ const: 'не-число' }))))).toBe('RULE_VALUE_TYPE');
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
