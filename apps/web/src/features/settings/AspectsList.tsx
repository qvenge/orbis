import { trpc } from '../../trpc';
import { Card } from '../../ui/Card';

/**
 * Реестр аспектов, видимых владельцу. С реформой (§А2-1) подпись стала per-locale
 * (`label: {ru, en}`), а иконка переехала в `view_config`: у аспекта осталась ЧЕТВЁРКА имён
 * id/key/label/description, и `name`/`icon` отдельными колонками больше нет.
 *
 * Локаль здесь взята русской напрямую, а не через fallback «локаль пользователя → en →
 * любая»: выбора локали в приложении пока нет вовсе, и вводить половину механизма (fallback
 * без переключателя) значило бы завести мёртвый код. Полный fallback приходит вместе с
 * экраном реестра — Задача 12.
 */
export function AspectsList() {
  const aspects = trpc.aspect.list.useQuery();
  return (
    <div className="flex flex-col gap-2 p-3">
      {(aspects.data ?? []).map((a) => {
        const icon = (a.viewConfig as { icon?: string } | null)?.icon;
        return (
          <Card key={a.id} className="flex items-center gap-2">
            {icon && <span aria-hidden>{icon}</span>}
            <span className="flex-1">{a.label.ru}</span>
            <span className="text-xs text-text-muted">{a.id}</span>
          </Card>
        );
      })}
    </div>
  );
}
