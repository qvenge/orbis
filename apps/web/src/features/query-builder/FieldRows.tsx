/**
 * Секция «Поля» формы-редактора: по строке на каждый узел отбора, привязанный к полю
 * (равенство/отрицание, сравнение, диапазон — §6.1), плюс пустая строка на поле, по
 * которому фильтра ещё нет.
 *
 * Строка — на УЗЕЛ, а не на поле: `amount>100, amount<500` — два законных узла по одному
 * полю, и одна строка на поле молча выбросила бы второй при сохранении.
 */

import type { QueryDateToken, QueryFieldValue, QueryFilter } from '@orbis/shared';
import { useId } from 'react';
import { fieldLabel } from '../../lib/field-labels';
import {
  defaultComparable,
  defaultValues,
  type FieldNode,
  type FieldRef,
  isComparable,
  isDateLike,
  listedValues,
} from './model';

/** Плотное поле формы: примитивов Select/Checkbox в src/ui нет — своя строка на своём элементе. */
export const FIELD_CLS =
  'min-w-0 rounded-control border border-line bg-surface px-2 py-1 text-sm text-text transition focus-visible:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40';
/** Мелкая кнопка внутри строки значения (× / добавить): не ui/Button — там свой кегль и паддинг. */
export const ROW_BUTTON_CLS =
  'shrink-0 cursor-pointer rounded-control border border-line px-2 py-1 text-text-secondary text-xs transition hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40';

/** Значение селекта операторов; пустая строка — «фильтра по этому полю нет». */
type Operator = '' | 'anyOf' | 'noneOf' | '>' | '<' | 'range';

const DATE_TOKEN_LABELS: Array<[QueryDateToken, string]> = [
  ['today', 'сегодня'],
  ['overdue', 'просрочено'],
  ['next_7d', 'ближайшие 7 дней'],
  ['after_7d', 'позже 7 дней'],
];

function operatorOf(node: FieldNode | null): Operator {
  if (node === null) return '';
  if (node.kind === 'range') return 'range';
  if (node.kind === 'comparison') return node.op;
  return node.condition.kind;
}

/**
 * Новый узел под выбранный оператор. Значения переносятся там, где они означают то же
 * самое («любое из» ↔ «ни одно из» — один и тот же список), и заводятся заново там, где
 * смысл другой: список литералов не превратить в границу сравнения, не выдумав числа.
 */
function buildNode(op: Exclude<Operator, ''>, field: FieldRef, prev: FieldNode | null): FieldNode {
  if (op === 'anyOf' || op === 'noneOf') {
    const values = prev?.kind === 'field' ? prev.condition.values : defaultValues(field);
    return { kind: 'field', field: field.name, condition: { kind: op, values } };
  }
  if (op === 'range') {
    const bound = prev?.kind === 'comparison' ? prev.value : defaultComparable(field);
    return { kind: 'range', field: field.name, min: { ...bound }, max: { ...bound } };
  }
  const value = prev?.kind === 'range' ? prev.min : defaultComparable(field);
  return { kind: 'comparison', field: field.name, op, value };
}

