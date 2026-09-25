// bun:test, как весь пакет shared. Модуль листовой: тест не тянет ни tiptap, ни marked, чтобы
// проверка «препроход обходится без токенайзера» не держалась на том, что токенайзер рядом.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  CONTAINER_LIMITS,
  GRAMMAR_ERROR_CODES,
  GRAMMAR_ERROR_MESSAGES,
  type GrammarErrorCode,
  type PageNode,
  parsePageText,
  RECORD_BLOCK_NAMES,
} from './page-grammar';

/** Склейка верхнего уровня: `text` у текста, `raw` у прочих — обязана вернуть вход до байта. */
const glue = (nodes: PageNode[]): string =>
  nodes.map((n) => (n.kind === 'text' ? n.text : n.raw)).join('');

const text = (t: string): PageNode => ({ kind: 'text', text: t });
const broken = (code: GrammarErrorCode, raw: string): PageNode => ({
  kind: 'broken',
  code,
  message: GRAMMAR_ERROR_MESSAGES[code],
  raw,
});

/** Разбор + обязательная сверка склейки: каждый случай таблицы заодно проверяет инвариант. */
const parse = (src: string): PageNode[] => {
  const nodes = parsePageText(src);
  expect(glue(nodes)).toBe(src);
  return nodes;
};

const lines = (...ls: string[]) => ls.map((l) => `${l}\n`).join('');

describe('контейнеры §5.2', () => {
  test('пример колонок из спеки — две части, текст внутри дословно', () => {
    const src = lines(
      '{{columns}}',
      '{{column}}',
      '…текст и блоки…',
      '{{/column}}',
      '{{column}}',
      '…',
      '{{/column}}',
      '{{/columns}}',
    );
    expect(parse(src)).toEqual([
      { kind: 'columns', parts: [[text('…текст и блоки…\n')], [text('…\n')]], raw: src },
    ]);
  });

  test('пример вкладок из спеки — подписи «Запись» и «Тред»', () => {
    const src = lines(
      '{{tabs}}',
      '{{tab: Запись}}',
      '…',
      '{{/tab}}',
      '{{tab: Тред}}',
      '…',
      '{{/tab}}',
      '{{/tabs}}',
    );
    expect(parse(src)).toEqual([
      {
        kind: 'tabs',
        parts: [
          { label: 'Запись', children: [text('…\n')] },
          { label: 'Тред', children: [text('…\n')] },
        ],
        raw: src,
      },
    ]);
  });

  test('соседи контейнера вне его остаются текстом рядом с ним', () => {
    const box = lines('{{tabs}}', '{{tab: A}}', 'x', '{{/tab}}', '{{/tabs}}');
    const src = `до\n\n${box}\nпосле`;
    expect(parse(src)).toEqual([
      text('до\n\n'),
      { kind: 'tabs', parts: [{ label: 'A', children: [text('x\n')] }], raw: box },
      text('\nпосле'),
    ]);
  });

  test('пустые строки между частями законны: канон печатает блоки через пустую строку', () => {
    const src = [
      '{{columns}}',
      '',
      '{{column}}',
      '',
      'a',
      '',
      '{{/column}}',
      '',
      '{{column}}',
      '',
      'b',
      '',
      '{{/column}}',
      '',
      '{{/columns}}',
    ].join('\n');
    expect(parse(src)).toEqual([
      { kind: 'columns', parts: [[text('\na\n\n')], [text('\nb\n\n')]], raw: src },
    ]);
  });

  test('между частями — несколько пустых строк или строка из пробелов: тоже пустота, не TEXT_OUTSIDE_PART (MUT-M1)', () => {
    const many = lines(
      '{{columns}}',
      '{{column}}',
      'a',
      '{{/column}}',
      '',
      '',
      '{{column}}',
      'b',
      '{{/column}}',
      '{{/columns}}',
    );
    expect(parse(many)).toEqual([
      { kind: 'columns', parts: [[text('a\n')], [text('b\n')]], raw: many },
    ]);
    const spaces = lines(
      '{{tabs}}',
      '{{tab: A}}',
      'x',
      '{{/tab}}',
      '   \t',
      '{{tab: B}}',
      'y',
      '{{/tab}}',
      '{{/tabs}}',
    );
    expect(parse(spaces)).toEqual([
      {
        kind: 'tabs',
        parts: [
          { label: 'A', children: [text('x\n')] },
          { label: 'B', children: [text('y\n')] },
        ],
        raw: spaces,
      },
    ]);
  });

  test('{{tab}} без подписи — вкладка с пустой подписью; подпись без краевых пробелов', () => {
    const src = lines(
      '{{tabs}}',
      '{{tab}}',
      '{{/tab}}',
      '{{tab:   Детали  }}',
      '{{/tab}}',
      '{{/tabs}}',
    );
    const [node] = parse(src);
    expect(node).toMatchObject({ kind: 'tabs' });
    if (node?.kind !== 'tabs') throw new Error('ожидались вкладки');
    expect(node.parts.map((p) => p.label)).toEqual(['', 'Детали']);
    expect(node.parts.map((p) => p.children)).toEqual([[], []]);
  });

  test('шаблон хоста §8.1 разбирается целиком без ошибок', () => {
    const src = lines(
      '{{title}}',
      '{{tags}}',
      '{{tabs}}',
      '{{tab: Запись}}',
      '{{card: orbis/goal}}',
      '{{card: orbis/assignment}}',
      '{{body}}',
      '{{/tab}}',
      '{{tab: Детали}}',
      '{{cards}}',
      '{{versions}}',
      '{{subtasks}}',
      '{{blockers}}',
      '{{backlinks}}',
      '{{/tab}}',
      '{{tab: Тред}}',
      '{{thread}}',
      '{{/tab}}',
      '{{/tabs}}',
    );
    const nodes = parse(src);
    expect(nodes.map((n) => n.kind)).toEqual(['record', 'record', 'tabs']);
    const tabs = nodes[2];
    if (tabs?.kind !== 'tabs') throw new Error('ожидались вкладки');
    expect(tabs.parts.map((p) => p.label)).toEqual(['Запись', 'Детали', 'Тред']);
    expect(tabs.parts[0]?.children).toEqual([
      { kind: 'card', aspect: 'orbis/goal', raw: '{{card: orbis/goal}}\n' },
      { kind: 'card', aspect: 'orbis/assignment', raw: '{{card: orbis/assignment}}\n' },
      { kind: 'record', name: 'body', raw: '{{body}}\n' },
    ]);
    expect(tabs.parts[2]?.children).toEqual([
      { kind: 'record', name: 'thread', raw: '{{thread}}\n' },
    ]);
  });
});

