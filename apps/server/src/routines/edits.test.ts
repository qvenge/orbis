// apps/server/src/routines/edits.test.ts
// Контракт правок предложения, детерминированный хеш и сборка правленого payload (Ш1.4,
// Ш1.11, Развилка 3). БД не нужна: все три функции чистые — вход это payload, прочитанный
// вызывающим, выход это payload, который вызывающий положит в P2.
import { describe, expect, test } from 'bun:test';
import { entityUpdateExecInput } from '@orbis/shared';
import { ExecError } from '../errors';
import {
  buildEditedOperations,
  editsHash,
  editsSchema,
  isEmptyEdits,
  type ProposalEdits,
} from './edits';

const TARGET = '019a0000-0000-7000-8000-000000000001';
const OTHER = '019a0000-0000-7000-8000-000000000002';
const UPDATED_AT = '2026-08-20T10:00:00.000Z';

type Operation = { tool: string; input: Record<string, unknown> };

/** Правка тела и двух полей аспекта — ровно то, что собирает propose.ts (buildUpdate). */
function updateOp(): Operation {
  return {
    tool: 'entity_update',
    input: {
      id: TARGET,
      title: 'Заголовок',
      body: '# Было',
      expectedUpdatedAt: UPDATED_AT,
      aspects: { 'orbis/task': { status: 'in_progress', priority: 2 } },
      // Форма §А7-3: адрес пункта — id свойства. Литеральный якорь, а не производная от
      // кода: инвариант «правка владельца не меняет предусловие» сверяет два КАНОНА одной и
      // той же формы, и на выведенной фикстуре он выродился бы в тавтологию.
      precondition: [
        { property: 'orbis/task_status', in: ['planned'] },
        { property: 'orbis/priority', absent: true },
      ],
    },
  };
}

/** Создание идёт БЕЗ предусловий (propose.ts:200-205) — и схема у него своя. */
function createOp(): Operation {
  return { tool: 'entity_create', input: { title: 'Новая', tags: [], body: 'текст' } };
}

function relationOp(): Operation {
  return {
    tool: 'relation_create',
    input: { source_id: TARGET, target_id: OTHER, role: 'dependency' },
  };
}

/** Тело документом в форме, которую принимает `bodyDocSchema` (@orbis/shared). */
function docOf(content: Record<string, unknown>[]) {
  return { v: 1, doc: { type: 'doc' as const, content } };
}

const BODY_DOC = docOf([{ type: 'paragraph' }]);

function edits(patch: Partial<ProposalEdits>): ProposalEdits {
  return editsSchema.parse(patch);
}

/** Собранная операция по номеру: `buildEditedOperations` отдаёт `unknown[]` — payload сырой. */
function opAt(built: unknown[], index: number): Operation {
  const op = built[index];
  if (op === undefined) throw new Error(`в собранном payload'е нет операции ${index}`);
  return op as Operation;
}

/** Разбор отказа: код, `details.reason` и то, что это именно ExecError, а не голый Error. */
function reasonOf(run: () => unknown): { code: string; reason: unknown } {
  try {
    run();
  } catch (e) {
    if (!(e instanceof ExecError)) throw e;
    return { code: e.code, reason: (e.details as { reason?: unknown }).reason };
  }
  throw new Error('ожидался ExecError, а вызов прошёл');
}

