/**
 * РЕЗОЛВ ИМЕНИ ПОЛЯ В АДРЕС СВОЙСТВА — для тех входов, где имя приезжает НЕ из текста
 * запроса: поле агрегата `user_query.field` и источник прогресса цели `progress_source.field`.
 *
 * Почему это отдельный модуль, а не часть разбора. Текст запроса с Задачи 21b разбирает
 * ТОЛЬКО `parseQueryAst`, и он принимает ровно два способа назвать свойство — namespaced key
 * и закавыченную подпись (§А5-3а). А `field` у двух входов выше — не текст запроса, а
 * отдельное поле, которое модель и переходные данные заполняют старым именем поля аспекта
 * (`amount`, `category_ref`), и второй резолв рядом разошёлся бы с этим на первом же слитом
 * свойстве.
 *
 * ДАТА СМЕРТИ ПОЛОВИНЫ ЭТОГО ФАЙЛА — Задача 23, и это проверяемое утверждение: старые имена
 * резолвит `propertyToLegacyField` (`registry/legacy-field-map.ts`), а РП-3 удаляет её
 * целиком. Останется резолв «id либо key», который в комментарии не нуждается.
 * `aspectsNamedInQueryAst` переживает обе даты — он про КАНОН, а не про старую форму.
 */
import { propertyToLegacyField } from '../registry/legacy-field-map';
import type { QueryAst, QueryFilterNode } from './ast';
import type { ParseRegistry } from './parse-ast';

/**
 * Core-свойства (§А1-3) под их СТАРЫМИ именами: носителя-аспекта у них нет, поэтому через
 * `propertyToLegacyField` они не находятся вовсе. `title` попадает сюда только из `sortBy`:
 * в позиции фильтра его имя занято параметром заголовка выдачи.
 */
const CORE_LEGACY_PROPERTY: Readonly<Record<string, string>> = {
  created_at: 'orbis/created_at',
  updated_at: 'orbis/updated_at',
  title: 'orbis/title',
};

interface LegacyFieldOwner {
  aspect: string;
  propertyId: string;
}

function legacyFieldIndex(reg: ParseRegistry): Map<string, LegacyFieldOwner[]> {
  const index = new Map<string, LegacyFieldOwner[]>();
  for (const aspect of reg.aspects.values()) {
    for (const ref of aspect.properties) {
      const name = propertyToLegacyField(ref.propertyId, aspect.id);
      if (name === undefined) continue;
      const list = index.get(name);
      if (list) list.push({ aspect: aspect.id, propertyId: ref.propertyId });
      else index.set(name, [{ aspect: aspect.id, propertyId: ref.propertyId }]);
    }
  }
  return index;
}

/**
 * Аспекты, НАЗВАННЫЕ запросом, — для резолва неоднозначного имени поля (§А5-3ж, `aspect=`
 * разводит подписи). Обход итеративный, а не рекурсивный: дерево приезжает недоверенным
 * входом `ast:` тула, и рекурсия по нему исчерпала бы стек на том же входе, на котором его
 * исчерпывает zod (см. докблок `queryFilterNodeSchema`).
 *
 * Узлы под `not` СЧИТАЮТСЯ: «покажи не-задачи» тоже называет аспект `orbis/task` — это
 * подсказка о том, про что запрос, а не про то, что попадёт в выдачу.
 */
export function aspectsNamedInQueryAst(ast: QueryAst): Set<string> {
  const found = new Set<string>();
  const stack: QueryFilterNode[] = ast.filter === null ? [] : [ast.filter];
  while (stack.length > 0) {
    const node = stack.pop() as QueryFilterNode;
    if ('aspect' in node) found.add(node.aspect);
    else if ('and' in node) stack.push(...node.and);
    else if ('or' in node) stack.push(...node.or);
    else if ('not' in node) stack.push(node.not);
  }
  return found;
}

/**
 * Имя поля → id свойства канона (§А5-2: в дереве лежат id, не подписи).
 *
 * Порядок резолва: id → key → core-имя старой формы → карта полей аспектов;
 * неоднозначность разводится аспектами, названными САМИМ запросом (`aspect=` — единственное,
 * чем автор разводит имя, которое носят несколько аспектов). Два последних шага уедут
 * вместе с `legacy-field-map.ts` в Задаче 23.
 */
export function resolveLegacyFieldId(
  field: string,
  reg: ParseRegistry,
  aspectsInQuery: ReadonlySet<string> = new Set(),
): string | undefined {
  // Имя может быть уже каноническим — id или key свойства: так его пишут переведённые
  // потребители, и заставлять их говорить по-старому ради моста было бы шагом назад.
  if (reg.properties.has(field)) return field;
  for (const prop of reg.properties.values()) {
    if (prop.key === field) return prop.id;
  }
  const core = CORE_LEGACY_PROPERTY[field];
  if (core !== undefined) return reg.properties.has(core) ? core : undefined;
  const owners = legacyFieldIndex(reg).get(field) ?? [];
  if (owners.length === 1) return (owners[0] as LegacyFieldOwner).propertyId;
  if (owners.length === 0) return undefined;
  const narrowed = owners.filter((o) => aspectsInQuery.has(o.aspect));
  if (narrowed.length === 1) return (narrowed[0] as LegacyFieldOwner).propertyId;
  // Слитые свойства (§А8/В1): у `category_ref` и `currency` носителей два, но свойство
  // одно — такое имя однозначно, хотя аспектов и несколько.
  const ids = new Set(owners.map((o) => o.propertyId));
  return ids.size === 1 ? (owners[0] as LegacyFieldOwner).propertyId : undefined;
}