describe('вложенность', () => {
  test('вкладки внутри колонки — законно, вложенный узел несёт свой raw дословно', () => {
    const inner = lines('{{tabs}}', '{{tab: A}}', 'x', '{{/tab}}', '{{/tabs}}');
    const src = `${lines('{{columns}}', '{{column}}')}${inner}${lines(
      '{{/column}}',
      '{{column}}',
      'y',
      '{{/column}}',
      '{{/columns}}',
    )}`;
    expect(parse(src)).toEqual([
      {
        kind: 'columns',
        parts: [
          [{ kind: 'tabs', parts: [{ label: 'A', children: [text('x\n')] }], raw: inner }],
          [text('y\n')],
        ],
        raw: src,
      },
    ]);
  });

  test('колонки внутри вкладки — законно', () => {
    const inner = lines(
      '{{columns}}',
      '{{column}}',
      'a',
      '{{/column}}',
      '{{column}}',
      'b',
      '{{/column}}',
      '{{/columns}}',
    );
    const src = `${lines('{{tabs}}', '{{tab: A}}')}${inner}${lines('{{/tab}}', '{{/tabs}}')}`;
    const [node] = parse(src);
    if (node?.kind !== 'tabs') throw new Error('ожидались вкладки');
    expect(node.parts[0]?.children).toEqual([
      { kind: 'columns', parts: [[text('a\n')], [text('b\n')]], raw: inner },
    ]);
  });

  test('третий уровень → broken DEPTH_EXCEEDED, raw — от открытия до закрытия внешнего, соседи целы', () => {
    const outer = lines(
      '{{columns}}',
      '{{column}}',
      '{{tabs}}',
      '{{tab: A}}',
      '{{columns}}',
      '{{column}}',
      'x',
      '{{/column}}',
      '{{column}}',
      'y',
      '{{/column}}',
      '{{/columns}}',
      '{{/tab}}',
      '{{/tabs}}',
      '{{/column}}',
      '{{column}}',
      'z',
      '{{/column}}',
      '{{/columns}}',
    );
    const src = `до\n${outer}после\n`;
    expect(parse(src)).toEqual([text('до\n'), broken('DEPTH_EXCEEDED', outer), text('после\n')]);
  });

  test('ошибка во вложенном контейнере ломает весь внешний, а следующий контейнер цел', () => {
    const bad = lines(
      '{{tabs}}',
      '{{tab: A}}',
      '{{columns}}',
      '{{column}}',
      'один',
      '{{/column}}',
      '{{/columns}}',
      '{{/tab}}',
      '{{/tabs}}',
    );
    const good = lines('{{tabs}}', '{{tab: B}}', '{{/tab}}', '{{/tabs}}');
    const nodes = parse(`${bad}${good}`);
    expect(nodes).toEqual([
      broken('PART_COUNT', bad),
      { kind: 'tabs', parts: [{ label: 'B', children: [] }], raw: good },
    ]);
  });
});

