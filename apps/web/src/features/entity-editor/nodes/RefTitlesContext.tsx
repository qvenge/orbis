import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { type RouterOutputs, trpc } from '../../../trpc';

/** Ровно то, что отдаёт `entity.resolveRefs`: тип берём у роутера, чтобы не завести второй. */
export type RefTitle = RouterOutputs['entity']['resolveRefs'][number];

const Ctx = createContext<Map<string, RefTitle>>(new Map());

/**
 * Заголовки для ВСЕХ чипов документа ОДНИМ запросом.
 *
 * Резолв поднят на уровень документа не для красоты: хук внутри самого чипа завёл бы
 * отдельный ключ кэша на каждую ссылку, и тело с десятком упоминаний давало бы десяток
 * запросов — ровно тот шторм, против которого и заведён `entity.resolveRefs` (Задача 6).
 *
 * `enabled` — не перестраховка: контракт требует непустой список (`ids.min(1)`), и с пустым
 * телом запрос уходил бы только затем, чтобы вернуться ошибкой валидации.
 */
export function RefTitlesProvider({ ids, children }: { ids: string[]; children: ReactNode }) {
  // Стабильный ключ кэша: порядок и дубли не должны заводить ВТОРОЙ запрос за тем же самым.
  // Сортировка тут же экономит и на сервере — список короче ровно на повторы.
  const unique = [...new Set(ids)].sort();
  const q = trpc.entity.resolveRefs.useQuery(
    { ids: unique },
    { enabled: unique.length > 0, staleTime: 30_000 },
  );
  // Карта пересобирается только на новый ответ: голое `new Map(...)` в JSX меняло бы значение
  // контекста на КАЖДЫЙ рендер редактора, то есть перерисовывало бы все чипы на каждое
  // нажатие клавиши.
  const map = useMemo(() => new Map((q.data ?? []).map((e) => [e.id, e])), [q.data]);
  return <Ctx.Provider value={map}>{children}</Ctx.Provider>;
}

/** Заголовок ссылки или undefined — пока резолв едет и если сущность не найдена. */
export function useRefTitle(id: string): RefTitle | undefined {
  return useContext(Ctx).get(id);
}
