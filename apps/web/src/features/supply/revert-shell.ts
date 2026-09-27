import { APP_HOME, APP_NAV, APP_OPENS_OVER, SUPPLY_TEXT } from '@orbis/shared';
import { parseAppPrint, printAppProps } from '@orbis/shared/supply/print';

const idsOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const idOf = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * Что изменит «Вернуть как было» у оболочки хоста (срез 1б §9.1 п. 4) — то, что диалог показывает
 * ДО возврата. Сравнивается нынешнее место с печатью эталона В ЗАПИСИ (`orbis/supply_text`), к
 * которой возврат и ведёт (`revertToEtalon`).
 *
 * - `vanishing` — разделы нынешней навигации, которых нет в эталоне: их добавил владелец, и они
 *   исчезнут (в порядке навигации);
 * - `home` / `etalonHome` — нынешняя домашняя и домашняя эталона;
 * - `etalonNav` и `etalonHome` нужны диалогу, чтобы сказать, что НЕ вернётся: сервер пишет эталон
 *   без архивных целей (R-16) — архивный раздел не вернётся, а при архивной «Домой» домашней после
 *   возврата не будет вовсе, даже если своя домашняя была.
 *
 * `null` — печати нет или она не разбирается: возвращать не к чему (сервер ответил бы отказом), и
 * пункта быть не должно.
 */
export interface ShellRevertPlan {
  vanishing: string[];
  home: string | null;
  etalonHome: string | null;
  etalonNav: string[];
  /** Печать эталона в записи — к ней ведёт возврат. */
  etalon: ReturnType<typeof parseAppPrint>;
}

export function shellRevertPlan(props: Readonly<Record<string, unknown>>): ShellRevertPlan | null {
  const text = props[SUPPLY_TEXT];
  if (typeof text !== 'string') return null;
  let etalon: ReturnType<typeof parseAppPrint>;
  try {
    etalon = parseAppPrint(text);
  } catch {
    return null;
  }
  const etalonNav = idsOf(etalon.props[APP_NAV]);
  const kept = new Set(etalonNav);
  return {
    vanishing: idsOf(props[APP_NAV]).filter((id) => !kept.has(id)),
    home: idOf(props[APP_HOME]),
    etalonHome: idOf(etalon.props[APP_HOME]),
    etalonNav,
    etalon,
  };
}

/** Ссылочные свойства места, из которых возврат вычищает архивные цели (R-16). */
const REF_PROPS = [APP_HOME, APP_NAV, APP_OPENS_OVER] as const;

/** id всех целей эталона: их живость решает, что возврат действительно вернёт. */
export function etalonRefIds(plan: ShellRevertPlan): string[] {
  return REF_PROPS.flatMap((p) => {
    const v = plan.etalon.props[p];
    return typeof v === 'string' ? [v] : idsOf(v);
  });
}

/**
 * Возвращать нечего (M-4 гейта 22): эталон без архивных и исчезнувших целей (`alive` — живые id)
 * совпадает с нынешним местом — сервер ответил бы отказом «отличие от поставки — только записи в
 * архиве». То же правило, что `withoutArchivedTargets` + сравнение печатей в `revertToEtalon`:
 * одиночная ссылка на неживую цель снимается, список — фильтруется, пустой список — снимается.
 */
export function revertIsNoop(
  row: { title: string; emoji: string | null; props: Record<string, unknown> },
  plan: ShellRevertPlan,
  alive: ReadonlySet<string>,
): boolean {
  const props: Record<string, unknown> = { ...plan.etalon.props };
  for (const p of REF_PROPS) {
    const v = props[p];
    if (typeof v === 'string' && !alive.has(v)) delete props[p];
    if (Array.isArray(v)) {
      const kept = v.filter((x) => typeof x === 'string' && alive.has(x));
      if (kept.length > 0) props[p] = kept;
      else delete props[p];
    }
  }
  return printAppProps(row) === printAppProps({ ...plan.etalon, props });
}
