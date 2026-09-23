// apps/server/src/policy/assign-level.test.ts
// §С8-26: одиннадцать правил делегирования «дня мечты» (§Б4-5) дают ожидаемые уровни — приёмка
// ВЫРАЗИМОСТИ, а не подключения: живой конвейер §7.10 правил не знает (V2), и оценочная область
// `assignLevelOf` зовётся только отсюда. Пол понижения (Р-27) пиннится здесь же — он и есть та
// граница, которую правило владельца пробить не вправе.
import { describe, expect, test } from 'bun:test';
import type { ToolCallFacts } from './confirmation';
import { floorLevel, LEVEL_ORDER, stricter } from './floor';

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
