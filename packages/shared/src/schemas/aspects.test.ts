import { describe, expect, test } from 'bun:test';
import {
  ASPECT_SCHEMAS,
  agentRunAspectSchema,
  aspectJsonSchema,
  assignmentAspectSchema,
  projectAspectSchema,
  repoAspectSchema,
  routineAspectSchema,
} from './aspects';

describe('схемы аспектов (01 §3.1–§3.7)', () => {
  test('orbis/task: полный и минимальный валидны; статус вне enum — нет', () => {
    const s = ASPECT_SCHEMAS['orbis/task'];
    expect(s.safeParse({ status: 'inbox' }).success).toBe(true);
    expect(
      s.safeParse({
        status: 'done',
        priority: 'high',
        due_date: '2026-07-10',
        completed_at: '2026-07-03T10:00:00Z',
        effort_min: 30,
        waiting_for: 'ответ',
      }).success,
    ).toBe(true);
    expect(s.safeParse({ status: 'todo' }).success).toBe(false);
    expect(s.safeParse({}).success).toBe(false); // status обязателен
  });
  test('orbis/financial: amount — положительная decimal-строка, number запрещён', () => {
    const s = ASPECT_SCHEMAS['orbis/financial'];
    const base = {
      direction: 'expense',
      category_ref: crypto.randomUUID(),
      occurred_on: '2026-07-03',
    };
    expect(s.safeParse({ ...base, amount: '340.00' }).success).toBe(true);
    expect(s.safeParse({ ...base, amount: 340 }).success).toBe(false);
    expect(s.safeParse({ ...base, amount: '-1.00' }).success).toBe(false);
    expect(s.safeParse({ ...base, amount: '0' }).success).toBe(false);
    expect(s.safeParse({ ...base, amount: '3.4e2' }).success).toBe(false);
  });
  test('orbis/financial: bank_txn_id — опциональная непустая строка (C2b, 03-budget §3.4.1)', () => {
    const s = ASPECT_SCHEMAS['orbis/financial'];
    const base = {
      amount: '3200.00',
      direction: 'expense',
      category_ref: crypto.randomUUID(),
      occurred_on: '2026-05-10',
    };
    expect(s.safeParse({ ...base, bank_txn_id: 'txn-42' }).success).toBe(true);
    expect(s.safeParse(base).success).toBe(true); // поле опционально: старые аспекты валидны
    expect(s.safeParse({ ...base, bank_txn_id: '' }).success).toBe(false);
    expect(s.safeParse({ ...base, bank_txn_id: 123 }).success).toBe(false);
    // Верхняя граница — защита JSONB от мусора, не бизнес-правило
    expect(s.safeParse({ ...base, bank_txn_id: 'x'.repeat(128) }).success).toBe(true);
    expect(s.safeParse({ ...base, bank_txn_id: 'x'.repeat(129) }).success).toBe(false);
  });
  test('orbis/schedule: start_at обязателен; recurrence — структурный объект', () => {
    const s = ASPECT_SCHEMAS['orbis/schedule'];
    expect(s.safeParse({ start_at: '2026-07-05T09:00:00+03:00' }).success).toBe(true);
    expect(s.safeParse({}).success).toBe(false);
    expect(
      s.safeParse({
        start_at: '2026-07-05T09:00:00+03:00',
        recurrence: { freq: 'weekly', interval: 1, byweekday: ['mo'] },
      }).success,
    ).toBe(true);
    expect(
      s.safeParse({
        start_at: '2026-07-05T09:00:00+03:00',
        recurrence: { freq: 'yearly', interval: 1 },
      }).success,
    ).toBe(false);
  });
  test('orbis/budget: carryover может быть отрицательным, limit — нет', () => {
    const s = ASPECT_SCHEMAS['orbis/budget'];
    const base = {
      category_ref: crypto.randomUUID(),
      limit: '30000.00',
      period_start: '2026-06-01',
      period_end: '2026-06-30',
    };
    expect(s.safeParse({ ...base, carryover: '-1200.00' }).success).toBe(true);
    expect(s.safeParse({ ...base, limit: '-1.00' }).success).toBe(false);
  });
  test('orbis/memory: kind обязателен', () => {
    expect(
      ASPECT_SCHEMAS['orbis/memory'].safeParse({ kind: 'rule', scope: 'orbis/financial' }).success,
    ).toBe(true);
    expect(ASPECT_SCHEMAS['orbis/memory'].safeParse({}).success).toBe(false);
  });
  test('orbis/goal: count не требует field, sum и latest — требуют', () => {
    const s = ASPECT_SCHEMAS['orbis/goal'];
    expect(
      s.safeParse({
        progress_source: { query: 'aspect=orbis/note', aggregate: 'count' },
        target_value: '24',
      }).success,
    ).toBe(true);
    expect(
      s.safeParse({
        progress_source: { query: 'aspect=orbis/financial', aggregate: 'sum' },
        target_value: '300000.00',
      }).success,
    ).toBe(false);
    expect(
      s.safeParse({
        progress_source: { query: 'aspect=orbis/financial', aggregate: 'latest' },
        target_value: '80',
      }).success,
    ).toBe(false);
    expect(
      s.safeParse({
        progress_source: { query: 'aspect=orbis/financial', aggregate: 'sum', field: 'amount' },
        target_value: '300000.00',
        unit: '₽',
      }).success,
    ).toBe(true);
    // count с field — лишний ключ в своей ветке объединения (strict), а не «просто игнор»
    expect(
      s.safeParse({
        progress_source: { query: 'aspect=orbis/note', aggregate: 'count', field: 'amount' },
        target_value: '24',
      }).success,
    ).toBe(false);
    // unit опционален, но пустым не бывает: иначе приедет хвостом за числом
    const src = { query: 'q', aggregate: 'count' as const };
    expect(s.safeParse({ progress_source: src, target_value: '24' }).success).toBe(true);
    expect(s.safeParse({ progress_source: src, target_value: '24', unit: '' }).success).toBe(false);
  });
  test('orbis/goal: суммы — decimal-строки, target_value строго положителен', () => {
    const s = ASPECT_SCHEMAS['orbis/goal'];
    const src = { query: 'q', aggregate: 'count' as const };
    expect(
      s.safeParse({ progress_source: src, target_value: 24 as unknown as string }).success,
    ).toBe(false);
    // E2 делит на target_value (ratio прогресса) — ноль и минус недопустимы
    expect(s.safeParse({ progress_source: src, target_value: '0' }).success).toBe(false);
    expect(s.safeParse({ progress_source: src, target_value: '-5' }).success).toBe(false);
    // current_value — КЭШ, считает сервер; неотрицательный
    expect(
      s.safeParse({ progress_source: src, target_value: '24', current_value: '0' }).success,
    ).toBe(true);
    expect(
      s.safeParse({ progress_source: src, target_value: '24', current_value: '-1' }).success,
    ).toBe(false);
  });
  test('orbis/note и orbis/category: пустой объект валиден (все поля опциональны)', () => {
    expect(ASPECT_SCHEMAS['orbis/note'].safeParse({}).success).toBe(true);
    expect(ASPECT_SCHEMAS['orbis/category'].safeParse({}).success).toBe(true);
  });
  test('неизвестные ключи отклоняются (strict) — защита от опечаток в meta→aspects', () => {
    expect(
      ASPECT_SCHEMAS['orbis/task'].safeParse({ status: 'inbox', prioritty: 'high' }).success,
    ).toBe(false);
  });
  test('JSON Schema: знаковость денег живёт в pattern (ajv-контракт реестра, решение 7)', () => {
    const fin = aspectJsonSchema('orbis/financial') as {
      properties: { amount: { pattern: string } };
    };
    expect(fin.properties.amount.pattern).toBe('^(?!0+(\\.0+)?$)\\d+(\\.\\d+)?$');
    const budget = aspectJsonSchema('orbis/budget') as {
      properties: { limit: { pattern: string }; carryover: { pattern: string } };
    };
    expect(budget.properties.limit.pattern).toBe('^\\d+(\\.\\d+)?$');
    expect(budget.properties.carryover.pattern).toBe('^-?\\d+(\\.\\d+)?$');
  });
  test('JSON Schema: enum-порядок сохранён (сортировка §6.1)', () => {
    const js = aspectJsonSchema('orbis/task') as {
      properties: { status: { enum: string[] }; priority: { enum: string[] } };
      required: string[];
    };
    expect(js.properties.status.enum).toEqual([
      'inbox',
      'planned',
      'in_progress',
      'waiting',
      'done',
      'cancelled',
    ]);
    expect(js.properties.priority.enum).toEqual(['low', 'medium', 'high']);
    expect(js.required).toContain('status');
  });
});

