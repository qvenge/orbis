// Стадия 2 валидации — путь, которым запись реально проверяется в проде ПОСЛЕ реформы:
// реестр СВОЙСТВ (§А7-1), а не одна JSON Schema на аспект. Каждое свойство проверяется
// схемой своего типа, каждый аспект — своими обязательными, неизвестный id в `props` —
// отказ. Тест на одной zod-схеме этот путь НЕ покрывает: `.refine` в схему значения не
// попадает, поэтому правило, выраженное через refine, в проде отсутствовало бы вовсе.
//
// БД не нужна: снимок реестра собирается в памяти ровно из встроенных деклараций
// (`BUILTIN_PROPERTY_META`/`BUILTIN_ASPECT_DEFS`) — того же источника, из которого их кладёт
// в базу сид (`scripts/seed-registries.ts`); расхождение снимка с базой стережёт отдельная
// проверка дрейфа (`db/registry-drift.test.ts`).
//
// Фикстуры записаны формой АСПЕКТА («вот такой аспект с такими полями») и переводятся в
// свойства локальной таблицей `A8_FIELDS` ниже. Так тест продолжает читаться как «аспект с
// такими данными», а проверяется при этом валидатор свойств — тот же, что на записи.

import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_ASPECT_DEFS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
} from '@orbis/shared';
import type { RegistrySnapshot } from '../registry/load';
import type { PropsViolation } from '../registry/validate-props';
import { assertEntityProps } from './aspects-validate';
import { ExecError } from './errors';

/** Снимок «как после свежего пересева»: встроенные строки, ни одной собственной. */
const REG: RegistrySnapshot = {
  properties: new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p])),
  aspects: new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a])),
  roles: new Map(BUILTIN_RELATION_ROLE_META.map((r) => [r.id, r])),
  ownerVersion: 0,
  systemVersion: 1,
};

/** Произвольный валидный uuid — в этих тестах важна только ФОРМА поля, не адресат. */
const NIL_ROUTINE = '019a0000-0000-7000-8000-000000000001';

/**
 * Имя поля аспекта → id свойства (§А8), ЛОКАЛЬНО и только для чтения фикстур.
 *
 * Общая таблица переходных имён (`registry/legacy-field-map.ts`) снята «Пересевом мира»
 * вместе со старой формой, и воскрешать её в продуктовом коде было бы шагом назад. Здесь
 * она нужна ровно для того, чтобы фикстуры читались как «аспект с такими полями»: имя
 * ищется по локальной части ключа свойства, а неочевидные переименования §А8 названы
 * поимённо — ПО АСПЕКТУ, потому что одно и то же имя у разных аспектов вело на разные
 * свойства (`stage` — это `project_stage` у проекта и `routine_stage` у рутины; ровно
 * поэтому реформа их и развела). Неизвестное имя уезжает как `orbis/<имя>` — заведомо
 * неизвестный адрес, на который валидатор и обязан ответить `UNKNOWN_PROPERTY`.
 */
const RENAMED: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'orbis/task': { status: 'orbis/task_status' },
  'orbis/project': { stage: 'orbis/project_stage' },
  'orbis/memory': { kind: 'orbis/memory_kind' },
  'orbis/financial': { category_ref: 'orbis/finance_category' },
  'orbis/budget': { category_ref: 'orbis/finance_category' },
  'orbis/assignment': { grant_id: 'orbis/grant' },
  'orbis/agent-run': {
    outcome: 'orbis/run_outcome',
    started_at: 'orbis/run_started_at',
    finished_at: 'orbis/run_finished_at',
    steps: 'orbis/run_steps',
    report: 'orbis/run_report',
    checkpoint: 'orbis/run_checkpoint',
    reply: 'orbis/run_reply',
    usage: 'orbis/run_usage',
    proposal: 'orbis/run_proposal',
    routine_id: 'orbis/run_routine',
    bucket: 'orbis/run_bucket',
    attempt: 'orbis/run_attempt',
    grant_id: 'orbis/grant',
  },
  'orbis/routine': {
    stage: 'orbis/routine_stage',
    at: 'orbis/routine_at',
    days: 'orbis/routine_days',
    mode: 'orbis/routine_mode',
  },
};

function propertyOfField(aspectId: string, field: string): string {
  const declared = BUILTIN_ASPECT_DEFS.find((a) => a.id === aspectId)?.properties ?? [];
  const renamed = RENAMED[aspectId]?.[field];
  if (renamed !== undefined) return renamed;
  const byLocal = declared.find((r) => r.propertyId.split('/').at(-1) === field);
  return byLocal?.propertyId ?? `orbis/${field}`;
}

/** Отказ валидации по форме аспекта: перевод в свойства + стадия 2 исполнителя. */
function verdict(aspects: Record<string, Record<string, unknown>>): ExecError | undefined {
  const props: Record<string, unknown> = {};
  for (const [aspectId, fields] of Object.entries(aspects)) {
    for (const [field, value] of Object.entries(fields ?? {})) {
      props[propertyOfField(aspectId, field)] = value;
    }
  }
  try {
    assertEntityProps(REG, { props, aspects: Object.keys(aspects) });
    return undefined;
  } catch (e) {
    if (e instanceof ExecError) return e;
    throw e;
  }
}

