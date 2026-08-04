// Стадия 2 валидации — путь, которым аспект реально проверяется в проде: JSON Schema ИЗ
// РЕЕСТРА (генерируется из zod в shared) компилируется ajv{strict:true} и применяется к
// данным. Тест на одной zod-схеме этот путь НЕ покрывает: `.refine` в JSON Schema не
// попадает, поэтому правило, выраженное через refine, в проде отсутствует вовсе.
//
// БД не нужна: реестр здесь собирается в памяти ровно из того, что кладёт в него
// scripts/seed-aspects.ts (`aspectJsonSchema(id)`), — сравнение схемы БД с этим источником
// стережёт отдельная проверка дрейфа (aspect-drift.test.ts).

import { describe, expect, test } from 'bun:test';
import { type AspectId, aspectJsonSchema, BUILTIN_ASPECT_IDS } from '@orbis/shared';
import { type AspectRegistry, validateAspectData } from './aspects-validate';
import { ExecError } from './errors';

/** Реестр «как после свежего пересева»: builtin-схема из shared, owner_id NULL. */
function registryOf(id: AspectId): AspectRegistry {
  return new Map([[id, { id, ownerId: null, schema: aspectJsonSchema(id) }]]);
}

function accepts(id: AspectId, data: unknown): boolean {
  try {
    validateAspectData(registryOf(id), id, data);
    return true;
  } catch (e) {
    if (e instanceof ExecError && e.code === 'VALIDATION') return false;
    throw e;
  }
}

describe('валидация аспектов по реестру (ajv strict, решение 7)', () => {
  test('orbis/goal: «field обязателен для sum/latest» ДОЖИВАЕТ до ajv, а не только до zod', () => {
    // Ровно тот случай, ради которого правило структурное (anyOf), а не .refine:
    // с refine ajv принял бы эту цель, и E2 делил бы на несуществующее поле.
    expect(
      accepts('orbis/goal', {
        progress_source: { query: 'aspect=orbis/financial', aggregate: 'sum' },
        target_value: '300000.00',
      }),
    ).toBe(false);
    expect(
      accepts('orbis/goal', {
        progress_source: { query: 'aspect=orbis/financial', aggregate: 'latest' },
        target_value: '80',
      }),
    ).toBe(false);
    // Обратное направление: count без field — законная цель, отклонять её нельзя
    expect(
      accepts('orbis/goal', {
        progress_source: { query: 'aspect=orbis/note', aggregate: 'count' },
        target_value: '24',
      }),
    ).toBe(true);
    expect(
      accepts('orbis/goal', {
        progress_source: { query: 'aspect=orbis/financial', aggregate: 'sum', field: 'amount' },
        target_value: '300000.00',
        unit: '₽',
      }),
    ).toBe(true);
  });

  test('orbis/goal: знаковость сумм тоже в реестре (pattern), не в refine', () => {
    const src = { query: 'q', aggregate: 'count' };
    expect(accepts('orbis/goal', { progress_source: src, target_value: '0' })).toBe(false);
    expect(accepts('orbis/goal', { progress_source: src, target_value: '-5' })).toBe(false);
    expect(accepts('orbis/goal', { progress_source: src, target_value: 24 })).toBe(false);
    expect(
      accepts('orbis/goal', { progress_source: src, target_value: '24', current_value: '-1' }),
    ).toBe(false);
    expect(
      accepts('orbis/goal', { progress_source: src, target_value: '24', current_value: '3' }),
    ).toBe(true);
  });

  test('схемы ВСЕХ builtin-аспектов компилируются ajv в strict-режиме', () => {
    // strict:true бросает на незнакомых ключевых словах — сторож того, что генератор
    // не выдал в реестр конструкцию, которую прод-валидатор не примет. Список берётся из
    // BUILTIN_ASPECT_IDS, а не хардкодом: новый аспект попадает под проверку сам.
    for (const id of BUILTIN_ASPECT_IDS) {
      // `{}` для большинства аспектов невалидно — это нормально: важно ОТЛИЧИЕ отказа
      // «не проходит схему» (схема скомпилировалась) от «не компилируется».
      try {
        validateAspectData(registryOf(id), id, {});
      } catch (e) {
        expect((e as ExecError).message).not.toContain('не компилируется');
        expect((e as ExecError).message).not.toContain('неизвестный аспект');
      }
    }
  });
});
