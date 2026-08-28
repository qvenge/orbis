/**
 * Секция «Поля» формы-редактора: по строке на каждый узел канона, привязанный к свойству
 * (список значений, отрицание списка, сравнение, диапазон — §А5-7), плюс пустая строка на
 * свойство, по которому фильтра ещё нет.
 *
 * Строка — на УЗЕЛ, а не на свойство: `orbis/amount>100, orbis/amount<500` — два законных
 * узла по одному свойству, и одна строка на свойство молча выбросила бы второй при записи.
 *
 * ДОСТУПНОЕ ИМЯ КОНТРОЛА — ПОДПИСЬ СВОЙСТВА, а не его ключ, и это СНЯТИЕ прежнего рулинга
 * («имя контрола обязано остаться именем поля грамматики — тем самым, что уедет в текст
 * блока»). Рулинг держался на том, что в тексте стояло голое имя поля аспекта (`status=`), то
 * есть ровно то слово, которое человек и видел. С §А5-3а в тексте стоит namespaced key
 * (`orbis/task_status=`) — машинная ручка, которую человеку читать незачем; она осталась в
 * строке рядом, но `aria-hidden`. Слепой пользователь теперь слышит «Статус», а не
 * «orbis/task_status».
 */

import type { QueryBound, QueryDateToken, QueryFilterNode } from '@orbis/shared/query';
import { useId, useRef } from 'react';
import {
  boundNode,
  defaultValue,
  type FieldNodeView,
  type FieldRef,
  isComparable,
  isDateLike,
  listedValues,
  listNode,
  type Operator,
  rangeNode,
} from './model';

/** Плотное поле формы: примитивов Select/Checkbox в src/ui нет — своя строка на своём элементе. */
export const FIELD_CLS =
  'min-w-0 rounded-control border border-line bg-surface px-2 py-1 text-sm text-text transition focus-visible:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40';
/** Мелкая кнопка внутри строки значения (× / добавить): не ui/Button — там свой кегль и паддинг. */
export const ROW_BUTTON_CLS =
  'shrink-0 cursor-pointer rounded-control border border-line px-2 py-1 text-text-secondary text-xs transition hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40';

const DATE_TOKEN_LABELS: Array<[QueryDateToken, string]> = [
  ['today', 'сегодня'],
  ['overdue', 'просрочено'],
  ['next_7d', 'ближайшие 7 дней'],
  ['after_7d', 'позже 7 дней'],
];

/** Относительное время вместо литерала (§А5-7). */
function isToken(value: QueryBound): value is { token: QueryDateToken } {
  return typeof value === 'object' && value !== null && 'token' in value;
}

/** Текст литерала для поля ввода; у токена литерала нет — там пусто. */
function literalText(value: QueryBound): string {
  return isToken(value) ? '' : String(value);
}

/** Совпадает ли значение с ключом варианта: `orbis/planned=true` приезжает флагом, не строкой. */
function sameValue(value: QueryBound, key: string): boolean {
  return !isToken(value) && String(value) === key;
}

