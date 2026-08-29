// apps/web/src/lib/entity-ref/RefField.tsx
//
// ОДИН пикер ссылочного свойства на всё приложение (§А6-1, ref Р6).
//
// Что он заменил. До реформы «выбрать сущность» было написано ПЯТЬ раз: карточка категории
// на экране записи (`entity-detail/AspectCards.tsx`), пилюли и полный список быстрой записи
// (`budget/QuickAddBar.tsx`), выбор в форме конверта (`budget/EnvelopeCreateSheet.tsx`),
// лист рекатегоризации (`budget/TransactionsScreen.tsx`) и колонка сверки импорта
// (`import/ReviewTable.tsx`). Все пять умели ровно одно множество — категории — и знали его
// ЛИТЕРАЛОМ ЗАПРОСА, вшитым в код экрана. Ссылку на рутину, проект или что угодно ещё ни
// один из них выбрать не мог: множество не было параметром.
//
// Здесь множество — ЦЕЛЬ СВОЙСТВА ИЗ РЕЕСТРА (`{kind:'ref', target: Q-AST}`, §А6-1), и
// потому проверка «реализация одна» наблюдаема без грепа: свойство `orbis/finance_category`
// носят и операция (`orbis/financial`), и конверт (`orbis/budget`) — В1 слил их в одно
// свойство, — поэтому конверт получает пикер, которого ему никто отдельно не писал.
//
// Цель приезжает ДЕРЕВОМ и деревом же уезжает на сервер (`entity.query` со входом `ast`,
// §А5-4). Печатать её в текст грамматики нельзя: `or`/`not` плоский текст §А5-3 не
// выражает — печать даёт скобочную форму, которую разбор честно отвергает, — то есть
// половина законных целей отказывала бы на пикере, и отказ приходил бы не от нас.
import { effectiveLabel, OWNER_LOCALE, type PropertyDefinition } from '@orbis/shared';
import type { QueryAst, QueryFilterNode } from '@orbis/shared/query';
import { useState } from 'react';
import { type RouterOutputs, trpc } from '../../trpc';
import { FIELD_CLASS } from '../registry/controls';

/**
 * Потолок выдачи пикера. Число то же, что у прежнего списка категорий
 * (`CATEGORIES_QUERY, limit=200`): поведение переносится, а не меняется.
 *
 * Он же — ПРИЗНАК обрезания: движок общего числа не отдаёт, и «пришло РОВНО limit» —
 * единственное, что говорит «возможно, есть ещё» (тот же приём, что у счётчика строк на
 * экране транзакций). Ровно по этому признаку и появляется поле поиска: показывать его
 * всегда значило бы ставить лишний контрол в строку свойства, где список из шести
 * категорий виден целиком.
 */
export const REF_OPTIONS_LIMIT = 200;

/**
 * Подписи состояний ВЫБРАННОГО значения — константами, а не литералами в разметке: их
 * различие и есть предмет проверки (D5d п.5), и разъехавшийся текст в тесте и в коде дал бы
 * зелёный тест на любой из трёх веток.
 *
 * Слова ОБЩИЕ, а не «категория»/«рутина»: контрол один на все ссылочные свойства, а
 * склонять подпись свойства по падежам в коде — способ получить «Без Рутина прогона».
 */
const EMPTY_UNSELECTED = 'Не выбрано';
const LOADING = 'Загрузка…';
const LOAD_FAILED = 'Не удалось загрузить список';
const NOT_FOUND = 'Не найдено';

/** Сортировка выдачи — по заголовку: пикер читает человек, а не машина. */
const REF_SORT: QueryAst['sortBy'] = [{ field: 'orbis/title', dir: 'asc' }];

/**
 * Q-AST выдачи пикера: цель свойства ⊕ набранный фрагмент ⊕ проекция.
 *
 * Проекцию (`sortBy`/`limit`) добавляет ПИКЕР, а не реестр: §А6-1 запрещает их внутри
 * `target` — цель описывает МНОЖЕСТВО, а не то, как его показать. `search` там запрещён по
 * той же причине и приходит отсюда же.
 *
 * `target` может быть списком альтернативных множеств (§А6-1) — тогда это `or` по ним:
 * «ссылка ведёт в любое из».
 *
 * ЧЛЕН СПИСКА С `filter: null` РАСПУСКАЕТ ВЕСЬ СОЮЗ, а не выбрасывается из него. «Любая
 * сущность ∪ категории» — это «любая сущность»; выбросив пустой предикат, объединение
 * СУЗИЛОСЬ бы до соседа, то есть пикер молча показал бы меньше, чем разрешает реестр, —
 * ровно тот «невидимый отбор не того», против которого §С8-3. Сегодня недостижимо (все
 * встроенные цели одиночные), но правило дешевле оговорки: список целей — это часть §А6-1,
 * и первая же пользовательская цель пришла бы сюда без предупреждения.
 */
