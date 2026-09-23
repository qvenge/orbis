// apps/server/src/registry/actions.test.ts
// Валидатор декларации действия (§Б6-1/§Б6-3) против снимка ЖИВОЙ базы: привязки контрактов, по
// которым считается `touches_money`, и словарь действий, по которому проверяется занятость `key`,
// приезжают из сида, а не из литерала теста.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { actionToolName, BUILTIN_ACTION_DEFS } from '@orbis/shared';
import { appDb, mintGraph, personal, requireEnv, truncateAll } from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
// Имена реестровых тулов читаются, а не правятся (tools/* — задача 7): пин рулинга 6-1 обязан
// видеть и тулы, которые заведут следующие задачи, а не список, переписанный сюда руками.
import { REGISTRY_TOOL_NAMES } from '../tools/registry-tools';
import { assertAction } from './actions';
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
