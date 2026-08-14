// bun:test, как ВЕСЬ пакет shared: у него "test": "bun test", и файл на vitest уронил бы
// корневой прогон (ревью Б6.1). Сиды здесь НЕ импортируются — shared не зависит от server
// (И17); round-trip сидов проверяет apps/server/src/seed/seed-canon.test.ts.
import { describe, expect, test } from 'bun:test';
import { getSchema } from '@tiptap/core';
import {
  bodyRefsFromDoc,
  canonicalizeBody,
  parseBody,
  readBodyDoc,
  serializeBody,
} from './convert';
import { DOC_EXTENSIONS } from './schema';

const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const raws = (md: string) => (parseBody(md).doc.content ?? []).filter((n) => n.type === 'rawBlock');
const shape = (md: string) => JSON.stringify(parseBody(md).doc);
const types = (md: string) => (parseBody(md).doc.content ?? []).map((n) => n.type);

describe('канонизация вместо строгой сверки (решение по Б1)', () => {
  test('бытовой текст с _ и & НЕ уезжает в raw и не обрастает экранированием', () => {
    // Ровно тела из проб ревью: при строгой сверке все три уходили в raw целиком.
    for (const md of [
      'поле due_date и updated_at в тексте',
      'условие a&b и c & d',
      'скрипт backfill_body_doc.ts готов',
    ]) {
      expect(raws(md)).toEqual([]);
      expect(canonicalizeBody(md).body).toBe(md); // канон этих строк — они сами
    }
  });

  test('ненормализованная разметка канонизируется, а не отвергается', () => {
    // Модель пишет как умеет; body — производная от документа, эталон — канон (вердикт Б1).
    const cases: Array<[string, string]> = [
      ['* раз\n* два', '- раз\n- два'],
      ['1) первый', '1. первый'],
      ['это __жирный__ текст', 'это **жирный** текст'],
    ];
    for (const [input, canon] of cases) {
      expect(raws(input)).toEqual([]);
      expect(canonicalizeBody(input).body).toBe(canon);
    }
  });

  test('канонизация идемпотентна', () => {
    for (const md of ['поле due_date', '* раз', '1) первый', '2 * 3 = 6', 'а < б > в']) {
      // Без этой строки проверка тождественна для raw: он отдаёт вход дословно (ревью, п. 3).
      expect(raws(md)).toEqual([]);
      const once = canonicalizeBody(md).body;
      expect(canonicalizeBody(once).body).toBe(once);
    }
  });

  test('канон не меняет смысла: повторный разбор даёт ту же структуру', () => {
    // Настоящий инвариант канона (замена тавтологичной проверки из брифа — решение Р-v2-5).
    // Канон вправе переписать буквы, но НЕ вправе переписать документ.
    for (const md of [
      'это _курсив_ такой',
      'это \\_курсив\\_ такой',
      'поле due_date и c & d',
      'а < б > в',
      '2 * 3 = 6',
      '- [ ] не сделано\n- [x] сделано',
    ]) {
      // Страж вакуумности: для тела, уехавшего в raw, инвариант выполняется тождественно, и
      // такой вход не утверждает НИЧЕГО (найдено ревью, п. 2 — на нём и попался `<div>`).
      expect(raws(md)).toEqual([]);
      expect(shape(canonicalizeBody(md).body)).toBe(shape(md));
    }
  });

  test('инлайн-HTML — честный raw с явным ожиданием, а не «зелёный инвариант»', () => {
    const md = 'текст <div>x</div>';
    expect(raws(md).length).toBe(1);
    expect(canonicalizeBody(md).body).toBe(md);
  });

  test('канон `_курсив_`, набранного буквально, сохраняет экранирование', () => {
    // Снятие экранирования ТОЧЕЧНОЕ: intraword `_` безопасен (CommonMark), а `_слово_`
    // целиком — нет: без экранирования повторный парс сделал бы из текста курсив.
    const md = 'это \\_курсив\\_ такой';
    expect(raws(md)).toEqual([]); // иначе «нет курсива» выполняется просто потому, что это raw
    const canon = canonicalizeBody(md).body;
    expect(canon).toBe(md);
    expect(shape(canon)).not.toContain('italic');
  });

  test('строка, начинающаяся с `>`, цитатой при повторном разборе не становится (Р-v2-3)', () => {
    // Штатный сериализатор прятал `>` за `&gt;`; сняв кодирование, обязаны защитить иначе —
    // иначе абзац «> не цитата» после первой же перезаписи станет blockquote.
    for (const md of ['\\> не цитата', '&gt; не цитата', '> цитата', '\\# не заголовок']) {
      // Все три ассерта ниже проходят и для raw — без этой строки страж решения контроллера
      // не отличил бы починку от регресса в raw (ревью, п. 3).
      expect(raws(md)).toEqual([]);
      expect(shape(canonicalizeBody(md).body)).toBe(shape(md));
    }
    expect(shape(canonicalizeBody('\\> не цитата').body)).not.toContain('blockquote');
    expect(shape(canonicalizeBody('\\# не заголовок').body)).not.toContain('heading');
  });

  test('пустое тело — валидный по схеме документ, канон остаётся пустой строкой', () => {
    // Топ-узел объявлен `block+`, а пустой `content: []` схему нарушает: документ КАЖДОЙ
    // только что созданной сущности поехал бы в редактор и уронил его (ревью, п. 5).
    const schema = getSchema(DOC_EXTENSIONS as never);
    expect(() => schema.nodeFromJSON(parseBody('').doc).check()).not.toThrow();
    // Инвариант пары не сломан: пустому документу обязана соответствовать пустая строка.
    expect(canonicalizeBody('').body).toBe('');
    expect(canonicalizeBody('   \n\n  ').body).toBe('');
  });
});

