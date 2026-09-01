// bun:test, как ВЕСЬ пакет shared: у него "test": "bun test", и файл на vitest уронил бы
// корневой прогон. Реестр — фикстурный (`@orbis/shared/query/fixtures`), а не серверный: shared
// от server не зависит (И17), а привязке хватает словарей по id.
import { describe, expect, test } from 'bun:test';
import { type ParseRegistry, printQueryAst, type QueryAst } from '../query';
import { FIXTURE_PARSE_REGISTRY as REG } from '../query/ast-fixtures';
import { bindQueryBlocks } from './bind-query';
import { parseBody, queryRefsFromDoc, readBodyDoc, serializeBody } from './convert';
import { diffBodyDocs } from './diff';
import { DOC_SCHEMA_VERSION } from './types';

const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';

/** Первый query-блок документа — все проверки ниже про один блок. */
function block(doc: BodyLike): { ast: QueryAst | null; text: string } {
  const node = (doc.doc.content ?? []).find((n) => n.type === 'queryBlock');
  if (node === undefined) throw new Error('в документе нет query-блока');
  const attrs = (node.attrs ?? {}) as { ast?: unknown; text?: unknown };
  return {
    ast: (attrs.ast ?? null) as QueryAst | null,
    text: typeof attrs.text === 'string' ? attrs.text : '',
  };
}
type BodyLike = { v: number; doc: { content?: Array<{ type?: string; attrs?: unknown }> } };

const bound = (md: string) => bindQueryBlocks(parseBody(md), REG) as unknown as BodyLike;

