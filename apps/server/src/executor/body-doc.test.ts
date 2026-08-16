// Путь записи тела в двух формах: UI шлёт bodyDoc, модель — строковый body, а в БД всегда
// ложатся ОБЕ формы, причём `body` — КАНОН (производная документа), а не «как написала модель».
// Env: DATABASE_URL (orbis_app, RLS) + DATABASE_URL_ADMIN (truncate/сверка колонок).
//
// Ожидаемые значения здесь ЛИТЕРАЛЬНЫЕ, а не вычисленные теми же parseBody/serializeBody,
// которыми пользуется сервер: сравнение «канон равен входу» проходит тождественно, если тело
// уехало в rawBlock (raw отдаёт свой вход дословно), и такой ассерт зелен по ложной причине.
import { afterAll, describe, expect, test } from 'bun:test';
import {
  type EntityGetUiInput,
  entityGetInput,
  entityGetUiInput,
  entityUpdateInput,
  entityUpdateUiInput,
} from '@orbis/shared';
import { canonicalizeBody, DOC_SCHEMA_VERSION, serializeBody } from '@orbis/shared/doc';
import { eq, sql } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { readEntity } from '../entity-read';
import { dispatchTool, type ToolCallCtx } from '../tools/dispatch';
import { toWireEntity, toWireEntityFromSql } from '../wire';
import { execute } from './executor';
import { makeChatJournalSink } from './journal';
import { extractBodyRefs } from './normalize';
import type { ExecuteOk, ExecuteRequest, WireEntity } from './types';
import { undoAction } from './undo';

requireEnv();

const { db, client } = appDb();
const { db: admin, client: adminClient } = adminDb();

afterAll(async () => {
  await truncateAll();
  await client.end();
  await adminClient.end();
});

const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const UUID_IN_CODE = '11111111-1111-4111-8111-111111111111';

/** Одиночный вызов executor'а от лица владельца из UI. */
function req(tool: string, input: unknown, actorUserId: string): ExecuteRequest {
  return { actorUserId, actorKind: 'owner', source: 'ui', operations: [{ tool, input }] };
}

interface StoredRow {
  body: string;
  body_doc: { v: number; doc: Record<string, unknown> } | null;
  body_refs: string[];
}

async function rowOf(id: string): Promise<StoredRow> {
  const rows = await admin.execute(
    sql`SELECT body, body_doc, body_refs FROM entities WHERE id = ${id}`,
  );
  const row = rows[0];
  if (!row) throw new Error(`строка ${id} не найдена`);
  return row as unknown as StoredRow;
}

function okFirst(r: Awaited<ReturnType<typeof execute>>): WireEntity {
  if (!r.ok) throw new Error(`ожидался успех, получено ${r.error.code}: ${r.error.message}`);
  return (r as ExecuteOk).results[0] as WireEntity;
}

/**
 * Код И текст отказа. Только кода мало: пока `bodyDoc` не входил в схему разбора executor'а,
 * VALIDATION давал strict-zod («невалидный input тула»), и проверка гейта была зелена по
 * ложной причине — гейт при этом не срабатывал ни разу.
 */
function err(r: Awaited<ReturnType<typeof execute>>): { code: string; message: string } {
  if (r.ok) throw new Error('ожидался отказ, получен успех');
  return { code: r.error.code, message: r.error.message };
}

/** Свежий владелец + пустая сущность: гейт §5.2 проверяется на update, а не на create. */
async function createOne(body?: string): Promise<{ entity: WireEntity; owner: string }> {
  const owner = freshUserId();
  const input: Record<string, unknown> = { title: 'проба', tags: [] };
  if (body !== undefined) input.body = body;
  const entity = okFirst(await execute(db, req('entity_create', input, owner)));
  return { entity, owner };
}

/** Первый узел документа — им проверяется ПРЕДПОСЫЛКА теста (raw это или разобранное дерево). */
function firstNodeType(row: StoredRow): unknown {
  const content = row.body_doc?.doc.content as Array<{ type?: string }> | undefined;
  return content?.[0]?.type;
}