export function refQueryAst(
  target: QueryAst | QueryAst[] | undefined,
  search: string,
): QueryAst | null {
  if (target === undefined) return null;
  const targets = Array.isArray(target) ? target : [target];
  // Цель без единого предиката — это «любая сущность владельца», и это законно: `filter`
  // канона nullable именно затем (§А5-7).
  const anyEntity = targets.length === 0 || targets.some((t) => t.filter === null);
  const filters = targets.flatMap((t) => (t.filter === null ? [] : [t.filter]));
  const scope: QueryFilterNode | null = anyEntity
    ? null
    : filters.length === 1
      ? (filters[0] as QueryFilterNode)
      : { or: filters };
  const term = search.trim();
  const filter: QueryFilterNode | null =
    term === '' ? scope : scope === null ? { search: term } : { and: [scope, { search: term }] };
  return { filter, sortBy: REF_SORT, limit: REF_OPTIONS_LIMIT };
}

/** Цель свойства из его объявления; не `ref` или без цели — цели нет. */
export function refTargetOf(def: PropertyDefinition): QueryAst | QueryAst[] | undefined {
  return def.type.kind === 'ref' ? def.type.target : undefined;
}

type QueryEntity = RouterOutputs['entity']['query'][number];

/**
 * Выдача цели свойства — ОДИН запрос на цель и набранный фрагмент.
 *
 * Хук, а не голый `useQuery` внутри компонента, ровно потому, что читателей у одной и той
 * же выдачи двое: сам пикер и подпись уже выбранной ссылки (`useRefTitle`). Общий ключ
 * кеша (`{ast}`) делает их одним запросом — иначе строка «Категория: Еда» и её же список
 * ходили бы на сервер порознь.
 *
 * ЧТО ЭТОТ КЛЮЧ НЕ СВОДИТ ВОЕДИНО, и это названо честно: списки категорий на экранах
 * Финансов и импорта (бейджи строк, фильтр «Категория», пилюли быстрой записи) читают
 * БОЕВОЙ ТЕКСТ смарт-листа `CATEGORIES_QUERY` (`features/budget/categories.ts`), то есть
 * другой ключ кеша и второй запрос тех же строк на трёх экранах. Свести их сегодня нечем:
 * текст — часть описи боевых запросов (`production-queries.test.ts`), а цель пикера
 * приходит из реестра и текстом не выражается вовсе (см. шапку файла). Сойдутся они там,
 * где рукописный текст уступит место цели из реестра, — вместе с экраном «Свойства» (§С4-1,
 * срез Б-3).
 */
export function useRefOptions(
  def: PropertyDefinition | undefined,
  search = '',
): { options: QueryEntity[]; isPending: boolean; isError: boolean } {
  const ast = def === undefined ? null : refQueryAst(refTargetOf(def), search);
  const q = trpc.entity.query.useQuery(
    // `ast` здесь не `null`: запрос выключен, пока цели нет, а `enabled:false` до вызова
    // процедуры не доходит вовсе.
    { ast: ast ?? { filter: null } },
    { enabled: ast !== null },
  );
  return {
    // Array.isArray — та же защита от неожиданной формы ответа, что была у прежних пяти копий.
    options: Array.isArray(q.data) ? q.data : [],
    // Отключённый запрос (цели нет) у TanStack Query тоже в статусе pending — но показывать
    // там нечего, поэтому загрузкой считается только включённый.
    isPending: ast !== null && q.isPending && !q.isError,
    isError: ast !== null && q.isError,
  };
}

/**
 * Заголовок сущности, на которую ссылается свойство: поверхности, где иначе печатался бы
 * сырой uuid (шапка записи, сетка полей карточки чата, имя нового конверта).
 *
 * Три состояния, а не «строка»: на холодном кеше выдача доезжает не мгновенно, и без
 * `isPending` запасной uuid успевал мелькнуть и подмениться названием; `isError` — «список
 * не доехал вовсе», и печатать uuid там та же ложь, что мелькающий uuid на загрузке.
 * Условие `found === undefined` в `isError` обязательно: TanStack v5 сохраняет прежние
 * данные при отказе РЕФЕТЧА, и на уже известном списке правда — «название есть».
 *
 * Промах по известному списку даёт САМ ref: uuid — запасной вариант, а не пустое место,
 * иначе значение поля молча исчезало бы.
 */
