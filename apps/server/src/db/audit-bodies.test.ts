// Read-only замер корпуса тел ПЕРЕД необратимой конверсией. Базы тесту не нужно: и порционность,
// и все девять счётчиков — свойства цикла, а не SQL (тот же приём, что у fakeQueue бэкфилла).
import { expect, test } from 'bun:test';
import { parseBody } from '@orbis/shared/doc';
import {
  AUDIT_BATCH,
  type AuditIo,
  type AuditRow,
  auditBodies,
  auditExitCode,
  FLAGGED_LIMIT,
} from './audit-bodies';

const UUID = '019e4466-aaaa-7e07-b5d4-64be9721da51';

/** Очередь тел с курсором по id — как ведёт себя `WHERE id > … ORDER BY id LIMIT n` в БД. */
function fakeCorpus(
  bodies: Array<string | null>,
  docs?: Array<unknown>,
): {
  io: AuditIo;
  selects: Array<{ limit: number; afterId: string }>;
} {
  // Ведущие нули: сравнение строковое, без выравнивания 'id-10' шло бы раньше 'id-2'.
  const rows: AuditRow[] = bodies.map((body, i) => ({
    id: `id-${String(i).padStart(5, '0')}`,
    body,
    bodyDoc: docs?.[i] ?? null,
  }));
  const selects: Array<{ limit: number; afterId: string }> = [];
  return {
    selects,
    io: {
      selectBatch: async (limit, afterId) => {
        selects.push({ limit, afterId });
        return rows.filter((r) => r.id > afterId).slice(0, limit);
      },
    },
  };
}

test('корпус читается ПОРЦИЯМИ, а не одним запросом (итоговое ревью, находка 7)', async () => {
  // Замер идёт перед операцией, которую нечем откатить, — тянуть весь корпус в память одним
  // SELECT'ом здесь лишний риск, тем более что сам бэкфилл порционный по осознанной причине.
  const n = AUDIT_BATCH * 2 + 7;
  const corpus = fakeCorpus(Array.from({ length: n }, () => 'обычное тело'));
  const result = await auditBodies(corpus.io);
  expect(result.total).toBe(n); // ни одна строка не потеряна дроблением
  expect(corpus.selects.map((s) => s.limit)).toEqual([AUDIT_BATCH, AUDIT_BATCH, AUDIT_BATCH]);
  // Курсор монотонен и стартует с нуля — иначе порция вращалась бы на месте.
  expect(corpus.selects.map((s) => s.afterId)).toEqual([
    '00000000-0000-0000-0000-000000000000',
    `id-${String(AUDIT_BATCH - 1).padStart(5, '0')}`,
    `id-${String(AUDIT_BATCH * 2 - 1).padStart(5, '0')}`,
  ]);
});

test('ровно кратный размер требует последней пустой выборки', async () => {
  // Граница, на которой не срабатывает выход «неполная порция»: без второго выхода
  // (`rows.length === 0`) цикл здесь вращался бы вечно.
  const corpus = fakeCorpus(Array.from({ length: AUDIT_BATCH * 2 }, () => 'тело'));
  expect((await auditBodies(corpus.io)).total).toBe(AUDIT_BATCH * 2);
  expect(corpus.selects).toHaveLength(3);
});

test('счётчики считают то, что обещают, и порции их не сбивают', async () => {
  const corpus = fakeCorpus([
    'уже канон', // ничего
    '* раз', // канон изменит body
    '<div>html</div>', // raw
    `<div>[[entity:${UUID}]]</div>`, // raw со ссылкой + нетривиальное
    `см. [[entity:${UUID}]]`, // нетривиальное, но не raw
    '{{query: aspect=orbis/task}}', // нетривиальное, не raw
    null, // NULL — пустое тело, не падение
  ]);
  expect(await auditBodies(corpus.io)).toEqual({
    total: 7,
    changed: 1,
    unstable: 0,
    lossy: 0,
    withRaw: 2,
    refsInRaw: 1,
    nontrivial: 3,
    failed: 0,
    lostWords: 0,
    withoutDoc: 7, // корпус ДО конверсии: документа нет ни у кого
    pairBroken: 0,
    flagged: [],
  });
});

