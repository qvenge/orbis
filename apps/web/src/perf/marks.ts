// Метки ступени 0 (спека скорости §3.1): холодный старт, переход, отклик действия. Готовность экрана — данные записи на
// экране и запросы экрана осели, потолок ожидания блоков 3 с.
import type { PerfActionKind, PerfSample, PerfScreen } from '@orbis/shared';
import { type Query, useIsFetching } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { QUERY_BLOCK_KEY } from '../lib/query-blocks/batch';
import { perfBase, recordSample } from './collector';

export const SCREEN_READY_CEILING_MS = 3000;
let coldStartDone = false;
let pendingNav: { entityId: string; t0: number } | null = null;
const ms = (v: number) => Math.min(600_000, Math.max(0, Math.round(v * 10) / 10));
const sample = (s: Omit<PerfSample, 'device' | 'net' | 'appVersion'>) =>
  recordSample({ ...perfBase(), ...s });

export function markNavigationStart(entityId: string): void {
  pendingNav = { entityId, t0: performance.now() };
}

/** `at` — момент готовности (`performance.now()`), если он раньше вызова: кадры проверки тишины в замер не входят. */
export function markScreenReady(
  entityId: string,
  opts: { cached: boolean; screen?: PerfScreen; at?: number },
): void {
  const at = opts.at ?? performance.now();
  const screen = opts.screen ?? 'record';
  if (!coldStartDone) {
    coldStartDone = true;
    pendingNav = null;
    // План А: постоянного кеша нет — первый экран всегда из сети, «содержимое» и «перепроверенные данные»
    // совпадают; их разведёт план Б (§6.3). Оба пишутся, чтобы у плана Б была база по обеим метрикам.
    sample({ metric: 'cold_start_content', screen, durMs: ms(at), cached: false });
    sample({ metric: 'cold_start_verified', screen, durMs: ms(at), cached: false });
    return;
  }
  if (pendingNav?.entityId !== entityId) return;
  sample({ metric: 'transition', screen, durMs: ms(at - pendingNav.t0), cached: opts.cached });
  pendingNav = null;
}

export interface PerfAction {
  visible(): void;
  confirmed(): void;
}
export function startAction(kind: PerfActionKind): PerfAction {
  const t0 = performance.now();
  let seen = false;
  let done = false;
  return {
    visible() {
      if (!seen) {
        seen = true;
        sample({ metric: 'action_visible', kind, durMs: ms(performance.now() - t0) });
      }
    },
    confirmed() {
      if (!done) {
        done = true;
        sample({ metric: 'action_confirmed', kind, durMs: ms(performance.now() - t0) });
      }
    },
  };
}

/** Запросы, из которых складывается экран записи: запись, списки, реестр, блоки. */
function isScreenQuery(q: Query): boolean {
  const head = q.queryKey[0];
  return (
    head === QUERY_BLOCK_KEY ||
    (Array.isArray(head) && (head[0] === 'entity' || head[0] === 'registry'))
  );
}

/** Готовность экрана записи: данные есть и запросы экрана тихи два кадра (блоки успели встать в очередь); потолок 3 с. */
export function useScreenReadyMark(entityId: string, hasData: boolean, screen: PerfScreen): void {
  const cachedRef = useRef<{ id: string; cached: boolean } | null>(null);
  if (cachedRef.current?.id !== entityId) cachedRef.current = { id: entityId, cached: hasData };
  const dataAtRef = useRef<{ id: string; at: number } | null>(null);
  const doneRef = useRef<string | null>(null);
  const fetching = useIsFetching({ predicate: isScreenQuery });
  useEffect(() => {
    if (!hasData || doneRef.current === entityId) return;
    // Потолок — от ПРИХОДА данных записи, а не от последней смены счётчика запросов (эффект перезапускается на каждой).
    let data = dataAtRef.current;
    if (data?.id !== entityId) {
      data = { id: entityId, at: performance.now() };
      dataAtRef.current = data;
    }
    const dataAt = data.at;
    const cached = cachedRef.current?.cached ?? false;
    const fire = (at: number) => {
      doneRef.current = entityId;
      markScreenReady(entityId, { cached, screen, at });
    };
    const ceiling = setTimeout(
      () => fire(performance.now()),
      Math.max(0, SCREEN_READY_CEILING_MS - (performance.now() - dataAt)),
    );
    if (fetching > 0) return () => clearTimeout(ceiling);
    const quietAt = performance.now();
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => fire(quietAt));
    });
    return () => {
      clearTimeout(ceiling);
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [entityId, hasData, fetching, screen]);
}

export function resetMarksForTests(): void {
  coldStartDone = false;
  pendingNav = null;
}
