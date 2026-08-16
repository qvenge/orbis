// bun:test, как ВЕСЬ пакет shared: у него "test": "bun test", и файл на vitest уронил бы
// корневой прогон (ревью Б6.1). Сиды здесь НЕ импортируются — shared не зависит от server
// (И17); round-trip сидов проверяет apps/server/src/seed/seed-canon.test.ts.
import { describe, expect, test } from 'bun:test';
import { getSchema } from '@tiptap/core';
import {
  bodyDocError,
  bodyPairFromDoc,
  bodyRefsFromDoc,
  canonicalizeBody,
  parseBody,
  readBodyDoc,
  serializeBody,
} from './convert';
import { DOC_EXTENSIONS } from './schema';
import { DOC_SCHEMA_VERSION } from './types';

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

describe('ограда блока кода — по длине содержимого (итоговое ревью, находка 1)', () => {
  // Правило CommonMark §4.5: длина ограды = max(3, самая длинная серия обратных кавычек
  // в содержимом + 1). Проверено РАЗБОРОМ, а не по документации: для каждой из десяти проб
  // подобрана минимальная длина, при которой round-trip возвращает то же содержимое, — и она
  // совпала с формулой везде, кроме `x```y` (серия не образует закрывающую ограду, хватает и 3;
  // формула даёт 4 — безопасный избыток, содержимое цело).

  test('вложенные ограды переживают канон и канон идемпотентен', () => {
    // Приём CommonMark «ограда в ограде» — так показывают markdown внутри markdown. Модель
    // пишет так штатно, README попадает в блок кода вставкой из редактора.
    const md = '````\n```\nвнутри\n```\n````';
    expect(types(md)).toEqual(['codeBlock']); // страж: не raw, иначе всё ниже тождественно
    const once = canonicalizeBody(md).body;
    expect(once).toBe(md);
    expect(canonicalizeBody(once).body).toBe(once);
    // Содержимое ЦЕЛО: до починки внутренние ограды закрывали внешнюю, и «внутри» вылезало
    // абзацем между двумя пустыми блоками кода.
    expect(shape(once)).toBe(shape(md));
  });

  test('серия кавычек ЛЮБОЙ длины в содержимом не разваливает блок', () => {
    for (const content of ['a', '`', '``', '```', '````', '`````', '```\nвнутри\n```', '   ````']) {
      const doc = {
        type: 'doc',
        content: [
          {
            type: 'codeBlock',
            attrs: { language: null },
            content: [{ type: 'text', text: content }],
          },
        ],
      };
      const md = serializeBody(doc as never);
      const back = parseBody(md).doc.content ?? [];
      expect(back.length).toBe(1);
      expect(back[0]?.type).toBe('codeBlock');
      expect(back[0]?.content?.[0]?.text ?? '').toBe(content); // байт в байт
      expect(canonicalizeBody(md).body).toBe(md); // и это неподвижная точка
    }
  });

  test('обратная кавычка в info-строке не рушит блок (найдено пробой, не в брифе)', () => {
    // `~~~a`b` — законная ограда CommonMark, но у backtick-ограды info-строка обратных кавычек
    // содержать НЕ ВПРАВЕ. До починки канон печатал ```a`b и блок кода превращался в абзац
    // с инлайн-кодом: `~~~a\`b\nx\n~~~` → канон1 "```a`b\nx\n```" → канон2 "`a`b x` ".
    const md = '~~~a`b\nx\n~~~';
    expect(types(md)).toEqual(['codeBlock']);
    const once = canonicalizeBody(md).body;
    expect(canonicalizeBody(once).body).toBe(once);
    // Текст кода цел; потерян только негодный ярлык языка — он не текст, а подсказка подсветке.
    expect(parseBody(once).doc.content?.[0]?.content?.[0]?.text).toBe('x');
    expect(types(once)).toEqual(['codeBlock']);
    // Положительный контроль: годный язык (в том числе с пробелом) НЕ теряется.
    expect(canonicalizeBody('```js extra\nx\n```').body).toBe('```js extra\nx\n```');
  });
});

