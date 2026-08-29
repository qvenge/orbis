// apps/server/src/registry/cache.ts
//
// ЕДИНСТВЕННЫЙ ВХОД К ЭФФЕКТИВНОМУ РЕЕСТРУ (§А10-1): система ⊕ строки владельца ⊕ его
// дельты, с процессным кешем по ключу `(владелец, его версия, системная версия)`.
//
// ОДНО МНОЖЕСТВО — ОДИН ЧИТАТЕЛЬ. Эффективный реестр читают ДВЕНАДЦАТЬ файлов боевого
// кода, ЧЕТЫРНАДЦАТЬЮ вызовами (у исполнителя их два — одиночный путь и batch; у роутера
// реестра тоже два — снимок ответа и граф зависимостей). Свой файл из счёта исключён: в нём
// объявление и вот эта строка, а не читатели.
//   grep -rc 'effectiveRegistry(' apps/server/src --include='*.ts' \
//     | grep -v test | grep -v ':0' | grep -v 'registry/cache.ts'
//   → entity-read.ts:1, export.ts:1, routers/registry.ts:2, agent-loop/verbs.ts:1,
//     seed/onboarding.ts:1, tools/registry.ts:1, llm/context.ts:1, tools/dispatch.ts:1,
//     routines/propose.ts:1, routines/lifecycle.ts:1, executor/executor.ts:2,
//     query/context.ts:1
// ЧЕТЫРЕ СБОРКИ РЕЕСТРА ТУЛОВ входят сюда двумя адресами: `tools/dispatch.ts` зовёт
// напрямую, а `mcp/server.ts`, `ai/send-message.ts` и `routines/runner.ts` — через
// `buildToolRegistry` (`tools/registry.ts`), и потому видят ровно то же множество и
// обновляются ровно тогда же.
//
// СЫРОЕ ЧТЕНИЕ СТРОК (`loadRegistryRows`, `loadRegistryDeltas`) вызывается ОТСЮДА И ИЗ
// ОПЕРАЦИЙ РЕЕСТРА, и второй адрес — не дыра в правиле, а его следствие:
//   grep -rn 'loadRegistryRows(\|loadRegistryDeltas(' apps/server/src --include='*.ts' \
//     | grep -v test | grep -v 'registry/cache.ts'
//   → два объявления в `load.ts` и ЧЕТЫРЕ вызова в `registry/ops.ts`, больше ничего.
// Операции реестра (Задача 15) — единственные, кто читает реестр ВНУТРИ ПИШУЩЕЙ транзакции,
// а её кеш обходит стороной по построению (`txHasWritten` ниже): зови они `effectiveRegistry`,
// они получили бы тот же четвёрочный SELECT через лишний слой. И главное — операции идут
// пачкой, и свойство, заведённое операцией N, обязано быть видно операции N+1; снимок,
// снятый исполнителем ДО стадий, этого не показывает. Сложение системы с дельтами при этом
// общее (`applyDeltas`) — второй суммы не заведено.
//
// ЗАЧЕМ КЕШ. До него каждый вызов делал четыре SELECT'а (три реестра + версия) и разбирал
// ~100 строк строгими zod-схемами. Это цена НА КАЖДЫЙ вызов тула, на каждый запрос и на
// каждую операцию исполнителя, при том что реестр меняется от силы раз в несколько месяцев.
//
// ЧЕМ КЕШ ИНВАЛИДИРУЕТСЯ. Только версией, и версия читается ИЗ БАЗЫ в той же транзакции
// (§А10-1). Ни таймера, ни ручного сброса нет намеренно: таймер даёт окно, в котором
// процесс валидирует по устаревшему определению, а ручной сброс — второй механизм, который
// однажды забудут позвать. Из этого следует ИНВАРИАНТ, которому обязан подчиняться КАЖДЫЙ
// писатель реестра: правка строки реестра или дельты и `bumpOwnerRegistryVersion` идут
// ОДНОЙ транзакцией (`registry/version.ts`). Писатель, который его нарушит, не «замедлит
// кеш» — он оставит процесс на старом определении навсегда.
//
// ПОЧЕМУ ВЕРСИЯ ЧИТАЕТСЯ ДВАЖДЫ НА ПРОМАХ. Транзакция читателя по умолчанию READ COMMITTED:
// каждый её SELECT берёт свой снапшот, и чужой коммит может лечь МЕЖДУ чтением версии и
// чтением строк. Тогда в кеш легли бы новые строки под старым ключом — то есть устаревание
// НАВСЕГДА, а не на одну транзакцию. Поэтому версия снимается до и после чтения строк, и
// снимок кладётся в кеш, только если она не сдвинулась: инкремент монотонен и идёт тем же
// коммитом, что правка, поэтому равенство версий означает «между двумя чтениями реестр не
// менялся».
//
// ПОЧЕМУ ПИШУЩАЯ ТРАНЗАКЦИЯ КЕШ ОБХОДИТ (`txHasWritten`). Номера версий переиспользуются
// после отката: транзакция, поднявшая версию с 5 до 6 и упавшая, освобождает 6 для
// следующей — с ДРУГИМ содержимым. Снимок, положенный первой под ключом «6», отдался бы
// второй как свой. Поэтому транзакция, которой уже выдан xid (то есть она что-то записала),
// кеш и не читает, и не наполняет. Читающие пути от этого не страдают: снимок реестра они
// берут ДО первой записи (исполнитель — первым делом в транзакции, `executor.ts`).
import type { Tx } from '../db/with-identity';
import { applyDeltas } from './deltas';
import { loadRegistryDeltas, loadRegistryRows, type RegistrySnapshot } from './load';
import { type RegistryVersions, readRegistryVersions } from './version';

