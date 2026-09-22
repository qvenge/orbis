// apps/server/src/policy/assign-level.test.ts
// §С8-26: одиннадцать правил делегирования дают ожидаемые уровни. Сегодня ложно — модуля
// `policy/assign-level` нет вовсе; пометку снимает задача 15, кладущая оценочную область.
// Тело СИНХРОННО (ОВ-Б1-1): импорт — в `beforeAll`, тест читает собранное.
import { beforeAll, describe, expect, test } from 'bun:test';
import { ASSIGN_LEVEL_RULES } from '@orbis/shared';

let loaded: { ok: unknown } | { err: unknown };
beforeAll(async () => {
  try {
    // Спецификатор ВЫЧИСЛЯЕМЫЙ: литеральный уронил бы `bun run typecheck` на несуществующем
    // модуле, а веха 0 обязана закрываться красными ТЕСТАМИ, а не красными типами.
    const mod = (await import(`${import.meta.dir}/assign-level`)) as Record<string, unknown>;
    loaded =
      typeof mod.assignLevelOf === 'function'
        ? { ok: mod.assignLevelOf }
        : { err: new Error('policy/assign-level: экспорта assignLevelOf нет (задача 15)') };
  } catch (e) {
    loaded = { err: e };
  }
});

describe('§С8-26: приёмка выразимости assign_level', () => {
  test.failing('оценочная область считает уровень каждого из одиннадцати правил', () => {
    if ('err' in loaded) throw loaded.err;
    // Задача 15 заменит тело: сценарии на `seedTestWorld`, ожидание —
    // stricter(RULE_LEVEL_TO_CONFIRMATION[level], floorLevel(facts)).
    expect(ASSIGN_LEVEL_RULES.length).toBe(13);
  });
});
