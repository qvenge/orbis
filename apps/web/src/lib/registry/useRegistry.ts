// apps/web/src/lib/registry/useRegistry.ts
//
// Снимок эффективного реестра владельца в web (§А9-2) — ОДИН на всё приложение, под ОДНИМ
// ключом (`REGISTRY_QUERY_KEY`); новая версия снимка (§А10-1) его инвалидирует.
//
// Зачем версия. Реестр меняется редко (сид, переименование label владельцем, слияние
// свойств), а читают его почти все экраны, и перечитывать четыре словаря по таймеру значило бы
// платить сетью за событие, которого обычно нет. Поэтому `staleTime` бесконечен, и
// единственный повод сходить на сервер — версия, ОТЛИЧНАЯ от версии лежащего снимка. Её
// приносит `entity.get` полем `registryVersion`: этот запрос уходит после каждой правки графа,
// то есть ровно тогда, когда снимок мог устареть.
//
// Почему версия — НЕ часть ключа (1а новое-8, срез 1б). Прежде ключ был `['registry', version]`,
// и холодный старт экрана записи ходил за реестром дважды: дети экрана подписываются на реестр
// раньше, чем эффект родителя сообщает версию из `entity.get`, — первый запрос уходил под
// «версии ещё нет», а версия переключала ключ, пока он летел. Любой ключ с версией эту гонку
// воспроизводит; ждать версии до первого запроса нельзя — экраны без `entity.get` (чат,
// настройки) версии не получают вовсе. Поэтому ключ один, а версия его ИНВАЛИДИРУЕТ — и только
// когда разошлась с версией ПРИЕХАВШЕГО снимка: первый запрос, пока он летит, версия не трогает,
// а совпавшая с ответом не стоит ничего.
//
// Почему не `trpc.registry.effective.useQuery`: ключ такого запроса собирает сам tRPC из
// пути и входа, и инвалидировать его по версии пришлось бы тем же приёмом, только с чужим
// ключом. Здесь ключ наш, а запрос идёт тем же клиентом и через те же линки
// (`utils.client`), так что мок-линк тестов и заголовки прода работают как у любой другой
// процедуры.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { trpc } from '../../trpc';
import { type EffectiveRegistry, lookupOf, type RegistryLookup } from './labels';

/** Ключ снимка реестра — один на приложение; версия в него не входит (см. шапку файла). */
export const REGISTRY_QUERY_KEY = ['registry'] as const;

/**
 * Последняя версия реестра, о которой сообщил сервер. Живёт МОДУЛЕМ, а не контекстом:
 * читателей реестра десятки и они разбросаны по несвязанным поддеревьям (карточки чата,
 * шапка записи, конструктор запросов), а провайдер над ними всеми означал бы перерисовку
 * всего приложения на каждую смену версии — при том что версия меняется от силы раз в
 * несколько месяцев.
 *
 * `undefined` — сервер ещё не называл версию ни разу; снимок при этом читается как обычно, а
 * названная позже версия перечитывает его, только если разошлась с версией снимка.
 */
let observedVersion: string | undefined;
/** Query update time prevents a new mount from announcing an older cached response.
 * It orders client observations, not opaque server versions or replica state. */
let observedAt = 0;
/**
 * Версия, ради которой снимок уже перечитан: одно перечитывание на одну новую версию, без петли.
 * Без неё сервер, отдающий снимок старше названной версии (реплика отстала), гонял бы запрос по
 * кругу — каждый ответ снова «не совпал».
 */
let refetchedFor: string | undefined;
const listeners = new Set<() => void>();

/**
 * Сообщить о версии реестра, приехавшей в чужом ответе. Идемпотентна: та же строка не
 * будит ни одного подписчика — иначе каждый `entity.get` (а он уходит на каждое открытие
 * записи) перерисовывал бы всех читателей реестра.
 */
