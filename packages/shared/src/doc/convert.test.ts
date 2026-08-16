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
/** Содержимое всех кодовых вставок документа — сверять их СТРОКОЙ бессмысленно, разделитель
 *  как раз и есть предмет спора. */
const codeSpans = (md: string): string[] => {
  const out: string[] = [];
  const walk = (n: {
    type?: string;
    text?: string;
    marks?: Array<{ type: string }>;
    content?: unknown[];
  }) => {
    if (typeof n.text === 'string' && (n.marks ?? []).some((m) => m.type === 'code'))
      out.push(n.text);
    for (const c of (n.content ?? []) as (typeof n)[]) walk(c);
  };
  walk(parseBody(md).doc as never);
  return out;
};

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

describe('разделитель кодовой вставки — по содержимому (ре-ревью, Б2)', () => {
  test('обратные кавычки внутри вставки НЕ пропадают', () => {
    // Разделитель был всегда одной кавычкой, и это была безвозвратная потеря СИМВОЛОВ:
    //   "`` ` ``"    → канон1 "```"  → канон2 "```\n\n```"  (кавычка исчезла, вставка → блок)
    //   "``` `` ```" → канон1 "````" → канон2 "```\n\n```"
    for (const md of ['`` ` ``', '``` `` ```', 'вот `` a`b `` конец', '`` `x `` тут', '`` x` ``']) {
      expect(raws(md)).toEqual([]); // страж: не raw, иначе всё ниже тождественно
      const once = canonicalizeBody(md).body;
      expect(canonicalizeBody(once).body).toBe(once); // канон устойчив
      // И, главное, содержимое вставки цело: сверяем ПО ДОКУМЕНТУ, а не по строке.
      expect(codeSpans(once)).toEqual(codeSpans(md));
      expect(codeSpans(md).length).toBeGreaterThan(0); // страж вакуумности
    }
  });

  test('содержимое с кавычками переживает round-trip через марку БАЙТ В БАЙТ', () => {
    for (const content of [
      'код',
      '`',
      '``',
      '```',
      '````',
      'a`b',
      'a``b',
      '`x',
      'x`',
      '`x`',
      '`a`b`',
      'a b',
      '*звёзды*',
      'due_date',
      '{{query: a=b}}',
      '\\',
    ]) {
      const doc = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: content, marks: [{ type: 'code' }] }],
          },
        ],
      };
      const md = serializeBody(doc as never);
      expect(`${content}: ${codeSpans(md).join('|')}`).toBe(`${content}: ${content}`);
      expect(`${content}: ${canonicalizeBody(md).body}`).toBe(`${content}: ${md}`);
    }
  });

  test('ИЗВЕСТНАЯ ГРАНИЦА: пробелы по краям вставки уезжают наружу, но не пропадают', () => {
    // Менеджер выносит ведущие и хвостовые пробелы ЗА пределы марки ещё до того, как спросит
    // обёртку (@tiptap/markdown, renderNodesWithMarkBoundaries) — на это отсюда не повлиять.
    // Фиксируем ФАКТ, а не желаемое: вставка сжимается, но ни один непробельный символ не
    // теряется, канон устойчив, и страховка записи такой документ не трогает.
    for (const content of [' x ', ' x', 'x ']) {
      const doc = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: content, marks: [{ type: 'code' }] }],
          },
        ],
      };
      const md = serializeBody(doc as never);
      expect(codeSpans(md)).toEqual([content.trim()]); // пробел ушёл из вставки…
      expect(md).toContain(content.trim()); // …но остался в тексте
      expect(canonicalizeBody(md).body).toBe(md);
      expect(bodyPairFromDoc({ v: DOC_SCHEMA_VERSION, doc } as never).doc.doc).toBe(doc as never);
    }
  });

  test('обычная вставка по-прежнему в ОДНУ кавычку (страж от жадности)', () => {
    // Без этого «содержимое цело» прошло бы и на разделителе из пяти кавычек всегда.
    expect(canonicalizeBody('это `код` тут').body).toBe('это `код` тут');
    expect(serializeBody(parseBody('`due_date`'))).toBe('`due_date`');
  });
});

