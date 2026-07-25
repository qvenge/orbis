// Task C4b (03-budget §3.4.1): имя источника выписки → `namespace` строки
// entity_origins. Чистая функция без DOM и запросов — она попадает в уникальный ключ
// (owner_id, namespace, external_id) НАВСЕГДА, поэтому живёт отдельным модулем с
// собственными тестами, а не строкой внутри экрана.
//
// Смысл вырезания дат: «выписка_май_01.05.2026.csv» и «выписка_май_02.06.2026.csv» —
// один и тот же счёт. Без нормализации повторная выгрузка того же периода расползлась
// бы по разным пространствам имён и получила бы статус ✓ вместо ⟳ (§3.4 шаг 3).

/** Максимум хвоста после `csv:` — с запасом влезает в лимит 80 схемы сервера. */
const MAX_SOURCE_CHARS = 40;

/** DD.MM.YYYY / YYYY-MM-DD (любой из разделителей `.`, `-`, `_`). */
const DATE_PATTERNS = [/\d{2}[.\-_]\d{2}[.\-_]\d{4}/g, /\d{4}[.\-_]\d{2}[.\-_]\d{2}/g];
/** Отдельно стоящая группа 6–8 цифр: 20260501, 010526. Соседние цифры запрещены
 *  границами — номер счёта из 4 или id из 9 цифр датой не считается. */
const BARE_DATE_DIGITS = /(?<!\d)\d{6,8}(?!\d)/g;

/**
 * `csv:<нормализованное имя файла без даты>` (§3.4.1). Правило: имя без расширения →
 * lowercase → вырезать датоподобные куски → всё не буква/цифра в `-` → схлопнуть и
 * срезать по краям → обрезать до 40 символов → пусто заменить на `statement`.
 */
export function csvNamespace(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[^./\\]*$/, '');
  let source = withoutExtension.toLowerCase();
  for (const pattern of DATE_PATTERNS) source = source.replace(pattern, ' ');
  source = source.replace(BARE_DATE_DIGITS, ' ');
  source = source
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    // хвостовой дефис после обрезки — артефакт границы, а не часть имени источника
    .slice(0, MAX_SOURCE_CHARS)
    .replace(/-+$/, '');
  return `csv:${source === '' ? 'statement' : source}`;
}
