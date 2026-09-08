import { CheckCircle2, Circle, FileText } from 'lucide-react';
import { useRefTitle } from '../../lib/entity-ref/RefField';
import { formatMoney, type MoneyTone } from '../../lib/format';
import { classLabel } from '../../lib/registry/labels';
import { useRowProjection } from '../../lib/registry/row';
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
 * справа типизированные элементы строки (срок, сумма, бейджи).
 * Не контрол: чекбокс-глиф задачи — индикатор состояния, переключение — в Detail.
 *
 * Род элементов — по КОНТРАКТАМ (M14, §Б5-6): строка не знает ни одного имени аспекта.
 * `showDate={false}` гасит ровно дату — для списков, где дату строки подписывает сам
 * список (§4.2); сумма не гасится никогда, её печатать больше некому.
 */
export function EntityRow({ entity, showDate = true }: { entity: Entity; showDate?: boolean }) {
  const props = entity.props;
  const registry = useRegistry();
  // Элементы строки — из привязок реестра, а не из веток по аспектам (§Б5-6). Пока снимок
  // едет, проекция пуста: строка печатает заголовок и дорисовывает элементы первым ответом.
  const row = useRowProjection(entity);
  const closed = row.checkbox?.closed === true;

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
   * Вызывателей у этого компонента ТРИ (греп `<EntityRow`): `browser/EntityList`,
   * `settings/MemoryScreen`, `agenda/AgendaScreen`. Правило одинаково во всех трёх; в
   * Повестку запись памяти просто не попадает — она отбирает по аспектам расписания и
   * задачи, — но исключением это не является и в перечне стоять обязано.
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

  // Глиф слева — по ЭЛЕМЕНТУ «чекбокс», а не по аспекту задачи: завершаемость есть у всякого,
  // кто реализует контракт, включая аспект владельца, которого этот файл не знает.
  const leading = entity.emoji ? (
    <span aria-hidden className="w-5 text-center leading-none">
      {entity.emoji}
    </span>
  ) : row.checkbox !== null ? (
    closed ? (
      <CheckCircle2 size={16} className="w-5 shrink-0 text-text-muted" aria-hidden />
    ) : (
      <Circle size={16} className="w-5 shrink-0 text-text-muted/70" aria-hidden />
    )
  ) : (
    <FileText size={16} className="w-5 shrink-0 text-text-muted/70" aria-hidden />
  );

  const money =
    row.amount === null
      ? null
      : formatMoney(row.amount.amount, row.amount.direction === 'inflow' ? 'income' : 'expense');

  return (
    <>
      {leading}
      <span
        data-testid={isRule ? 'entity-row-rule' : undefined}
        className={`flex-1 truncate ${closed ? 'text-text-muted line-through' : ''}`}
      >
        {isRule ? rulePattern : entity.title}
      </span>
      {ruleTargetResolved && <span className="text-xs text-text-muted">{ruleTargetTitle}</span>}
      {showDate && row.date !== null && (
        <span className="text-xs text-text-muted">{formatDay(row.date.value)}</span>
      )}
      {money !== null && (
        <span className={`text-xs font-medium tabular-nums ${AMOUNT_TONE_CLASS[money.tone]}`}>
          {money.text}
        </span>
      )}
      {row.badges.map((b) =>
        b.kind === 'priority' ? (
          <span
            key="priority"
            role="img"
            aria-label="высокий приоритет"
            className="size-1.5 shrink-0 rounded-full bg-danger"
          />
        ) : (
          <span key={`${b.contract}:${b.cls}`} className="text-xs text-text-muted">
            {classLabel(registry, b.contract, b.cls)}
          </span>
        ),
      )}
    </>
  );
}
