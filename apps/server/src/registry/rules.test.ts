// apps/server/src/registry/rules.test.ts
// Валидатор декларации правила (§Б4-1/3, Р-И-21) — юнитом по снимку-пробе: правило кладётся на
// строку-носитель встроенного словаря так, как его увидит читатель ПОСЛЕ записи.
import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_ASPECT_DEFS,
  BUILTIN_CONTRACT_DEFS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
  type RuleDefinitionInput,
} from '@orbis/shared';
import { SECOND_LANGUAGE } from '@orbis/shared/expr';
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
