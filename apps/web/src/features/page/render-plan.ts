// Листовые сабпаты, не баррель `@orbis/shared/doc`: модуль эагерно достижим из экрана записи через
// рендерер (сторожа `check-lazy-chunks.ts` и `save.test.tsx`).
import type { PageNode } from '@orbis/shared/doc/page-grammar';
import {
  type BodyKind,
  bodyIssues,
  nodeAt,
  type PlacementIssue,
} from '@orbis/shared/doc/placement';
import { OWNER_LOCALE, type ParseRegistry } from '@orbis/shared/query';

/**
 * Что рисуется из дерева тела — одна копия правила для рендерера показа (`Renderer.planRender`) и
 * для «Изменить вид только этой записи» (`change-view.ts`): вторая копия «какой `{{cards}}`
 * рисуемый» разошлась бы с показом, и копия шаблона потеряла бы карточки, которые запись до
 * действия показывала (финальное ревью, C1-I1).
 */

/**
 * Пустой реестр разбора — для мест БЕЗ блоков данных. `bodyIssues` читает реестр только у узлов
 * `query`, а первый кадр спрашивает её об одном узле обвязки или контейнера за раз и берёт
 * только проблему самого узла (путь длины 1): проблемы блоков данных внутри показывает их
 * собственный `DataBlock` по настоящему реестру. Тем же приёмом пользуется рендерер страниц:
 * проблемы узлов-запросов он отбрасывает, ими говорит блок.
 */
export const NO_REGISTRY: ParseRegistry = {
  properties: new Map(),
  aspects: new Map(),
  roles: new Map(),
  contracts: new Map(),
  locale: OWNER_LOCALE,
};

export const pathKey = (path: readonly number[]): string => path.join('.');

/** Части контейнера как списки узлов — у колонок это сам массив, у вкладок — `children`. */
export function partsOf(node: PageNode): readonly (readonly PageNode[])[] {
  if (node.kind === 'columns') return node.parts;
  if (node.kind === 'tabs') return node.parts.map((t) => t.children);
  return [];
}

/**
 * Плашки рендерера по путям (`path.join('.')`). Проблемы узлов-запросов отброшены: о себе говорит
 * сам `DataBlock` (разбор, абсолютная дата, отказ сервера) — той же формулировкой, с кнопкой
 * «Настроить». Вторая плашка на том же месте повторила бы первую. Поэтому и реестр здесь пустой.
 */
export function renderIssues(
  nodes: readonly PageNode[],
  kind: BodyKind,
): Map<string, PlacementIssue> {
  const issues = new Map<string, PlacementIssue>();
  for (const issue of bodyIssues(nodes, kind, NO_REGISTRY)) {
    if (nodeAt(nodes, issue.path).kind === 'query') continue;
    issues.set(pathKey(issue.path), issue);
  }
  return issues;
}

/**
 * Обход РИСУЕМЫХ узлов: узел с плашкой не показан, и в его части обход не спускается. Карточка в
 * неуместном или сломанном месте не рисуется — считать её размещённой значило бы потерять её
 * совсем, ни на месте, ни в конце. Путь узла — тому, кто ставит плашку сам (план рендера:
 * вторая карточка аспекта, узнанная только с реестром).
 */
export function forEachRendered(
  nodes: readonly PageNode[],
  issues: ReadonlyMap<string, PlacementIssue>,
  fn: (node: PageNode, path: readonly number[]) => void,
): void {
  const visit = (list: readonly PageNode[], prefix: readonly number[]) => {
    list.forEach((node, i) => {
      const path = [...prefix, i];
      if (issues.has(pathKey(path))) return;
      fn(node, path);
      for (const [p, part] of partsOf(node).entries()) visit(part, [...path, p]);
    });
  };
  visit(nodes, []);
}

/** Рисуемый ли блок «все карточки»: тогда дописывать карточки в конец нечего (§8.3). */
export const isCardsBlock = (node: PageNode): boolean =>
  node.kind === 'record' && node.name === 'cards';

/** Есть ли в дереве рисуемый `{{cards}}` — в заборе кода, неуместном или сломанном месте не в счёт. */
export function hasRenderedCards(nodes: readonly PageNode[], kind: BodyKind): boolean {
  let found = false;
  forEachRendered(nodes, renderIssues(nodes, kind), (node) => {
    if (isCardsBlock(node)) found = true;
  });
  return found;
}