export function noteRegistryVersion(version: string | undefined, readAt = Date.now()): void {
  if (version === undefined || readAt < observedAt) return;
  // A fresh observation of the same version also supersedes older cached graph reads.
  observedAt = readAt;
  if (version === observedVersion) return;
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
 * Из продуктового кода звать её нельзя: она стирает наблюдённую версию и память о сделанном
 * перечитывании — следующая названная версия перечитала бы реестр на пустом месте.
 */
export function resetRegistryVersionForTests(): void {
  observedVersion = undefined;
  observedAt = 0;
  refetchedFor = undefined;
  for (const listener of [...listeners]) listener();
}

/**
 * Отдать версию из ответа, который её несёт (`entity.get`). Хук, а не голый вызов, потому
 * что делать это надо ПОСЛЕ рендера: `noteRegistryVersion` будит подписчиков, а обновление
 * внешнего хранилища во время рендера — предупреждение React и лишний кадр.
 */
export function useNoteRegistryVersion(version: string | undefined, readAt?: number): void {
  useEffect(() => noteRegistryVersion(version, readAt), [version, readAt]);
}

/** Снимок реестра для читателя: словари, поиск, подписи и версия, под которой он сложен. */
export interface RegistryView extends RegistryLookup {
  /** `undefined` — снимок ещё едет; подписи в этот момент показываются сырыми адресами. */
  data: EffectiveRegistry | undefined;
  /** Версия ПРИЕХАВШЕГО снимка; пустая строка — снимка ещё нет. */
  version: string;
  /**
   * Снимка нет и не будет: запрос реестра отказал. Без признака «ещё едет» и «не приедет»
   * неразличимы, и читатель, который ждёт реестр (выбор шаблона экрана записи), ждал бы вечно.
   */
  failed: boolean;
  /** Любой отказ чтения, в том числе обновления уже имеющегося snapshot. */
  refreshFailed: boolean;
  refreshing: boolean;
  /** Сервер назвал версию, которой ещё нет в сохранённом snapshot. */
  versionStale: boolean;
  retry: () => void;
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
    queryKey: REGISTRY_QUERY_KEY,
    queryFn: (): Promise<EffectiveRegistry> => utils.client.registry.effective.query(),
    // Снимок протухает не по часам, а по версии. `staleTime` конечный означал бы перезапрос по
    // таймеру, то есть плату за событие, которого нет. Прежний снимок на время перечитывания
    // держит тот же ключ сам — кадра без реестра (и размонтирования тела посреди правки) нет.
    staleTime: Number.POSITIVE_INFINITY,
  });
  const data = query.data;
  const failed = query.isError && data === undefined;
  const refreshFailed = query.isError;
  const refreshing = query.isFetching;
  const versionStale = version !== undefined && data?.version !== version;
  const retry = useCallback(() => {
    void query.refetch();
  }, [query.refetch]);
  useEffect(() => {
    if (
      version === undefined ||
      data === undefined ||
      data.version === version ||
      refetchedFor === version
    )
      return;
    // Читателей десятки, но перечитывает первый: остальные видят `refetchedFor` и молчат.
    refetchedFor = version;
    // cancelRefetch: true — летящий запрос мог уйти под ПРЕДЫДУЩУЮ версию (две смены версии за
    // одно перечитывание). Слитая с ним, новая версия осталась бы «уже перечитанной», а снимок —
    // старым до следующей смены. Лишнего запроса это не стоит: на одну версию он один (страж
    // выше), а первый запрос холодного старта сюда не попадает — снимка ещё нет.
    void queryClient.invalidateQueries({ queryKey: REGISTRY_QUERY_KEY }, { cancelRefetch: true });
  }, [version, data, queryClient]);
  // Cached readers mount repeatedly. Their snapshot initializes the version once;
  // it cannot supersede a newer version already reported by graph reads.
  useEffect(() => {
    if (observedVersion === undefined) noteRegistryVersion(data?.version, query.dataUpdatedAt);
  }, [data?.version, query.dataUpdatedAt]);
  // Локаль здесь НЕ параметр хука, хотя `label()` её принимает: снимок один на всё
  // приложение, а локаль владельца — одна и общая с сервером (`OWNER_LOCALE`). Параметр
  // хука означал бы два разных перевода одного реестра на одном экране.
  return useMemo(
    () => ({
      ...lookupOf(data),
      data,
      version: data?.version ?? '',
      failed,
      refreshFailed,
      refreshing,
      versionStale,
      retry,
    }),
    [data, failed, refreshFailed, refreshing, versionStale, retry],
  );
}
