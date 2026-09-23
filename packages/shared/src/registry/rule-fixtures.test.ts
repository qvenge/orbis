// packages/shared/src/registry/rule-fixtures.test.ts
// Полнота словаря фикстур (§С8-25) и состав одиннадцати правил §Б4-5 (§С8-26). Исполняет вердикты
// валидатор задачи 1 — здесь пиннится то, что объявлено данными.
import { describe, expect, test } from 'bun:test';
import { ASSIGN_LEVEL_RULES, RULE_FIXTURES, ruleFormsOf } from './rule-fixtures';
import { ruleDefinitionSchema } from './rule-type';

describe('§С8-25: словарь фикстур правил', () => {
  test('§С8-25: у каждого из 12 шаблонов есть и позитив, и негатив', () => {
    expect(
      [...ruleFormsOf(RULE_FIXTURES)]
        .filter(([, c]) => c.positive === 0 || c.negative === 0)
        .map(([t]) => t),
    ).toEqual([]);
  });

  test('позитивы разбираются схемой формы; имена уникальны', () => {
    // Негативы разбираться НЕ обязаны: половина их кодов (RULE_CONFLICT, UNIQUE_ON_MANY,
    // DEREF_IN_CONSTRAINT) — про реестр и область E, а не про форму.
    for (const f of RULE_FIXTURES.filter((x) => x.verdict.ok)) {
      expect(`${f.name}: ${ruleDefinitionSchema.safeParse(f.rule).success}`).toBe(
        `${f.name}: true`,
      );
    }
    expect(new Set(RULE_FIXTURES.map((f) => f.name)).size).toBe(RULE_FIXTURES.length);
  });
});

describe('§С8-26: одиннадцать правил §Б4-5 каноном', () => {
  test('§С8-26: тринадцать записей на одиннадцать правил, id уникальны', () => {
    expect(ASSIGN_LEVEL_RULES.length).toBe(13);
    expect(new Set(ASSIGN_LEVEL_RULES.map((r) => r.n.replace(/[ab]$/, ''))).size).toBe(11);
    expect(new Set(ASSIGN_LEVEL_RULES.map((r) => r.rule.id)).size).toBe(13);
  });

  test('каждое правило §Б4-5 разбирается схемой формы — язык E вырос на empty и $touched', () => {
    for (const r of ASSIGN_LEVEL_RULES) {
      expect(`${r.n}: ${ruleDefinitionSchema.safeParse(r.rule).success}`).toBe(`${r.n}: true`);
    }
  });

  test('каждое правило §Б4-5 — шаблона assign_level и с обязательным when', () => {
    for (const r of ASSIGN_LEVEL_RULES) {
      expect(`${r.n}: ${r.rule.template}/${r.rule.when === undefined}`).toBe(
        `${r.n}: assign_level/false`,
      );
    }
  });
});