/**
 * Сколько владельцев держать. Владелец у Orbis сегодня один (рулинг 23.08), и число здесь
 * не про нагрузку, а про забор: словарь без верхней границы в долгоживущем процессе — это
 * утечка, которая проявляется не на стенде, а через месяц аптайма. 64 снимка ≈ единицы
 * мегабайт и заведомо больше любого реального числа активных владельцев процесса.
 */
export const REGISTRY_CACHE_LIMIT = 64;

/**
 * LRU на обычном `Map`: порядок вставки в нём наблюдаем и стабилен, поэтому «самый старый» —
 * это первый ключ итерации, а «освежить» — удалить и вставить заново. Отдельная структура
 * (двусвязный список) на 64 элементах не окупается.
 */
const cache = new Map<string, RegistrySnapshot>();

/** Счётчики — наблюдаемость кеша для тестов и для будущего /health (§А10-1). */
let hits = 0;
let misses = 0;
let bypassed = 0;

export interface RegistryCacheStats {
  size: number;
  hits: number;
  /** Промах: снимок собран заново и, если версия не сдвинулась, положен в кеш. */
  misses: number;
  /** Обход: транзакция уже писала — кеш не читался и не наполнялся. */
  bypassed: number;
}

export function registryCacheStats(): RegistryCacheStats {
  return { size: cache.size, hits, misses, bypassed };
}

function cacheKey(ownerId: string, versions: RegistryVersions): string {
  return `${ownerId}:${versions.ownerVersion}:${versions.systemVersion}`;
}

/**
 * Эффективный реестр владельца (§А3-2, §А10-1): система ⊕ его строки ⊕ его дельты.
 *
 * Вызывается ТОЛЬКО внутри транзакции — своей у неё нет намеренно: версия обязана читаться
 * тем же снапшотом, что и всё остальное чтение вызывающего, иначе исполнитель валидировал
 * бы запись по реестру, которого в его транзакции ещё (или уже) нет.
 */
export async function effectiveRegistry(tx: Tx, ownerId: string): Promise<RegistrySnapshot> {
  const before = await readRegistryVersions(tx, ownerId);
  const key = cacheKey(ownerId, before);
  if (before.txHasWritten) {
    bypassed += 1;
    return await build(tx, ownerId, before);
  }
  const hit = cache.get(key);
  if (hit !== undefined) {
    hits += 1;
    // Освежить позицию в LRU: без этого «самый старый ключ» означало бы «дольше всех не
    // перечитывался», а вытеснять надо тот, которым дольше всех не ПОЛЬЗОВАЛИСЬ.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  misses += 1;
  const snapshot = await build(tx, ownerId, before);
  const after = await readRegistryVersions(tx, ownerId);
  if (
    after.txHasWritten ||
    after.ownerVersion !== before.ownerVersion ||
    after.systemVersion !== before.systemVersion
  ) {
    return snapshot;
  }
  cache.set(key, snapshot);
  while (cache.size > REGISTRY_CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }
  return snapshot;
}

async function build(
  tx: Tx,
  ownerId: string,
  versions: RegistryVersions,
): Promise<RegistrySnapshot> {
  const rows = await loadRegistryRows(tx, ownerId);
  const deltas = await loadRegistryDeltas(tx, ownerId);
  return applyDeltas(
    { ...rows, ownerVersion: versions.ownerVersion, systemVersion: versions.systemVersion },
    deltas,
  );
}