function accepts(id: string, data: unknown): boolean {
  return verdict({ [id]: data as Record<string, unknown> }) === undefined;
}

function violationsOf(aspects: Record<string, Record<string, unknown>>): PropsViolation[] {
  const error = verdict(aspects);
  return ((error?.details as { violations?: PropsViolation[] } | undefined)?.violations ??
    []) as PropsViolation[];
}

describe('валидация записи по реестру свойств (§А7-1)', () => {
  test('orbis/goal: «field обязателен для sum/latest» ДОЖИВАЕТ до валидатора, а не только до zod', () => {
    // Ровно тот случай, ради которого правило структурное (anyOf), а не .refine:
    // с refine валидатор принял бы эту цель, и E2 делил бы на несуществующее поле.
    expect(
      accepts('orbis/goal', {
        progress_source: { query: { text: 'aspect=orbis/financial' }, aggregate: 'sum' },
        target_value: '300000.00',
      }),
    ).toBe(false);
    expect(
      accepts('orbis/goal', {
        progress_source: { query: { text: 'aspect=orbis/financial' }, aggregate: 'latest' },
        target_value: '80',
      }),
    ).toBe(false);
    // Обратное направление: count без field — законная цель, отклонять её нельзя
    expect(
      accepts('orbis/goal', {
        progress_source: { query: { text: 'aspect=orbis/note' }, aggregate: 'count' },
        target_value: '24',
      }),
    ).toBe(true);
    expect(
      accepts('orbis/goal', {
        progress_source: {
          query: { text: 'aspect=orbis/financial' },
          aggregate: 'sum',
          field: 'orbis/amount',
        },
        target_value: '300000.00',
        unit: '₽',
      }),
    ).toBe(true);
  });

  test('orbis/goal: знаковость сумм тоже в реестре (границы decimal), не в refine', () => {
    const src = { query: { text: 'q' }, aggregate: 'count' };
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

  test('orbis/assignment: uuid-формат grant_id доезжает до валидатора, may_close без default', () => {
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
    // may_close опционален и БЕЗ default'а: значение не материализуется (РП-9), отсутствие = false
    expect(accepts('orbis/assignment', { executor: 'human', assignee: 'Биржан' })).toBe(true);
    expect(accepts('orbis/assignment', { executor: 'human', assignee: '' })).toBe(false);
    expect(accepts('orbis/assignment', { executor: 'human', may_close: 'да' })).toBe(false);
  });

  test('orbis/routine: pattern времени и enum режима доезжают до валидатора (V1.1)', () => {
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

  test('orbis/agent-run: grant_id не обязателен, форма bucket живёт в реестре (V1.4)', () => {
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

  test('коды нарушений: REQUIRED по аспекту, UNKNOWN_PROPERTY, TYPE — VALIDATION с details.violations', () => {
    // REQUIRED: аспект добавляет свойству обязательность (Р5), и называет её именно аспект.
    const required = violationsOf({ 'orbis/task': {} });
    expect(required).toEqual([
      { code: 'REQUIRED', aspectId: 'orbis/task', propertyId: 'orbis/task_status' },
    ]);

    // UNKNOWN_PROPERTY: поле, которого §А8 не знает (`agent-run.project_id` УДАЛЕНО) —
    // отказ по СВОЙСТВУ, а не «лишний ключ аспекта»: носителем поля перестал быть аспект.
    const unknown = violationsOf({
      'orbis/agent-run': {
        outcome: 'running',
        started_at: '2026-08-18T07:00:00.000Z',
        last_step_at: '2026-08-18T07:00:00.000Z',
        step_count: 0,
        steps: [],
        project_id: NIL_ROUTINE,
      },
    });
    expect(unknown).toEqual([{ code: 'UNKNOWN_PROPERTY', propertyId: 'orbis/project_id' }]);

    // TYPE: сообщение называет id свойства — по нему владелец и правит форму.
    const typed = violationsOf({ 'orbis/task': { status: 'придумано' } });
    expect(typed).toHaveLength(1);
    expect(typed[0]?.code).toBe('TYPE');
    expect((typed[0] as { propertyId: string }).propertyId).toBe('orbis/task_status');

    // Список ПОЛНЫЙ, а не «первое найденное»: владелец правит форму целиком.
    const both = violationsOf({ 'orbis/repo': { repo_url: 'не-урл' } });
    expect(both.map((v) => v.code).sort()).toEqual(['REQUIRED', 'TYPE']);

    // Всё это — один код ExecError, а не пять разных: потребители различают причину полем.
    const error = verdict({ 'orbis/task': {} });
    expect(error?.code).toBe('VALIDATION');
  });

  test('неизвестный аспект — UNKNOWN_ASPECT, а не молчаливый пропуск', () => {
    const violations = violationsOf({ 'user/выдуманный': {} });
    expect(violations).toEqual([{ code: 'UNKNOWN_ASPECT', aspectId: 'user/выдуманный' }]);
  });
});