describe('ошибки §5.8: ни одна не теряет текст', () => {
  test('незакрытый {{columns}} до конца тела → CONTAINER_UNCLOSED, raw — хвост дословно', () => {
    const tail = lines(
      '{{columns}}',
      '{{column}}',
      'x',
      '{{/column}}',
      '{{column}}',
      'y',
      '{{/column}}',
    );
    expect(parse(`до\n${tail}`)).toEqual([text('до\n'), broken('CONTAINER_UNCLOSED', tail)]);
  });

  test('незакрытый контейнер без переноса в конце — хвост дословно', () => {
    const tail = '{{tabs}}\n{{tab: A}}\nтекст';
    expect(parse(`x\n${tail}`)).toEqual([text('x\n'), broken('CONTAINER_UNCLOSED', tail)]);
  });

  test('незакрытая часть: закрытие контейнера при открытой колонке → PART_UNCLOSED', () => {
    const src = lines(
      '{{columns}}',
      '{{column}}',
      'a',
      '{{column}}',
      'b',
      '{{/column}}',
      '{{/columns}}',
    );
    expect(parse(src)).toEqual([broken('PART_UNCLOSED', src)]);
    const src2 = lines(
      '{{columns}}',
      '{{column}}',
      'a',
      '{{/column}}',
      '{{column}}',
      'b',
      '{{/columns}}',
    );
    expect(parse(src2)).toEqual([broken('PART_UNCLOSED', src2)]);
  });

  test('незакрытая вкладка перед следующей → PART_UNCLOSED', () => {
    const src = lines('{{tabs}}', '{{tab: A}}', 'a', '{{tab: B}}', 'b', '{{/tab}}', '{{/tabs}}');
    expect(parse(src)).toEqual([broken('PART_UNCLOSED', src)]);
  });

  test('текст вне части внутри контейнера → TEXT_OUTSIDE_PART', () => {
    const src = lines(
      '{{columns}}',
      'вне части',
      '{{column}}',
      'a',
      '{{/column}}',
      '{{column}}',
      '{{/column}}',
      '{{/columns}}',
    );
    expect(parse(`до\n${src}после`)).toEqual([
      text('до\n'),
      broken('TEXT_OUTSIDE_PART', src),
      text('после'),
    ]);
  });

  test('блок обвязки и блок данных вне части тоже TEXT_OUTSIDE_PART', () => {
    for (const stray of ['{{title}}', '{{query:a=1}}', '{{card: orbis/goal}}']) {
      const src = lines('{{tabs}}', stray, '{{tab: A}}', '{{/tab}}', '{{/tabs}}');
      expect(parse(src)).toEqual([broken('TEXT_OUTSIDE_PART', src)]);
    }
  });

  test('контейнер прямо в контейнере, вне части → TEXT_OUTSIDE_PART', () => {
    const src = lines('{{tabs}}', '{{columns}}', '{{/columns}}', '{{/tabs}}');
    expect(parse(src)).toEqual([broken('TEXT_OUTSIDE_PART', src)]);
  });

  test('{{column}} вне {{columns}} → PART_OUTSIDE_CONTAINER, текст дальше цел', () => {
    expect(parse(lines('до', '{{column}}', 'x', '{{/column}}'))).toEqual([
      text('до\n'),
      broken('PART_OUTSIDE_CONTAINER', '{{column}}\n'),
      text('x\n'),
      broken('CLOSE_WITHOUT_OPEN', '{{/column}}\n'),
    ]);
    expect(parse('{{tab: Тред}}')).toEqual([broken('PART_OUTSIDE_CONTAINER', '{{tab: Тред}}')]);
  });

  test('{{tab}} прямо внутри {{columns}} (без {{tabs}}) → PART_OUTSIDE_CONTAINER', () => {
    const src = lines('{{columns}}', '{{tab: A}}', 'x', '{{/tab}}', '{{/columns}}');
    expect(parse(src)).toEqual([broken('PART_OUTSIDE_CONTAINER', src)]);
  });

  test('{{tab}} внутри {{column}} без {{tabs}} → PART_OUTSIDE_CONTAINER', () => {
    const src = lines(
      '{{columns}}',
      '{{column}}',
      '{{tab: A}}',
      '{{/tab}}',
      '{{/column}}',
      '{{column}}',
      '{{/column}}',
      '{{/columns}}',
    );
    expect(parse(src)).toEqual([broken('PART_OUTSIDE_CONTAINER', src)]);
  });

  test('{{/tabs}} без открытия → CLOSE_WITHOUT_OPEN, только своя строка', () => {
    expect(parse(lines('a', '{{/tabs}}', 'b'))).toEqual([
      text('a\n'),
      broken('CLOSE_WITHOUT_OPEN', '{{/tabs}}\n'),
      text('b\n'),
    ]);
  });

  test('чужое закрытие внутри контейнера → CLOSE_WITHOUT_OPEN у всего контейнера', () => {
    const src = lines(
      '{{columns}}',
      '{{column}}',
      '{{/tab}}',
      '{{/column}}',
      '{{column}}',
      '{{/column}}',
      '{{/columns}}',
    );
    expect(parse(src)).toEqual([broken('CLOSE_WITHOUT_OPEN', src)]);
  });

  test('повторное закрытие части → CLOSE_WITHOUT_OPEN', () => {
    const src = lines('{{tabs}}', '{{tab: A}}', '{{/tab}}', '{{/tab}}', '{{/tabs}}');
    expect(parse(src)).toEqual([broken('CLOSE_WITHOUT_OPEN', src)]);
  });

  const columnsOf = (n: number) =>
    lines(
      '{{columns}}',
      ...Array.from({ length: n }, () => ['{{column}}', '{{/column}}']).flat(),
      '{{/columns}}',
    );
  const tabsOf = (n: number) =>
    lines(
      '{{tabs}}',
      ...Array.from({ length: n }, (_, i) => [`{{tab: ${i}}}`, '{{/tab}}']).flat(),
      '{{/tabs}}',
    );

  test('число частей: 1 и 5 колонок, 0 и 9 вкладок → PART_COUNT', () => {
    for (const src of [columnsOf(1), columnsOf(5), tabsOf(0), tabsOf(9)]) {
      expect(parse(src)).toEqual([broken('PART_COUNT', src)]);
    }
  });

  test('границы числа частей законны: 2 и 4 колонки, 1 и 8 вкладок', () => {
    expect(CONTAINER_LIMITS).toEqual({
      columns: { min: 2, max: 4 },
      tabs: { min: 1, max: 8 },
      depth: 2,
    });
    for (const [src, kind, n] of [
      [columnsOf(2), 'columns', 2],
      [columnsOf(4), 'columns', 4],
      [tabsOf(1), 'tabs', 1],
      [tabsOf(8), 'tabs', 8],
    ] as const) {
      const [node] = parse(src);
      expect(node?.kind).toBe(kind);
      if (node?.kind !== 'columns' && node?.kind !== 'tabs') throw new Error('ожидался контейнер');
      expect(node.parts.length).toBe(n);
    }
  });

  test('каждый код ошибки имеет русское сообщение словарём концепции', () => {
    expect(Object.keys(GRAMMAR_ERROR_MESSAGES).sort()).toEqual([...GRAMMAR_ERROR_CODES].sort());
    for (const code of GRAMMAR_ERROR_CODES) {
      const m = GRAMMAR_ERROR_MESSAGES[code];
      expect(m).toMatch(/[а-яё]/i);
      expect(m.toLowerCase()).not.toMatch(/view|панел|секци|смарт-лист/);
    }
  });
});

