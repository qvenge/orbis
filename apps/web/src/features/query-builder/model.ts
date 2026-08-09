/**
 * Модель формы-редактора query-блока: что грамматика §6.1 позволяет собрать из полей
 * каталога и как AST формы превращается обратно в строку блока.
 *
 * Состояние формы — сам `QueryAst`, а не своя структура: любое отображение «AST → поля
 * формы → AST» теряло бы конструкции, которых в отображении нет (два `tags=`, второе
 * сравнение по тому же полю). Форма правит узлы на месте, порядок массива сохраняется,
 * а всё, чего её контролы не покрывают, доезжает до сериализации нетронутым.
 */

import type {
  FieldCatalog,
  FieldInfo,
  FieldType,
  QueryAst,
  QueryComparableValue,
  QueryFieldValue,
  QueryFilter,
} from '@orbis/shared';
import { CORE_FIELDS, parseQuery, serializeQuery } from '@orbis/shared';

/** Узлы отбора, привязанные к имени поля (§6.1): равенство/отрицание, сравнение, диапазон. */
export type FieldNode = Extract<QueryFilter, { kind: 'field' | 'comparison' | 'range' }>;

export function isFieldNode(f: QueryFilter): f is FieldNode {
  return f.kind === 'field' || f.kind === 'comparison' || f.kind === 'range';
}

/** Поле в терминах формы: тип для выбора контрола + признаки, влияющие на разрешённые формы. */
export interface FieldRef {
  name: string;
  type: FieldType;
  /** created_at/updated_at — только они сравниваются как timestamp (§6.1). */
  core: boolean;
  enumValues?: string[];
}

const CORE_NAMES = Object.keys(CORE_FIELDS) as Array<keyof typeof CORE_FIELDS>;

/**
 * Занято ли имя ключом грамматики §6.1. Спрашиваем сам парсер на одноимённом каталоге из
 * одного поля, а не копируем список ключей третий раз (он уже продублирован в parse.ts и
 * serialize.ts): копия молча разъехалась бы с грамматикой, а поле-призрак в форме — это
 * `limit=100` вместо фильтра по `orbis/budget.limit`, то есть фильтр, исчезнувший без
 * ошибки. Каталог тут искусственный именно поэтому: настоящий подмешал бы к ответу ещё и
 * неоднозначность имени, а это другой вопрос и другой ответ формы.
 */
const reservedCache = new Map<string, boolean>();
export function isReservedKey(name: string): boolean {
  const cached = reservedCache.get(name);
  if (cached !== undefined) return cached;
  const probe: FieldCatalog = { fields: { [name]: [{ aspect: 'orbis/probe', type: 'string' }] } };
  const r = parseQuery(`${name}=orbis_probe`, probe);
  const reserved = !(r.ok && r.ast.filters.length === 1 && r.ast.filters[0]?.kind === 'field');
  reservedCache.set(name, reserved);
  return reserved;
}

/** Аспекты, названные в запросе (`aspect=`) — они же резолвят неоднозначные имена полей. */
export function aspectsOf(ast: QueryAst): string[] {
  return ast.filters.flatMap((f) => (f.kind === 'aspect' ? [f.aspect] : []));
}

/** Описание поля с учётом выбранных аспектов; неизвестное имя деградирует до строки. */
export function fieldRef(
  name: string,
  catalog: FieldCatalog,
  selected: ReadonlySet<string>,
): FieldRef {
  if (name === 'created_at' || name === 'updated_at') {
    return { name, type: CORE_FIELDS[name], core: true };
  }
  const infos = catalog.fields[name] ?? [];
  // Неоднозначное имя (`currency` живёт в двух аспектах) резолвится по выбранным aspect=,
  // как это делает парсер; не разрешилось — берём первое описание, чтобы было чем рисовать
  // контрол. О самой неоднозначности скажет проверка печати: там сообщение парсера дословно.
  const narrowed = infos.length > 1 ? infos.filter((i) => selected.has(i.aspect)) : infos;
  const info: FieldInfo | undefined = narrowed.length === 1 ? narrowed[0] : infos[0];
  const ref: FieldRef = { name, type: info?.type ?? 'string', core: false };
  if (info?.enumValues) ref.enumValues = info.enumValues;
  return ref;
}