describe('контракт UI: bodyDoc живёт в *UiInput, а не в тул-контракте', () => {
  test('bodyDoc принимается UI-схемой', () => {
    const r = entityUpdateUiInput.safeParse({
      id: UUID,
      bodyDoc: { v: 1, doc: { type: 'doc', content: [] } },
      expectedUpdatedAt: '2026-08-13T10:00:00.000Z',
    });
    expect(r.success).toBe(true);
  });

  test('body и bodyDoc одновременно — отказ ИМЕННО из-за конфликта форм', () => {
    // Два источника правды в одном запросе: тихий выбор одного из них потерял бы вторую правку.
    const r = entityUpdateUiInput.safeParse({
      id: UUID,
      body: 'текст',
      bodyDoc: { v: 1, doc: { type: 'doc', content: [] } },
      expectedUpdatedAt: '2026-08-13T10:00:00.000Z',
    });
    expect(r.success).toBe(false);
    // Сверяем причину, а не только факт: голого `success === false` мало — после любого
    // ужесточения bodyDocSchema сторож стал бы зелёным по ДРУГОЙ причине (структурная
    // придирка к документу вместо конфликта форм) и перестал бы охранять то, что заявляет.
    expect(r.error?.issues.map((i) => ({ path: i.path, message: i.message }))).toEqual([
      { path: ['bodyDoc'], message: 'body и bodyDoc одновременно недопустимы' },
    ]);
  });

  test('UI-схема остаётся strict: посторонний ключ отвергается', () => {
    const r = entityUpdateUiInput.safeParse({ id: UUID, somethingElse: 1 });
    expect(r.success).toBe(false);
  });

  test('схема отвергает документ, который не является документом', () => {
    // Дешёвая структурная сетка: ловит {doc:{}} и content-не-массив, не моделируя НИ ОДНОЙ
    // ноды. Именно эти формы serializeBody молча превращает в пустую строку.
    const parse = (doc: unknown) =>
      entityUpdateUiInput.safeParse({ id: UUID, bodyDoc: { v: 1, doc } }).success;
    expect(parse({})).toBe(false);
    expect(parse({ type: 'doc', content: 'oops' })).toBe(false);
    expect(parse({ type: 'НЕ_ДОКУМЕНТ', content: [] })).toBe(false);
    expect(parse({ type: 'doc', content: [] })).toBe(true);
    expect(parse({ type: 'doc', content: [{ type: 'paragraph' }] })).toBe(true);
  });

  test('схема НЕ обрезает документ: посторонние ключи доезжают до executor’а', () => {
    // .passthrough(): zod по умолчанию срезал бы всё, чего нет в форме, — и правда о теле
    // приехала бы в БД урезанной. Схема здесь сетка, а не модель дерева.
    const r = entityUpdateUiInput.safeParse({
      id: UUID,
      bodyDoc: {
        v: 1,
        doc: {
          type: 'doc',
          content: [{ type: 'paragraph', attrs: { blockId: 'b1' }, content: [] }],
          какой_то_ключ: 1,
        },
      },
    });
    expect(r.success).toBe(true);
    const doc = r.data && 'bodyDoc' in r.data ? r.data.bodyDoc?.doc : undefined;
    expect(doc).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { blockId: 'b1' }, content: [] }],
      какой_то_ключ: 1,
    });
  });
});

describe('канон: body в БД — производная документа, а не вход', () => {
  test('строковый body от модели ложится КАНОНОМ, а не как написан (create)', async () => {
    const { entity } = await createOne('* раз\n* два');
    const row = await rowOf(entity.id);
    // Звёздочка маркера — не канон: сериализатор пишет дефис. Литерал ловит и уход в raw
    // (там строка вернулась бы дословно со звёздочками).
    expect(row.body).toBe('- раз\n- два');
    expect(firstNodeType(row)).toBe('bulletList');
  });

  test('строковый body от модели ложится КАНОНОМ (update)', async () => {
    const { entity, owner } = await createOne();
    const r = await execute(
      db,
      req(
        'entity_update',
        { id: entity.id, body: '* раз\n* два', expectedUpdatedAt: entity.updatedAt },
        owner,
      ),
    );
    okFirst(r);
    const row = await rowOf(entity.id);
    expect(row.body).toBe('- раз\n- два');
    expect(firstNodeType(row)).toBe('bulletList');
  });

  test('сервер сам собирает документ из строкового body', async () => {
    const { entity } = await createOne('# Заголовок');
    const row = await rowOf(entity.id);
    // Литеральное дерево, а не parseBody(...) обеими сторонами: иначе уход тела в rawBlock
    // прошёл бы тождественно и проверка не проверяла бы ничего.
    expect(row.body_doc).toEqual({
      v: 1,
      doc: {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Заголовок' }] },
        ],
      },
    });
  });

  test('bodyDoc из UI: в БД ложатся ОБЕ формы, body = сериализация документа', async () => {
    const { entity, owner } = await createOne();
    const doc = {
      v: 1,
      doc: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'текст' }] },
          { type: 'queryBlock', attrs: { query: ' aspect=orbis/task, status=inbox' } },
        ],
      },
    };
    const r = await execute(
      db,
      req(
        'entity_update',
        { id: entity.id, bodyDoc: doc, expectedUpdatedAt: entity.updatedAt },
        owner,
      ),
    );
    okFirst(r);
    const row = await rowOf(entity.id);
    expect(row.body_doc).toEqual(doc);
    expect(row.body).toBe('текст\n\n{{query: aspect=orbis/task, status=inbox}}');
  });
});