describe('страховка НЕ трогает пустые абзацы (ре-ревью, Б1 — регресс раунда 1)', () => {
  // markdown не умеет выражать пустой абзац, поэтому у документа с пустой строкой проекция
  // неподвижной точкой канона не является В ПРИНЦИПЕ. Первая редакция страховки требовала
  // именно неподвижности и уводила такую заметку в один неправимый rawBlock на КАЖДОМ круге
  // автосохранения — человек видел, как его текст схлопывается.
  const P = (text?: string) =>
    text === undefined
      ? { type: 'paragraph' }
      : { type: 'paragraph', content: [{ type: 'text', text }] };
  const doc = (content: unknown[]) => ({ v: DOC_SCHEMA_VERSION, doc: { type: 'doc', content } });

  const cases: Array<[string, unknown]> = [
    [
      'хвостовой пустой абзац (человек нажал Enter в конце)',
      doc([
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'План' }] },
        P('первый пункт'),
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [P('раз')] },
            { type: 'listItem', content: [P('два')] },
          ],
        },
        P(),
      ]),
    ],
    ['текст + пустой абзац', doc([P('текст'), P()])],
    ['пустой абзац + текст', doc([P(), P('текст')])],
    ['абзац, пустой абзац, абзац', doc([P('раз'), P(), P('два')])],
    [
      'пустой абзац перед заголовком',
      doc([
        P('раз'),
        P(),
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'H' }] },
      ]),
    ],
    [
      'пустой абзац перед списком',
      doc([
        P('раз'),
        P(),
        { type: 'bulletList', content: [{ type: 'listItem', content: [P('a')] }] },
      ]),
    ],
    ['ДВА пустых абзаца подряд', doc([P('раз'), P(), P(), P('два')])],
  ];

  test('документ остаётся ТЕМ ЖЕ объектом, структура цела', () => {
    for (const [name, d] of cases) {
      const pair = bodyPairFromDoc(d as never);
      // Страж вакуумности: у документа обязано быть непустое содержимое, иначе проекция —
      // пустая строка, а она неподвижна тождественно и не утверждает ничего. Ровно на этой
      // ловушке первая редакция и проскочила сьют.
      expect(`${name}: ${pair.body}`).not.toBe(`${name}: `);
      expect(`${name}: ${(pair.doc.doc.content ?? []).length}`).not.toBe(`${name}: 1`);
      expect(`${name}: ${pair.doc === (d as never)}`).toBe(`${name}: true`);
      expect(`${name}: ${(pair.doc.doc.content ?? [])[0]?.type}`).not.toBe(`${name}: rawBlock`);
    }
  });

  test('канон таких тел действительно НЕ неподвижен — то есть страж не вакуумен', () => {
    // Премиса предыдущего теста: если бы проекции были неподвижны, он проходил бы и со старым
    // (строгим) критерием, то есть не защищал бы ни от чего.
    let movable = 0;
    for (const [, d] of cases) {
      const body = serializeBody(d as never);
      if (canonicalizeBody(body).body !== body) movable += 1;
    }
    expect(movable).toBe(cases.length);
  });

  test('ЭМОДЗИ не считается пропажей текста', () => {
    // Найдено сплошной пробой, а не типами: сверка «ничего не пропало» перебирала стог по
    // кодовым ТОЧКАМ, а иглу — по кодовым ЕДИНИЦАМ, поэтому суррогатная пара не совпадала сама
    // с собой. Любая заметка с эмодзи считалась потерявшей текст и уезжала в raw ЦЕЛИКОМ.
    for (const text of [
      'эмодзи 🎉 тут',
      '👨‍👩‍👧‍👦 семья',
      'математика 𝕏 и 𝔸',
      'одинокий \ud83d суррогат',
    ]) {
      const doc = { v: DOC_SCHEMA_VERSION, doc: { type: 'doc', content: [P(text)] } };
      const pair = bodyPairFromDoc(doc as never);
      expect(`${text}: ${pair.doc === (doc as never)}`).toBe(`${text}: true`);
      expect(`${text}: ${pair.doc.doc.content?.[0]?.type}`).toBe(`${text}: paragraph`);
    }
  });

  test('подпись ссылки с `]` — не пропажа: её опускает СОБСТВЕННАЯ починка находки 2', () => {
    // Тоже поймано пробой. Подпись — вмороженный кеш заголовка, а не авторский текст, и
    // сериализатор опускает её осознанно. Считай сверка подпись «написанным» — каждый чип
    // с такой подписью уводил бы весь документ в raw.
    const doc = {
      v: DOC_SCHEMA_VERSION,
      doc: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'entityRef', attrs: { entityId: UUID, label: 'Задача ] хвост' } }],
          },
        ],
      },
    };
    const pair = bodyPairFromDoc(doc as never);
    expect(pair.doc).toBe(doc as never);
    expect(pair.body).toBe(`[[entity:${UUID}]]`);
    expect(bodyRefsFromDoc(parseBody(pair.body))).toEqual([UUID]); // связь на месте
  });

  test('пропажа ССЫЛКИ ловится, даже когда текст цел', () => {
    // Вторая половина страховки, отдельно от первой. Ссылка с id не-uuid-формы печатается
    // дословно, но обратный разбор её ссылкой не признаёт (класс символов `[0-9a-f-]{36}`),
    // и связь исчезает из body_refs — при том что ВЕСЬ текст на месте. Без сверки ссылок такой
    // документ проходил бы молча (мутационная проверка показала: без неё не краснеет ничто).
    const doc = {
      v: DOC_SCHEMA_VERSION,
      doc: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'entityRef', attrs: { entityId: 'нет-такого-id', label: null } }],
          },
        ],
      },
    };
    const proj = serializeBody(doc as never);
    // Премиса: текст ЦЕЛ — значит сработает именно сверка ссылок, а не сверка текста.
    expect(proj).toContain('нет-такого-id');
    expect(bodyRefsFromDoc(doc as never)).toEqual(['нет-такого-id']);
    expect(bodyRefsFromDoc(parseBody(proj))).toEqual([]);
    const pair = bodyPairFromDoc(doc as never);
    expect(pair.doc).not.toBe(doc as never);
    expect(pair.doc.doc.content?.[0]?.type).toBe('rawBlock');
    expect(pair.body).toBe(proj); // текст всё равно уехал байт в байт
  });

  test('ВЕРХНИЙ РЕГИСТР id ссылки не считается пропажей', () => {
    // Разбор приводит id к нижнему регистру (И7), а посимвольная сверка регистра не прощает —
    // документ с `[[entity:0F8F…]]` уезжал в raw целиком. Сверка ССЫЛОК ту же связь проверяет
    // и к регистру нечувствительна, поэтому id из посимвольной сверки убран как избыточный.
    const doc = {
      v: DOC_SCHEMA_VERSION,
      doc: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'entityRef', attrs: { entityId: UUID.toUpperCase(), label: null } }],
          },
        ],
      },
    };
    const pair = bodyPairFromDoc(doc as never);
    expect(pair.doc).toBe(doc as never);
    expect(bodyRefsFromDoc(parseBody(pair.body))).toEqual([UUID]); // связь на месте, в нижнем
  });

  test('и при этом настоящая пропажа текста ловится (положительный контроль)', () => {
    // Тот же набор проверок, но на документе, чья проекция ТЕРЯЕТ написанное.
    const lossy = doc([
      { type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text: 'x' }] },
      { type: 'rawBlock', attrs: { markdown: '{{query: a=b}}\nхвост {{query: c=d}}' } },
    ]);
    const pair = bodyPairFromDoc(lossy as never);
    expect(pair.doc).not.toBe(lossy as never);
    expect(pair.doc.doc.content?.[0]?.type).toBe('rawBlock');
    expect(serializeBody(pair.doc)).toBe(pair.body);
  });
});

