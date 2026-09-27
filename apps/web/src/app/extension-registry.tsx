import type { ExtensionId } from '@orbis/shared';
import type { ComponentType } from 'react';
import { FinancialCard } from '../extensions/finance/FinancialCard';
import { GoalCard } from '../extensions/goals/GoalCard';
import { usePlanToFactPrompt } from '../features/budget/usePlanToFactPrompt';
import type { WireEntity } from '../features/entity-detail/record-host';
import { useExtensionEnabled } from '../features/settings/extension-mask';

/**
 * Реестр карточек расширений (спека 1б §4.1; РП-23, С1б-10) — ЕДИНСТВЕННОЕ место web, которому
 * разрешено импортировать каталоги расширений (`apps/web/src/extensions/*`), «корень сборки».
 *
 * Манифест расширения (shared, `EXTENSION_MANIFESTS`) объявляет, У КАКОГО аспекта своя карточка и её
 * ранг; компонент — дело web, и связывает их этот реестр. Ядро (экран записи, `{{cards: own}}`) знает
 * карточки расширений только через него: каталог расширения, импортированный кодом ядра напрямую,
 * сделал бы ядро зависимым от расширения, которое владелец вправе выключить.
 *
 * Кроме карточек через реестр идут РЕАКЦИИ расширений на события записи (`useExtensionRecordHooks`):
 * ядро сообщает «задача закрыта», а что из этого следует для Финансов, знают Финансы.
 */

/** Своя карточка аспекта: что рисовать, у какой записи и чья она. */
export interface OwnCard {
  Card: ComponentType;
  /**
   * Показывать ли карточку у этой записи. Обычно — «аспект навешен», но не всегда: карточка
   * назначения стоит у ЛЮБОЙ задачи, потому что исполнителя ставит владелец, и именно этим жестом
   * задача становится тикетом (ревью задачи 12 1а, I-2).
   */
  showWhen: (e: Pick<WireEntity, 'aspects'>) => boolean;
  /** Расширение, чья это карточка (id манифеста, объявившего её); `null` — карточка ядра. */
  extension: ExtensionId | null;
}

const hasAspect =
  (aspectId: string) =>
  (entity: Pick<WireEntity, 'aspects'>): boolean =>
    entity.aspects.includes(aspectId);

/**
 * Карточки расширений по аспекту — ровно те, что объявлены в `cards` манифестов (сверка —
 * `extension-registry.test.tsx`): карточка без объявления встала бы вне порядка рангов, объявление
 * без карточки молча пропало бы с экрана.
 */
export const EXTENSION_CARDS: Readonly<Record<string, OwnCard>> = {
  'orbis/goal': { Card: GoalCard, showWhen: hasAspect('orbis/goal'), extension: 'goals' },
  'orbis/financial': {
    Card: FinancialCard,
    showWhen: hasAspect('orbis/financial'),
    extension: 'finance',
  },
};

/**
 * Реакции расширений на события записи — связь экрана записи, которую держит хост (Ф-1а-18): чекбокс
 * `{{title}}` сообщает о закрытии задачи, а карточка «план → факт» Финансов, которую шаблон вправе
 * поставить в другую вкладку, показывает поднятое состояние.
 */
export interface ExtensionRecordHooks {
  /** Чекбокс {{title}} перевёл задачу в done — реакция расширений (Финансы: «план → факт»); выключенное молчит (§8.4). */
  onTaskDone(entity: { id: string; props: Record<string, unknown> }): void;
  /** Состояние карточки «план → факт» — читает `PlanToFactSlot` Финансов через хост записи. */
  finance: ReturnType<typeof usePlanToFactPrompt>;
}

/**
 * Реакции расширений для хоста записи (экран записи и страница своим телом). Хуки безусловны; маска
 * решает только, дойдёт ли событие: при выключенных Финансах «план → факт» молчит — их карточка на
 * записи уже показывает плашку, а сервер отказал бы `budget.confirmPurchase` (§8.3, задача 7).
 */
export function useExtensionRecordHooks(): ExtensionRecordHooks {
  const finance = usePlanToFactPrompt();
  const financeOn = useExtensionEnabled('finance');
  return {
    onTaskDone: (entity) => {
      if (financeOn) finance.onTaskDone(entity);
    },
    finance,
  };
}
