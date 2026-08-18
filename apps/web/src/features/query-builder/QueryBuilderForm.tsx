/**
 * Визуальная форма-редактор query-блока (02-core-os §3.4, грамматика 01-architecture §6.1).
 *
 * Состояние формы — сам разобранный AST: форма правит его узлы на месте и печатает обратно
 * `serializeQuery`. Второго хранилища у блока нет — строка в body и есть состояние (§3.4).
 *
 * Правило «без изменений — байт-в-байт» (Р3): совпала печать текущего AST с печатью
 * исходного — наверх уходит ИСХОДНАЯ строка. Сериализатор по построению даёт одну строку,
 * а все шесть сидированных smart lists многострочные: без этого правила «открыл форму и
 * ничего не менял» переписывало бы запись схлопнутым блоком.
 *
 * Форма требует валидного парса; невалидный блок — забота строкового редактора (§3.4,
 * выбор редактора делает QueryBlockEditor).
 */

import type { QueryAst, QueryDisplayMode, QueryFilter, QuerySortDirection } from '@orbis/shared';
import { useId, useMemo, useState } from 'react';
import { aspectLabel } from '../../lib/field-labels';
import { useFieldCatalog } from '../../lib/query-blocks/useFieldCatalog';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { FIELD_CLS, FieldRow, ROW_BUTTON_CLS } from './FieldRows';
import {
  aspectsOf,
  type FieldNode,
  fieldRef,
  isFieldNode,
  parseForForm,
  printQuery,
  sortableFieldNames,
  visibleFieldNames,
} from './model';

type Filters = QueryFilter[];
type PatchFilters = (fn: (filters: Filters) => Filters) => void;

