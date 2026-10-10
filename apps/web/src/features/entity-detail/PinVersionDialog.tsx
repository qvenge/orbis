import { useId, useRef, useState } from 'react';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Input } from '../../ui/Input';
import { useToast } from '../../ui/toast-store';

/** Потолок подписи — тот же, что в схеме операции executor'а: длиннее сервер не примет. */
const LABEL_MAX = 200;

/**
 * Диалог закрепления. Загружается после жеста меню, а монтируется экраном: жест приходит из
 * меню ⋮, которое висит в шапке, снаружи вкладок.
 *
 * Монтируется ТОЛЬКО открытым (`open` без состояния): набранная и брошенная подпись не
 * переживает закрытие, а вместе с ней не переживает и переход запись→запись — экран монтируется
 * без key (router.tsx), и держать здесь состояние значило бы завести ещё одну память, которую
 * надо гасить при смене сущности.
 */
export function PinVersionDialog({ entityId, onClose }: { entityId: string; onClose: () => void }) {
  const utils = trpc.useUtils();
  const { show } = useToast();
  const [label, setLabel] = useState('');
  const fieldId = useId();
  const field = useRef<HTMLInputElement>(null);

  const pin = trpc.version.pin.useMutation({
    onSuccess: () => {
      // Инвалидируется ТОЛЬКО список версий, без invalidateGraph: закрепление пишет строку
      // снимка и саму запись не двигает вовсе (executor.prepareVersionPin — INSERT в
      // entity_versions, entities не тронут), то есть протух ровно этот список.
      void utils.version.list.invalidate({ entityId });
      show('Версия закреплена');
      onClose();
    },
  });

  // По краям подпись из одних пробелов сервер примет (min(1) её длину считает честной), а в
  // списке она будет пустой строкой — режем здесь, до отправки.
  const trimmed = label.trim();

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
          if (trimmed !== '') pin.mutate({ entityId, label: trimmed });
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
        {pin.isError && (
          <p role="alert" className="text-danger text-sm">
            {pin.error.message}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Отмена
          </Button>
          {/* Пустая подпись — гарантированный отказ сервера (min(1)): не отправляем вовсе, и
              видно это до нажатия. */}
          <Button type="submit" size="sm" disabled={trimmed === '' || pin.isPending}>
            Закрепить
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
