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
 * ПОЛОВИНА ЭТОГО ФАЙЛА УМЕРЛА В ЗАДАЧЕ 23, как и было объявлено. Старые имена полей
 * (`amount`, `category_ref`, `status`) резолвила переходная карта
 * `registry/legacy-field-map.ts`; «Пересев мира» снёс её целиком вместе с формой данных,
 * которая эти имена и порождала. Осталcя резолв «id либо key» — то есть КАНОН §А5-3а, и
 * второго способа назвать свойство больше нет ни у текста запроса, ни у поля агрегата.
 * `aspectsNamedInQueryAst` пережил обе даты — он про канон, а не про старую форму.
 */
import type { QueryAst, QueryFilterNode } from './ast';
import type { ParseRegistry } from './parse-ast';

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
 * Адрес поля → id свойства канона (§А5-2: в дереве лежат id, не подписи).
 *
 * Порядок резолва: id, затем `key`. Третьего шага — «старое имя поля аспекта» — больше нет:
 * его карту снял «Пересев мира» вместе со старой формой данных, и вместе с ним ушла вся
 * машинерия разведения неоднозначности (`amount` носили и `orbis/financial`, и
 * `orbis/budget`, поэтому имя приходилось уточнять аспектами, названными самим запросом).
 * Канон однозначен по построению: `orbis/amount` — один адрес и одно свойство.
 *
 * Неизвестный адрес возвращает `undefined` — отказ называет вызывающий, у каждого из двух
 * входов он свой (`UNKNOWN_FIELD` у агрегата, `invalid_query` у прогресса цели).
 */
export function resolvePropertyFieldId(field: string, reg: ParseRegistry): string | undefined {
  if (reg.properties.has(field)) return field;
  for (const prop of reg.properties.values()) {
    if (prop.key === field) return prop.id;
  }
  return undefined;
}
