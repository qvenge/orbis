// Read-only замер корпуса тел ПЕРЕД необратимой конверсией. Базы тесту не нужно: и порционность,
// и все шесть счётчиков — свойства цикла, а не SQL (тот же приём, что у fakeQueue бэкфилла).
import { expect, test } from 'bun:test';
import { AUDIT_BATCH, type AuditIo, type AuditRow, auditBodies } from './audit-bodies';

const UUID = '019e4466-aaaa-7e07-b5d4-64be9721da51';

/** Очередь тел с курсором по id — как ведёт себя `WHERE id > … ORDER BY id LIMIT n` в БД. */
function fakeCorpus(bodies: Array<string | null>): {
  io: AuditIo;
  selects: Array<{ limit: number; afterId: string }>;
} {
  // Ведущие нули: сравнение строковое, без выравнивания 'id-10' шло бы раньше 'id-2'.
  const rows: AuditRow[] = bodies.map((body, i) => ({
    id: `id-${String(i).padStart(5, '0')}`,
    body,
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
  });
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
            { id: 'a', body: 'взорвётся' },
            { id: 'b', body: 'обычное' },
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