export function QueryBuilderForm({
  initial,
  onSave,
  onCancel,
  onEditAsText,
}: {
  initial: string;
  onSave: (query: string) => void;
  onCancel: () => void;
  /**
   * Переход в строковый редактор. Аргумент — ТЕКУЩАЯ сериализация формы (§3.4: «тот же
   * редактор с текущей сериализацией»): без него набранное в форме терялось бы на переходе.
   */
  onEditAsText: (query: string) => void;
}) {
  const { catalog, aspectIds } = useFieldCatalog();
  const initialAst = useMemo(
    () => (catalog ? parseForForm(initial, catalog) : null),
    [catalog, initial],
  );

  // Состояние заводится, как только приехал каталог: до него разобрать блок нечем.
  // Прямо в теле рендера, без useEffect — идиома «черновик vs серверное значение» detail.
  const [ast, setAst] = useState<QueryAst | null>(null);
  const [limitText, setLimitText] = useState('');
  if (ast === null && initialAst !== null) {
    setAst(initialAst);
    setLimitText(initialAst.limit === undefined ? '' : String(initialAst.limit));
  }

  // `limit` живёт отдельной строкой, а не числом в AST: набирая «50» поверх «30», человек
  // проходит через пустую строку. Пустая — это «лимита нет», конструкция просто уходит из
  // AST. Непустое непечатаемое (`0`, дробное) в AST не попадает вовсе: отказ формулируется
  // здесь и по НАБРАННОМУ значению — подсунуть сериализатору NaN ради его исключения
  // значило бы объяснять человеку его же ввод служебным словом.
  const limit = useMemo<{ value?: number; error: string | null }>(() => {
    const raw = limitText.trim();
    if (raw === '') return { error: null };
    const value = Number.parseInt(raw, 10);
    if (!/^\d+$/.test(raw) || value <= 0) {
      // Формулировка — дословно парсерская (parse.ts, parseLimit): одна ошибка обязана
      // звучать одинаково, откуда бы человек к ней ни пришёл.
      return { error: `limit должен быть целым числом больше 0, получено '${raw}'` };
    }
    return { value, error: null };
  }, [limitText]);

  const effective = useMemo<QueryAst | null>(() => {
    if (ast === null) return null;
    const { limit: _dropped, ...rest } = ast;
    return limit.value === undefined ? rest : { ...rest, limit: limit.value };
  }, [ast, limit.value]);

  const printed = useMemo(
    () => (effective && catalog ? printQuery(effective, catalog) : null),
    [effective, catalog],
  );
  const initialPrinted = useMemo(
    () => (initialAst && catalog ? printQuery(initialAst, catalog) : null),
    [initialAst, catalog],
  );

  let body: React.ReactNode;
  if (catalog === null) {
    // Каталог едет tRPC (реестр живёт в БД). До него ни разобрать блок, ни показать поля.
    body = (
      <p role="status" className="py-6 text-center text-sm text-text-secondary">
        Загрузка…
      </p>
    );
  } else if (ast === null || effective === null || printed === null) {
    // Каталог есть, а AST нет — блок не разобрался или не печатается обратно. Штатно сюда
    // не попадают (редактор выбирает форму только для таких, что и то и другое), но врать
    // «Загрузка…» в этом состоянии нельзя: выход — тот же строковый редактор в футере.
    body = (
      <p role="alert" className="py-6 text-center text-danger text-sm">
        Этот блок формой не выражается — откройте его как текст.
      </p>
    );
  } else {
    body = (
      <FormBody
        ast={ast}
        setAst={setAst}
        limitText={limitText}
        setLimitText={setLimitText}
        aspectIds={aspectIds}
        catalog={catalog}
      />
    );
  }

  // Что мешает записи: отказ по лимиту считаем мы (см. выше), всё остальное — печать с
  // обратным разбором (непечатаемый AST, неоднозначное имя поля, пустая граница сравнения).
  const formError = limit.error ?? printed?.error ?? null;
  const blocked = printed === null || printed.text === null || formError !== null;

  function handleSave(): void {
    if (blocked || printed?.text == null) return;
    // Р3: печать не изменилась — отдаём исходную строку дословно, со всеми её переносами.
    onSave(printed.text === initialPrinted?.text ? initial : printed.text);
  }

  return (
    <Dialog
      open
      onOpenChange={(v) => {
        // Esc, крестик и клик по подложке — тот же отказ от правки, что «Отмена».
        if (!v) onCancel();
      }}
      title="Настройка блока"
    >
      <div className="mt-3 flex flex-col gap-4">
        {body}
        {formError !== null && (
          // role="status", а не alert: сообщение пересчитывается на каждое движение в форме,
          // и ассертивная озвучка перебивала бы собственные действия пользователя.
          <p role="status" data-testid="qb-form-error" className="text-danger text-sm">
            {formError}
          </p>
        )}
        <div className="sticky bottom-0 flex flex-wrap justify-end gap-2 bg-surface pt-2">
          <Button
            variant="ghost"
            size="sm"
            className="mr-auto"
            onClick={() => onEditAsText(printed?.text ?? initial)}
          >
            Редактировать как текст
          </Button>
          <Button variant="outline" size="sm" onClick={onCancel}>
            Отмена
          </Button>
          <Button size="sm" disabled={blocked} onClick={handleSave}>
            Сохранить
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function FormBody({
  ast,
  setAst,
  limitText,
  setLimitText,
  aspectIds,
  catalog,
}: {
  ast: QueryAst;
  setAst: (fn: (prev: QueryAst | null) => QueryAst | null) => void;
  limitText: string;
  setLimitText: (v: string) => void;
  aspectIds: string[];
  catalog: NonNullable<ReturnType<typeof useFieldCatalog>['catalog']>;
}) {
  const patch = (next: Partial<QueryAst>): void =>
    setAst((prev) => (prev === null ? prev : { ...prev, ...next }));
  const patchFilters: PatchFilters = (fn) =>
    setAst((prev) => (prev === null ? prev : { ...prev, filters: fn(prev.filters) }));

  const selected = useMemo(() => new Set(aspectsOf(ast)), [ast]);
  const aspectOptions = useMemo(
    () => [...new Set([...aspectIds, ...selected])],
    [aspectIds, selected],
  );
  const fieldNames = useMemo(() => visibleFieldNames(ast, catalog), [ast, catalog]);

  return (
    <div className="flex flex-col gap-4">
      <Section title="Аспекты">
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {aspectOptions.map((id) => (
            <label key={id} className="flex items-center gap-1 text-sm text-text">
              <input
                type="checkbox"
                checked={selected.has(id)}
                className="size-4 accent-accent"
                onChange={() =>
                  patchFilters((list) =>
                    selected.has(id)
                      ? list.filter((f) => !(f.kind === 'aspect' && f.aspect === id))
                      : [...list, { kind: 'aspect', aspect: id }],
                  )
                }
              />
              {aspectLabel(id)}
            </label>
          ))}
        </div>
      </Section>

      <Section title="Теги">
        <TagList
          kind="tags"
          singular="Тег"
          addLabel="Добавить тег"
          ast={ast}
          onFilters={patchFilters}
        />
        <TagList
          kind="excludeTags"
          singular="Исключённый тег"
          addLabel="Добавить исключённый тег"
          ast={ast}
          onFilters={patchFilters}
        />
      </Section>

      <Section title="Поля">
        {fieldNames.map((name) => {
          const field = fieldRef(name, catalog, selected);
          const nodes = ast.filters.flatMap((f, index) =>
            isFieldNode(f) && f.field === name ? [{ node: f as FieldNode, index }] : [],
          );
          const rows: Array<{ node: FieldNode | null; index: number | null }> =
            nodes.length > 0 ? nodes : [{ node: null, index: null }];
          return rows.map((row, k) => (
            <FieldRow
              // biome-ignore lint/suspicious/noArrayIndexKey: ключ — МЕСТО строки среди строк поля, а не индекс узла в AST: заведение фильтра меняет index с null на число, и ключ по нему пересоздавал бы строку, выбрасывая фокус из селекта ровно в момент выбора
              key={`${name}#${k}`}
              field={field}
              // Несколько узлов по одному полю — законны (`amount>100, amount<500`), а
              // одинаковые доступные имена — нет: подпись получает номер.
              label={rows.length > 1 ? `${name} #${k + 1}` : name}
              node={row.node}
              index={row.index}
              onFilters={patchFilters}
            />
          ));
        })}
      </Section>

      <Section title="Связи">
        <RelationRows
          kind="children_of"
          label="Дети сущности"
          idLabel="Id сущности (дети)"
          ast={ast}
          onFilters={patchFilters}
        />
        <RelationRows
          kind="parents_of"
          label="Родители сущности"
          idLabel="Id сущности (родители)"
          ast={ast}
          onFilters={patchFilters}
        />
      </Section>

      <Section title="Отбор">
        <label className="flex items-center gap-2 text-sm text-text">
          <input
            type="checkbox"
            checked={ast.filters.some((f) => f.kind === 'excludeBlocked')}
            className="size-4 accent-accent"
            onChange={(e) =>
              patchFilters((list) =>
                e.target.checked
                  ? [...list, { kind: 'excludeBlocked' }]
                  : list.filter((f) => f.kind !== 'excludeBlocked'),
              )
            }
          />
          Скрыть заблокированные
        </label>
        <LabeledControl label="Архивные">
          {(id) => (
            <select
              id={id}
              className={FIELD_CLS}
              value={ast.filters.find((f) => f.kind === 'archived')?.value ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                patchFilters((list) => {
                  const rest = list.filter((f) => f.kind !== 'archived');
                  // Узел допускает ровно true|any (§6.1); пустое значение — это его отсутствие.
                  if (v !== 'true' && v !== 'any') return rest;
                  return [...rest, { kind: 'archived', value: v }];
                });
              }}
            >
              <option value="">только неархивные</option>
              <option value="true">только архивные</option>
              <option value="any">все</option>
            </select>
          )}
        </LabeledControl>
      </Section>

      <Section title="Сортировка">
        <SortRows ast={ast} catalog={catalog} onPatch={patch} />
      </Section>

      <Section title="Вывод">
        <LabeledControl label="Поиск по тексту">
          {(id) => (
            <input
              id={id}
              className={FIELD_CLS}
              value={ast.search ?? ''}
              onChange={(e) =>
                patch({ search: e.target.value === '' ? undefined : e.target.value })
              }
            />
          )}
        </LabeledControl>
        <LabeledControl label="Лимит">
          {(id) => (
            <input
              id={id}
              type="number"
              min={1}
              step={1}
              className={FIELD_CLS}
              value={limitText}
              onChange={(e) => setLimitText(e.target.value)}
            />
          )}
        </LabeledControl>
        <LabeledControl
          label="Режим отображения"
          hint="Подсказка рендереру: сегодня все три режима рисуются одинаково."
        >
          {(id, describedBy) => (
            <select
              id={id}
              aria-describedby={describedBy}
              className={FIELD_CLS}
              value={ast.display ?? ''}
              onChange={(e) =>
                patch({
                  display: e.target.value === '' ? undefined : (e.target.value as QueryDisplayMode),
                })
              }
            >
              <option value="">по умолчанию</option>
              <option value="compact">компактный</option>
              <option value="list">список</option>
              <option value="table">таблица</option>
            </select>
          )}
        </LabeledControl>
        <LabeledControl label="Заголовок">
          {(id) => (
            <input
              id={id}
              className={FIELD_CLS}
              value={ast.title ?? ''}
              onChange={(e) => patch({ title: e.target.value === '' ? undefined : e.target.value })}
            />
          )}
        </LabeledControl>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="pb-1 font-medium text-text-secondary text-xs uppercase tracking-wide">
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

/** Подпись + контрол одной строкой; id связывает их, hint приезжает через aria-describedby. */
function LabeledControl({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (id: string, describedBy: string | undefined) => React.ReactNode;
}) {
  const id = useId();
  const hintId = useId();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="w-32 shrink-0 text-sm text-text-secondary">
          {label}
        </label>
        <span className="min-w-0 flex-1">
          {children(id, hint === undefined ? undefined : hintId)}
        </span>
      </div>
      {hint !== undefined && (
        <p id={hintId} className="text-2xs text-text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * Список тегов одной конструкции (`tags=` / `excludeTags=`). Конструкция повторяется в
 * запросе (два `tags=` — это AND двух OR-групп), поэтому рисуются ВСЕ её узлы; новую группу
 * форма не заводит — кнопка дописывает значение в последнюю (или создаёт первую).
 */
function TagList({
  kind,
  singular,
  addLabel,
  ast,
  onFilters,
}: {
  kind: 'tags' | 'excludeTags';
  singular: string;
  addLabel: string;
  ast: QueryAst;
  onFilters: PatchFilters;
}) {
  const groups = ast.filters.flatMap((f, index) =>
    f.kind === kind ? [{ index, values: f.values }] : [],
  );
  // Плоский список «значение → его место в AST»: ключи строк позиционные, поэтому очистка
  // последнего тега (узел исчезает, остаётся строка-заготовка) не пересоздаёт <input>
  // и не отнимает у него фокус посреди набора.
  const rows = groups.flatMap((g) =>
    g.values.map((value, valueIndex) => ({ node: g.index, valueIndex, value })),
  );
  const display: Array<{ node: number | null; valueIndex: number; value: string }> =
    rows.length > 0 ? rows : [{ node: null, valueIndex: 0, value: '' }];

  const editValue = (row: (typeof display)[number], next: string): void =>
    onFilters((list) => {
      if (row.node === null) return next === '' ? list : [...list, { kind, values: [next] }];
      // Пустое значение — это «значения нет». Стёртое единственное убирает конструкцию
      // целиком, симметрично снятию последней галочки у enum-поля: иначе сохранился бы
      // разбирающийся, но бессмысленный `tags=""`. Пустое среди нескольких остаётся видимым
      // (и снимается крестиком) — сдвигать соседей под курсором было бы хуже.
      const group = groups.find((g) => g.index === row.node);
      if (next === '' && group?.values.length === 1) {
        return list.filter((_, k) => k !== row.node);
      }
      return list.map((f, k) =>
        k === row.node && (f.kind === 'tags' || f.kind === 'excludeTags')
          ? { ...f, values: f.values.map((v, j) => (j === row.valueIndex ? next : v)) }
          : f,
      );
    });

  const removeValue = (row: (typeof display)[number]): void =>
    onFilters((list) => {
      if (row.node === null) return list;
      const group = groups.find((g) => g.index === row.node);
      // Последнее значение группы — вместе с самой группой: `tags=` грамматика не выражает,
      // и serializeQuery на пустом списке бросает.
      if (group?.values.length === 1) return list.filter((_, k) => k !== row.node);
      return list.map((f, k) =>
        k === row.node && (f.kind === 'tags' || f.kind === 'excludeTags')
          ? { ...f, values: f.values.filter((_, j) => j !== row.valueIndex) }
          : f,
      );
    });

  return (
    <div className="flex flex-col gap-1">
      {display.map((row, n) => {
        const label = `${singular} ${n + 1}`;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: позиция в списке и есть личность строки
          <div key={n} className="flex items-center gap-2">
            <input
              aria-label={label}
              value={row.value}
              className={`${FIELD_CLS} w-full`}
              onChange={(e) => editValue(row, e.target.value)}
            />
            {row.node !== null && (
              <button
                type="button"
                aria-label={`Удалить: ${label}`}
                className={ROW_BUTTON_CLS}
                onClick={() => removeValue(row)}
              >
                ×
              </button>
            )}
          </div>
        );
      })}
      <button
        type="button"
        className={`${ROW_BUTTON_CLS} self-start`}
        onClick={() =>
          onFilters((list) => {
            const last = groups.at(-1);
            if (last === undefined) return [...list, { kind, values: [''] }];
            return list.map((f, k) =>
              k === last.index && (f.kind === 'tags' || f.kind === 'excludeTags')
                ? { ...f, values: [...f.values, ''] }
                : f,
            );
          })
        }
      >
        {addLabel}
      </button>
    </div>
  );
}

/**
 * `children_of=` / `parents_of=`: `this` либо конкретный id (§6.1). Пикера сущности в фазе
 * нет — id вводится руками.
 *
 * `this` из web РАБОТАЕТ: экран сущности передаёт контекст блока (ThisEntityProvider вокруг
 * тела в DetailScreen → thisEntityId в entity.query). Прежнее предупреждение «клиент не
 * передаёт thisEntityId» устарело вместе с самим недостатком. Остаётся оговорка про
 * ПЕРЕЕЗД блока: тому же тексту, прочитанному вне ТЕЛА записи (Browser, бейдж закреплённого
 * списка), контекст не передаётся намеренно — `this` там означал бы «запись, из чьего тела блок
 * скопировали», а не «текущий экран», и по-прежнему ответит ошибкой.
 */
function RelationRows({
  kind,
  label,
  idLabel,
  ast,
  onFilters,
}: {
  kind: 'children_of' | 'parents_of';
  label: string;
  idLabel: string;
  ast: QueryAst;
  onFilters: PatchFilters;
}) {
  const nodes = ast.filters.flatMap((f, index) => (f.kind === kind ? [{ index, of: f.of }] : []));
  const rows: Array<{
    index: number | null;
    of: { kind: 'this' } | { kind: 'id'; id: string } | null;
  }> = nodes.length > 0 ? nodes : [{ index: null, of: null }];

  return (
    <>
      {rows.map((row, k) => {
        const rowLabel = rows.length > 1 ? `${label} ${k + 1}` : label;
        const rowIdLabel = rows.length > 1 ? `${idLabel} ${k + 1}` : idLabel;
        return (
          // Ключ — место строки, не индекс узла: заведение связи не должно пересоздавать
          // строку и выбрасывать фокус из селекта (та же причина, что у строк полей).
          // biome-ignore lint/suspicious/noArrayIndexKey: место строки и есть её личность
          <div key={k} className="flex flex-col gap-1">
            <LabeledControl label={rowLabel}>
              {(id) => (
                <select
                  id={id}
                  className={FIELD_CLS}
                  value={row.of?.kind ?? ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    onFilters((list) => {
                      if (v === '') {
                        return row.index === null ? list : list.filter((_, i) => i !== row.index);
                      }
                      const node: QueryFilter = {
                        kind,
                        of: v === 'this' ? { kind: 'this' } : { kind: 'id', id: '' },
                      };
                      if (row.index === null) return [...list, node];
                      return list.map((f, i) => (i === row.index ? node : f));
                    });
                  }}
                >
                  <option value="">нет</option>
                  <option value="this">эта сущность (this)</option>
                  <option value="id">по id</option>
                </select>
              )}
            </LabeledControl>
            {row.of?.kind === 'id' && (
              <input
                aria-label={rowIdLabel}
                value={row.of.id}
                placeholder="00000000-0000-0000-0000-000000000000"
                className={`${FIELD_CLS} w-full`}
                onChange={(e) =>
                  onFilters((list) =>
                    list.map((f, i) =>
                      i === row.index ? { kind, of: { kind: 'id', id: e.target.value } } : f,
                    ),
                  )
                }
              />
            )}
            {row.of?.kind === 'this' && (
              <p role="status" className="text-text-muted text-xs">
                `this` — запись, в теле которой лежит блок. Вне записи (Browser, бейдж закреплённого
                списка) такой блок ответит ошибкой «this вне контекста сущности».
              </p>
            )}
          </div>
        );
      })}
    </>
  );
}

/** Упорядоченный список сортировки: перестановка кнопками — DnD в проекте нет и не заводим. */
function SortRows({
  ast,
  catalog,
  onPatch,
}: {
  ast: QueryAst;
  catalog: NonNullable<ReturnType<typeof useFieldCatalog>['catalog']>;
  onPatch: (next: Partial<QueryAst>) => void;
}) {
  const sort = ast.sortBy ?? [];
  const options = useMemo(() => sortableFieldNames(ast, catalog), [ast, catalog]);
  const addId = useId();

  const write = (next: typeof sort): void =>
    onPatch({ sortBy: next.length === 0 ? undefined : next });

  return (
    <div className="flex flex-col gap-2">
      {sort.map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: порядок значим (§6.1), и одно поле может стоять в sortBy дважды — личность строки задаёт место
        <div key={i} className="flex items-center gap-1">
          <select
            aria-label={`Поле сортировки ${i + 1}`}
            value={s.field}
            className={`${FIELD_CLS} min-w-0 flex-1`}
            onChange={(e) =>
              write(sort.map((x, k) => (k === i ? { ...x, field: e.target.value } : x)))
            }
          >
            {/* Текущее значение — всегда в списке: снятый aspect= делает своё поле
                неоднозначным, но выбрасывать его из селекта значило бы менять запрос молча. */}
            {[...new Set([s.field, ...options])].map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <select
            aria-label={`Направление ${i + 1}`}
            value={s.direction}
            className={`${FIELD_CLS} w-28 shrink-0`}
            onChange={(e) =>
              write(
                sort.map((x, k) =>
                  k === i ? { ...x, direction: e.target.value as QuerySortDirection } : x,
                ),
              )
            }
          >
            <option value="asc">по возрастанию</option>
            <option value="desc">по убыванию</option>
          </select>
          <button
            type="button"
            aria-label={`Переместить выше: строка ${i + 1}`}
            disabled={i === 0}
            className={`${ROW_BUTTON_CLS} disabled:cursor-not-allowed disabled:opacity-40`}
            onClick={() => write(swap(sort, i, i - 1))}
          >
            ↑
          </button>
          <button
            type="button"
            aria-label={`Переместить ниже: строка ${i + 1}`}
            disabled={i === sort.length - 1}
            className={`${ROW_BUTTON_CLS} disabled:cursor-not-allowed disabled:opacity-40`}
            onClick={() => write(swap(sort, i, i + 1))}
          >
            ↓
          </button>
          <button
            type="button"
            aria-label={`Убрать из сортировки: строка ${i + 1}`}
            className={ROW_BUTTON_CLS}
            onClick={() => write(sort.filter((_, k) => k !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <label htmlFor={addId} className="w-32 shrink-0 text-sm text-text-secondary">
          Добавить поле сортировки
        </label>
        <select
          id={addId}
          value=""
          className={`${FIELD_CLS} min-w-0 flex-1`}
          onChange={(e) =>
            e.target.value !== '' && write([...sort, { field: e.target.value, direction: 'asc' }])
          }
        >
          <option value="">—</option>
          {options
            .filter((name) => !sort.some((s) => s.field === name))
            .map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
        </select>
      </div>
    </div>
  );
}

function swap<T>(list: readonly T[], a: number, b: number): T[] {
  const next = [...list];
  const first = next[a] as T;
  next[a] = next[b] as T;
  next[b] = first;
  return next;
}
