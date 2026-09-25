import { ThisEntityProvider } from '../../lib/query-blocks/this-entity';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Skeleton } from '../../ui/Skeleton';
import { bodyKindOf, EntityBody } from '../entity-detail/EntityBody';
import { detailGetInput } from '../entity-detail/useEntityDetail';
import { TemplateBanner, templateForOf } from './TemplateBanner';

/**
 * Настройка страницы или шаблона (спека страниц 1а §9.1): тело — в ТОМ ЖЕ редакторе, что тело
 * записи (`EntityBody`: первый кадр, автосохранение, черновики, Undo правки тела), под родом
 * страницы или шаблона — его `EntityBody` ставит сам по записи (`bodyKindOf`). Контейнеры в нём —
 * подписанными рамками, обвязка — заглушками, блоки данных — живыми; «/» предлагает контейнеры и
 * обвязку. «Готово» возвращает к показу; отложенную правку тело досылает при уходе само.
 *
 * Запись настройки — своим `entity.get` под ключом экрана записи (`detailGetInput`): у страницы,
 * настраиваемой со своего экрана, это ТОТ ЖЕ запрос из кеша, второго нет; у шаблона, открытого
 * с записи («Настроить шаблон „X“»), — запрос самого шаблона: список шаблонов (`entity.query`)
 * документа тела не несёт, а редактору нужен документ, не текст.
 *
 * `this` в блоках данных тела — сама настраиваемая запись (§6.4), как на её показе.
 */
export function ConfigureView({ targetId, onDone }: { targetId: string; onDone: () => void }) {
  const get = trpc.entity.get.useQuery(detailGetInput(targetId));
  const entity = get.data?.entity;
  const done = (
    <Button size="sm" onClick={onDone}>
      Готово
    </Button>
  );
  if (entity === undefined) {
    return (
      <div data-testid="configure-view" className="flex flex-col gap-4 px-4 pb-10 pt-5 md:px-6">
        <div className="flex justify-end">{done}</div>
        {get.isError ? (
          <p role="alert" className="text-danger text-sm">
            Не удалось открыть тело для настройки: {get.error.message}
          </p>
        ) : (
          <Skeleton className="h-24" />
        )}
      </div>
    );
  }
  const isTemplate = bodyKindOf(entity) === 'template';
  return (
    <div data-testid="configure-view" className="flex flex-col gap-4 px-4 pb-10 pt-5 md:px-6">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-text-secondary">
          {isTemplate ? 'Настройка шаблона' : 'Настройка страницы'} „{entity.title}“
        </p>
        {done}
      </div>
      {isTemplate && <TemplateBanner forAspects={templateForOf(entity.props)} />}
      <ThisEntityProvider id={entity.id}>
        {/* key — по записи: память правки (таймер паузы, черновик) не переезжает на соседнюю. */}
        <EntityBody
          key={entity.id}
          entity={entity}
          asMarkdown={false}
          onCloseMarkdown={() => {}}
          screenConflict={false}
          noticeHost={null}
          onRefresh={() => void get.refetch()}
        />
      </ThisEntityProvider>
    </div>
  );
}
