import { rowAllDayOf } from '@orbis/shared';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useRefTitle } from '../../lib/entity-ref/RefField';
import { formatMoney, type MoneyTone } from '../../lib/format';
import { isTitleStale } from '../../lib/orbis-error';
import { displayText } from '../../lib/registry/format';
import { classLabel, fieldLabel } from '../../lib/registry/labels';
import {
  rowRegistryOf,
  useRowCategoryRef,
  useRowProjection,
  useRowStatusProperty,
} from '../../lib/registry/row';
import { useRegistry } from '../../lib/registry/useRegistry';
import type { RouterOutputs } from '../../trpc';
import { Badge } from '../../ui/Badge';
import { Checkbox } from '../../ui/Checkbox';
import { formatDay } from '../browser/EntityRow';
import { useCategoryTitle } from '../budget/categories';
import {
  bindStepOwner,
  discardRedo,
  pushStep,
  redoStep,
  resetSteps,
  stepsGeneration,
  undoStep,
} from '../entity-editor/arrows-stack';
import { mountRecord } from '../entity-editor/editor-cache';
import {
  markTitleSent,
  observeTitleValue,
  recordTitleChange,
  redoTitle,
  rejectTitleSend,
  undoTitle,
} from '../entity-editor/title-history';
import { useExtensionEnabled } from '../settings/extension-mask';
import { isUndoEpoch, subscribeUndoEpoch, undoEpoch } from '../undo/undo-epoch';
import { useHostReadOnly } from './record-host';

type Entity = RouterOutputs['entity']['query'][number];

// §3.6 rich-money: тон из formatMoney — expense→danger, income→success.
const AMOUNT_TONE_CLASS: Record<MoneyTone, string> = {
  danger: 'text-danger',
  positive: 'text-success',
};

// NativeRow живёт на странице Detail — title здесь является заголовком страницы.
const TITLE_CLASS = 'text-xl font-semibold tracking-tight';

/**
 * Кому переключатель шапки доступен. Писатель (`useRecordEdits.toggleTask`) шлёт ТОЛЬКО смену
 * `orbis/task_status`: «готово» — `done`, снятие — `unset`. Штамп `orbis/completed_at`, снятие вопроса
 * и значение возврата (`inbox`, строка `default` каталога `task_status_default`) делают правила
 * каталога, а они стоят на носителе `orbis/task` (область правила без `scope` — аспект-носитель).
 * Поэтому гард — ДВА условия, и оба нужны:
 *  • запись несёт `orbis/task` — иначе правил нет: пользовательский аспект, несущий то же
 *    `orbis/task_status`, получил бы `done` без штампа, а снятие оставило бы его вовсе без статуса;
 *  • победившая привязка `orbis/completable` смотрит в `orbis/task_status` — иначе галочка
 *    показывает чужое свойство, а клик пишет это, и галочка не сдвинулась бы.
 * Показать состояние строка обязана у ВСЯКОГО реализатора `orbis/completable` (§С8-18); неактивный
 * чекбокс с подсказкой — не прятать члена контракта.
 */
const TOGGLE_CARRIER_ASPECT = 'orbis/task';
const TOGGLABLE_STATUS_PROPERTY = 'orbis/task_status';
const TOGGLE_BLOCKED_TITLE = 'переключение доступно только задачам';

/**
 * Заголовок строки: статичный текст без onSaveTitle и inline-редактор с ним (Detail, DF п.3);
 * боевой вызыватель сегодня один — экран записи, и он правку передаёт. Правка title обязана существовать: 02-core-os
 * §2.7 — «правка памяти = правка обычной сущности (title, поля аспекта, body)».
 * Отдельного экрана не заводим — тот же inline-паттерн, что у body и полей аспектов.
 *
 * ПРЕДУПРЕЖДЕНИЯ О ФОРМАТЕ ЗДЕСЬ БОЛЬШЕ НЕТ, и это не упрощение: механизм `warn` был
 * заведён ровно под одного вызывающего — подсказку «правило не распознано» у memory-правила
 * (его смысл жил в заголовке и ломался одним символом). После В7 смысл правила живёт в
 * свойствах, заголовок стал генерируемой подписью, и ломать правкой заголовка стало нечего;
 * оставленный механизм был бы веткой без единственного вызывателя.
 */
