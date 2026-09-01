/**
 * ПРИВЯЗКА query-блоков тела к реестру — отдельный шаг между разбором markdown и записью.
 *
 * Почему шаг отдельный, а не параметр `parseBody` (Р-21-1). `{{query:…}}` токенизирует
 * `parseBody`, и реестр в его сигнатуре протёк бы дальше — в `canonicalizeBody`,
 * `bodyPairFromDoc`, `projectionKeepsEverything` и во всех их вызывателей (шесть несущих плюс
 * 238 вызовов в тестах); а в web у `MarkdownToggle` реестра нет структурно. Поэтому синтаксис
 * и привязка разделены: разбор markdown всегда отдаёт `{ast: null, text}`, а дерево собирает
 * ЭТА функция — и зовут её ровно те, у кого реестр есть: executor перед записью и
 * `readBodyDoc` на чтении.
 *
 * ИНВАРИАНТ, который она устанавливает: в блоке либо `ast !== null` и `text` — печатная
 * key-форма ЭТОГО ЖЕ дерева, либо `ast === null` и `text` — исходная строка блока. Третьего
 * состояния не бывает, и обе стороны проверяются тестом.
 *
 * Разбор СТРОГИЙ (`parseQueryAst`): другой формы текста запроса больше нет. Мост старой
 * грамматики стоял здесь ровно до тех пор, пока сидированные тела (§3.3 PRD) были написаны
 * ею; Задача 21b перевела их в key-форму и удалила мост вместе с `query/legacy-bridge.ts`.
 * Текст, который строгий разбор не принял, блоком не становится — он остаётся в `text` с
 * `ast: null`, и владелец видит отказ с позицией, а не молчание.
 */
import type { JSONContent } from '@tiptap/core';
import {
  type ParseRegistry,
  parseQueryAst,
  printQueryAst,
  QUERY_TREE_DEPTH_CAP,
  type QueryAst,
  queryAstSchema,
  queryTreeExceedsDepth,
} from '../query';
import { QUERY_BLOCK_CLOSE } from './nodes/query-block';
import type { BodyDoc } from './types';

interface QueryBlockAttrs {
  ast: QueryAst | null;
  text: string;
}

/**
 * Дерево из атрибута — или `undefined`, если его там нет или оно битое.
 *
 * ВХОД-ДЕРЕВА 5: `ast` в `body_doc`. Форму документа executor спрашивает у схемы ProseMirror,
 * а `attrs` там — произвольный JSON: `{}` вместо дерева проверку документа проходит и падал бы
 * уже в печати. ГЛУБИНА меряется ДО схемы и по той же причине, что у остальных четырёх входов:
 * `queryAstSchema` рекурсивна через `z.lazy` и на достаточно глубоком входе исчерпывает стек
 * ВНУТРИ собственного разбора.
 */
function astFromAttrs(raw: unknown): QueryAst | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (queryTreeExceedsDepth(raw, QUERY_TREE_DEPTH_CAP)) return undefined;
  const parsed = queryAstSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Привязка одного блока. Порядок ветвей — приоритет ДЕРЕВА над текстом: `ast` и есть правда,
 * а `text` — его печать, и разбирать печать заново значило бы гонять дерево через форму,
 * которая беднее его (§А5-3д).
 */
function bindAttrs(attrs: Record<string, unknown>, reg: ParseRegistry): QueryBlockAttrs {
  const text = typeof attrs.text === 'string' ? attrs.text : '';
  let ast = astFromAttrs(attrs.ast);
  if (ast === undefined && text.trim() !== '') {
    // Пустой текст НЕ разбирается намеренно (Р-21-8): `parseQueryAst('')` отвечает
    // `{filter: null}` — законным деревом «весь корпус владельца», — и пустая заготовка молча
    // сменила бы смысл на «все сущности». Незакрытый блок остаётся незакрытым.
    const parsed = parseQueryAst(text, reg);
    if (parsed.ok) ast = parsed.ast;
  }
  if (ast === undefined) return { ast: null, text };
  const printed = printQueryAst(ast, reg, 'key');
  // Единственный оставшийся источник `}}` в key-форме — НЕРЕЗОЛВЕННЫЙ id: печать тотальна и
  // печатает такой id как есть, мимо квотирования значений. Уложить его в обёртку `{{…}}`
  // нечем, поэтому дерево не сохраняется: порванное тело хуже неразобранного блока.
  if (printed.includes(QUERY_BLOCK_CLOSE)) return { ast: null, text };
  return { ast, text: printed };
}

/**
 * Блоки документа — привязанными к реестру. Вход не мутируется, и узлы БЕЗ query-блоков
 * возвращаются ТЕМИ ЖЕ объектами: чтение обязано отдавать вход, а не свою копию, иначе
 * блочные id (UniqueID — чужой схеме атрибут) терялись бы на каждом круге.
 */
export function bindQueryBlocks(input: BodyDoc, reg: ParseRegistry): BodyDoc {
  const doc = bindNode(input.doc, reg);
  return doc === input.doc ? input : { v: input.v, doc };
}

function bindNode(node: JSONContent, reg: ParseRegistry): JSONContent {
  const content = node.content;
  const nextContent = content?.map((child) => bindNode(child, reg));
  const contentChanged = nextContent?.some((child, i) => child !== content?.[i]) === true;
  if (node.type !== 'queryBlock') {
    return contentChanged ? { ...node, content: nextContent } : node;
  }
  const attrs = (node.attrs ?? {}) as Record<string, unknown>;
  // Прочие атрибуты (блочный id) сохраняются: пересобирается ровно пара `ast`/`text`.
  return { ...node, attrs: { ...attrs, ...bindAttrs(attrs, reg) } };
}