describe('bindQueryBlocks — привязка блока к реестру (Р-21-1)', () => {
  test('текст блока превращается в ast по реестру; опечатка оставляет блок неразобранным', () => {
    const ok = block(bound('{{query: aspect=orbis/task, status=inbox}}'));
    expect(ok.ast).not.toBeNull();
    // Не «просто не null»: дерево обязано нести именно то, что написано в блоке.
    expect(JSON.stringify(ok.ast)).toContain('orbis/task_status');

    // Опечатка в имени конструкции — блок остаётся текстом, и текст остаётся ИСХОДНЫМ:
    // потерять написанное владельцем хуже, чем показать ему отказ разбора.
    const bad = block(bound('{{query: aspekt=orbis/task}}'));
    expect(bad.ast).toBeNull();
    expect(bad.text).toBe(' aspekt=orbis/task');
  });

  test('инвариант формы: ast !== null ⟹ text — key-форма ЭТОГО ast; ast === null ⟹ text исходный', () => {
    const ok = block(bound('{{query: aspect=orbis/task, status=inbox}}'));
    if (ok.ast === null) throw new Error('блок обязан был разобраться');
    expect(ok.text).toBe(printQueryAst(ok.ast, REG, 'key'));
    // Обратная сторона инварианта: печать УЖЕ не равна исходной строке — старое имя `status`
    // приведено к key-форме, и именно это делает дифф нечувствительным к переименованиям.
    expect(ok.text).not.toBe(' aspect=orbis/task, status=inbox');

    const bad = block(bound('{{query: aspekt=orbis/task}}'));
    expect(bad.ast).toBeNull();
    expect(bad.text).toBe(' aspekt=orbis/task');
  });

  test('привязка идемпотентна: второй проход не двигает ни ast, ни text', () => {
    const once = bindQueryBlocks(parseBody('{{query: aspect=orbis/task, status=inbox}}'), REG);
    const twice = bindQueryBlocks(once, REG);
    expect(twice).toEqual(once);
    // Документ без блоков не пересобирается вовсе — иначе каждое чтение давало бы новый
    // объект, и `readBodyDoc` перестал бы отдавать ВХОД (блочные id UniqueID).
    const plain = parseBody('просто текст');
    expect(bindQueryBlocks(plain, REG)).toBe(plain);
  });

  test('пустой блок НЕ становится «все сущности владельца» (Р-21-8)', () => {
    // `parseQueryAst('')` отвечает `{filter: null}` — законным деревом «весь корпус
    // владельца». Молча превратить пустую заготовку в такой запрос значило бы сменить смысл
    // блока при обновлении: сегодня он отвечает отказом `min(1)`, а не всем графом.
    for (const md of ['{{query:}}', '{{query:   }}', '{{query:\n   }}']) {
      const empty = block(bound(md));
      expect(empty.ast).toBeNull();
    }
    // Контроль: непустой блок с теми же пробелами вокруг разбирается.
    expect(block(bound('{{query:  aspect=orbis/task  }}')).ast).not.toBeNull();
  });

  test('значение с `}}` квотируется печатью и не рвёт тело (Р-21-3)', () => {
    // Барьер `}}` — конец ОБЁРТКИ разметки, а не правило грамматики. С деревом в атрибуте
    // барьер остался бы без держателя: печать вернула бы `title=a}}b`, токенайзер закрыл бы
    // блок на первом `}}`, и хвост запроса уехал бы прозой.
    const ast: QueryAst = { filter: null, title: 'a}}b' };
    const doc = bindQueryBlocks(
      {
        v: DOC_SCHEMA_VERSION,
        doc: { type: 'doc', content: [{ type: 'queryBlock', attrs: { ast, text: '' } }] },
      },
      REG,
    );
    const printed = block(doc as unknown as BodyLike).text;
    expect(printed).not.toContain('}}');

    // Круг «печать → markdown → разбор → привязка» возвращает ТО ЖЕ дерево.
    const md = serializeBody(doc);
    expect(md).not.toContain('a}}b');
    expect(block(bound(md)).ast).toEqual(ast);
  });

  test('key-форма, которую всё же нельзя уложить в обёртку, оставляет блок неразобранным', () => {
    // Единственный оставшийся источник `}}` в печати — НЕРЕЗОЛВЕННЫЙ id (печать тотальна и
    // печатает такой id как есть, `print.ts`). Уложить его в `{{…}}` нечем, поэтому дерево
    // не сохраняется: порванное тело хуже неразобранного блока.
    const ast = { filter: { prop: 'x}}y', op: 'eq', value: 1 } } as unknown as QueryAst;
    const doc = bindQueryBlocks(
      {
        v: DOC_SCHEMA_VERSION,
        doc: {
          type: 'doc',
          content: [{ type: 'queryBlock', attrs: { ast, text: ' старый текст' } }],
        },
      },
      REG,
    );
    const got = block(doc as unknown as BodyLike);
    expect(got.ast).toBeNull();
    expect(got.text).toBe(' старый текст');
  });

  test('слишком глубокое дерево в атрибуте отвергается ДО схемы, а не роняет стек (пятый вход дерева)', () => {
    // Сторож ПЯТОГО входа дерева (сам вход помечен в `doc/bind-query.ts`; пометку здесь не
    // повторяем — счётный греп в докблоке `query/ast.ts` считает ТОЛЬКО места в коде, и
    // пометка в названии теста ломала бы его же правило).
    // `queryAstSchema` рекурсивна через `z.lazy`: достаточно глубокий вход исчерпывает стек
    // ВНУТРИ собственного разбора, и `safeParse` этого не ловит — `RangeError` летит наружу.
    // Поэтому глубина меряется явным обходом ДО схемы, ровно как у остальных входов дерева.
    // Глубина ~5000 узлов: втрое с лишним больше капа в уровнях JSON и заведомо больше, чем
    // выдержит рекурсия.
    let deep: unknown = { tag: 'дно' };
    for (let i = 0; i < 5000; i++) deep = { not: deep };
    const doc = bindQueryBlocks(
      {
        v: DOC_SCHEMA_VERSION,
        doc: {
          type: 'doc',
          content: [{ type: 'queryBlock', attrs: { ast: { filter: deep }, text: ' tags=дом' } }],
        },
      },
      REG,
    );
    // Дерево отвергнуто, ТЕКСТ разобран заново — привязка не упала и данные целы.
    const got = block(doc as unknown as BodyLike);
    expect(JSON.stringify(got.ast)).toContain('дом');
  });

  test('битое дерево в атрибуте отвергается формой, а не доезжает до печати', () => {
    // `bodyDocError` спрашивает у схемы ProseMirror, а attrs там — произвольный JSON: `{}`
    // вместо дерева проходит проверку документа и падал бы уже в `printQueryAst`.
    const doc = bindQueryBlocks(
      {
        v: DOC_SCHEMA_VERSION,
        doc: {
          type: 'doc',
          content: [{ type: 'queryBlock', attrs: { ast: { мусор: 1 }, text: ' tags=дом' } }],
        },
      },
      REG,
    );
    // Дерево выброшено, а ТЕКСТ разобран заново — данные не потеряны.
    const got = block(doc as unknown as BodyLike);
    expect(got.ast).not.toBeNull();
    expect(JSON.stringify(got.ast)).toContain('дом');
  });
});

