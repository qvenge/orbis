// Листовые сабпаты, не баррель `@orbis/shared/doc`: модуль эагерно достижим из экрана записи
// (сторожа `check-lazy-chunks.ts` и `save.test.tsx`).
import { type PageNode, parsePageText } from '@orbis/shared/doc/page-grammar';
import { HOST_TEMPLATE_ETALON_TEXT } from '@orbis/shared/supply';

/**
 * Шаблон хоста из КОДА — эталон поставки (срез 1б §9.2, §8.5): текст спеки 1а §8.1 с `{{cards: own}}`
 * вместо пяти строк `{{card: …}}`. Своей копии текста у web нет (гейт задачи 11): эталон один, в
 * `@orbis/shared/supply`, и из него же сервер заводит запись поставки «Шаблон хоста».
 *
 * Экран записи рисует шаблоном хоста ТЕЛО ЭТОЙ ЗАПИСИ (`RecordView`), а эталон кода — гарантия:
 * записи нет, она в архиве или сломана (§9.2). Сверку с блоком спеки 1а держит `host-template.test.ts`.
 */
export const HOST_TEMPLATE_TEXT: string = HOST_TEMPLATE_ETALON_TEXT;

/**
 * Дерево эталона — разобрано один раз, при загрузке модуля: эталон в поставке не меняется, и
 * разбирать его на каждом открытии записи незачем. Экран без своих шаблонов рисуется сразу, не
 * дожидаясь записи шаблона хоста (1а §6.5).
 */
export const HOST_TEMPLATE_NODES: readonly PageNode[] = parsePageText(HOST_TEMPLATE_TEXT);