test('пост-проверка: пара сверяется, а не додумывается (ре-ревью раунда 3, п.5)', async () => {
  // Повторный прогон стоп-кранов после бэкфилла вакуумен по построению, поэтому настоящая
  // пост-проверка — несущий инвариант хранения. До этого раунда аудит `body_doc` не читал вовсе.
  const good = 'текст';
  const corpus = fakeCorpus(
    [good, good, good, good],
    [
      parseBody(good), // пара сходится
      parseBody('совсем другое'), // проекция не равна body → пара разошлась
      null, // документа нет
      { v: 1, doc: { type: 'doc', content: [{ type: 'НЕТ_ТАКОЙ' }] } }, // не сериализуется
    ],
  );
  const r = await auditBodies(corpus.io);
  expect(r.total).toBe(4);
  expect(r.withoutDoc).toBe(1);
  // Две беды разной природы: разошедшаяся проекция и документ, который вообще не печатается.
  expect(r.pairBroken).toBe(2);
});

test('стоп-кран ловит СЛОВО, пропавшее на ПЕРВОМ разборе (ре-ревью раунда 4)', async () => {
  // Единственный кран, который смотрит на первый разбор — тот шаг, который бэкфилл делает
  // необратимо. Три известных входа этого класса шли мимо всех прочих счётчиков; здесь они
  // проверяются НАСТОЯЩИМ каноном, без подделок. (Сами входы уже починены в @orbis/shared —
  // поэтому кран заодно служит регресс-стражем: снимут починку, число станет ненулевым.)
  const corpus = fakeCorpus([
    '| a |\n| --- |\n| один | ПОТЕРЯННЫЙ |',
    '> | a |\n> | --- |\n> | ![схема](i.png) |',
    '[](http://пример.рф/адрес)',
    'здоровое тело со ссылкой [док](https://example.com)',
    '&lt;тег&gt; и &amp; амперсанд',
  ]);
  const r = await auditBodies(corpus.io);
  expect(r.total).toBe(5);
  // Все три входа теперь уходят в raw дословно — слово доживает, кран молчит.
  expect(r.lostWords).toBe(0);
});

test('счётчик слов НЕ шумит на здоровой нормализации (страж от ложной тревоги)', async () => {
  // Кран, который шумит, перестают читать. Проверяем на телах, где канон законно переписывает
  // разметку, и отдельно на семействе HTML-сущностей: `&lt;` раскрывается в сам знак, и слово
  // «lt» честно исчезает, ничего не теряя, — потому имена сущностей из сверки и вырезаны.
  const corpus = fakeCorpus([
    '* раз\n* два',
    'это __жирный__ текст',
    '| a | b |\n|---|---|\n| 1 | 2 |',
    'текст\n\n\n',
    '&lt;тег&gt;',
    '&amp; амперсанд',
    '&copy; знак',
    '&#169; числовая',
  ]);
  const r = await auditBodies(corpus.io);
  expect(r.changed).toBeGreaterThan(0); // страж вакуумности: нормализация реально случилась
  expect(r.lostWords).toBe(0);
});

test('счётчик слов краснеет, когда слово действительно пропало', async () => {
  // Положительный контроль на подставном каноне: без него «ноль» выше был бы неотличим от
  // счётчика, который не считает ничего.
  const corpus = fakeCorpus(['важное слово тут']);
  const r = await auditBodies(corpus.io, (body) => ({
    doc: { v: 1, doc: { type: 'doc', content: [{ type: 'paragraph' }] } },
    body: body.replace('слово', ''),
  }));
  expect(r.lostWords).toBe(1);
});