describe('аспекты ADE-среза 1 (С4)', () => {
  test('orbis/project: stage обязателен, лишние ключи отвергаются', () => {
    expect(projectAspectSchema.safeParse({ stage: 'active' }).success).toBe(true);
    expect(projectAspectSchema.safeParse({}).success).toBe(false);
    expect(projectAspectSchema.safeParse({ stage: 'active', status: 'x' }).success).toBe(false);
  });
  test('orbis/repo: url и default_branch', () => {
    expect(
      repoAspectSchema.safeParse({ url: 'https://github.com/qvenge/orbis', default_branch: 'main' })
        .success,
    ).toBe(true);
    expect(repoAspectSchema.safeParse({ url: '' }).success).toBe(false);
  });
  test('orbis/assignment: executor agent|human, grant_id — uuid, may_close необязателен', () => {
    expect(
      assignmentAspectSchema.safeParse({
        executor: 'agent',
        grant_id: '019a0000-0000-7000-8000-000000000001',
      }).success,
    ).toBe(true);
    expect(
      assignmentAspectSchema.safeParse({ executor: 'human', assignee: 'Биржан', may_close: true })
        .success,
    ).toBe(true);
    expect(
      assignmentAspectSchema.safeParse({ executor: 'agent', grant_id: 'не-uuid' }).success,
    ).toBe(false);
  });
  test('orbis/agent-run: полный прогон с шагом валиден; steps > 500 отвергается', () => {
    const run = {
      grant_id: '019a0000-0000-7000-8000-000000000001',
      outcome: 'running',
      started_at: '2026-08-17T10:00:00.000Z',
      last_step_at: '2026-08-17T10:05:00.000Z',
      step_count: 1,
      steps: [{ seq: 1, at: '2026-08-17T10:05:00.000Z', summary: 'создал ветку', external: true }],
    };
    expect(agentRunAspectSchema.safeParse(run).success).toBe(true);
    const many = {
      ...run,
      steps: Array.from({ length: 501 }, (_, i) => ({
        seq: i + 1,
        at: run.last_step_at,
        summary: 's',
        external: false,
      })),
    };
    expect(agentRunAspectSchema.safeParse(many).success).toBe(false);
  });
  test('JSON Schema новых аспектов генерируется и не содержит refine-логики', () => {
    for (const id of [
      'orbis/project',
      'orbis/repo',
      'orbis/assignment',
      'orbis/agent-run',
    ] as const) {
      const js = aspectJsonSchema(id) as { additionalProperties?: boolean };
      expect(js.additionalProperties).toBe(false);
    }
  });
});

