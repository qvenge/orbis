import type { BlockResult } from '@orbis/shared';
import type { QueryAggregate } from '@orbis/shared/query';
import { formatMoneyWithCurrency, formatSums } from '../../../lib/format';
import { displayText, EMPTY_TEXT } from '../../../lib/registry/format';
import { useRegistry } from '../../../lib/registry/useRegistry';
import { Card } from '../../../ui/Card';
import { ConfigureButton } from './BlockPlaque';

type TileResult = Extract<BlockResult, { kind: 'count' | 'sum' | 'latest' }>;

/**
 * Число плитки текстом. Сумма — по валютам раздельно (спека 1в §3.6): сервер не складывает рубли с
 * долларами, строку печатает общий `formatSums` (тот же, что у карточки `user_query`). `latest`
 * денежное — с символом своей валюты (§3.7), иначе значение по ТИПУ свойства агрегата.
 */
// ОБХОДЧИК-Q: web-tile-form
function tileValue(
  result: TileResult,
  aggregate: QueryAggregate | undefined,
  registry: ReturnType<typeof useRegistry>,
): string {
  switch (result.kind) {
    case 'count':
      return String(result.count);
    case 'sum':
      return formatSums(result.sums).text;
    case 'latest': {
      if (result.value === null) return EMPTY_TEXT;
      if (result.currency !== null) return formatMoneyWithCurrency(result.value, result.currency);
      const field = aggregate !== undefined && aggregate.fn !== 'count' ? aggregate.field : '';
      // Адрес контракта (1в) — не свойство: у него нет подписи типа в реестре, и значение
      // печатается как есть, без поиска свойства по строке-ключу.
      if (typeof field !== 'string') return displayText(undefined, result.value, registry);
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
  const note = result.kind === 'sum' ? formatSums(result.sums).note : null;
  return (
    <Card data-testid="qb-tile" className="flex flex-col gap-1">
      <div className="flex items-start justify-between gap-2">
        <span data-testid="qb-tile-value" className="font-semibold text-2xl tabular-nums">
          {tileValue(result, aggregate, registry)}
        </span>
        {onConfigure && <ConfigureButton onClick={onConfigure} />}
      </div>
      {heading && <p className="text-sm text-text-secondary">{heading}</p>}
      {note && (
        <p data-testid="qb-currencies" role="note" className="text-warning text-xs">
          {note}
        </p>
      )}
    </Card>
  );
}
