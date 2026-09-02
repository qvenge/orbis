/**
 * Визуальная форма-редактор query-блока (02-core-os §3.4, канон Q-AST §А5-7).
 *
 * Состояние формы — сам разобранный `QueryAst`: форма правит его узлы на месте и печатает
 * обратно `printQueryAst` в КЛЮЧЕВОЙ форме (§А5-2 — key канон). Наружу форма отдаёт СТРОКУ:
 * дерево у блока с Задачи 21a хранится в `attrs.ast` документа, но собирает его привязка к
 * реестру (`bindQueryBlocks`), а не эта форма, — она остаётся редактором текста.
 *
 * Правило «без изменений — байт-в-байт» (Р3): совпала печать текущего AST с печатью
 * исходного — наверх уходит ИСХОДНАЯ строка. Защищает оно текст, НАПИСАННЫЙ ЧЕЛОВЕКОМ:
 * пробелы и кавычки печать нормализует, и «открыл форму, ничего не менял, нажал Сохранить»
 * без правила переписало бы чужую запись. На сидах правило стало тождеством — Задача 21b
 * перевела их тела в ту же однострочную key-форму, которую печатает форма (сторож —
 * `seed/seed-canon.test.ts`), — но первый повод оно пережило, и сторож рукописного текста
 * в `query-form.test.tsx` живой. Поправил лимит — блок печатается целиком, а не правкой
 * подстроки: половина строки в одном виде и половина в другом не разобралась бы ничем.
 *
 * Форма требует РАЗБИРАЕМОГО блока; неразбираемый — забота строкового редактора (§3.4, выбор
 * редактора делает QueryBlockEditor).
 */

import type { QueryAst, QueryDisplayMode, QueryFilterNode } from '@orbis/shared/query';
import { isExcludeBlockedSugar } from '@orbis/shared/query';
import { useId, useMemo, useState } from 'react';
import type { QueryRegistry } from '../../lib/query-blocks/catalog';
import { useFieldCatalog } from '../../lib/query-blocks/useFieldCatalog';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { FIELD_CLS, FieldRow, ROW_BUTTON_CLS } from './FieldRows';
import {
  aspectsOf,
  excludeBlockedNode,
  fieldNodeView,
  fieldRef,
  labelOfText,
  parseForForm,
  printQuery,
  sortableFieldIds,
  topNodes,
  visibleFieldIds,
  withNodes,
} from './model';

