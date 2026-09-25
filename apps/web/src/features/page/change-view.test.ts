/**
 * «Изменить вид только этой записи» — чистая часть (спека страниц 1а §8.4, Р-19, РП-29, Э-13).
 *
 * Три случая судьбы текста записи; молча ничего не дописывается и не убирается (С1а-8). Сверки —
 * байт-в-байт: страница после действия обязана выглядеть как запись до него, а любой лишний или
 * пропавший символ шаблона — это другая раскладка.
 */
import { parsePageText } from '@orbis/shared/doc/page-grammar';
import { describe, expect, test } from 'vitest';
import { changeViewPlan, TEXT_BEFORE_VIEW_CHANGE } from './change-view';
import { HOST_TEMPLATE_TEXT } from './host-template';

/** Есть ли в дереве блок `{{body}}` на любой глубине — на странице он был бы плашкой (§5.5). */
const hasBodyBlock = (text: string): boolean => {
  const visit = (nodes: ReturnType<typeof parsePageText>): boolean =>
    nodes.some((n) =>
      n.kind === 'record'
        ? n.name === 'body'
        : n.kind === 'columns'
          ? n.parts.some(visit)
          : n.kind === 'tabs'
            ? n.parts.some((t) => visit(t.children))
            : false,
    );
  return visit(parsePageText(text));
};

test('подпись закреплённой версии — дословно из спеки §8.4', () => {
  expect(TEXT_BEFORE_VIEW_CHANGE).toBe('Текст до изменения вида');
});

describe('случай 1: текста у записи нет — только копия шаблона', () => {
  test('пустое тело → шаблон хоста БЕЗ строки {{body}}, остальное дословно (РП-29)', () => {
    const plan = changeViewPlan(HOST_TEMPLATE_TEXT, '');
    expect(plan).toEqual({ case: 1, body: HOST_TEMPLATE_TEXT.replace('{{body}}\n', '') });
    expect(hasBodyBlock(plan.case === 1 ? plan.body : '')).toBe(false);
  });

  test('тело из одних пробелов и переносов — тоже «текста нет»', () => {
    expect(changeViewPlan(HOST_TEMPLATE_TEXT, '  \n\t\n ')).toEqual({
      case: 1,
      body: HOST_TEMPLATE_TEXT.replace('{{body}}\n', ''),
    });
  });

  test('шаблон без {{body}} → копия шаблона как есть', () => {
    const tpl = '{{title}}\n{{cards}}\n';
    expect(changeViewPlan(tpl, '')).toEqual({ case: 1, body: tpl });
  });

  test('{{body}} между двумя кусками текста → на его месте пустая строка: абзацы не слипаются', () => {
    // Через шаблон «Вступление» и «Итог» — два отдельных куска текста; склеенные переносом, они
    // стали бы одним абзацем, то есть другим видом.
    expect(changeViewPlan('Вступление\n{{body}}\nИтог\n', '')).toEqual({
      case: 1,
      body: 'Вступление\n\nИтог\n',
    });
    // Пустая строка уже есть с одной стороны — добавлять нечего.
    expect(changeViewPlan('Вступление\n\n{{body}}\nИтог\n', '')).toEqual({
      case: 1,
      body: 'Вступление\n\nИтог\n',
    });
  });
});