describe('структурная целость документа — вопросом К СХЕМЕ (раунд правок 2)', () => {
  const BROKEN_MESSAGE = 'документ не соответствует схеме — правка отклонена';

  /** Правка bodyDoc поверх непустого тела со ссылкой: у неудачи должно быть что терять. */
  async function tryDoc(doc: unknown) {
    const { entity, owner } = await createOne(`исходное тело [[entity:${UUID}]]`);
    const r = await execute(
      db,
      req(
        'entity_update',
        { id: entity.id, bodyDoc: { v: 1, doc }, expectedUpdatedAt: entity.updatedAt },
        owner,
      ),
    );
    return { r, row: await rowOf(entity.id) };
  }

  /** Отказ ИМЕННО от схемы: код + дословный текст. Голого кода мало — см. докблок err(). */
  async function expectRejected(doc: unknown) {
    const { r, row } = await tryDoc(doc);
    expect(err(r)).toEqual({ code: 'VALIDATION', message: BROKEN_MESSAGE });
    // Ни одна из форм не тронута — отказ случился до записи.
    expect(row.body).toBe(`исходное тело [[entity:${UUID}]]`);
    expect(row.body_refs).toEqual([UUID]);
    return r;
  }

  test('документ из одной неизвестной ноды — VALIDATION, тело и ссылки целы', async () => {
    // serializeBody исключения не бросает: он молча отдаёт ''. Без гейта запись обнулила бы
    // и body, и body_refs, а в body_doc остался бы тот же мусор — readBodyDoc пропускает его
    // по версии, так что обе формы терялись бы с 200 OK.
    await expectRejected({ type: 'doc', content: [{ type: 'НЕТ_ТАКОЙ_НОДЫ' }] });
  });

  test('text-нода без text — VALIDATION, тело цело', async () => {
    await expectRejected({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text' }] }],
    });
  });

  test('нарушенная вложенность ловится на ЛЮБОЙ глубине', async () => {
    // check() рекурсивен — перечислением верхнего уровня это не поймать.
    await expectRejected({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'paragraph' }] }],
    });
  });

  test('неизвестная МАРКА тоже отвергается', async () => {
    await expectRejected({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'НЕТ' }] }] },
      ],
    });
  });

  test('документ БЕЗ узлов (content: []) отвергается — топ-узел объявлен block+', async () => {
    // Согласовано с Задачей 2: emptyDoc() именно поэтому делает один абзац, а не пустой список
    // (convert.ts). Редактор такой документ и не производит — ProseMirror его не удержит.
    // Zod-сетка его пропускает (она про форму, не про схему), отвергает валидация.
    await expectRejected({ type: 'doc', content: [] });
  });

  test('незнакомая схеме нода отвергается ДАЖЕ при частично годном теле', async () => {
    // Смена границы раунда 2. Раньше этот класс проходил: проекция была непустой
    // ("важный текст\n\n"), гейт по пустоте молчал, и документ ложился с нодой, которой сервер
    // не знает. Схема отвергает его целиком — и это строже намеренно: тихо сохранить половину
    // документа хуже, чем отказать. Версионный перекос сюда не попадает — его ловит гейт версии.
    await expectRejected({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'важный текст' }] },
        { type: 'НЕТ_ТАКОЙ_НОДЫ' },
      ],
    });
  });

  test('незнакомые схеме АТРИБУТЫ проходят и доезжают до БД дословно', async () => {
    // Решающее для редактора: блочные id даёт UniqueID, а он живёт только в редакторе и в
    // DOC_EXTENSIONS его НЕТ. Схема такие атрибуты пропускает, но nodeFromJSON().toJSON() их
    // теряет — поэтому в БД обязан ехать ВХОД. Отвергни схема attrs.id — не сохранялось бы
    // вообще ничего; запиши мы toJSON() — молча пропадали бы id блоков.
    const { entity, owner } = await createOne('было');
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { id: 'blk-1' }, content: [{ type: 'text', text: 'текст' }] },
      ],
    };
    okFirst(
      await execute(
        db,
        req(
          'entity_update',
          { id: entity.id, bodyDoc: { v: 1, doc }, expectedUpdatedAt: entity.updatedAt },
          owner,
        ),
      ),
    );
    const row = await rowOf(entity.id);
    expect(row.body_doc).toEqual({ v: 1, doc }); // attrs.id на месте
    expect(row.body).toBe('текст');
  });
});