describe('подпись ссылки с `]` (итоговое ревью, находка 2)', () => {
  // EditorSuggest вставляет ЗАГОЛОВОК сущности в подпись дословно, а разбор держит подпись
  // в классе «всё кроме `]`». Заголовок со скобкой — не синтетика.
  test('заголовок с `]` не превращает ссылку в текст и канон устойчив', () => {
    for (const title of ['Задача ] хвост', 'Отчёт [черновик]', 'Список [1]']) {
      const doc = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'См. ' },
              { type: 'entityRef', attrs: { entityId: UUID, label: title } },
            ],
          },
        ],
      };
      const md = serializeBody(doc as never);
      expect(raws(md)).toEqual([]); // страж: не raw
      // Ссылка ОСТАЛАСЬ ссылкой — иначе она исчезает из body_refs при первой пересборке.
      expect(bodyRefsFromDoc(parseBody(md))).toEqual([UUID]);
      expect(JSON.stringify(parseBody(md).doc)).toContain('entityRef');
      expect(canonicalizeBody(md).body).toBe(md); // неподвижная точка
    }
  });

  test('безопасная подпись сохраняется — потеря её не общее правило', () => {
    // Положительный контроль к тесту выше: `[`, `|`, `\`, `` ` `` и пробелы в подписи проверены
    // пробой и round-trip проходят, поэтому опускается ТОЛЬКО подпись с `]`.
    for (const label of ['Кроссовки', 'Отчёт [черновик', 'a|b', 'a\\b', 'a`b']) {
      const md = serializeBody({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'entityRef', attrs: { entityId: UUID, label } }] },
        ],
      } as never);
      expect(md).toBe(`[[entity:${UUID}|${label}]]`);
      expect(canonicalizeBody(md).body).toBe(md);
    }
  });
});

describe('setext-подчёркивание (итоговое ревью, находка 4)', () => {
  test('`===` под мягким переносом не делает из абзаца заголовок', () => {
    const doc = {
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
    };
    const md = serializeBody(doc as never);
    // До починки: "foo  \n===" → разбор давал heading, и строка `===` ИСЧЕЗАЛА вместе с абзацем.
    expect(types(md)).toEqual(['paragraph']);
    expect(shape(md)).not.toContain('heading');
    expect(canonicalizeBody(md).body).toBe(md);
    // Соседняя конструкция `---` уже была закрыта — сверяем, что не сломали её.
    const dashes = serializeBody({
      ...doc,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'foo' },
            { type: 'hardBreak' },
            { type: 'text', text: '---' },
          ],
        },
      ],
    } as never);
    expect(types(dashes)).toEqual(['paragraph']);
  });

  test('`=` внутри строки и в конце строки НЕ экранируется без нужды', () => {
    // Страж от жадного правила: экранируется только строка ИЗ ОДНИХ `=` в начале текстового узла.
    for (const md of ['2 + 2 = 4', 'x == y', 'итог = 5']) {
      expect(raws(md)).toEqual([]);
      expect(canonicalizeBody(md).body).toBe(md);
    }
  });
});

