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
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Input } from '../../ui/Input';
import { flushBodyOf } from '../entity-editor/body-flush';
import { journalRefOf } from '../undo/journal-ref';
import { isUndoEpoch, subscribeUndoEpoch, undoEpoch } from '../undo/undo-epoch';
import { offerUndoLazy } from '../undo/undo-lazy';

/** Потолок подписи — тот же, что в схеме операции executor'а: длиннее сервер не примет. */
const LABEL_MAX = 200;

/**
 * Диалог закрепления. Живёт здесь, рядом со списком, а монтируется экраном: жест приходит из
 * меню ⋮, которое висит в шапке, снаружи вкладок.
 *
 * Монтируется ТОЛЬКО открытым (`open` без состояния): набранная и брошенная подпись не
 * переживает закрытие, а вместе с ней не переживает и переход запись→запись — экран монтируется
 * без key (router.tsx), и держать здесь состояние значило бы завести ещё одну память, которую
 * надо гасить при смене сущности.
 */
export function PinVersionDialog({ entityId, onClose }: { entityId: string; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [label, setLabel] = useState('');
  const fieldId = useId();
  const field = useRef<HTMLInputElement>(null);

  const epoch = useSyncExternalStore(subscribeUndoEpoch, undoEpoch, undoEpoch);
  const alive = useRef(true);
  const currentId = useRef(entityId);
  currentId.current = entityId;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const pending = useRef<{ epoch: number; id: string } | null>(null);
  type Intent = { epoch: number; id: string };
  const [waiting, setWaiting] = useState<Intent | null>(null);
  const [error, setError] = useState<{ intent: Intent; message: string } | null>(null);
  const pinIntent = useRef<Intent>({ epoch, id: entityId });
  const current = (intent: { epoch: number; id: string }) =>
    isUndoEpoch(intent.epoch) && alive.current && currentId.current === intent.id;
  const pin = trpc.version.pin.useMutation({
    meta: { undoStack: 'self' },
    onMutate: (vars) => ({ epoch: pinIntent.current.epoch, id: vars.entityId }),
    onSuccess: (data, _vars, intent) => {
      if (!intent || !current(intent)) return;
      // Инвалидируется ТОЛЬКО список версий, без invalidateGraph: закрепление пишет строку
      // снимка и саму запись не двигает вовсе (executor.prepareVersionPin — INSERT в
      // entity_versions, entities не тронут), то есть протух ровно этот список.
      void utils.version.list.invalidate({ entityId });
      const ref = journalRefOf(data);
      if (ref) offerUndoLazy({ title: 'Версия закреплена', actionId: ref.actionId, entityIds: [] });
      onClose();
    },
  });

  // По краям подпись из одних пробелов сервер примет (min(1) её длину считает честной), а в
  // списке она будет пустой строкой — режем здесь, до отправки.
  const trimmed = label.trim();
  const submit = async () => {
    if (
      !trimmed ||
      (pending.current && current(pending.current)) ||
      (pin.isPending && current(pinIntent.current))
    )
      return;
    const intent = { epoch: undoEpoch(), id: entityId };
    pending.current = intent;
    setWaiting(intent);
    setError(null);
    try {
      const flushed = await flushBodyOf(intent.id);
      if (!current(intent)) return;
      if (flushed === 'blocked' || flushed === 'offline') {
        setError({
          intent,
          message:
            flushed === 'blocked'
              ? 'Текст записи не сохранён — сначала закончите правку или разрешите конфликт текста'
              : 'Нет связи: набранный текст ещё не на сервере — снимок версии не отправлен',
        });
        return;
      }
      pinIntent.current = intent;
      pin.mutate({ entityId: intent.id, label: trimmed });
    } finally {
      if (pending.current === intent) {
        pending.current = null;
        if (current(intent)) setWaiting(null);
      }
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(v) => {
        // Esc, крестик и клик по подложке — тот же отказ, что «Отмена».
        if (!v) onClose();
      }}
      title="Закрепить версию"
      // Фокус — в поле: модалка открыта по явному пункту меню, и Tab до единственного поля был
      // бы платой ни за что. Штатным хуком Radix, а не отложенным кадром наперегонки с его
      // фокус-ловушкой (тот же приём, что в QueryTextEditor).
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        field.current?.focus();
      }}
    >
      <form
        className="flex flex-col gap-3 pt-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="text-sm text-text-secondary">
          Снимок сохранит тело записи как есть — заголовок, свойства и связи в него не входят.
        </p>
        <div className="flex flex-col gap-1">
          <label htmlFor={fieldId} className="text-sm text-text-secondary">
            Подпись
          </label>
          <Input
            id={fieldId}
            ref={field}
            value={label}
            maxLength={LABEL_MAX}
            placeholder="до правки агентом"
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        {((error && current(error.intent)) || (current(pinIntent.current) && pin.isError)) && (
          <p role="alert" className="text-danger text-sm">
            {error && current(error.intent) ? error.message : pin.error?.message}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Отмена
          </Button>
          {/* Пустая подпись — гарантированный отказ сервера (min(1)): не отправляем вовсе, и
              видно это до нажатия. */}
          <Button
            type="submit"
            size="sm"
            disabled={
              trimmed === '' ||
              (waiting !== null && current(waiting)) ||
              (pin.isPending && current(pinIntent.current))
            }
          >
            Закрепить
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
