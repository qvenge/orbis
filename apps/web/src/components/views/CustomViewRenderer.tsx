import { ArrowLeft } from 'lucide-react';
import type { CustomViewConfig, Entity } from '@orbis/shared';
import { useNavigationStore } from '../../stores/navigation.ts';
import { trpc } from '../../lib/trpc.ts';
import { IconButton } from '../ui/IconButton.tsx';
import { GenericListView } from './GenericListView.tsx';
import { GenericTableView } from './GenericTableView.tsx';
import { GenericChartView } from './GenericChartView.tsx';

interface CustomViewRendererProps {
  config: CustomViewConfig;
}

function computeAggregations(
  entities: Entity[],
  aspectId: string,
  aggregations: NonNullable<CustomViewConfig['aggregations']>,
): Array<{ label: string; value: string }> {
  return aggregations.map((agg) => {
    const values = entities
      .map((e) => {
        const aspects = e.aspects as Record<string, Record<string, unknown>>;
        const data = aspects[aspectId];
        return data ? Number(data[agg.field]) || 0 : 0;
      })
      .filter((v) => !isNaN(v));

    let result = 0;
    if (agg.type === 'count') result = values.length;
    else if (agg.type === 'sum') result = values.reduce((a, b) => a + b, 0);
    else if (agg.type === 'avg') result = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    else if (agg.type === 'min') result = values.length > 0 ? Math.min(...values) : 0;
    else if (agg.type === 'max') result = values.length > 0 ? Math.max(...values) : 0;

    return {
      label: agg.label,
      value: result % 1 === 0 ? String(result) : result.toFixed(1),
    };
  });
}

export function CustomViewRenderer({ config }: CustomViewRendererProps) {
  const { navigate, openEntity } = useNavigationStore();

  const { data, isLoading } = trpc.entity.list.useQuery({
    aspects: [config.aspectId],
    limit: 100,
    sortBy: 'updated_at',
    sortOrder: 'desc',
  });

  const entities = (data?.items ?? []) as Entity[];

  const aggResults = config.aggregations && config.aggregations.length > 0
    ? computeAggregations(entities, config.aspectId, config.aggregations)
    : [];

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <IconButton icon={ArrowLeft} label="Go back" onClick={() => navigate('hub')} />
        <h2 className="text-sm font-semibold text-text">{config.name}</h2>
        <span className="text-[10px] text-text-muted">{entities.length} items</span>
      </div>

      {/* Aggregation summary cards */}
      {aggResults.length > 0 && (
        <div className="flex gap-3 overflow-x-auto border-b border-border px-4 py-2">
          {aggResults.map((agg, i) => (
            <div key={i} className="shrink-0 rounded-lg border border-border bg-surface-dim px-3 py-2">
              <p className="text-[10px] text-text-muted">{agg.label}</p>
              <p className="text-lg font-bold text-text">{agg.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Content */}
      {isLoading ? (
        <div className="flex h-32 items-center justify-center">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-border-light border-t-primary" />
        </div>
      ) : config.layout === 'chart' && config.chartConfig ? (
        <GenericChartView
          entities={entities}
          aspectId={config.aspectId}
          chartConfig={config.chartConfig}
        />
      ) : config.layout === 'table' ? (
        <GenericTableView
          entities={entities}
          aspectId={config.aspectId}
          columns={config.columns}
          onEntityClick={openEntity}
        />
      ) : (
        <GenericListView
          entities={entities}
          aspectId={config.aspectId}
          columns={config.columns}
          onEntityClick={openEntity}
        />
      )}
    </div>
  );
}