describe('body из bodyDoc — КАНОНИЧЕН (итоговое ревью, находка 3)', () => {
  /** Записывает документ через путь редактора и отдаёт строку БД. */
  async function writeDoc(doc: unknown): Promise<StoredRow> {
    const { entity, owner } = await createOne();
    okFirst(
      await execute(
        db,
        req(
          'entity_update',
          { id: entity.id, bodyDoc: { v: 1, doc }, expectedUpdatedAt: entity.updatedAt },
          owner,
        ),
      ),
    );
    return rowOf(entity.id);
  }

  test('несущий инвариант хранения на документах ИЗ НАХОДОК 1 и 2', async () => {
    // Проверялись версия и структура, но НЕ то, ради чего вся конструкция затеяна: что body —
    // неподвижная точка канона. Через этот шов проходили обе порчи, и ни один тест их не ловил.
    const docs: Array<[string, unknown]> = [
      [
        'вложенные ограды кода',
        {
          type: 'doc',
          content: [
            {
              type: 'codeBlock',
              attrs: { language: null },
              content: [{ type: 'text', text: '```\nвнутри\n```' }],
            },
          ],
        },
      ],
      [
        'подпись ссылки со скобкой',
        {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'См. ' },
                { type: 'entityRef', attrs: { entityId: UUID, label: 'Задача ] хвост' } },
              ],
            },
          ],
        },
      ],
      [
        'setext под мягким переносом',
        {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'foo' },
                { type: 'hardBreak' },
                { type: 'text', text: '===' },
              ],
            },
          ],
        },
      ],
    ];
    for (const [name, doc] of docs) {
      const row = await writeDoc(doc);
      // Страж вакуумности: пустое тело инвариант выполняет тождественно и не утверждает ничего.
      expect(`${name}: ${row.body}`).not.toBe(`${name}: `);
      expect(`${name}: ${canonicalizeBody(row.body).body}`).toBe(`${name}: ${row.body}`);
      // И пара согласована — документ печатается ровно в то, что лежит в body.
      expect(serializeBody(row.body_doc as never)).toBe(row.body);
    }
  });

  test('ссылка с подписью-скобкой ОСТАЁТСЯ в body_refs, а не выпадает из графа', async () => {
    // Последствие находки 2, которое тяжелее косметики: при первой пересборке документа из
    // текста чип становился обычным текстом, и связь исчезала.
    const row = await writeDoc({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'entityRef', attrs: { entityId: UUID, label: 'Отчёт [черновик]' } }],
        },
      ],
    });
    expect(row.body_refs).toEqual([UUID]);
    expect(extractBodyRefs(row.body)).toEqual([UUID]); // и по ТЕКСТУ она тоже находится
  });

  test('неканоничная проекция уходит в raw, а не отказом — и текст цел до байта', async () => {
    // Модель следующей ноды с несимметричным сериализатором (сегодня подделана rawBlock'ом
    // с неканоничным текстом). Отказ здесь был бы хуже болезни: VALIDATION терминален,
    // автосохранение встало бы и человек потерял бы возможность писать.
    const row = await writeDoc({
      type: 'doc',
      content: [
        { type: 'rawBlock', attrs: { markdown: `* раз [[entity:${UUID}]]` } },
        { type: 'paragraph', content: [{ type: 'text', text: 'хвост' }] },
      ],
    });
    expect(row.body).toBe(`* раз [[entity:${UUID}]]\n\nхвост`); // звёздочку канон НЕ переписал
    expect(firstNodeType(row)).toBe('rawBlock');
    expect(row.body_doc?.doc.content).toHaveLength(1); // весь документ подменён дословным текстом
    expect(serializeBody(row.body_doc as never)).toBe(row.body);
    expect(row.body_refs).toEqual([UUID]); // связь из raw достаётся регэкспом (Б2)
  });

  test('документ с ПУСТЫМИ АБЗАЦАМИ доезжает целым (ре-ревью, Б1)', async () => {
    // Регресс раунда 1: страховка требовала неподвижности канона, а markdown пустой абзац
    // выразить не умеет — заметка человека схлопывалась в один неправимый rawBlock на каждом
    // круге автосохранения. Проверяем сквозь executor и БД, а не только на чистых функциях.
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'План' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'первый пункт' }] },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'раз' }] }],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'два' }] }],
            },
          ],
        },
        { type: 'paragraph' }, // человек нажал Enter в конце
      ],
    };
    const row = await writeDoc(doc);
    expect(row.body_doc).toEqual({ v: 1, doc }); // структура цела, ничего не схлопнулось
    expect(firstNodeType(row)).toBe('heading');
    expect(row.body).toBe('# План\n\nпервый пункт\n\n- раз\n- два\n\n');
    // Пара по-прежнему согласована — инвариант не принесён в жертву.
    expect(serializeBody(row.body_doc as never)).toBe(row.body);
  });

  test('обычный документ страховка НЕ трогает (страж от жадности)', async () => {
    // Без этого теста «страховка срабатывает всегда» была бы неотличима от починки: каждое
    // сохранение превращало бы документ в один raw-блок и убивало редактор.
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { id: 'blk-1' }, content: [{ type: 'text', text: 'текст' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] },
      ],
    };
    const row = await writeDoc(doc);
    expect(row.body_doc).toEqual({ v: 1, doc }); // тот же документ, блочный id на месте
    expect(firstNodeType(row)).toBe('paragraph');
  });
});

