// Task C4b, экран ревью импорта (03-budget §3.4 шаг 3): счётчики ✓/⊘/⟳, строка со
// статусом, inline-правка категории, переключение ⊘ → «создать всё равно»,
// [Снять все дубли] и [Подтвердить N].
//
// Разметка — не <table> (таблиц в приложении нет вовсе): Card + flex-строки, как в
// RolloverScreen. Виртуализации нет (её нет нигде в приложении), поэтому строка
// держится дешёвой: никаких запросов и подписок на строку.
//
// Инвариант, ради которого написана половина файла: НИ ОДНА строка не теряется молча.
// ⟳ структурно не может попасть в payload (actionOf возвращает 'skip' по статусу, а не
// по состоянию переключателей), ✓ без категории не выбрасывается, а блокирует кнопку
// с явным счётчиком ожидания.
import type { CanonicalRow, ImportConfirmItem, ImportReviewRow } from '@orbis/shared';
import { useState } from 'react';
import { formatMoney, type MoneyTone } from '../../lib/format';
import { useNav } from '../../state/navigation';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Spinner } from '../../ui/Spinner';
import { CATEGORIES_QUERY, type CategoryOption, toOption } from '../budget/categories';
import { ddmm } from '../budget/EnvelopeCard';

type RowAction = 'create' | 'adopt' | 'skip';

const TONE_CLASS: Record<MoneyTone, string> = { danger: 'text-danger', positive: 'text-success' };

// Общая строка нативной выпадашки (примитива Select в src/ui нет) — образец §3.3
const FIELD_CLS =
  'rounded-control border border-line bg-surface px-2 py-1 text-xs text-text transition focus-visible:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40';

const STATUS_ICON: Record<ImportReviewRow['status'], string> = {
  new: '✓',
  probable_duplicate: '⊘',
  already_imported: '⟳',
};
const STATUS_TITLE: Record<ImportReviewRow['status'], string> = {
  new: 'новая',
  probable_duplicate: 'вероятный дубль',
  already_imported: 'уже импортирована',
};

/** Заголовок строки — тот же, что даст сервер при создании (confirmImport). */
function rowTitle(row: ImportReviewRow): string {
  const counterparty = row.counterparty.trim();
  return counterparty === '' ? `Операция ${row.occurredOn}` : counterparty;
}

/**
 * Служебные поля ревью (externalId/status/duplicateOf/suggestedCategoryRef) в payload
 * не уходят: canonicalRowSchema объявлена .strict() и отвергла бы их целиком.
 */
function toCanonical(row: ImportReviewRow): CanonicalRow {
  return {
    occurredOn: row.occurredOn,
    amount: row.amount,
    direction: row.direction,
    counterparty: row.counterparty,
    raw: row.raw,
    rowIndex: row.rowIndex,
    ...(row.bankTxnId === undefined ? {} : { bankTxnId: row.bankTxnId }),
  };
}

/**
 * Дефолт строки (§3.4): ⟳ — только skip; ⊘ — adopt (сущность усыновляет новый
 * источник, транзакция не создаётся); ✓ — create. ⊘ без duplicateOf усыновлять
 * некого — такая строка ведёт себя как обычная новая.
 */
function defaultAction(row: ImportReviewRow): RowAction {
  if (row.status === 'already_imported') return 'skip';
  if (row.status === 'probable_duplicate' && row.duplicateOf !== undefined) return 'adopt';
  return 'create';
}

