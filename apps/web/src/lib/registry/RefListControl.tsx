// apps/web/src/lib/registry/RefListControl.tsx
//
// Контрол «упорядоченный список ссылок» (срез 1б §9.3): порядок значения — смысл свойства, как у
// «Навигации» приложения (порядок разделов). Перестановка — кнопками ↑↓ и перетаскиванием, добавление
// — поиском (`entity.suggest`), удаление — крестиком. Ссылка на архивную запись — строкой-плашкой
// «в архиве» (§4.4, §6.6), а не пустотой: владелец видит, что раздел был и что с ним стало.
//
// Модуль ЛЕНИВЫЙ: `PropertyControl` (эагерный в экране записи) грузит его только для свойства с этим
// контролом, а редактор навигации — сам ленивый. Статический импорт вернул бы поиск, перестановку и
// плашки в первый кадр каждой записи (сторож `LAZY_DETAIL_MODULES` в `scripts/check-lazy-chunks.ts`).
import { effectiveLabel, OWNER_LOCALE, type PropertyDefinition } from '@orbis/shared';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { type RouterOutputs, trpc } from '../../trpc';
import { FIELD_CLASS } from './controls';

type RefRow = RouterOutputs['entity']['resolveRefs'][number];

/** Строка, чья запись в архиве, — подпись плашки (§6.6). Одна константа на контрол и тесты. */
export const ARCHIVED_NOTE = 'в архиве';
/** Ссылка, которой ответ не знает (удалена, чужая). */
export const MISSING_NOTE = 'не найдено';

/**
 * Заголовки и архивность ссылок — одним `entity.resolveRefs`. Ключ — набор id без порядка
 * (`refIdsKey`): перестановка раздела не зовёт сеть, и у редактора, и у списка один запрос.
 */
export function useRefRows(ids: readonly string[]): {
  rows: readonly RefRow[] | undefined;
  byId: ReadonlyMap<string, RefRow>;
} {
  const key = [...new Set(ids)].sort();
  const q = trpc.entity.resolveRefs.useQuery(
    { ids: key },
    { enabled: key.length > 0, placeholderData: (prev) => prev },
  );
  const rows = key.length === 0 ? [] : Array.isArray(q.data) ? q.data : undefined;
  return { rows, byId: new Map((rows ?? []).map((r) => [r.id, r])) };
}

/** Задержка поиска: запрос — по паузе набора, а не на каждую букву. */
const SEARCH_DEBOUNCE_MS = 200;

/**
 * Поиск записи для ссылки (`entity.suggest` — вхождение фрагмента в заголовок, архивные не
 * предлагаются). `exclude` — то, что уже выбрано: второй экземпляр раздела поиск не предложит.
 */
