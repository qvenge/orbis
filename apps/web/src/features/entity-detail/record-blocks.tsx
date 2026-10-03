import type { RecordBlockName } from '@orbis/shared/doc/page-grammar';
import {
  type ComponentType,
  lazy,
  Suspense,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { ThisEntityProvider } from '../../lib/query-blocks/this-entity';
import { resetSteps, stepsGeneration } from '../entity-editor/arrows-stack';
import { mountRecord } from '../entity-editor/editor-cache';
import { observeTitleValue } from '../entity-editor/title-history';
import { isUndoEpoch, undoEpoch } from '../undo/undo-epoch';
import { Backlinks } from './Backlinks';
import { Blockers } from './Blockers';
import { EntityBody, ReadOnlyEntityBody, useBodyArrows, useBodyScreen } from './EntityBody';
import { EntityThreadTab } from './EntityThreadTab';
import { NativeRow } from './NativeRow';
import { useRecordHost } from './record-host';
import { Subtasks } from './Subtasks';
import { TagsBlock } from './TagsBlock';
import { UndoArrowsSlot } from './UndoArrowsSlot';
import { useRecordEdits } from './useEntityDetail';

const VersionsCard = lazy(() =>
  import('./VersionsCard').then((m) => ({ default: m.VersionsCard })),
);

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
  const { entity, extensionHooks, readOnly } = useRecordHost();
  const arrows = useBodyArrows(),
    onTitleShown = arrows?.onTitleShown;
  useLayoutEffect(() => {
    onTitleShown?.(true);
    return () => onTitleShown?.(false);
  }, [onTitleShown]);
  const { toggleTask, saveTitle, titleStale, refreshTitle, dismissTitleStale } = useRecordEdits(
    entity.id,
    entity,
  );
  const [titleRefresh, setTitleRefresh] = useState(0);
  const refresh = useRef({ id: entity.id, generation: 0 });
  // Возврат к тому же id не возвращает право старому ответу стереть новый черновик.
  if (refresh.current.id !== entity.id) {
    refresh.current.id = entity.id;
    refresh.current.generation += 1;
  }
  return (
    // Notion-style шапка страницы: крупная emoji-иконка над заголовком. Нет emoji — ничего не
    // рендерим (без плейсхолдера); в самой шапке экрана — только title.
    <div
      className="flex flex-col gap-3"
      onChange={() => {
        // Ввод во время чтения важнее ответа: поле и отказ остаются до нового «Обновить».
        refresh.current.generation += 1;
      }}
    >
      {entity.emoji && (
        <span aria-hidden className="text-4xl leading-none">
          {entity.emoji}
        </span>
      )}
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <NativeRow
            key={`${entity.id}:${titleRefresh}`}
            entity={entity}
            onToggleTask={(done) => {
              toggleTask(done);
              // Данные сущности ДО перевода: planned ещё true — карточка на переходе в done
              if (done) extensionHooks.onTaskDone(entity);
            }}
            onSaveTitle={saveTitle}
          />
        </div>
        {arrows !== undefined && !readOnly && <UndoArrowsSlot entityId={entity.id} />}
      </div>
      {titleStale && (
        <p role="alert" className="text-sm text-danger">
          Заголовок изменён в другом месте — обновите{' '}
          <button
            type="button"
            onClick={() => {
              const generation = ++refresh.current.generation;
              void refreshTitle()
                .then(() => {
                  if (refresh.current.generation !== generation) return;
                  dismissTitleStale();
                  setTitleRefresh((n) => n + 1);
                })
                .catch(() => {});
            }}
          >
            Обновить
          </button>
        </p>
      )}
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
 * `readOnly` хоста (предпросмотр шаблона на чужой записи, §9.3) — тело только для чтения:
 * первый кадр без редактора, без сохранения и черновиков. Запись взята для примера, и касание её
 * тела не повод его править.
 */
export function BodyBlock() {
  const { entity, readOnly } = useRecordHost();
  const { arrows, ...screen } = useBodyScreen();
  const intent = useRef({ epoch: undoEpoch(), generation: stepsGeneration() }).current;
  const titleShown = arrows?.titleShown;
  const current = useCallback(
    () =>
      !readOnly &&
      titleShown === false &&
      isUndoEpoch(intent.epoch) &&
      intent.generation === stepsGeneration(),
    [readOnly, titleShown, intent],
  );
  // Даже без заголовка и до ленивого редактора наблюдение принадлежит тому же LRU записи.
  useLayoutEffect(() => {
    if (current()) return mountRecord(entity.id);
  }, [entity.id, current]);
  useLayoutEffect(() => {
    if (current() && observeTitleValue(entity.id, entity.title)) resetSteps(entity.id);
  }, [entity.id, entity.title, current]);
  return (
    <ThisEntityProvider id={entity.id}>
      {!readOnly && arrows !== undefined && !arrows.titleShown && (
        <div className="flex justify-end">
          <UndoArrowsSlot entityId={entity.id} />
        </div>
      )}
      {readOnly ? (
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
 * `{{versions}}` — версии тела. Список идёт в сеть только на открытой вкладке (`openTab`), а
 * key — как у ленты прогона: у карточки своё состояние (выбранная версия, отказ
 * восстановления), и переезжать на соседнюю запись оно не должно.
 */
export function VersionsBlock() {
  const { entity, openTab } = useRecordHost();
  const opened = useRef(false);
  if (openTab !== null) opened.current = true;
  if (!opened.current)
    return (
      <section aria-label="Версии" data-testid="versions-card" className="flex flex-col gap-2">
        <p className="text-2xs font-medium uppercase tracking-wide text-text-muted">Версии</p>
        <p className="text-sm text-text-muted">…</p>
      </section>
    );
  return (
    <Suspense fallback={<p role="status">Загружаем версии…</p>}>
      <VersionsCard key={`versions-${entity.id}`} entity={entity} active={openTab !== null} />
    </Suspense>
  );
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
