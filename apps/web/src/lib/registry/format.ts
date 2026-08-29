// apps/web/src/lib/registry/format.ts
//
// Показ ЗНАЧЕНИЯ свойства текстом — по типу из реестра (§А2-2), а не по тому, чем это
// значение оказалось в рантайме.
//
// Разница наблюдаема ровно там, где реформа и меняла адрес. Прежде форма строки решалась
// вопросом `typeof value` (`isScalar` ниже): строка — инпут, объект — read-only. Тип
// свойства при этом не спрашивали вовсе, и `orbis/task_status` со значением `'inbox'`
// печатался машинным ключом, хотя у варианта есть подпись `Входящие` в самом реестре.
// Здесь показ идёт ОТ ОБЪЯВЛЕНИЯ: `select` показывает подпись варианта, `boolean` —
// «да»/«нет», список — перечисление, а «типа не знаем» (свойства нет в снимке) честно
// откатывается к прежнему правилу по значению.
//
// Слов в файле три — «да», «нет» и прочерк, — и ни одно из них не является подписью ЗАПИСИ
// реестра: это подписи ЗНАЧЕНИЙ языка (булев литерал и пустота), у которых ни id, ни
// владельца, ни label в jsonb нет. Ровно по той же границе в коде остался `AGGREGATE_LABELS`
// (`lib/field-labels.ts`): ключевое слово грамматики — не запись реестра.
import { effectiveLabel, OWNER_LOCALE, type PropertyDefinition } from '@orbis/shared';

/** Прочерк вместо пустого места: «поле есть, значения нет» читается, пустая ячейка — нет. */
export const EMPTY_TEXT = '—';

/**
 * Правится ли значение строкой в инпуте. Инпут отдаёт СТРОКУ, и обратно в объект или
 * массив она не превращается ничем: до этой проверки объектный `progress_source` цели
 * рисовался как `[object Object]` (String(value)), а blur слал эту строку и получал
 * жёсткий VALIDATION от ajv — поле выглядело сломанным на КАЖДОЙ цели (обязательное
 * поле аспекта). То же касалось `orbis/recurrence` и `orbis/aliases`.
 *
 * Дом здесь, а не в карточках свойств, потому что читателей ДВА и оба вне записи: строка
 * предложения рутины (`ProposalOverlay`) спрашивает то же самое о значении, у которого
 * строки реестра может не быть вовсе (`tags`, `emoji`), — а карточки свойств спрашивают
 * это только там, где тип свойства неизвестен (см. `valueText`).
 */
export function isScalar(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean'
  );
}

/**
 * Показ значения БЕЗ объявления типа: список скаляров — через запятую, всё прочее —
 * компактным JSON. Это и есть та форма, в которой значение уедет обратно на сервер, и по
 * ней видно опечатку в запросе.
 *
 * Пустой список — прочерк, а не пустое место: `Алиасы: ` без значения читается как
 * сломанная строка, а не как «алиасов нет».
 */
export function valueText(value: unknown): string {
  if (value === undefined || value === null) return EMPTY_TEXT;
  if (Array.isArray(value) && value.length === 0) return EMPTY_TEXT;
  if (Array.isArray(value) && value.every(isScalar))
    return value.map((v) => String(v ?? '')).join(', ');
  if (typeof value === 'object') return JSON.stringify(value) ?? String(value);
  return String(value);
}

/**
 * Подпись варианта `select` в локали владельца; вариант не из словаря — сам ключ.
 *
 * Сырой ключ здесь честнее выдуманного слова: вариант мог быть снят из реестра, а значение
 * на записи остаться (§А10-3), и «пусто» на его месте потеряло бы факт владельца.
 */
export function optionLabel(def: PropertyDefinition, key: unknown): string {
  if (def.type.kind !== 'select') return String(key);
  const option = def.type.options.find((o) => o.key === key);
  return option === undefined ? String(key) : effectiveLabel(option.label, OWNER_LOCALE);
}

/**
 * Значение свойства ТЕКСТОМ по его объявлению — для строк, которые не правятся (флаги
 * §А2-5, `json`, `grant`, список свободного текста).
 *
 * `def === undefined` — свойства нет в снимке (снято, реестр ещё едет): тогда показ идёт
 * по значению (`valueText`), потому что о типе здесь не известно ничего.
 */
export function displayText(def: PropertyDefinition | undefined, value: unknown): string {
  if (value === undefined || value === null) return EMPTY_TEXT;
  if (def === undefined) return valueText(value);
  if (def.type.kind === 'boolean') return value === true ? 'да' : 'нет';
  if (def.type.kind === 'select') {
    if (Array.isArray(value))
      return value.length === 0 ? EMPTY_TEXT : value.map((v) => optionLabel(def, v)).join(', ');
    return optionLabel(def, value);
  }
  return valueText(value);
}