describe('блоки обвязки §5.3', () => {
  test('все девять имён — узлы record; raw — строка целиком', () => {
    expect(RECORD_BLOCK_NAMES).toEqual([
      'title',
      'tags',
      'body',
      'cards',
      'subtasks',
      'blockers',
      'backlinks',
      'versions',
      'thread',
    ]);
    const src = RECORD_BLOCK_NAMES.map((n) => `{{${n}}}\n`).join('');
    expect(parse(src)).toEqual(
      RECORD_BLOCK_NAMES.map((name) => ({ kind: 'record', name, raw: `{{${name}}}\n` })),
    );
  });

  test('{{card: orbis/goal}} и {{card: "Цель"}} — аспект как написан', () => {
    expect(parse('{{card: orbis/goal}}\n{{card: "Цель"}}')).toEqual([
      { kind: 'card', aspect: 'orbis/goal', raw: '{{card: orbis/goal}}\n' },
      { kind: 'card', aspect: '"Цель"', raw: '{{card: "Цель"}}' },
    ]);
  });

  test('блок обвязки между абзацами режет текст', () => {
    expect(parse('абзац\n{{title}}\nхвост')).toEqual([
      text('абзац\n'),
      { kind: 'record', name: 'title', raw: '{{title}}\n' },
      text('хвост'),
    ]);
  });
});