describe('рваная строка таблицы (ре-ревью раунда 3, п.2)', () => {
  test('строка ШИРЕ шапки уводит таблицу в raw — слово не исчезает', () => {
    // GFM обрезает лишние ячейки по ширине шапки, и слово пропадает НАВСЕГДА уже на ПЕРВОМ
    // разборе. Оба стоп-крана аудита на этом молчали по построению: они считают ПОСЛЕ первого
    // разбора. Замер до починки: канон "| a |\n| --- |\n| один |" — «ПОТЕРЯННЫЙ» нигде.
    for (const [md, missing] of [
      ['| a |\n| --- |\n| один | ПОТЕРЯННЫЙ |', 'ПОТЕРЯННЫЙ'],
      ['| a | b |\n| --- | --- |\n| 1 | 2 | 3 |', '3'],
      ['| a |\n| --- |\n| x |\n| y | ТОЖЕ |', 'ТОЖЕ'],
    ] as Array<[string, string]>) {
      expect(`${missing}: ${types(md).join()}`).toBe(`${missing}: rawBlock`);
      // Дословно: raw отдаёт вход байт в байт, поэтому текст цел и канон неподвижен.
      expect(`${missing}: ${canonicalizeBody(md).body}`).toBe(`${missing}: ${md}`);
      expect(canonicalizeBody(md).body).toContain(missing);
    }
  });

  test('строка УЖЕ шапки в raw НЕ уходит — там ничего не теряется', () => {
    // Страж от жадности, и он не умозрительный: недостающие ячейки GFM дополняет пустыми
    // (замерено: `| 1 |` под шапкой в две колонки → `| 1 |  |`), ни один символ не пропадает.
    // Уводить такие таблицы в raw значило бы ловить лишнее.
    const md = '| a | b |\n| --- | --- |\n| 1 |';
    expect(types(md)).toEqual(['table']);
    expect(canonicalizeBody(md).body).toContain('1');
    // И ровная таблица, конечно, тоже виджет.
    expect(types('| a | b |\n| --- | --- |\n| 1 | 2 |')).toEqual(['table']);
    expect(raws('| a | b |\n| --- | --- |\n| 1 | 2 |')).toEqual([]);
  });

  test('ВЛОЖЕННАЯ таблица проверяется теми же тремя правилами (ре-ревью раунда 4)', () => {
    // `blockIsKnown` звал проверки только для токена ВЕРХНЕГО уровня, а вложенная таблица шла
    // через walk, где спрашивалось лишь членство в списке известных блоков. Мимо проходили все
    // три правила сразу, причём картинка в ячейке — РЕГРЕСС уже сделанной починки.
    for (const [md, needle] of [
      ['> | a |\n> | --- |\n> | один | ПОТЕРЯННЫЙ |', 'ПОТЕРЯННЫЙ'],
      ['> | a |\n> | --- |\n> | ![схема](i.png) |', 'i.png'],
      ['> | a |\n> | --- |\n> | x \\| y |', '\\|'],
      ['- пункт\n\n  | a |\n  | --- |\n  | один | ПОТЕРЯННЫЙ |', 'ПОТЕРЯННЫЙ'],
    ] as Array<[string, string]>) {
      expect(`${needle}: ${types(md).join()}`).toBe(`${needle}: rawBlock`);
      // Дословно: raw отдаёт вход байт в байт, поэтому потерянного не остаётся.
      expect(`${needle}: ${canonicalizeBody(md).body}`).toBe(`${needle}: ${md}`);
    }
  });

  test('ЗДОРОВАЯ таблица в цитате виджетом остаётся (страж от жадности)', () => {
    // Без этого «вложенное уходит в raw» прошло бы и на починке, которая топит всякую таблицу
    // внутри цитаты или пункта.
    for (const md of [
      '> | a | b |\n> | --- | --- |\n> | 1 | 2 |',
      '- пункт\n\n  | a | b |\n  | --- | --- |\n  | 1 | 2 |',
    ]) {
      expect(`${md}: ${raws(md).length}`).toBe(`${md}: 0`);
      expect(canonicalizeBody(md).body).toContain('1');
      expect(canonicalizeBody(md).body).toContain('2');
    }
  });

  test('таблица с `\\|` в ячейке уходит в raw при любом положении черты', () => {
    // Счётчик ячеек экранирование НЕ разбирает намеренно: любая таблица с `\|` уже уходит в raw
    // давним правилом (сериализатор черту обратно не экранирует). Мутационная проверка
    // показала, что разбор экранирования не меняет исхода ни на одном входе, — значит это был
    // бы непроверяемый код. Тест закрепляет СЛЕДСТВИЕ, на котором держится упрощение: где бы
    // черта ни стояла — в пределах шапки или за её краем, — тело сохраняется дословно.
    for (const md of [
      '| a |\n| --- |\n| x \\| y |', // в пределах ширины
      '| a |\n| --- |\n| один | два \\| три |', // за краем шапки, в отброшенной части
      '| a | b |\n| --- | --- |\n| a | b \\| c |', // ровно по ширине
      // НЕСУЩИЙ вход: наивный счёт даёт 3 = ширине, то есть «шире шапки» НЕ срабатывает, и
      // таблицу держит в raw ТОЛЬКО правило про `\|`. Без этой строки зависимость двух правил
      // была бы заявлена, но не проверена: все входы выше наивно шире шапки, и сьют остался бы
      // зелёным при удалении правила (поймано ре-ревью раунда 4).
      '| a | b | c |\n| --- | --- | --- |\n| 1 \\| 2 | 3 |',
    ]) {
      expect(`${md}: ${types(md).join()}`).toBe(`${md}: rawBlock`);
      expect(`${md}: ${canonicalizeBody(md).body}`).toBe(`${md}: ${md}`);
    }
  });
});