describe('разбор не рождает документ, которого нет в схеме (найдено пробой)', () => {
  test('`1.` не роняет канонизацию — а роняла ВЕСЬ прогон бэкфилла', () => {
    // Пустой пункт НУМЕРОВАННОГО списка marked отдаёт без абзаца внутри, и `md().parse` строил
    // listItem с `content: []` — документ, который сама же схема отвергает («Invalid content for
    // node listItem»). serializeBody на нём БРОСАЛ TypeError из недр @tiptap/markdown, а значит
    // бросал и canonicalizeBody — то есть путь модели (entity_update{body}) отвечал 500, и,
    // главное, бэкфилл, который ошибку конверсии НЕ глотает намеренно, обрывался на такой строке
    // вместе со всем оставшимся хвостом корпуса. Проверено на исходном наборе расширений:
    // бросали `1.`, `1. `, `1)`, `2.`, `1.\n2.`, `текст\n\n1.`.
    for (const md of ['1.', '1. ', '1)', '2.', '1.\n2.', 'текст\n\n1.', '- раз\n\n1.']) {
      expect(() => canonicalizeBody(md)).not.toThrow();
      // Текст не потерян ни на байт: непрошедший схему блок уезжает в raw дословно, поэтому
      // канон этих тел — они сами. Заодно это и неподвижная точка.
      expect(canonicalizeBody(md).body).toBe(md);
    }
  });

  test('parseBody НИКОГДА не отдаёт документ, непригодный по схеме', () => {
    // Общее правило, а не заплатка под `1.`: непрошедший схему блок уводится в rawBlock тем же
    // приёмом, которым модуль спасает непонятое. Иначе следующий такой блок снова уронил бы
    // сериализацию — молча и на всём корпусе сразу.
    for (const md of [
      '1.',
      '2)',
      '- раз\n- два',
      '1. первый',
      '# Заголовок',
      '> цитата',
      '| a |\n| --- |\n| x |',
      '- [ ] дело',
      '```\nкод\n```',
      'обычный текст',
      '',
    ]) {
      expect(bodyDocError(parseBody(md))).toBeUndefined();
    }
  });

  test('годный нумерованный список в raw НЕ уезжает (страж от жадности)', () => {
    // Без этого «схема довольна» выполнялось бы и для корпуса, целиком уехавшего в raw.
    expect(raws('1. первый\n2. второй')).toEqual([]);
    expect(types('1. первый\n2. второй')).toEqual(['orderedList']);
    expect(canonicalizeBody('1. первый\n2. второй').body).toBe('1. первый\n2. второй');
  });
});

describe('пустой блок редактора — тоже неподвижная точка (найдено пробой)', () => {
  test('пустой пункт списка и пустая задача переживают проекцию', () => {
    // Живое состояние: нажали кнопку списка и ещё ничего не набрали. Автосохранение шлёт такой
    // документ на КАЖДОМ круге, поэтому неподвижной точкой он обязан быть в первую очередь.
    // Маркер печатался с ХВОСТОВЫМ ПРОБЕЛОМ ("- "), а `- ` marked списком не считает вовсе —
    // видит абзац с текстом «- », и канон экранировал его в «\- ».
    const item = (list: string, extra: Record<string, unknown> = {}) => ({
      v: DOC_SCHEMA_VERSION,
      doc: {
        type: 'doc',
        content: [
          {
            type: list,
            content: [
              {
                type: list === 'taskList' ? 'taskItem' : 'listItem',
                ...extra,
                content: [{ type: 'paragraph' }],
              },
            ],
          },
        ],
      },
    });
    for (const doc of [
      item('bulletList'),
      item('orderedList'),
      item('taskList', { attrs: { checked: false } }),
    ]) {
      const body = serializeBody(doc as never);
      expect(body).not.toBe(''); // страж: пустая строка неподвижна тождественно
      expect(canonicalizeBody(body).body).toBe(body);
      // Страховка записи такой документ НЕ трогает — иначе каждое нажатие кнопки списка
      // превращало бы весь документ в один raw-блок.
      expect(bodyPairFromDoc(doc as never).doc).toBe(doc as never);
    }
  });

  test('непустой пункт по-прежнему печатается с пробелом после маркера', () => {
    // Положительный контроль: снятие хвостового пробела касается ТОЛЬКО пустого пункта.
    expect(canonicalizeBody('- раз\n- два').body).toBe('- раз\n- два');
    expect(canonicalizeBody('1. раз\n2. два').body).toBe('1. раз\n2. два');
    expect(canonicalizeBody('- [ ] дело').body).toBe('- [ ] дело');
  });
});

