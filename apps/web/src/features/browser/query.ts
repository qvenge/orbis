import { APP_ASPECT, PAGE_ASPECT } from '@orbis/shared';
import { parsePageText } from '@orbis/shared/doc/page-grammar';
import { quoteQueryValue } from '@orbis/shared/query';

export type FilterState = {
  tags: string[];
  aspects: string[];
  /**
   * Границы создания в форме `YYYY-MM-DD`.
   *
   * ИЗВЕСТНЫЙ ОСТАТОК, названный вслух и НЕ заведённый реформой: `orbis/created_at` —
   * свойство типа timestamp, и разбор ждёт от него полный момент ISO 8601, а не день. Дата
   * без времени отвергалась и старой грамматикой (опись боевых текстов, `ast-fixtures.ts`:
   * «ломается в самом старом парсере»), так что поведение здесь ровно прежнее. Живёт это
   * поле сегодня без единого производителя: `Filters` заполняет только `tags`, и построить
   * такой запрос из интерфейса нельзя ни одним действием.
   */
  createdFrom: string | null;
  createdTo: string | null;
};

export function buildFilterQuery(f: FilterState): string {
  // Грамматика §А5-3: конструкции через запятую; OR внутри значения — '|'; сравнения строгие.
  // Имена свойств — namespaced key реестра (§А5-3а), значения тегов — через общий квотировщик
  // печати (`quoteQueryValue`): пробел стал разделителем конструкций, и тег владельца
  // «личные дела» без кавычек рвал запрос надвое.
  const clauses: string[] = [];
  if (f.tags.length) clauses.push(`tags=${f.tags.map(quoteQueryValue).join('|')}`);
  for (const a of f.aspects) clauses.push(`aspect=${a}`);
  if (f.createdFrom) clauses.push(`orbis/created_at>${f.createdFrom}`);
  if (f.createdTo) clauses.push(`orbis/created_at<${f.createdTo}`);
  return clauses.join(', ');
}

/**
 * Отрицания общего списка «Записей» (спека 1б §9.6): страницы и приложения там по умолчанию не
 * показываются — это обёртки над записями, а не сами записи, и в общем списке они тонули бы среди
 * заметок и задач. Поиск (задача 24) исключает их из группы «Записи» тем же текстом, чтобы
 * показать отдельными группами.
 */
export const RECORDS_HIDE_PAGES_AND_APPS = `!aspect=${PAGE_ASPECT}, !aspect=${APP_ASPECT}`;

/**
 * Текст запроса списка «Записей». `showPagesAndApps` — обязательный, без умолчания: забытый
 * аргумент молча показал бы или спрятал страницы, и ни один вызыватель этого бы не заметил.
 */
export function browserQuery({
  limit,
  filters,
  showPagesAndApps,
}: {
  limit: number;
  filters: string;
  showPagesAndApps: boolean;
}): string {
  const clauses = [filters, showPagesAndApps ? '' : RECORDS_HIDE_PAGES_AND_APPS].filter(Boolean);
  const base = clauses.length > 0 ? `${clauses.join(', ')}, ` : '';
  return `${base}sortBy=orbis/updated_at:desc, limit=${limit}`;
}

/**
 * Первый блок данных тела — и только он: §3.2 нормирует бейдж pinned-сущности как «число
 * результатов ПЕРВОГО query-блока её body» (у Daily Planning это размер Inbox). Потребителя в
 * интерфейсе с среза 1б нет: закреплённые сняты, бейдж раздела навигации считает сервер тем же
 * правилом (`entity.blocks {badgeOf}`, РП-8). Правило держат тесты этого файла; снять функцию —
 * вместе с правкой сторожа `scripts/grammar-copies.test.ts` (он числит этот файл читателем грамматики).
 *
 * Блоки узнаёт препроход тела (`parsePageText`) — одна копия правил маркеров (РП-6): прежний
 * свой регэксп (`bodySegments`) снят вместе с первым кадром, который на нём жил. Блок ищется
 * только на верхнем уровне тела: у заметки контейнеров нет, а бейдж страницы с раскладкой —
 * забота размещений (1б).
 */
export function firstQueryBlock(body: string): string | null {
  const first = parsePageText(body).find((n) => n.kind === 'query');
  return first?.kind === 'query' ? first.text.trim() : null;
}
