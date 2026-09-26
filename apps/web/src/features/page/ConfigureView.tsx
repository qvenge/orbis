import { useEffect } from 'react';
import { ThisEntityProvider } from '../../lib/query-blocks/this-entity';
import { registerLeaveGuard } from '../../state/leave-guard';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Skeleton } from '../../ui/Skeleton';
import { useToast } from '../../ui/toast-store';
import { leaveBody } from '../entity-detail/body-gate';
import { bodyKindOf, EntityBody, useBodyScreen } from '../entity-detail/EntityBody';
import { detailGetInput } from '../entity-detail/useEntityDetail';
import { TemplateBanner, templateForOf } from './TemplateBanner';

/**
 * Настройка страницы или шаблона (спека страниц 1а §9.1): тело — в ТОМ ЖЕ редакторе, что тело
 * записи (`EntityBody`: первый кадр, автосохранение, черновики, Undo правки тела), под родом
 * страницы или шаблона — его `EntityBody` ставит сам по записи (`bodyKindOf`). Контейнеры в нём —
 * подписанными рамками, обвязка — заглушками, блоки данных — живыми; «/» предлагает контейнеры и
 * обвязку. «Готово» возвращает к показу.
 *
 * Неотправленная правка (пауза набора, сохранение в полёте, отказ сервера) держит и «Готово», и
 * уход с экрана — «назад», смену записи, вкладку (страж ухода `registerLeaveGuard`): тело досылается
 * сейчас же, человек видит тост и повторяет жест. Досыл на размонтировании (`useBodySave`) об отказе
 * молчал бы — плашки тела к тому времени уже ушли вместе с видом (остаток 1а №86). Без связи уход
 * разрешён, когда текст лежит черновиком на устройстве (`leaveBody`, рулинг R-5).
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
  // Тело настройки регистрируется у экрана так же, как тело записи: жесты меню ⋮, переписывающие
  // запись, обязаны знать о неотправленной правке и здесь (финальное ревью, F-I1).
  const { bodyGate } = useBodyScreen();
  const { show } = useToast();
  useEffect(() => registerLeaveGuard(() => leaveBody(bodyGate.current, show)), [bodyGate, show]);
  const entity = get.data?.entity;
  const done = (
    <Button
      size="sm"
      onClick={() => {
        if (leaveBody(bodyGate.current, show)) onDone();
      }}
    >
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
          bodyGate={bodyGate}
        />
      </ThisEntityProvider>
    </div>
  );
}
