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
import {
  type BackfillIo,
  backfillBodyDoc,
  backfillExitCode,
  describeRoleAccess,
  drizzleBackfillIo,
} from './backfill-body-doc';

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
  expect(await backfillBodyDoc(io)).toEqual({ done: 1, skipped: 0, pending: 0 });
  // Идемпотентность — не «повторный запуск безвреден», а «повторный запуск НИЧЕГО не берёт»:
  // предикат `body_doc IS NULL` сам вычёркивает сконвертированные строки.
  expect(await backfillBodyDoc(io)).toEqual({ done: 0, skipped: 0, pending: 0 });
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
  expect(await backfillBodyDoc(io)).toEqual({ done: 1, skipped: 0, pending: 0 });
  const row = await readRow(id);
  expect(row.body).toBe('- раз\n- два');
  expect(serializeBody(row.bodyDoc as never)).toBe(row.body);
});

test('пустое тело: body остаётся пустой строкой, body_doc — пустой абзац', async () => {
  await truncateAll();
  const id = await insertBody('');
  expect(await backfillBodyDoc(io)).toEqual({ done: 1, skipped: 0, pending: 0 });
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
  expect(await backfillBodyDoc(io)).toEqual({ done: seeds.length, skipped: 0, pending: 0 });
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
  const ids = await Promise.all(bodies.map(insertBody));
  expect(await backfillBodyDoc(io)).toEqual({ done: bodies.length, skipped: 0, pending: 0 });
  for (const id of ids) {
    const row = await readRow(id);
    // Инвариант хранения (§3.3 PRD): проекция = сериализация документа. Он обязан держаться
    // С ПЕРВОГО ДНЯ, а не «после первого пересохранения», — ради этого бэкфилл и пишет ОБЕ
    // колонки. Речь именно о СОГЛАСОВАННОСТИ пары: что сам канон ничего не теряет по сравнению
    // с оригиналом — предмет Задачи 2 и замера audit-bodies, а не этого теста.
    expect(serializeBody(row.bodyDoc as never)).toBe(row.body);
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
  const ids: string[] = [];
  for (const body of bodies) {
    // Колонка заполняется тем же экстрактором, что и на боевой записи (executor §2.1), —
    // иначе тест сверял бы бэкфилл с выдумкой теста, а не с тем, что кладёт исполнитель.
    // Литерал массива параметром: extractBodyRefs отдаёт только [0-9a-f-]{36}, кавычки не нужны.
    const refs = `{${extractBodyRefs(body).join(',')}}`;
    const id = newId();
    ids.push(id);
    await admin.execute(
      sql`INSERT INTO entities (id, owner_id, title, body, body_refs)
          VALUES (${id}, ${freshUserId()}, 'со ссылкой', ${body}, ${refs}::text[])`,
    );
  }
  expect(await backfillBodyDoc(io)).toEqual({ done: bodies.length, skipped: 0, pending: 0 });
  let seen = 0;
  for (const id of ids) {
    const rows = (await admin.execute(
      sql`SELECT body, body_refs FROM entities WHERE id = ${id}`,
    )) as unknown as Array<{ body: string; body_refs: string[] }>;
    const row = rows[0] as { body: string; body_refs: string[] };
    // Пересчёт по НОВОМУ телу обязан дать ровно то, что лежит в колонке с момента вставки.
    expect(extractBodyRefs(row.body).sort()).toEqual([...row.body_refs].sort());
    seen += row.body_refs.length;
  }
  // Страховка от вырождения: без неё сверка «пусто = пусто» прошла бы и на корпусе, из
  // которого канон вычистил ВСЕ ссылки, — то есть тест молчал бы ровно про ту поломку,
  // ради которой написан. Считается по КОЛОНКЕ, то есть по входной стороне.
  expect(seen).toBe(13); // 12 тел, одно из которых с двумя ссылками
});

test('правка владельца во время прогона не затирается каноном старого тела', async () => {
  await truncateAll();
  // Гонка «прочитал — записал» (ревью И-1): между выборкой порции и записью строки владелец
  // или агент через MCP успевает отредактировать запись. Без CAS бэкфилл писал бы канон уже
  // УСТАРЕВШЕГО тела поверх свежего — необратимая порча личной записи. Воспроизведено пробой
  // до правки: 'совершенно новый текст владельца' молча превращался в '- раз'.
  const tronutyj = await insertBody('* раз');
  const spokojnyj = await insertBody('* два');
  const novyjTekst = 'совершенно новый текст владельца';
  const racing: BackfillIo = {
    ...io,
    selectBatch: async (limit, afterId) => {
      const rows = await io.selectBatch(limit, afterId);
      await admin.execute(sql`UPDATE entities SET body = ${novyjTekst} WHERE id = ${tronutyj}`);
      return rows;
    },
  };
  // Прогон не зависает и честно называет пропуск: строка не потеряна из счётчиков.
  expect(await backfillBodyDoc(racing)).toEqual({ done: 1, skipped: 1, pending: 1 });

  const touched = await readRow(tronutyj);
  expect(touched.body).toBe(novyjTekst); // текст владельца ЦЕЛ
  expect(touched.bodyDoc).toBeNull(); // осталась на ленивую конверсию при первом чтении
  const calm = await readRow(spokojnyj);
  expect(calm.body).toBe('- два');
  expect(serializeBody(calm.bodyDoc as never)).toBe(calm.body);

  // И она не потеряна навсегда: следующий прогон (уже без гонки) её догоняет.
  expect(await backfillBodyDoc(io)).toEqual({ done: 1, skipped: 0, pending: 0 });
  const after = await readRow(tronutyj);
  expect(after.body).toBe(novyjTekst); // канон этого текста равен ему самому
  expect(serializeBody(after.bodyDoc as never)).toBe(novyjTekst);
});

/**
 * Очередь из n тел с курсором по id — как ведёт себя предикат `body_doc IS NULL AND id > …`
 * в БД. `writesFail` имитирует корпус, ГДЕ КАЖДУЮ строку правят во время прогона.
 */
function fakeQueue(
  n: number,
  opts: { writesFail?: boolean } = {},
): { io: BackfillIo; selects: Array<{ limit: number; afterId: string }>; left: () => number } {
  const remaining = new Map<string, string>();
  // Ключи с ведущими нулями: сравнение строковое, и без выравнивания 'id-10' шло бы раньше
  // 'id-2', то есть порядок курсора разошёлся бы с порядком uuid в БД.
  for (let i = 0; i < n; i += 1) remaining.set(`id-${String(i).padStart(4, '0')}`, `тело ${i}`);
  const selects: Array<{ limit: number; afterId: string }> = [];
  return {
    selects,
    left: () => remaining.size,
    io: {
      selectBatch: async (limit, afterId) => {
        selects.push({ limit, afterId });
        return [...remaining]
          .filter(([id]) => id > afterId)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .slice(0, limit)
          .map(([id, body]) => ({ id, body }));
      },
      writeRow: async (row) => {
        if (opts.writesFail) return false; // CAS не сошёлся — строку тронули
        remaining.delete(row.id);
        return true;
      },
      countPending: async () => remaining.size,
    },
  };
}

test('порции: цикл забирает следующую порцию и завершается на хвосте', async () => {
  // Без БД: 450 строк в базе ради проверки арифметики порций стоили бы секунд, а поведение
  // цикла от базы не зависит.
  const q = fakeQueue(450);
  expect(await backfillBodyDoc(q.io)).toEqual({ done: 450, skipped: 0, pending: 0 });
  expect(q.left()).toBe(0);
  // Три ВЫБОРКИ (не «три порции по 200 строк»): 200 + 200 + хвост 50, после хвоста SELECT'а нет.
  expect(q.selects.map((s) => s.limit)).toEqual([200, 200, 200]);
  // Курсор двигается монотонно и стартует с нуля.
  expect(q.selects.map((s) => s.afterId)).toEqual([
    '00000000-0000-0000-0000-000000000000',
    'id-0199',
    'id-0399',
  ]);
});

test('порции: ровно кратный размер требует последней пустой выборки', async () => {
  // Граница, на которой не срабатывает выход «неполная порция»: 400 = 2 × BATCH. Без второго
  // выхода (`rows.length === 0`) цикл здесь вращался бы вечно.
  const q = fakeQueue(400);
  expect(await backfillBodyDoc(q.io)).toEqual({ done: 400, skipped: 0, pending: 0 });
  expect(q.selects.map((s) => s.limit)).toEqual([200, 200, 200]);
});

test('корпус, где правят КАЖДУЮ строку, не закручивает цикл', async () => {
  // Худший случай для пропусков: ни одна строка не покидает выборку `body_doc IS NULL`.
  // Держит прогон конечным только курсор — он двигается и на пропущенной строке. Без него
  // тот же SELECT возвращал бы те же 200 строк бесконечно.
  const q = fakeQueue(450, { writesFail: true });
  expect(await backfillBodyDoc(q.io)).toEqual({ done: 0, skipped: 450, pending: 450 });
  expect(q.left()).toBe(450); // ничего не записано — и ничего не потеряно
  expect(q.selects.map((s) => s.limit)).toEqual([200, 200, 200]); // ровно один осмотр на строку
});

test('NULL в body не роняет бэкфилл: считается пустым телом', async () => {
  // `body` в НАШЕЙ схеме NOT NULL, но команда ходит и в ПРОД, чья схема — та, что развёрнута.
  // Проверяем ту же страховку, что стоит в audit-bodies (`?? ''`).
  const rows: Array<{ id: string; body: string | null }> = [{ id: 'x', body: null }];
  const written: Array<{ id: string; body: string; expectedBody: string | null }> = [];
  const fake: BackfillIo = {
    selectBatch: async () => rows.splice(0, rows.length),
    writeRow: async (row) => {
      written.push({ id: row.id, body: row.body, expectedBody: row.expectedBody });
      return true;
    },
    countPending: async () => 0,
  };
  expect(await backfillBodyDoc(fake)).toEqual({ done: 1, skipped: 0, pending: 0 });
  // В CAS уходит ИСХОДНОЕ значение (NULL), а не приведённая к строке пустышка: иначе сверка
  // в SQL сравнивала бы NULL с '' и строка не совпала бы никогда.
  expect(written).toEqual([{ id: 'x', body: '', expectedBody: null }]);
});

test('CAS в SQL умеет сравнивать NULL-тело (IS NOT DISTINCT FROM, а не =)', async () => {
  await truncateAll();
  // Прод-схема — та, что развёрнута, и NULL в body там возможен. С обычным `body = $1` такая
  // строка не совпала бы НИКОГДА (`NULL = NULL` → NULL) и молча копилась бы в пропущенных.
  const id = newId();
  await admin.execute(
    sql`INSERT INTO entities (id, owner_id, title, body) VALUES (${id}, ${freshUserId()}, 'нулевое', '')`,
  );

  // Снятие NOT NULL живёт ВНУТРИ транзакции с гарантированным откатом. DDL в Postgres
  // транзакционен, поэтому схема общей базы не меняется ни на мгновение дольше этого теста —
  // даже если процесс умрёт посреди прогона (а это в этой работе уже случалось: исполнитель
  // оборвался на лимите сессии). Прежний вариант с `finally` восстанавливал колонку только
  // при штатном исходе, а жёсткое падение между двумя ALTER'ами оставило бы общую базу
  // с nullable-колонкой молча и навсегда — детектора такого дрейфа нет.
  //
  // Покрытие при этом НЕ страдает: `drizzleBackfillIo` нужен только `.execute`, поэтому
  // транзакционный объект ему подходит, и настоящий UPDATE по NULL-строке исполняется.
  const ROLLBACK = new Error('намеренный откат: тест схему не оставляет');
  let inside: unknown = null;
  let insideRow: { body: string | null; body_doc: unknown } | null = null;
  await expect(
    admin.transaction(async (tx) => {
      await tx.execute(sql`ALTER TABLE entities ALTER COLUMN body DROP NOT NULL`);
      await tx.execute(sql`UPDATE entities SET body = NULL WHERE id = ${id}`);
      inside = await backfillBodyDoc(drizzleBackfillIo(tx));
      const rows = await tx.execute(sql`SELECT body, body_doc FROM entities WHERE id = ${id}`);
      insideRow = rows[0] as { body: string | null; body_doc: unknown };
      throw ROLLBACK;
    }),
  ).rejects.toThrow('намеренный откат');

  // NULL-строка сконвертирована, а не пропущена: CAS сошёлся на NULL.
  expect(inside).toEqual({ done: 1, skipped: 0, pending: 0 });
  expect((insideRow as unknown as { body: string }).body).toBe('');
  expect(serializeBody((insideRow as unknown as { body_doc: never }).body_doc)).toBe('');

  // А общая база вернулась к исходному состоянию целиком — и схемой, и данными.
  const nullable = await admin.execute(
    sql`SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'entities' AND column_name = 'body'`,
  );
  expect((nullable[0] as { is_nullable: string }).is_nullable).toBe('NO');
  const after = await readRow(id);
  expect(after.body).toBe('');
  expect(after.bodyDoc).toBeNull();
});

test('код возврата отличает успех от «корпус не виден» (итоговое ревью, находка 6)', async () => {
  // База не нужна: решение — чистая функция от факта роли и счётчиков. Прежде команда всегда
  // возвращала 0, и запуск из скрипта не мог отличить «сделано» от «роль видит ноль строк».
  const admin = { role: 'postgres', bypassRls: true };
  const blind = { role: 'authenticated', bypassRls: false };
  const nothing = { done: 0, skipped: 0, pending: 0 };
  // Ровно тот случай, ради которого код и заводится: нули под ролью без BYPASSRLS.
  expect(backfillExitCode(blind, nothing)).toBe(1);
  // Положительные контроли: под годной ролью нули — законный исход (корпус уже сконвертирован),
  // и провалом их считать нельзя, иначе повторный прогон «падал» бы всегда.
  expect(backfillExitCode(admin, nothing)).toBe(0);
  expect(backfillExitCode(admin, { done: 5, skipped: 1, pending: 2 })).toBe(0);
  // Дверь наружу: если роль без BYPASSRLS всё-таки что-то переписала, строки ей видны и работа
  // сделана — врать отказом сюда так же плохо, как врать успехом в другую сторону.
  expect(backfillExitCode(blind, { done: 3, skipped: 0, pending: 0 })).toBe(0);
});

test('роль без BYPASSRLS: нули НЕ означают «сконвертировано», и это видно по факту роли', async () => {
  await truncateAll();
  await insertBody('# тело');
  // Сценарий M-2 целиком, на живой базе. `authenticated` — роль С ГРАНТАМИ на entities, но
  // БЕЗ rolbypassrls. Под FORCE RLS и политикой owner_id = auth.uid() (а auth.uid() у прямого
  // подключения пуст) она не видит НИ ОДНОЙ строки — молча, без ошибки.
  await admin.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE authenticated`);
    // Вот он, тихий ложный успех: счётчики прогона неотличимы от «корпус уже сконвертирован».
    expect(await backfillBodyDoc(drizzleBackfillIo(tx))).toEqual({
      done: 0,
      skipped: 0,
      pending: 0,
    });
    // Единственное, что отличает этот случай от настоящего успеха.
    expect(await describeRoleAccess(tx)).toEqual({ role: 'authenticated', bypassRls: false });
  });
  // Корпус на самом деле цел и НЕ сконвертирован — то есть нули выше были ложью.
  const real = await admin.execute(
    sql`SELECT count(*)::int AS n FROM entities WHERE body_doc IS NULL`,
  );
  expect((real[0] as { n: number }).n).toBe(1);
  // Под админской ролью тот же корпус виден и конвертируется.
  expect(await describeRoleAccess(admin)).toEqual({ role: 'postgres', bypassRls: true });
  expect(await backfillBodyDoc(io)).toEqual({ done: 1, skipped: 0, pending: 0 });
});