export function RefSearch({
  label,
  exclude = [],
  disabled = false,
  onPick,
}: {
  label: string;
  exclude?: readonly string[];
  disabled?: boolean;
  onPick: (id: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setTerm(draft.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [draft]);
  const found = trpc.entity.suggest.useQuery(
    { term, limit: 10 },
    { enabled: !disabled && term !== '' },
  );
  const options = (Array.isArray(found.data) ? found.data : []).filter(
    (e) => !exclude.includes(e.id),
  );
  return (
    <div className="flex flex-col gap-1">
      <input
        type="search"
        aria-label={label}
        placeholder="Найти запись…"
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        className={FIELD_CLASS}
      />
      {term !== '' && draft.trim() !== '' && (
        <ul aria-label={`Найдено: ${label}`} className="flex flex-col">
          {found.isError ? (
            <li className="px-2 py-1 text-sm text-danger">Не удалось найти</li>
          ) : found.data === undefined ? (
            <li className="px-2 py-1 text-sm text-text-muted">Поиск…</li>
          ) : options.length === 0 ? (
            <li className="px-2 py-1 text-sm text-text-muted">Ничего не найдено</li>
          ) : (
            options.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(e.id);
                    setDraft('');
                    setTerm('');
                  }}
                  className="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm transition hover:bg-surface-2"
                >
                  {e.emoji && <span aria-hidden>{e.emoji}</span>}
                  {e.title}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

/** Переставить элемент `from` на место `to` (прочие сдвигаются). */
function moved(list: readonly string[], from: number, to: number): string[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

/**
 * Упорядоченный список ссылок.
 *
 * `onChange` отдаёт СПИСОК всегда, пустой — тоже `[]`, а не снятие: «Навигация» без значения читается
 * испорченной оболочкой (`useAppShell`, `shellOf`), а пустая навигация — законное состояние
 * приложения (§9.5).
 */
export function RefListControl({
  def,
  label,
  value,
  onChange,
}: {
  def: PropertyDefinition;
  label?: string;
  value: unknown;
  onChange: (next: string[]) => void;
}) {
  const name = label ?? effectiveLabel(def.label, OWNER_LOCALE);
  const ids = Array.isArray(value)
    ? value.filter((x): x is string => typeof x === 'string' && x !== '')
    : [];
  const { rows, byId } = useRefRows(ids);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const max = def.type.kind === 'ref' ? def.type.max : undefined;
  const full = max !== undefined && ids.length >= max;

  return (
    <div
      data-testid={`prop-${def.id}`}
      data-kind="ref-list"
      className="flex min-w-0 flex-col gap-1"
    >
      <ol aria-label={name} className="flex flex-col gap-0.5">
        {ids.map((id, i) => {
          const r = byId.get(id);
          const missing = r === undefined && rows !== undefined;
          const title = r?.title ?? (missing ? id : '…');
          return (
            <li
              key={id}
              data-testid="ref-row"
              data-id={id}
              {...(r?.archived === true && { 'data-archived': 'true' })}
              draggable
              onDragStart={(e) => {
                // Firefox не начинает перетаскивание без данных; `dataTransfer` бывает пуст у
                // синтетических событий — порядок держит `dragFrom`, а не данные.
                e.dataTransfer?.setData('text/plain', id);
                if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
                setDragFrom(i);
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragFrom !== null && dragFrom !== i) onChange(moved(ids, dragFrom, i));
                setDragFrom(null);
              }}
              onDragEnd={() => setDragFrom(null)}
              className={`flex min-h-11 items-center gap-2 rounded-md px-2 text-sm ${
                r?.archived === true || missing ? 'bg-surface-2 text-text-muted' : ''
              } ${dragFrom === i ? 'opacity-50' : ''}`}
            >
              {r?.emoji && <span aria-hidden>{r.emoji}</span>}
              <span data-testid="ref-title" className="min-w-0 flex-1 truncate">
                {title}
              </span>
              {(r?.archived === true || missing) && (
                <span className="text-2xs">{missing ? MISSING_NOTE : ARCHIVED_NOTE}</span>
              )}
              <button
                type="button"
                aria-label={`Выше: ${title}`}
                disabled={i === 0}
                onClick={() => onChange(moved(ids, i, i - 1))}
                className="cursor-pointer rounded p-1 hover:bg-surface-2 disabled:cursor-default disabled:opacity-30"
              >
                <ArrowUp size={14} aria-hidden />
              </button>
              <button
                type="button"
                aria-label={`Ниже: ${title}`}
                disabled={i === ids.length - 1}
                onClick={() => onChange(moved(ids, i, i + 1))}
                className="cursor-pointer rounded p-1 hover:bg-surface-2 disabled:cursor-default disabled:opacity-30"
              >
                <ArrowDown size={14} aria-hidden />
              </button>
              <button
                type="button"
                aria-label={`Убрать: ${title}`}
                onClick={() => onChange(ids.filter((x) => x !== id))}
                className="cursor-pointer rounded p-1 hover:bg-surface-2"
              >
                <X size={14} aria-hidden />
              </button>
            </li>
          );
        })}
      </ol>
      <RefSearch
        label={`Добавить: ${name}`}
        exclude={ids}
        disabled={full}
        onPick={(id) => onChange(ids.includes(id) ? ids : [...ids, id])}
      />
    </div>
  );
}