type Nodes = QueryFilterNode[];
type PatchNodes = (fn: (nodes: Nodes) => Nodes) => void;

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
   * Переход в строковый редактор. Аргумент — ТЕКУЩАЯ печать формы (§3.4: «тот же редактор с
   * текущей сериализацией»): без него набранное в форме терялось бы на переходе.
   */
  onEditAsText: (query: string) => void;
}) {
  const { registry } = useFieldCatalog();
  const initialAst = useMemo(
    () => (registry ? parseForForm(initial, registry) : null),
    [registry, initial],
  );

  // Состояние заводится, как только приехал реестр: до него разобрать блок нечем.
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
  // здесь и по НАБРАННОМУ значению — подсунуть печати NaN ради его исключения значило бы
  // объяснять человеку его же ввод служебным словом.
  const limit = useMemo<{ value?: number; error: string | null }>(() => {
    const raw = limitText.trim();
    if (raw === '') return { error: null };
    const value = Number.parseInt(raw, 10);
    if (!/^\d+$/.test(raw) || value <= 0) {
      // Формулировка — дословно разборная (`parse-ast.ts`, ветка `limit`): одна ошибка
      // обязана звучать одинаково, откуда бы человек к ней ни пришёл.
      return { error: `limit: целое больше 0, получено '${raw}'` };
    }
    return { value, error: null };
  }, [limitText]);

  const effective = useMemo<QueryAst | null>(() => {
    if (ast === null) return null;
    const { limit: _dropped, ...rest } = ast;
    return limit.value === undefined ? rest : { ...rest, limit: limit.value };
  }, [ast, limit.value]);

  const printed = useMemo(
    () => (effective && registry ? printQuery(effective, registry) : null),
    [effective, registry],
  );
  const initialPrinted = useMemo(
    () => (initialAst && registry ? printQuery(initialAst, registry) : null),
    [initialAst, registry],
  );

  let body: React.ReactNode;
  if (registry === null) {
    // Реестр едет tRPC (он живёт в БД). До него ни разобрать блок, ни показать поля.
    body = (
      <p role="status" className="py-6 text-center text-sm text-text-secondary">
        Загрузка…
      </p>
    );
  } else if (ast === null || effective === null || printed === null) {
    // Реестр есть, а AST нет — блок не разобрался или не печатается обратно. Штатно сюда не
    // попадают (редактор выбирает форму только для таких, что и то и другое), но врать
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
        registry={registry}
      />
    );
  }

  // Что мешает записи: отказ по лимиту считаем мы (см. выше), всё остальное — печать с
  // обратным разбором (`}}` в значении, пустая граница сравнения, дерево вне грамматики v1).
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
  registry,
}: {
  ast: QueryAst;
  setAst: (fn: (prev: QueryAst | null) => QueryAst | null) => void;
  limitText: string;
  setLimitText: (v: string) => void;
  registry: QueryRegistry;
}) {
  const patch = (next: Partial<QueryAst>): void =>
    setAst((prev) => (prev === null ? prev : { ...prev, ...next }));
  const patchNodes: PatchNodes = (fn) =>
    setAst((prev) => (prev === null ? prev : withNodes(prev, fn(topNodes(prev)))));

  const nodes = useMemo(() => topNodes(ast), [ast]);
  const selected = useMemo(() => new Set(aspectsOf(nodes)), [nodes]);
  const aspectOptions = useMemo(() => {
    const known = new Map(
      registry.aspects.map((a) => [a.id, labelOfText(a.label, registry.parse.locale)]),
    );
    // Аспект, названный в запросе, но исчезнувший из реестра, обязан остаться видимым:
    // иначе снять его было бы нечем, а запрос молча носил бы фильтр, которого не видно.
    for (const id of selected) if (!known.has(id)) known.set(id, id);
    return [...known.entries()];
  }, [registry, selected]);
  const fieldIds = useMemo(
    () => visibleFieldIds(nodes, registry, selected),
    [nodes, registry, selected],
  );
  const orHintId = useId();

  return (
    <div className="flex flex-col gap-4">
      <Section title="Аспекты">
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {aspectOptions.map(([id, label]) => (
            <label key={id} className="flex items-center gap-1 text-sm text-text">
              <input
                type="checkbox"
                checked={selected.has(id)}
                className="size-4 accent-accent"
                onChange={() =>
                  patchNodes((list) =>
                    selected.has(id)
                      ? list.filter((n) => !('aspect' in n && n.aspect === id))
                      : [...list, { aspect: id }],
                  )
                }
              />
              {label}
            </label>
          ))}
        </div>
      </Section>

      <Section title="Теги">
        <TagList
          kind="tags"
          singular="Тег"
          addLabel="Добавить тег"
          nodes={nodes}
          onNodes={patchNodes}
        />
        <TagList
          kind="excludeTags"
          singular="Исключённый тег"
          addLabel="Добавить исключённый тег"
          nodes={nodes}
          onNodes={patchNodes}
        />
      </Section>

      <Section title="Поля">
        {fieldIds.map((id) => {
          const field = fieldRef(id, registry);
          if (field === null) return null;
          const rows = nodes.flatMap((node, index) => {
            const view = fieldNodeView(node);
            return view !== null && view.prop === id ? [{ view, index }] : [];
          });
          const display: Array<{ view: ReturnType<typeof fieldNodeView>; index: number | null }> =
            rows.length > 0 ? rows : [{ view: null, index: null }];
          return display.map((row, k) => (
            <FieldRow
              // biome-ignore lint/suspicious/noArrayIndexKey: ключ — МЕСТО строки среди строк свойства, а не индекс узла: заведение фильтра меняет index с null на число, и ключ по нему пересоздавал бы строку, выбрасывая фокус из селекта ровно в момент выбора
              key={`${id}#${k}`}
              field={field}
              // Несколько узлов по одному свойству — законны (`amount>100, amount<500`), а
              // одинаковые доступные имена — нет: подпись получает номер.
              label={display.length > 1 ? `${field.label} #${k + 1}` : field.label}
              view={row.view}
              index={row.index}
              onNodes={patchNodes}
            />
          ));
        })}
        {/*
          Кнопка есть и погашена НАМЕРЕННО, и причина у неё ПОСТОЯННАЯ, а не «пока не доехало»:
          OR между разными свойствами канон выражает (§А5-7, узел `{or}`), а плоский текст
          грамматики — нет (§А5-3д). Блок с 21a хранит ДЕРЕВО, но у него есть вторая, равная по
          силе форма — markdown-проекция тела: `{{query:…}}` печатается текстом, и запрос,
          который текстом не печатается, потерялся бы на первом же круге «печать → разбор»
          (рулинг Р-21-6). Разблокировать кнопку можно будет не «после перехода на AST», а
          только вместе со СКОБОЧНОЙ формой текста. Спрятать её значило бы скрыть от человека,
          что возможность существует; дать нажать — собрать запрос, который не переживёт тело.
        */}
        <button
          type="button"
          disabled
          aria-describedby={orHintId}
          className={`${ROW_BUTTON_CLS} self-start disabled:cursor-not-allowed disabled:opacity-40`}
        >
          ИЛИ между полями
        </button>
        <p id={orHintId} className="text-2xs text-text-muted">
          «ИЛИ» между разными полями пока не выражается текстом блока.
        </p>
      </Section>

      <Section title="Связи">
        <RelationRows
          kind="children_of"
          label="Дети сущности"
          idLabel="Id сущности (дети)"
          nodes={nodes}
          onNodes={patchNodes}
        />
        <RelationRows
          kind="parents_of"
          label="Родители сущности"
          idLabel="Id сущности (родители)"
          nodes={nodes}
          onNodes={patchNodes}
        />
      </Section>

      <Section title="Отбор">
        <BlockedCheckbox registry={registry} nodes={nodes} onNodes={patchNodes} />
        <LabeledControl label="Архивные">
          {(id) => (
            <select
              id={id}
              className={FIELD_CLS}
              value={nodes.flatMap((n) => ('archived' in n ? [n.archived] : []))[0] ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                patchNodes((list) => {
                  const rest = list.filter((n) => !('archived' in n));
                  // Узел допускает ровно true|any (§А5-7); пустое значение — его отсутствие.
                  if (v !== 'true' && v !== 'any') return rest;
                  return [...rest, { archived: v }];
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
        <SortRows ast={ast} registry={registry} onPatch={patch} />
      </Section>

      <Section title="Вывод">
        <LabeledControl label="Поиск по тексту">
          {(id) => (
            <input
              id={id}
              className={FIELD_CLS}
              value={nodes.flatMap((n) => ('search' in n ? [n.search] : []))[0] ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                patchNodes((list) => {
                  // `search` в каноне — УЗЕЛ фильтра, а не параметр проекции (§А5-7), и
                  // пустая строка ему запрещена схемой: «поиска нет» — это отсутствие узла.
                  const rest = list.filter((n) => !('search' in n));
                  return v === '' ? rest : [...rest, { search: v }];
                });
              }}
            />
          )}
        </LabeledControl>
        {/* «Лимит выдачи», а не «Лимит»: с §А5-3а свойство конверта `orbis/limit` («Лимит»)
            стало адресуемым и получает в форме собственную строку — два одноимённых
            контрола в одной форме недостижимы ни клавиатурой, ни скринридером. */}
        <LabeledControl label="Лимит выдачи">
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

/**
 * «Скрыть заблокированные» — текстовый сахар `excludeBlocked=true` (§А5-3): в дереве это
 * отрицание ребра `dependency` с условием на дальний конец, и собран он из id РЕЕСТРА.
 *
 * Узел строит сам разбор (`excludeBlockedNode`), а не литералы формы: «что такое закрытая
 * работа» — знание языка, и второй его копии здесь быть не должно. Реестр без роли или без
 * `orbis/task_status` даёт `null` — тогда контрола нет вовсе, и это честнее галочки, которая
 * записала бы ссылку на несуществующую роль.
 */
function BlockedCheckbox({
  registry,
  nodes,
  onNodes,
}: {
  registry: QueryRegistry;
  nodes: Nodes;
  onNodes: PatchNodes;
}) {
  const sugar = useMemo(() => excludeBlockedNode(registry), [registry]);
  const isSugar = (node: QueryFilterNode): boolean =>
    'not' in node && 'rel' in node.not && isExcludeBlockedSugar(node.not.rel, registry.parse);
  if (sugar === null) return null;
  const checked = nodes.some(isSugar);
  return (
    <label className="flex items-center gap-2 text-sm text-text">
      <input
        type="checkbox"
        checked={checked}
        className="size-4 accent-accent"
        onChange={(e) =>
          onNodes((list) => (e.target.checked ? [...list, sugar] : list.filter((n) => !isSugar(n))))
        }
      />
      Скрыть заблокированные
    </label>
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

/** Теги одной группы: `{tag}` либо `{or:[{tag}…]}`, у исключений — под `{not}` (§А5-7). */
function tagValues(node: QueryFilterNode, kind: 'tags' | 'excludeTags'): string[] | null {
  const negated = 'not' in node;
  if (negated !== (kind === 'excludeTags')) return null;
  const inner = 'not' in node ? node.not : node;
  if ('tag' in inner) return [inner.tag];
  if (!('or' in inner)) return null;
  const values: string[] = [];
  for (const child of inner.or) {
    if (!('tag' in child)) return null;
    values.push(child.tag);
  }
  return values;
}

function tagNode(kind: 'tags' | 'excludeTags', values: readonly string[]): QueryFilterNode {
  const leaves: QueryFilterNode[] = values.map((tag) => ({ tag }));
  const inner: QueryFilterNode =
    leaves.length === 1 ? (leaves[0] as QueryFilterNode) : { or: leaves };
  return kind === 'excludeTags' ? { not: inner } : inner;
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
  nodes,
  onNodes,
}: {
  kind: 'tags' | 'excludeTags';
  singular: string;
  addLabel: string;
  nodes: Nodes;
  onNodes: PatchNodes;
}) {
  const groups = nodes.flatMap((node, index) => {
    const values = tagValues(node, kind);
    return values === null ? [] : [{ index, values }];
  });
  // Плоский список «значение → его место в дереве»: ключи строк позиционные, поэтому очистка
  // последнего тега (узел исчезает, остаётся строка-заготовка) не пересоздаёт <input> и не
  // отнимает у него фокус посреди набора.
  const rows = groups.flatMap((g) =>
    g.values.map((value, valueIndex) => ({ node: g.index, valueIndex, value })),
  );
  const display: Array<{ node: number | null; valueIndex: number; value: string }> =
    rows.length > 0 ? rows : [{ node: null, valueIndex: 0, value: '' }];

  const editValue = (row: (typeof display)[number], next: string): void =>
    onNodes((list) => {
      if (row.node === null) return next === '' ? list : [...list, tagNode(kind, [next])];
      // Пустое значение — это «значения нет». Стёртое единственное убирает конструкцию
      // целиком, симметрично снятию последней галочки у поля-варианта: иначе сохранился бы
      // разбирающийся, но бессмысленный `tags=""`. Пустое среди нескольких остаётся видимым
      // (и снимается крестиком) — сдвигать соседей под курсором было бы хуже.
      const group = groups.find((g) => g.index === row.node);
      if (group === undefined) return list;
      if (next === '' && group.values.length === 1) {
        return list.filter((_, k) => k !== row.node);
      }
      const values = group.values.map((v, j) => (j === row.valueIndex ? next : v));
      return list.map((n, k) => (k === row.node ? tagNode(kind, values) : n));
    });

  const removeValue = (row: (typeof display)[number]): void =>
    onNodes((list) => {
      const group = groups.find((g) => g.index === row.node);
      if (group === undefined) return list;
      // Последнее значение группы — вместе с самой группой: пустой список тегов канон не
      // выражает (`min(1)` в схеме `or`).
      if (group.values.length === 1) return list.filter((_, k) => k !== row.node);
      const values = group.values.filter((_, j) => j !== row.valueIndex);
      return list.map((n, k) => (k === row.node ? tagNode(kind, values) : n));
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
          onNodes((list) => {
            const last = groups.at(-1);
            if (last === undefined) return [...list, tagNode(kind, [''])];
            return list.map((n, k) => (k === last.index ? tagNode(kind, [...last.values, '']) : n));
          })
        }
      >
        {addLabel}
      </button>
    </div>
  );
}

/**
 * `children_of=` / `parents_of=`: `this` либо конкретный id (§А5-7). Пикера сущности в фазе
 * нет — id вводится руками.
 *
 * `this` из web РАБОТАЕТ: экран сущности передаёт контекст блока (ThisEntityProvider вокруг
 * тела в DetailScreen → thisEntityId в entity.query). Остаётся оговорка про ПЕРЕЕЗД блока:
 * тому же тексту, прочитанному вне ТЕЛА записи (Browser, бейдж закреплённого списка),
 * контекст не передаётся намеренно — `this` там означал бы «запись, из чьего тела блок
 * скопировали», а не «текущий экран», и по-прежнему ответит ошибкой.
 */
function RelationRows({
  kind,
  label,
  idLabel,
  nodes,
  onNodes,
}: {
  kind: 'children_of' | 'parents_of';
  label: string;
  idLabel: string;
  nodes: Nodes;
  onNodes: PatchNodes;
}) {
  const found = nodes.flatMap((node, index) =>
    'rel' in node && node.rel.kind === kind ? [{ index, of: node.rel.of }] : [],
  );
  const rows: Array<{ index: number | null; of: string | null }> =
    found.length > 0 ? found : [{ index: null, of: null }];

  const write = (index: number | null, node: QueryFilterNode | null): void =>
    onNodes((list) => {
      if (node === null) return index === null ? list : list.filter((_, i) => i !== index);
      if (index === null) return [...list, node];
      return list.map((n, i) => (i === index ? node : n));
    });

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
                  value={row.of === null ? '' : row.of === 'this' ? 'this' : 'id'}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === '') write(row.index, null);
                    else write(row.index, { rel: { kind, of: v === 'this' ? 'this' : '' } });
                  }}
                >
                  <option value="">нет</option>
                  <option value="this">эта сущность (this)</option>
                  <option value="id">по id</option>
                </select>
              )}
            </LabeledControl>
            {row.of !== null && row.of !== 'this' && (
              <input
                aria-label={rowIdLabel}
                value={row.of}
                placeholder="00000000-0000-0000-0000-000000000000"
                className={`${FIELD_CLS} w-full`}
                onChange={(e) => write(row.index, { rel: { kind, of: e.target.value } })}
              />
            )}
            {row.of === 'this' && (
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
  registry,
  onPatch,
}: {
  ast: QueryAst;
  registry: QueryRegistry;
  onPatch: (next: Partial<QueryAst>) => void;
}) {
  const sort = ast.sortBy ?? [];
  const options = useMemo(() => sortableFieldIds(registry), [registry]);
  const addId = useId();
  const nameOf = (id: string): string => fieldRef(id, registry)?.label ?? id;

  const write = (next: typeof sort): void =>
    onPatch({ sortBy: next.length === 0 ? undefined : next });

  return (
    <div className="flex flex-col gap-2">
      {sort.map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: порядок значим (§А5-7), и одно свойство может стоять в sortBy дважды — личность строки задаёт место
        <div key={i} className="flex items-center gap-1">
          <select
            aria-label={`Поле сортировки ${i + 1}`}
            value={s.field}
            className={`${FIELD_CLS} min-w-0 flex-1`}
            onChange={(e) =>
              write(sort.map((x, k) => (k === i ? { ...x, field: e.target.value } : x)))
            }
          >
            {/* Текущее значение — всегда в списке: свойство могло исчезнуть из реестра, но
                выбрасывать его из селекта значило бы менять запрос молча. */}
            {[...new Set([s.field, ...options])].map((id) => (
              <option key={id} value={id}>
                {nameOf(id)}
              </option>
            ))}
          </select>
          <select
            aria-label={`Направление ${i + 1}`}
            value={s.dir}
            className={`${FIELD_CLS} w-28 shrink-0`}
            onChange={(e) =>
              write(
                sort.map((x, k) => (k === i ? { ...x, dir: e.target.value as 'asc' | 'desc' } : x)),
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
            e.target.value !== '' && write([...sort, { field: e.target.value, dir: 'asc' }])
          }
        >
          <option value="">—</option>
          {options
            .filter((id) => !sort.some((s) => s.field === id))
            .map((id) => (
              <option key={id} value={id}>
                {nameOf(id)}
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
