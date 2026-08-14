// bun:test, как ВЕСЬ пакет shared: у него "test": "bun test", и файл на vitest уронил бы
// корневой прогон (ревью Б6.1). Сиды здесь НЕ импортируются — shared не зависит от server
// (И17); round-trip сидов проверяет apps/server/src/seed/seed-canon.test.ts.
import { describe, expect, test } from 'bun:test';
import {
  bodyRefsFromDoc,
  canonicalizeBody,
  parseBody,
  readBodyDoc,
  serializeBody,
} from './convert';

const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const raws = (md: string) => (parseBody(md).doc.content ?? []).filter((n) => n.type === 'rawBlock');
const shape = (md: string) => JSON.stringify(parseBody(md).doc);

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
      'текст <div>x</div>',
      '2 * 3 = 6',
      '- [ ] не сделано\n- [x] сделано',
    ]) {
      expect(shape(canonicalizeBody(md).body)).toBe(shape(md));
    }
  });

  test('канон `_курсив_`, набранного буквально, сохраняет экранирование', () => {
    // Снятие экранирования ТОЧЕЧНОЕ: intraword `_` безопасен (CommonMark), а `_слово_`
    // целиком — нет: без экранирования повторный парс сделал бы из текста курсив.
    const canon = canonicalizeBody('это \\_курсив\\_ такой').body;
    expect(canon).toBe('это \\_курсив\\_ такой');
    expect(shape(canon)).not.toContain('italic');
  });

  test('строка, начинающаяся с `>`, цитатой при повторном разборе не становится (Р-v2-3)', () => {
    // Штатный сериализатор прятал `>` за `&gt;`; сняв кодирование, обязаны защитить иначе —
    // иначе абзац «> не цитата» после первой же перезаписи станет blockquote.
    for (const md of ['\\> не цитата', '&gt; не цитата', '> цитата', '\\# не заголовок']) {
      expect(shape(canonicalizeBody(md).body)).toBe(shape(md));
    }
    expect(shape(canonicalizeBody('\\> не цитата').body)).not.toContain('blockquote');
    expect(shape(canonicalizeBody('\\# не заголовок').body)).not.toContain('heading');
  });
});

describe('поблочный raw по токенам (решение по Б1, мера 3)', () => {
  test('HTML-блок уезжает в raw ОДИН, соседний смарт-лист остаётся виджетом', () => {
    const md = '<div>x</div>\n\n{{query: aspect=orbis/task, status=inbox}}';
    const doc = parseBody(md);
    const types = (doc.doc.content ?? []).map((n) => n.type);
    expect(types).toContain('rawBlock');
    expect(types).toContain('queryBlock');
    expect(serializeBody(doc)).toBe(md); // raw отдаёт дословно, канон остального совпал
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
    expect(json).toContain('entityRef');
    expect(json).toContain(UUID); // lowercase в атрибуте
    expect(serializeBody(doc)).toBe(`См. [[entity:${UUID}|Кроссовки]].`);
    expect(serializeBody(parseBody(`Связано с [[entity:${UUID}]].`))).toBe(
      `Связано с [[entity:${UUID}]].`,
    );
  });

  test('многострочный query дословен; }} внутри запроса блоком не считается', () => {
    const multi = '{{query: aspect=orbis/task,\n         status=inbox}}';
    expect(serializeBody(parseBody(multi))).toBe(multi);
    expect(raws(multi)).toEqual([]);
    // Хвост после `}}` — обычный текст, блок закрылся на первом `}}`; в raw ничто не уезжает.
    const tail = parseBody('{{query: tags=a}}b}}');
    expect((tail.doc.content ?? []).map((n) => n.type)).toEqual(['queryBlock', 'paragraph']);
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