describe('queryRefsFromDoc — индекс адресов, названных блоками', () => {
  test('блок с orbis/task_status и children_of=<uuid> — refs несут оба', () => {
    const doc = bound(`{{query: aspect=orbis/task, status=inbox, children_of=${UUID}}}`);
    const refs = queryRefsFromDoc(doc as never);
    expect(refs).toContain('orbis/task_status');
    expect(refs).toContain('orbis/task');
    expect(refs).toContain(UUID);
  });

  test('неразобранный блок в индекс не попадает, и это названо вслух', () => {
    // Регэксп по тексту здесь второй правдой быть не может: индекс несёт id ДЕРЕВА, а текст
    // неразобранного блока имён реестра не содержит по построению (он и не разобрался).
    expect(queryRefsFromDoc(bound('{{query: aspekt=orbis/task}}') as never)).toEqual([]);
    expect(queryRefsFromDoc(parseBody('просто текст') as never)).toEqual([]);
  });

  test('uuid ПРИВОДИТСЯ К НИЖНЕМУ РЕГИСТРУ: сравнение text[] в PG регистрозависимо', () => {
    // Дерево несёт uuid ровно так, как его набрал владелец (`children_of=0F8F…` разбор не
    // трогает — проверено пробой и закреплено стражем вакуумности ниже). Индекс же читают
    // сравнением `query_refs @> ARRAY[<id из БД>]`, а id в БД — канонический нижний регистр:
    // не приведи здесь — и держатель молча выпал бы из выдачи, а регрессия не покраснела бы
    // нигде (все серверные фикстуры в нижнем регистре, различить их нечем).
    const upper = UUID.toUpperCase();
    const doc = bound(`{{query: children_of=${upper}}}`);
    // Страж вакуумности: приведение делает ИНДЕКС, а не разбор — в дереве регистр исходный.
    expect(JSON.stringify(block(doc).ast)).toContain(upper);
    expect(queryRefsFromDoc(doc as never)).toEqual([UUID]);
  });

  test('`this` в индекс не едет: это не адрес, а контекст исполнения', () => {
    const refs = queryRefsFromDoc(bound('{{query: children_of=this}}') as never);
    expect(refs).not.toContain('this');
  });
});