describe('buildEditedOperations', () => {
  test('правка тела: body → bodyDoc, ключ body удалён, expectedUpdatedAt и precondition нетронуты, safeParse проходит', () => {
    const source = [updateOp()];
    const built = buildEditedOperations(source, edits({ body: [{ index: 0, bodyDoc: BODY_DOC }] }));

    expect(built).toHaveLength(1);
    const input = opAt(built, 0).input;
    // XOR тела — refine, а не union (contracts/tools.ts:137-140): ключ body обязан УЙТИ
    expect(Object.hasOwn(input, 'body')).toBe(false);
    expect(input.bodyDoc).toEqual(BODY_DOC);
    // Ш1.6: CAS переносится КАК ЕСТЬ — иначе правка тела затирала бы чужую
    expect(input.expectedUpdatedAt).toBe(UPDATED_AT);
    expect(input.precondition).toEqual(updateOp().input.precondition);
    expect(input.title).toBe('Заголовок');
    expect(input.aspects).toEqual(updateOp().input.aspects);
    // Форма, которой операцию разберёт executor у владельца на кнопке
    expect(entityUpdateExecInput.safeParse(input).success).toBe(true);
    // Исходный payload не тронут — вызывающий читает его же для инвариантов
    expect(source[0]).toEqual(updateOp());
  });

  test('правка поля аспекта и core-поля меняет ровно значение; остальное байт-в-байт', () => {
    const source = [updateOp(), relationOp()];
    const built = buildEditedOperations(
      source,
      edits({
        fields: [
          { index: 0, aspect: 'orbis/task', field: 'priority', value: 5 },
          { index: 0, field: 'title', value: 'Другой заголовок' },
        ],
      }),
    );

    const first = opAt(built, 0).input;
    expect(first.aspects).toEqual({ 'orbis/task': { status: 'in_progress', priority: 5 } });
    expect(first.title).toBe('Другой заголовок');
    expect(first.body).toBe('# Было');
    expect(first.precondition).toEqual(updateOp().input.precondition);
    // Непатченная операция переносится целиком
    expect(opAt(built, 1)).toEqual(relationOp());
  });

  test('две правки одного аспекта складываются: первая не теряется под второй', () => {
    const built = buildEditedOperations(
      [updateOp()],
      edits({
        fields: [
          { index: 0, aspect: 'orbis/task', field: 'status', value: 'planned' },
          { index: 0, aspect: 'orbis/task', field: 'priority', value: 1 },
        ],
      }),
    );
    expect(opAt(built, 0).input.aspects).toEqual({
      'orbis/task': { status: 'planned', priority: 1 },
    });
  });

  test('новый ключ поля → VALIDATION edit_key_missing (Б3: запись без предусловия)', () => {
    const source = [updateOp()];
    // Поля нет в патче аспекта — предусловия под него никто не снимал
    expect(
      reasonOf(() =>
        buildEditedOperations(
          source,
          edits({
            fields: [{ index: 0, aspect: 'orbis/task', field: 'due', value: '2026-09-01' }],
          }),
        ),
      ),
    ).toEqual({ code: 'VALIDATION', reason: 'edit_key_missing' });

    // Аспекта нет в операции вовсе
    expect(
      reasonOf(() =>
        buildEditedOperations(
          source,
          edits({ fields: [{ index: 0, aspect: 'orbis/note', field: 'pinned', value: true }] }),
        ),
      ).reason,
    ).toBe('edit_key_missing');

    // core-поле, которого операция не трогает
    expect(
      reasonOf(() =>
        buildEditedOperations(
          source,
          edits({ fields: [{ index: 0, field: 'emoji', value: '🔥' }] }),
        ),
      ).reason,
    ).toBe('edit_key_missing');

    // Служебное поле операции — не строка предложения и правке не подлежит
    expect(
      reasonOf(() =>
        buildEditedOperations(source, edits({ fields: [{ index: 0, field: 'id', value: OTHER }] })),
      ).reason,
    ).toBe('edit_key_missing');

    // Тело правится ДОКУМЕНТОМ (Ш1.11), значением поля — никогда
    expect(
      reasonOf(() =>
        buildEditedOperations(
          source,
          edits({ fields: [{ index: 0, field: 'body', value: '# Стало' }] }),
        ),
      ).reason,
    ).toBe('edit_key_missing');
  });

  test('body-правка в операции без body → VALIDATION edit_body_missing; index мимо → edit_index_out_of_range; дубль → edit_duplicate', () => {
    const withoutBody: Operation[] = [
      { tool: 'entity_update', input: { id: TARGET, title: 'Только заголовок' } },
    ];
    expect(
      reasonOf(() =>
        buildEditedOperations(withoutBody, edits({ body: [{ index: 0, bodyDoc: BODY_DOC }] })),
      ),
    ).toEqual({ code: 'VALIDATION', reason: 'edit_body_missing' });

    const source = [updateOp()];
    expect(
      reasonOf(() =>
        buildEditedOperations(source, edits({ body: [{ index: 1, bodyDoc: BODY_DOC }] })),
      ),
    ).toEqual({ code: 'VALIDATION', reason: 'edit_index_out_of_range' });
    expect(
      reasonOf(() =>
        buildEditedOperations(
          source,
          edits({ fields: [{ index: 7, field: 'title', value: 'нет' }] }),
        ),
      ).reason,
    ).toBe('edit_index_out_of_range');

    // Две правки одного ключа: последняя молча выиграла бы, а владелец видел бы обе
    expect(
      reasonOf(() =>
        buildEditedOperations(
          source,
          edits({
            fields: [
              { index: 0, field: 'title', value: 'первая' },
              { index: 0, field: 'title', value: 'вторая' },
            ],
          }),
        ),
      ).reason,
    ).toBe('edit_duplicate');
    expect(
      reasonOf(() =>
        buildEditedOperations(
          source,
          edits({
            body: [
              { index: 0, bodyDoc: BODY_DOC },
              { index: 0, bodyDoc: docOf([]) },
            ],
          }),
        ),
      ).reason,
    ).toBe('edit_duplicate');
  });

  test('строки entity_create и связей не правятся вовсе → VALIDATION edit_row_not_editable', () => {
    // Граница спеки («Известные границы»): правка заголовка новой задачи — это правка
    // записи, которой ещё нет. С экрана такого не послать, но вход открыт любому клиенту.
    const create = [createOp()];
    expect(
      reasonOf(() =>
        buildEditedOperations(
          create,
          edits({ fields: [{ index: 0, field: 'title', value: 'Правленый' }] }),
        ),
      ),
    ).toEqual({ code: 'VALIDATION', reason: 'edit_row_not_editable' });

    // Поле аспекта создания — та же граница
    const createWithAspect: Operation[] = [
      {
        tool: 'entity_create',
        input: { title: 'Новая', tags: [], aspects: { 'orbis/task': { status: 'planned' } } },
      },
    ];
    expect(
      reasonOf(() =>
        buildEditedOperations(
          createWithAspect,
          edits({ fields: [{ index: 0, aspect: 'orbis/task', field: 'status', value: 'done' }] }),
        ),
      ).reason,
    ).toBe('edit_row_not_editable');

    // Тело у создания есть, но строка всё равно не правится — и причина об этом, а не о
    // контракте тула (иначе владелец читал бы «операция невалидна» вместо «править нельзя»)
    expect(
      reasonOf(() =>
        buildEditedOperations(create, edits({ body: [{ index: 0, bodyDoc: BODY_DOC }] })),
      ).reason,
    ).toBe('edit_row_not_editable');

    // У связей строк-полей нет вовсе
    expect(
      reasonOf(() =>
        buildEditedOperations(
          [relationOp()],
          edits({ fields: [{ index: 0, field: 'title', value: 'нет' }] }),
        ),
      ).reason,
    ).toBe('edit_row_not_editable');
  });

  test('null — принятое значение: «пусто» в поле аспекта собирается и проходит контракт тула', () => {
    const built = buildEditedOperations(
      [updateOp()],
      edits({ fields: [{ index: 0, aspect: 'orbis/task', field: 'priority', value: null }] }),
    );
    const input = opAt(built, 0).input;
    expect(input.aspects).toEqual({ 'orbis/task': { status: 'in_progress', priority: null } });
    // Ключ остался на месте — снятие значения не выбрасывает строку из предложения
    expect(entityUpdateExecInput.safeParse(input).success).toBe(true);
  });

  test('собранная операция валидируется схемой СВОЕГО тула — fail-closed на всех, включая непатченные', () => {
    // Значение неверного типа: title: z.string().min(1) не принимает null
    expect(
      reasonOf(() =>
        buildEditedOperations(
          [updateOp()],
          edits({ fields: [{ index: 0, field: 'title', value: null }] }),
        ),
      ),
    ).toEqual({ code: 'VALIDATION', reason: 'edit_result_invalid' });

    // Непатченная операция тоже обязана пройти контракт — иначе провал вылезет у владельца
    const broken: Operation[] = [{ tool: 'entity_update', input: { id: 'не-uuid' } }];
    expect(reasonOf(() => buildEditedOperations(broken, edits({}))).reason).toBe(
      'edit_result_invalid',
    );

    // Тул без известного exec-контракта — отказ, а не «пронесём как есть»
    const unknown: Operation[] = [{ tool: 'thread_post', input: { text: 'привет' } }];
    expect(reasonOf(() => buildEditedOperations(unknown, edits({}))).reason).toBe(
      'edit_source_unsupported',
    );
    // Элемент payload'а не в форме {tool, input}
    expect(
      reasonOf(() => buildEditedOperations([{ tool: 'entity_update' }], edits({}))).reason,
    ).toBe('edit_source_unsupported');
    // Имя тула с прототипа: поиск схемы объектным литералом отдал бы функцию, а не undefined
    const proto: Operation[] = [{ tool: 'constructor', input: {} }];
    expect(reasonOf(() => buildEditedOperations(proto, edits({}))).reason).toBe(
      'edit_source_unsupported',
    );
  });

  test('пустая правка переносит payload без изменений', () => {
    const source = [updateOp(), createOp(), relationOp()];
    expect(buildEditedOperations(source, edits({}))).toEqual(source);
  });
});

