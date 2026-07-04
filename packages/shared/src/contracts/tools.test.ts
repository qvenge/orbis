// Юнит-тесты envelope-схем тулов §9.2: позитив + негативы (strict-лишний ключ, невалидный uuid).
import { describe, expect, test } from 'bun:test';
import {
  attachAspectInput,
  batchExecuteInput,
  entityCreateInput,
  entityGetInput,
  entityQueryInput,
  entityUpdateInput,
  relationCreateInput,
  relationDeleteInput,
} from './tools';

const UUID = '019e4466-1000-7e07-b5d4-64be9721da51';

describe('entityCreateInput', () => {
  test('минимальный валидный: title + tags (пустой массив допустим)', () => {
    expect(entityCreateInput.safeParse({ title: 'Кроссовки', tags: [] }).success).toBe(true);
  });

  test('полный валидный: id/emoji/body/meta/aspects', () => {
    const r = entityCreateInput.safeParse({
      id: UUID,
      title: 'Кроссовки',
      emoji: '👟',
      body: 'текст',
      tags: ['Shopping'],
      meta: { raw: 'кроссовки 8000' },
      aspects: { 'orbis/task': { status: 'inbox' } },
    });
    expect(r.success).toBe(true);
  });

  test('tags обязателен (§9.2: string[]*)', () => {
    expect(entityCreateInput.safeParse({ title: 'x' }).success).toBe(false);
  });

  test('strict: лишний ключ отклоняется', () => {
    expect(entityCreateInput.safeParse({ title: 'x', tags: [], extra: 1 }).success).toBe(false);
  });

  test('невалидный uuid в id отклоняется', () => {
    expect(entityCreateInput.safeParse({ id: 'not-a-uuid', title: 'x', tags: [] }).success).toBe(
      false,
    );
  });

  test('пустой title отклоняется', () => {
    expect(entityCreateInput.safeParse({ title: '', tags: [] }).success).toBe(false);
  });
});

describe('entityUpdateInput', () => {
  test('частичный патч валиден; aspects принимает объект и null (detach)', () => {
    const r = entityUpdateInput.safeParse({
      id: UUID,
      aspects: { 'orbis/task': { status: 'done' }, 'orbis/note': null },
    });
    expect(r.success).toBe(true);
  });

  test('expectedUpdatedAt — ISO datetime; мусор отклоняется', () => {
    expect(entityUpdateInput.safeParse({ id: UUID, expectedUpdatedAt: 'вчера' }).success).toBe(
      false,
    );
    expect(
      entityUpdateInput.safeParse({ id: UUID, expectedUpdatedAt: '2026-07-04T10:00:00.000Z' })
        .success,
    ).toBe(true);
  });

  test('id обязателен и должен быть uuid', () => {
    expect(entityUpdateInput.safeParse({ title: 'x' }).success).toBe(false);
    expect(entityUpdateInput.safeParse({ id: '123', title: 'x' }).success).toBe(false);
  });

  test('strict: лишний ключ отклоняется', () => {
    expect(entityUpdateInput.safeParse({ id: UUID, unknown: true }).success).toBe(false);
  });

  test('emoji: null допустим (сброс), строка допустима', () => {
    expect(entityUpdateInput.safeParse({ id: UUID, emoji: null }).success).toBe(true);
    expect(entityUpdateInput.safeParse({ id: UUID, emoji: '🔥' }).success).toBe(true);
  });
});

describe('attachAspectInput', () => {
  test('валидный: entity_id + data', () => {
    expect(
      attachAspectInput.safeParse({ entity_id: UUID, data: { status: 'inbox' } }).success,
    ).toBe(true);
  });

  test('невалидный uuid entity_id отклоняется', () => {
    expect(attachAspectInput.safeParse({ entity_id: 'nope', data: {} }).success).toBe(false);
  });

  test('strict: лишний ключ отклоняется', () => {
    expect(attachAspectInput.safeParse({ entity_id: UUID, data: {}, extra: 1 }).success).toBe(
      false,
    );
  });
});

describe('relationCreateInput / relationDeleteInput', () => {
  const base = { source_id: UUID, target_id: '019e4466-2000-7e07-b5d4-64be9721da52' };

  test('все четыре relation_type принимаются, прочее — нет', () => {
    for (const t of ['parent', 'blocks', 'related_to', 'derived_from']) {
      expect(relationCreateInput.safeParse({ ...base, relation_type: t }).success).toBe(true);
    }
    expect(relationCreateInput.safeParse({ ...base, relation_type: 'linked' }).success).toBe(false);
  });

  test('delete — та же схема, что create (§9.2)', () => {
    expect(relationDeleteInput).toBe(relationCreateInput);
  });

  test('невалидный uuid source_id отклоняется', () => {
    expect(
      relationCreateInput.safeParse({ ...base, source_id: 'x', relation_type: 'parent' }).success,
    ).toBe(false);
  });
});

describe('batchExecuteInput', () => {
  test('валидный batch: batch_id + operations (min 1)', () => {
    const r = batchExecuteInput.safeParse({
      batch_id: UUID,
      operations: [{ tool: 'entity_create', input: { title: 'x', tags: [] } }],
    });
    expect(r.success).toBe(true);
  });

  test('пустой operations отклоняется', () => {
    expect(batchExecuteInput.safeParse({ batch_id: UUID, operations: [] }).success).toBe(false);
  });

  test('невалидный uuid batch_id отклоняется', () => {
    expect(
      batchExecuteInput.safeParse({ batch_id: 'b1', operations: [{ tool: 't', input: {} }] })
        .success,
    ).toBe(false);
  });
});

describe('entityQueryInput / entityGetInput', () => {
  test('query: непустая строка', () => {
    expect(entityQueryInput.safeParse({ query: 'aspect=orbis/task' }).success).toBe(true);
    expect(entityQueryInput.safeParse({ query: '' }).success).toBe(false);
  });

  test('get: include из enum §9.2, прочее отклоняется', () => {
    expect(
      entityGetInput.safeParse({ id: UUID, include: ['body', 'relations', 'backlinks', 'thread'] })
        .success,
    ).toBe(true);
    expect(entityGetInput.safeParse({ id: UUID, include: ['meta'] }).success).toBe(false);
    expect(entityGetInput.safeParse({ id: 'nope' }).success).toBe(false);
  });
});
