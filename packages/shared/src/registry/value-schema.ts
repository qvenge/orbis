/**
 * JSON Schema ЗНАЧЕНИЯ одного свойства по его типу — §А7-1 («каждое свойство проверяется по
 * своему типу, ajv по сгенерированной схеме»).
 *
 * Единица здесь — свойство, а не аспект: аспект перестал владеть полями (Р5), и схема
 * аспекта в новой форме — производная-склейка (§А3-1), собираемая из этих кусков. Потому
 * генератор ничего не знает ни про обязательность (её добавляет аспект), ни про
 * `additionalProperties` (неизвестные ключи ловит валидатор записи, а не схема поля).
 *
 * Что в схему НЕ уезжает и почему:
 *  - границы `decimal` — они СТРОКИ, а числовые ключевые слова JSON Schema к строке не
 *    применяются; сравнивать их текстом нельзя («10.0» = «10.00», §А7-3). Границы едут
 *    аннотацией `x-orbis-decimal`, и проверяет их `validate-props` через `decCmp`. Паттерн
 *    при этом остаётся В КЛАССЕ RE2 — ровно ради этого В8 и завела `exclusiveMin` вместо
 *    lookahead'а (`(?!0+(\.0+)?$)` старой схемы — причина `strict:false` в D29).
 *  - `default` булева — умолчание есть семантика ЧТЕНИЯ, а не записи (РП-9): попав в схему
 *    тула, оно превратилось бы в подсказку модели «пиши false», и `has(orbis/planned)` стал
 *    бы истинным у каждой транзакции.
 *
 * `x-orbis-type` — копия типа свойства (ref Р1): по нему UI выбирает контрол, а сервер —
 * границы decimal. В ajv оно регистрируется как keyword без валидации, иначе `strict: true`
 * отвергает схему целиком.
 */
import { HHMM_RE } from '../date';
import { assertPatternRegular } from './property-type';
import type { PropertyType, TextFormat } from './types';

/** Аннотация «копия типа свойства» (ref Р1). Имя одно на shared и сервер — не литерал на месте. */
export const X_ORBIS_TYPE = 'x-orbis-type';
/** Аннотация границ decimal: их проверяет `decCmp`, а не ajv (см. шапку). */
export const X_ORBIS_DECIMAL = 'x-orbis-decimal';

/** Границы decimal в аннотации — те же строки, что в конфиге типа (§А2-2). */
export interface DecimalBounds {
  min?: string;
  max?: string;
  exclusiveMin?: string;
}

/** ISO-дата `YYYY-MM-DD` — тот же текст, что у `dateString` старых схем (`aspects.ts:9`). */
const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';
/** ISO 8601 с зоной — тот же текст, что у `timestampString` (`aspects.ts:10-12`). */
const TIMESTAMP_PATTERN =
  '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$';
/** decimal-строка base-10 без экспоненты; знак разрешён, границу ставит `x-orbis-decimal`. */
const DECIMAL_PATTERN = '^-?\\d+(\\.\\d+)?$';

/**
 * Форматы текста (§А2-2). `url` и `email` отданы ajv-formats: разбор адреса регэкспом — свой
 * класс дефектов, и он уже написан не нами. Остальные три — паттерны, потому что они и есть
 * паттерны: `#hex`, три заглавные буквы валюты, форма имени зоны IANA.
 *
 * `iana-tz` проверяет ФОРМУ имени, а не его существование: база зон в JSON Schema не живёт,
 * а живая сверка (`Intl`) не экспортируема в реестр и не работает в паспорте P. Ловится
 * ровно то, ради чего ужесточение и вводилось (§А8): «Мск», «MSK+3», голое «Moscow».
 */
const TEXT_FORMATS_SCHEMA: Record<TextFormat, { format?: string; pattern?: string }> = {
  url: { format: 'uri' },
  email: { format: 'email' },
  'iana-tz': { pattern: '^(UTC|[A-Za-z][A-Za-z0-9_+-]*(\\/[A-Za-z0-9_+-]+)+)$' },
  color: { pattern: '^#[0-9a-fA-F]{6}$' },
  currency: { pattern: '^[A-Z]{3}$' },
};

