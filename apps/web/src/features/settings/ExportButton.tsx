import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';

export function ExportButton() {
  const utils = trpc.useUtils();
  async function exportNow() {
    // §9.4: выгрузка orbis-export одним JSON-Blob, скачивание через <a download>.
    const data = await utils.user.exportData.fetch();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `orbis-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <Button variant="primary" onClick={exportNow}>
      Экспорт данных
    </Button>
  );
}
