import { ROLE_DEPENDENCY } from '@orbis/shared';
import { Ban, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { RecordLink } from '../../lib/entity-ref/RecordLink';
import { useFreshnessVisible } from '../../lib/freshness/screen';
import type { RelationKey } from '../../lib/optimistic/adapters';
import { useReadableRecordIds } from '../../lib/optimistic/create-intent-scope';
import {
  type RelationOperation,
  useRelationCommand,
} from '../../lib/optimistic/use-relation-command';
import { type RouterOutputs, trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Spinner } from '../../ui/Spinner';
import { offerUndoLazy } from '../undo/undo-lazy';
import { pushUndoable } from '../undo/undo-stack';
import { useHostReadOnly } from './record-host';

type Relation = NonNullable<RouterOutputs['entity']['get']['relations']>[number];
/** Куда смотрит создаваемая связь: текущая блокирует выбранную (out) или наоборот (in). */
type Direction = 'out' | 'in';

const SECTION_LABEL = 'text-2xs font-medium uppercase tracking-wide text-text-muted';
const ROW =
  'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition hover:bg-surface-2/60';
const PICKER_NOTE = 'px-2 py-1.5 text-xs text-text-muted';
const PICKER_FIELD =
  'min-w-0 rounded-md bg-transparent px-1 text-sm text-text outline-none transition placeholder:text-text-muted focus-visible:bg-surface-2/70';
/** Минимум символов, с которого пикер идёт в сеть. */
const SEARCH_MIN = 2;
/** Пауза набора, после которой пикер идёт в сеть: без неё запрос уходил на каждую букву. */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * Значение, отстающее от ввода на паузу набора. Прецедента debounce в web не было —
 * минимальная реализация таймером: следующий ввод снимает предыдущий таймер, в сеть
 * уходит только последнее набранное.
 */
function useDebounced(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * Секция 7 «Блокировки» (02-core-os §3.5.7): «блокирует» — исходящие blocks-связи,
 * «заблокирована» — входящие от НЕзакрытых задач. Связи приходят готовыми в
 * entity.get(include:['relations']) экрана (prop relations) — своего relation.listFor
 * секция не заводит; титул и статус второй стороны дочитываются per-id entity.get
 * (прецедент EntityRef: React Query кэширует и дедупит, списки короткие).
 *
 * Пустые списки скрыты (§3.5), но заголовок секции и «+» остаются: это единственный
 * путь создания blocks-связи из UI, и прятать его вместе с пустотой значило бы сделать
 * фичу недостижимой (та же логика, что у «тихой строки добавления» подзадач).
 */
export function Blockers({ entityId, relations }: { entityId: string; relations: Relation[] }) {
  // Предпросмотр шаблона (хост `readOnly`): блокировки видны и открываются, но не ставятся и не
  // снимаются.
  const readOnly = useHostReadOnly();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [direction, setDirection] = useState<Direction>('out');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [failure, setFailure] = useState<{
    entityId: string;
    kind: 'rejected' | 'unknown';
    message: string;
    operation: RelationOperation;
    key: RelationKey;
  }>();
  const activeFailure = failure?.entityId === entityId ? failure : undefined;
  const currentId = useRef(entityId);
  currentId.current = entityId;
  const { run, reconcile } = useRelationCommand();

  const blocks = relations.filter((r) => r.role === ROLE_DEPENDENCY);
  const outgoing = blocks.filter((r) => r.sourceId === entityId);
  const incoming = blocks.filter((r) => r.targetId === entityId);
  const other = (r: Relation) => (r.sourceId === entityId ? r.targetId : r.sourceId);
  const ids = [...outgoing, ...incoming].map(other);

  // Титулы и статусы сторон — ОДНИМ запросом (entity.resolveRefs), а не entity.get на
  // строку: сущность целиком секции не нужна, ей нужны титул и статус, а per-id шторм
  // тем заметнее, чем длиннее список.
  const shown = useFreshnessVisible();
  const readable = useReadableRecordIds(ids);
  const sides = trpc.entity.resolveRefs.useQuery(
    { ids: readable },
    { enabled: shown && readable.length > 0 },
  );
  const byId = new Map((sides.data ?? []).map((e) => [e.id, e]));
  const title = (id: string) => byId.get(id)?.title ?? `${id.slice(0, 8)}…`;
  // Пока сущность не доехала — блокер считается живым: спрятать реальную блокировку хуже,
  // чем показать лишнюю строку на время загрузки. «Закрыт» приходит с сервера полем
  // `completable` (набор `closed` контракта) — второй копии набора в web больше нет
  // (§6.1, Р-К-14): её разъезд с компилятором ломал lock-иконку §3.6.
  const alive = (id: string) => byId.get(id)?.completable?.closed !== true;
  const blockedBy = incoming.filter((r) => alive(r.sourceId));

  // Был entity.query с `search=`, то есть FTS по plainto_tsquery — совпадение только по
  // ЦЕЛОМУ слову: «Куп» не находило «Купить кроссовки», и пикер честно извинялся подсказкой.
  // entity.suggest ищет ВХОЖДЕНИЕ набранного фрагмента, извиняться больше не за что.
  // Остальные состояния (ошибка, загрузка, пусто) остались: немая пустая область читается
  // как сломанная фича.
  const q = useDebounced(draft.trim(), SEARCH_DEBOUNCE_MS);
  const search = trpc.entity.suggest.useQuery(
    { term: q, limit: 10 },
    { enabled: adding && q.length >= SEARCH_MIN },
  );
  const known = new Set([entityId, ...ids]);
  // Закрытую задачу нельзя предлагать блокером: список «Заблокирована» показывает только
  // незакрытые (§3.5.7), поэтому такая связь создалась бы невидимой ни в одном списке и
  // неповторимой (id уже в `known`). Направления «блокирует» ограничение не касается —
  // исходящая связь видна всегда.
  const found = (search.data ?? []).filter(
    (e) => !known.has(e.id) && (direction === 'out' || e.completable?.closed !== true),
  );

  function finish(operation: RelationOperation) {
    if (operation === 'delete') setConfirming(null);
    else {
      setDraft('');
      setAdding(false);
      setDirection('out');
    }
  }

  async function mutate(operation: RelationOperation, key: RelationKey) {
    if (locked.current || activeFailure?.kind === 'unknown') return;
    const label = title(key.source_id === entityId ? key.target_id : key.source_id);
    locked.current = true;
    setBusy(true);
    setFailure(undefined);
    try {
      const outcome = await run(operation, key);
      if (!outcome) return;
      if (outcome.kind !== 'confirmed') {
        if (currentId.current === entityId) setFailure({ ...outcome, operation, key, entityId });
        return;
      }
      if (outcome.actionId && typeof outcome.consequences === 'boolean') {
        const entry = { actionId: outcome.actionId, entityIds: [] };
        if (operation === 'delete')
          offerUndoLazy({ ...entry, title: `Блокировка снята: «${label}»` });
        else pushUndoable({ ...entry, title: `блокировка «${label}»` });
      }
      if (currentId.current === entityId) finish(operation);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  async function verifyFailure() {
    if (!activeFailure || locked.current) return;
    locked.current = true;
    setBusy(true);
    try {
      const result = await reconcile(entityId, activeFailure.operation, activeFailure.key);
      if (result === 'unavailable' || currentId.current !== entityId) return;
      setFailure(undefined);
      if (result === 'matches') finish(activeFailure.operation);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  const list = (label: string, items: Relation[]) => (
    <div className="flex flex-col">
      <p className={SECTION_LABEL}>{label}</p>
      <ul className="flex flex-col">
        {items.map((r) => (
          <li key={r.id} data-testid="block-row" className={ROW}>
            <Ban size={14} aria-hidden className="shrink-0 text-text-muted/70" />
            <RecordLink
              id={other(r)}
              className="min-w-0 flex-1 cursor-pointer truncate text-left hover:underline"
            >
              {byId.get(other(r))?.title ??
                search.data?.find((row) => row.id === other(r))?.title ??
                title(other(r))}
            </RecordLink>
            {/* Подтверждение-минимум: соседние разрушающие действия web («Снять аспект»,
                «Архивировать») модалок не заводят, а Undo по actionId здесь недоступен —
                поэтому спрашиваем вторым кликом прямо в строке. */}
            {readOnly ? null : confirming === r.id ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-danger"
                  disabled={busy || activeFailure?.kind === 'unknown'}
                  onClick={() =>
                    void mutate('delete', {
                      source_id: r.sourceId,
                      target_id: r.targetId,
                      role: ROLE_DEPENDENCY,
                    })
                  }
                >
                  Снять
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  // Отказ снятия гаснет вместе с вопросом: иначе красная плашка висела бы
                  // до ухода с экрана, хотя действие уже отменено.
                  onClick={() => {
                    setConfirming(null);
                    if (activeFailure?.kind === 'rejected') setFailure(undefined);
                  }}
                >
                  Отмена
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0"
                aria-label="Снять блокировку"
                title="Снять блокировку"
                disabled={busy || activeFailure?.kind === 'unknown'}
                onClick={() => setConfirming(r.id)}
              >
                <X size={14} aria-hidden />
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <p className={SECTION_LABEL}>Блокировки</p>
        {!readOnly && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Добавить блокировку"
            title="Добавить блокировку"
            onClick={() => setAdding((v) => !v)}
          >
            <Plus size={14} aria-hidden />
          </Button>
        )}
      </div>
      {outgoing.length > 0 && list('Блокирует', outgoing)}
      {blockedBy.length > 0 && list('Заблокирована', blockedBy)}
      {adding && !readOnly && (
        <div className="flex flex-col gap-1 px-2 py-1.5">
          {/* Обе стороны создаются с ОДНОГО экрана: «заблокирована» просто меняет
              source/target местами. Без выбора направления список «Заблокирована»
              пополнялся только с detail самого блокера. */}
          <select
            aria-label="Направление блокировки"
            value={direction}
            onChange={(e) => setDirection(e.target.value === 'in' ? 'in' : 'out')}
            className={PICKER_FIELD}
          >
            <option value="out">блокирует выбранную</option>
            <option value="in">заблокирована выбранной</option>
          </select>
          <input
            aria-label="Поиск записи"
            value={draft}
            placeholder="Найти запись…"
            onChange={(e) => setDraft(e.target.value)}
            className={PICKER_FIELD}
          />
          {/* Порядок веток: сначала «ещё не искали», потом ошибка/загрузка, и только затем
              пустой результат — иначе «ничего не найдено» мигало бы на каждом нажатии.
              Прецедент разводки состояний — лента транзакций Бюджета, 03-budget §3.3. */}
          {q.length < SEARCH_MIN ? (
            <p className={PICKER_NOTE}>Поиск от 2 символов</p>
          ) : search.isError ? (
            <p role="alert" className="px-2 py-1.5 text-sm text-danger">
              Не удалось выполнить поиск
            </p>
          ) : search.isLoading ? (
            <Spinner size={14} aria-label="Поиск" className="px-2 py-1.5 text-text-muted" />
          ) : found.length === 0 ? (
            // Сюда же попадает случай «нашлось, но всё уже связано с текущей» — такие
            // сущности отсеяны `known` и уже видны списками выше.
            <p className={PICKER_NOTE}>Ничего не найдено</p>
          ) : (
            <ul className="flex flex-col">
              {found.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    disabled={busy || activeFailure?.kind === 'unknown'}
                    onClick={() =>
                      void mutate(
                        'create',
                        direction === 'out'
                          ? { source_id: entityId, target_id: e.id, role: ROLE_DEPENDENCY }
                          : { source_id: e.id, target_id: entityId, role: ROLE_DEPENDENCY },
                      )
                    }
                    className="w-full cursor-pointer truncate rounded-md px-2 py-1.5 text-left text-sm transition hover:bg-surface-2/60"
                  >
                    {e.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {busy && confirming && (
        <p role="status" className={PICKER_NOTE}>
          Снимается…
        </p>
      )}
      {activeFailure && (
        <div role="alert" className="px-2 text-sm text-danger">
          <p>{activeFailure.message}</p>
          {activeFailure.kind === 'unknown' && (
            <Button size="sm" disabled={busy} onClick={() => void verifyFailure()}>
              Проверить состояние
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