function textSchema(type: Extract<PropertyType, { kind: 'text' }>): Record<string, unknown> {
  const schema: Record<string, unknown> = { type: 'string' };
  const patterns: string[] = [];
  if (type.pattern !== undefined) patterns.push(type.pattern);
  if (type.format !== undefined) {
    const rule = TEXT_FORMATS_SCHEMA[type.format];
    if (rule.format !== undefined) schema.format = rule.format;
    if (rule.pattern !== undefined) patterns.push(rule.pattern);
  }
  for (const pattern of patterns) assertPatternRegular(pattern);
  // Двух ключей `pattern` в одной схеме не бывает: свой паттерн И паттерн формата
  // складываются в `allOf`, иначе один молча затёр бы другой.
  if (patterns.length === 1) schema.pattern = patterns[0];
  else if (patterns.length > 1) schema.allOf = patterns.map((pattern) => ({ pattern }));
  if (type.minLength !== undefined) schema.minLength = type.minLength;
  if (type.maxLength !== undefined) schema.maxLength = type.maxLength;
  return schema;
}

/** Схема ОДНОГО значения — без обёртки списка (её ставит `propertyValueJsonSchema`). */
function elementSchema(type: PropertyType): Record<string, unknown> {
  switch (type.kind) {
    case 'text':
      return textSchema(type);
    case 'number': {
      const schema: Record<string, unknown> = {
        type: type.integer === true ? 'integer' : 'number',
      };
      if (type.min !== undefined) schema.minimum = type.min;
      if (type.max !== undefined) schema.maximum = type.max;
      return schema;
    }
    case 'decimal': {
      const schema: Record<string, unknown> = { type: 'string', pattern: DECIMAL_PATTERN };
      const bounds: DecimalBounds = {};
      if (type.min !== undefined) bounds.min = type.min;
      if (type.max !== undefined) bounds.max = type.max;
      if (type.exclusiveMin !== undefined) bounds.exclusiveMin = type.exclusiveMin;
      if (Object.keys(bounds).length > 0) schema[X_ORBIS_DECIMAL] = bounds;
      return schema;
    }
    case 'boolean':
      return { type: 'boolean' };
    case 'date':
      return { type: 'string', pattern: DATE_PATTERN };
    case 'timestamp':
      return { type: 'string', pattern: TIMESTAMP_PATTERN };
    case 'time':
      // Один алфавит времени на систему: планировщик рутин уже считает по HHMM_RE, второго
      // «ЧЧ:ММ» быть не должно (`date.ts:112-117`).
      return { type: 'string', pattern: HHMM_RE.source };
    case 'select':
      // В данных лежит key варианта (Р3); порядок enum — порядок rank объявления, по нему
      // сортируются смарт-листы.
      return { type: 'string', enum: type.options.map((option) => option.key) };
    case 'ref':
      // Значение — id сущности. Что она существует и попадает в `target`, проверяет сервер
      // запросом (§А6-1): множество цели — Q-AST, в JSON Schema его не выразить.
      return { type: 'string', format: 'uuid' };
    case 'grant':
      // Ссылка в `agent_grants` (§А6-4). Существование проверяет инвариант исполнителя, но
      // ФОРМА остаётся uuid: без неё «не-uuid» доехал бы до SQL и упал приведением типа
      // вместо честного VALIDATION.
      return { type: 'string', format: 'uuid' };
    case 'registry_ref':
      // Цель — строка id записи реестра (`orbis/money-movement`), не uuid: у встроенных
      // записей id читаемый (§А2-1). Существование проверяет сервер по реестру под RLS.
      return { type: 'string' };
    case 'json':
      return type.schema === undefined ? { type: 'object' } : { ...type.schema };
  }
}

/**
 * JSON Schema значения ОДНОГО свойства по его типу; `x-orbis-type` — копия типа (ref Р1).
 *
 * Признак списка у скаляров — `cardinality: 'many'` (§А2-2), у `json` — наличие `maxItems`
 * (см. правило в докблоке ветки `json` словаря, `types.ts`): у kind `json` конфига
 * `cardinality` в словаре нет, и второго признака заводить не стали.
 */
export function propertyValueJsonSchema(type: PropertyType): Record<string, unknown> {
  const element = elementSchema(type);
  let schema: Record<string, unknown>;
  if (type.kind === 'json') {
    schema =
      type.maxItems === undefined
        ? element
        : { type: 'array', items: element, maxItems: type.maxItems };
  } else if (type.kind === 'ref') {
    schema =
      type.cardinality === 'many'
        ? {
            type: 'array',
            items: element,
            // У `ref` кап называется `max` (§А6-1), у скаляров — `maxItems`; в схему оба
            // едут одним ключом JSON Schema.
            ...(type.max === undefined ? {} : { maxItems: type.max }),
          }
        : element;
  } else if ('cardinality' in type && type.cardinality === 'many') {
    schema = {
      type: 'array',
      items: element,
      ...(type.minItems === undefined ? {} : { minItems: type.minItems }),
      ...(type.maxItems === undefined ? {} : { maxItems: type.maxItems }),
    };
  } else {
    schema = element;
  }
  return { ...schema, [X_ORBIS_TYPE]: type };
}