function Title({
  entityId,
  value,
  onSave,
  onStale,
  className = '',
}: {
  entityId: string;
  value: string;
  onSave?: TitleSave;
  onStale?: () => void;
  className?: string;
}) {
  const epoch = useSyncExternalStore(subscribeUndoEpoch, undoEpoch, undoEpoch);
  if (onSave === undefined) {
    return <span className={`flex-1 ${TITLE_CLASS} ${className}`}>{value}</span>;
  }
  return (
    <TitleEditor
      key={`${entityId}:${epoch}`}
      entityId={entityId}
      value={value}
      onSave={onSave}
      onStale={onStale}
      className={className}
    />
  );
}

type TitleSave = (title: string, expectedTitle: string) => unknown;

function TitleEditor({
  entityId,
  value,
  onSave,
  onStale,
  className,
}: {
  entityId: string;
  value: string;
  onSave: TitleSave;
  onStale?: () => void;
  className: string;
}) {
  const [draft, setDraft] = useState(value);
  const [serverValue, setServerValue] = useState(value);
  const lockRef = useRef<string | null>(null);
  const savingRef = useRef(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const mountedRef = useRef(true);

  // Тот же приём, что у редактора тела (BodyEditor) и AspectField (D6c п.3): внешнее
  // значение подхватываем, но ТОЛЬКО если черновик не трогали — иначе текст, который
  // владелец печатает прямо сейчас, затирался бы рефетчем после чужой мутации.
  if (value !== serverValue) {
    setServerValue(value);
    // Оптимистичный title совпадает с draft, но отказ ещё может вернуть прежнее value:
    // основа ввода держит набранное и через optimistic→rollback→чужое перечитывание.
    if (lockRef.current === null && draft === serverValue) setDraft(value);
  }

  const latest = useRef({ onSave, onStale, serverValue });
  latest.current = { onSave, onStale, serverValue };
  const intent = useRef({ epoch: undoEpoch(), generation: stepsGeneration() }).current;
  const saveSequence = useRef(0);
  const current = useCallback(
    () =>
      mountedRef.current && isUndoEpoch(intent.epoch) && intent.generation === stepsGeneration(),
    [intent],
  );
  const commit = async (v: string, expected: string) => {
    if (!current()) return;
    const sequence = ++saveSequence.current;
    const token = markTitleSent(entityId, v);
    savingRef.current = true;
    try {
      await latest.current.onSave(v, expected);
      if (current() && sequence === saveSequence.current)
        lockRef.current = draftRef.current === v ? null : v;
    } catch (err) {
      if (isUndoEpoch(intent.epoch) && intent.generation === stepsGeneration())
        rejectTitleSend(entityId, token);
      if (current() && sequence === saveSequence.current && isTitleStale(err))
        latest.current.onStale?.();
    } finally {
      if (current() && sequence === saveSequence.current) savingRef.current = false;
    }
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useLayoutEffect(() => {
    mountedRef.current = true;
    const release = mountRecord(entityId);
    const apply = (v: string | null) => {
      if (v === null || !current()) return false;
      draftRef.current = v;
      setDraft(v);
      lockRef.current = null;
      void commitRef.current(v, latest.current.serverValue);
      return true;
    };
    const unbind = bindStepOwner(entityId, 'title', {
      undo: () => apply(undoTitle(entityId, draftRef.current)),
      redo: () => apply(redoTitle(entityId, draftRef.current)),
      reset: () => {},
    });
    return () => {
      mountedRef.current = false;
      unbind();
      release();
    };
  }, [entityId, current]);
  useLayoutEffect(() => {
    if (current() && observeTitleValue(entityId, value)) resetSteps(entityId);
  }, [value, entityId, current]);
  return (
    <input
      aria-label="Заголовок"
      data-testid="title-edit"
      data-step-record={entityId}
      value={draft}
      onFocus={() => {
        // Грязный черновик после отказа не видел нового title: рефокус CAS не обходит (R-28).
        if (draft === value && !savingRef.current) lockRef.current = null;
      }}
      onChange={(e) => {
        lockRef.current ??= serverValue;
        if (!current()) return;
        const next = e.target.value;
        if (recordTitleChange(entityId, draftRef.current, next)) pushStep(entityId, 'title');
        else discardRedo(entityId);
        draftRef.current = next;
        setDraft(next);
      }}
      // Пустой заголовок сущности не бывает (entityUpdateInput: title.min(1)) — вместо
      // заведомо отказного запроса возвращаем серверное значение.
      onKeyDown={(e) => {
        if (!(e.ctrlKey || e.metaKey) || e.altKey || !current()) return;
        const k = e.key.toLowerCase(),
          nonLatin = !/^[a-z]$/.test(k);
        const z = k === 'z' || k === 'я' || (nonLatin && e.code === 'KeyZ'),
          y = k === 'y' || k === 'н' || (nonLatin && e.code === 'KeyY');
        if (!z && !y) return;
        e.preventDefault();
        if (z && !e.shiftKey) undoStep(entityId);
        else redoStep(entityId);
      }}
      onBlur={() => {
        if (!current()) return;
        if (draft.trim() === '') {
          lockRef.current = null;
          setDraft(value);
          resetSteps(entityId);
        } else if (draft !== value) void commit(draft, lockRef.current ?? serverValue);
        else if (!savingRef.current) lockRef.current = null;
      }}
      className={`min-w-0 flex-1 rounded-md bg-transparent px-1 ${TITLE_CLASS} outline-none transition hover:bg-surface-2/60 focus-visible:bg-surface-2/70 focus-visible:ring-2 focus-visible:ring-accent/30 ${className}`}
    />
  );
}

/**
 * Строка памяти AI. У ПРАВИЛА она собирается ИЗ СВОЙСТВ (В7): образец —
 * `orbis/rule_pattern`, назначаемая категория — `orbis/rule_target` (ссылка), и её
 * название разыменовывается при показе. Именно поэтому переименование категории здесь
 * видно сразу: до реформы правая часть правила была сохранённой СТРОКОЙ, и экран
 * показывал прежнее имя, которого в графе уже не было.
 *
 * Заголовок остаётся inline-редактируемым (§2.7 — правка памяти это правка обычной
 * записи), но смысла правила он больше не несёт: это генерируемая подпись. Сам образец
 * правится карточкой свойства, как любое другое значение.
 *
 * Отдельный компонент, а не ветка внутри NativeRow: хук разыменования ссылки обязан быть
 * безусловным (та же причина, что у `CategoryBadge`).
 */
function MemoryRow({
  entityId,
  title,
  props,
  onSaveTitle,
  onStale,
}: {
  entityId: string;
  title: string;
  props: Record<string, unknown>;
  onSaveTitle?: TitleSave;
  onStale?: () => void;
}) {
  const registry = useRegistry();
  const kind = props['orbis/memory_kind'];
  const pattern = props['orbis/rule_pattern'];
  const targetRef = props['orbis/rule_target'];
  const {
    title: targetTitle,
    isPending: targetPending,
    isError: targetFailed,
  } = useRefTitle(
    registry.property('orbis/rule_target'),
    typeof targetRef === 'string' ? targetRef : '',
  );
  const isRule = kind === 'rule';
  return (
    <div className="flex items-center gap-2" data-testid="native-memory">
      <Title entityId={entityId} value={title} onSave={onSaveTitle} onStale={onStale} />
      {isRule && typeof pattern === 'string' && pattern !== '' && (
        <span data-testid="memory-rule-pattern" className="truncate text-sm text-text-secondary">
          {pattern}
        </span>
      )}
      {/* Пока список категорий грузится, названия нет — бейджа нет вовсе (D6d п.1):
          иначе на холодном кэше мелькал бы сырой uuid и подменялся названием. */}
      {isRule &&
        typeof targetRef === 'string' &&
        targetRef !== '' &&
        !targetPending &&
        !targetFailed && <Badge>{targetTitle}</Badge>}
      {typeof kind === 'string' && <Badge>{kind}</Badge>}
    </div>
  );
}

/**
 * Бейдж категории — свой компонент ради ХУКА (D6c п.2): хук обязан быть безусловным, а запрос
 * категорий не должен уходить с каждой нефинансовой строки. Пока значение неизвестно — бейджа нет
 * вовсе (D6d п.1): иначе на холодном кэше мелькал бы uuid.
 *
 * При выключенных Финансах бейджа нет, и запрос категорий не уходит вовсе (срез 1б §8.4): пустая
 * ссылка выдачу не поднимает. Маску спрашивает только строка С категорией — у прочих строк этого
 * компонента нет. Отступление §15 (код ядра знает Финансы, адрес снятия — срез 2).
 */
function CategoryBadge({ categoryRef }: { categoryRef: string }) {
  const financeOn = useExtensionEnabled('finance');
  const { title, isPending, isError } = useCategoryTitle(financeOn ? categoryRef : '');
  if (!financeOn || isPending || isError) return null;
  return <Badge>{title}</Badge>;
}

/**
 * §3.6 нативный рендер строки сущности — ОДНА строка по таблице M14 (§Б5-6), а не четыре ветки
 * по именам аспектов: чекбокс, заголовок, дата, сумма и бейджи собираются из ПРИВЯЗОК реестра,
 * и аспект владельца, которого этот файл не знает, получает их наравне со встроенным (§С8-18).
 *
 * Вне M14 остались три вещи, и каждая — осознанно: строка ПАМЯТИ (её смысл живёт в свойствах,
 * а не в контрактах, В7), бейдж КАТЕГОРИИ (свойство-ссылка, контракта «категория» в v1 нет,
 * В-2) и `keyFields` шапки (§А9-2 — их показывают записи, у которых не сработал ни один элемент).
 *
 * onSaveTitle — опционален: с ним заголовок становится inline-редактором (Detail), без него
 * остаётся текстом (так строку рисуют тесты; вызыватель списка без правки — строки транзакций
 * экрана категории — удалён срезом 1в §8.1).
 */
export function NativeRow({
  entity,
  onToggleTask,
  onSaveTitle,
  onStale,
}: {
  entity: Entity;
  onToggleTask: (done: boolean) => void;
  onSaveTitle?: TitleSave;
  onStale?: () => void;
}) {
  const props = entity.props;
  const aspects = new Set(entity.aspects);
  // Предпросмотр шаблона на чужой записи (хост `readOnly`): чекбокс не переключается, заголовок —
  // текстом. Вне хоста (списки) — `false`, строка ведёт себя как прежде.
  const readOnly = useHostReadOnly();
  const saveTitle = readOnly ? undefined : onSaveTitle;
  // Подписи, keyFields и правило строки — из реестра (§А9-2, §Б5-6). Хуки зовутся ДО ветки
  // памяти: ветвление идёт ниже по данным, и вызов хука внутри ветки нарушил бы правило
  // порядка хуков на первой же смене аспекта у открытой записи.
  const registry = useRegistry();
  const row = useRowProjection(entity);
  const statusProperty = useRowStatusProperty(entity);
  // Категория — по КОНТРАКТУ денег (слот `category`), а не по сырому свойству: то же свойство
  // несёт конверт слотом своего контракта, и сырое чтение вешало бы на его шапку чужой бейдж и
  // лишний запрос списка категорий; а запись со снятым аспектом-носителем показывала бы бейдж по
  // пережившему снятие значению (Р9). Бейдж остаётся вне M14 (контракта «категория» в v1 нет, В-2).
  const catRef = useRowCategoryRef(entity);
  // Память — своя строка (В7): её смысл (образец сопоставления и цель) живёт в свойствах, а не в
  // контрактах; в таблицу M14 запись памяти не входит.
  if (aspects.has('orbis/memory'))
    return (
      <MemoryRow
        entityId={entity.id}
        title={entity.title}
        props={props}
        onSaveTitle={saveTitle}
        onStale={onStale}
      />
    );

  const closed = row.checkbox?.closed === true;
  const togglable =
    aspects.has(TOGGLE_CARRIER_ASPECT) && statusProperty === TOGGLABLE_STATUS_PROPERTY;
  const money =
    row.amount === null
      ? null
      : formatMoney(row.amount.amount, row.amount.direction === 'inflow' ? 'income' : 'expense');
  // keyFields — только когда ни один элемент M14 не сработал: записи без контрактов шапке нечего
  // показать, кроме её ключевых полей (§А9-2; первый аспект — по rank реестра, не по порядку записи).
  const bare = row.checkbox === null && row.date === null && row.amount === null;
  const firstAspect = bare
    ? (registry.data?.aspects ?? []).find((a) => aspects.has(a.id))
    : undefined;
  const fields = (firstAspect?.viewConfig.keyFields ?? [])
    .filter((id) => props[id] !== undefined)
    .slice(0, 3);

  // ИЗМЕНЕНИЕ ВИДИМОГО ПОВЕДЕНИЯ: ОТМЕНЁННАЯ задача выглядит закрытой — чекбокс отмечен, заголовок
  // зачёркнут (прежде чекбокс был пуст, а рядом стоял сырой бейдж `cancelled`). Так и задумано:
  // чекбокс показывает МЕМБЕРСТВО в наборе `closed`, а не класс `done`, и различает классы бейдж
  // («Отменено»). Цена названа: снятие галочки у отменённой возвращает её в `inbox` — той же
  // строкой `default` каталога, что и у сделанной, то есть «отменено» отменяется в «входящие».
  return (
    <div className="flex items-center gap-2" data-testid="native-row">
      {row.checkbox !== null && (
        <Checkbox
          aria-label="Готово"
          checked={closed}
          onCheckedChange={onToggleTask}
          disabled={readOnly || !togglable}
          title={togglable ? undefined : TOGGLE_BLOCKED_TITLE}
        />
      )}
      <Title
        entityId={entity.id}
        value={entity.title}
        onSave={saveTitle}
        onStale={onStale}
        className={closed ? 'text-text-muted line-through' : ''}
      />
      {row.date !== null && (
        <span className="text-xs text-text-secondary">{formatDay(row.date.value)}</span>
      )}
      {money !== null && (
        <span
          data-testid="native-amount"
          className={`text-lg font-medium tabular-nums ${AMOUNT_TONE_CLASS[money.tone]}`}
        >
          {money.text}
        </span>
      )}
      {/* прогресс — контракта `orbis/progress` в Б-1 нет (Б-3) */}
      {row.badges.map((b) =>
        b.kind === 'priority' ? (
          <span
            key="priority"
            role="img"
            aria-label="высокий приоритет"
            className="size-1.5 shrink-0 rounded-full bg-danger"
          />
        ) : (
          <Badge key={`${b.contract}:${b.cls}`}>{classLabel(registry, b.contract, b.cls)}</Badge>
        ),
      )}
      {/* «весь день» — слот `all_day` контракта «когда» (1в §4.3): у аспекта владельца своё
          свойство, а значение, пережившее снятие расписания (Р9), бейджа не даёт */}
      {rowAllDayOf(entity, rowRegistryOf(registry.data)) && <Badge>весь день</Badge>}
      {catRef !== null && <CategoryBadge categoryRef={catRef} />}
      {fields.length > 0 && (
        <dl className="flex gap-2 text-xs text-text-secondary">
          {fields.map((id) => (
            <div key={id} className="flex gap-1">
              <dt>{fieldLabel(registry, id)}:</dt>
              {/* Показ — по ТИПУ свойства: у `select` печатается подпись варианта, у булева — «да»/«нет»,
                  у списка аспектов («Шаблон для» страницы) — подписи аспектов, а не их id. */}
              <dd>{displayText(registry.property(id), props[id], registry)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