describe('все законные формы пустоты сохраняются (раунд правок 2)', () => {
  // Сквозная граница гейта. Каждая из этих форм сериализуется в '' (замерено), и гейт по
  // признаку «пустая проекция» отверг бы четыре из пяти. Худший случай был не транзиентным, а
  // ЗАЛИПАЮЩИМ: у заметки из одного заголовка стёрли текст — нода heading остаётся, документ
  // даёт '', и каждое автосохранение возвращало бы отказ, пока человек не снесёт блок.
  const BLANK_FORMS: Array<[string, unknown]> = [
    ['один пустой абзац', [{ type: 'paragraph' }]],
    ['пустой абзац с content: []', [{ type: 'paragraph', content: [] }]],
    ['несколько пустых абзацев', [{ type: 'paragraph' }, { type: 'paragraph' }]],
    ['ПУСТОЙ ЗАГОЛОВОК (стёрли текст заголовка)', [{ type: 'heading', attrs: { level: 1 } }]],
    [
      'абзац с одним hardBreak (Shift+Enter)',
      [{ type: 'paragraph', content: [{ type: 'hardBreak' }] }],
    ],
    [
      'абзац из пробельного текста',
      [{ type: 'paragraph', content: [{ type: 'text', text: '   ' }] }],
    ],
  ];

  for (const [name, content] of BLANK_FORMS) {
    test(`${name} — сохраняется, тело пустеет`, async () => {
      const { entity, owner } = await createOne(`было тело [[entity:${UUID}]]`);
      const r = await execute(
        db,
        req(
          'entity_update',
          {
            id: entity.id,
            bodyDoc: { v: 1, doc: { type: 'doc', content } },
            expectedUpdatedAt: entity.updatedAt,
          },
          owner,
        ),
      );
      okFirst(r);
      const row = await rowOf(entity.id);
      expect(row.body.trim()).toBe('');
      expect(row.body_refs).toEqual([]);
      // Документ лёг дословно — пустота сохранена как форма, а не «починена» сервером.
      expect(row.body_doc).toEqual({ v: 1, doc: { type: 'doc', content } });
    });
  }

  test('повторное сохранение той же пустоты не залипает (автосейв не долбит отказом)', async () => {
    // Регрессия на залипающий сценарий: второе автосохранение того же состояния обязано пройти.
    const { entity, owner } = await createOne('# Заголовок');
    const doc = { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 } }] };
    const first = await execute(
      db,
      req(
        'entity_update',
        { id: entity.id, bodyDoc: { v: 1, doc }, expectedUpdatedAt: entity.updatedAt },
        owner,
      ),
    );
    const afterFirst = okFirst(first);
    const second = await execute(
      db,
      req(
        'entity_update',
        { id: entity.id, bodyDoc: { v: 1, doc }, expectedUpdatedAt: afterFirst.updatedAt },
        owner,
      ),
    );
    expect(okFirst(second).body).toBe('');
  });
});

