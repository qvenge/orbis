import { ENTITY_RESOLVE_REFS_MAX } from '@orbis/shared';
import { createContext, type ReactNode, useCallback, useContext, useMemo } from 'react';
import { type RouterOutputs, trpc } from '../../../trpc';

/** Ровно то, что отдаёт `entity.resolveRefs`: тип берём у роутера, чтобы не завести второй. */
export type RefTitle = RouterOutputs['entity']['resolveRefs'][number];

const Ctx = createContext<Map<string, RefTitle>>(new Map());

/**
 * Заголовки для ВСЕХ чипов документа одним запросом — и ровно столькими запросами, сколько
 * требует потолок контракта, не больше.
 *
 * Резолв поднят на уровень документа не для красоты: хук внутри самого чипа завёл бы
 * отдельный ключ кэша на каждую ссылку, и тело с десятком упоминаний давало бы десяток
 * запросов — ровно тот шторм, против которого и заведён `entity.resolveRefs` (Задача 6).
 *
 * Нарезка на пачки — вторая половина того же обещания. У входа контракта есть ПОТОЛОК
 * (`ENTITY_RESOLVE_REFS_MAX`), и тело с 201 упоминанием одним запросом получило бы ошибку
 * валидации: `data` осталась бы пустой, а ВСЕ чипы документа — навсегда серыми, без единого
 * следа для пользователя (в проде — ещё и с ретраями). Обрезать список нельзя: это молчаливая
 * потеря заголовков у хвоста тела. Поэтому режем и запрашиваем пачки параллельно: у
 * подавляющего большинства тел пачка ровно одна, а деградация линейна, а не катастрофична.
 * Шторм — это запрос на ссылку, а не на две сотни.
 */
export function RefTitlesProvider({ ids, children }: { ids: string[]; children: ReactNode }) {
  // Стабильный ключ кэша: порядок и дубли не должны заводить ВТОРОЙ запрос за тем же самым.
  // Сортировка тут же экономит и на сервере — список короче ровно на повторы. Ключ мемоизации
  // строковый: сам массив пересоздаётся на каждый рендер, и по нему memo не удержался бы.
  const key = useMemo(() => [...new Set(ids)].sort().join(','), [ids]);
  const batches = useMemo(() => {
    // Пустое тело до сети не доходит вовсе: у входа есть и НИЖНЯЯ граница (min(1)), и пустой
    // запрос вернулся бы той же ошибкой валидации.
    const unique = key === '' ? [] : key.split(',');
    const out: string[][] = [];
    for (let i = 0; i < unique.length; i += ENTITY_RESOLVE_REFS_MAX) {
      out.push(unique.slice(i, i + ENTITY_RESOLVE_REFS_MAX));
    }
    return out;
  }, [key]);

  // `combine` вместо сборки карты в теле компонента — ради ТОЖДЕСТВА значения контекста:
  // React Query пересчитывает его только на смену результатов, а голое `new Map(...)` на
  // каждый рендер перерисовывало бы все чипы документа на каждое нажатие клавиши. Функция
  // обязана быть стабильной, иначе мемоизация внутри QueriesObserver не срабатывает.
  const combine = useCallback(
    (results: { data?: RefTitle[] }[]) =>
      new Map(results.flatMap((r) => r.data ?? []).map((e) => [e.id, e] as const)),
    [],
  );
  const map = trpc.useQueries(
    (t) => batches.map((batch) => t.entity.resolveRefs({ ids: batch }, { staleTime: 30_000 })),
    { combine },
  );

  return <Ctx.Provider value={map}>{children}</Ctx.Provider>;
}

/** Заголовок ссылки или undefined — пока резолв едет и если сущность не найдена. */
export function useRefTitle(id: string): RefTitle | undefined {
  return useContext(Ctx).get(id);
}