describe('текстом остаётся всё незнакомое §5.7', () => {
  test.each([
    'x {{title}} y',
    '{{finance/ring}}',
    '{{unknown}}',
    '  {{title}}',
    '   {{columns}}',
    '\t{{title}}',
    '{{columns: x}}',
    '{{/tab: x}}',
    '{{column: x}}',
    '{{card:}}',
    '{{tab:}}',
    '{{card: }}',
    '{{card:   }}',
    '{{card:\t}}',
    '{{tab: }}',
    '{{tab:   }}',
    '{{tab:\t \t}}',
    '{{Title}}',
    '{{title}} хвост',
  ])('%p — текст', (src) => {
    expect(parse(src)).toEqual([text(src)]);
    expect(parse(`${src}\n`)).toEqual([text(`${src}\n`)]);
  });

  test('подпись только у открывающего {{tab: …}}: {{/tab: x}} в контейнере — текст внутри части', () => {
    const src = lines('{{tabs}}', '{{tab: A}}', '{{/tab: x}}', '{{/tab}}', '{{/tabs}}');
    const [node] = parse(src);
    if (node?.kind !== 'tabs') throw new Error('ожидались вкладки');
    expect(node.parts[0]?.children).toEqual([text('{{/tab: x}}\n')]);
  });

  test('{{tab: a}} b}} — вкладка с подписью «a}} b»: закрытие ищется у конца строки', () => {
    const src = lines('{{tabs}}', '{{tab: a}} b}}', '{{/tab}}', '{{/tabs}}');
    const [node] = parse(src);
    if (node?.kind !== 'tabs') throw new Error('ожидались вкладки');
    expect(node.parts.map((p) => p.label)).toEqual(['a}} b']);
  });

  test('пустое тело — пустой список', () => {
    expect(parsePageText('')).toEqual([]);
  });
});

describe('заборы кода (Фокус ревью п. 2)', () => {
  test.each([
    ['```', '```'],
    ['~~~', '~~~'],
    ['```ts', '```'],
    ['````', '`````'],
    ['   ```', '```'],
    ['~~~~', '~~~~  '],
  ])('маркеры внутри забора %p … %p — текст', (open, close) => {
    const src = lines(
      open,
      '{{columns}}',
      '{{column}}',
      '{{title}}',
      '{{query:a=1}}',
      '{{/column}}',
      close,
      'после',
    );
    expect(parse(src)).toEqual([text(src)]);
  });

  test('после закрытого забора маркеры снова узнаются', () => {
    const fence = lines('```', '{{title}}', '```');
    expect(parse(`${fence}{{title}}\n`)).toEqual([
      text(fence),
      { kind: 'record', name: 'title', raw: '{{title}}\n' },
    ]);
  });

  test('закрытие короче открытия или другим символом забор не закрывает', () => {
    for (const [open, fake] of [
      ['````', '```'],
      ['~~~', '```'],
      ['```', '~~~'],
      ['```', '``` x'],
    ]) {
      const src = lines(open as string, 'код', fake as string, '{{title}}');
      expect(parse(src)).toEqual([text(src)]);
    }
  });

  test('незакрытый забор до конца тела — всё текст, контейнер не открывается', () => {
    const src = lines(
      'до',
      '```',
      '{{columns}}',
      '{{column}}',
      'x',
      '{{/column}}',
      '{{/columns}}',
      '{{title}}',
    );
    expect(parse(src)).toEqual([text(src)]);
    const src2 = '~~~\n{{tabs}}\n{{tab: A}}';
    expect(parse(src2)).toEqual([text(src2)]);
  });

  test('незакрытый забор внутри части съедает закрытия — контейнер не закрыт, текст цел', () => {
    const src = lines(
      '{{columns}}',
      '{{column}}',
      '```',
      '{{/column}}',
      '{{column}}',
      '{{/column}}',
      '{{/columns}}',
    );
    expect(parse(`до\n${src}`)).toEqual([text('до\n'), broken('CONTAINER_UNCLOSED', src)]);
  });

  test('закрытый забор внутри части — код части, контейнер цел', () => {
    const fence = lines('```', '{{/column}}', '{{/columns}}', '```');
    const src = `${lines('{{columns}}', '{{column}}')}${fence}${lines('{{/column}}', '{{column}}', '{{/column}}', '{{/columns}}')}`;
    expect(parse(src)).toEqual([{ kind: 'columns', parts: [[text(fence)], []], raw: src }]);
  });

  test('не забор: отступ 4 пробела, два символа, обратная кавычка в строке ```-забора', () => {
    for (const notFence of ['    ```', '``', '``` a`b', '\t```']) {
      expect(parse(lines(notFence, '{{title}}'))).toEqual([
        text(`${notFence}\n`),
        { kind: 'record', name: 'title', raw: '{{title}}\n' },
      ]);
    }
  });

  test('~~~-забор допускает обратную кавычку в строке сведений', () => {
    const src = lines('~~~ a`b', '{{title}}', '~~~');
    expect(parse(src)).toEqual([text(src)]);
  });
});