describe('editsHash', () => {
  test('перестановка элементов fields не меняет хеш; другая правка — другой хеш; формат /^[0-9a-f]{64}$/', () => {
    const a = edits({
      fields: [
        { index: 1, field: 'title', value: 'вторая' },
        { index: 0, aspect: 'orbis/task', field: 'status', value: 'done' },
      ],
    });
    const b = edits({
      fields: [
        { index: 0, aspect: 'orbis/task', field: 'status', value: 'done' },
        { index: 1, field: 'title', value: 'вторая' },
      ],
    });
    expect(editsHash(a)).toBe(editsHash(b));

    // hex в нижнем регистре обязателен: pendingMessageId лоуэркейсит ключ (ids.ts:63-64)
    expect(editsHash(a)).toMatch(/^[0-9a-f]{64}$/);

    // Другое значение — другая личность правки
    const c = edits({
      fields: [
        { index: 0, aspect: 'orbis/task', field: 'status', value: 'planned' },
        { index: 1, field: 'title', value: 'вторая' },
      ],
    });
    expect(editsHash(c)).not.toBe(editsHash(a));

    // Порядок КЛЮЧЕЙ во входе тоже не значим (jsonb его не хранит)
    const bodyA = edits({ body: [{ index: 0, bodyDoc: docOf([]) }] });
    const bodyB = edits({ body: [{ bodyDoc: docOf([]), index: 0 }] });
    expect(editsHash(bodyA)).toBe(editsHash(bodyB));
    expect(editsHash(bodyA)).not.toBe(editsHash(a));

    // Перестановка body по index тоже не меняет личность
    const two = [
      { index: 1, bodyDoc: BODY_DOC },
      { index: 0, bodyDoc: docOf([]) },
    ];
    expect(editsHash(edits({ body: two }))).toBe(editsHash(edits({ body: [...two].reverse() })));
  });
});

