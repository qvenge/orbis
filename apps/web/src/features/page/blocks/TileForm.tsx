import type { BlockResult } from '@orbis/shared';
import type { QueryAggregate } from '@orbis/shared/query';
import { formatMoneyWithCurrency } from '../../../lib/format';
import { displayText, EMPTY_TEXT } from '../../../lib/registry/format';
import { useRegistry } from '../../../lib/registry/useRegistry';
import { Card } from '../../../ui/Card';
import { ConfigureButton } from './BlockPlaque';

type TileResult = Extract<BlockResult, { kind: 'count' | 'sum' | 'latest' }>;

/**
 * Число плитки текстом. Сумма печатается с символом валюты, только когда валюта ОДНА: рубли с
 * долларами сервер сложил бы честно как числа, но символ при такой сумме был бы ложью (РП-20) —
 * и это вслух говорит плашка под числом. `latest` — значение по ТИПУ свойства агрегата.
 */
function tileValue(
  result: TileResult,
  aggregate: QueryAggregate | undefined,
  registry: ReturnType<typeof useRegistry>,
): string {
  switch (result.kind) {
    case 'count':
      return String(result.count);
    case 'sum':
      return formatMoneyWithCurrency(
        result.sum,
        result.currencies.length === 1 ? (result.currencies[0] ?? null) : null,
      );
    case 'latest': {
      if (result.value === null) return EMPTY_TEXT;
      const field = aggregate !== undefined && aggregate.fn !== 'count' ? aggregate.field : '';
      return displayText(registry.property(field), result.value, registry);
    }
  }
}

/**
 * `tile` (спека страниц 1а §5.4, §7.2): одна цифра агрегата `count` / `sum` / `latest` с подписью
 * `title`. Своя карточка, а не шапка списка: у плитки нет строк, и счётчик «Совпадений» над
 * числом повторил бы его же.
 */
export function TileForm({
  result,
  aggregate,
  heading,
  onConfigure,
}: {
  result: TileResult;
  aggregate: QueryAggregate | undefined;
  heading: string | undefined;
  onConfigure?: () => void;
}) {
  const registry = useRegistry();
  const mixed = result.kind === 'sum' && result.currencies.length > 1 ? result.currencies : null;
  return (
    <Card data-testid="qb-tile" className="flex flex-col gap-1">
      <div className="flex items-start justify-between gap-2">
        <span data-testid="qb-tile-value" className="font-semibold text-2xl tabular-nums">
          {tileValue(result, aggregate, registry)}
        </span>
        {onConfigure && <ConfigureButton onClick={onConfigure} />}
      </div>
      {heading && <p className="text-sm text-text-secondary">{heading}</p>}
      {mixed && (
        <p data-testid="qb-currencies" role="note" className="text-warning text-xs">
          разные валюты: {mixed.join(', ')}
        </p>
      )}
    </Card>
  );
}
