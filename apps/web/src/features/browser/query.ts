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

export function browserQuery({ limit, filters }: { limit: number; filters: string }): string {
  const base = filters ? `${filters}, ` : '';
  return `${base}sortBy=orbis/updated_at:desc, limit=${limit}`;
}

/**
 * Первый блок данных тела — и только он: §3.2 нормирует бейдж pinned-сущности как «число
 * результатов ПЕРВОГО query-блока её body» (у Daily Planning это размер Inbox). Единственный
 * потребитель — PinnedList (счётчик закреплённого остаётся отдельным `entity.count`, спека
 * страниц 1а §6.3).
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
