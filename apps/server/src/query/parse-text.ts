// apps/server/src/query/parse-text.ts
// ЕДИНСТВЕННАЯ точка серверного разбора ТЕКСТА запроса (§А5-3 → §А5-7).
//
// Через неё идут все четверо: tRPC `entity.query`/`entity.count`, тул `entity_query`, тул
// `user_query` и источник прогресса цели. Точка одна не ради красоты: разбор принимает ДВЕ
// формы текста (новую грамматику и старую через мост, `@orbis/shared/query`), и второй его
// копией у любого из потребителей одна половина продукта читала бы старые тексты, а другая
// — нет. Именно так и выглядел бы отказ, который никто не воспроизведёт: Agenda работает,
// а тот же запрос из чата — нет.
//
// Отказ — всегда `ExecError('VALIDATION')` с позицией в `details`: роутер разворачивает его
// в `TRPCError` (клиент рисует красную плашку по `{message, position}`), диспатч тулов — в
// error-результат модели (§6.4). Код причины новой грамматики едет в `details.reason`.

import {
  type ParseRegistry,
  parseQueryAny,
  type QueryAst,
  toParseRegistry,
} from '@orbis/shared/query';
import { ExecError } from '../errors';
import type { CompileCtx } from './compile-ast';

/**
 * Локаль, в которой резолвятся ЗАКАВЫЧЕННЫЕ подписи имён (§А5-3б).
 *
 * Своей колонки у неё нет: `user_settings` хранит таймзону, валюту и начало недели, но не
 * язык. Константа названа здесь одна на весь сервер, и её значение наблюдаемо ровно в одном
 * случае — когда в тексте запроса стоит `"подпись"` вместо ключа; ключевая форма (вся
 * сегодняшняя опись боевых текстов) от локали не зависит вовсе. Правило fallback — §А2-1:
 * локаль → en → любая, поэтому промах даёт английскую подпись, а не отказ.
 */
const OWNER_LOCALE = 'ru';

/**
 * Снимок реестра в форме разбора имён. Одна функция на всех, а не `toParseRegistry(reg, 'ru')`
 * на месте у каждого: локаль — решение, а не литерал, и три её копии разъехались бы ровно
 * тогда, когда язык владельца станет настройкой.
 *
 * Нужна не только разбору текста: тем же реестром резолвится ИМЯ СВОЙСТВА, приехавшее не из
 * запроса, — поле агрегата `user_query.field` и источник прогресса цели.
 */
export function parseRegistryOf(ctx: CompileCtx): ParseRegistry {
  return toParseRegistry(ctx.reg, OWNER_LOCALE);
}

/**
 * Текст запроса → канонический Q-AST по реестру владельца.
 *
 * Контекст, а не `(tx, ownerId)`: снимок реестра уже снят вызывающим (`queryContext`) и
 * лежит в `ctx.reg` — второе его чтение стоило бы пять запросов к БД на каждый разбор.
 */
export function parseQueryText(text: string, ctx: CompileCtx): QueryAst {
  const parsed = parseQueryAny(text, parseRegistryOf(ctx));
  if (parsed.ok) return parsed.ast;
  throw new ExecError('VALIDATION', parsed.error.message, {
    reason: parsed.error.code,
    ...(parsed.error.position !== undefined && { position: parsed.error.position }),
  });
}