describe('\\r\\n и хвостовые пробелы у маркера (Фокус ревью п. 1)', () => {
  const crlf = (s: string) => s.replace(/\n/g, '\r\n');

  test('маркер с хвостовыми пробелами узнан; подпись без них', () => {
    const src = lines('{{tabs}}  ', '{{tab: Тред}}  ', 'x', '{{/tab}}\t', '{{/tabs}} ');
    expect(parse(src)).toEqual([
      { kind: 'tabs', parts: [{ label: 'Тред', children: [text('x\n')] }], raw: src },
    ]);
    expect(parse('{{title}}   \nx')).toEqual([
      { kind: 'record', name: 'title', raw: '{{title}}   \n' },
      text('x'),
    ]);
  });

  test('контейнер с \\r\\n внутри — то же дерево, raw и текст байт-в-байт', () => {
    const src = crlf(
      lines(
        'до',
        '{{columns}}  ',
        '{{column}}',
        'a',
        '{{/column}}',
        '{{column}}',
        '{{title}}',
        'b',
        '{{/column}}',
        '{{/columns}}',
        'после',
      ),
    );
    const box = src.slice(src.indexOf('{{columns}}'), src.indexOf('после'));
    expect(parse(src)).toEqual([
      text('до\r\n'),
      {
        kind: 'columns',
        parts: [
          [text('a\r\n')],
          [{ kind: 'record', name: 'title', raw: '{{title}}\r\n' }, text('b\r\n')],
        ],
        raw: box,
      },
      text('после\r\n'),
    ]);
  });

  test('broken на \\r\\n — raw байт-в-байт', () => {
    const bad = crlf(lines('{{tabs}}', '{{tab: A}} ', 'x', '{{/tabs}}'));
    const src = `a\r\n${bad}{{/tabs}}\r\nb`;
    expect(parse(src)).toEqual([
      text('a\r\n'),
      broken('PART_UNCLOSED', bad),
      broken('CLOSE_WITHOUT_OPEN', '{{/tabs}}\r\n'),
      text('b'),
    ]);
    const unclosed = crlf(lines('{{columns}}', '{{column}}', 'x'));
    expect(parse(unclosed)).toEqual([broken('CONTAINER_UNCLOSED', unclosed)]);
  });

  test('забор на \\r\\n тоже узнан', () => {
    const src = crlf(lines('```', '{{title}}', '```  ', '{{title}}'));
    expect(parse(src)).toEqual([
      text(crlf(lines('```', '{{title}}', '```  '))),
      { kind: 'record', name: 'title', raw: '{{title}}\r\n' },
    ]);
  });

  test('шаблон хоста на \\r\\n — дерево совпадает по форме с \\n-версией', () => {
    const lf = lines(
      '{{title}}',
      '{{tabs}}',
      '{{tab: Запись}}',
      '{{body}}',
      '{{/tab}}',
      '{{/tabs}}',
    );
    const shape = (nodes: PageNode[]) =>
      JSON.stringify(nodes, (k, v) => (k === 'raw' || k === 'text' ? undefined : v));
    expect(shape(parse(crlf(lf)))).toBe(shape(parse(lf)));
  });
});

describe('блок данных {{query:…}}', () => {
  test('многострочный {{query:\\naspect=orbis/task\\n}} — один узел, текст дословно', () => {
    const q = '{{query:\naspect=orbis/task\n}}';
    expect(parse(`до\n${q}\nпосле`)).toEqual([
      text('до\n'),
      { kind: 'query', text: '\naspect=orbis/task\n', raw: `${q}\n` },
      text('после'),
    ]);
  });

  test('{{query: без }} — текст, как сегодня bodySegments', () => {
    const src = 'до\n{{query:aspect=orbis/task\nпосле';
    expect(parse(src)).toEqual([text(src)]);
  });

  test('{{query:…}} не с начала строки — текст', () => {
    expect(parse('смотри {{query:a=1}} тут')).toEqual([text('смотри {{query:a=1}} тут')]);
  });

  test('хвост строки после }} — текст, повторная обёртка на той же строке блоком не считается', () => {
    expect(parse('{{query:a=1}} хвост\nдальше')).toEqual([
      { kind: 'query', text: 'a=1', raw: '{{query:a=1}}' },
      text(' хвост\nдальше'),
    ]);
    expect(parse('{{query:a=1}}{{query:b=2}}\n')).toEqual([
      { kind: 'query', text: 'a=1', raw: '{{query:a=1}}' },
      text('{{query:b=2}}\n'),
    ]);
  });

  test('хвостовые пробелы и \\r\\n после }} уходят в raw узла', () => {
    expect(parse('{{query:a=1}}  \r\nx')).toEqual([
      { kind: 'query', text: 'a=1', raw: '{{query:a=1}}  \r\n' },
      text('x'),
    ]);
  });

  test('блок данных внутри колонки и вкладки', () => {
    const src = lines(
      '{{tabs}}',
      '{{tab: A}}',
      '{{query:aspect=orbis/task, display=list}}',
      '{{/tab}}',
      '{{/tabs}}',
    );
    const [node] = parse(src);
    if (node?.kind !== 'tabs') throw new Error('ожидались вкладки');
    expect(node.parts[0]?.children).toEqual([
      {
        kind: 'query',
        text: 'aspect=orbis/task, display=list',
        raw: '{{query:aspect=orbis/task, display=list}}\n',
      },
    ]);
  });

  test('блок кончается на ПЕРВОМ }} — как токенайзер queryBlock, даже если это }} маркера', () => {
    expect(parse('{{query:\n{{title}}\n')).toEqual([
      { kind: 'query', text: '\n{{title', raw: '{{query:\n{{title}}\n' },
    ]);
  });

  test('строки внутри многострочного блока не сканируются: ``` в нём забор не открывает', () => {
    const q = '{{query:a=1\n```\n}}\n';
    expect(parse(`${q}{{title}}\n`)).toEqual([
      { kind: 'query', text: 'a=1\n```\n', raw: q },
      { kind: 'record', name: 'title', raw: '{{title}}\n' },
    ]);
  });
});