test('кран неустойчивости НЕ краснеет на пустых абзацах редактора (ре-ревью раунда 5)', async () => {
  // markdown не умеет выражать пустой абзац, поэтому сериализатор печатает `&nbsp;` за каждый
  // ВТОРОЙ подряд пустой — то есть за три нажатия Enter. Без вычета кран стал бы постоянно
  // ненулевым сразу после выхода редактора пользователям, а всегда красный кран читать
  // перестают. Тела здесь — настоящие проекции таких документов.
  const corpus = fakeCorpus([
    'раз\n\n\n\n&nbsp;\n\nдва',
    'раз\n\n\n\n&nbsp;\n\n&nbsp;\n\nдва',
    'раз\n\n\n\n&nbsp;',
    '\n\n&nbsp;\n\nраз',
    'раз\n\n \n\nдва',
  ]);
  const r = await auditBodies(corpus.io);
  expect(r.total).toBe(5);
  expect(r.unstable).toBe(0);
  expect(r.flagged).toEqual([]);
});

test('вычет НЕ глушит настоящую неустойчивость (страж от переглушения)', async () => {
  // Кодовая вставка из одних пробелов уничтожается, и кран обязан это видеть — иначе вычет
  // превратил бы стоп-кран в украшение.
  const corpus = fakeCorpus(['` `', '`  `', 'до ` ` после', '`\t`']);
  const r = await auditBodies(corpus.io);
  expect(r.unstable).toBe(4);
  expect(r.flagged).toHaveLength(4);
});

test('аудит называет id строк, поднявших кран (ре-ревью раунда 5)', async () => {
  // Регламентный шаг «стоп и разбор конкретного тела» без этого НЕИСПОЛНИМ: по счётчику «1»
  // человек не найдёт строку в корпусе на тысячи записей.
  const corpus = fakeCorpus(['здоровое тело', 'дрожит', 'тоже здоровое']);
  const r = await auditBodies(corpus.io, (body) => ({
    doc: { v: 1, doc: { type: 'doc', content: [{ type: 'paragraph' }] } },
    body: body.startsWith('дрожит') ? `${body}!` : body,
  }));
  expect(r.unstable).toBe(1);
  expect(r.flagged).toEqual(['id-00001']); // ровно виновная строка, а не весь корпус
});

test('список id ограничен сверху — больной корпус не вываливает всё', async () => {
  const corpus = fakeCorpus(Array.from({ length: FLAGGED_LIMIT + 20 }, () => 'дрожит'));
  const r = await auditBodies(corpus.io, (body) => ({
    doc: { v: 1, doc: { type: 'doc', content: [{ type: 'paragraph' }] } },
    body: `${body}!`,
  }));
  expect(r.unstable).toBe(FLAGGED_LIMIT + 20); // считаны ВСЕ
  expect(r.flagged).toHaveLength(FLAGGED_LIMIT); // а напечатан вход в корпус
});

test('код возврата аудита: невидимый корпус и стоп-краны (ре-ревью раунда 3, п.1)', () => {
  // Повтор находки M-2, но опаснее: у бэкфилла нули означали ложный успех, здесь ЧИСЛО И ЕСТЬ
  // РЕШЕНИЕ — человек получал зелёный свет на необратимую конверсию оттого, что аудит ничего
  // не увидел. База не нужна: решение — чистая функция от факта роли и счётчиков.
  const admin = { role: 'postgres', bypassRls: true };
  const blind = { role: 'authenticated', bypassRls: false };
  const clean = {
    total: 100,
    changed: 11,
    unstable: 0,
    lossy: 0,
    withRaw: 3,
    refsInRaw: 0,
    nontrivial: 20,
    failed: 0,
    lostWords: 0,
    withoutDoc: 100,
    pairBroken: 0,
    flagged: [],
  };
  // Ровно тот случай, ради которого код заведён: все счётчики нулевые, потому что НИЧЕГО НЕ ВИДНО.
  expect(
    auditExitCode(blind, {
      ...clean,
      total: 0,
      changed: 0,
      withRaw: 0,
      nontrivial: 0,
      withoutDoc: 0,
    }),
  ).toBe(1);
  // Положительный контроль: здоровый корпус под годной ролью — ноль, даже когда changed велик.
  expect(auditExitCode(admin, clean)).toBe(0);
  // Каждый стоп-кран в отдельности поднимает код — иначе один из них был бы декоративным.
  expect(auditExitCode(admin, { ...clean, unstable: 1 })).toBe(1);
  expect(auditExitCode(admin, { ...clean, lossy: 1 })).toBe(1);
  expect(auditExitCode(admin, { ...clean, lostWords: 1 })).toBe(1);
  expect(auditExitCode(admin, { ...clean, failed: 1 })).toBe(1);
  expect(auditExitCode(admin, { ...clean, pairBroken: 1 })).toBe(1);
  // А `withoutDoc` в гейт НЕ входит: до конверсии он законно равен всему корпусу.
  expect(auditExitCode(admin, { ...clean, withoutDoc: 100 })).toBe(0);
});

