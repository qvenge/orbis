import { type ExtensionId, SWITCHABLE_EXTENSION_IDS } from '@orbis/shared';
import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Input } from '../../ui/Input';
import { useUpdateBatch } from '../page/useUpdateBatch';
import { ExtensionChecks } from './ExtensionChecks';
import { newAppOps } from './nav-edit';

export const NEW_APP = 'Новое приложение';

/**
 * «Новое приложение» (срез 1б §9.5): имя и иконка — и одна пачка `entity_create` (`newAppOps`), один
 * Undo. Зовут «⋯ → Добавить в навигацию → Новое приложение…» (домашняя и раздел — эта запись) и
 * «Приложения и расширения → Новое приложение» (задача 22: без домашней, навигация пуста).
 *
 * «Состав» — по выбору владельца (§9.5, §8.6): галочки расширений, по умолчанию пусто; пишется в ту
 * же `entity_create`. Маску «Состав» не меняет — расширения включает и выключает только владелец в
 * «Приложениях и расширениях» (и каскад «Выключить приложение»).
 *
 * «Дом» странице здесь не пишется — его ставит сервер той же пачкой, если страница бездомная (§4.3,
 * докблок `newAppOps`). Форма навигации — «список из заголовка» (по умолчанию, §9.5).
 *
 * Модуль ЛЕНИВЫЙ: диалог нужен после жеста.
 */
export function NewAppDialog({
  homeId,
  navIds = [],
  onClose,
}: {
  homeId?: string;
  navIds?: readonly string[];
  onClose: () => void;
}) {
  const runBatch = useUpdateBatch();
  const [title, setTitle] = useState('');
  const [emoji, setEmoji] = useState('');
  const [extensions, setExtensions] = useState<ExtensionId[]>([]);
  const name = title.trim();

  function save() {
    if (name === '') return;
    onClose();
    void runBatch(
      newAppOps({
        title: name,
        emoji,
        ...(homeId !== undefined && { homeId }),
        navIds,
        form: 'header-list',
        extensions,
      }),
      `Приложение «${name}» создано`,
      { action: NEW_APP },
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={NEW_APP}
    >
      <form
        className="flex flex-col gap-3 pt-2 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="flex gap-2">
          <div className="flex w-20 flex-col gap-1">
            <span className="text-text-secondary">Иконка</span>
            <Input
              aria-label="Иконка"
              value={emoji}
              maxLength={16}
              onChange={(e) => setEmoji(e.target.value)}
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-text-secondary">Имя</span>
            <Input aria-label="Имя" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
        </div>
        <ExtensionChecks
          testId="new-app-extensions"
          lead="Состав — расширения, которые приложение предлагает выключать вместе с собой:"
          options={SWITCHABLE_EXTENSION_IDS}
          chosen={extensions}
          onChange={setExtensions}
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button type="submit" disabled={name === ''}>
            Создать
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
