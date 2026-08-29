// apps/web/src/lib/registry/useRegistry.ts
//
// Снимок эффективного реестра владельца в web (§А9-2) — ОДИН на всё приложение, кешируемый
// по версии снимка (§А10-1).
//
// Зачем версия. Реестр меняется редко (сид, переименование label владельцем, слияние
// свойств), а читают его почти все экраны, и перечитывать три словаря по таймеру значило бы
// платить сетью за событие, которого обычно нет. Поэтому ключ кеша несёт саму версию
// (`['registry', version]`), `staleTime` — бесконечен, и единственный повод сходить на
// сервер — ДРУГАЯ версия в ключе. Её приносит `entity.get` полем `registryVersion`: этот
// запрос уходит после каждой правки графа, то есть ровно тогда, когда снимок мог устареть.
//
// Почему не `trpc.registry.effective.useQuery`: ключ такого запроса собирает сам tRPC из
// пути и входа, и версии в нём нет — а без неё смена версии не меняет ключ, то есть
// инвалидации не происходит вовсе. Здесь ключ наш, а запрос идёт тем же клиентом и через
// те же линки (`utils.client`), так что мок-линк тестов и заголовки прода работают как у
// любой другой процедуры.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { trpc } from '../../trpc';
import { type EffectiveRegistry, lookupOf, type RegistryLookup } from './labels';

/**
 * Последняя версия реестра, о которой сообщил сервер. Живёт МОДУЛЕМ, а не контекстом:
 * читателей реестра десятки и они разбросаны по несвязанным поддеревьям (карточки чата,
 * шапка записи, конструктор запросов), а провайдер над ними всеми означал бы перерисовку
 * всего приложения на каждую смену версии — при том что версия меняется от силы раз в
 * несколько месяцев.
 *
 * `undefined` — сервер ещё не называл версию ни разу; тогда снимок берётся под ключом
 * `['registry', null]` и переезжает под свою версию первым же ответом (см. `useRegistry`).
 */
let observedVersion: string | undefined;
const listeners = new Set<() => void>();

/**
 * Сообщить о версии реестра, приехавшей в чужом ответе. Идемпотентна: та же строка не
 * будит ни одного подписчика — иначе каждый `entity.get` (а он уходит на каждое открытие
 * записи) перерисовывал бы всех читателей реестра.
 */
export function noteRegistryVersion(version: string | undefined): void {
  if (version === undefined || version === observedVersion) return;
  observedVersion = version;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * ТОЛЬКО для тестов: вернуть модульное состояние к «сервер версии ещё не называл».
 *
 * Нужна потому, что хранилище выше живёт МОДУЛЕМ и переживает размонтирование дерева — как и
 * должно в бою (версия реестра не сбрасывается от перехода между экранами). В тестовом файле
 * это означало бы, что второй тест стартует с версией, которую наблюдал первый, и проверял бы
 * не то, что написано в его имени.
 *
 * Из продуктового кода звать её нельзя: она стирает наблюдённую версию, то есть уводит всех
 * читателей на ключ «версии ещё нет» и заставляет перечитать реестр на пустом месте.
 */
export function resetRegistryVersionForTests(): void {
  observedVersion = undefined;
  for (const listener of [...listeners]) listener();
}

/**
 * Отдать версию из ответа, который её несёт (`entity.get`). Хук, а не голый вызов, потому
 * что делать это надо ПОСЛЕ рендера: `noteRegistryVersion` будит подписчиков, а обновление
 * внешнего хранилища во время рендера — предупреждение React и лишний кадр.
 */
export function useNoteRegistryVersion(version: string | undefined): void {
  useEffect(() => noteRegistryVersion(version), [version]);
}

/** Снимок реестра для читателя: словари, поиск, подписи и версия, под которой он сложен. */
export interface RegistryView extends RegistryLookup {
  /** `undefined` — снимок ещё едет; подписи в этот момент показываются сырыми адресами. */
  data: EffectiveRegistry | undefined;
  /** Версия ПРИЕХАВШЕГО снимка; пустая строка — снимка ещё нет. */
  version: string;
}

export function useRegistry(): RegistryView {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const version = useSyncExternalStore(
    subscribe,
    () => observedVersion,
    () => observedVersion,
  );
  const query = useQuery({
    queryKey: ['registry', version ?? null],
    queryFn: async (): Promise<EffectiveRegistry> => {
      const data = await utils.client.registry.effective.query();
      // Снимок кладётся и под СВОЮ версию — до того, как ключ на неё переедет. Без этого
      // первый же ответ, назвавший версию, уводил бы читателей на пустой ключ и заставлял
      // сходить на сервер второй раз за тем же самым снимком.
      queryClient.setQueryData(['registry', data.version], data);
      return data;
    },
    // Снимок протухает не по часам, а по версии — она и есть ключ. `staleTime` конечный
    // означал бы перезапрос по таймеру, то есть плату за событие, которого нет.
    staleTime: Number.POSITIVE_INFINITY,
  });
  const data = query.data;
  useNoteRegistryVersion(data?.version);
  // Локаль здесь НЕ параметр хука, хотя `label()` её принимает: снимок один на всё
  // приложение, а локаль владельца — одна и общая с сервером (`OWNER_LOCALE`). Параметр
  // хука означал бы два разных перевода одного реестра на одном экране.
  return useMemo(() => ({ ...lookupOf(data), data, version: data?.version ?? '' }), [data]);
}
