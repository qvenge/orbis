import type { RecordBlockName } from '@orbis/shared/doc/page-grammar';
import type { ComponentType } from 'react';
import { ThisEntityProvider } from '../../lib/query-blocks/this-entity';
import { Backlinks } from './Backlinks';
import { Blockers } from './Blockers';
import { EntityBody, ReadOnlyEntityBody, useBodyScreen } from './EntityBody';
import { EntityThreadTab } from './EntityThreadTab';
import { NativeRow } from './NativeRow';
import { useRecordHost } from './record-host';
import { Subtasks } from './Subtasks';
import { TagsBlock } from './TagsBlock';
import { useRecordEdits } from './useEntityDetail';
import { VersionsCard } from './VersionsCard';

/**
 * Примитивы обвязки записи по имени блока (спека страниц 1а §5.3, §7.3). Каждый показывает
 * запись `this` из хоста (`record-host.tsx`) и пропов не берёт: его ставит шаблон, и знать, что
 * у экрана лежит в каком поле, ему незачем.
 */

/**
 * `{{title}}` — эмодзи и строка заголовка (сегодняшняя шапка «Сущности»).
 *
 * Правит запись сам (`useRecordEdits`), а карточку «план → факт» поднимает в ХОСТЕ: показывает
 * её карточка `orbis/financial`, которую шаблон вправе поставить в другую вкладку (Ф-1а-18).
 */
export function TitleBlock() {
  const { entity, planToFact } = useRecordHost();
  // Флаг `conflict` этого экземпляра никуда не выведен — и не может зажечься: заголовок и
  // чекбокс сервер проводит по LWW, версию он сверяет только у правок тела (`executor.ts`, гейт
  // §5.2 под `body || bodyDoc`), так что 409 у них не бывает. Откат при прочих отказах — в
  // самой обвязке (`useEntityUpdate`).
  const { toggleTask, saveTitle } = useRecordEdits(entity.id, entity);
  return (
    // Notion-style шапка страницы: крупная emoji-иконка над заголовком. Нет emoji — ничего не
    // рендерим (без плейсхолдера); в самой шапке экрана — только title.
    <div className="flex flex-col gap-3">
      {entity.emoji && (
        <span aria-hidden className="text-4xl leading-none">
          {entity.emoji}
        </span>
      )}
      <NativeRow
        entity={entity}
        onToggleTask={(done) => {
          toggleTask(done);
          // Данные сущности ДО перевода: planned ещё true — карточка на переходе в done
          if (done) planToFact.onTaskDone(entity);
        }}
        onSaveTitle={saveTitle}
      />
    </div>
  );
}

/**
 * `{{body}}` — тело записи.
 *
 * РАЗМОНТИРУЕМОЕ по key: роутер монтирует экран записи БЕЗ key (router.tsx), переход
 * entity→entity меняет лишь проп, — а `useBodySave` при смене `entityId` под тем же хуком теряет
 * отложенное МОЛЧА. Без размонтирования таймер паузы со старым id дописал бы старый документ в
 * новую запись. key по id, НЕ по updatedAt: рефетч после каждого сохранения ремоунтил бы
 * редактор, стирая набранное за время запроса.
 *
 * Провайдер `this` — вокруг ТЕЛА, потому что `this` в блоках данных (§6.1) означает запись, чьё
 * тело этот блок содержит.
 *
 * `readOnlyBody` хоста (предпросмотр шаблона на чужой записи, §9.3) — тело только для чтения:
 * первый кадр без редактора, без сохранения и черновиков. Запись взята для примера, и касание её
 * тела не повод его править.
 */
export function BodyBlock() {
  const { entity, readOnlyBody } = useRecordHost();
  const screen = useBodyScreen();
  return (
    <ThisEntityProvider id={entity.id}>
      {readOnlyBody ? (
        <ReadOnlyEntityBody entity={entity} />
      ) : (
        <EntityBody key={entity.id} entity={entity} {...screen} />
      )}
    </ThisEntityProvider>
  );
}

export function SubtasksBlock() {
  const { entity, relations } = useRecordHost();
  return <Subtasks parentId={entity.id} relations={relations} />;
}

export function BlockersBlock() {
  const { entity, relations } = useRecordHost();
  return <Blockers entityId={entity.id} relations={relations} />;
}

export function BacklinksBlock() {
  const { backlinks, backlinksTruncated } = useRecordHost();
  return <Backlinks items={backlinks} truncated={backlinksTruncated} />;
}

/**
 * `{{versions}}` — версии тела. Список идёт в сеть только на открытой вкладке (`activeTab`), а
 * key — как у ленты прогона: у карточки своё состояние (выбранная версия, отказ
 * восстановления), и переезжать на соседнюю запись оно не должно.
 */
export function VersionsBlock() {
  const { entity, activeTab } = useRecordHost();
  return <VersionsCard key={`versions-${entity.id}`} entity={entity} active={activeTab !== null} />;
}

/**
 * `{{thread}}` — тред записи. key по id — у вкладки есть память о ЗАВЕДЁННОМ треде (см.
 * EntityThreadTab), и, переехав на соседнюю запись, она отдала бы её сообщения в чужой тред.
 */
export function ThreadBlock() {
  const { entity, thread } = useRecordHost();
  if (thread === null) return <p className="p-3 text-sm text-text-muted">Нет треда</p>;
  return <EntityThreadTab key={`thread-${entity.id}`} entityId={entity.id} />;
}

/**
 * Примитивы блоков обвязки. `{{cards}}` здесь НЕТ: его рисует рендерер (`RestCards` с множеством
 * карточек, размещённых `{{card: X}}` этого дерева, и без карточки «Страница» у страницы своим
 * телом, РП-25). Примитив без этих знаний был бы второй дорогой к `{{cards}}`, по которой
 * карточки показались бы дважды (финальное ревью, C2-M1).
 */
export const RECORD_BLOCK_COMPONENTS: Readonly<
  Record<Exclude<RecordBlockName, 'cards'>, ComponentType>
> = {
  title: TitleBlock,
  tags: TagsBlock,
  body: BodyBlock,
  subtasks: SubtasksBlock,
  blockers: BlockersBlock,
  backlinks: BacklinksBlock,
  versions: VersionsBlock,
  thread: ThreadBlock,
};
