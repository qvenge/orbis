import { effectiveLabel, OWNER_LOCALE, type PropertyDefinition } from '@orbis/shared';
import { useState } from 'react';
import { useEntityOptions } from '../entity-ref/useEntityOptions';
import { useResolvedRefs } from '../entity-ref/useResolvedRefs';
import { FIELD_CLASS } from './controls';

const BUTTON =
  'min-h-11 cursor-pointer rounded-md px-2 text-sm transition hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default disabled:opacity-50';

/** Saved generic refs are never cleaned automatically, including archived/unavailable targets. */
export function RefManyControl({
  def,
  value,
  onChange,
  disabled = false,
}: {
  def: PropertyDefinition;
  value: readonly string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const label = effectiveLabel(def.label, OWNER_LOCALE);
  const [term, setTerm] = useState('');
  const resolved = useResolvedRefs(value);
  const max = def.type.kind === 'ref' ? def.type.max : undefined;
  const full = max !== undefined && value.length >= max;
  const options = useEntityOptions({
    target: def.type.kind === 'ref' ? def.type.target : undefined,
    term,
    exclude: value,
    enabled: !disabled && !full,
  });
  return (
    <div
      data-testid={`prop-${def.id}`}
      data-kind="ref-many"
      className="flex min-w-0 flex-col gap-2"
    >
      <ol aria-label={label} className="flex flex-col gap-1">
        {value.map((id, index) => {
          const row = resolved.byId.get(id);
          const failed = resolved.failedIds.has(id);
          const pending = resolved.pendingIds.has(id);
          const title =
            row?.title ??
            (pending ? 'Загрузка…' : failed ? 'Не удалось прочитать ссылку' : 'Недоступная ссылка');
          return (
            <li
              key={id}
              data-testid="ref-many-row"
              data-id={id}
              className="flex min-h-11 items-center gap-2 rounded-md px-2 text-sm"
            >
              {row?.emoji && <span aria-hidden>{row.emoji}</span>}
              <span className="min-w-0 flex-1 break-words">{title}</span>
              {!row && <span className="min-w-0 break-all text-2xs text-text-muted">{id}</span>}
              {row?.archived && <span className="text-2xs text-text-muted">в архиве</span>}
              <button
                type="button"
                aria-label={`Убрать: ${title} (${id})`}
                disabled={disabled}
                className={BUTTON}
                onClick={() => onChange(value.filter((_, at) => at !== index))}
              >
                Убрать
              </button>
            </li>
          );
        })}
      </ol>
      {resolved.failedIds.size > 0 && (
        <button type="button" disabled={disabled} className={BUTTON} onClick={resolved.retry}>
          Повторить чтение ссылок
        </button>
      )}
      {full && <p className="text-sm text-text-muted">Предел ссылок: {max}</p>}
      <input
        type="search"
        aria-label={`Добавить: ${label}`}
        placeholder="Найти запись…"
        value={term}
        disabled={disabled || full}
        onChange={(e) => setTerm(e.target.value)}
        className={`${FIELD_CLASS} min-h-11`}
      />
      {!disabled && !full && (
        <>
          {options.isError ? (
            <div role="alert" className="text-sm text-danger">
              Не удалось найти записи{' '}
              <button type="button" className={BUTTON} onClick={options.retry}>
                Повторить поиск
              </button>
            </div>
          ) : options.isPending ? (
            <p className="text-sm text-text-muted">Поиск…</p>
          ) : options.rows.length === 0 ? (
            <p className="text-sm text-text-muted">Ничего не найдено</p>
          ) : (
            <ul aria-label={`Найдено: ${label}`}>
              {options.rows.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    className={`${BUTTON} w-full text-left`}
                    aria-label={`Добавить: ${row.title}`}
                    onClick={() => {
                      if (!value.includes(row.id)) onChange([...value, row.id]);
                    }}
                  >
                    {row.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {options.mayHaveMore && (
            <p className="text-sm text-text-muted">Возможно, есть ещё — уточните поиск</p>
          )}
        </>
      )}
    </div>
  );
}