describe('разбор линейный на патологических телах', () => {
  // Порог щедрый: линейный разбор укладывается в единицы миллисекунд, а квадратичный на 50 тыс.
  // символов — в секунды. Узкий порог дал бы флак на медленной машине CI, широкий всё равно ловит.
  const timed = (src: string) => {
    const t = performance.now();
    const nodes = parsePageText(src);
    return { nodes, ms: performance.now() - t };
  };

  test.each([
    '{{tab:',
    '{{card:',
    '{{tab: x',
    '{{card: x',
  ])('%p + 50 тыс. пробелов без }} — быстро и текстом', (head) => {
    const src = head + ' '.repeat(50_000);
    const { nodes, ms } = timed(src);
    expect(nodes).toEqual([text(src)]);
    expect(ms).toBeLessThan(200);
  });

  // Числа замерены (фикс-раунд 1 задачи 8), а не выведены. Поиск `}}` у квадратичного варианта
  // идёт `indexOf` и потому быстр: отношение «квадратичный / линейный» растёт только с ЧИСЛОМ
  // строк `{{query:` (≈ 2,5·10⁻⁴·N), и порогу нужен вход, где оно ≥ 50. На 300 тыс. строк
  // линейный разбор — ≈ 100 мс (в 10 раз ниже порога; прежние 100 тыс. строк при пороге 200 мс
  // под нагрузкой полного прогона давали 243 мс — флак), квадратичный — ≈ 7,6 с (в 7,6 раза
  // выше порога и выше тайм-аута теста, то есть мутация краснеет в любом случае).
  test('300 тыс. строк {{query: без }} — быстро и текстом', () => {
    const src = '{{query:\n'.repeat(300_000);
    const { nodes, ms } = timed(src);
    expect(nodes).toEqual([text(src)]);
    expect(ms).toBeLessThan(1_000);
  });

  test('память о ближайшем }} не сбивает блоки: каждый блок кончается на своём }}', () => {
    expect(parse('{{query:a\n{{query:b}}\n{{query:c}}}\n{{query:d')).toEqual([
      { kind: 'query', text: 'a\n{{query:b', raw: '{{query:a\n{{query:b}}\n' },
      { kind: 'query', text: 'c', raw: '{{query:c}}' },
      text('}\n{{query:d'),
    ]);
  });
});

