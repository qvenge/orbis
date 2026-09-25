// Листовой сабпат, не баррель `@orbis/shared/doc`: модуль эагерно достижим из экрана записи
// (сторожа `check-lazy-chunks.ts` и `save.test.tsx`).
import { type PageNode, parsePageText } from '@orbis/shared/doc/page-grammar';

/**
 * Шаблон хоста (спека страниц 1а §8.1, Р-16) — сегодняшний экран записи, записанный текстом в
 * грамматике страниц. Текст дословно из спеки: разбирается тем же препроходом и рисуется тем же
 * рендерером, что шаблоны владельца, — у экрана записи нет второго, «зашитого» пути показа.
 *
 * В 1а не правится (правка — 1б, копией с эталоном, Р-3). Сверку «дословно» держит
 * `host-template.test.ts` — и литералом, и против самого блока спеки.
 */
export const HOST_TEMPLATE_TEXT: string = [
  '{{title}}',
  '{{tags}}',
  '{{tabs}}',
  '{{tab: Запись}}',
  '{{card: orbis/goal}}',
  '{{card: orbis/assignment}}',
  '{{card: orbis/routine}}',
  '{{card: orbis/agent-run}}',
  '{{card: orbis/financial}}',
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
].join('\n');

/**
 * Дерево шаблона хоста — разобрано один раз, при загрузке модуля: текст в поставке не меняется,
 * и разбирать его на каждом открытии записи незачем. Экран без своих шаблонов рисуется сразу, без
 * запроса за текстом шаблона (§6.5).
 */
export const HOST_TEMPLATE_NODES: readonly PageNode[] = parsePageText(HOST_TEMPLATE_TEXT);
