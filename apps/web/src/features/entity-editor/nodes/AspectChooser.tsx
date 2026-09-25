import { effectiveLabel, OWNER_LOCALE, PAGE_ASPECT } from '@orbis/shared';
import { useRegistry } from '../../../lib/registry/useRegistry';
import { Button } from '../../../ui/Button';
import { Dialog } from '../../../ui/Dialog';

/**
 * Выбор аспекта для карточки `{{card: X}}` (спека страниц 1а §5.3, §9.1) — по реестру владельца:
 * и встроенные аспекты, и свои.
 *
 * Отдаёт КЛЮЧ, а не id: карточка печатается ключом, и вставка кладёт в узел ровно ту строку, что
 * встанет в текст тела (`{aspect: null, text: key}`); id по ней проставит привязка на сервере.
 *
 * «Страницы» в списке нет: на показе страницы своим телом её карточка не рисуется (РП-25), а
 * через шаблон хоста она видна и так — предлагать её значило бы звать поставить пустое место.
 */
export function AspectChooser({
  onPick,
  onCancel,
}: {
  onPick: (aspectKey: string) => void;
  onCancel: () => void;
}) {
  const registry = useRegistry();
  const aspects = [...(registry.data?.aspects ?? [])]
    .filter((a) => a.id !== PAGE_ASPECT)
    .sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title="Карточка аспекта"
    >
      <div className="flex flex-col gap-3 pt-2">
        <p className="text-sm text-text-secondary">
          Карточка покажет поля этого аспекта у записи — и ничего, если аспекта у записи нет.
        </p>
        {registry.data === undefined ? (
          <p className="text-sm text-text-muted">Реестр загружается…</p>
        ) : (
          <div data-testid="aspect-chooser" className="flex flex-wrap gap-2">
            {aspects.map((a) => (
              <Button key={a.id} variant="outline" size="sm" onClick={() => onPick(a.key)}>
                {effectiveLabel(a.label, OWNER_LOCALE)}
              </Button>
            ))}
          </div>
        )}
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onCancel}>
            Отмена
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