describe('случай 2: текст есть, в шаблоне есть {{body}} — текст на его место', () => {
  test('тело «Заметка» и шаблон хоста → строка {{body}} заменена, остальное байт-в-байт', () => {
    const plan = changeViewPlan(HOST_TEMPLATE_TEXT, 'Заметка');
    expect(plan).toEqual({ case: 2, body: HOST_TEMPLATE_TEXT.replace('{{body}}', 'Заметка') });
  });

  test('{{body}} внутри вкладки заменяется там же — текст остаётся на вкладке «Запись»', () => {
    const plan = changeViewPlan(HOST_TEMPLATE_TEXT, 'Заметка');
    if (plan.case !== 2) throw new Error('ожидался случай 2');
    const tabs = parsePageText(plan.body).find((n) => n.kind === 'tabs');
    if (tabs?.kind !== 'tabs') throw new Error('вкладки пропали');
    expect(tabs.parts[0]?.label).toBe('Запись');
    expect(tabs.parts[0]?.children.at(-1)).toEqual({ kind: 'text', text: 'Заметка\n' });
    expect(hasBodyBlock(plan.body)).toBe(false);
  });

  test('{{body}} в колонке внутри вкладки (вторая глубина) — там же', () => {
    const tpl = [
      '{{tabs}}',
      '{{tab: Главное}}',
      '{{columns}}',
      '{{column}}',
      'Слева',
      '',
      '{{body}}',
      '{{/column}}',
      '{{column}}',
      'Справа',
      '{{/column}}',
      '{{/columns}}',
      '{{/tab}}',
      '{{/tabs}}',
      '',
    ].join('\n');
    expect(changeViewPlan(tpl, 'Мой текст\nвторая строка\n')).toEqual({
      case: 2,
      body: tpl.replace('{{body}}\n', 'Мой текст\nвторая строка\n'),
    });
  });

  test('тело с переносом в конце не даёт лишней пустой строки', () => {
    expect(changeViewPlan(HOST_TEMPLATE_TEXT, 'Заметка\n')).toEqual({
      case: 2,
      body: HOST_TEMPLATE_TEXT.replace('{{body}}', 'Заметка'),
    });
  });

  test('{{body}} последней строкой без переноса — текст встаёт как есть', () => {
    expect(changeViewPlan('{{title}}\n{{body}}', 'Заметка')).toEqual({
      case: 2,
      body: '{{title}}\nЗаметка',
    });
  });

  test('{{body}} между кусками текста — текст отделён пустыми строками, абзацы не слипаются', () => {
    expect(changeViewPlan('Вступление\n{{body}}\nИтог\n', 'Заметка')).toEqual({
      case: 2,
      body: 'Вступление\n\nЗаметка\n\nИтог\n',
    });
  });

  test('пустые строки между вкладками — адрес {{body}} считается по исходнику, не по дереву', () => {
    // Пустые строки между частями контейнера в дерево не попадают; адрес `{{body}}` во второй
    // вкладке обязан их учесть, иначе замена съехала бы на чужую строку.
    const tpl =
      '{{tabs}}\n\n{{tab: А}}\n{{body}}x\n{{/tab}}\n\n\n{{tab: Б}}\n{{title}}\n{{body}}\n{{/tab}}\n\n{{/tabs}}\n{{thread}}\n';
    expect(changeViewPlan(tpl, 'Заметка')).toEqual({
      case: 2,
      body: tpl.replace('{{body}}\n', 'Заметка\n'),
    });
  });
});

describe('случай 3: текст есть, а шаблон тело не показывает — выбор владельца', () => {
  test('hideAsVersion = шаблон, showBelow = шаблон + пустая строка + текст записи', () => {
    const tpl = '{{title}}\n{{cards}}\n';
    expect(changeViewPlan(tpl, 'Заметка')).toEqual({
      case: 3,
      hideAsVersion: tpl,
      showBelow: '{{title}}\n{{cards}}\n\nЗаметка',
    });
  });

  test('шаблон без переноса в конце — пустая строка всё равно одна', () => {
    expect(changeViewPlan('{{title}}', 'Заметка')).toEqual({
      case: 3,
      hideAsVersion: '{{title}}',
      showBelow: '{{title}}\n\nЗаметка',
    });
  });

  test('{{body}} внутри забора кода — текст, а не блок: тело шаблон не показывает', () => {
    const tpl = '{{title}}\n```\n{{body}}\n```\n';
    expect(changeViewPlan(tpl, 'Заметка').case).toBe(3);
  });

  test('{{body}} внутри сломанного контейнера не рисуется — тело шаблон не показывает', () => {
    const tpl = '{{columns}}\n{{column}}\n{{body}}\n{{/column}}\n';
    expect(changeViewPlan(tpl, 'Заметка').case).toBe(3);
  });
});
