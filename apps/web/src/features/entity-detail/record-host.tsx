import { createContext, type ReactNode, useContext } from 'react';
import type { ExtensionRecordHooks } from '../../app/extension-registry';
import type { RouterOutputs } from '../../trpc';

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
 * `extensionHooks` (прежде `planToFact`) и `openTab`. Разведка нашла их как пропы между частями одной вкладки; шаблон
 * разносит эти части по разным местам дерева, и держать их можно только выше обоих.
 */

type EntityGetReply = RouterOutputs['entity']['get'];
export type WireEntity = EntityGetReply['entity'];
export type WireRelation = NonNullable<EntityGetReply['relations']>[number];
export type Backlink = NonNullable<EntityGetReply['backlinks']>[number];
export type GoalProgress = NonNullable<EntityGetReply['goalProgress']>;
export type WireThread = NonNullable<EntityGetReply['thread']>;

/**
 * Ревизия тела показанной записи — замок текста (спека скорости §8.1). Ответ `entity.get` несёт её всегда
 * (`toWireEntityWithRevision`); тип необязателен лишь потому, что форма записи на клиенте общая со строками списков, у
 * которых ревизии нет. Запись без ревизии сюда попасть не должна, а если попала — сохранение тела с основой 0 не
 * уходит вовсе (`useBodySave`: текст лежит черновиком с основой 0 и предлагается выбором), а жесты меню и «вернуть
 * версию» получают отказ разбора (`expectedBodyRevision` — целое ≥ 1): отказ, а не текст, записанный вслепую.
 */
export function shownBodyRevision(entity: { bodyRevision?: number }): number {
  return entity.bodyRevision ?? 0;
}

export interface RecordHostValue {
  entity: WireEntity;
  relations: WireRelation[];
  backlinks: Backlink[];
  backlinksTruncated: boolean;
  /** Есть ТОЛЬКО у записи с аспектом `orbis/goal` (E2): у остальных поля нет вовсе. */
  goalProgress?: GoalProgress;
  thread: WireThread | null;
  /**
   * Реакции расширений на события записи (`useExtensionRecordHooks` реестра карточек) — сегодня
   * «план → факт» Финансов (§2.7): общее состояние у `{{title}}` и карточки `orbis/financial`.
   *
   * Поднимает его ТОЛЬКО чекбокс заголовка (единственный мутационный путь), а показывает карточка
   * финансов. Шаблон вправе поставить их в разные вкладки: состояние, живущее в одном из двух,
   * карточка не увидела бы никогда. Тип — из реестра: ядро не знает каталога Финансов (§8.4).
   */
  extensionHooks: ExtensionRecordHooks;
  /**
   * Открытая вкладка, на которой стоит блок; `null` — вкладка блока сейчас скрыта.
   *
   * Нужна списку версий: вкладки держат части смонтированными (keepMounted), и без признака
   * «меня видно» `version.list` уходил бы на каждом открытии записи, включая те, где на вкладку
   * с версиями никто не ходил. Сообщает это контейнер вкладок — оборачивая каждую часть в
   * `TabPartHost`; корень хоста (вне вкладок) несёт непустую строку: блок вне вкладок виден всегда.
   */
  openTab: string | null;
  /**
   * Запись только для чтения ЦЕЛИКОМ — предпросмотр шаблона на чужой записи (§9.3; 1а новое-5,
   * принцип §0.2 п. 2): не правится ничего — ни тело, ни заголовок с чекбоксом, ни теги,
   * подзадачи, блокировки, тред, свойства, карточки назначения, рутины и прогона, ни версии.
   * Запись взята для примера, и касание её не повод её менять. Экран записи ставит `false`.
   * Листья читают флаг сами (`useHostReadOnly`): каждый знает, что в нём правится.
   */
  readOnly: boolean;
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
 * Только чтение хоста; вне хоста — `false`: лист (строка записи, карточка назначения) живёт и вне
 * шаблона — в списках и на экранах модулей, — и там его поведение не меняется.
 */
export function useHostReadOnly(): boolean {
  return useContext(RecordHostContext)?.readOnly ?? false;
}

/**
 * Часть контейнера вкладок: дети видят `openTab` своей части — её значение, пока она открыта,
 * и `null`, пока скрыта (см. `RecordHostValue.openTab`).
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
    <RecordHostProvider value={{ ...host, openTab: open ? value : null }}>
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
  screen: Pick<RecordHostValue, 'extensionHooks' | 'openTab' | 'readOnly'>,
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