test('стоп-краны считают беду, а «канон изменит body» — нет (ре-ревью, Б3)', async () => {
  // Гейт по `changed` бесполезен: канон законно нормализует разметку, и на живом корпусе это
  // число велико. Стоп-краны обязаны молчать на нормализации и кричать на порче.
  const corpus = fakeCorpus([
    '* раз', // нормализация: changed, но НЕ беда
    'это __жирный__ текст', // нормализация
    '| a | b |\n|---|---|\n| 1 | 2 |', // выравнивание таблицы — нормализация
    'текст\n\n\n', // обрезка хвоста — нормализация
  ]);
  const r = await auditBodies(corpus.io);
  expect(r.changed).toBeGreaterThan(0); // страж вакуумности: нормализация реально случилась
  expect(r.unstable).toBe(0);
  expect(r.lossy).toBe(0);
});

test('стоп-кран ловит тело, на котором канон НЕУСТОЙЧИВ', async () => {
  // Подделываем канон, «дрожащий» на конкретном теле: настоящих таких входов после починок
  // не осталось, а счётчик без доказательства — утверждение без проверки.
  const corpus = fakeCorpus(['дрожит', 'спокойное']);
  const r = await auditBodies(corpus.io, (body) => ({
    doc: { v: 1, doc: { type: 'doc', content: [{ type: 'paragraph' }] } },
    // Приписка НА КАЖДОМ проходе, а не только на первом: иначе второй проход вернул бы то же
    // самое, и «неустойчивость» была бы зелена по ложной причине (поймано прогоном).
    body: body.startsWith('дрожит') ? `${body}!` : body,
  }));
  // canon('дрожит') = 'дрожит!', canon('дрожит!') = 'дрожит!!' — второй проход даёт не первое.
  expect(r.unstable).toBe(1);
  expect(r.total).toBe(2);
});

test('стоп-кран ловит тело, у которого канон ТЕРЯЕТ написанное', async () => {
  // Проверяется на настоящем каноне и настоящем механизме: raw-блок с текстом, который канон
  // при обратном разборе не восстанавливает. Без подделок.
  const corpus = fakeCorpus(['`` ` ``', 'обычное тело']);
  const r = await auditBodies(corpus.io, (body) => {
    // Канон ДО починки Б2: разделитель кодовой вставки всегда одна кавычка.
    if (body === '`` ` ``')
      return {
        doc: {
          v: 1,
          doc: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: '`', marks: [{ type: 'code' }] }],
              },
            ],
          },
        },
        body: '```',
      };
    return {
      doc: {
        v: 1,
        doc: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }],
        },
      },
      body,
    };
  });
  expect(r.lossy).toBe(1); // кавычка исчезла из проекции
  expect(r.total).toBe(2);
});

test('одно упавшее тело не рушит замер, а попадает в счётчик', async () => {
  // Аудит и заведён затем, чтобы неразобранные тела ПОСЧИТАТЬ, а не остановиться на середине
  // корпуса перед необратимой операцией.
  let calls = 0;
  const io: AuditIo = {
    selectBatch: async () => {
      calls += 1;
      return calls === 1
        ? [
            { id: 'a', body: 'взорвётся', bodyDoc: null },
            { id: 'b', body: 'обычное', bodyDoc: null },
          ]
        : [];
    },
  };
  const result = await auditBodies(io, (body) => {
    if (body === 'взорвётся') throw new Error('парсер не справился');
    return { doc: { v: 1, doc: { type: 'doc', content: [{ type: 'paragraph' }] } }, body };
  });
  expect(result.failed).toBe(1);
  expect(result.total).toBe(2); // упавшая строка всё равно посчитана в корпусе
});