describe('версия документа сверяется НА ЗАПИСИ (раунд правок 1)', () => {
  test('документ версии из будущего — VALIDATION, содержимое не урезается', async () => {
    // Цепочка без гейта (воспроизведена пробой): клиент новее сервера шлёт ноду, которой
    // сервер не знает → serializeBody ТИХО выбрасывает её из body ("начало\n\n" вместо текста
    // callout'а) → body_doc с v=2 сохраняется → на первом же чтении readBodyDoc отвергает его
    // по версии и пересобирает из УЖЕ УРЕЗАННОГО body. Содержимое исчезает из обеих форм.
    // Ровно то, ради чего версия и заведена (doc/types.ts: «откат релиза съел бы содержимое»).
    const { entity, owner } = await createOne('исходное тело');
    const r = await execute(
      db,
      req(
        'entity_update',
        {
          id: entity.id,
          bodyDoc: {
            v: 2,
            doc: {
              type: 'doc',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'начало' }] },
                { type: 'callout', content: [{ type: 'text', text: 'ВАЖНОЕ' }] },
              ],
            },
          },
          expectedUpdatedAt: entity.updatedAt,
        },
        owner,
      ),
    );
    // Причина сверяется дословно: отказ обязан быть ПО ВЕРСИИ, а не потому что схема не
    // узнала ноду callout. Иначе тест выродился бы в дубль структурной проверки и перестал
    // охранять гейт версии.
    expect(err(r)).toEqual({
      code: 'VALIDATION',
      message: 'документ другой версии схемы: перезагрузите приложение и повторите правку',
    });
    const row = await rowOf(entity.id);
    expect(row.body).toBe('исходное тело');
    expect(row.body_doc).toEqual({
      v: 1,
      doc: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'исходное тело' }] }],
      },
    });
  });

  test('запись принимает ровно ту версию, которую примет чтение', async () => {
    // Симметрия — суть правки: readBodyDoc гарантированно выбрасывает любой v !== 1, значит
    // принимать такое на запись значило бы сохранять заведомо обречённое.
    expect(DOC_SCHEMA_VERSION).toBe(1);
    const { entity, owner } = await createOne();
    const ok = await execute(
      db,
      req(
        'entity_update',
        {
          id: entity.id,
          bodyDoc: {
            v: DOC_SCHEMA_VERSION,
            doc: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ок' }] }],
            },
          },
          expectedUpdatedAt: entity.updatedAt,
        },
        owner,
      ),
    );
    expect(okFirst(ok).body).toBe('ок');
  });
});

describe('body_refs — из дерева ∪ raw в обеих ветках', () => {
  test('create: ссылка в блоке кода связью не считается', async () => {
    const body = `живая [[entity:${UUID}]]\n\n\`\`\`\n[[entity:${UUID_IN_CODE}]]\n\`\`\``;
    const { entity } = await createOne(body);
    const row = await rowOf(entity.id);
    expect(row.body_refs).toEqual([UUID]);
  });

  test('update строковым body: ссылка в блоке кода связью не считается', async () => {
    const { entity, owner } = await createOne();
    const body = `живая [[entity:${UUID}]]\n\n\`\`\`\n[[entity:${UUID_IN_CODE}]]\n\`\`\``;
    okFirst(
      await execute(
        db,
        req('entity_update', { id: entity.id, body, expectedUpdatedAt: entity.updatedAt }, owner),
      ),
    );
    const row = await rowOf(entity.id);
    expect(row.body_refs).toEqual([UUID]);
  });

  test('update через bodyDoc: ссылки берутся из дерева', async () => {
    const { entity, owner } = await createOne();
    const doc = {
      v: 1,
      doc: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'entityRef', attrs: { entityId: UUID, label: null } }],
          },
          {
            type: 'codeBlock',
            attrs: { language: null },
            content: [{ type: 'text', text: `[[entity:${UUID_IN_CODE}]]` }],
          },
        ],
      },
    };
    okFirst(
      await execute(
        db,
        req(
          'entity_update',
          { id: entity.id, bodyDoc: doc, expectedUpdatedAt: entity.updatedAt },
          owner,
        ),
      ),
    );
    const row = await rowOf(entity.id);
    expect(row.body_refs).toEqual([UUID]);
  });

  test('create: тело, ушедшее в raw целиком, не теряет body_refs', async () => {
    // Сноска GFM: reference-определения marked восстановить нечем — весь исходник в rawBlock.
    const body = `текст[^1] и [[entity:${UUID}]]\n\n[^1]: сноска`;
    const { entity } = await createOne(body);
    const row = await rowOf(entity.id);
    // Предпосылка теста: это действительно raw. Без неё тест однажды перестанет проверять
    // ветку «дерево ∪ raw», молча превратившись в дубль обычного случая.
    expect(firstNodeType(row)).toBe('rawBlock');
    expect(row.body_refs).toEqual([UUID]);
  });

  test('update: тело, ушедшее в raw целиком, не теряет body_refs', async () => {
    const { entity, owner } = await createOne();
    const body = `текст[^1] и [[entity:${UUID}]]\n\n[^1]: сноска`;
    okFirst(
      await execute(
        db,
        req('entity_update', { id: entity.id, body, expectedUpdatedAt: entity.updatedAt }, owner),
      ),
    );
    const row = await rowOf(entity.id);
    expect(firstNodeType(row)).toBe('rawBlock');
    expect(row.body_refs).toEqual([UUID]);
  });
});