export function useRefTitle(
  def: PropertyDefinition | undefined,
  refId: string,
): { title: string; isPending: boolean; isError: boolean } {
  // Пустая ссылка не поднимает запрос вовсе: с нефинансовых записей выдача не уходит.
  const target = refId === '' ? undefined : def;
  const { options, isPending, isError } = useRefOptions(target);
  const found = options.find((o) => o.id === refId);
  return {
    title: found?.title ?? refId,
    /**
     * Снимка реестра ещё нет — это ЗАГРУЗКА, а не «названия не будет». Разница наблюдаема:
     * без этой ветки строка поля успевала мелькнуть сырым uuid'ом и через кадр смениться
     * названием — ровно тот дефект, против которого `isPending` и заведён (D6d п.1), только
     * приехавший с другой стороны: раньше ждали выдачу, теперь ещё и определение цели.
     */
    isPending: isPending || (refId !== '' && def === undefined),
    isError: isError && found === undefined,
  };
}

/**
 * Пикер ссылки на сущность.
 *
 * `value`/`onChange` — как у любого контрола формы (`PropertyControl`): `onChange(undefined)`
 * означает СНЯТЬ значение, а не «записать пусто».
 *
 * Значок и заголовок — из самой выдачи: `orbis/icon` живёт на записи плоско (§А1-1), и
 * второго запроса ради него не нужно. Свойство, у которого значка не бывает (рутина,
 * проект), просто не покажет его — ветка одна на все цели.
 */
export function RefField({
  def,
  value,
  onChange,
  label,
  disabled = false,
}: {
  def: PropertyDefinition;
  value: unknown;
  onChange: (v: unknown | undefined) => void;
  /** Подпись контрола; по умолчанию — подпись свойства из реестра. */
  label?: string;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState('');
  const { options, isPending, isError } = useRefOptions(def, search);
  const name = label ?? effectiveLabel(def.label, OWNER_LOCALE);
  const current = typeof value === 'string' ? value : '';
  const known = current === '' || options.some((o) => o.id === current);
  /**
   * Поиск показывается, только когда выдача упёрлась в потолок: до этого список полон, и
   * поле ввода было бы контролом без работы. Он же остаётся на экране, пока в нём что-то
   * набрано, — иначе первый же фрагмент, срезавший список ниже потолка, убирал бы поле
   * вместе с набранным текстом.
   */
  const showSearch = options.length >= REF_OPTIONS_LIMIT || search !== '';

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {showSearch && (
        <input
          type="search"
          aria-label={`Поиск: ${name}`}
          placeholder="Поиск…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={`${FIELD_CLASS} w-28 shrink-0`}
        />
      )}
      <select
        aria-label={name}
        // Имя элемента — то же, что у остальных контролов формы (`PropertyControl`):
        // строка свойства адресуется одинаково, каким бы ни был её тип.
        data-testid={`prop-${def.id}`}
        data-kind="ref"
        disabled={disabled}
        className={FIELD_CLASS}
        value={current}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
      >
        {/* Пустой вариант — единственный способ СНЯТЬ ссылку из формы, и стоит он первым
            даже у заполненной: без него выбранное однажды значение не убрать вовсе.
            Подпись у него НЕ зависит от состояния выдачи: «значения нет» — свойство самой
            записи, и беда со списком не имеет права выглядеть как потерянная ссылка
            (D5d п.5а: пустая ссылка обязана пережить и загрузку, и отказ). */}
        <option value="">{EMPTY_UNSELECTED}</option>
        {/* Значение, которого нет в выдаче: оно есть В ДАННЫХ (цель сузилась, запись
            заархивирована — §А6-3), и без своей опции `select` показал бы пустоту и первым
            же изменением молча переставил бы ссылку.
            ТРИ причины «нет в выдаче» читаются по-разному, и это не косметика (D5d п.5):
            «список не доехал», «список не доехал ВООБЩЕ» и «список цел, а ссылка ведёт
            мимо» — три разных положения дел, и общий текст на все три врал бы про запись
            в двух случаях из трёх. Порядок веток: отказ — только когда данных нет вовсе
            (TanStack v5 держит прежнюю выдачу при отказе РЕФЕТЧА, и на известном списке
            правда — «ссылка ведёт в никуда»); затем загрузка (`isPending`, а не
            `isLoading`: офлайн-пауза даёт `isLoading === false` при `status:'pending'`). */}
        {!known && (
          <option value={current}>
            {isError && options.length === 0 ? LOAD_FAILED : isPending ? LOADING : NOT_FOUND}
          </option>
        )}
        {options.map((o) => {
          const icon = o.props['orbis/icon'];
          return (
            <option key={o.id} value={o.id}>
              {typeof icon === 'string' && icon !== '' ? `${icon} ` : ''}
              {o.title}
            </option>
          );
        })}
      </select>
    </span>
  );
}