describe('поблочный raw по токенам (решение по Б1, мера 3)', () => {
  test('HTML-блок уезжает в raw ОДИН, соседний смарт-лист остаётся виджетом', () => {
    const md = '<div>x</div>\n\n{{query: aspect=orbis/task, status=inbox}}';
    expect(types(md)).toEqual(['rawBlock', 'queryBlock']);
    expect(serializeBody(parseBody(md))).toBe(md); // raw отдаёт дословно, канон остального совпал
  });

  test('экранированная черта в ячейке уводит таблицу в raw (инвариант канона)', () => {
    // Тот же механизм, что у картинки в ячейке, но с другой стороны: токен `escape` числится
    // знакомым, а сериализатор таблицы черту обратно не экранирует — при повторном разборе
    // ячейка `x \| y` разваливалась надвое (найдено ревью, п. 4).
    const md = 'абзац\n\n| a |\n| --- |\n| x \\| y |';
    expect(raws(md).length).toBe(1);
    expect(shape(canonicalizeBody(md).body)).toBe(shape(md));
    expect(serializeBody(parseBody(md))).toContain('x \\| y');
  });

  test('картинка (нет в схеме) уводит СВОЙ блок в raw, а не всё тело', () => {
    const md = 'абзац\n\n![схема](https://example.com/a.png)\n\nещё абзац';
    const doc = parseBody(md);
    expect(raws(md).length).toBe(1);
    expect(serializeBody(doc)).toContain('![схема]');
    expect(serializeBody(doc)).toContain('ещё абзац');
  });

  test('reference-определения — консервативно всё тело в raw', () => {
    // marked складывает link reference definitions в lexer.tokens.links — восстановить их
    // позицию и форму нечем, поэтому единственный честный вариант — весь текст дословно.
    // Сноска GFM из спайка (`текст[^1](сноска)` — определение исчезало) ловится именно здесь.
    const md = 'текст[^1]\n\n[^1]: сноска';
    const doc = parseBody(md);
    expect(doc.doc.content?.length).toBe(1);
    expect(doc.doc.content?.[0]?.type).toBe('rawBlock');
    expect(serializeBody(doc)).toBe(md);
  });

  test('картинка в ячейке таблицы уводит таблицу в raw, а не пропадает молча', () => {
    // Найдено саморевью: ячейки GFM лежат в header/rows, а не в tokens/items, и без их обхода
    // таблица считалась «понятой», сериализатор выбрасывал картинку, и тело менялось молча —
    // ровно та тихая потеря, против которой построен весь модуль.
    const md = '| a |\n| --- |\n| ![x](y.png) |';
    expect(raws(md).length).toBe(1);
    expect(serializeBody(parseBody(md))).toBe(md);
    // Таблица без незнакомых конструкций виджетом остаётся.
    expect(raws('| a | b |\n| --- | --- |\n| 1 | 2 |')).toEqual([]);
  });

  test('список — не raw: его элементы лежат в items как list_item', () => {
    // Набор KNOWN_BLOCK из брифа не содержал list_item, и КАЖДЫЙ список (включая чеклисты)
    // уезжал в raw целиком — проверено репликой алгоритма на наборах брифа.
    for (const md of ['- раз\n- два', '1. первый', '- [ ] дело']) {
      expect(raws(md)).toEqual([]);
    }
  });

  test('обычный текст в raw НЕ уезжает — включая проблемные символы', () => {
    expect(raws('# Заголовок\n\n- раз\n- два')).toEqual([]);
    expect(raws('поле due_date, условие a&b, 2 * 3')).toEqual([]);
  });
});