describe('orbis/routine (V1.1)', () => {
  test('минимальная форма: stage+at+mode; days и allowed_tools опциональны; JSON Schema additionalProperties=false', () => {
    expect(
      routineAspectSchema.safeParse({ stage: 'active', at: '07:00', mode: 'propose' }).success,
    ).toBe(true);
    expect(
      routineAspectSchema.safeParse({
        stage: 'paused',
        at: '23:59',
        mode: 'act',
        days: ['mo', 'we', 'su'],
        allowed_tools: ['entity_create'],
      }).success,
    ).toBe(true);
    // ЧЧ:ММ строго: без ведущего нуля время сортируется и сравнивается как попало
    expect(
      routineAspectSchema.safeParse({ stage: 'active', at: '7:00', mode: 'propose' }).success,
    ).toBe(false);
    expect(
      routineAspectSchema.safeParse({ stage: 'active', at: '24:00', mode: 'propose' }).success,
    ).toBe(false);
    // mode обязателен и БЕЗ умолчания (V1.1): «по умолчанию act» дало бы рутине право
    // писать в граф молча, а «по умолчанию propose» — тихо ломало бы уже заведённые act
    expect(routineAspectSchema.safeParse({ stage: 'active', at: '07:00' }).success).toBe(false);
    expect(
      routineAspectSchema.safeParse({
        stage: 'active',
        at: '07:00',
        mode: 'act',
        days: ['mo', 'xx'],
      }).success,
    ).toBe(false);
    expect(
      routineAspectSchema.safeParse({ stage: 'active', at: '07:00', mode: 'act', days: [] })
        .success,
    ).toBe(false); // пустой список ≠ «ежедневно»: для этого поле просто не задают
    expect(
      (aspectJsonSchema('orbis/routine') as { additionalProperties?: boolean })
        .additionalProperties,
    ).toBe(false);
  });
});