/**
 * Имена полей, которым форма рисует строки: core-поля, поля выбранных аспектов и поля, на
 * которые уже есть узлы (снятый аспект не должен прятать живой фильтр — иначе он уехал бы
 * в body невидимым). Порядок каталога — по аспектам в порядке реестра, внутри — по схеме.
 *
 * Поля типа `unfilterable` (объект `orbis/schedule.recurrence`, разнотипный union
 * `orbis/goal.progress_source`) отсеиваются: грамматика фильтра для них не определена, и
 * контрол печатал бы строку, которую парсер отказывается разбирать, — форма предлагала бы
 * выбор, который гарантированно не сохранится. Поля типа `array` (`orbis/category.aliases`)
 * ОСТАЮТСЯ: у них честный containment-предикат, обычное равенство их и фильтрует.
 * На узел, уже стоящий в AST, отказ не может распространиться иначе: непарсящееся поле не
 * доходит до формы вовсе (`parseForForm` вернёт null, и откроется строковый редактор),
 * поэтому `used` не содержит нефильтруемых имён и фильтр по типу не прячет живой узел.
 *
 * Второй зазор — он тут ЕСТЬ, и сегодня не стреляет. Тип спрашивается через `fieldRef`, а
 * тот при НЕразрешённой неоднозначности берёт `infos[0]`, тогда как парсер в этом же месте
 * отказывает («неоднозначное поле … уточните запрос через aspect=»). Разойтись они могут
 * ровно в одном случае: имя живёт в двух аспектах и **оба выбраны** (`aspect=orbis/financial,
 * aspect=orbis/budget`) — выбирать между описаниями форме нечем, и она берёт первое по
 * каталогу. Сегодня решение от порядка не зависит вовсе: неоднозначных имён в реестре два
 * (`category_ref`, `currency`), и оба — `string` в обоих аспектах. Зазор начнёт стрелять,
 * если одно имя окажется скаляром в одном аспекте и не-скаляром в другом: строка поля
 * появится или исчезнет по порядку каталога, а не по правилу. Тихой потери и тогда не
 * будет — такой запрос не печатается вовсе, `printQuery` отдаёт дословный отказ парсера про
 * неоднозначность, — но правило станет случайным, и назвать его придётся явно.
 * `sortableFieldNames` этого зазора не имеет: он выбрасывает неоднозначные имена ДО того,
 * как спросит тип.
 */
export function visibleFieldNames(ast: QueryAst, catalog: FieldCatalog): string[] {
  const selected = new Set(aspectsOf(ast));
  const used = new Set(ast.filters.filter(isFieldNode).map((f) => f.field));
  const names: string[] = [...CORE_NAMES];
  for (const [name, infos] of Object.entries(catalog.fields)) {
    if (names.includes(name) || isReservedKey(name)) continue;
    if (!(used.has(name) || infos.some((i) => selected.has(i.aspect)))) continue;
    // Тип спрашиваем ровно так же, как его выберет контрол (fieldRef), — иначе список имён
    // и нарисованная по нему строка расходились бы на неоднозначном имени.
    if (fieldRef(name, catalog, selected).type === 'unfilterable') continue;
    names.push(name);
  }
  return names;
}

/**
 * Имена, доступные сортировке (§6.1): каталог `sortBy` шире фильтров ровно на core-`title`,
 * но уже по типу — линейного порядка нет ни у массива, ни у объекта/union, и парсер по
 * обоим отказывает (`sortBy: по полю 'aliases' сортировать нельзя — это массив`). Отсюда
 * асимметрия с фильтрами: `array` там разрешён, здесь — нет. Неоднозначные имена
 * отсеиваются — `sortBy=currency:asc` без `aspect=` не разберётся так же, как фильтр.
 */
