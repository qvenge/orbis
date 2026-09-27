import type { ExtensionId } from '@orbis/shared';
import type { ComponentType } from 'react';
import { FinancialCard } from '../extensions/finance/FinancialCard';
import { GoalCard } from '../extensions/goals/GoalCard';
import type { WireEntity } from '../features/entity-detail/record-host';

/**
 * Реестр карточек расширений (спека 1б §4.1; РП-23, С1б-10) — ЕДИНСТВЕННОЕ место web, которому
 * разрешено импортировать каталоги расширений (`apps/web/src/extensions/*`), «корень сборки».
 *
 * Манифест расширения (shared, `EXTENSION_MANIFESTS`) объявляет, У КАКОГО аспекта своя карточка и её
 * ранг; компонент — дело web, и связывает их этот реестр. Ядро (экран записи, `{{cards: own}}`) знает
 * карточки расширений только через него: каталог расширения, импортированный кодом ядра напрямую,
 * сделал бы ядро зависимым от расширения, которое владелец вправе выключить.
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