describe('разбор обязан воспроизвести свой текст — ОБЩИЙ приём (ре-ревью раунда 6)', () => {
  test('кодовая вставка внутри списка глубины ≥ 2 не исчезает', () => {
    // Четвёртая форма одного семейства подряд: разбор молча выбрасывает узел, документ без него
    // схеме годен, в raw блок не уходит, а оба крана аудита считают уже ПОСЛЕ разбора, где обе
    // стороны согласны. Замер до починки: канон «1. Подготовка\n  - [ ] выложить ключ» —
    // вставка удалена ЦЕЛИКОМ при нулях по всем пяти кранам.
    for (const md of [
      '1. Подготовка\n\n   - [ ] выложить ключ\n\n     ```\n     ssh deploy\n     ```',
      '1. Подготовка\n\n   - выложить ключ\n\n     ```\n     admin hunter2\n     ```',
      '1. раз\n   - два\n     ```\n     секретный конфиг\n     ```',
      '1. раз\n   - [ ] два\n     ```\n     ещё один ключ\n     ```',
    ]) {
      expect(`${md}: ${types(md).join()}`).toBe(`${md}: rawBlock`);
      expect(`${md}: ${canonicalizeBody(md).body}`).toBe(`${md}: ${md}`); // дословно
    }
  });

  test('вставка не спасается тем, что её слова встречаются рядом (ре-ревью раунда 7)', () => {
    // Словесная проверка раунда 6 была слепа, когда выброшенный узел состоит из слов, уже
    // встречающихся в том же блоке. Бытовой рантбук, никакой синтетики: до починки вставка
    // удалялась целиком при нулях по всем пяти кранам, а « ```sh » спасалась лишь тем, что
    // «sh» не встретилось в тексте пункта.
    for (const [md, needle] of [
      [
        '1. Установка\n\n   - [ ] выполнить `npm install`\n\n     ```\n     npm install\n     ```',
        'npm install',
      ],
      ['1. Установка через sh\n\n   - [ ] запустить\n\n     ```sh\n     make\n     ```', 'make'],
      ['1. раз\n   - два\n     ```\n     раз два\n     ```', 'раз два'],
    ] as Array<[string, string]>) {
      expect(`${md}: ${types(md).join()}`).toBe(`${md}: rawBlock`);
      expect(`${md}: ${canonicalizeBody(md).body}`).toBe(`${md}: ${md}`);
      expect(canonicalizeBody(md).body).toContain(needle);
    }
  });

  test('краевое содержимое вставки не теряется: буквы, цифры, эмодзи, иероглиф', () => {
    // Слова короче двух символов словесная проверка не видела в принципе. Структурный счёт
    // от состава текста не зависит — в этом и была цель перехода.
    for (const content of ['a b c', '7 3 9', '🎉🎉🎉', '車', 'А. Б. В.', '!!! ???']) {
      const md = `1. раз\n   - два\n     \`\`\`\n     ${content}\n     \`\`\``;
      expect(`${content}: ${types(md).join()}`).toBe(`${content}: rawBlock`);
      expect(`${content}: ${canonicalizeBody(md).body}`).toBe(`${content}: ${md}`);
    }
  });

  test('приём общий: ловит по ПРОПАЖЕ, а не по перечню форм', () => {
    // Смысл этого теста — в его наборе. Здесь формы, которые чинились точечно в раундах 2–5;
    // все они остаются пойманными и после перехода на общий приём, то есть точечные правила
    // и общий приём не спорят.
    for (const md of [
      '| a |\n| --- |\n| один | ПОТЕРЯННЫЙ |',
      '> | a |\n> | --- |\n> | ![схема](i.png) |',
      '1. пункт\n\n   | a |\n   | --- |\n   | один | СМЕТА |',
      '[](http://пример.рф/адрес)',
      '- [ ] пункт\n\n  [](http://пример.рф/адрес)',
    ]) {
      expect(`${md}: ${types(md).join()}`).toBe(`${md}: rawBlock`);
      expect(`${md}: ${canonicalizeBody(md).body}`).toBe(`${md}: ${md}`);
    }
  });

  test('ЖАДНОСТИ нет: здоровые тела остаются виджетами (главный риск приёма)', () => {
    // Строгий критерий уже был регрессом однажды (раунд 2: любая заметка с пустой строкой
    // уезжала в raw). Здесь набор заведомо здоровых тел, включая вложенность трёх уровней и
    // все формы, где разметка ЗАКОННО переписывается.
    const healthy = [
      '# Заголовок\n\nабзац с текстом',
      '- раз\n- два\n  - вложенный\n- три',
      '1. первый\n2. второй\n   1. вложенный',
      '- [ ] дело\n- [x] сделано',
      '> цитата\n>\n> вторая строка',
      '```ts\nconst x = 1;\n```',
      '````\n```\nвнутри\n```\n````',
      '~~~js`\nx\n~~~',
      '| Заголовок | Значение |\n| --- | --- |\n| смета | 100 |',
      'текст **жирный** _курсив_ ~~зачёркнутый~~ `код`',
      'поле due_date и updated_at',
      'ссылка [сюда](https://example.com/путь)',
      'автоссылка <https://example.com/путь>',
      `см. [[entity:${UUID}|Кроссовки]]`,
      '{{query: aspect=orbis/task, status=inbox}}',
      'эмодзи 🎉 и семья 👨‍👩‍👧‍👦',
      '\\_курсив\\_ и \\> не цитата',
      '&copy; знак и &lt;тег&gt; и &amp; амперсанд',
      '0. ноль\n1. один',
      '- пункт\n\n  ```js\n  код внутри\n  ```',
      '1. пункт\n\n   ```js\n   код внутри\n   ```',
      '> цитата\n>\n> ```js\n> код\n> ```',
      '1. раз\n   - два\n     - три',
      '- раз\n  1. два\n     1. три',
      'Заголовок\n=========',
      'параграф с https://example.com/голая-ссылка внутри',
      '| a | b |\n| --- | --- |\n|  |  |',
      '> | a | b |\n> | --- | --- |\n> | 1 | 2 |',
      '- пункт\n\n  | a | b |\n  | --- | --- |\n  | 1 | 2 |',
      '1. пункт\n\n   | a | b |\n   | --- | --- |\n   | 1 | 2 |',
      '- раз\n  - два\n    - три\n      - четыре',
      '1. раз\n   1. два\n      1. три',
      '```\n\n```',
      '[ссылка с **жирным**](https://ex.com)',
      '1. пункт\n\n   > цитата в пункте',
      'много   пробелов   между   словами',
      '&nbsp; одинокий',
    ];
    for (const md of healthy) {
      expect(`${md}: ${raws(md).length}`).toBe(`${md}: 0`);
    }
  });

  test('ИЗВЕСТНАЯ ГРАНИЦА: кодовая вставка ВНУТРИ другой марки рисуется дословно', () => {
    // Тоже не жадность приёма, а СХЕМА: марка `code` объявлена `excludes: "_"`, то есть
    // несовместима с любой другой, и разбор `**жирный с \`кодом\`**` даёт текстовый узел с
    // марками bold+code, который схема отвергает (замерено — отвергает именно она).
    // Текст цел до байта, канон неподвижен.
    for (const md of [
      'вложенный **жирный с `кодом` внутри**',
      '*курсив с `кодом`*',
      '[ссылка с `кодом`](https://ex.com)',
    ]) {
      expect(`${md}: ${types(md).join()}`).toBe(`${md}: rawBlock`);
      expect(`${md}: ${canonicalizeBody(md).body}`).toBe(`${md}: ${md}`);
    }
    // Рядом, а не внутри — обычный абзац.
    expect(types('обычный **жирный** и `код` рядом')).toEqual(['paragraph']);
  });

  test('ИЗВЕСТНАЯ ГРАНИЦА: пункт ЧЕКЛИСТА с вложенным блоком рисуется дословно', () => {
    // Не жадность нового приёма, а пре-существующее свойство СХЕМЫ: разбор такого пункта даёт
    // документ, который схема отвергает (замерено — отвергает именно она, до проверки слов),
    // и блок сохраняется дословно. Текст цел до байта, канон неподвижен. Фиксируем ФАКТ, чтобы
    // следующий читатель не принял это за регресс приёма.
    for (const md of [
      '- [ ] пункт\n\n  ```js\n  код внутри\n  ```',
      '- [ ] пункт\n\n  | a | b |\n  | --- | --- |\n  | 1 | 2 |',
      '- [ ] пункт\n\n  > цитата внутри',
    ]) {
      expect(`${md}: ${types(md).join()}`).toBe(`${md}: rawBlock`);
      expect(`${md}: ${canonicalizeBody(md).body}`).toBe(`${md}: ${md}`);
    }
    // А чеклист БЕЗ вложенных блоков — обычный виджет.
    expect(types('- [ ] дело\n- [x] сделано')).toEqual(['taskList']);
    expect(types('- [ ] пункт с `кодом` внутри строки')).toEqual(['taskList']);
  });
});

