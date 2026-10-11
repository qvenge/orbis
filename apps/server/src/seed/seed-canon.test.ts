// Сиды живут здесь, а не в shared: тест сидов — единственная точка, где нужны оба мира,
// и импортировать server из shared было бы инверсией слоёв (ревью И17).
import { describe, expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
import { bindQueryBlocks, canonicalizeBody, parseBody, serializeBody } from '@orbis/shared/doc';
import { parsePageText } from '@orbis/shared/doc/page-grammar';
import { parseQueryAst } from '@orbis/shared/query';
import { FIXTURE_PARSE_REGISTRY } from '@orbis/shared/query/fixtures';
import type { JSONContent } from '@tiptap/core';
import { projectBodyTemplate } from './project-body';
import {
  AGENDA_BODY,
  ALL_TASKS_BODY,
  DAILY_PLANNING_BODY,
  HORIZON_LIFE_BODY,
  HORIZON_YEAR_BODY,
  ROUTINES_LIST_BODY,
  UPCOMING_BODY,
} from './smart-lists';

const SEEDS: Array<[string, string]> = [
  ['Daily Planning', DAILY_PLANNING_BODY],
  ['Повестка', AGENDA_BODY],
  // Эталон 1б снятого ключа (срез 1в §6.3): поставкой не несётся, но лежит печатью в записях 1б, и
  // «Вернуть как было» кладёт его в тело — канон обязан держать и его.
  ['Upcoming (снята с поставки)', UPCOMING_BODY],
  ['All Tasks', ALL_TASKS_BODY],
  ['Горизонт «Год»', HORIZON_YEAR_BODY],
  ['Горизонт «Жизнь»', HORIZON_LIFE_BODY],
  ['Рутины', ROUTINES_LIST_BODY],
  // Заготовка проекта сеется другим путём (executor, а не онбординг), но проходит через тот
  // же конвейер тела — и потому обязана держать тот же инвариант.
  ['Заготовка проекта', projectBodyTemplate(newId())],
];

/** Атрибуты всех query-блоков документа, по порядку. */
function queryBlocks(doc: JSONContent): Array<{ ast: unknown; text: unknown }> {
  const out: Array<{ ast: unknown; text: unknown }> = [];
  const walk = (node: JSONContent | undefined): void => {
    if (!node) return;
    if (node.type === 'queryBlock') {
      out.push({ ast: node.attrs?.ast ?? null, text: node.attrs?.text ?? null });
    }
    for (const child of node.content ?? []) walk(child);
  };
  walk(doc);
  return out;
}

describe('сиды — канонические и в key-форме', () => {
  for (const [name, body] of SEEDS) {
    test(`${name}: канон равен телу байт-в-байт, raw нет`, () => {
      // «Байт-в-байт» остаётся приёмкой ДЛЯ СИДОВ — потому что они уже канон (вердикт Б1),
      // а не потому что конвертер обязан сохранять любую форму. Инвариант §3.3 PRD цел.
      expect(canonicalizeBody(body).body).toBe(body);
      expect(JSON.stringify(parseBody(body).doc)).not.toContain('rawBlock');
    });

    test(`${name}: ПРИВЯЗКА к реестру ничего не двигает — тело уже написано печатью`, () => {
      // Сильнее канона, и это главный сторож формы сидов. `canonicalizeBody` реестра не
      // видит и потому одинаково пропускает и key-форму, и любой другой текст в обёртке;
      // разойтись с печатью (лишний пробел, старое имя поля, снятая кавычка заголовка) он
      // не заметил бы вовсе. А executor кладёт в тело именно `serializeBody(bind(…))` —
      // и первое же сохранение переписало бы сид, разъехавшись с этими литералами,
      // с PRD §3.3 и с байтовыми пинами web разом.
      const bound = bindQueryBlocks(parseBody(body), FIXTURE_PARSE_REGISTRY);
      expect(serializeBody(bound)).toBe(body);
    });

    test(`${name}: каждый query-блок РАЗОБРАН — ни одного ast === null`, () => {
      // Половина, которую предыдущая проверка не ловит: неразобранный блок текст сохраняет
      // дословно, поэтому «привязка ничего не двигает» на нём выполняется тождественно.
      // Владельцу такой блок приезжает красной плашкой в готовом списке.
      const blocks = queryBlocks(bindQueryBlocks(parseBody(body), FIXTURE_PARSE_REGISTRY).doc);
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        expect([block.text, block.ast === null]).toEqual([block.text, false]);
      }
    });
  }
});

describe('тело Повестки (срез 1в §6.1)', () => {
  test('разбор тела — ровно текст, параметр и три блока данных', () => {
    // Пустые строки между блоками — тоже узлы текста (markdown дословно); по смыслу их нет.
    const nodes = parsePageText(AGENDA_BODY).filter(
      (n) => n.kind !== 'text' || n.text.trim() !== '',
    );
    expect(nodes.map((n) => n.kind)).toEqual(['text', 'param', 'query', 'query', 'query']);
    expect(nodes[0]).toEqual({
      kind: 'text',
      text: expect.stringContaining('Всё, что во времени: встречи, сроки и сделанное — по дням.'),
    });
  });

  test('параметр горизонта: период, по умолчанию 7 дней, варианты — только от сегодня', () => {
    const param = parsePageText(AGENDA_BODY).find((n) => n.kind === 'param');
    if (param?.kind !== 'param') throw new Error('в теле Повестки нет параметра');
    expect(param.problem).toBeNull();
    // `this_week` Повестке не предлагается (§3.3, §6.1): «Просрочено» и лента пересеклись бы.
    expect(param.decl).toEqual({
      name: 'period',
      type: 'period',
      default: 'next_7d',
      options: ['next_7d', 'next_14d'],
      title: 'Горизонт',
    });
  });

  test('каждый блок данных разбирается как блок страницы ({place: "page"}), без места — отказ по $', () => {
    const queries = parsePageText(AGENDA_BODY).flatMap((n) => (n.kind === 'query' ? [n.text] : []));
    expect(queries).toHaveLength(3);
    for (const q of queries) {
      const r = parseQueryAst(q, FIXTURE_PARSE_REGISTRY, { place: 'page' });
      expect([q, r.ok]).toEqual([q, true]);
    }
    // `$period` — только в блоках страниц (§3.8): вне страницы лента и «Дальше» не разбираются.
    expect(parseQueryAst(queries[1] as string, FIXTURE_PARSE_REGISTRY).ok).toBe(false);
  });
});
