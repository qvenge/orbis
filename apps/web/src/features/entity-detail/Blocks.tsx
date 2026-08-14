import { Ban, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNav } from '../../state/navigation';
import { type RouterOutputs, trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Spinner } from '../../ui/Spinner';
import { detailGetInput } from './useEntityDetail';

type Relation = NonNullable<RouterOutputs['entity']['get']['relations']>[number];
/** Куда смотрит создаваемая связь: текущая блокирует выбранную (out) или наоборот (in). */
type Direction = 'out' | 'in';

// «Незакрытая» — ровно семантика excludeBlocked (§6.1): блокер БЕЗ task-аспекта живой,
// COALESCE(status,'') NOT IN ('done','cancelled'). Разъезд с ней ломает lock-иконку §3.6.
const CLOSED = new Set(['done', 'cancelled']);
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
 * Секция 6 «Блокировки» (02-core-os §3.5.6): «блокирует» — исходящие blocks-связи,
 * «заблокирована» — входящие от НЕзакрытых задач. Связи приходят готовыми в
 * entity.get(include:['relations']) экрана (prop relations) — своего relation.listFor
 * секция не заводит; титул и статус второй стороны дочитываются per-id entity.get
 * (прецедент EntityRef/PinnedList: React Query кэширует и дедупит, списки короткие).
 *
 * Пустые списки скрыты (§3.5), но заголовок секции и «+» остаются: это единственный
 * путь создания blocks-связи из UI, и прятать его вместе с пустотой значило бы сделать
 * фичу недостижимой (та же логика, что у «тихой строки добавления» подзадач).
 */
