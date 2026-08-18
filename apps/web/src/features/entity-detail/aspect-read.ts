/**
 * Разбор полей аспекта РУКАМИ, а не зод-схемой из `@orbis/shared`.
 *
 * Аспекты приезжают в wire-форме как `Record<string, unknown>` — тип по id аспекта клиенту
 * не известен, и без разбора это `unknown` в каждом поле. Соблазн взять готовую
 * `agentRunAspectSchema` (или `routineAspectSchema`) велик, но она притащила бы zod в чанк
 * `DetailScreen`, где его сегодня нет вовсе (ни один модуль web не импортирует zod напрямую), —
 * то есть заплатила бы весом первого кадра записи за проверку данных, которые сервер уже
 * провалидировал на записи.
 *
 * Отсюда правило разбора: поле неверной формы — как отсутствующее. Запись рисуется тем, что в
 * ней разобралось; пустая лента честнее, чем красный экран на одном кривом шаге.
 *
 * Живут эти четыре функции ОБЩИМ модулем, а не копией в каждом читателе аспекта: у ленты
 * прогона и у блока состояния рутины правило одно, и разъехаться ему было бы негде — а копия
 * разъезжается ровно в тот день, когда одну из них правят («пустая строка — это значение?»).
 */
export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

export function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * Массив строк аспекта (`days`, `allowed_tools`). Элементы не той формы ОТБРАСЫВАЮТСЯ, а не
 * роняют весь массив: список прав, потерявший один кривой элемент, читается; список,
 * исчезнувший целиком, читался бы как «прав нет вовсе» — а это прямая ложь о том, что рутине
 * позволено. Пустой массив на выходе неотличим от отсутствия поля — по схеме пустых `days`
 * и `allowed_tools` не бывает.
 */
export function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const items = v.filter((item): item is string => typeof item === 'string' && item !== '');
  return items.length === 0 ? undefined : items;
}
