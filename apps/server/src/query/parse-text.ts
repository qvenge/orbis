// apps/server/src/query/parse-text.ts
// ЕДИНСТВЕННАЯ точка серверного разбора ТЕКСТА запроса (§А5-3 → §А5-7).
//
// Через неё идут все четверо: tRPC `entity.query`/`entity.count`, тул `entity_query`, тул
// `user_query` и источник прогресса цели. Точка одна не ради красоты: у разбора есть
// НАСТРОЙКИ (локаль резолва подписей), и второй его копией у любого из потребителей одна
// половина продукта читала бы тексты, которые другая отвергает. Именно так и выглядел бы
// отказ, который никто не воспроизведёт: Agenda работает, а тот же запрос из чата — нет.
//
// ФОРМА ТЕКСТА ТЕПЕРЬ ОДНА. До Задачи 21b здесь стоял мост `parseQueryAny`, принимавший и
// старую плоскую грамматику §6.1: боевые тексты (тела сидов, заготовка проекта) были
// написаны ею. Тексты переведены в key-форму той же задачей, мост удалён вместе со старой
// грамматикой, и разбор стал СТРОГИМ — старая форма получает честный отказ с позицией.
//
// Отказ — всегда `ExecError('VALIDATION')` с позицией в `details`: роутер разворачивает его
// в `TRPCError` (клиент рисует красную плашку по `{message, position}`), диспатч тулов — в
// error-результат модели (§6.4). Код причины новой грамматики едет в `details.reason`.

import {
  OWNER_LOCALE,
  type ParseRegistry,
  parseQueryAst,
  type QueryAst,
  toParseRegistry,
} from '@orbis/shared/query';
import { ExecError } from '../errors';
import type { CompileCtx } from './compile-ast';

/**
 * Снимок реестра в форме разбора имён. Одна функция на всех, а не `toParseRegistry(reg, …)`
 * на месте у каждого: локаль — решение, а не литерал, и три её копии разъехались бы ровно
 * тогда, когда язык владельца станет настройкой. Сама локаль живёт в `@orbis/shared/query`
 * (`OWNER_LOCALE`): с Задачи 10c тот же текст разбирает браузер, и две локали означали бы
 * запрос, который клиент принимает, а сервер отвергает.
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
  const parsed = parseQueryAst(text, parseRegistryOf(ctx));
  if (parsed.ok) return parsed.ast;
  throw new ExecError('VALIDATION', parsed.error.message, {
    reason: parsed.error.code,
    ...(parsed.error.position !== undefined && { position: parsed.error.position }),
  });
}
