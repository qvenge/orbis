// Метки ступени 0 (спека скорости §3.1): холодный старт, переход, отклик действия. Готовность экрана — данные записи на
// экране и первые загрузки запросов экрана осели, потолок ожидания блоков 3 с.
import type { PerfActionKind, PerfSample, PerfScreen } from '@orbis/shared';
import { type Query, useIsFetching } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { QUERY_BLOCK_KEY } from '../lib/query-blocks/batch';
import { perfBase, recordSample } from './collector';

/**
 * Срок метки начала перехода (гейт задачи 3, M-1): метка, не закрытая готовностью за это время (ушли назад до
 * готовности, запись не нашлась), снимается — иначе поздняя готовность той же записи чужим путём дала бы «переход»
 * длиной в минуты. Потолок готовности — 3 с после данных, поэтому 30 с с запасом покрывают и медленную сеть.
 */
export const NAV_MARK_TTL_MS = 30_000;

/** Куда ведёт переход: запись по id или домашняя приложения (её запись становится известна только оболочке). */
export type NavTarget = { kind: 'record'; id: string } | { kind: 'home' };

let coldStartDone = false;
let pendingNav: { target: NavTarget; t0: number } | null = null;
/**
 * Страница была скрыта до первой готовности (гейт задачи 3, M-6): холодный старт считается от начала навигации
 * документа, и фоновая вкладка раздула бы его временем, пока на неё не смотрели. Такой старт не пишется — так же
 * `web-vitals` отбрасывает LCP скрытой страницы.
 */
let hiddenBeforeReady = document.visibilityState === 'hidden';
document.addEventListener('visibilitychange', () => {
  if (!coldStartDone && document.visibilityState === 'hidden') hiddenBeforeReady = true;
});
const ms = (v: number) => Math.min(600_000, Math.max(0, Math.round(v * 10) / 10));
const sample = (s: Omit<PerfSample, 'device' | 'net' | 'appVersion'>) =>
  recordSample({ ...perfBase(), ...s });

/**
 * Начало перехода. Ставит ЕГО стор навигации (`state/navigation.ts`) на каждой смене места — ссылка, раздел, плитка,
 * «‹» и системный «назад» (гейт задачи 3, I-4); `null` — переход не на экран записи: прежняя метка снимается.
 */
export function markNavigationStart(target: NavTarget | null): void {
  pendingNav = target === null ? null : { target, t0: performance.now() };
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
    if (hiddenBeforeReady) return;
    // План А: постоянного кеша нет — первый экран всегда из сети, «содержимое» и «перепроверенные данные»
    // совпадают; их разведёт план Б (§6.3). Оба пишутся, чтобы у плана Б была база по обеим метрикам.
    sample({ metric: 'cold_start_content', screen, durMs: ms(at), cached: false });
    sample({ metric: 'cold_start_verified', screen, durMs: ms(at), cached: false });
    return;
  }
  const nav = pendingNav;
  // Готовность, наступившая раньше нажатия, — от прежнего экрана: к этому переходу она не относится.
  if (nav === null || at < nav.t0) return;
  if (at - nav.t0 > NAV_MARK_TTL_MS) {
    pendingNav = null;
    return;
  }
  const hit = nav.target.kind === 'record' ? nav.target.id === entityId : screen === 'home';
  if (!hit) return;
  sample({ metric: 'transition', screen, durMs: ms(at - nav.t0), cached: opts.cached });
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

/** Потолок ожидания первых загрузок экрана после прихода данных записи. */
export const SCREEN_READY_CEILING_MS = 3000;

/**
 * ПЕРВЫЕ загрузки запросов экрана записи: запись, списки, реестр, блоки — у которых данных ещё нет. Фоновая
 * перепроверка показанного (устаревший кеш, `invalidateGraph`) готовность не задерживает (гейт задачи 3, I-3): экран
 * уже нарисован, и переход «из кеша» получал бы время сети — ровно то, что разрез по кешу должен отделять.
 */
function isScreenFirstLoad(q: Query): boolean {
  if (q.state.data !== undefined) return false;
  const head = q.queryKey[0];
  return (
    head === QUERY_BLOCK_KEY ||
    (Array.isArray(head) && (head[0] === 'entity' || head[0] === 'registry'))
  );
}

/** Были ли данные записи в кеше в момент открытия экрана этой записи — разрез «из кеша» (§3.3). */
export function useCachedAtOpen(entityId: string, hasData: boolean): boolean {
  const ref = useRef<{ id: string; cached: boolean } | null>(null);
  if (ref.current?.id !== entityId) ref.current = { id: entityId, cached: hasData };
  return ref.current.cached;
}

/**
 * Готовность экрана записи: зовётся, когда данные записи уже на экране; первые загрузки запросов экрана тихи два кадра
 * (блоки успели встать в очередь); потолок 3 с от прихода данных.
 */
export function useScreenReadyMark(entityId: string, screen: PerfScreen, cached: boolean): void {
  const dataAtRef = useRef<{ id: string; at: number } | null>(null);
  const doneRef = useRef<string | null>(null);
  const fetching = useIsFetching({ predicate: isScreenFirstLoad });
  useEffect(() => {
    if (doneRef.current === entityId) return;
    // Потолок — от ПРИХОДА данных записи, а не от последней смены счётчика запросов (эффект перезапускается на каждой).
    let data = dataAtRef.current;
    if (data?.id !== entityId) {
      data = { id: entityId, at: performance.now() };
      dataAtRef.current = data;
    }
    const dataAt = data.at;
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
  }, [entityId, fetching, screen, cached]);
}

/**
 * Лист экрана записи, который ничего не рисует (гейт задачи 3, M-3): подписка на счётчик запросов перерисовывает
 * только его, а не весь экран — замер не должен замедлять то, что меряет. Монтируется, когда данные записи есть.
 */
export function ScreenReadyMark(props: {
  entityId: string;
  screen: PerfScreen;
  cached: boolean;
}): null {
  useScreenReadyMark(props.entityId, props.screen, props.cached);
  return null;
}

export function resetMarksForTests(): void {
  coldStartDone = false;
  pendingNav = null;
  hiddenBeforeReady = document.visibilityState === 'hidden';
}
