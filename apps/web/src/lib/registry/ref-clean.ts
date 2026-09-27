/**
 * Вычистка списка ссылок перед записью (срез 1б §4.4, Фокус ревью п. 2): архивные и исчезнувшие цели
 * убираются клиентом, иначе проверка ссылок исполнителя (`assertRefValue`) отвергла бы ВСЮ правку
 * («цель архивна», «цель не найдена») — и перестановку, и добавление, и удаление.
 *
 * Чистые функции без React: ими пишут «Навигацию» меню «⋯», диалог «Добавить в навигацию», редактор
 * «Настроить навигацию» (`features/apps`) и карточка записи-приложения (`RefListField`) — одно
 * правило на все пути записи.
 */

/**
 * Вычистить разделы, на которые ссылаться уже нельзя, — архивные (§4.4) и исчезнувшие (удалена,
 * чужая): оба сервер отверг бы проверкой ссылок, и правка навигации, которую владелец видит
 * законной, не записалась бы вовсе.
 */
export function cleanNav(nav: readonly string[], archivedIds: ReadonlySet<string>): string[] {
  return nav.filter((id) => !archivedIds.has(id));
}

/** Ответ `entity.resolveRefs` — сколько нужно правилу: id и признак архива. */
interface ResolvedRef {
  id: string;
  archived: boolean;
}

/**
 * Какие из `ids` вычищать при записи: архивные и те, кого ответ не знает (удалены, чужие). Ответа
 * нет — `null`: вычищать вслепую нельзя, а записать как есть — значит упасть на проверке ссылок.
 */
export function goneOf(
  ids: readonly string[],
  resolved: readonly ResolvedRef[] | undefined,
): ReadonlySet<string> | null {
  if (ids.length === 0) return new Set();
  if (resolved === undefined) return null;
  const alive = new Set(resolved.filter((r) => !r.archived).map((r) => r.id));
  return new Set(ids.filter((id) => !alive.has(id)));
}

/** Ключ `entity.resolveRefs` для набора id: без порядка и повторов — перестановка не зовёт сеть. */
export function refIdsKey(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}
