// Интеграционный тест разовой конверсии тел в структурную форму (Задача 4).
// Env: DATABASE_URL_ADMIN — бэкфилл служебный, RLS-скоуп владельца ему не нужен.
import { afterAll, expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
import { DOC_SCHEMA_VERSION, parseBody, serializeBody } from '@orbis/shared/doc';
import { sql } from 'drizzle-orm';
import { adminDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { extractBodyRefs } from '../executor/normalize';
import {
  ALL_TASKS_BODY,
  DAILY_PLANNING_BODY,
  HORIZON_LIFE_BODY,
  HORIZON_YEAR_BODY,
  UPCOMING_BODY,
} from '../seed/smart-lists';
import { type BackfillIo, backfillBodyDoc, drizzleBackfillIo } from './backfill-body-doc';

requireEnv();

// adminDb() возвращает { db, client } и открывает пул НА КАЖДЫЙ вызов — берём один раз и
// закрываем сами, иначе прогон повисает на незакрытых соединениях (образец: executor.test.ts).
const { db: admin, client: adminClient } = adminDb();
const io = drizzleBackfillIo(admin);

afterAll(async () => {
  await truncateAll();
  await adminClient.end();
});

/** Вставка тела админской ролью; возвращает id. */
async function insertBody(body: string): Promise<string> {
  const id = newId();
  await admin.execute(
    sql`INSERT INTO entities (id, owner_id, title, body)
        VALUES (${id}, ${freshUserId()}, 'тело', ${body})`,
  );
  return id;
}

async function readRow(id: string): Promise<{ body: string; bodyDoc: unknown }> {
  const rows = await admin.execute(sql`SELECT body, body_doc FROM entities WHERE id = ${id}`);
  const row = rows[0] as { body: string; body_doc: unknown };
  return { body: row.body, bodyDoc: row.body_doc };
}

test('конвертирует тела без документа и повторно ничего не делает', async () => {
  await truncateAll();
  const id = await insertBody('# Заголовок');
  expect(await backfillBodyDoc(io)).toBe(1);
  // Идемпотентность — не «повторный запуск безвреден», а «повторный запуск НИЧЕГО не берёт»:
  // предикат `body_doc IS NULL` сам вычёркивает сконвертированные строки.
  expect(await backfillBodyDoc(io)).toBe(0);
  const { bodyDoc } = await readRow(id);
  expect(bodyDoc).toEqual(parseBody('# Заголовок') as never);
});

test('проекция сконвертированного совпадает с исходным body', async () => {
  await truncateAll();
  const body = 'текст\n\n{{query: aspect=orbis/task, status=inbox}}';
  const id = await insertBody(body);
  await backfillBodyDoc(io);
  const row = await readRow(id);
  expect(row.body).toBe(body); // тело уже канон — бэкфилл его не трогает
  expect(serializeBody(row.bodyDoc as never)).toBe(body);
});

test('бэкфилл выравнивает body до канона', async () => {
  await truncateAll();
  const id = await insertBody('* раз\n* два');
  expect(await backfillBodyDoc(io)).toBe(1);
  const row = await readRow(id);
  expect(row.body).toBe('- раз\n- два');
  expect(serializeBody(row.bodyDoc as never)).toBe(row.body);
});

test('пустое тело: body остаётся пустой строкой, body_doc — пустой абзац', async () => {
  await truncateAll();
  const id = await insertBody('');
  expect(await backfillBodyDoc(io)).toBe(1);
  const row = await readRow(id);
  // Самый частый случай корпуса (на локальном стенде им были ВСЕ 115 тел), а не краевой:
  // у каждой только что созданной сущности body пуст.
  expect(row.body).toBe('');
  expect(row.bodyDoc).toEqual({
    v: DOC_SCHEMA_VERSION,
    doc: { type: 'doc', content: [{ type: 'paragraph' }] },
  } as never);
  expect(serializeBody(row.bodyDoc as never)).toBe('');
});

test('сиды не сдвигаются: их body остаётся байт-в-байт', async () => {
  await truncateAll();
  const seeds = [
    DAILY_PLANNING_BODY,
    UPCOMING_BODY,
    ALL_TASKS_BODY,
    HORIZON_YEAR_BODY,
    HORIZON_LIFE_BODY,
  ];
  const ids = await Promise.all(seeds.map(insertBody));
  expect(await backfillBodyDoc(io)).toBe(seeds.length);
  for (const [i, id] of ids.entries()) {
    const row = await readRow(id);
    // seed-canon.test.ts утверждает то же на чистых функциях; здесь — что БД после конверсии
    // отдаёт ровно то, что в неё положил сидер, иначе онбординг «поедет» на первом бэкфилле.
    expect(row.body).toBe(seeds[i] as string);
    expect(serializeBody(row.bodyDoc as never)).toBe(seeds[i] as string);
  }
});

test('инвариант пары держится на всём тронутом корпусе', async () => {
  await truncateAll();
  const bodies = [
    '',
    '# Заголовок',
    '* раз\n* два',
    'текст\n\n{{query: aspect=orbis/task, status=inbox}}',
    '<div>непонятое</div>',
    'a\r\nb',
    '| a | b |\n|---|---|\n| x \\| y | z |',
    DAILY_PLANNING_BODY,
  ];
  await Promise.all(bodies.map(insertBody));
  expect(await backfillBodyDoc(io)).toBe(bodies.length);
  const rows = (await admin.execute(sql`SELECT body, body_doc FROM entities`)) as unknown as Array<{
    body: string;
    body_doc: unknown;
  }>;
  expect(rows).toHaveLength(bodies.length);
  for (const row of rows) {
    // Главный инвариант хранения (§3.3 PRD): проекция = сериализация документа. Он обязан
    // держаться С ПЕРВОГО ДНЯ, а не «после первого пересохранения», — ради этого бэкфилл и
    // пишет ОБЕ колонки.
    expect(serializeBody(row.body_doc as never)).toBe(row.body);
  }
});

test('переписанный body не рассинхронизирует body_refs', async () => {
  await truncateAll();
  // body_refs денормализован: его считает extractBodyRefs РЕГЭКСПОМ ПО ТЕКСТУ body, а бэкфилл
  // этот текст переписывает и сам body_refs не пересчитывает. Если бы канон экранировал скобки
  // валидной ссылки (`\[\[entity:…\]\]` — так он поступает с ПОХОЖИМ на ссылку мусором), связи
  // остались бы в колонке, но исчезли из тела: обратные ссылки порвались бы молча и на всём
  // корпусе сразу. Проверяем на всех местах, где ссылка может стоять.
  const u = '019e4466-aaaa-7e07-b5d4-64be9721da51';
  const v = '019e4466-bbbb-7e07-b5d4-64be9721da52';
  const bodies = [
    `[[entity:${u}]]`,
    `[[entity:${u}|Купить молоко]]`,
    `см. [[entity:${u}]] и ещё [[entity:${v}]]`,
    `* пункт [[entity:${u}]]\n* второй`,
    `- [ ] сделать [[entity:${u}]]`,
    `> цитата [[entity:${u}]]`,
    `# Заголовок [[entity:${u}]]`,
    `| a | b |\n|---|---|\n| [[entity:${u}]] | x |`,
    `<div>html</div>\n\nтекст [[entity:${u}]]`,
    `<div>[[entity:${u}]]</div>`, // ссылка внутри raw-блока
    `**жирный [[entity:${u}]]**`,
    `[[entity:${u.toUpperCase()}]]`, // extractBodyRefs приводит к нижнему регистру
  ];
  for (const body of bodies) {
    // Колонка заполняется тем же экстрактором, что и на боевой записи (executor §2.1), —
    // иначе тест сверял бы бэкфилл с выдумкой теста, а не с тем, что кладёт исполнитель.
    // Литерал массива параметром: extractBodyRefs отдаёт только [0-9a-f-]{36}, кавычки не нужны.
    const refs = `{${extractBodyRefs(body).join(',')}}`;
    await admin.execute(
      sql`INSERT INTO entities (id, owner_id, title, body, body_refs)
          VALUES (${newId()}, ${freshUserId()}, 'со ссылкой', ${body}, ${refs}::text[])`,
    );
  }
  expect(await backfillBodyDoc(io)).toBe(bodies.length);
  const rows = (await admin.execute(
    sql`SELECT body, body_refs FROM entities`,
  )) as unknown as Array<{ body: string; body_refs: string[] }>;
  let seen = 0;
  for (const row of rows) {
    // Пересчёт по НОВОМУ телу обязан дать ровно то, что лежит в колонке с момента вставки.
    expect(extractBodyRefs(row.body).sort()).toEqual([...row.body_refs].sort());
    seen += row.body_refs.length;
  }
  // Страховка от вырождения: без неё сверка «пусто = пусто» прошла бы и на корпусе, из
  // которого канон вычистил ВСЕ ссылки, — то есть тест молчал бы ровно про ту поломку,
  // ради которой написан.
  expect(seen).toBe(13); // 12 тел, одно из которых с двумя ссылками
});

/** Очередь из n тел, которую опустошает сам `writeRow`, — как это делает предикат в БД. */
function fakeQueue(n: number): { io: BackfillIo; selects: number[]; left: () => number } {
  const remaining = new Map<string, string>();
  for (let i = 0; i < n; i += 1) remaining.set(`id-${i}`, `тело ${i}`);
  const selects: number[] = [];
  return {
    selects,
    left: () => remaining.size,
    io: {
      selectBatch: async (limit) => {
        selects.push(limit);
        return [...remaining].slice(0, limit).map(([id, body]) => ({ id, body }));
      },
      writeRow: async (row) => {
        remaining.delete(row.id);
      },
    },
  };
}

test('порции: цикл забирает следующую порцию и завершается на хвосте', async () => {
  // Без БД: 450 строк в базе ради проверки арифметики порций стоили бы секунд, а поведение
  // цикла от базы не зависит. Заодно ловится главная опасность порционного цикла —
  // бесконечное вращение на строке, которая не покинула выборку.
  const q = fakeQueue(450);
  expect(await backfillBodyDoc(q.io)).toBe(450);
  expect(q.left()).toBe(0);
  expect(q.selects).toEqual([200, 200, 200]); // 200 + 200 + хвост 50, после хвоста SELECT'а нет
});

test('порции: ровно кратный размер требует последней пустой выборки', async () => {
  // Граница, на которой не срабатывает выход «неполная порция»: 400 = 2 × BATCH. Без второго
  // выхода (`rows.length === 0`) цикл здесь вращался бы вечно.
  const q = fakeQueue(400);
  expect(await backfillBodyDoc(q.io)).toBe(400);
  expect(q.selects).toEqual([200, 200, 200]);
});

test('NULL в body не роняет бэкфилл: считается пустым телом', async () => {
  // `body` в НАШЕЙ схеме NOT NULL, но команда ходит и в ПРОД, чья схема — та, что развёрнута.
  // Проверяем ту же страховку, что стоит в audit-bodies (`?? ''`).
  const rows: Array<{ id: string; body: string | null }> = [{ id: 'x', body: null }];
  const written: Array<{ id: string; body: string }> = [];
  const fake: BackfillIo = {
    selectBatch: async () => rows.splice(0, rows.length),
    writeRow: async (row) => {
      written.push({ id: row.id, body: row.body });
    },
  };
  expect(await backfillBodyDoc(fake)).toBe(1);
  expect(written).toEqual([{ id: 'x', body: '' }]);
});
