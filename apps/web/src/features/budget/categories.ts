// Общий список категорий Budget: запрос §6.1 + маппинг wire-сущности в опцию выбора.
// Делят QuickAddBar (§3.6: пилюли/полный выбор) и TransactionsScreen (§3.3: фильтр
// категории + Sheet рекатегоризации) — один запрос, один кэш tRPC.
import { type RouterOutputs, trpc } from '../../trpc';

type QueryEntity = RouterOutputs['entity']['query'][number];

export const CATEGORIES_QUERY = 'aspect=orbis/category, sortBy=title:asc, limit=200';

export type CategoryOption = {
  id: string;
  title: string;
  icon: string | null;
  /** `orbis/category.color` (#RRGGBB, §3.6 реестра) — подсветка бейджа §3.3. */
  color: string | null;
};

/**
 * Название категории по её id (D6c п.2): поверхности, где раньше печатался сырой
 * category_ref (шапка detail, сетка полей карточки чата). Источник — ТОТ ЖЕ запрос и
 * тот же кэш, что у пикера категории (CATEGORIES_QUERY): второго источника категорий
 * в приложении нет.
 *
 * Ссылка в неизвестную категорию → возвращается сам ref: uuid — запасной вариант,
 * а не пустое место, иначе значение поля молча исчезало бы.
 *
 * `isPending` (D6d п.1) отличает «ещё грузится» от «не найдена»: на холодном кэше
 * (вход в detail из Chat/Browser) список категорий доезжает за ~200 мс, и без этого
 * признака запасной uuid успевал мелькнуть и подмениться названием. Потребитель обязан
 * НЕ рисовать бейдж/строку поля, пока `isPending`.
 *
 * `isError` (уборочная фаза) — третье состояние: список НЕ доехал вовсе (сеть или
 * BAD_REQUEST парсера запроса на непересеянном реестре аспектов). Названия у нас нет и
 * не будет, поэтому печатать uuid — та же ложь, что мелькающий uuid на загрузке; условие
 * `!found` обязательно: TanStack v5 сохраняет прежние data при отказе РЕФЕТЧА, и на уже
 * известном списке правда — «название есть», а не «ошибка».
 */
export function useCategoryTitle(categoryRef: string): {
  title: string;
  isPending: boolean;
  isError: boolean;
} {
  // enabled: непустой ref — с нефинансовых сущностей запрос категорий не уходит вовсе
  // (та же бережливость, что у пикера AspectCards, смонтированного только на financial).
  const q = trpc.entity.query.useQuery(
    { query: CATEGORIES_QUERY },
    { enabled: categoryRef !== '' },
  );
  // Array.isArray — та же защита от неожиданной формы ответа, что в TransactionsScreen.
  const found = (Array.isArray(q.data) ? q.data : []).find((e) => e.id === categoryRef);
  return {
    title: found?.title ?? categoryRef,
    // Отключённый запрос (пустой ref) у TanStack Query тоже в статусе pending — но там и
    // показывать нечего, поэтому загрузкой считается только непустой ref. Ошибка чтения
    // pending снимает — она отдельное состояние ниже.
    isPending: categoryRef !== '' && q.isPending && !q.isError,
    isError: categoryRef !== '' && q.isError && found === undefined,
  };
}

export function toOption(e: QueryEntity): CategoryOption {
  const cat = (e.aspects as Record<string, { icon?: unknown; color?: unknown } | undefined>)[
    'orbis/category'
  ];
  return {
    id: e.id,
    title: e.title,
    icon: typeof cat?.icon === 'string' && cat.icon !== '' ? cat.icon : null,
    color: typeof cat?.color === 'string' && cat.color !== '' ? cat.color : null,
  };
}