describe('свои конструкции', () => {
  test('ссылка с подписью и без; регистр id приводится к lower (И7)', () => {
    const doc = parseBody(`См. [[entity:${UUID.toUpperCase()}|Кроссовки]].`);
    const json = JSON.stringify(doc.doc);
    expect(raws(`См. [[entity:${UUID}|Кроссовки]].`)).toEqual([]);
    expect(json).toContain('entityRef');
    expect(json).toContain(UUID); // lowercase в атрибуте
    expect(serializeBody(doc)).toBe(`См. [[entity:${UUID}|Кроссовки]].`);
    expect(serializeBody(parseBody(`Связано с [[entity:${UUID}]].`))).toBe(
      `Связано с [[entity:${UUID}]].`,
    );
  });

  test('смарт-лист внутри забора кода остаётся ТЕКСТОМ кода', () => {
    // Вырезание сегментов регэкспом до лексера рвало показанный в коде пример синтаксиса на
    // два пустых забора и живой виджет; приёмочный инвариант этого не ловил — порча случалась
    // на parseBody, поэтому shape(канон) === shape(вход) (найдено ревью, п. 1).
    const md = '```\n{{query: aspect=orbis/task}}\n```';
    expect(types(md)).toEqual(['codeBlock']);
    expect(canonicalizeBody(md).body).toBe(md);
  });

  test('`{{query:}}` в инлайн-коде не режет абзац', () => {
    const md = 'смотри `{{query: a=b}}` тут';
    expect(types(md)).toEqual(['paragraph']);
    expect(canonicalizeBody(md).body).toBe(md);
  });

  test('настоящий смарт-лист рядом с забором кода остаётся виджетом', () => {
    const md = '```ts\nconst x = 1;\n```\n\n{{query: aspect=orbis/task}}';
    expect(types(md)).toEqual(['codeBlock', 'queryBlock']);
    expect(canonicalizeBody(md).body).toBe(md);
  });

  test('многострочный query дословен; }} внутри запроса блоком не считается', () => {
    const multi = '{{query: aspect=orbis/task,\n         status=inbox}}';
    expect(serializeBody(parseBody(multi))).toBe(multi);
    expect(raws(multi)).toEqual([]);
    // Хвост после `}}` — обычный текст, блок закрылся на первом `}}`; в raw ничто не уезжает.
    const tail = parseBody('{{query: tags=a}}b}}');
    expect((tail.doc.content ?? []).map((n) => n.type)).toEqual(['queryBlock', 'paragraph']);
  });

  test('обёртка не с колонки 1 блоком не считается (ни с отступом, ни после буквы)', () => {
    // Правило «блок начинается с колонки 1» держится и на ОДНОМ символе перед обёрткой:
    // marked ищет место разреза абзаца в src.slice(1), и прежний якорь `^` в start значил
    // «второй символ блока» — `x{{query:a=1}}` разваливалось на абзац «x» и блок, а
    // ` {{query:a=1}}` становилось блоком вопреки отступу (проба Задачи 7).
    for (const md of [
      'x{{query:a=1}}',
      ' {{query:a=1}}',
      '  {{query:a=1}}',
      'до\n {{query:a=1}}',
    ]) {
      // Страж вакуумности: у raw «нет блока» выполнялось бы тождественно.
      expect(raws(md)).toEqual([]);
      expect(shape(md)).not.toContain('queryBlock');
      expect(canonicalizeBody(md).body).toBe(md);
    }
    // …и настоящий блок с колонки 1 при этом цел — в том числе сразу после строки текста.
    expect(types('до\n{{query:a=1}}')).toEqual(['paragraph', 'queryBlock']);
    expect(types('{{query:a=1}}')).toEqual(['queryBlock']);
    expect(types('> цитата\n\n{{query:a=1}}')).toEqual(['blockquote', 'queryBlock']);
  });

  test('незакрытая обёртка остаётся текстом и не режет абзац', () => {
    const md = 'текст {{query: aspect=orbis/task и всё';
    expect(canonicalizeBody(md).body).toBe(md);
    expect(raws(md)).toEqual([]);
  });

  test('чеклист, код, вложенный список, цитата — канон равен входу и не raw', () => {
    // Проверка «не raw» здесь ОБЯЗАТЕЛЬНА: raw отдаёт вход дословно, поэтому одно только
    // равенство канона входу зелено и для мёртвого блока (так чеклист прошёл приёмку брифа).
    for (const md of [
      '- [ ] не сделано\n- [x] сделано',
      '```ts\nconst x = 1;\n```',
      '- раз\n  - вложенный\n- два',
      '> цитата',
    ]) {
      expect(raws(md)).toEqual([]);
      expect(canonicalizeBody(md).body).toBe(md);
    }
  });
});