export function FieldRow({
  field,
  label,
  view,
  index,
  onNodes,
}: {
  field: FieldRef;
  /** Подпись строки: подпись свойства, а при нескольких узлах по нему — с номером. */
  label: string;
  view: FieldNodeView | null;
  /** Индекс узла в плоском списке конструкций; null — строка-заготовка, узла ещё нет. */
  index: number | null;
  onNodes: (fn: (nodes: QueryFilterNode[]) => QueryFilterNode[]) => void;
}) {
  const id = useId();
  const operator: Operator = view?.op ?? '';

  /**
   * Оператор списка, с которым строка жила последний раз. Узел исчезает от стирания
   * ПОСЛЕДНЕГО значения (пустой список канон не выражает — `min(1)` в схеме), и повторный
   * ввод заводит его заново уже без узла: литеральный `'anyOf'` здесь переворачивал бы смысл
   * («заменить, что именно исключаем» превращало `!done` в `done`). Память живёт в строке, а
   * не в AST: в AST этого узла в тот момент нет вовсе.
   *
   * Ref, а не state: значение только сопровождает узел и само по себе ничего не рисует —
   * перерисовка от него была бы кадром без единого изменения на экране.
   */
  const listKind = useRef<'anyOf' | 'noneOf'>('anyOf');
  if (operator === 'anyOf' || operator === 'noneOf') listKind.current = operator;

  /** Запись узла на место строки: `null` — конструкции больше нет. */
  function writeNode(next: QueryFilterNode | null): void {
    onNodes((list) => {
      if (next === null) return index === null ? list : list.filter((_, i) => i !== index);
      if (index === null) return [...list, next];
      return list.map((n, i) => (i === index ? next : n));
    });
  }

  /**
   * Запись списка значений — одним путём и для существующего узла, и для строки-заготовки:
   * варианты видны ДО того, как фильтр заведён (иначе «снял последнюю галочку» прятало бы
   * весь набор значений, и вернуть его было бы нечем, кроме селекта операторов).
   */
  function writeValues(values: QueryBound[]): void {
    if (values.length === 0) {
      writeNode(null);
      return;
    }
    const kind =
      operator === 'noneOf' ? 'noneOf' : operator === 'anyOf' ? 'anyOf' : listKind.current;
    writeNode(listNode(field, kind, values));
  }

  function changeOperator(next: Operator): void {
    if (next === '') {
      // «Нет фильтра» — ЯВНЫЙ отказ от конструкции, а не побочный эффект стирания значения:
      // следующий фильтр по этому свойству строка заводит с чистого листа, иначе галочка
      // после сброса тихо возвращала бы отрицание, которого уже не просили.
      listKind.current = 'anyOf';
      writeNode(null);
      return;
    }
    writeNode(buildNode(next, field, view));
  }

  return (
    <div className="flex flex-col gap-1 border-line border-t pt-2 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2">
        <span className="flex min-w-0 flex-1 items-baseline gap-1">
          <label htmlFor={id} className="truncate text-sm text-text">
            {label}
          </label>
          {/* Ключ — машинная ручка имени в тексте блока (§А5-3а). Он РЯДОМ и aria-hidden:
              читать его вслух незачем, а видеть — да, ровно он уедет в текст. */}
          <span aria-hidden className="truncate font-mono text-2xs text-text-muted">
            {field.key}
          </span>
        </span>
        <select
          id={id}
          value={operator}
          className={`${FIELD_CLS} w-32 shrink-0`}
          onChange={(e) => changeOperator(e.target.value as Operator)}
        >
          <option value="">нет фильтра</option>
          <option value="anyOf">любое из</option>
          <option value="noneOf">ни одно из</option>
          {/* Сравнения — только там, где их принимает разбор: у типов с линейным порядком
              (§А5-7). Список исключён: у него порядка нет. */}
          {isComparable(field) && (
            <>
              <option value="gt">больше</option>
              <option value="lt">меньше</option>
              <option value="range">диапазон</option>
            </>
          )}
        </select>
      </div>
      {/* Значения видны и БЕЗ узла: у вариантов это набор галочек, у строк и чисел — пустая
          строка-заготовка, которую заводит первый символ. Дате заготовка не полагается:
          пустой литерал там означает «переключился на точное значение», а не «значения нет». */}
      {(operator === 'anyOf' || operator === 'noneOf' || (view === null && !isDateLike(field))) && (
        <ConditionValues
          field={field}
          label={label}
          values={view === null ? [] : view.values}
          onValues={writeValues}
        />
      )}
      {(operator === 'gt' || operator === 'lt') && view !== null && (
        <BoundInput
          field={field}
          label={`${label}: значение`}
          dateLabel={`${label}: дата`}
          value={view.from ?? ''}
          onValue={(value) => writeNode(boundNode(field, operator, value))}
        />
      )}
      {operator === 'range' && view !== null && (
        <div className="flex gap-2">
          <BoundInput
            field={field}
            label={`${label}: от`}
            dateLabel={`${label}: от, дата`}
            value={view.from ?? ''}
            onValue={(value) => writeNode(rangeNode(field, value, view.to ?? ''))}
          />
          <BoundInput
            field={field}
            label={`${label}: до`}
            dateLabel={`${label}: до, дата`}
            value={view.to ?? ''}
            onValue={(value) => writeNode(rangeNode(field, view.from ?? '', value))}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Новый узел под выбранный оператор. Значения переносятся там, где они означают то же самое
 * («любое из» ↔ «ни одно из» — один и тот же список), и заводятся заново там, где смысл
 * другой: список литералов не превратить в границу сравнения, не выдумав числа.
 */
function buildNode(
  op: Exclude<Operator, ''>,
  field: FieldRef,
  prev: FieldNodeView | null,
): QueryFilterNode {
  if (op === 'anyOf' || op === 'noneOf') {
    const values = prev !== null && prev.values.length > 0 ? prev.values : [defaultValue(field)];
    return listNode(field, op, values);
  }
  const carried = prev?.from ?? null;
  if (op === 'range') {
    const bound = carried ?? '';
    return rangeNode(field, bound, prev?.to ?? bound);
  }
  return boundNode(field, op, carried ?? '');
}

/** Одна граница сравнения/диапазона либо одно значение списка. */
function BoundInput({
  field,
  label,
  dateLabel,
  value,
  onValue,
}: {
  field: FieldRef;
  /** Доступное имя единственного контрола (у дат — селекта «токен или точное значение»). */
  label: string;
  /** Доступное имя поля точного значения — оно появляется рядом с селектом токенов. */
  dateLabel: string;
  value: QueryBound;
  onValue: (v: QueryBound) => void;
}) {
  if (!isDateLike(field)) {
    return (
      <input
        aria-label={label}
        type={field.kind === 'date' ? 'date' : 'text'}
        inputMode={field.kind === 'number' || field.kind === 'decimal' ? 'decimal' : undefined}
        placeholder={field.kind === 'time' ? 'ЧЧ:ММ' : undefined}
        value={literalText(value)}
        onChange={(e) => onValue(e.target.value)}
        className={`${FIELD_CLS} w-full`}
      />
    );
  }
  return (
    <>
      <select
        aria-label={label}
        value={isToken(value) ? value.token : 'exact'}
        className={`${FIELD_CLS} min-w-0 flex-1`}
        onChange={(e) => {
          const picked = e.target.value;
          onValue(picked === 'exact' ? '' : { token: picked as QueryDateToken });
        }}
      >
        {DATE_TOKEN_LABELS.map(([token, text]) => (
          <option key={token} value={token}>
            {text}
          </option>
        ))}
        <option value="exact">точное значение</option>
      </select>
      {!isToken(value) && (
        <input
          aria-label={dateLabel}
          type={field.kind === 'date' ? 'date' : 'text'}
          placeholder={field.kind === 'timestamp' ? '2026-07-02T09:00:00Z' : undefined}
          value={literalText(value)}
          onChange={(e) => onValue(e.target.value)}
          className={`${FIELD_CLS} min-w-0 flex-1`}
        />
      )}
    </>
  );
}

/** Значения «любое из» / «ни одно из»: галочки у вариантов, токены у дат, список строк иначе. */
function ConditionValues({
  field,
  label,
  values,
  onValues,
}: {
  field: FieldRef;
  /** Подпись строки (с номером, если узлов по свойству несколько) — основа имён всех значений. */
  label: string;
  values: QueryBound[];
  onValues: (values: QueryBound[]) => void;
}) {
  const listed = listedValues(field);
  if (listed !== null) {
    return (
      <div className="flex flex-wrap gap-x-3 gap-y-1 pl-1">
        {listed.map((option) => {
          const checked = values.some((v) => sameValue(v, option.key));
          return (
            <label key={option.key} className="flex items-center gap-1 text-sm text-text">
              <input
                type="checkbox"
                // Подписи вариантов повторяются между свойствами (`true`/`false` у четырёх
                // флагов), поэтому доступное имя несёт подпись свойства — иначе в форме
                // четыре одноимённые галочки.
                aria-label={`${label}: ${option.label}`}
                checked={checked}
                className="size-4 accent-accent"
                onChange={() =>
                  onValues(
                    checked
                      ? values.filter((v) => !sameValue(v, option.key))
                      : [...values, option.key],
                  )
                }
              />
              {option.label}
            </label>
          );
        })}
      </div>
    );
  }

  // Узла ещё нет — рисуем пустую строку-заготовку: значение набирается прямо в ней, и она же
  // остаётся под курсором, когда единственное значение стёрли (позиционные ключи не дают
  // <input> пересоздаться, иначе фокус улетал бы в body посреди правки).
  const empty = values.length === 0;
  const rows: QueryBound[] = empty ? [''] : values;

  /** Пустой текст = «значения нет»: единственное стёртое убирает конструкцию целиком. */
  function editValue(i: number, next: QueryBound): void {
    // У дат пустой литерал — это «переключился с токена на точное значение», а не «стёр»:
    // трактуй его как отсутствие значения, и выбор «точное значение» удалял бы фильтр.
    const cleared = !isDateLike(field) && !isToken(next) && String(next) === '';
    if (empty) {
      onValues(cleared ? [] : [next]);
      return;
    }
    if (cleared && values.length === 1) {
      onValues([]);
      return;
    }
    onValues(values.map((v, k) => (k === i ? next : v)));
  }

  return (
    <div className="flex flex-col gap-1 pl-1">
      {rows.map((value, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: позиция и есть личность значения в списке
          key={i}
          className="flex items-center gap-2"
        >
          <BoundInput
            field={field}
            label={`${label}: значение ${i + 1}`}
            dateLabel={`${label}: дата ${i + 1}`}
            value={value}
            onValue={(next) => editValue(i, next)}
          />
          {!empty && (
            <button
              type="button"
              aria-label={`Удалить значение ${i + 1}: ${label}`}
              className={ROW_BUTTON_CLS}
              onClick={() => onValues(values.filter((_, k) => k !== i))}
            >
              ×
            </button>
          )}
        </div>
      ))}
      {/* У заготовки кнопки «добавить» нет: второе пустое значение рядом с первым пустым
          ничего не добавляет, а `key=""` в строке блока — уже добавляет. */}
      {!empty && (
        <button
          type="button"
          className={`${ROW_BUTTON_CLS} self-start`}
          onClick={() => onValues([...values, defaultValue(field)])}
        >
          Добавить значение: {label}
        </button>
      )}
    </div>
  );
}
