import { trpc } from '../../trpc';
import { Card } from '../../ui/Card';

export function AspectsList() {
  const aspects = trpc.aspect.list.useQuery();
  return (
    <div className="flex flex-col gap-2 p-3">
      {(aspects.data ?? []).map((a) => (
        <Card key={a.id} className="flex items-center gap-2">
          {a.icon && <span aria-hidden>{a.icon}</span>}
          <span className="flex-1">{a.name}</span>
          <span className="text-xs text-text-muted">{a.id}</span>
        </Card>
      ))}
    </div>
  );
}