describe('гейт §5.2 покрывает ОБА поля тела', () => {
  test('bodyDoc без expectedUpdatedAt — отказ VALIDATION', async () => {
    // Сохранения редактора едут ТОЛЬКО bodyDoc: пока гейт смотрел на input.body, они
    // проходили мимо него и 409 не наступал никогда (ревью Б3).
    const { entity, owner } = await createOne();
    const r = await execute(
      db,
      req(
        'entity_update',
        { id: entity.id, bodyDoc: { v: 1, doc: { type: 'doc', content: [] } } },
        owner,
      ),
    );
    expect(err(r)).toEqual({
      code: 'VALIDATION',
      message: 'правка body требует expectedUpdatedAt (§5.2)',
    });
  });

  test('устаревший expectedUpdatedAt при bodyDoc — STALE_VERSION', async () => {
    const { entity, owner } = await createOne();
    const r = await execute(
      db,
      req(
        'entity_update',
        {
          id: entity.id,
          bodyDoc: { v: 1, doc: { type: 'doc', content: [] } },
          expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
        },
        owner,
      ),
    );
    expect(err(r).code).toBe('STALE_VERSION');
  });

  test('строковый body без expectedUpdatedAt — по-прежнему VALIDATION', async () => {
    const { entity, owner } = await createOne();
    const r = await execute(db, req('entity_update', { id: entity.id, body: 'текст' }, owner));
    expect(err(r)).toEqual({
      code: 'VALIDATION',
      message: 'правка body требует expectedUpdatedAt (§5.2)',
    });
  });

  test('патч без тела гейта не требует (LWW)', async () => {
    const { entity, owner } = await createOne();
    const r = await execute(db, req('entity_update', { id: entity.id, title: 'новое' }, owner));
    expect(okFirst(r).title).toBe('новое');
  });

  test('внутренний undo гейт ПРОПУСКАЕТ — и для body, и для bodyDoc', async () => {
    // Иначе сломался бы откат: inverse-операция журнала expectedUpdatedAt не несёт (§7.8).
    const { entity, owner } = await createOne();
    const internalUndo = { writeUndoMessage: async () => {} };

    const viaBody = await execute(
      db,
      req('entity_update', { id: entity.id, body: 'откат' }, owner),
      {
        internalUndo,
      },
    );
    expect(okFirst(viaBody).body).toBe('откат');

    const viaDoc = await execute(
      db,
      req(
        'entity_update',
        {
          id: entity.id,
          bodyDoc: {
            v: 1,
            doc: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'откат-2' }] }],
            },
          },
        },
        owner,
      ),
      { internalUndo },
    );
    expect(okFirst(viaDoc).body).toBe('откат-2');
    const row = await rowOf(entity.id);
    expect(row.body).toBe('откат-2');
    expect(firstNodeType(row)).toBe('paragraph');
  });
});

describe('откат сохранения редактора', () => {
  test('undo правки через bodyDoc восстанавливает прежнее тело в ОБЕИХ формах', async () => {
    // Сценарий, которого до этой работы не существовало: журнал §7.8 несёт только строковый
    // body, а сохранение пришло документом. Откат идёт «модельной» веткой — и обязан привести
    // body_doc в согласие с восстановленным body, иначе формы разъезжаются молча.
    const sink = makeChatJournalSink();
    const { entity, owner } = await createOne('- раз\n- два');
    const saved = await execute(
      db,
      req(
        'entity_update',
        {
          id: entity.id,
          bodyDoc: {
            v: 1,
            doc: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'новое тело' }] }],
            },
          },
          expectedUpdatedAt: entity.updatedAt,
        },
        owner,
      ),
      { sink },
    );
    okFirst(saved);
    expect((await rowOf(entity.id)).body).toBe('новое тело');

    const undone = await undoAction(db, {
      actorUserId: owner,
      actionId: (saved as ExecuteOk).actionId,
    });
    expect(undone.ok).toBe(true);

    const row = await rowOf(entity.id);
    expect(row.body).toBe('- раз\n- два');
    // Документ пересобран из восстановленного тела: формы согласованы, а не «body откатили,
    // body_doc остался от отменённой правки».
    expect(firstNodeType(row)).toBe('bulletList');
  });
});

