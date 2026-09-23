// apps/server/src/policy/assign-level.test.ts
// §С8-26: одиннадцать правил делегирования «дня мечты» (§Б4-5) дают ожидаемые уровни — приёмка
// ВЫРАЗИМОСТИ, а не подключения: живой конвейер §7.10 правил не знает (V2), и оценочная область
// `assignLevelOf` зовётся только отсюда. Пол понижения (Р-27) пиннится здесь же — он и есть та
// граница, которую правило владельца пробить не вправе.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ASSIGN_LEVEL_RULES, type GraphId, ruleDefinitionSchema } from '@orbis/shared';
import {
  seedTestWorld,
  TEST_CALL_ASPECT,
  TEST_CONTACT_ASPECT,
  TEST_ROLE_PARTICIPANT,
} from '../../test/fixtures/test-seed';
import {
  appDb,
  freshGraph,
  personal,
  requireEnv,
  seedCustomAspect,
  seedCustomRole,
  truncateAll,
} from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import { effectiveRegistry } from '../registry/cache';
import type { RegistrySnapshot } from '../registry/load';
import { assertRule } from '../registry/rules';
import type { ToolCallFacts } from './confirmation';
import { floorLevel, LEVEL_ORDER, stricter } from './floor';

requireEnv();
const { db, client } = appDb();
afterAll(async () => {
  await client.end();
});
/** Владелец мира §С8-26 — `freshGraph()` в хуке (Ф-Б2-9): модульный id без хука не рождает строку графа. */
let owner: GraphId;
let reg: RegistrySnapshot; // снимок с синтетическим сидом §С8-26
let regWithRules: RegistrySnapshot; // он же + тринадцать строк правил на носителях
let verdicts: Array<{ ok: true } | { ok: false; code: string; reason?: string }> = [];

/** Правила приёмки живут ФИКСТУРОЙ, а не сидом (Р-И-36): `test/*` в живой путь не идут. */
function withRules(base: RegistrySnapshot): RegistrySnapshot {
  const aspects = new Map(base.aspects);
  for (const { carrier, rule } of ASSIGN_LEVEL_RULES) {
    if (carrier.kind !== 'aspect') {
      throw new Error(`фикстура §С8-26: носитель ${carrier.kind} не предусмотрен`);
    }
    const row = aspects.get(carrier.id);
    if (row === undefined) throw new Error(`фикстура §С8-26: аспекта ${carrier.id} нет в снимке`);
    aspects.set(carrier.id, { ...row, rules: [...row.rules, ruleDefinitionSchema.parse(rule)] });
  }
  return { ...base, aspects };
}

beforeAll(async () => {
  await truncateAll();
  owner = await freshGraph();
  // Словарь приёмки — строки ВЛАДЕЛЬЦА, не сид: мир ссылается на них, и без них его не посеять
  // (тот же порядок, что у `test/test-seed.test.ts`).
  await seedCustomAspect(owner, TEST_CONTACT_ASPECT);
  await seedCustomAspect(owner, TEST_CALL_ASPECT);
  await seedCustomRole(owner, TEST_ROLE_PARTICIPANT);
  await seedTestWorld(owner);
  reg = await withIdentity(db, personal(owner), (tx) => effectiveRegistry(tx, owner));
  regWithRules = withRules(reg);
  verdicts = ASSIGN_LEVEL_RULES.map(({ carrier, rule }) => {
    try {
      assertRule(rule, { reg: regWithRules, carrier, systemSeed: false });
      return { ok: true as const };
    } catch (e) {
      const { code, details } = e as { code?: unknown; details?: { reason?: unknown } };
      return details?.reason === undefined
        ? { ok: false as const, code: String(code) }
        : { ok: false as const, code: String(code), reason: String(details.reason) };
    }
  });
});

const FACTS = (over: Partial<ToolCallFacts> = {}): ToolCallFacts => ({
  tool: 'entity_update',
  kind: 'mutate',
  known: true,
  actorKind: 'ai',
  explicitCommand: false,
  archives: false,
  isBatch: false,
  grantsAutonomy: false,
  reconfigures: 'none',
  sensitivity: [],
  ...over,
});

describe('пол понижения §С2-1 (Р-27): три ряда таблицы и запрет по объекту', () => {
  test('порядок строгости — единственный, и он полон', () => {
    expect(LEVEL_ORDER).toEqual(['execute', 'preview', 'explicit-confirmation', 'forbidden']);
    expect(stricter('preview', 'execute')).toBe('preview');
    expect(stricter('explicit-confirmation', 'forbidden')).toBe('forbidden');
    expect(stricter('preview', 'preview')).toBe('preview');
  });
  test('ряды 1/4/6 дают пол, обычная мутация — не даёт', () => {
    expect(floorLevel(FACTS({ known: false }))).toBe('forbidden');
    expect(floorLevel(FACTS({ reconfigures: 'behavior-delta' }))).toBe('explicit-confirmation');
    expect(floorLevel(FACTS({ reconfigures: 'system-object' }))).toBe('explicit-confirmation');
    expect(floorLevel(FACTS({ grantsAutonomy: true }))).toBe('explicit-confirmation');
    // Владельцу автономию выдаёт он сам — ряд 6 по актору ветвится (`classifyToolCall`).
    expect(floorLevel(FACTS({ grantsAutonomy: true, actorKind: 'owner' }))).toBeNull();
    // Ряд 5 (масштаб) и ряд 3 (архивация) в пол НЕ входят: их правило понижать вправе (В-2).
    expect(floorLevel(FACTS({ isBatch: true, batchSize: 40 }))).toBeNull();
    expect(floorLevel(FACTS({ archives: true }))).toBeNull();
    expect(floorLevel(FACTS(), true)).toBe('forbidden');
  });
});

describe('§С8-26: одиннадцать правил делегирования проходят валидатор', () => {
  test('тринадцать строк на одиннадцать номеров — правила 8 и 10 разложены на два (Р-5)', () => {
    expect(ASSIGN_LEVEL_RULES.length).toBe(13);
    // Номер правила — без суффикса разложения ('8a' → '8'): мерка §С8-26 — одиннадцать НОМЕРОВ, а не строк.
    expect(new Set(ASSIGN_LEVEL_RULES.map((r) => r.n.replace(/[ab]$/, ''))).size).toBe(11);
  });
  test('каждая строка принята валидатором — без нового шаблона каталога', () => {
    for (const [i, v] of verdicts.entries()) {
      expect(v, `${ASSIGN_LEVEL_RULES[i]?.name}`).toEqual({ ok: true });
      expect(ASSIGN_LEVEL_RULES[i]?.rule.template).toBe('assign_level');
    }
  });
  // Отказ `RULE_LOWERING_UNSCOPED` (понижающее правило без `actor`, Р-27) пинит ВАЛИДАТОР
  // задачи 1 (`registry/rules.test.ts`) — второй копии того же утверждения здесь не заводится.
});