export function sortableFieldNames(ast: QueryAst, catalog: FieldCatalog): string[] {
  const selected = new Set(aspectsOf(ast));
  const names: string[] = [...CORE_NAMES, 'title'];
  for (const [name, infos] of Object.entries(catalog.fields)) {
    if (names.includes(name) || isReservedKey(name)) continue;
    if (infos.length !== 1 && infos.filter((i) => selected.has(i.aspect)).length !== 1) continue;
    const { type } = fieldRef(name, catalog, selected);
    if (type === 'array' || type === 'unfilterable') continue;
    names.push(name);
  }
  return names;
}

/**
 * Допустимо ли поле в сравнении `>`/`<` и диапазоне `..` (§6.1): числовые поля, date-поля
 * аспектов и core-timestamp. Timestamp-поля аспектов (`start_at`, `end_at`, `completed_at`)
 * операторами не сравниваются — предложи их форма, строка перестала бы разбираться.
 */
export function isComparable(ref: FieldRef): boolean {
  if (ref.core) return ref.type === 'timestamp';
  if (ref.type === 'date') return true;
  return ref.type === 'number' || ref.type === 'integer' || ref.type === 'decimal';
}

/** Значения, которые поле принимает списком: enum как есть, boolean — как enum из двух. */
export function listedValues(ref: FieldRef): string[] | null {
  if (ref.enumValues) return ref.enumValues;
  return ref.type === 'boolean' ? ['true', 'false'] : null;
}

/** Даты выражаются относительными токенами (§6.1) — они же дефолт нового условия. */
export function isDateLike(ref: FieldRef): boolean {
  return ref.type === 'date' || ref.type === 'timestamp';
}

/** Стартовое значение нового условия: осмысленное для типа и всегда печатаемое. */
export function defaultValues(ref: FieldRef): QueryFieldValue[] {
  const listed = listedValues(ref);
  if (listed) return [{ kind: 'literal', value: listed[0] as string }];
  if (isDateLike(ref)) return [{ kind: 'date_token', token: 'today' }];
  return [{ kind: 'literal', value: '' }];
}

/** Стартовая граница сравнения/диапазона — по типу значения, который примет парсер (§6.1). */
export function defaultComparable(ref: FieldRef): QueryComparableValue {
  if (ref.core) return { kind: 'timestamp', value: '' };
  if (ref.type === 'date') return { kind: 'date', value: '' };
  return { kind: 'decimal', value: '' };
}

export type Printed = {
  /** Строка блока; null — сериализатор отказался печатать AST вовсе. */
  text: string | null;
  /** Почему строку нельзя записывать; null — всё в порядке. */
  error: string | null;
};

/**
 * AST формы → строка блока с проверкой, что она разберётся обратно. Двойная проверка не
 * лишняя: сериализатор ловит непечатаемый AST (пустой список значений, `limit` не целым,
 * `}}` в значении), а обратный разбор — то, чего он проверить не может, потому что не
 * знает каталога: неоднозначное имя без `aspect=`, пустое или нечисловое значение
 * сравнения. Оба случая обязаны быть видны ДО записи в body, а не красной плашкой после.
 */
export function printQuery(ast: QueryAst, catalog: FieldCatalog): Printed {
  let text: string;
  try {
    text = serializeQuery(ast);
  } catch (e) {
    return { text: null, error: e instanceof Error ? e.message : String(e) };
  }
  const back = parseQuery(text, catalog);
  return { text, error: back.ok ? null : back.error.message };
}

/**
 * AST для формы: строка обязана и разобраться, и напечататься обратно. Не напечаталась —
 * форма таким блоком не управляет, и вызывающий обязан открыть строковый редактор
 * (иначе первое же сохранение молча потеряло бы конструкцию).
 */
export function parseForForm(initial: string, catalog: FieldCatalog): QueryAst | null {
  const r = parseQuery(initial.trim(), catalog);
  if (!r.ok) return null;
  return printQuery(r.ast, catalog).text === null ? null : r.ast;
}
