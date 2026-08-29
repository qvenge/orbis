// Юнит-тесты envelope-схем тулов §9.2: позитив + негативы (strict-лишний ключ, невалидный uuid).
import { describe, expect, test } from 'bun:test';
import { RELATION_ROLE_IDS } from '../constants';
import {
  attachAspectInput,
  batchExecuteInput,
  entityCreateExecInput,
  entityCreateInput,
  entityCreateUiInput,
  entityGetInput,
  entityQueryInput,
  entityUpdateExecInput,
  entityUpdateInput,
  entityUpdatePrecondition,
  entityUpdateUiInput,
  relationCreateInput,
  relationDeleteInput,
} from './tools';

const UUID = '019e4466-1000-7e07-b5d4-64be9721da51';

describe('entityCreateInput', () => {
  test('минимальный валидный: title + tags (пустой массив допустим)', () => {
    expect(entityCreateInput.safeParse({ title: 'Кроссовки', tags: [] }).success).toBe(true);
  });

  test('полный валидный: id/emoji/body/props/aspects списком (§А9-1)', () => {
    const r = entityCreateInput.safeParse({
      id: UUID,
      title: 'Кроссовки',
      emoji: '👟',
      body: 'текст',
      tags: ['Shopping'],
      props: { 'orbis/task_status': 'inbox' },
      aspects: ['orbis/task'],
    });
    expect(r.success).toBe(true);
  });

  test('старую карту аспектов и `meta` не принимают НИ тул, НИ роутер владельца (§А9-1, 13c)', () => {
    // Обе формы — то, чем писали мимо реестра: `meta` не проверялась ничем, а карта
    // адресовала поле парой «аспект + имя», которой в реестре свойств нет.
    const legacy = { title: 'x', tags: [], aspects: { 'orbis/task': { status: 'inbox' } } };
    expect(entityCreateInput.safeParse(legacy).success).toBe(false);
    expect(
      entityCreateInput.safeParse({ title: 'x', tags: [], meta: { raw: 'кроссовки 8000' } })
        .success,
    ).toBe(false);
    // НАДМНОЖЕСТВО tRPC-роутера — тоже нет, с Задачи 13c: последний web-отправитель старой
    // карты (`MemoryRuleCard`) переведён, и оставленный вход принимал бы форму, которой
    // никто не шлёт, — то есть форму, за которой не следит ни один тест.
    expect(entityCreateUiInput.safeParse(legacy).success).toBe(false);
    expect(
      entityCreateUiInput.safeParse({ title: 'x', tags: [], meta: { raw: 'x' } }).success,
    ).toBe(false);
    // Новая форма проходит ОБЕ схемы: у роутера и тула вход теперь один и тот же.
    const modern = { title: 'x', tags: [], props: { 'orbis/task_status': 'inbox' } };
    expect(entityCreateInput.safeParse(modern).success).toBe(true);
    expect(entityCreateUiInput.safeParse(modern).success).toBe(true);
    // …и старую карту по-прежнему принимает ВНУТРЕННЕЕ надмножество исполнителя: серверные
    // пути мимо тулов переводятся до «Пересева мира» (РП-2), и вход у них свой.
    expect(entityCreateExecInput.safeParse(legacy).success).toBe(true);
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
  test('частичный патч валиден: props по key, unset и aspects {attach, detach} (§А9-1)', () => {
    const r = entityUpdateInput.safeParse({
      id: UUID,
      props: { 'orbis/task_status': 'done' },
      unset: ['orbis/waiting_for'],
      aspects: { attach: ['orbis/task'], detach: ['orbis/note'] },
    });
    expect(r.success).toBe(true);
  });

  test('старую карту аспектов не принимают НИ тул, НИ роутер владельца — только исполнитель', () => {
    const legacy = { id: UUID, aspects: { 'orbis/task': { status: 'done' }, 'orbis/note': null } };
    expect(entityUpdateInput.safeParse(legacy).success).toBe(false);
    // 13c: формы правки web говорят `props`/`unset`/`aspects.{attach,detach}` — карту роутер
    // владельца отвергает разбором, а не раскладывает по свойствам молча.
    expect(entityUpdateUiInput.safeParse(legacy).success).toBe(false);
    // Внутреннее надмножество исполнителя её ещё принимает (РП-2, до «Пересева мира»).
    expect(entityUpdateExecInput.safeParse(legacy).success).toBe(true);
    // Новая форма проходит ВСЕ три схемы: перевод потребителя не ломает соседа.
    const modern = { id: UUID, props: { 'orbis/task_status': 'done' } };
    expect(entityUpdateInput.safeParse(modern).success).toBe(true);
    expect(entityUpdateUiInput.safeParse(modern).success).toBe(true);
    expect(entityUpdateExecInput.safeParse(modern).success).toBe(true);
  });

  test('precondition контракту ТУЛА неизвестен — модель не подставляет CAS сама (§А7-3)', () => {
    // Непротекание держится именно strict-схемой тула: `runPropose` на неё и опирается,
    // снимая предусловия сервером с текущих значений.
    const withPre = {
      id: UUID,
      props: { 'orbis/task_status': 'done' },
      precondition: [{ property: 'orbis/task_status', in: ['planned'] }],
    };
    expect(entityUpdateInput.safeParse(withPre).success).toBe(false);
    expect(entityUpdateExecInput.safeParse(withPre).success).toBe(true);
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

describe('entityUpdatePrecondition (CAS по свойству, §А7-3 + V1.7)', () => {
  const IN = { property: 'orbis/task_status', in: ['planned'] };
  const ABSENT = { property: 'orbis/due_date', absent: true };

  test('обе формы валидны: `in` (значение из списка) и `absent` (значения ещё нет)', () => {
    expect(entityUpdatePrecondition.safeParse([IN]).success).toBe(true);
    expect(entityUpdatePrecondition.safeParse([ABSENT]).success).toBe(true);
    expect(entityUpdatePrecondition.safeParse([IN, ABSENT]).success).toBe(true);
  });

  test('пара «аспект + поле» БОЛЬШЕ НЕ ПРИНИМАЕТСЯ: адрес пункта — id свойства', () => {
    // Пин формы, а не косметика: пока старая пара проходила бы схему, писатель, забытый при
    // переводе, молча слал бы предусловие, которое сверять не с чем, — и получал бы
    // `VALIDATION` не в тесте, а у владельца на кнопке.
    expect(
      entityUpdatePrecondition.safeParse([
        { aspect: 'orbis/task', field: 'status', in: ['planned'] },
      ]).success,
    ).toBe(false);
    // И смесь двух форм — тоже: лишний ключ в предусловии это опечатка адреса.
    expect(
      entityUpdatePrecondition.safeParse([
        { property: 'orbis/task_status', field: 'status', in: ['planned'] },
      ]).success,
    ).toBe(false);
  });

  test('формы не смешиваются: `absent` вместе с `in` отклоняется (обе половины union strict)', () => {
    // Смесь — это не «оба условия сразу», а опечатка: strict каждой половины ловит её
    // здесь, иначе предусловие с лишним ключом молча пропускало бы гонку.
    expect(
      entityUpdatePrecondition.safeParse([{ property: 'orbis/task_status', absent: true, in: [1] }])
        .success,
    ).toBe(false);
  });

  test('пункт без `in` и без `absent` отклоняется — условия в нём нет', () => {
    expect(entityUpdatePrecondition.safeParse([{ property: 'orbis/task_status' }]).success).toBe(
      false,
    );
  });

  test('`absent: false` отклоняется: «значение есть» выражается формой `in`, а не отрицанием', () => {
    expect(
      entityUpdatePrecondition.safeParse([{ property: 'orbis/due_date', absent: false }]).success,
    ).toBe(false);
  });

  test('пустой список, пустой `in` и пустой id отклоняются (min 1)', () => {
    expect(entityUpdatePrecondition.safeParse([]).success).toBe(false);
    expect(
      entityUpdatePrecondition.safeParse([{ property: 'orbis/task_status', in: [] }]).success,
    ).toBe(false);
    expect(entityUpdatePrecondition.safeParse([{ property: '', in: ['planned'] }]).success).toBe(
      false,
    );
    // Обе половины union: пустой адрес в форме `absent` — та же опечатка.
    expect(entityUpdatePrecondition.safeParse([{ property: '', absent: true }]).success).toBe(
      false,
    );
  });

  test('exec-схема принимает обе формы; тул-контракт модели не принимает ни одной', () => {
    const input = {
      id: UUID,
      precondition: [ABSENT],
      aspects: { 'orbis/task': { due_date: '2026-08-20' } },
    };
    expect(entityUpdateExecInput.safeParse(input).success).toBe(true);
    expect(entityUpdateInput.safeParse(input).success).toBe(false);
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

  test('ребро несёт role: встроенная и кастомная роль принимаются, старый relation_type — нет', () => {
    for (const role of [...RELATION_ROLE_IDS, 'my/своя-роль']) {
      expect(relationCreateInput.safeParse({ ...base, role }).success).toBe(true);
    }
    // Контракт роль НЕ сужает (реестр расширяем владельцем, §А4-2) — но пустая строка
    // не роль, а старое поле типа отклоняется strict'ом: путь «забыли перевести» громкий
    expect(relationCreateInput.safeParse({ ...base, role: '' }).success).toBe(false);
    expect(relationCreateInput.safeParse({ ...base, relation_type: 'parent' }).success).toBe(false);
  });

  /**
   * АБСОЛЮТНЫЕ ожидания по каждому полю. Эквивалентность двух схем (тест ниже) ловит только
   * РАСХОЖДЕНИЕ; синхронный дрейф — «свели обе к общей базе с ослабленным полем» — она не
   * ловит по построению, а это ровно тот рефакторинг, ради которого пин и заводился.
   * Поэтому здесь сказано, чего каждое поле обязано требовать САМО.
   */
  const FIELD_CASES: ReadonlyArray<{ field: string; value: unknown; ok: boolean; why: string }> = [
    { field: 'source_id', value: UUID, ok: true, why: 'валидный uuid' },
    { field: 'source_id', value: 'не-uuid', ok: false, why: 'строка не uuid' },
    { field: 'source_id', value: 42, ok: false, why: 'не строка' },
    { field: 'source_id', value: undefined, ok: false, why: 'поле обязательно' },
    { field: 'target_id', value: UUID, ok: true, why: 'валидный uuid' },
    { field: 'target_id', value: 'не-uuid', ok: false, why: 'строка не uuid' },
    { field: 'target_id', value: 42, ok: false, why: 'не строка' },
    { field: 'target_id', value: undefined, ok: false, why: 'поле обязательно' },
    { field: 'role', value: 'subitem', ok: true, why: 'непустая строка' },
    { field: 'role', value: '', ok: false, why: 'пустая строка не роль' },
    { field: 'role', value: 7, ok: false, why: 'не строка' },
    { field: 'role', value: undefined, ok: false, why: 'поле обязательно' },
  ];

  /** Полный валидный вход с подменённым одним полем; `undefined` — поле выброшено. */
  function withField(field: string, value: unknown): Record<string, unknown> {
    const input: Record<string, unknown> = { ...base, role: 'subitem' };
    if (value === undefined) delete input[field];
    else input[field] = value;
    return input;
  }

  test.each([
    ['relationCreateInput', relationCreateInput],
    ['relationDeleteInput', relationDeleteInput],
  ])('%s: каждое поле держит СВОЙ валидатор (абсолютный пин)', (name, schema) => {
    for (const c of FIELD_CASES) {
      expect({
        name,
        field: c.field,
        why: c.why,
        ok: schema.safeParse(withField(c.field, c.value)).success,
      }).toEqual({
        name,
        field: c.field,
        why: c.why,
        ok: c.ok,
      });
    }
    // strict и старая форма — тоже абсолютно, на обеих схемах
    expect(schema.safeParse({ ...base, role: 'subitem', extra: 1 }).success).toBe(false);
    expect(schema.safeParse({ ...base, relation_type: 'parent' }).success).toBe(false);
  });

  // Тождество `toBe` снято реформой: у создания и удаления разошлись внутренние формы
  // (у create есть undo-надмножество с `meta`), и общий объект тянул бы правку одного
  // контракта во второй молча. Сравнивать сами схемы глубоким равенством нельзя — у zod
  // внутри функции, и `toEqual` падает на любых двух экземплярах; поэтому пиннится то,
  // что здесь и важно: РАЗНЫЕ объекты ОДНОЙ формы и одного поведения. Абсолютные ожидания
  // полей — в тесте выше: эквивалентность их не заменяет.
  test('delete — схема той же ФОРМЫ и того же поведения, но отдельный объект (§9.2)', () => {
    expect(relationDeleteInput).not.toBe(relationCreateInput);
    expect(Object.keys(relationDeleteInput.shape).sort()).toEqual(
      Object.keys(relationCreateInput.shape).sort(),
    );
    const samples: unknown[] = [
      ...FIELD_CASES.map((c) => withField(c.field, c.value)),
      { ...base, role: 'subitem', extra: 1 },
      { ...base, relation_type: 'parent' },
    ];
    for (const sample of samples) {
      expect({
        sample,
        ok: relationDeleteInput.safeParse(sample).success,
      }).toEqual({ sample, ok: relationCreateInput.safeParse(sample).success });
    }
  });

  test('невалидный uuid source_id отклоняется', () => {
    expect(
      relationCreateInput.safeParse({ ...base, source_id: 'x', role: 'subitem' }).success,
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

  test('strict вложенного конверта: лишний ключ элемента operations отклоняется (парность с JSON Schema §9.2)', () => {
    expect(
      batchExecuteInput.safeParse({
        batch_id: UUID,
        operations: [{ tool: 'entity_create', input: { title: 'x', tags: [] }, extra: 1 }],
      }).success,
    ).toBe(false);
  });
});

describe('entityQueryInput / entityGetInput', () => {
  test('query: непустая строка', () => {
    expect(entityQueryInput.safeParse({ query: 'aspect=orbis/task' }).success).toBe(true);
    expect(entityQueryInput.safeParse({ query: '' }).success).toBe(false);
  });

  test('§А5-4: РОВНО одно из query|ast — ни оба, ни ни одного', () => {
    // Второй вход существует ради того, чего плоская строка не выражает, — дерева.
    expect(entityQueryInput.safeParse({ ast: { filter: { tag: 'дом' } } }).success).toBe(true);
    expect(entityQueryInput.safeParse({ ast: { filter: null } }).success).toBe(true);
    // Два непустых входа — два разных запроса в одном вызове: молчаливый победитель был бы
    // отбором «не того» (§С8-3), поэтому отказ, а не приоритет.
    expect(entityQueryInput.safeParse({ query: 'tags=x', ast: { filter: null } }).success).toBe(
      false,
    );
    expect(entityQueryInput.safeParse({}).success).toBe(false);
    // Дерево проверяется ТОЙ ЖЕ схемой канона, что и `scope` свойства: узел с чужим ключом
    // до сервера не доезжает.
    expect(entityQueryInput.safeParse({ ast: { filter: { нетtакого: 1 } } }).success).toBe(false);
    expect(entityQueryInput.safeParse({ ast: {} }).success).toBe(false);
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
