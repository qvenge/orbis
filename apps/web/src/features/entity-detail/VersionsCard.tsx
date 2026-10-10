// Закреплённые версии тела (С11, приёмка 12): «сохрани как есть, чтобы было куда вернуться».
//
// Страховка ВЛАДЕЛЬЦА перед тем, как отдать запись агенту, а не рабочий материал исполнителя:
// закрепляет и восстанавливает только человек (роутер version — ownerOnly), агент версий не
// видит вовсе. Отсюда и два места на экране: закрепляют из меню ⋮ (оно одно на все вкладки,
// и жест этот делают, глядя на тело), а восстанавливают из списка на «Деталях».
//
// Восстанавливается ТОЛЬКО тело — аспекты, связи и заголовок в снимок не входят (инвариант 8
// среза). Об этом сказано в подтверждении: «восстановить версию» без оговорки читается как
// «вернуть запись целиком», и человек нажимал бы её, ожидая большего, чем случится.
import { useId, useState } from 'react';
import { formatDate } from '../../lib/format';
import { invalidateGraph } from '../../lib/invalidate';
import { type RouterOutputs, trpc } from '../../trpc';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { useToast } from '../../ui/toast-store';
import { useHostReadOnly } from './record-host';

type Entity = RouterOutputs['entity']['get']['entity'];
type Version = RouterOutputs['version']['list'][number];

export function VersionsCard({ entity, active }: { entity: Entity; active: boolean }) {
  // Предпросмотр шаблона (хост `readOnly`): список версий виден, «Восстановить» нет — жест
  // переписал бы тело записи, взятой для примера.
  const readOnly = useHostReadOnly();
  const utils = trpc.useUtils();
  const { show } = useToast();
  // Часовой пояс — по УЖЕ живому ключу кэша (его читает сам экран): своей сети секция не
  // добавляет.
  const tz = trpc.user.getSettings.useQuery().data?.timezone;
  /**
   * Список — по АКТИВНОСТИ вкладки, а не с монтирования. «Детали» живут постоянно
   * (keepMounted в DetailScreen), и безусловный запрос стоил бы лишнего похода в сеть на
   * КАЖДОМ открытии любой записи — включая те, где по вкладкам никто не ходил. Ровно та
   * плата, из-за которой «Тред» живым не держат (см. Tabs).
   */
  const list = trpc.version.list.useQuery({ entityId: entity.id }, { enabled: active });

  /** Версия, о восстановлении которой сейчас спрашивают. Null — диалога нет. */
  const [target, setTarget] = useState<Version | null>(null);
  const cancelId = useId();

  const restore = trpc.version.restore.useMutation({
    onSuccess: () => {
      setTarget(null);
      // Тело записи переписано — граф перечитывается целиком (Р17): та же запись открыта в
      // редакторе, а её строка живёт в чужих подзадачах и backlinks.
      invalidateGraph(utils);
      show('Тело восстановлено');
    },
    // Отказ показываем строкой ниже, а модалку закрываем: открытый диалог поверх сообщения об
    // отказе читался бы как «нажми ещё раз» (тот же порядок в RunFeed).
    onError: () => setTarget(null),
  });

  /**
   * 409 — НЕ плашка тела экрана (`screenConflict`), и это не небрежность: та питается только
   * `entity.update` через useEntityDetail, а восстановление идёт своим роутером и до неё не
   * доезжает никогда. Секция обязана сказать о своём отказе сама.
   */
  const conflict = restore.error?.data?.code === 'CONFLICT';

  const versions = list.data;

  return (
    <section aria-label="Версии" data-testid="versions-card" className="flex flex-col gap-2">
      <p className="text-2xs font-medium uppercase tracking-wide text-text-muted">Версии</p>

      {conflict && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-danger/40 bg-danger/10 px-3 py-2"
        >
          <p className="text-sm text-danger">Документ изменился в другом месте — обновите экран.</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              // Сбрасываем отказ ДО перечитывания: тревога, оставшаяся висеть над свежей
              // записью, утверждала бы неправду.
              restore.reset();
              invalidateGraph(utils);
            }}
          >
            Обновить
          </Button>
        </div>
      )}
      {restore.isError && !conflict && (
        <p role="alert" className="text-danger text-sm">
          {restore.error.message}
        </p>
      )}

      {list.isError ? (
        <p role="alert" className="text-danger text-sm">
          {list.error.message}
        </p>
      ) : versions === undefined ? (
        <p className="text-sm text-text-muted">…</p>
      ) : versions.length === 0 ? (
        // Пустая секция обязана сказать, чем её наполнить: пункт меню найти неоткуда.
        <p className="text-sm text-text-muted">
          Версий нет. Пункт «Закрепить версию» в меню ⋮ сохранит нынешнее тело.
        </p>
      ) : (
        <ul className="flex flex-col">
          {versions.map((v) => (
            <li
              key={v.id}
              className="flex flex-wrap items-center gap-2 border-line/60 border-b py-1.5 text-sm last:border-b-0"
            >
              {/* Подпись пишет человек — переносим её целиком, а не режем многоточием: по ней
                  он и выбирает, куда возвращаться. */}
              <span className="min-w-0 flex-1 break-words">{v.label}</span>
              <time dateTime={v.createdAt} className="text-text-secondary">
                {formatDate(v.createdAt, tz)}
              </time>
              {/* Что лежит в снимке: документ или только markdown-текст (тело «до бэкфилла»,
                  body_doc IS NULL). Второе восстановится текстом — блочная разметка соберётся
                  заново, и знать это надо ДО нажатия, а не после. */}
              <Badge>{v.hasDoc ? 'есть документ' : 'только текст'}</Badge>
              {!readOnly && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={restore.isPending}
                  onClick={() => setTarget(v)}
                >
                  Восстановить
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {target !== null && (
        <Dialog
          open
          onOpenChange={(v) => {
            if (!v) setTarget(null);
          }}
          title="Восстановить это тело?"
          // Фокус — на «Отмена», а не на первом таб-стопе (крестик) и тем более не на самом
          // восстановлении: жест переписывает тело записи, и Enter сразу по открытии модалки не
          // должен его совершать. По id, а не по ссылке: `Button` — не forwardRef-компонент.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            document.getElementById(cancelId)?.focus();
          }}
        >
          <div className="flex flex-col gap-3 pt-2">
            <p className="text-sm text-text-secondary">
              Тело записи заменится снимком «{target.label}» от {formatDate(target.createdAt, tz)}.
              Заголовок, свойства и связи останутся нынешними.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button id={cancelId} variant="ghost" size="sm" onClick={() => setTarget(null)}>
                Отмена
              </Button>
              <Button
                size="sm"
                disabled={restore.isPending}
                onClick={() =>
                  restore.mutate({
                    versionId: target.id,
                    // Метка ОТКРЫТОЙ записи: сервер сверит её и откажет 409, если тело правили,
                    // пока экран смотрел на список (§5.2) — молча затирать чужое нельзя.
                    expectedUpdatedAt: entity.updatedAt,
                  })
                }
              >
                Восстановить
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </section>
  );
}