describe('orbis/agent-run V1 (V1.4)', () => {
  const base = {
    outcome: 'running',
    started_at: '2026-08-18T07:00:00.000Z',
    last_step_at: '2026-08-18T07:00:00.000Z',
    step_count: 0,
    steps: [],
  };
  test('grant_id необязателен; routine_id/bucket/attempt/proposal принимаются; исходы failed/answered/stale валидны', () => {
    // Рутинный прогон: субъект — рутина, гранта у него нет вовсе (grant_id стал опционален).
    // «Ровно одно из grant_id/routine_id» схемой не выражается — держит assertRunSubject.
    expect(
      agentRunAspectSchema.safeParse({
        ...base,
        routine_id: '019a0000-0000-7000-8000-000000000001',
        bucket: '2026-08-18T07:00',
        attempt: 1,
      }).success,
    ).toBe(true);
    // Ручной запуск: бакет — не слот расписания, а метка «по кнопке» с моментом нажатия
    expect(
      agentRunAspectSchema.safeParse({ ...base, bucket: 'manual:2026-08-18T09:12:00.000Z' })
        .success,
    ).toBe(true);
    expect(agentRunAspectSchema.safeParse({ ...base, bucket: '07:00' }).success).toBe(false);
    expect(agentRunAspectSchema.safeParse({ ...base, attempt: 0 }).success).toBe(false);
    for (const outcome of ['failed', 'answered', 'stale']) {
      expect(agentRunAspectSchema.safeParse({ ...base, outcome }).success).toBe(true);
    }
    expect(
      agentRunAspectSchema.safeParse({
        ...base,
        outcome: 'failed',
        fail_note: 'провайдер недоступен',
        proposal: {
          pending_id: '019a0000-0000-7000-8000-000000000002',
          status: 'stale',
          decided_at: '2026-08-18T07:10:00.000Z',
          mismatches: [{ aspect: 'orbis/task', field: 'status', note: 'уже done' }],
        },
      }).success,
    ).toBe(true);
    expect(
      agentRunAspectSchema.safeParse({
        ...base,
        proposal: { pending_id: '019a0000-0000-7000-8000-000000000002', status: 'неизвестно' },
      }).success,
    ).toBe(false);
  });

  test('proposal.edited_from: uuid принимается, мусор отвергается, отсутствие поля валидно (Ш1.8)', () => {
    const proposal = { pending_id: '019a0000-0000-7000-8000-000000000002', status: 'approved' };
    // След правки владельца: id ИСХОДНОГО предложения на том, что родилось из его правки
    expect(
      agentRunAspectSchema.safeParse({
        ...base,
        proposal: { ...proposal, edited_from: '019a0000-0000-7000-8000-000000000003' },
      }).success,
    ).toBe(true);
    expect(
      agentRunAspectSchema.safeParse({ ...base, proposal: { ...proposal, edited_from: 'не-uuid' } })
        .success,
    ).toBe(false);
    // Прогоны до Ш1 поля не несут вовсе — бэкфилла нет, и они обязаны остаться валидными
    expect(agentRunAspectSchema.safeParse({ ...base, proposal }).success).toBe(true);
  });
});