export function FieldRow({
  field,
  label,
  node,
  index,
  onFilters,
}: {
  field: FieldRef;
  /** Подпись строки: имя поля, а при нескольких узлах по нему — с номером (имена уникальны). */
  label: string;
  node: FieldNode | null;
  /** Индекс узла в `ast.filters`; null — строка-заготовка, узла ещё нет. */
  index: number | null;
  onFilters: (fn: (filters: QueryFilter[]) => QueryFilter[]) => void;
}) {
  const id = useId();
  const gloss = fieldLabel(field.name);

  /**
   * Запись списка значений — одним путём и для существующего узла, и для строки-заготовки:
   * галочки enum видны ДО того, как фильтр заведён (иначе «снял последнюю галочку» прятало
   * бы весь набор значений, и вернуть его было бы нечем, кроме селекта операторов).
   */
  function writeValues(values: QueryFieldValue[]): void {
    onFilters((list) => {
      // Пустой список грамматика не выражает (`status=` — ошибка), и serializeQuery на нём
      // бросает: «значений не осталось» здесь означает «фильтра нет».
      if (values.length === 0) return index === null ? list : list.filter((_, i) => i !== index);
      const kind = node?.kind === 'field' ? node.condition.kind : 'anyOf';
      const built: FieldNode = { kind: 'field', field: field.name, condition: { kind, values } };
      if (index === null) return [...list, built];
      return list.map((f, i) => (i === index ? built : f));
    });
  }

  function changeOperator(next: Operator): void {
    onFilters((list) => {
      if (next === '') return index === null ? list : list.filter((_, i) => i !== index);
      const built = buildNode(next, field, node);
      if (index === null) return [...list, built];
      return list.map((f, i) => (i === index ? built : f));
    });
  }

  function replaceNode(next: FieldNode | null): void {
    if (index === null) return;
    onFilters((list) =>
      next === null
        ? list.filter((_, i) => i !== index)
        : list.map((f, i) => (i === index ? next : f)),
    );
  }

  return (
    <div className="flex flex-col gap-1 border-line border-t pt-2 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2">
        <span className="flex min-w-0 flex-1 items-baseline gap-1">
          <label htmlFor={id} className="truncate font-mono text-text-secondary text-xs">
            {label}
          </label>
          {gloss !== field.name && (
            // Русская подпись — РЯДОМ с <label>, а не внутри: доступное имя контрола обязано
            // остаться именем поля грамматики — тем самым, что уедет в текст блока.
            <span aria-hidden className="truncate text-2xs text-text-muted">
              {gloss}
            </span>
          )}
        </span>
        <select
          id={id}
          value={operatorOf(node)}
          className={`${FIELD_CLS} w-32 shrink-0`}
          onChange={(e) => changeOperator(e.target.value as Operator)}
        >
          <option value="">нет фильтра</option>
          <option value="anyOf">любое из</option>
          <option value="noneOf">ни одно из</option>
          {/* Сравнения — только там, где их принимает парсер: числа, date-поля аспектов и
              core-timestamp. Timestamp-поля аспектов операторами не сравниваются (§6.1). */}
          {isComparable(field) && (
            <>
              <option value=">">больше</option>
              <option value="<">меньше</option>
              <option value="range">диапазон</option>
            </>
          )}
        </select>
      </div>
      {/* Значения видны и БЕЗ узла: у enum это набор галочек, у строк и чисел — пустая
          строка-заготовка, которую заводит первый символ. Дате заготовка не полагается:
          пустой литерал там означает «переключился на точное значение», а не «значения нет». */}
      {(node?.kind === 'field' || (node === null && !isDateLike(field))) && (
        <ConditionValues
          field={field}
          label={label}
          values={node?.kind === 'field' ? node.condition.values : []}
          onValues={writeValues}
        />
      )}
      {node?.kind === 'comparison' && (
        <ComparableInput
          field={field}
          label={`${label}: значение`}
          value={node.value.value}
          onValue={(value) => replaceNode({ ...node, value: { ...node.value, value } })}
        />
      )}
      {node?.kind === 'range' && (
        <div className="flex gap-2">
          <ComparableInput
            field={field}
            label={`${label}: от`}
            value={node.min.value}
            onValue={(value) => replaceNode({ ...node, min: { ...node.min, value } })}
          />
          <ComparableInput
            field={field}
            label={`${label}: до`}
            value={node.max.value}
            onValue={(value) => replaceNode({ ...node, max: { ...node.max, value } })}
          />
        </div>
      )}
    </div>
  );
}

/** Граница сравнения/диапазона: у дат — календарь, у core-timestamp — ISO 8601 руками. */
function ComparableInput({
  field,
  label,
  value,
  onValue,
}: {
  field: FieldRef;
  label: string;
  value: string;
  onValue: (v: string) => void;
}) {
  const date = !field.core && field.type === 'date';
  return (
    <input
      aria-label={label}
      type={date ? 'date' : 'text'}
      inputMode={date || field.core ? undefined : 'decimal'}
      placeholder={field.core ? '2026-07-02T09:00:00Z' : undefined}
      value={value}
      onChange={(e) => onValue(e.target.value)}
      className={`${FIELD_CLS} w-full`}
    />
  );
}