describe('ВСЕ правила × нумерованный пункт и чеклист (ре-ревью раунда 5 — блокер)', () => {
  // `walk(token.tokens ?? token.items)` не осматривал поддерево ВОВСЕ: у маркированного списка
  // `tokens` отсутствует, а у нумерованного и чеклиста он ЕСТЬ И ПУСТ, и `[] ?? items` даёт
  // `[]`. Мои тесты раунда 4 везде брали маркированный список — то есть форму, которая
  // работала СЛУЧАЙНО, — и заявление «класс закрыт» было ложным.
  //
  // Второй контейнер, найденный тем же прогоном: `nestedTokens` у пункта ЧЕКЛИСТА.
  // Без него `- [ ] пункт` + `[](url)` терял адрес, а html-блок экранировался вместо raw.
  const rules: Array<[string, (item: string, indent: string) => string, string]> = [
    [
      'рваная строка таблицы',
      (i, s) => `${i}пункт\n\n${s}| a |\n${s}| --- |\n${s}| один | СМЕТА |`,
      'СМЕТА',
    ],
    [
      'картинка в ячейке',
      (i, s) => `${i}пункт\n\n${s}| a |\n${s}| --- |\n${s}| ![схема](i.png) |`,
      'i.png',
    ],
    [
      'экранированная черта',
      (i, s) => `${i}пункт\n\n${s}| a |\n${s}| --- |\n${s}| x \\| y |`,
      '\\|',
    ],
    ['картинка в абзаце', (i, s) => `${i}пункт\n\n${s}![схема](i.png)`, 'i.png'],
    ['ссылка с пустым текстом', (i, s) => `${i}пункт\n\n${s}[](https://ex.com/зело)`, 'зело'],
    ['html-блок', (i, s) => `${i}пункт\n\n${s}<div>html</div>`, '<div>'],
  ];
  const forms: Array<[string, string, string]> = [
    ['нумерованный', '1. ', '   '],
    ['чеклист', '- [ ] ', '  '],
    ['маркированный', '- ', '  '],
  ];

  test('непонятое внутри пункта уводит блок в raw — текст цел до байта', () => {
    for (const [formName, marker, indent] of forms) {
      for (const [ruleName, build, needle] of rules) {
        const md = build(marker, indent);
        const label = `${formName}/${ruleName}`;
        expect(`${label}: ${types(md).join()}`).toBe(`${label}: rawBlock`);
        expect(`${label}: ${canonicalizeBody(md).body}`).toBe(`${label}: ${md}`);
        expect(`${label}: ${canonicalizeBody(md).body.includes(needle)}`).toBe(`${label}: true`);
      }
    }
  });

  test('ссылка с пустым текстом ПРЯМО в пункте (без вложенного абзаца)', () => {
    for (const md of [
      '1. [](https://ex.com/зело)',
      '- [ ] [](https://ex.com/зело)',
      '- [](https://ex.com/зело)',
    ]) {
      expect(`${md}: ${types(md).join()}`).toBe(`${md}: rawBlock`);
      expect(`${md}: ${canonicalizeBody(md).body}`).toBe(`${md}: ${md}`);
    }
  });

  test('ЗДОРОВЫЕ нумерованный и чеклист остаются виджетами (страж от жадности)', () => {
    // Без этого «всё уходит в raw» прошло бы как починка и убило бы списки целиком.
    const healthy: Array<[string, string]> = [
      ['1. первый\n2. второй', 'orderedList'],
      ['1. первый\n2. второй\n   1. вложенный', 'orderedList'],
      ['- [ ] дело\n- [x] сделано', 'taskList'],
      ['1. пункт с **жирным** и `кодом`', 'orderedList'],
      ['- [ ] пункт со [ссылкой](https://example.com)', 'taskList'],
      ['1. пункт\n\n   абзац внутри пункта', 'orderedList'],
      ['1. пункт\n\n   ```js\n   код\n   ```', 'orderedList'],
      ['1. пункт\n\n   | a | b |\n   | --- | --- |\n   | 1 | 2 |', 'orderedList'],
      ['- пункт\n\n  | a | b |\n  | --- | --- |\n  | 1 | 2 |', 'bulletList'],
    ];
    for (const [md, expected] of healthy) {
      expect(`${md}: ${types(md).join()}`).toBe(`${md}: ${expected}`);
    }
  });
});

