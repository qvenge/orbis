import { CheckCircle2, Circle, FileText } from 'lucide-react';
import { useRefTitle } from '../../lib/entity-ref/RefField';
import { formatMoney, type MoneyTone } from '../../lib/format';
import { useRegistry } from '../../lib/registry/useRegistry';
import type { RouterOutputs } from '../../trpc';

type Entity = RouterOutputs['entity']['query'][number];

const AMOUNT_TONE_CLASS: Record<MoneyTone, string> = {
  danger: 'text-danger',
  positive: 'text-success',
};

// Дата ('2026-07-18' или полный ISO) → '18 июл.'; битое значение возвращаем как есть.
// Date-only парсится как полночь UTC — форматируем в UTC, иначе в западных таймзонах
// срок уехал бы на день назад. Полный ISO — в локальной зоне.
export function formatDay(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    ...(dateOnly ? { timeZone: 'UTC' } : {}),
  }).format(d);
}

/**
 * «Живая строка сущности» — подпись дизайна Orbis: слева эмодзи (или тип-глиф),
 * справа типизированная мета из аспектов (срок задачи, сумма с тоном, дата события).
 * Не контрол: чекбокс-глиф задачи — индикатор состояния, переключение — в Detail.
 *
 * `showMeta={false}` подавляет правую мету — для списков, где дату строки задаёт сам
 * список («Просроченное» в Agenda подписывает строку релевантной датой, §4.2). Дефолт
 * `true`: Browser (EntityList) прежний, поведение по умолчанию не менялось.
 */
export function EntityRow({ entity, showMeta = true }: { entity: Entity; showMeta?: boolean }) {
  // Род строки — по СПИСКУ аспектов, значения — плоско в `props` по id свойства (§А1-1).
  // Прежде и то, и другое читалось из одной карты, и «аспект навешен» было неотличимо от
  // «в аспекте что-то заполнено»: задача без единого свойства оставалась без глифа.
  const props = entity.props;
  const aspects = new Set(entity.aspects);
  const task = aspects.has('orbis/task');
  const done = props['orbis/task_status'] === 'done';

  /**
   * ПРАВИЛО ПАМЯТИ ПОКАЗЫВАЕТСЯ ИЗ СВОЙСТВ (В7) — та же граница, что у слоя памяти промпта
   * (`server/llm/context.ts`): подпись пересобирается тогда и только тогда, когда у правила
   * ЕСТЬ ЦЕЛЬ. Правило без цели (глобальное, прозой) сохраняет заголовок: образец у него —
   * лишь текст сопоставления, и подмена выбросила бы саму формулировку.
   *
   * Иначе экран «Память AI» — место, куда владелец приходит СПЕЦИАЛЬНО ревизовать правила,
   * — показывал бы сохранённый заголовок, то есть имя категории, которое могло устареть
   * после её переименования. Смысл В7 в том, что подпись ПРОИЗВОДНАЯ, а не копия.
   *
   * ЧЕГО ЭТО НЕ ПОКРЫВАЕТ, названо вслух: `entity-detail/NativeRow` (экран записи)
   * показывает сохранённый заголовок как есть — там он РЕДАКТИРУЕТСЯ, и поле обязано
   * показывать содержимое колонки; живые образец и категория стоят там рядом отдельными
   * элементами. `PinnedList` печатает `title` закреплённой записи — поверхность вне скоупа
   * Задачи 18. То есть «устаревшее имя нигде не видно» — НЕВЕРНО; верно узкое: списки,
   * которые строит этот компонент, его не показывают.
   *
   * Хук безусловен (правило порядка хуков), но пустая ссылка выдачу НЕ поднимает
   * (`useRefTitle`: `refId === ''` гасит запрос) — на списках без правил сеть не трогается
   * вовсе, а полсотни строк с целями схлопываются react-query в один запрос.
   */
  const registry = useRegistry();
  const ruleTarget = props['orbis/memory_kind'] === 'rule' ? props['orbis/rule_target'] : undefined;
  const ruleTargetRef = typeof ruleTarget === 'string' ? ruleTarget : '';
  const rulePattern = props['orbis/rule_pattern'];
  const {
    title: ruleTargetTitle,
    isPending: rulePending,
    isError: ruleFailed,
  } = useRefTitle(registry.property('orbis/rule_target'), ruleTargetRef);
  const isRule = ruleTargetRef !== '' && typeof rulePattern === 'string' && rulePattern !== '';
  // Название цели показываем только РАЗЫМЕНОВАННЫМ: пока список грузится или не доехал,
  // сырой uuid — та же ложь, что мелькающее имя (D6d п.1).
  const ruleTargetResolved =
    isRule && !rulePending && !ruleFailed && ruleTargetTitle !== ruleTargetRef;

  const leading = entity.emoji ? (
    <span aria-hidden className="w-5 text-center leading-none">
      {entity.emoji}
    </span>
  ) : task ? (
    done ? (
      <CheckCircle2 size={16} className="w-5 shrink-0 text-text-muted" aria-hidden />
    ) : (
      <Circle size={16} className="w-5 shrink-0 text-text-muted/70" aria-hidden />
    )
  ) : (
    <FileText size={16} className="w-5 shrink-0 text-text-muted/70" aria-hidden />
  );

  const due = props['orbis/due_date'];
  const startAt = props['orbis/start_at'];
  let meta: React.ReactNode = null;
  if (aspects.has('orbis/financial')) {
    const money = formatMoney(
      String(props['orbis/amount'] ?? '0'),
      (props['orbis/direction'] as 'expense' | 'income') ?? 'expense',
    );
    meta = (
      <span className={`text-xs font-medium tabular-nums ${AMOUNT_TONE_CLASS[money.tone]}`}>
        {money.text}
      </span>
    );
  } else if (task && typeof due === 'string') {
    meta = <span className="text-xs text-text-muted">{formatDay(due)}</span>;
  } else if (aspects.has('orbis/schedule') && typeof startAt === 'string') {
    meta = <span className="text-xs text-text-muted">{formatDay(startAt)}</span>;
  }

  return (
    <>
      {leading}
      <span
        data-testid={isRule ? 'entity-row-rule' : undefined}
        className={`flex-1 truncate ${done ? 'text-text-muted line-through' : ''}`}
      >
        {isRule ? rulePattern : entity.title}
      </span>
      {ruleTargetResolved && <span className="text-xs text-text-muted">{ruleTargetTitle}</span>}
      {task && props['orbis/priority'] === 'high' && !done && (
        <span
          role="img"
          aria-label="высокий приоритет"
          className="size-1.5 shrink-0 rounded-full bg-danger"
        />
      )}
      {showMeta && meta}
    </>
  );
}