describe('bodyDoc не протекает в путь модели (dispatch/MCP)', () => {
  // Вход модели и MCP идёт через dispatchTool → validateMutationEnvelope с УЗКИМ
  // entityUpdateInput, и strict-zod отклоняет лишний ключ ДО классификации §7.10 и до
  // executor'а. Схема разбора executor'а при этом шире — проверяем, что второй линией
  // она первую не отменяет.
  const modelCtx = (owner: string): ToolCallCtx => ({
    db,
    actorUserId: owner,
    actorKind: 'ai',
    source: 'chat',
    explicitCommand: false,
  });

  test('одиночный entity_update с bodyDoc от модели — VALIDATION', async () => {
    const { entity, owner } = await createOne();
    const r = await dispatchTool(modelCtx(owner), 'entity_update', {
      id: entity.id,
      bodyDoc: { v: 1, doc: { type: 'doc', content: [] } },
      expectedUpdatedAt: entity.updatedAt,
    });
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.error.code).toBe('VALIDATION');
    // Тело не тронуто: отказ случился ДО записи.
    expect((await rowOf(entity.id)).body).toBe('');
  });

  test('bodyDoc внутри операции batch_execute — VALIDATION', async () => {
    const { entity, owner } = await createOne();
    const r = await dispatchTool(modelCtx(owner), 'batch_execute', {
      batch_id: crypto.randomUUID(),
      operations: [
        {
          tool: 'entity_update',
          input: {
            id: entity.id,
            bodyDoc: { v: 1, doc: { type: 'doc', content: [] } },
            expectedUpdatedAt: entity.updatedAt,
          },
        },
      ],
    });
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.error.code).toBe('VALIDATION');
    expect((await rowOf(entity.id)).body).toBe('');
  });

  test('тул-контракт модели поля bodyDoc не содержит — ни на запись, ни на чтение', () => {
    expect(Object.keys(entityUpdateInput.shape)).not.toContain('bodyDoc');
    expect(entityUpdateInput.safeParse({ id: UUID, bodyDoc: { v: 1, doc: {} } }).success).toBe(
      false,
    );
    // include('bodyDoc') — тоже только UI: модели документ не нужен, ей едет body.
    expect(entityGetInput.safeParse({ id: UUID, include: ['bodyDoc'] }).success).toBe(false);
    expect(entityGetUiInput.safeParse({ id: UUID, include: ['bodyDoc'] }).success).toBe(true);
  });
});

describe('документ наружу — только по явному include', () => {
  test('wire-форма без флага документа не несёт; entity.query-путь его не отдаёт вовсе', async () => {
    const { entity } = await createOne('# Заголовок');
    // Результат мутации (то, что уезжает роутером update) — без документа.
    expect('bodyDoc' in entity).toBe(false);

    const rows = await admin.execute(sql`SELECT * FROM entities WHERE id = ${entity.id}`);
    const raw = rows[0] as unknown as Record<string, unknown>;
    // Путь entity.query (compileQuery → toWireEntityFromSql): документ не отдаётся намеренно —
    // спискам он не нужен, а вес ответа удвоился бы.
    expect('bodyDoc' in toWireEntityFromSql(raw)).toBe(false);

    const dbRows = await admin.select().from(entities).where(eq(entities.id, entity.id));
    const row = dbRows[0];
    if (!row) throw new Error('строка не найдена');
    expect('bodyDoc' in toWireEntity(row)).toBe(false);
    expect(toWireEntity(row, true).bodyDoc).not.toBeUndefined();
  });

  test('entity_get без include(bodyDoc) документа не несёт, с ним — несёт', async () => {
    const { entity, owner } = await createOne('# Заголовок');
    const read = (include: EntityGetUiInput['include']) =>
      withIdentity(db, owner, (tx) => readEntity(tx, owner, { id: entity.id, include }));

    expect('bodyDoc' in (await read(['body'])).entity).toBe(false);
    expect((await read(['body', 'bodyDoc'])).entity.bodyDoc).toEqual({
      v: 1,
      doc: {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Заголовок' }] },
        ],
      },
    });
  });

  test('строка без документа (до этой работы) конвертируется ЛЕНИВО и обратно в БД не пишется', async () => {
    const { entity, owner } = await createOne('# Заголовок');
    // Строка «из прошлого»: колонка ещё не заполнена бэкфиллом.
    await admin.execute(sql`UPDATE entities SET body_doc = NULL WHERE id = ${entity.id}`);

    const out = await withIdentity(db, owner, (tx) =>
      readEntity(tx, owner, { id: entity.id, include: ['body', 'bodyDoc'] }),
    );
    expect(out.entity.bodyDoc).toEqual({
      v: 1,
      doc: {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Заголовок' }] },
        ],
      },
    });
    // Чтение обязано оставаться чтением: колонку заполнит бэкфилл или первое же сохранение.
    expect((await rowOf(entity.id)).body_doc).toBeNull();
  });

  test('версия документа из будущего пересобирается из body (правило Р1)', async () => {
    const { entity, owner } = await createOne('# Заголовок');
    // Откат релиза: в колонке лежит схема, которой этот сервер не знает.
    await admin.execute(
      sql`UPDATE entities SET body_doc = ${JSON.stringify({ v: 999, doc: { type: 'doc', content: [] } })}::jsonb WHERE id = ${entity.id}`,
    );
    const out = await withIdentity(db, owner, (tx) =>
      readEntity(tx, owner, { id: entity.id, include: ['bodyDoc'] }),
    );
    // Не пустой документ из будущего, а пересборка из текста: теряется оформление, не текст.
    expect(out.entity.bodyDoc?.v).toBe(1);
    expect(out.entity.body).toBe('# Заголовок');
  });
});
