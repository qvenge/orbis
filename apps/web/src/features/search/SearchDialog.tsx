import { HOST_APP } from '@orbis/shared/nav';
import { useState } from 'react';
import { type FrameApp, FrameAppContext } from '../../app/frame/FrameApp';
import { Dialog } from '../../ui/Dialog';
import { SearchPanel } from './SearchPanel';
import { useSearchDialog } from './search-dialog-store';

/**
 * Окно — не элемент истории (спека 1б §7.3): запись из него ложится в стопку текущего раздела
 * основной области, правило открытия — из хоста. `host-screen` здесь неверен — он снял бы со стопки
 * верхний экран (экран хоста под окном — чат, настройки), а окна в стопке нет.
 */
const DIALOG_FRAME: FrameApp = { app: HOST_APP, via: 'content' };

/**
 * Окно поиска ⌘K на десктопе (спека 1б §6.3, §6.4): вверху по центру, поле сверху, там же переход к
 * странице или приложению по имени. Открывают 🔍 и ⌘K / Ctrl+K (`useSearchDialog`); выбор результата
 * закрывает окно. Строка поиска живёт в окне, не в адресе: окна в истории нет.
 *
 * Модуль ЛЕНИВЫЙ (R-35): его монтирует `AppShell` только открытым.
 */
export function SearchDialog() {
  const hide = useSearchDialog((s) => s.hide);
  const [q, setQ] = useState('');
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v) hide();
      }}
      title="Поиск"
      placement="top"
      // Фокус ставит поле само (`autoFocus`), а не Radix на крестик «Закрыть».
      onOpenAutoFocus={(e) => e.preventDefault()}
    >
      <FrameAppContext.Provider value={DIALOG_FRAME}>
        <SearchPanel value={q} onChange={setQ} fieldAt="top" onPicked={hide} />
      </FrameAppContext.Provider>
    </Dialog>
  );
}
