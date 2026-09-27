/**
 * Шаблон хоста — эталон поставки (спека 1б §8.5, §9.2; С1б-9): текст спеки 1а §8.1 с одной заменой
 * и без единой проблемы тела (§5.8 1а).
 *
 * ПОЧЕМУ СПЕКА 1а НЕ ПРАВИТСЯ (решение владельца 27.09, Э-21). Спека 1а — документ исполненного и
 * выкаченного среза: её §8.1 — текст шаблона хоста 1а, каким он ушёл в прод. Эталон 1б — тот же блок
 * с ОДНОЙ заменой по спеке 1б §8.5: пять строк `{{card: …}}` вкладки «Запись» → одна `{{cards: own}}`.
 * Преобразование живёт здесь, в единственном тесте, читающем спеку 1а, — а не правкой её текста:
 * переписанная под следующий срез спека перестала бы говорить, что было выкачено.
 *
 * Три сверки, и ни одна не заменяет другую. Литерал — ЧТО поставлено: правка эталона без правки
 * теста краснеет здесь. Блок спеки 1а через замену — ОТКУДА текст: литерал, переписанный вместе с
 * кодом, разошёлся бы со спекой молча. «Ни одного id аспекта расширения» — ЗАЧЕМ замена (С1б-9):
 * шаблон хоста не называет расширений, и эта проверка краснеет на возвращённой `{{card: orbis/goal}}`
 * независимо от того, что написано в спеке.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BUILTIN_ASPECT_DEFS } from '@orbis/shared';
import { bodyIssues } from '@orbis/shared/doc/placement';
import { HOST_TEMPLATE_ETALON_TEXT } from '@orbis/shared/supply';
import { expect, test } from 'vitest';
import { buildQueryRegistry } from '../../lib/query-blocks/catalog';
import { BUILTIN_REGISTRY } from '../../test/registry';
import { HOST_TEMPLATE_NODES, HOST_TEMPLATE_TEXT } from './host-template';

const ETALON_LINES = [
  '{{title}}',
  '{{tags}}',
  '{{tabs}}',
  '{{tab: Запись}}',
  '{{cards: own}}',
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
];

/**
 * Замена спеки 1б §8.5 над блоком спеки 1а §8.1: подряд идущие строки `{{card: …}}` вкладки
 * «Запись» — одной `{{cards: own}}`. Строго пять и строго подряд: иначе блок спеки 1а — не тот, на
 * котором замена определена, и тест обязан сказать об этом, а не заменить что-то похожее.
 */
function to1b(block1a: string): string {
  const lines = block1a.split('\n');
  const first = lines.findIndex((l) => l.startsWith('{{card: '));
  const run = lines.slice(first).findIndex((l) => !l.startsWith('{{card: '));
  expect(first, 'в блоке §8.1 спеки 1а нет строк {{card: …}}').toBeGreaterThan(-1);
  expect(run, 'строк {{card: …}} подряд — не пять').toBe(5);
  return [...lines.slice(0, first), '{{cards: own}}', ...lines.slice(first + run)].join('\n');
}

test('HOST_TEMPLATE_TEXT — реэкспорт эталона поставки, а не своя копия (гейт 11)', () => {
  expect(HOST_TEMPLATE_TEXT).toBe(HOST_TEMPLATE_ETALON_TEXT);
});

test('HOST_TEMPLATE_TEXT побайтно равен литералу эталона 1б', () => {
  expect(HOST_TEMPLATE_TEXT).toBe(ETALON_LINES.join('\n'));
});

test('HOST_TEMPLATE_TEXT — блок §8.1 спеки 1а после замены §8.5 спеки 1б', () => {
  // vitest запускается из apps/web; спека — в корне репозитория.
  const spec = readFileSync(
    resolve(process.cwd(), '../../docs/superpowers/specs/2026-09-23-pages-slice-1a-design.md'),
    'utf8',
  );
  const section = spec.slice(spec.indexOf('### 8.1'));
  const block = /```\n([\s\S]*?)\n```/.exec(section)?.[1];
  expect(block).toBeDefined();
  expect(to1b(block as string)).toBe(HOST_TEMPLATE_TEXT);
});

test('в тексте шаблона хоста ни одного id аспекта расширения (С1б-9)', () => {
  const extensionAspects = BUILTIN_ASPECT_DEFS.filter((a) => a.module !== null).map((a) => a.key);
  // Проба средства: расширения у встроенных аспектов есть — пустой список сделал бы сверку вакуумной.
  expect(extensionAspects).toEqual(expect.arrayContaining(['orbis/goal', 'orbis/financial']));
  expect(extensionAspects.filter((key) => HOST_TEMPLATE_TEXT.includes(key))).toEqual([]);
});

test('шаблон хоста разбирается без единой проблемы тела шаблона', () => {
  expect(
    bodyIssues(HOST_TEMPLATE_NODES, 'template', buildQueryRegistry(BUILTIN_REGISTRY).parse),
  ).toEqual([]);
  // Один узел верхнего уровня на строку заголовка и тегов и один контейнер вкладок — не текст:
  // «дословно» не значит «разобрано как текст».
  expect(HOST_TEMPLATE_NODES.map((n) => n.kind).filter((k) => k !== 'text')).toEqual([
    'record',
    'record',
    'tabs',
  ]);
  // Свои карточки — узлом `ownCards` первой вкладки, а не текстом.
  const [tabs] = HOST_TEMPLATE_NODES.filter((n) => n.kind === 'tabs');
  const first = tabs?.kind === 'tabs' ? tabs.parts[0]?.children : undefined;
  expect(first?.map((n) => n.kind).filter((k) => k !== 'text')).toEqual(['ownCards', 'record']);
});