describe('инвариант «склейка = вход» на случайных телах', () => {
  /** mulberry32 — детерминированный генератор: упавший случай воспроизводится сидом. */
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const FRAGMENTS = [
    '{{columns}}',
    '{{/columns}}',
    '{{column}}',
    '{{/column}}',
    '{{tabs}}',
    '{{/tabs}}',
    '{{tab: Запись}}',
    '{{tab}}',
    '{{/tab}}',
    '{{tab:  }}',
    '{{title}}',
    '{{body}}',
    '{{thread}}',
    '{{card: orbis/goal}}',
    '{{card: "Цель"}}',
    '{{query:aspect=orbis/task}}',
    '{{query:',
    '}}',
    'aspect=orbis/goal',
    '```',
    '~~~',
    '````',
    '```ts',
    '    ```',
    'текст',
    '- пункт',
    '> цитата',
    '<div>html</div>',
    '  {{title}}',
    'x {{title}} y',
    '{{unknown}}',
    '{{/tab: x}}',
    '',
    ' ',
    '\t',
    '{{columns}}  ',
    '{{/column}} \t',
  ];
  const SEPARATORS = ['\n', '\r\n', '  \n', '\n\n', '\r\n\r\n', '', ' ', '\r'];

  const genBody = (r: () => number): string => {
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
    // Половина тел — почти правильные контейнеры с шумом: иначе случайная каша почти никогда не
    // собирает законный контейнер, и ветка «успешный разбор» осталась бы непроверенной.
    const box = (depth: number): string => {
      const cols = r() < 0.5;
      const n = cols ? 1 + Math.floor(r() * 5) : Math.floor(r() * 10);
      let s = cols ? '{{columns}}' : '{{tabs}}';
      for (let i = 0; i < n; i++) {
        s += pick(SEPARATORS) + (cols ? '{{column}}' : `{{tab: ${i}}}`);
        const inner = Math.floor(r() * 4);
        for (let k = 0; k < inner; k++) {
          s += pick(['\n', '\r\n']) + (depth < 3 && r() < 0.25 ? box(depth + 1) : pick(FRAGMENTS));
        }
        s +=
          pick(['\n', '\r\n', '\n\n']) +
          (r() < 0.95 ? (cols ? '{{/column}}' : '{{/tab}}') : pick(FRAGMENTS));
      }
      return s + pick(['\n', '\r\n']) + (r() < 0.95 ? (cols ? '{{/columns}}' : '{{/tabs}}') : '');
    };
    const count = Math.floor(r() * 30);
    let body = '';
    for (let i = 0; i < count; i++) {
      body += (r() < 0.2 ? box(1) : pick(FRAGMENTS)) + pick(SEPARATORS);
    }
    return body;
  };

  /** Каждый узел любой глубины обязан быть подстрокой входа — дерево не выдумывает текст. */
  const walk = (nodes: PageNode[], src: string, seen: Set<string>) => {
    for (const n of nodes) {
      seen.add(n.kind);
      expect(src.includes(n.kind === 'text' ? n.text : n.raw)).toBe(true);
      if (n.kind === 'columns') for (const p of n.parts) walk(p, src, seen);
      if (n.kind === 'tabs') for (const p of n.parts) walk(p.children, src, seen);
    }
  };

  test('600 тел на фиксированном сиде: не бросает, склейка верхнего уровня = вход', () => {
    const r = rng(20260925);
    const seen = new Set<string>();
    const codes = new Set<string>();
    for (let i = 0; i < 600; i++) {
      const src = genBody(r);
      let nodes: PageNode[] = [];
      expect(() => {
        nodes = parsePageText(src);
      }).not.toThrow();
      if (glue(nodes) !== src)
        throw new Error(`склейка разошлась со входом на случае ${i}: ${JSON.stringify(src)}`);
      walk(nodes, src, seen);
      for (const n of nodes) if (n.kind === 'broken') codes.add(n.code);
    }
    // Генератор не холостой: встречаются все виды узлов и заметная часть кодов ошибок.
    expect([...seen].sort()).toEqual([
      'broken',
      'card',
      'columns',
      'query',
      'record',
      'tabs',
      'text',
    ]);
    expect(codes.size).toBeGreaterThanOrEqual(6);
  });
});

describe('листовость модуля', () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
  const IMPORT_RE = /^\s*import\b/m;
  const REEXPORT_RE = /^\s*export\b[^;]*\bfrom\s*['"]/m;
  const DYNAMIC_RE = /\brequire\s*\(|\bimport\s*\(/;

  test('исходник page-grammar.ts не импортирует ничего', () => {
    // Строже, чем у diff.ts: здесь нет даже типовых импортов. Модуль читают первый кадр записи и
    // рендерер экрана, и любой импорт — кандидат протащить tiptap или marked в эагерный чанк.
    const src = read('./page-grammar.ts');
    expect(src).not.toMatch(IMPORT_RE);
    // Реэкспорт тянет модуль так же, как импорт: `export { parseBody } from './convert'` протащил
    // бы схему Tiptap, не написав ни одного `import` (поймано ревью: прежний сторож молчал).
    expect(src).not.toMatch(REEXPORT_RE);
    expect(src).not.toMatch(DYNAMIC_RE);
    // Положительный контроль: те же регэкспы срабатывают на тяжёлом соседе и на образцах —
    // иначе зелёный сторож мог бы значить лишь сломанный регэксп.
    expect(read('./convert.ts')).toMatch(IMPORT_RE);
    expect(read('./index.ts')).toMatch(REEXPORT_RE);
    expect("export { parseBody } from './convert';").toMatch(REEXPORT_RE);
    expect("export * from './convert'").toMatch(REEXPORT_RE);
    expect("const m = await import ('./convert');").toMatch(DYNAMIC_RE);
    expect("require('./convert')").toMatch(DYNAMIC_RE);
  });

  test('сабпат @orbis/shared/doc/page-grammar объявлен в exports', () => {
    const pkg = JSON.parse(read('../../package.json')) as { exports: Record<string, string> };
    expect(pkg.exports['./doc/page-grammar']).toBe('./src/doc/page-grammar.ts');
  });
});