export function ReviewTable({
  rows,
  pending,
  onConfirm,
}: {
  rows: ImportReviewRow[];
  pending: boolean;
  onConfirm: (items: ImportConfirmItem[]) => void;
}) {
  const categoriesQ = trpc.entity.query.useQuery({ query: CATEGORIES_QUERY });
  const categories: CategoryOption[] = (
    Array.isArray(categoriesQ.data) ? categoriesQ.data : []
  ).map(toOption);

  // Ручные переключения поверх дефолтов; ключ — externalId строки (уникален в файле)
  const [actions, setActions] = useState<Record<string, RowAction>>({});
  const [categoryRefs, setCategoryRefs] = useState<Record<string, string>>({});

  // ⟳ читает статус, а не состояние переключателей: строка не может попасть в payload
  // ни при каких действиях пользователя (§3.4: «переключение недоступно»). Второй
  // структурный инвариант: adopt без duplicateOf невозможен — усыновлять было бы некого.
  const actionOf = (row: ImportReviewRow): RowAction => {
    if (row.status === 'already_imported') return 'skip';
    const chosen = actions[row.externalId] ?? defaultAction(row);
    return chosen === 'adopt' && row.duplicateOf === undefined ? 'create' : chosen;
  };
  const categoryOf = (row: ImportReviewRow): string =>
    categoryRefs[row.externalId] ?? row.suggestedCategoryRef ?? '';

  const counts = {
    new: rows.filter((r) => r.status === 'new').length,
    duplicate: rows.filter((r) => r.status === 'probable_duplicate').length,
    already: rows.filter((r) => r.status === 'already_imported').length,
  };

  const creating = rows.filter((r) => actionOf(r) === 'create');
  const needsCategory = creating.filter((r) => categoryOf(r) === '').length;
  const ready =
    creating.length - needsCategory + rows.filter((r) => actionOf(r) === 'adopt').length;

  const items = (): ImportConfirmItem[] =>
    rows.flatMap((row): ImportConfirmItem[] => {
      const action = actionOf(row);
      if (action === 'skip') return [];
      if (action === 'adopt' && row.duplicateOf !== undefined) {
        return [{ row: toCanonical(row), action: 'adopt', adoptEntityId: row.duplicateOf }];
      }
      return [{ row: toCanonical(row), action: 'create', categoryRef: categoryOf(row) }];
    });

  return (
    <>
      {/* Счётчики §3.4 шаг 3 макета */}
      <Card data-testid="review-counters" className="p-3 text-sm tabular-nums">
        ✓ новых {counts.new} · ⊘ дубли {counts.duplicate} · ⟳ уже {counts.already}
      </Card>

      <Card className="flex flex-col gap-2 p-3">
        {rows.map((row) => (
          <Row
            key={row.externalId}
            row={row}
            action={actionOf(row)}
            categoryRef={categoryOf(row)}
            categories={categories}
            onCategory={(ref) => setCategoryRefs((s) => ({ ...s, [row.externalId]: ref }))}
            onToggle={() =>
              setActions((s) => ({
                ...s,
                [row.externalId]: actionOf(row) === 'adopt' ? 'create' : 'adopt',
              }))
            }
          />
        ))}
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        {counts.duplicate > 0 && (
          <Button
            variant="outline"
            size="sm"
            // §3.4: кнопка возвращает ВСЮ группу ⊘ к дефолту (adopt), снимая ручные
            // «создать всё равно» — поэтому она стирает переключения, а не ставит свои
            onClick={() =>
              setActions((s) =>
                Object.fromEntries(
                  Object.entries(s).filter(
                    ([id]) =>
                      rows.find((r) => r.externalId === id)?.status !== 'probable_duplicate',
                  ),
                ),
              )
            }
          >
            Снять все дубли
          </Button>
        )}
        <span className="flex-1" />
        {needsCategory > 0 && (
          <span data-testid="needs-category" className="text-xs text-text-muted">
            Ждут категорию: {needsCategory}
          </span>
        )}
        <Button
          size="sm"
          data-testid="confirm-import"
          disabled={pending || needsCategory > 0 || ready === 0}
          onClick={() => onConfirm(items())}
        >
          {pending ? <Spinner size={14} aria-label="Импорт" /> : `Подтвердить ${ready}`}
        </Button>
      </div>
    </>
  );
}

function Row({
  row,
  action,
  categoryRef,
  categories,
  onCategory,
  onToggle,
}: {
  row: ImportReviewRow;
  action: RowAction;
  categoryRef: string;
  categories: CategoryOption[];
  onCategory: (ref: string) => void;
  onToggle: () => void;
}) {
  const title = rowTitle(row);
  const money = formatMoney(row.amount, row.direction);
  const duplicateOf = row.duplicateOf;

  return (
    <div
      data-testid="review-row"
      data-status={row.status}
      className="flex items-center gap-2 text-sm"
    >
      <span title={STATUS_TITLE[row.status]} className="shrink-0">
        {STATUS_ICON[row.status]}
      </span>
      <span className="w-10 shrink-0 text-xs tabular-nums text-text-muted">
        {ddmm(row.occurredOn)}
      </span>
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <span className={`shrink-0 tabular-nums ${TONE_CLASS[money.tone]}`}>{money.text}</span>

      {action === 'skip' ? (
        <span className="shrink-0 text-xs text-text-muted">уже импортирована</span>
      ) : (
        <select
          aria-label={`Категория «${title}»`}
          value={categoryRef}
          onChange={(e) => onCategory(e.target.value)}
          className={`${FIELD_CLS} max-w-36 shrink-0`}
        >
          <option value="">❓ выбрать</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.icon ? `${c.icon} ` : ''}
              {c.title}
            </option>
          ))}
        </select>
      )}

      {/* Переключатель существует только когда есть кого усыновлять (duplicateOf) */}
      {row.status === 'probable_duplicate' && duplicateOf !== undefined && (
        <>
          {/* С какой сущностью совпало (§3.4): её title потребовал бы запроса на строку
              (до 1000 строк) — вместо этого строка ВЕДЁТ на совпавшую запись */}
          <button
            type="button"
            aria-label="Открыть совпавшую запись"
            onClick={() => {
              const { activeTab, push } = useNav.getState();
              push(activeTab, { kind: 'entity', id: duplicateOf });
            }}
            className="shrink-0 cursor-pointer rounded-control px-1 text-xs text-text-muted underline decoration-dotted transition hover:text-text"
          >
            дубль ↗
          </button>
          <Button
            size="sm"
            variant={action === 'create' ? 'primary' : 'outline'}
            aria-pressed={action === 'create'}
            className="shrink-0 text-xs"
            onClick={onToggle}
          >
            создать всё равно
          </Button>
        </>
      )}
    </div>
  );
}
