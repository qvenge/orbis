import { createContext, type ReactNode, useContext } from 'react';
import type { RouterOutputs } from '../../trpc';
import type { usePlanToFactPrompt } from '../budget/usePlanToFactPrompt';

/**
 * Хост записи: данные, которые примитивы обвязки (`title`, `body`, `card: X`, `subtasks`, …;
 * спека страниц 1а §7.3) берут из запроса записи `this`, а не пропами от экрана.
 *
 * Зачем контекст. Примитив стоит там, куда его поставил шаблон, — во вкладке, в колонке, под
 * блоком данных, — и протаскивать `relations` или `goalProgress` пропами через контейнеры
 * рендерера значило бы учить каждый контейнер данным, которых он не касается. Источник у всех
 * один — ответ `entity.get` экрана (`useEntityDetail`, ключ `detailGetInput(id)`); второго
 * запроса записи хост не заводит.
 *
 * Два поля — не данные запроса, а СВЯЗИ экрана, которые разрез обязан сохранить (Ф-1а-18):
 * `planToFact` и `activeTab`. Разведка нашла их как пропы между частями одной вкладки; шаблон
 * разносит эти части по разным местам дерева, и держать их можно только выше обоих.
 */

type EntityGetReply = RouterOutputs['entity']['get'];
export type WireEntity = EntityGetReply['entity'];
export type WireRelation = NonNullable<EntityGetReply['relations']>[number];
export type Backlink = NonNullable<EntityGetReply['backlinks']>[number];
export type GoalProgress = NonNullable<EntityGetReply['goalProgress']>;
export type WireThread = NonNullable<EntityGetReply['thread']>;

export interface RecordHostValue {
  entity: WireEntity;
  relations: WireRelation[];
  backlinks: Backlink[];
  backlinksTruncated: boolean;
  /** Есть ТОЛЬКО у записи с аспектом `orbis/goal` (E2): у остальных поля нет вовсе. */
  goalProgress?: GoalProgress;
  thread: WireThread | null;
  /**
   * Состояние карточки «план → факт» (§2.7) — общее у `{{title}}` и карточки `orbis/financial`.
   *
   * Поднимает его ТОЛЬКО чекбокс заголовка (единственный мутационный путь, `usePlanToFactPrompt`),
   * а показывает карточка финансов. Шаблон вправе поставить их в разные вкладки: состояние,
   * живущее в одном из двух, карточка не увидела бы никогда.
   */
  planToFact: ReturnType<typeof usePlanToFactPrompt>;
  /**
   * Открытая вкладка, на которой стоит блок; `null` — вкладка блока сейчас скрыта.
   *
   * Нужна списку версий: вкладки держат части смонтированными (keepMounted), и без признака
   * «меня видно» `version.list` уходил бы на каждом открытии записи, включая те, где на вкладку
   * с версиями никто не ходил. Сообщает это контейнер вкладок — оборачивая каждую часть в
   * `TabPartHost`; корень хоста (вне вкладок) несёт непустую строку: блок вне вкладок виден всегда.
   */
  activeTab: string | null;
  /**
   * Тело только для чтения — предпросмотр шаблона на чужой записи (§6.2, §9.3): показ шаблона
   * не повод править тело записи, выбранной для примера. Экран записи ставит `false`.
   */
  readOnlyBody: boolean;
}

const RecordHostContext = createContext<RecordHostValue | null>(null);

export function RecordHostProvider({
  value,
  children,
}: {
  value: RecordHostValue;
  children: ReactNode;
}) {
  return <RecordHostContext.Provider value={value}>{children}</RecordHostContext.Provider>;
}

/**
 * Хост ближайшей записи. Вне хоста — ошибка, а не пустышка: примитив без записи показал бы
 * пустое место там, где на деле сломана обвязка, и это заметили бы только глазами.
 */
export function useRecordHost(): RecordHostValue {
  const value = useContext(RecordHostContext);
  if (value === null) throw new Error('Примитив обвязки записи вне RecordHostProvider');
  return value;
}

/**
 * Часть контейнера вкладок: дети видят `activeTab` своей части — её значение, пока она открыта,
 * и `null`, пока скрыта (см. `RecordHostValue.activeTab`).
 */
export function TabPartHost({
  value,
  open,
  children,
}: {
  value: string;
  open: boolean;
  children: ReactNode;
}) {
  const host = useRecordHost();
  return (
    <RecordHostProvider value={{ ...host, activeTab: open ? value : null }}>
      {children}
    </RecordHostProvider>
  );
}

/**
 * Значение хоста из ответа `entity.get` экрана. Необязательные поля ответа сводятся здесь, один
 * раз: `relations ?? []` в каждом примитиве — шесть копий одного правила.
 */
export function recordHostValue(
  reply: EntityGetReply,
  screen: Pick<RecordHostValue, 'planToFact' | 'activeTab' | 'readOnlyBody'>,
): RecordHostValue {
  return {
    entity: reply.entity,
    relations: reply.relations ?? [],
    backlinks: reply.backlinks ?? [],
    backlinksTruncated: reply.backlinksTruncated === true,
    ...(reply.goalProgress === undefined ? {} : { goalProgress: reply.goalProgress }),
    thread: reply.thread ?? null,
    ...screen,
  };
}
