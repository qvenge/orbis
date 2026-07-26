import { useMemo } from 'react';
import { trpc } from '../../trpc';
import { Card } from '../../ui/Card';
import { buildCatalogFromAspects, parseBlock } from './parse';

// Виджет ОДНОГО query-блока (02-core-os §3.4). На вход идёт inner блока — уже без обёртки
// {{query:...}}; разбивку body на блоки делает queryBlocks (features/browser/query.ts).
// Раньше проп назывался body и компонент сам брал ПЕРВОЕ совпадение регэкспа: из-за этого
// detail-экран сидированного Daily Planning показывал только Inbox, а секции «Сегодня»
// и «Ожидание» (§3.3) не рендерились вовсе.
export function QueryBlock({ query, title }: { query: string; title?: string }) {
  const aspects = trpc.aspect.list.useQuery();
  const catalog = useMemo(
    () => (aspects.data ? buildCatalogFromAspects(aspects.data) : null),
    [aspects.data],
  );

  const parsed = useMemo(() => (catalog ? parseBlock(query, catalog) : null), [catalog, query]);
  const ok = parsed?.ok === true;

  // entity.query только при валидном блоке; §6.4 — при ошибке НИКОГДА не пустой список, а плашка.
  const list = trpc.entity.query.useQuery({ query }, { enabled: ok });

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

  // §3.4: «заголовок (из title=; нет параметра — без заголовка)». Явный проп перекрывает
  // блок — им пользуются вызывающие, у которых заголовок задан снаружи виджета.
  const heading = title ?? parsed.ast.title;
  const entities = list.data ?? [];
  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        {heading && <p className="font-medium">{heading}</p>}
        <span data-testid="qb-count" className="text-text-secondary text-xs">
          {heading ? entities.length : `Совпадений: ${entities.length}`}
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
