/**
 * Выбор редактора query-блока (02-core-os §3.4): валидный блок правится формой, невалидный —
 * строковым редактором (форма требует валидного парса). Из формы доступен переход «в текст»
 * с текущей сериализацией; обратного перехода нет — правкой руками из блока можно сделать
 * что угодно, и возврат в форму молча выбрасывал бы то, чего она не выражает.
 *
 * Кому какой редактор — решается здесь, а не в detail-экране: тот знает про блок ровно
 * столько, чтобы заменить его подстроку в body, и заводить у него каталог полей ради
 * выбора редактора значило бы третий разбор одной и той же строки на экране.
 */

import { useState } from 'react';
import { useFieldCatalog } from '../../lib/query-blocks/useFieldCatalog';
import { Dialog } from '../../ui/Dialog';
import { parseForForm } from './model';
import { QueryBuilderForm } from './QueryBuilderForm';
import { QueryTextEditor } from './QueryTextEditor';

export function QueryBlockEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (query: string) => void;
  onCancel: () => void;
}) {
  const { catalog } = useFieldCatalog();
  // Не null — открыт строковый редактор с этим текстом (переход «редактировать как текст»).
  const [text, setText] = useState<string | null>(null);

  if (catalog === null) {
    return (
      <Dialog
        open
        onOpenChange={(v) => {
          if (!v) onCancel();
        }}
        title="Настройка блока"
      >
        <p role="status" className="py-6 text-center text-sm text-text-secondary">
          Загрузка…
        </p>
      </Dialog>
    );
  }

  // Форма управляет только тем блоком, который она умеет напечатать обратно: и разбор, и
  // печать проверяются ДО открытия — иначе первое же сохранение потеряло бы конструкцию.
  if (text === null && parseForForm(initial, catalog) !== null) {
    return (
      <QueryBuilderForm
        initial={initial}
        onSave={onSave}
        onCancel={onCancel}
        onEditAsText={setText}
      />
    );
  }
  return <QueryTextEditor initial={text ?? initial} onSave={onSave} onCancel={onCancel} />;
}