describe('bodyRefsFromDoc: дерево ∪ raw (Б2)', () => {
  test('lowercase и без дублей', () => {
    expect(
      bodyRefsFromDoc(parseBody(`[[entity:${UUID.toUpperCase()}]] и [[entity:${UUID}]]`)),
    ).toEqual([UUID]);
  });

  test('ссылка в блоке кода и inline-коде — НЕ связь (Р7 сохраняется)', () => {
    expect(bodyRefsFromDoc(parseBody(`\`\`\`\n[[entity:${UUID}]]\n\`\`\``))).toEqual([]);
    expect(bodyRefsFromDoc(parseBody(`\`[[entity:${UUID}]]\``))).toEqual([]);
  });

  test('ссылка внутри raw-блока связью ОСТАЁТСЯ — backlinks не зависят от разбираемости', () => {
    // Регресс из ревью Б2: сегодня регэксп находит такие ссылки, терять их нельзя.
    const md = `<div>html</div>\n\nсм. [[entity:${UUID}]]`; // ссылка в обычном абзаце
    expect(bodyRefsFromDoc(parseBody(md))).toEqual([UUID]);
    const allRaw = `текст[^1] и [[entity:${UUID}]]\n\n[^1]: сноска`; // всё тело в raw
    expect(bodyRefsFromDoc(parseBody(allRaw))).toEqual([UUID]);
  });
});

describe('readBodyDoc (приёмка 11 — теперь с тестом, ревью M)', () => {
  test('знакомая версия — как есть; будущая/битая/NULL — пересборка из body', () => {
    const good = parseBody('текст');
    expect(readBodyDoc(good, 'другое')).toEqual(good);
    for (const bad of [null, 42, { v: 999, doc: { type: 'doc' } }, { doc: {} }]) {
      const rebuilt = readBodyDoc(bad, '# Заголовок');
      expect(JSON.stringify(rebuilt.doc)).toContain('heading');
    }
  });
});
