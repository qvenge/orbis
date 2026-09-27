import { APP_HOME, APP_NAV, SUPPLY_TEXT } from '@orbis/shared';
import { parseAppPrint } from '@orbis/shared/supply/print';

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
  };
}
