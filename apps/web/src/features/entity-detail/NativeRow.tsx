import { useState } from 'react';
import { useRefTitle } from '../../lib/entity-ref/RefField';
import { formatMoney, type MoneyTone } from '../../lib/format';
import { displayText } from '../../lib/registry/format';
import { classLabel, fieldLabel } from '../../lib/registry/labels';
import { useRowCategoryRef, useRowProjection, useRowStatusProperty } from '../../lib/registry/row';
import { useRegistry } from '../../lib/registry/useRegistry';
import type { RouterOutputs } from '../../trpc';
import { Badge } from '../../ui/Badge';
import { Checkbox } from '../../ui/Checkbox';
import { formatDay } from '../browser/EntityRow';
import { useCategoryTitle } from '../budget/categories';

type Entity = RouterOutputs['entity']['query'][number];

// §3.6 rich-money: тон из formatMoney — expense→danger, income→success.
const AMOUNT_TONE_CLASS: Record<MoneyTone, string> = {
  danger: 'text-danger',
  positive: 'text-success',
};

// NativeRow живёт на странице Detail — title здесь является заголовком страницы.
const TITLE_CLASS = 'text-xl font-semibold tracking-tight';

/**
 * Свойство, в которое умеет писать переключатель шапки (`useEntityDetail.toggleTask` кладёт
 * литерал `done ? 'done' : 'inbox'`). ГАРД, а не общее правило: показать состояние строка обязана
 * у ВСЯКОГО реализатора `orbis/completable` (§С8-18), а записать — только туда, куда писатель
 * умеет. Без гарда клик по чекбоксу записи с пользовательским аспектом клал бы на неё ЧУЖОЕ
 * `orbis/task_status`, своё свойство статуса не менял, и галочка не появлялась бы вовсе.
 *
 * ПОЧЕМУ КОДОМ, а не декларацией: запись через привязку — «положи первый вариант класса из
 * `variantsOfClass`» — это Б-2 (у писателя нет ни выбора варианта внутри класса, ни поля `default`
 * у свойства); до неё гард назван вслух и стоит здесь. Остаток — в реестр остатков задачи 19.
 */
const TOGGLABLE_STATUS_PROPERTY = 'orbis/task_status';
const TOGGLE_BLOCKED_TITLE = 'переключение доступно только задачам';

/**
 * Заголовок строки: статичный текст без onSaveTitle (списки транзакций CategoryScreen) и
 * inline-редактор с ним (Detail, DF п.3). Правка title обязана существовать: 02-core-os
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
  value,
  onSave,
  className = '',
}: {
  value: string;
  onSave?: (title: string) => void;
  className?: string;
}) {
  if (onSave === undefined) {
    return <span className={`flex-1 ${TITLE_CLASS} ${className}`}>{value}</span>;
  }
  return <TitleEditor value={value} onSave={onSave} className={className} />;
}

function TitleEditor({
  value,
  onSave,
  className,
}: {
  value: string;
  onSave: (title: string) => void;
  className: string;
}) {
  const [draft, setDraft] = useState(value);
  const [serverValue, setServerValue] = useState(value);

  // Тот же приём, что у редактора тела (BodyEditor) и AspectField (D6c п.3): внешнее
  // значение подхватываем, но ТОЛЬКО если черновик не трогали — иначе текст, который
  // владелец печатает прямо сейчас, затирался бы рефетчем после чужой мутации.
  if (value !== serverValue) {
    setServerValue(value);
    if (draft === serverValue) setDraft(value);
  }

  return (
    <input
      aria-label="Заголовок"
      data-testid="title-edit"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      // Пустой заголовок сущности не бывает (entityUpdateInput: title.min(1)) — вместо
      // заведомо отказного запроса возвращаем серверное значение.
      onBlur={() => {
        if (draft.trim() === '') setDraft(value);
        else if (draft !== value) onSave(draft);
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
  title,
  props,
  onSaveTitle,
}: {
  title: string;
  props: Record<string, unknown>;
  onSaveTitle?: (title: string) => void;
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
      <Title value={title} onSave={onSaveTitle} />
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
 */
function CategoryBadge({ categoryRef }: { categoryRef: string }) {
  const { title, isPending, isError } = useCategoryTitle(categoryRef);
  if (isPending || isError) return null;
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
 * остаётся текстом (строки транзакций CategoryScreen).
 */
export function NativeRow({
  entity,
  onToggleTask,
  onSaveTitle,
}: {
  entity: Entity;
  onToggleTask: (done: boolean) => void;
  onSaveTitle?: (title: string) => void;
}) {
  const props = entity.props;
  const aspects = new Set(entity.aspects);
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
    return <MemoryRow title={entity.title} props={props} onSaveTitle={onSaveTitle} />;

  const closed = row.checkbox?.closed === true;
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
  // («Отменено»). Цена названа: снятие галочки у отменённой возвращает её в `inbox` — тем же
  // литералом, что и у сделанной (Р-К-18), то есть «отменено» отменяется в «входящие».
  return (
    <div className="flex items-center gap-2" data-testid="native-row">
      {row.checkbox !== null && (
        <Checkbox
          aria-label="Готово"
          checked={closed}
          onCheckedChange={onToggleTask}
          disabled={statusProperty !== TOGGLABLE_STATUS_PROPERTY}
          title={statusProperty === TOGGLABLE_STATUS_PROPERTY ? undefined : TOGGLE_BLOCKED_TITLE}
        />
      )}
      <Title
        value={entity.title}
        onSave={onSaveTitle}
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
      {/* raw_value вне M14: «весь день» — свойство записи, контракта «признак суток» в v1 нет */}
      {props['orbis/all_day'] === true && <Badge>весь день</Badge>}
      {catRef !== null && <CategoryBadge categoryRef={catRef} />}
      {fields.length > 0 && (
        <dl className="flex gap-2 text-xs text-text-secondary">
          {fields.map((id) => (
            <div key={id} className="flex gap-1">
              <dt>{fieldLabel(registry, id)}:</dt>
              {/* Показ — по ТИПУ свойства: у `select` печатается подпись варианта, у булева — «да»/«нет». */}
              <dd>{displayText(registry.property(id), props[id])}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
