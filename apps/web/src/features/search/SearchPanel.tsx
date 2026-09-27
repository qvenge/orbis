import type { BlockResult } from '@orbis/shared';
import type { UseQueryResult } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { useOpenRecord } from '../../app/useOpenRecord';
import { useNav } from '../../state/navigation';
import { Input } from '../../ui/Input';
import { Spinner } from '../../ui/Spinner';
import { useApps } from '../apps/useApps';
import { SEARCH_GROUPS, type SearchGroup } from './search-query';
import { type SearchGroupsData, useSearchGroups, useSearchTexts } from './useSearch';

const GROUP_TITLES: Readonly<Record<SearchGroup, string>> = {
  records: 'Записи',
  pages: 'Страницы',
  apps: 'Приложения',
};

/** Найденное одной строкой: запись и страница открываются правилом открытия, приложение — переключением. */
interface Hit {
  id: string;
  group: SearchGroup;
  title: string;
  emoji: string | null;
  /** Выключенное приложение — приглушённо; нажатие ведёт на его адрес, там плашка «выключено». */
  disabled: boolean;
}

/**
 * Панель поиска хоста (спека 1б §6.4): поле и результаты группами «Записи», «Страницы», «Приложения»
 * (пустая группа не рисуется; «и ещё N» — что не поместилось в потолок группы), «Ничего не найдено»,
 * ↑↓ — выбор, Enter — открыть выбранное (по умолчанию первое), Esc — очистить поле (окно ⌘K
 * закрывает сам Radix).
 *
 * Одна панель на обе формы: телефон — экран хоста с полем ВНИЗУ, над клавиатурой (`fieldAt:
 * 'bottom'`), десктоп — окно ⌘K с полем сверху. Куда ведут ссылки, решает рамка вокруг
 * (`FrameAppContext`): экран хоста снимается переходом, окно — нет (его нет в истории, §7.3).
 *
 * Модуль ЛЕНИВЫЙ (R-35): его грузят экран поиска и окно ⌘K, оба ленивые.
 */
