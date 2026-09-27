/**
 * Правка навигации — клиентом одной пачкой; архивные id вычищаются, иначе сервер отверг бы правку
 * «цель архивна» (§4.4, РП-22).
 *
 * Навигация хранится у записи-приложения (срез 1б §4.4): «Навигация» — список id разделов, порядок
 * значения — порядок разделов. Здесь — чистые правила над этим списком и операции пачки
 * `entity.updateBatch` для «Новое приложение…» (§9.5). Ни запросов, ни React: их зовут меню «⋯»,
 * диалог «Добавить в навигацию» и редактор «Настроить навигацию» — правило одно на троих.
 *
 * Почему вычищать ДО записи, а не полагаться на сервер: проверка ссылок исполнителя смотрит на
 * записываемое значение целиком (`assertRefValue`), и архивный раздел, который владелец не трогал,
 * отверг бы любую следующую правку навигации — перестановку, добавление, удаление. Плашка «в архиве»
 * (§6.6) — достаточный сигнал до этой правки; после неё раздела нет, а сама запись раздела цела.
 */
import { APP_ASPECT, APP_HOME, APP_NAV, APP_NAV_FORM, type NavForm } from '@orbis/shared';
import type { UpdateBatchOperation } from '../page/useUpdateBatch';

/** Навигация записи-приложения; не список id — пусто (испорченное значение правкой заменяется). */
export function navOf(props: Readonly<Record<string, unknown>>): string[] {
  const nav = props[APP_NAV];
  return Array.isArray(nav) ? nav.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Поставить раздел в конец навигации — БЕЗ ДУБЛЕЙ (§9.3): раздел уже стоит — тот же список, тем же
 * значением (не копией), порядок прочих не трогается. Второй экземпляр id дал бы в листе разделов
 * два одинаковых раздела с одной стопкой на двоих.
 */
export function withSection(nav: readonly string[], id: string): readonly string[] {
  return nav.includes(id) ? nav : [...nav, id];
}

/**
 * Стоит ли запись в навигации — «поставить её ничего не изменит». Одно определение на меню
 * («Добавить» или «Убрать») и диалог (приложение, где запись уже стоит, не предлагается): иначе
 * меню и диалог разошлись бы в ответе на один вопрос.
 */
export function inNav(nav: readonly string[], id: string): boolean {
  return withSection(nav, id) === nav;
}

/** Убрать раздел из навигации; прочие — в прежнем порядке. */
export function withoutSection(nav: readonly string[], id: string): string[] {
  return nav.filter((x) => x !== id);
}

/**
 * Вычистка ссылок (`cleanNav`, `goneOf`, `refIdsKey`) живёт в `lib/registry/ref-clean.ts`: ею же
 * пишет «Навигацию» карточка записи-приложения (`RefListField`), а `lib` не зовёт `features`.
 * Здесь — реэкспорт: правило одно на меню, диалог, редактор и карточку.
 */
export { cleanNav, goneOf, refIdsKey } from '../../lib/registry/ref-clean';

export interface NewApp {
  title: string;
  emoji: string;
  /** Домашняя — выбранная страница; нет — приложение без домашней (§9.5). */
  homeId?: string;
  navIds: readonly string[];
  form: NavForm;
  /** id новой записи; по умолчанию — свежий. Задаёт клиент: на него ссылаются правки следом (§9.3). */
  id?: string;
}

/**
 * «Новое приложение…» (§9.5) — ОДНА операция пачки: создать запись-приложение с домашней,
 * навигацией и формой. Одна пачка — один Undo.
 *
 * «Дом» странице клиент НЕ пишет: бездомная, поставленная домашней или разделом приложения, получает
 * «Дом» на сервере той же пачкой (§4.3, задача 10 `applyHomeFollowUps`) — одно правило для владельца
 * и агента. Написанный здесь «Дом» поставил бы его и НЕ бездомной странице (она уже стоит в
 * навигации хоста), вопреки определению §4.3.
 *
 * Навигация пишется списком и пустой: без списка запись-приложение читается испорченной
 * (`useAppShell`, `shellOf`).
 */
export function newAppOps(app: NewApp): UpdateBatchOperation[] {
  const emoji = app.emoji.trim();
  return [
    {
      tool: 'entity_create',
      input: {
        id: app.id ?? crypto.randomUUID(),
        title: app.title.trim(),
        ...(emoji !== '' && { emoji }),
        tags: [],
        aspects: [APP_ASPECT],
        props: {
          ...(app.homeId !== undefined && { [APP_HOME]: app.homeId }),
          [APP_NAV]: [...app.navIds],
          [APP_NAV_FORM]: app.form,
        },
      },
    },
  ];
}