export function Blocks({ entityId, relations }: { entityId: string; relations: Relation[] }) {
  const push = useNav((s) => s.push);
  const activeTab = useNav((s) => s.activeTab);
  const utils = trpc.useUtils();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [direction, setDirection] = useState<Direction>('out');
  const [confirming, setConfirming] = useState<string | null>(null);

  const blocks = relations.filter((r) => r.relationType === 'blocks');
  const outgoing = blocks.filter((r) => r.sourceId === entityId);
  const incoming = blocks.filter((r) => r.targetId === entityId);
  const other = (r: Relation) => (r.sourceId === entityId ? r.targetId : r.sourceId);
  const ids = [...outgoing, ...incoming].map(other);

  // Титулы и статусы сторон — ОДНИМ запросом (entity.resolveRefs), а не entity.get на
  // строку: сущность целиком секции не нужна, ей нужны титул и статус, а per-id шторм
  // тем заметнее, чем длиннее список.
  const sides = trpc.entity.resolveRefs.useQuery({ ids }, { enabled: ids.length > 0 });
  const byId = new Map((sides.data ?? []).map((e) => [e.id, e]));
  const title = (id: string) => byId.get(id)?.title ?? `${id.slice(0, 8)}…`;
  // Пока сущность не доехала — блокер считается живым: спрятать реальную блокировку
  // хуже, чем показать лишнюю строку на время загрузки.
  const alive = (id: string) => {
    const e = byId.get(id);
    return !e || !CLOSED.has(String(e.status ?? ''));
  };
  const blockedBy = incoming.filter((r) => alive(r.sourceId));

  // Был entity.query с `search=`, то есть FTS по plainto_tsquery — совпадение только по
  // ЦЕЛОМУ слову: «Куп» не находило «Купить кроссовки», и пикер честно извинялся подсказкой.
  // entity.suggest ищет по ПРЕФИКСУ, извиняться больше не за что. Остальные состояния
  // (ошибка, загрузка, пусто) остались: немая пустая область читается как сломанная фича.
  const q = useDebounced(draft.trim(), SEARCH_DEBOUNCE_MS);
  const search = trpc.entity.suggest.useQuery(
    { prefix: q, limit: 10 },
    { enabled: adding && q.length >= SEARCH_MIN },
  );
  const known = new Set([entityId, ...ids]);
  // Закрытую задачу нельзя предлагать блокером: список «Заблокирована» показывает только
  // незакрытые (§3.5.6), поэтому такая связь создалась бы невидимой ни в одном списке и
  // неповторимой (id уже в `known`). Направления «блокирует» ограничение не касается —
  // исходящая связь видна всегда.
  const found = (search.data ?? []).filter(
    (e) => !known.has(e.id) && (direction === 'out' || !CLOSED.has(String(e.status ?? ''))),
  );

  /**
   * Инвалидация после правки графа (DF п.5). Трёх ключей мало не бывает:
   *  - entity.get текущей сущности — свой список связей;
   *  - entity.get ВТОРОЙ стороны — её detail держит собственный список связей и, если
   *    открывался раньше, лежит в кэше уже неверным;
   *  - entity.query — Browser, Повестка и списки с excludeBlocked (§6.1) читают другой
   *    ключ со своим staleTime (60 с у Повестки, K16) и сами не протухнут: без этого
   *    новая блокировка до минуты не видна нигде, кроме этого экрана.
   */
  const refresh = (otherId: string) => {
    void utils.entity.get.invalidate(detailGetInput(entityId));
    void utils.entity.get.invalidate({ id: otherId });
    void utils.entity.query.invalidate();
  };
  // Ацикличность blocks проверяет сервер (§4.2): путь цикла доезжает ТОЛЬКО в message
  // (cause по HTTP не сериализуется) — его и показываем плашкой (02 §6).
  const relate = trpc.relation.create.useMutation({
    // Плашка одна на две мутации, поэтому старт каждой гасит чужую ошибку: иначе отказ
    // создания («замкнула бы цикл») перекрывал бы любой последующий отказ снятия и висел
    // бы даже после успешных действий.
    // Тело-блок, а не `() => unrelate.reset()`: возвращённое значение onMutate — это
    // context мутации, и вывод его типа замкнулся бы на саму мутацию (TS7022).
    onMutate: () => {
      unrelate.reset();
    },
    onSuccess: (_data, vars) => {
      setDraft('');
      setAdding(false);
      // Направление — часть состояния формы: без сброса внешне свежая форма молча
      // создавала бы следующую связь в обратную сторону.
      setDirection('out');
      refresh(vars.source_id === entityId ? vars.target_id : vars.source_id);
    },
  });
  // Снятие ошибочной связи: relation.create не отдаёт actionId, Undo журналом из секции
  // недоступен — обратный путь только через relation.delete.
  const unrelate = trpc.relation.delete.useMutation({
    onMutate: () => {
      relate.reset();
    },
    onSuccess: (_data, vars) => {
      setConfirming(null);
      refresh(vars.source_id === entityId ? vars.target_id : vars.source_id);
    },
  });
  const failure = relate.error ?? unrelate.error;

  const open = (id: string) => push(activeTab, { kind: 'entity', id });
  const list = (label: string, items: Relation[]) => (
    <div className="flex flex-col">
      <p className={SECTION_LABEL}>{label}</p>
      <ul className="flex flex-col">
        {items.map((r) => (
          <li key={r.id} data-testid="block-row" className={ROW}>
            <Ban size={14} aria-hidden className="shrink-0 text-text-muted/70" />
            <button
              type="button"
              onClick={() => open(other(r))}
              className="min-w-0 flex-1 cursor-pointer truncate text-left hover:underline"
            >
              {title(other(r))}
            </button>
            {/* Подтверждение-минимум: соседние разрушающие действия web («Снять аспект»,
                «Архивировать») модалок не заводят, а Undo по actionId здесь недоступен —
                поэтому спрашиваем вторым кликом прямо в строке. */}
            {confirming === r.id ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-danger"
                  disabled={unrelate.isPending}
                  onClick={() =>
                    unrelate.mutate({
                      source_id: r.sourceId,
                      target_id: r.targetId,
                      relation_type: 'blocks',
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
                    unrelate.reset();
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
        <Button
          variant="ghost"
          size="icon"
          aria-label="Добавить блокировку"
          title="Добавить блокировку"
          onClick={() => setAdding((v) => !v)}
        >
          <Plus size={14} aria-hidden />
        </Button>
      </div>
      {outgoing.length > 0 && list('Блокирует', outgoing)}
      {blockedBy.length > 0 && list('Заблокирована', blockedBy)}
      {adding && (
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
            aria-label="Поиск сущности"
            value={draft}
            placeholder="Найти сущность…"
            onChange={(e) => setDraft(e.target.value)}
            className={PICKER_FIELD}
          />
          {/* Порядок веток: сначала «ещё не искали», потом ошибка/загрузка, и только затем
              пустой результат — иначе «ничего не найдено» мигало бы на каждом нажатии.
              Прецедент разводки состояний — TransactionsScreen §3.3. */}
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
                    disabled={relate.isPending}
                    onClick={() =>
                      relate.mutate(
                        direction === 'out'
                          ? { source_id: entityId, target_id: e.id, relation_type: 'blocks' }
                          : { source_id: e.id, target_id: entityId, relation_type: 'blocks' },
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
      {failure && (
        <p role="alert" className="px-2 text-sm text-danger">
          {failure.message}
        </p>
      )}
    </div>
  );
}