describe('дифф Ш1 меряет key-формой: подпись реестра на блок не влияет', () => {
  /** Тот же реестр, но с ДРУГОЙ подписью `orbis/task_status`. Различаются ровно подписи. */
  function withLabel(label: string): ParseRegistry {
    const properties = new Map(REG.properties);
    const def = properties.get('orbis/task_status');
    if (def === undefined) throw new Error('в фикстурном реестре нет orbis/task_status');
    properties.set('orbis/task_status', { ...def, label: { ...def.label, ru: label } });
    return { ...REG, properties };
  }

  test('переименование подписи свойства блок НЕ трогает — при том же документе', () => {
    // Тавтологии здесь быть не должно: сравниваются НЕ два одинаковых дерева, а результаты
    // привязки ОДНОГО текста ДВУМЯ реестрами, различающимися подписью. Печатай привязка
    // label-форму — `text` разошёлся бы, и переименование свойства в реестре приезжало бы
    // владельцу правкой его тела.
    const md = 'Заголовок\n\n{{query: aspect=orbis/task, status=inbox}}';
    const before = bindQueryBlocks(parseBody(md), withLabel('Статус'));
    const after = bindQueryBlocks(parseBody(md), withLabel('Состояние задачи'));

    // Страж вакуумности: реестры И ПРАВДА разные — label-печать одного и того же дерева их
    // различает. Без него «дифф молчит» было бы правдой и на двух одинаковых реестрах.
    const ast = block(before as unknown as BodyLike).ast;
    if (ast === null) throw new Error('блок обязан был разобраться');
    expect(printQueryAst(ast, withLabel('Статус'), 'label')).not.toBe(
      printQueryAst(ast, withLabel('Состояние задачи'), 'label'),
    );

    const result = diffBodyDocs(before.doc, after.doc);
    if ('skipped' in result) throw new Error(`дифф отказал: ${result.skipped}`);
    expect(result.units.map((u) => u.kind)).toEqual(['same', 'same']);
  });
});

describe('readBodyDoc: конверсия v1 → v2 по дереву', () => {
  const v1 = (content: unknown[]) => ({ v: 1, doc: { type: 'doc', content } });

  test('тело без query-блоков: v1 → v2 без потери содержимого и блочных id (Т8-в)', () => {
    const stored = v1([
      { type: 'paragraph', attrs: { id: 'блок-1' }, content: [{ type: 'text', text: 'привет' }] },
    ]);
    const got = readBodyDoc(stored, 'совсем другое тело', REG);
    expect(got.v).toBe(DOC_SCHEMA_VERSION);
    expect(got.doc).toEqual(stored.doc as never);
  });

  test('query-блок v1 приезжает с ast, а не пустым', () => {
    const stored = v1([
      { type: 'queryBlock', attrs: { id: 'блок-2', query: ' aspect=orbis/task, status=inbox' } },
    ]);
    const got = readBodyDoc(stored, '', REG) as unknown as BodyLike;
    expect(got.v).toBe(DOC_SCHEMA_VERSION);
    const b = block(got);
    expect(b.ast).not.toBeNull();
    if (b.ast === null) throw new Error('недостижимо');
    expect(b.text).toBe(printQueryAst(b.ast, REG, 'key'));
    // Блочный id — то, ради чего конверсия идёт ПО ДЕРЕВУ, а не пересборкой из markdown.
    const node = (got.doc.content ?? [])[0] as { attrs?: Record<string, unknown> };
    expect(node.attrs?.id).toBe('блок-2');
    // Старого имени атрибута не остаётся: иначе слияние свойств и дифф видели бы две правды.
    expect(node.attrs?.query).toBeUndefined();
  });

  test('версия из будущего и битая форма по-прежнему пересобираются из body', () => {
    for (const bad of [{ v: 999, doc: { type: 'doc' } }, { v: 1, doc: 'мусор' }, null]) {
      const rebuilt = readBodyDoc(bad, '# Заголовок', REG);
      expect(rebuilt.v).toBe(DOC_SCHEMA_VERSION);
      expect(JSON.stringify(rebuilt.doc)).toContain('heading');
    }
  });

  test('пересборка из body тоже привязана: блок из markdown приезжает с ast', () => {
    const got = readBodyDoc(null, '{{query: aspect=orbis/task}}', REG) as unknown as BodyLike;
    expect(block(got).ast).not.toBeNull();
  });
});
