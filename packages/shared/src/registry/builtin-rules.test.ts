// packages/shared/src/registry/builtin-rules.test.ts
// Системные строки каталога правил (§Б4-1) — ФОРМА: каждая строка разбирается схемой, id уникальны
// по всей карте, носители — существующие аспекты и роли. Ссылки внутри правила (свойства, контракт, роль)
// проверяет валидатор сервера над снимком (`assertBuiltinRules`, `registry/rules.test.ts`): схема
// про форму, а не про реестр.
import { describe, expect, test } from 'bun:test';
import { BUILTIN_ASPECT_DEFS } from './builtin-aspects';
import { BUILTIN_RELATION_ROLE_META } from './builtin-roles';
import {
  BUILTIN_RULES_BY_CARRIER,
  RULE_ENVELOPE_UNIQUE,
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
      'duplicate_envelope',
      // Задача 13: носители параметров движков. `nearest_ancestor` — то же имя, что во
      // `flags.computed.rule` вычисляемых свойств и в журнале пересчёта (`RULE_NEAREST_ANCESTOR`).
      'budget_rollover',
      'nearest_ancestor',
      'materialize',
      'mirror_ref',
      // …и метки ролевых ограничений: значение живёт в `role.constraints`, строка его не дублирует.
      'dependency_acyclic',
      'category_parent_acyclic',
      'envelope_binding_max_incoming',
    ]);
  });

  test('id уникальны среди всех правил карты', () => {
    expect(new Set(ALL_RULES.map((r) => r.id)).size).toBe(ALL_RULES.length);
  });

  test('ключи карты — существующие встроенные аспекты либо роли; ролевые шаблоны — только на ролях', () => {
    const aspects = new Set(BUILTIN_ASPECT_DEFS.map((a) => a.id));
    const roles = new Set(BUILTIN_RELATION_ROLE_META.map((r) => r.id));
    const ROLE_TEMPLATES = new Set(['acyclic', 'target_max_incoming', 'mirror_relation']);
    for (const [carrier, rules] of Object.entries(BUILTIN_RULES_BY_CARRIER)) {
      const kind = aspects.has(carrier) ? 'aspect' : roles.has(carrier) ? 'role' : 'нет такого';
      expect(`${carrier}: ${kind}`).not.toBe(`${carrier}: нет такого`);
      for (const rule of rules) {
        const want = ROLE_TEMPLATES.has(rule.template) ? 'role' : 'aspect';
        expect(`${rule.id}@${kind}`).toBe(`${rule.id}@${want}`);
      }
    }
  });

  test('откат: C-строки названы `check` ЯВНО, T-строка берёт умолчание (Р-И-2)', () => {
    // Явное `undo` у C-строк — решение по экземпляру, а не умолчание: снятое схемой поле молча
    // сменило бы политику отката инварианта. У конверта `check` — слово владельца (В-П-1а): откат
    // при уже созданном дубле отклоняется.
    expect([
      RULE_FINANCIAL_REQUIRES_OCCURRED_ON.undo,
      RULE_FINANCIAL_RECURRING_REQUIRES_RECURRENCE.undo,
      RULE_TASK_COMPLETED_AT.undo,
      RULE_ENVELOPE_UNIQUE.undo,
    ]).toEqual(['check', 'check', undefined, 'check']);
  });
});