describe('editsSchema и isEmptyEdits', () => {
  test('isEmptyEdits: {body:[],fields:[]} — пусто', () => {
    expect(isEmptyEdits(edits({}))).toBe(true);
    expect(isEmptyEdits(edits({ body: [], fields: [] }))).toBe(true);
    expect(isEmptyEdits(edits({ fields: [{ index: 0, field: 'title', value: 'есть' }] }))).toBe(
      false,
    );
    expect(isEmptyEdits(edits({ body: [{ index: 0, bodyDoc: BODY_DOC }] }))).toBe(false);
  });

  test('контракт входа: strict, скалярное значение, потолки', () => {
    expect(
      editsSchema.safeParse({ fields: [{ index: 0, field: 'tags', value: ['a'] }] }).success,
    ).toBe(false);
    expect(editsSchema.safeParse({ body: [], fields: [], extra: 1 }).success).toBe(false);
    expect(
      editsSchema.safeParse({ fields: [{ index: -1, field: 'title', value: 'x' }] }).success,
    ).toBe(false);
    expect(
      editsSchema.safeParse({ fields: [{ index: 0, aspect: '', field: 'title', value: 'x' }] })
        .success,
    ).toBe(false);
    expect(
      editsSchema.safeParse({ body: [{ index: 0, bodyDoc: { v: 1, doc: { type: 'doc' } } }] })
        .success,
    ).toBe(false);
    const many = Array.from({ length: 51 }, (_, index) => ({ index, bodyDoc: BODY_DOC }));
    expect(editsSchema.safeParse({ body: many }).success).toBe(false);
    const manyFields = Array.from({ length: 201 }, (_, i) => ({
      index: 0,
      field: `f${i}`,
      value: 'x',
    }));
    expect(editsSchema.safeParse({ fields: manyFields }).success).toBe(false);
  });
});
