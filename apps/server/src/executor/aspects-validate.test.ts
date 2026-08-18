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

/** Произвольный валидный uuid — в этих тестах важна только ФОРМА поля, не адресат. */
const NIL_ROUTINE = '019a0000-0000-7000-8000-000000000001';

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
    // minLength у unit тоже обязан доехать до реестра, а не остаться в zod
    expect(accepts('orbis/goal', { progress_source: src, target_value: '24', unit: '' })).toBe(
      false,
    );
    expect(accepts('orbis/goal', { progress_source: src, target_value: '24', unit: '₽' })).toBe(
      true,
    );
  });

  test('orbis/assignment: uuid-формат grant_id доезжает до ajv, may_close без default', () => {
    // Инвариант «executor=agent ⇒ grant_id живого гранта владельца» держит assertAssignment,
    // но САМ формат обязан жить в реестре: иначе прод примет строку-мусор в grant_id.
    expect(
      accepts('orbis/assignment', {
        executor: 'agent',
        grant_id: '019a0000-0000-7000-8000-000000000001',
      }),
    ).toBe(true);
    expect(accepts('orbis/assignment', { executor: 'agent', grant_id: 'не-uuid' })).toBe(false);
    expect(accepts('orbis/assignment', { executor: 'кто-то' })).toBe(false);
    // may_close опционален и БЕЗ default'а: ajv их не применяет (С8), отсутствие = false
    expect(accepts('orbis/assignment', { executor: 'human', assignee: 'Биржан' })).toBe(true);
    expect(accepts('orbis/assignment', { executor: 'human', assignee: '' })).toBe(false);
    expect(accepts('orbis/assignment', { executor: 'human', may_close: 'да' })).toBe(false);
  });

  test('orbis/routine: pattern времени и enum режима доезжают до ajv (V1.1)', () => {
    // Формат `at` — единственная защита планировщика от мусора: он разбирает строку двумя
    // Number() без своей валидации, поэтому «7:00» в базе дал бы NaN-минуты молча.
    expect(accepts('orbis/routine', { stage: 'active', at: '07:00', mode: 'propose' })).toBe(true);
    expect(accepts('orbis/routine', { stage: 'active', at: '7:00', mode: 'propose' })).toBe(false);
    expect(accepts('orbis/routine', { stage: 'active', at: '07:00' })).toBe(false); // mode обязателен
    expect(accepts('orbis/routine', { stage: 'active', at: '07:00', mode: 'обсудить' })).toBe(
      false,
    );
    expect(
      accepts('orbis/routine', { stage: 'paused', at: '21:30', mode: 'act', days: ['mo', 'fr'] }),
    ).toBe(true);
    expect(accepts('orbis/routine', { stage: 'active', at: '07:00', mode: 'act', days: [] })).toBe(
      false,
    );
    expect(
      accepts('orbis/routine', { stage: 'active', at: '07:00', mode: 'act', days: ['вторник'] }),
    ).toBe(false);
  });

  test('orbis/agent-run: grant_id перестал быть обязательным, форма bucket живёт в реестре (V1.4)', () => {
    const base = {
      outcome: 'running',
      started_at: '2026-08-18T07:00:00.000Z',
      last_step_at: '2026-08-18T07:00:00.000Z',
      step_count: 0,
      steps: [],
    };
    // Рутинный прогон гранта не имеет вовсе. «Ровно одно из grant_id/routine_id» реестр не
    // выражает (это не форма, а домен) — его держит assertRunSubject в executor'е.
    expect(accepts('orbis/agent-run', { ...base, routine_id: NIL_ROUTINE })).toBe(true);
    expect(accepts('orbis/agent-run', { ...base })).toBe(true);
    expect(accepts('orbis/agent-run', { ...base, routine_id: 'не-uuid' })).toBe(false);
    expect(accepts('orbis/agent-run', { ...base, bucket: '2026-08-18T07:00', attempt: 2 })).toBe(
      true,
    );
    expect(accepts('orbis/agent-run', { ...base, bucket: 'manual:2026-08-18T09:12:00.000Z' })).toBe(
      true,
    );
    expect(accepts('orbis/agent-run', { ...base, bucket: '2026-08-18' })).toBe(false);
    expect(accepts('orbis/agent-run', { ...base, outcome: 'failed', fail_note: 'таймаут' })).toBe(
      true,
    );
    expect(
      accepts('orbis/agent-run', {
        ...base,
        proposal: { pending_id: NIL_ROUTINE, status: 'pending' },
      }),
    ).toBe(true);
    expect(
      accepts('orbis/agent-run', {
        ...base,
        proposal: { pending_id: NIL_ROUTINE, status: 'pending', лишнее: 1 },
      }),
    ).toBe(false);
  });

  test('схемы ВСЕХ builtin-аспектов компилируются ajv в strict-режиме', () => {
    // strict:true бросает на незнакомых ключевых словах — сторож того, что генератор
    // не выдал в реестр конструкцию, которую прод-валидатор не примет. Список берётся из
    // BUILTIN_ASPECT_IDS, а не хардкодом: новый аспект попадает под проверку сам.
    for (const id of BUILTIN_ASPECT_IDS) {
      // Ключа нет НИ В ОДНОЙ builtin-схеме, а все они strict (additionalProperties:false),
      // поэтому такие данные обязан отвергнуть КАЖДЫЙ аспект. Отсюда ровно один живой
      // ассерт на каждой итерации — в том числе для orbis/note и orbis/category, у которых
      // пустой объект валиден и проверять на `{}` было бы нечего.
      let message: string | undefined;
      try {
        validateAspectData(registryOf(id), id, { __нет_такого_поля: 1 });
      } catch (e) {
        message = (e as ExecError).message;
      }
      // Отказ ПО СХЕМЕ = схема скомпилировалась. Провал компиляции дал бы
      // «не компилируется», а принятые данные — undefined; оба валят ассерт.
      expect(message).toContain('не проходят схему реестра');
    }
  });
});