describe('bodyPairFromDoc: страховка каноничности проекции (находка 3)', () => {
  test('обычный документ проходит НЕТРОНУТЫМ, вместе с чужими атрибутами', () => {
    // Положительный контроль и одновременно защита от «страховка срабатывает всегда»:
    // блочные id (UniqueID, в схеме их нет) обязаны доехать до БД.
    const doc = {
      v: DOC_SCHEMA_VERSION,
      doc: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: { id: 'блок-1' },
            content: [{ type: 'text', text: 'текст' }],
          },
        ],
      },
    };
    const pair = bodyPairFromDoc(doc as never);
    expect(pair.doc).toBe(doc as never); // тот же объект, а не пересборка
    expect(pair.body).toBe('текст');
    expect(canonicalizeBody(pair.body).body).toBe(pair.body);
  });

  test('проекция-не-неподвижная-точка уходит в rawBlock, а текст цел до байта', () => {
    // Модель следующей ноды с несимметричным сериализатором. Здесь она подделана прямым
    // rawBlock'ом с неканоничным текстом: parseBody вернёт из него ДРУГОЙ документ, то есть
    // ровно тот шов, ради которого страховка и ставится.
    const doc = {
      v: DOC_SCHEMA_VERSION,
      doc: {
        type: 'doc',
        content: [
          { type: 'rawBlock', attrs: { markdown: '* раз' } },
          { type: 'paragraph', content: [{ type: 'text', text: 'хвост' }] },
        ],
      },
    };
    const pair = bodyPairFromDoc(doc as never);
    expect(pair.body).toBe('* раз\n\nхвост'); // ни байта не потеряно, канон его НЕ переписал
    // Документ подменён: печатается дословно, поэтому пара согласована при любом сериализаторе.
    expect(pair.doc.doc.content).toEqual([
      { type: 'rawBlock', attrs: { markdown: '* раз\n\nхвост' } },
    ]);
    // Несущее свойство пары: документ печатается ровно в этот текст.
    expect(serializeBody(pair.doc)).toBe(pair.body);
  });

  test('страховка не отказывает и на сломанном документе — пара остаётся согласованной', () => {
    // Проверяем именно инвариант, а не конкретную форму починки: что бы страховка ни выбрала,
    // serialize(doc) обязан совпасть с body.
    for (const inner of [
      { type: 'doc', content: [{ type: 'codeBlock', content: [{ type: 'text', text: '```' }] }] },
      { type: 'doc', content: [{ type: 'rawBlock', attrs: { markdown: '1) первый' } }] },
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ок' }] }] },
    ]) {
      const pair = bodyPairFromDoc({ v: DOC_SCHEMA_VERSION, doc: inner } as never);
      expect(serializeBody(pair.doc)).toBe(pair.body);
      expect(bodyDocError(pair.doc)).toBeUndefined();
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

  test('БИТАЯ ФОРМА при знакомой версии — тоже пересборка (итоговое ревью, находка 5)', () => {
    // Докблок обещал пересборку «при битой форме», а код смотрел только на тип, наличие полей
    // и версию: `{v: 1, doc: 'мусор'}` уезжал в редактор как есть и ронял его на nodeFromJSON.
    // Проверяем именно то, что обещано, — на формах, которые версией НЕ отсеиваются.
    for (const broken of [
      { v: DOC_SCHEMA_VERSION, doc: 'мусор' },
      { v: DOC_SCHEMA_VERSION, doc: null },
      { v: DOC_SCHEMA_VERSION, doc: { type: 'doc' } }, // content пуст — топ-узел объявлен block+
      { v: DOC_SCHEMA_VERSION, doc: { type: 'doc', content: [{ type: 'НЕТ_ТАКОЙ_НОДЫ' }] } },
      { v: DOC_SCHEMA_VERSION, doc: { type: 'doc', content: [{ type: 'text' }] } }, // text без text
    ]) {
      const rebuilt = readBodyDoc(broken, '# Заголовок');
      expect(JSON.stringify(rebuilt.doc)).toContain('heading');
      // И пересобранное само по себе пригодно — иначе чинили бы одно, отдавая другое битое.
      expect(bodyDocError(rebuilt)).toBeUndefined();
    }
  });

  test('годный документ с ЧУЖИМИ атрибутами проверку переживает (страж от жадности)', () => {
    // Блочные id (UniqueID) схеме неизвестны, но обязаны доехать до редактора: без этого
    // ужесточение проверки стирало бы id у КАЖДОГО документа при каждом чтении.
    const withIds = {
      v: DOC_SCHEMA_VERSION,
      doc: {
        type: 'doc',
        content: [
          { type: 'paragraph', attrs: { id: 'блок-1' }, content: [{ type: 'text', text: 'а' }] },
        ],
      },
    };
    expect(readBodyDoc(withIds, 'другое')).toBe(withIds as never);
  });
});
