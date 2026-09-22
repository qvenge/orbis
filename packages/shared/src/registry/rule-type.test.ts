// packages/shared/src/registry/rule-type.test.ts
// Форма правила каталога §Б4-1: состав шаблонов, карта уровней Р-6, умолчания и два условия
// `superRefine`. Тесты чистые — ни базы, ни реестра: схема про ФОРМУ, а не про ссылки.
import { describe, expect, test } from 'bun:test';
import {
  RULE_ID_RE,
  RULE_LEVEL_TO_CONFIRMATION,
  RULE_LEVELS,
  RULE_TEMPLATES,
  ruleDefinitionSchema,
} from './rule-type';

describe('форма правила §Б4-1', () => {
  test('двенадцать шаблонов §Б4-3 и карта уровней Р-6', () => {
    expect(RULE_TEMPLATES.length).toBe(12);
    expect(Object.keys(RULE_LEVEL_TO_CONFIRMATION)).toEqual([...RULE_LEVELS]);
    expect(RULE_LEVEL_TO_CONFIRMATION.discuss).toBe('explicit-confirmation');
  });

  test('умолчания формы: enabled=true, undo=check (fail-closed)', () => {
    const r = ruleDefinitionSchema.parse({
      id: 'probe',
      template: 'requires_when',
      params: { property: 'orbis/occurred_on' },
    });
    expect([r.enabled, r.undo]).toEqual([true, 'check']);
  });

  test('assign_level без when не разбирается; on_enter_class без set и on_leave — тоже', () => {
    expect(
      ruleDefinitionSchema.safeParse({
        id: 'a',
        template: 'assign_level',
        params: {},
        level: 'silent',
      }).success,
    ).toBe(false);
    expect(
      ruleDefinitionSchema.safeParse({
        id: 'b',
        template: 'on_enter_class',
        params: { enter: { contract: 'orbis/completable', slot: 'status', in: ['done'] } },
      }).success,
    ).toBe(false);
  });

  test('лишний ключ — отказ (strict): опечатка не уезжает в jsonb молча', () => {
    expect(
      ruleDefinitionSchema.safeParse({
        id: 'c',
        template: 'requires_when',
        params: { property: 'orbis/occurred_on' },
        levl: 'silent',
      }).success,
    ).toBe(false);
  });

  test('id — ASCII-слаг: пробел и заглавная не разбираются, дефис и подчёркивание законны', () => {
    // Регулярка пиннится ОБЕИМИ сторонами: без положительной половины «ничего не проходит»
    // читалось бы как «форма строгая».
    expect([RULE_ID_RE.test('task_completed_at'), RULE_ID_RE.test('duplicate-envelope')]).toEqual([
      true,
      true,
    ]);
    const bad = (id: string) =>
      ruleDefinitionSchema.safeParse({
        id,
        template: 'requires_when',
        params: { property: 'orbis/occurred_on' },
      }).success;
    expect([bad('two words'), bad('TaskCompletedAt')]).toEqual([false, false]);
  });
});
