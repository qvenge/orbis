// apps/web/src/lib/registry/controls.ts
//
// Какой КОНТРОЛ и в каком РЕЖИМЕ показать свойству — решается объявлением реестра (§А2-2,
// §А2-5), а не именем поля и не типом значения, которое в нём сегодня лежит.
//
// Что здесь заменено. До реформы форма записи строилась по ЗАПОЛНЕННЫМ значениям: цикл шёл
// по карте `aspects[аспект][поле]`, инпут получало всё, что оказалось скаляром, а остальное
// печаталось текстом. У такой формы три наблюдаемых порока, и все три чинит именно этот
// файл: незаполненного поля на экране не было вовсе (у задачи без срока «Срок» не
// показывался, то есть поставить его было нечем), тип восстанавливался из старого значения
// (`coerce`: пустое поле не знало о себе ничего, а `true` приходило словом), и права на
// запись не спрашивались ни у кого — инпут предлагался и полю, которое пишет только сервер.
//
// Модуль ЧИСТЫЙ: ни React, ни разбора схем. Проверки значения по границам типа (`min`,
// `pattern`, `maxItems`) здесь НЕТ и быть не должно — её делает валидатор записи на сервере
// (Задача 2), а вторая реализация на клиенте означала бы два разных ответа на вопрос
// «допустимо ли это значение». Клиент отвечает только на вопрос «чем это набирают».
import type { PropertyDefinition } from '@orbis/shared';

/**
 * Тихий инпут-в-строке-свойства: один вид у всех контролов формы записи и у строки правки
 * предложения (Ш1.3) — иначе владелец читал бы их как разные вещи. Прежний дом константы —
 * `features/entity-detail/AspectCards.tsx`; переехала сюда вместе с самими контролами.
 */
export const FIELD_CLASS =
  'w-full rounded-md bg-transparent px-2 py-1 text-sm text-text outline-none transition hover:bg-surface-2 focus-visible:bg-surface-2/70 focus-visible:ring-2 focus-visible:ring-accent/40';

/**
 * Род контрола. Это НЕ копия словаря типов (§А2-2): типов двенадцать, а контролов меньше —
 * `json`, `grant` и `registry_ref` набирать нечем, и все трое сходятся в `readonly`, а
 * `select` расходится надвое по `cardinality`.
 */
export type ControlKind =
  | 'text'
  | 'number'
  | 'decimal'
  | 'boolean'
  | 'date'
  | 'timestamp'
  | 'time'
  | 'select'
  | 'select-many'
  | 'ref'
  | 'readonly';

/**
 * Контрол по объявлению свойства.
 *
 * `many` разбирается ровно для `select`: у вариантов из закрытого словаря список набирается
 * чипами без единой двусмысленности. Список СВОБОДНОГО текста (`orbis/aliases`,
 * `orbis/allowed_tools`) остаётся `readonly`, и это не пробел: однострочной формы у него нет
 * — разделитель пришлось бы выбрать, а алиас с запятой внутри такой контрол молча разрезал
 * бы надвое. Показывается он перечислением (`displayText`), правится тулом и импортом.
 *
 * `json`, `grant`, `registry_ref` — `readonly` по той же причине, по какой ими не правят с
 * клавиатуры: у `json` форма значения описана схемой, у `grant` — это id живого доступа
 * (его ставит карточка назначения, где есть список), у `registry_ref` — адрес строки
 * реестра.
 */
export function controlKindOf(def: PropertyDefinition): ControlKind {
  const type = def.type;
  switch (type.kind) {
    case 'select':
      return type.cardinality === 'many' ? 'select-many' : 'select';
    case 'text':
    case 'number':
    case 'decimal':
      return type.cardinality === 'many' ? 'readonly' : type.kind;
    case 'boolean':
    case 'date':
    case 'timestamp':
    case 'time':
    case 'ref':
      return type.kind;
    default:
      return 'readonly';
  }
}

/**
 * Режим строки: правится, пишет только сервер, либо это кэш вычисления.
 *
 * Флага ДВА, и в один они не сводятся, хотя оба запрещают правку из UI (`writableFromTool`,
 * §А2-5). `system_writable` — «значение приходит извне»: его пишет импорт, правило или
 * глагол исполнителя, и владельцу тут сказать нечего вовсе. `model_writable: false` — «это
 * посчитано»: у значения есть ПРАВИЛО, по которому оно получилось, и строка обязана сказать
 * об этом словом — иначе владелец, увидев расхождение с ожиданием, полезет искать, где это
 * поле «не сохранилось».
 *
 * Порядок веток значим: свойство с обоими флагами — системное (правило считает его, а пишет
 * всё равно сервер); ни одного боевого такого сегодня нет, но ответ обязан быть один.
 */
export type WriteMode = 'editable' | 'system' | 'computed';

export function writeModeOf(def: PropertyDefinition): WriteMode {
  if (def.flags.system_writable === true) return 'system';
  if (def.flags.model_writable === false) return 'computed';
  return 'editable';
}

/** Пометка строки-кэша. Слово ПРО МЕХАНИЗМ, а не про запись реестра (см. `format.ts`). */
export const COMPUTED_NOTE = 'вычисляется';

/**
 * Что набрали в контроле: значение, снятие или нечитаемое.
 *
 * Три исхода, а не «значение | undefined», ровно из-за третьего. `undefined` уже занят
 * снятием, и вернуть его на опечатке значило бы СТЕРЕТЬ поле у того, кто промахнулся по
 * клавише, — самая дорогая ошибка формы из возможных.
 */
export type ControlParse =
  | { kind: 'value'; value: unknown }
  | { kind: 'unset' }
  | { kind: 'invalid' };

/**
 * Строка из контрола → что с ней делать.
 *
 * Пустая строка не «записывается пусто» и не превращается в `null`: `null` — законное
 * значение json-свойства (докблок `entityPropsPatch`), и подменять им «значения нет»
 * значило бы навсегда запретить его записывать. Поэтому пусто из контрола = снятие, и оно
 * же — единственный способ убрать значение с записи из формы.
 *
 * Число разбирается ТОЛЬКО если разобралось: `Number('')` даёт ноль, а `Number('12ф')` —
 * NaN, и оба молча уехали бы на сервер числом (прежний `coerce` так и делал).
 *
 * Decimal остаётся СТРОКОЙ на всём пути (Global Constraints: деньги не проходят через
 * float); запятая приводится к точке — так набирают с русской раскладки. Нормализация до
 * двух знаков живёт в Финансах (`features/budget/moneyInput.ts`) и здесь не повторяется:
 * два знака — правило денег, а не всех decimal-свойств (`orbis/target_value` меряет книги).
 */
export function parseControlValue(def: PropertyDefinition, raw: string): ControlParse {
  const trimmed = raw.trim();
  if (trimmed === '') return { kind: 'unset' };
  switch (def.type.kind) {
    case 'number': {
      const n = Number(trimmed);
      return Number.isFinite(n) ? { kind: 'value', value: n } : { kind: 'invalid' };
    }
    case 'decimal': {
      const text = trimmed.replace(',', '.');
      return /^[-+]?\d+(\.\d+)?$/.test(text) ? { kind: 'value', value: text } : { kind: 'invalid' };
    }
    default:
      return { kind: 'value', value: trimmed };
  }
}

/**
 * Значение свойства → строка для инпута. `undefined`/`null` дают пустую строку — то есть
 * ровно то, что `parseControlValue` прочитает обратно как «снять».
 */
export function controlText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? '';
}
