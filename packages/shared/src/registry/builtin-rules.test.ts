// packages/shared/src/registry/builtin-rules.test.ts
// Системные строки каталога правил (§Б4-1) — ФОРМА: каждая строка разбирается схемой, id уникальны
// по всей карте, носители — существующие аспекты. Ссылки внутри правила (свойства, контракт, роль)
// проверяет валидатор сервера над снимком (`assertBuiltinRules`, `registry/rules.test.ts`): схема
// про форму, а не про реестр.
import { describe, expect, test } from 'bun:test';
import { BUILTIN_ASPECT_DEFS } from './builtin-aspects';
import {
  BUILTIN_RULES_BY_CARRIER,
  RULE_FINANCIAL_RECURRING_REQUIRES_RECURRENCE,
  RULE_FINANCIAL_REQUIRES_OCCURRED_ON,
  RULE_TASK_COMPLETED_AT,
} from './builtin-rules';
import { ruleDefinitionSchema } from './rule-type';

const ALL_RULES = Object.values(BUILTIN_RULES_BY_CARRIER).flat();

describe('системные строки каталога правил (§Б4-1)', () => {
  test('каждая строка проходит ruleDefinitionSchema; id — прежние коды отказов (Р-К-1)', () => {
    for (const rule of ALL_RULES) {
      expect(() => ruleDefinitionSchema.parse(rule)).not.toThrow();
    }
    expect(ALL_RULES.map((r) => r.id)).toEqual([
      'financial_requires_occurred_on',
      'financial_recurring_requires_recurrence',
      'task_completed_at',
    ]);
  });

  test('id уникальны среди всех правил карты', () => {
    expect(new Set(ALL_RULES.map((r) => r.id)).size).toBe(ALL_RULES.length);
  });

  test('ключи карты — существующие встроенные аспекты', () => {
    const aspects = new Set(BUILTIN_ASPECT_DEFS.map((a) => a.id));
    for (const carrier of Object.keys(BUILTIN_RULES_BY_CARRIER)) {
      expect(`${carrier}: ${aspects.has(carrier)}`).toBe(`${carrier}: true`);
    }
  });

  test('откат: C-строки названы `check` ЯВНО, T-строка берёт умолчание (Р-И-2)', () => {
    // Явное `undo` у C-строк — решение по экземпляру, а не умолчание: снятое схемой поле молча
    // сменило бы политику отката инварианта.
    expect([
      RULE_FINANCIAL_REQUIRES_OCCURRED_ON.undo,
      RULE_FINANCIAL_RECURRING_REQUIRES_RECURRENCE.undo,
      RULE_TASK_COMPLETED_AT.undo,
    ]).toEqual(['check', 'check', undefined]);
  });
});