describe('ссылка с пустым текстом (ре-ревью раунда 4)', () => {
  test('`[](адрес)` не уничтожает адрес — блок уходит в raw', () => {
    // Адрес живёт АТРИБУТОМ, поэтому посимвольная сверка страховки его не видит, а узел
    // исчезает целиком: `[](url)` → канон "". Все четыре счётчика аудита при этом молчали.
    for (const md of [
      '[](http://пример.рф/адрес)',
      'до [](http://пример.рф/адрес) после',
      '# заголовок [](http://пример.рф/адрес)',
      '> цитата [](http://пример.рф/адрес)',
      '- пункт [](http://пример.рф/адрес)',
      '| a |\n| --- |\n| [](http://пример.рф/адрес) |',
    ]) {
      expect(`${md}: ${canonicalizeBody(md).body}`).toBe(`${md}: ${md}`); // дословно
      expect(canonicalizeBody(md).body).toContain('пример.рф/адрес');
    }
  });

  test('обычная ссылка виджетом остаётся (страж от жадности)', () => {
    for (const md of [
      '[текст](https://example.com)',
      '[ ](https://example.com)', // текст из одного пробела — узел выживает
      'см. [док](https://example.com) тут',
      '<https://example.com>',
    ]) {
      expect(`${md}: ${raws(md).length}`).toBe(`${md}: 0`);
      expect(canonicalizeBody(md).body).toContain('example.com');
    }
  });
});

