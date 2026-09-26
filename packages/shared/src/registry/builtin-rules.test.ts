// packages/shared/src/registry/builtin-rules.test.ts
// Системные строки каталога правил (§Б4-1) — ФОРМА: каждая строка разбирается схемой, id уникальны
// по всей карте, носители — существующие аспекты и роли. Ссылки внутри правила (свойства, контракт, роль)
// проверяет валидатор сервера над снимком (`assertBuiltinRules`, `registry/rules.test.ts`): схема
// про форму, а не про реестр.
import { describe, expect, test } from 'bun:test';
import { BUILTIN_ASPECT_DEFS } from './builtin-aspects';
import { BUILTIN_RELATION_ROLE_META } from './builtin-roles';
import {
  BUILTIN_RULE_REQUIRES,
  BUILTIN_RULES_BY_CARRIER,
  RULE_ASSIGNMENT_GRANT_FORBIDDEN,
  RULE_ASSIGNMENT_GRANT_REQUIRED,
  RULE_ENVELOPE_CURRENCY_DEFAULT,
  RULE_ENVELOPE_UNIQUE,
  RULE_FINANCIAL_RECURRING_REQUIRES_RECURRENCE,
  RULE_FINANCIAL_REQUIRES_OCCURRED_ON,
  RULE_MEMORY_RULE_PATTERN,
  RULE_MEMORY_RULE_TARGET,
  RULE_PAGE_WINS_OVER_NEEDS_TEMPLATE,
  RULE_PAGE_WINS_OVER_NOT_SELF,
  RULE_RUN_SUBJECT_FORBIDDEN,
  RULE_RUN_SUBJECT_REQUIRED,
  RULE_TASK_COMPLETED_AT,
  RULE_TASK_STATUS_DEFAULT,
  RULE_TASK_WAITING_FOR,
  RULE_TASK_WAITING_ONLY,
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
      // Задача 14: «чего ждём» — пара строк по классу `waiting` контракта делегирования (В-П-8 (в)).
      'waiting_for',
      'waiting_for_only_when_waiting',
      // Срез 1б задача 3: возврат из закрытия — `inbox` строкой `default` каталога (Б-2 №98).
      'task_status_default',
      'duplicate_envelope',
      // Задача 13: носители параметров движков. `nearest_ancestor` — то же имя, что во
      // `flags.computed.rule` вычисляемых свойств и в журнале пересчёта (`RULE_NEAREST_ANCESTOR`).
      'budget_rollover',
      // Задача 14: умолчание валюты конверта (`default` с `{param}`, В-П-3) — третья строка конверта.
      'envelope_currency_default',
      // Задача 14: условие гранта назначения (живость гранта — кодом, Р-К-17) и XOR субъекта
      // прогона — парами (§4-Б-9 рамки: тринадцатый шаблон не заводится).
      'assignment_grant_required',
      'assignment_grant_forbidden',
      'run_subject',
      'run_subject_forbidden',
      // …и форма правила памяти: две условные обязательности (область — признак в props).
      'memory_rule_pattern',
      'memory_rule_target',
      'nearest_ancestor',
      'materialize',
      // Срез 1а §3.2: «Главнее, чем» только у шаблона; ссылка на себя — отказ.
      'page_wins_over_needs_template_for',
      'page_wins_over_not_self',
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

  test('откат: C-строки названы ЯВНО, T-строки берут умолчание (Р-И-2)', () => {
    // Явное `undo` у C-строк — решение по экземпляру, а не умолчание: снятое схемой поле молча
    // сменило бы политику отката инварианта. У конверта `check` — слово владельца (В-П-1а): откат
    // при уже созданном дубле отклоняется; субъект прогона и грант назначения — `skip` (§А7-2
    // ревизии 5: снятый код под откатом не звался); форма правила памяти — `check` (снятый код стоял
    // в стадии 2, а она под откатом исполняется).
    expect([
      RULE_FINANCIAL_REQUIRES_OCCURRED_ON.undo,
      RULE_FINANCIAL_RECURRING_REQUIRES_RECURRENCE.undo,
      RULE_TASK_COMPLETED_AT.undo,
      RULE_ENVELOPE_UNIQUE.undo,
      RULE_TASK_WAITING_FOR.undo,
      RULE_TASK_WAITING_ONLY.undo,
      RULE_RUN_SUBJECT_REQUIRED.undo,
      RULE_RUN_SUBJECT_FORBIDDEN.undo,
      RULE_ASSIGNMENT_GRANT_REQUIRED.undo,
      RULE_ASSIGNMENT_GRANT_FORBIDDEN.undo,
      RULE_MEMORY_RULE_PATTERN.undo,
      RULE_MEMORY_RULE_TARGET.undo,
      RULE_ENVELOPE_CURRENCY_DEFAULT.undo,
      RULE_PAGE_WINS_OVER_NEEDS_TEMPLATE.undo,
      RULE_PAGE_WINS_OVER_NOT_SELF.undo,
      RULE_TASK_STATUS_DEFAULT.undo,
    ]).toEqual([
      'check',
      'check',
      undefined,
      'check',
      undefined,
      'check',
      'skip',
      'skip',
      'skip',
      'skip',
      'check',
      'check',
      undefined,
      'check',
      'check',
      undefined,
    ]);
  });

  test('зависимости включённости называют существующие правила ОДНОГО носителя (Fable M-2 задачи 14)', () => {
    // Сторож записи (`registry/ops.ts`) спрашивает пару по снимку: имя, которого в каталоге нет, делало
    // бы зависимость вечно невыполненной (запись правил падала бы), а пара на двух носителях — не пара.
    const carrierOf = new Map(
      Object.entries(BUILTIN_RULES_BY_CARRIER).flatMap(([c, rules]) => rules.map((r) => [r.id, c])),
    );
    expect(Object.keys(BUILTIN_RULE_REQUIRES)).toEqual(['waiting_for_only_when_waiting']);
    for (const [rule, needs] of Object.entries(BUILTIN_RULE_REQUIRES)) {
      for (const need of needs) {
        expect([rule, carrierOf.get(need)]).toEqual([rule, carrierOf.get(rule)]);
      }
    }
    expect(BUILTIN_RULE_REQUIRES[RULE_TASK_WAITING_ONLY.id]).toEqual([RULE_TASK_WAITING_FOR.id]);
  });
});
