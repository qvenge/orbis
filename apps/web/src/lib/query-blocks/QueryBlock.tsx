import { useMemo } from 'react';
import { trpc } from '../../trpc';
import { Card } from '../../ui/Card';
import { buildCatalogFromAspects, parseBlock } from './parse';

export function QueryBlock({ body, title }: { body: string; title?: string }) {
  const aspects = trpc.aspect.list.useQuery();
  const catalog = useMemo(
    () => (aspects.data ? buildCatalogFromAspects(aspects.data) : null),
    [aspects.data],
  );

  const parsed = useMemo(() => (catalog ? parseBlock(body, catalog) : null), [catalog, body]);
  const inner = body.match(/\{\{query:([\s\S]*?)\}\}/)?.[1]?.trim() ?? '';
  const ok = parsed?.ok === true;

  // entity.query только при валидном блоке; §6.4 — при ошибке НИКОГДА не пустой список, а плашка.
  const list = trpc.entity.query.useQuery({ query: inner }, { enabled: ok });

  if (!parsed) {
    return (
      <Card>
        <span role="status">Загрузка…</span>
      </Card>
    );
  }

  if (!parsed.ok) {
    return (
      <Card role="alert" data-testid="qb-error" className="border-danger">
        <p className="text-danger text-sm">Ошибка запроса: {parsed.error.message}</p>
        <p className="text-text-muted text-xs">позиция {parsed.error.position}</p>
      </Card>
    );
  }

  const entities = list.data ?? [];
  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        {title && <p className="font-medium">{title}</p>}
        <span data-testid="qb-count" className="text-text-secondary text-xs">
          {title ? entities.length : `Совпадений: ${entities.length}`}
        </span>
      </div>
      <ul className="flex flex-col divide-y divide-line">
        {entities.map((e) => (
          <li key={e.id} data-testid="qb-item" className="py-1 text-sm">
            {e.title}
          </li>
        ))}
      </ul>
    </Card>
  );
}