export function SearchPanel({
  value,
  onChange,
  fieldAt,
  onPicked,
}: {
  value: string;
  onChange: (q: string) => void;
  fieldAt: 'top' | 'bottom';
  /** Выбор результата — хозяину панели (окно ⌘K закрывается). */
  onPicked?: () => void;
}) {
  const texts = useSearchTexts(value);
  const openRecord = useOpenRecord();
  // Список приложений — здесь, при открытии, а не в группе: группа монтируется после паузы в наборе,
  // и новый наблюдатель протухшего ключа перезапросил бы список на каждое слово.
  const apps = useApps();
  const hits = useRef<readonly Hit[]>([]);
  const [active, setActive] = useState(0);
  const textKey = texts === null ? '' : texts.records;
  // biome-ignore lint/correctness/useExhaustiveDependencies: выбор сбрасывается на НОВОМ запросе — ключ и есть причина
  useEffect(() => setActive(0), [textKey]);

  const pick = (hit: Hit) => {
    onPicked?.();
    if (hit.group === 'apps') useNav.getState().switchApp(hit.id);
    else openRecord(hit.id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = hits.current.length;
    if (e.key === 'ArrowDown' && n > 0) {
      e.preventDefault();
      setActive((i) => (i + 1) % n);
    } else if (e.key === 'ArrowUp' && n > 0) {
      e.preventDefault();
      setActive((i) => (i - 1 + n) % n);
    } else if (e.key === 'Enter') {
      const hit = hits.current[Math.min(active, n - 1)];
      if (hit === undefined) return;
      e.preventDefault();
      pick(hit);
    } else if (e.key === 'Escape' && fieldAt === 'bottom' && value !== '') {
      e.preventDefault();
      onChange('');
    }
  };

  const field = (
    <div className="flex shrink-0 items-center gap-2 px-3 py-2">
      <Search size={16} aria-hidden className="shrink-0 text-text-muted" />
      <Input
        type="search"
        aria-label="Строка поиска"
        placeholder="Найти запись, страницу или приложение"
        // Фокус — сразу в поле: поиск открывают ради ввода (🔍, ⌘K), лишнее нажатие было бы помехой.
        autoFocus
        enterKeyHint="search"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        className="min-w-0 flex-1"
      />
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {fieldAt === 'top' && field}
      <div data-testid="search-results" className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {texts !== null && (
          <SearchResults
            texts={texts}
            disabledApp={(id) => apps.byId.get(id)?.disabled === true}
            active={active}
            onHits={(h) => {
              hits.current = h;
            }}
            onPick={pick}
          />
        )}
      </div>
      {fieldAt === 'bottom' && field}
    </div>
  );
}

function SearchResults({
  texts,
  disabledApp,
  active,
  onHits,
  onPick,
}: {
  texts: Parameters<typeof useSearchGroups>[0];
  disabledApp: (id: string) => boolean;
  active: number;
  onHits: (hits: readonly Hit[]) => void;
  onPick: (hit: Hit) => void;
}) {
  const data = useSearchGroups(texts);
  const groups = SEARCH_GROUPS.map((g) => ({ g, ...rowsOf(g, data, disabledApp) }));
  const flat = groups.flatMap((x) => x.hits);
  onHits(flat);

  const loading = SEARCH_GROUPS.some((g) => data[g].isPending);
  const failed = SEARCH_GROUPS.some((g) => data[g].isError);
  if (flat.length === 0) {
    if (loading) return <Spinner aria-label="Ищу" className="m-3 text-text-muted" />;
    if (!failed) return <p className="px-2 py-3 text-sm text-text-muted">Ничего не найдено</p>;
  }

  let index = 0;
  return (
    <>
      {groups.map(({ g, hits, more, error }) => {
        if (hits.length === 0 && error === null) return null;
        return (
          <fieldset
            key={g}
            aria-label={GROUP_TITLES[g]}
            className="m-0 flex min-w-0 flex-col border-0 p-0 py-1"
          >
            <h2 className="px-2 pt-2 pb-1 text-2xs font-medium tracking-wide text-text-muted uppercase">
              {GROUP_TITLES[g]}
            </h2>
            {error !== null && (
              <p role="alert" className="px-2 py-1 text-sm text-danger">
                Поиск не удался: {error}
              </p>
            )}
            {hits.map((hit) => {
              const mine = index++;
              return <HitButton key={hit.id} hit={hit} active={mine === active} onPick={onPick} />;
            })}
            {more > 0 && <p className="px-2 py-1 text-xs text-text-muted">и ещё {more}</p>}
          </fieldset>
        );
      })}
    </>
  );
}

function HitButton({
  hit,
  active,
  onPick,
}: {
  hit: Hit;
  active: boolean;
  onPick: (hit: Hit) => void;
}): ReactNode {
  return (
    <button
      type="button"
      data-testid={`search-hit-${hit.id}`}
      data-active={active ? '' : undefined}
      data-disabled={hit.disabled ? '' : undefined}
      onClick={() => onPick(hit)}
      className={`flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-control px-2 text-left text-sm transition hover:bg-surface-2 ${
        active ? 'bg-surface-2' : ''
      } ${hit.disabled ? 'opacity-50' : ''}`}
    >
      <span aria-hidden className="w-5 shrink-0 text-center">
        {hit.emoji ?? '▫️'}
      </span>
      <span className="min-w-0 flex-1 truncate">{hit.title}</span>
      {hit.disabled && <span className="text-2xs text-text-muted">выключено</span>}
    </button>
  );
}

function rowsOf(
  g: SearchGroup,
  data: SearchGroupsData,
  disabledApp: (id: string) => boolean,
): { hits: Hit[]; more: number; error: string | null } {
  const q: UseQueryResult<BlockResult> = data[g];
  if (q.isError) return { hits: [], more: 0, error: q.error.message };
  const r = q.data;
  if (r === undefined || !r.ok || r.kind !== 'rows') return { hits: [], more: 0, error: null };
  return {
    hits: r.rows.map((e) => ({
      id: e.id,
      group: g,
      title: e.title,
      emoji: e.emoji,
      disabled: g === 'apps' && disabledApp(e.id),
    })),
    more: r.more,
    error: null,
  };
}