describe('ярлык языка блока кода не теряется (ре-ревью раунда 3, Б5)', () => {
  test('обратная кавычка в ярлыке — печатается ТИЛЬДА-ограда, ярлык цел', () => {
    // В раунде 1 негодный ярлык просто опускался, и это была тихая потеря авторского текста
    // мимо обоих стоп-кранов (замер: `~~~js`…` → канон "```\nx\n```", changed=да, оба крана — нет).
    for (const md of ['~~~js`\nx\n~~~', '~~~a`b\nx\n~~~', '~~~```\nx\n~~~']) {
      expect(types(md)).toEqual(['codeBlock']); // страж: не raw
      const once = canonicalizeBody(md).body;
      const doc = parseBody(once).doc.content ?? [];
      expect(`${md}: ${doc[0]?.attrs?.language}`).toBe(
        `${md}: ${parseBody(md).doc.content?.[0]?.attrs?.language}`,
      );
      expect(`${md}: ${doc[0]?.content?.[0]?.text}`).toBe(`${md}: x`);
      expect(`${md}: ${canonicalizeBody(once).body}`).toBe(`${md}: ${once}`); // устойчив
    }
  });

  test('тильда-ограда растёт по содержимому', () => {
    for (const [content, expected] of [
      ['x', '~~~'],
      ['~~~', '~~~~'],
      ['~~~~', '~~~~~'],
    ] as Array<[string, string]>) {
      const md = serializeBody({
        type: 'doc',
        content: [
          {
            type: 'codeBlock',
            attrs: { language: 'js`' },
            content: [{ type: 'text', text: content }],
          },
        ],
      } as never);
      expect(`${content}: ${md.split('\n')[0]}`).toBe(`${content}: ${expected}js\``);
      expect(`${content}: ${canonicalizeBody(md).body}`).toBe(`${content}: ${md}`);
    }
  });

  test('обычный язык по-прежнему в КАВЫЧКАХ (страж от жадности)', () => {
    // Без этого «ярлык цел» прошло бы и на переводе всех блоков кода на тильды.
    expect(canonicalizeBody('```ts\nconst x = 1;\n```').body).toBe('```ts\nconst x = 1;\n```');
    expect(canonicalizeBody('```js extra\nx\n```').body).toBe('```js extra\nx\n```');
    expect(canonicalizeBody('```\nx\n```').body).toBe('```\nx\n```');
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