/** Значения «любое из» / «ни одно из»: галочки у enum, токены у дат, список строк иначе. */
function ConditionValues({
  field,
  label,
  values,
  onValues,
}: {
  field: FieldRef;
  /** Подпись строки (с номером, если узлов по полю несколько) — основа имён всех значений. */
  label: string;
  values: QueryFieldValue[];
  onValues: (values: QueryFieldValue[]) => void;
}) {
  const listed = listedValues(field);
  if (listed !== null) {
    return (
      <div className="flex flex-wrap gap-x-3 gap-y-1 pl-1">
        {listed.map((v) => {
          const checked = values.some((x) => x.kind === 'literal' && x.value === v);
          return (
            <label key={v} className="flex items-center gap-1 text-sm text-text">
              <input
                type="checkbox"
                // Значения enum повторяются между полями (`true`/`false` у четырёх boolean),
                // поэтому доступное имя несёт поле — иначе в форме четыре кнопки «true».
                aria-label={`${label}: ${v}`}
                checked={checked}
                className="size-4 accent-accent"
                onChange={() =>
                  onValues(
                    checked
                      ? values.filter((x) => !(x.kind === 'literal' && x.value === v))
                      : [...values, { kind: 'literal', value: v }],
                  )
                }
              />
              {v}
            </label>
          );
        })}
      </div>
    );
  }

  // Узла ещё нет — рисуем пустую строку-заготовку: значение набирается прямо в ней, и она
  // же остаётся под курсором, когда единственное значение стёрли (позиционные ключи не дают
  // <input> пересоздаться, иначе фокус улетал бы в body посреди правки).
  const empty = values.length === 0;
  const rows: QueryFieldValue[] = empty ? [{ kind: 'literal', value: '' }] : values;

  /** Пустой текст = «значения нет»: единственное стёртое убирает конструкцию целиком. */
  function editValue(i: number, next: QueryFieldValue): void {
    // У дат пустой литерал — это «переключился с токена на точное значение», а не «стёр»:
    // трактуй его как отсутствие значения, и выбор «точное значение» удалял бы фильтр.
    const cleared = !isDateLike(field) && next.kind === 'literal' && next.value === '';
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
          <ValueInput
            field={field}
            label={label}
            index={i}
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
          ничего не добавляет, а `field=""` в строке блока — уже добавляет. */}
      {!empty && (
        <button
          type="button"
          className={`${ROW_BUTTON_CLS} self-start`}
          onClick={() => onValues([...values, ...defaultValues(field)])}
        >
          Добавить значение: {label}
        </button>
      )}
    </div>
  );
}

/** Одно значение списка: у date/timestamp — относительный токен или точное значение (§6.1). */
function ValueInput({
  field,
  label,
  index,
  value,
  onValue,
}: {
  field: FieldRef;
  /** Подпись строки поля — с номером, если узлов по этому полю несколько. */
  label: string;
  index: number;
  value: QueryFieldValue;
  onValue: (v: QueryFieldValue) => void;
}) {
  if (!isDateLike(field)) {
    return (
      <input
        aria-label={`${label}: значение ${index + 1}`}
        value={value.kind === 'literal' ? value.value : value.token}
        onChange={(e) => onValue({ kind: 'literal', value: e.target.value })}
        className={`${FIELD_CLS} w-full`}
      />
    );
  }
  return (
    <>
      <select
        aria-label={`${label}: значение ${index + 1}`}
        value={value.kind === 'date_token' ? value.token : 'exact'}
        className={`${FIELD_CLS} min-w-0 flex-1`}
        onChange={(e) => {
          const picked = e.target.value;
          onValue(
            picked === 'exact'
              ? { kind: 'literal', value: '' }
              : { kind: 'date_token', token: picked as QueryDateToken },
          );
        }}
      >
        {DATE_TOKEN_LABELS.map(([token, label]) => (
          <option key={token} value={token}>
            {label}
          </option>
        ))}
        <option value="exact">точное значение</option>
      </select>
      {value.kind === 'literal' && (
        <input
          aria-label={`${label}: дата ${index + 1}`}
          type={field.type === 'date' ? 'date' : 'text'}
          value={value.value}
          onChange={(e) => onValue({ kind: 'literal', value: e.target.value })}
          className={`${FIELD_CLS} min-w-0 flex-1`}
        />
      )}
    </>
  );
}
