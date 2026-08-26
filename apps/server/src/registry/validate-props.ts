// apps/server/src/registry/validate-props.ts
// Валидация записи по реестру свойств — решение §А7-1: композиционная проверка над
// результатом слияния. Каждое свойство — по СВОЕМУ типу (ajv по сгенерированной схеме),
// каждый аспект сущности — обязательные присутствуют, неизвестных id в `props` нет.
//
// Почему это отдельный файл, а не часть `executor/aspects-validate.ts`: тот — тонкая
// обёртка стадии 2 конвейера (список нарушений → ExecError), и у неё другая работа.
// «Старым валидатором» golden-корпуса приёмки §С8-1 остаются zod-схемы `ASPECT_SCHEMAS`
// (`schemas/aspects.ts`); путь записи перешёл сюда Задачей 4b.
//
// Конфигурация ajv — та же, что у старого пути (strict: true + ajv-formats), плюс два
// собственных keyword'а без валидации: в strict-режиме незнакомый ключ схемы БРОСАЕТ при
// компиляции, а `x-orbis-type` (копия типа, ref Р1) и `x-orbis-decimal` (границы decimal)
// в схеме есть у каждого свойства.
import {
  type AspectDefinition,
  type DecimalBounds,
  type PropertyDefinition,
  propertyValueJsonSchema,
  X_ORBIS_DECIMAL,
  X_ORBIS_TYPE,
} from '@orbis/shared';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { decCmp } from '../budget/decimal';

const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addKeyword({ keyword: X_ORBIS_TYPE });
ajv.addKeyword({ keyword: X_ORBIS_DECIMAL });

export interface PropsRegistry {
  properties: Map<string, PropertyDefinition>;
  aspects: Map<string, AspectDefinition>;
}

export type PropsViolation =
  | { code: 'UNKNOWN_PROPERTY'; propertyId: string }
  | { code: 'TYPE'; propertyId: string; message: string }
  | { code: 'REQUIRED'; aspectId: string; propertyId: string }
  | { code: 'UNKNOWN_ASPECT'; aspectId: string }
  | { code: 'DEPRECATED'; propertyId: string };

// Кэш скомпилированных валидаторов ПО ТЕКСТУ СХЕМЫ (§А7-1: «кеш по тексту схемы
// сохраняется»; приём перенесён из `executor/aspects-validate.ts:46-67`). Ключ там —
// (id, owner) с текстом схемы в значении, здесь — сам текст: схема значения есть чистая
// функция от типа свойства, поэтому одинаковые типы (а их в словаре много: девять голых
// `text`, четыре `timestamp`) делят один валидатор, и инвалидации не требуется вовсе.
// Рост ограничен числом РАЗЛИЧНЫХ типов реестра — как и у старого кеша числом аспектов.
const validatorCache = new Map<string, ValidateFunction>();

function getValidator(schema: Record<string, unknown>): ValidateFunction {
  const schemaJson = JSON.stringify(schema);
  const cached = validatorCache.get(schemaJson);
  if (cached !== undefined) return cached;
  const validate = ajv.compile(schema);
  validatorCache.set(schemaJson, validate);
  return validate;
}

/**
 * Границы decimal лежат в аннотации схемы, а не читаются из типа заново: аннотация — это
 * контракт, который уезжает потребителям вместе со схемой (тулы, web-контролы, экспорт), и
 * проверять по ней же — единственный способ не завести второе мнение о границах.
 */
function decimalBounds(schema: Record<string, unknown>): DecimalBounds | undefined {
  const own = schema[X_ORBIS_DECIMAL] as DecimalBounds | undefined;
  if (own !== undefined) return own;
  const items = schema.items as Record<string, unknown> | undefined;
  return items?.[X_ORBIS_DECIMAL] as DecimalBounds | undefined;
}

/**
 * Числовые границы decimal — `decCmp`, а НЕ ajv (§А7-3, В8): значение хранится строкой, и
 * «10.0» обязано равняться «10.00». Форму строки к этому моменту уже проверил паттерн, так
 * что `parseDec` внутри `decCmp` не бросит.
 */
function decimalViolation(bounds: DecimalBounds, value: unknown): string | undefined {
  const values = Array.isArray(value) ? value : [value];
  for (const item of values) {
    if (typeof item !== 'string') continue;
    if (bounds.min !== undefined && decCmp(item, bounds.min) < 0) {
      return `значение «${item}» меньше минимума ${bounds.min}`;
    }
    if (bounds.max !== undefined && decCmp(item, bounds.max) > 0) {
      return `значение «${item}» больше максимума ${bounds.max}`;
    }
    if (bounds.exclusiveMin !== undefined && decCmp(item, bounds.exclusiveMin) <= 0) {
      return `значение «${item}» не больше ${bounds.exclusiveMin}`;
    }
  }
  return undefined;
}

/**
 * Нарушения записи сущности — списком, а не первым найденным: владелец правит форму целиком,
 * и отказ по одному полю за раз превращает одну правку в пять заходов.
 *
 * Чего здесь НЕТ намеренно: прав записи (`model_writable`/`system_writable`). Гейт §А2-5
 * определён против ИСТОЧНИКА мутации, а не против значения, и источник валидатору значений
 * неизвестен — его место в исполнителе (Задача 4b), иначе право оказалось бы в двух домах.
 */
export function validateEntityProps(
  reg: PropsRegistry,
  entity: { props: Record<string, unknown>; aspects: string[] },
): PropsViolation[] {
  const violations: PropsViolation[] = [];

  for (const [propertyId, value] of Object.entries(entity.props)) {
    const def = reg.properties.get(propertyId);
    if (def === undefined) {
      violations.push({ code: 'UNKNOWN_PROPERTY', propertyId });
      continue;
    }
    if (def.status === 'deprecated') {
      // §А10-3: строка реестра не удаляется никогда — старые значения ЧИТАЮТСЯ, запись
      // нового отвергается. Тип при этом не проверяется: причина отказа не в нём.
      violations.push({ code: 'DEPRECATED', propertyId });
      continue;
    }
    const schema = propertyValueJsonSchema(def.type);
    const validate = getValidator(schema);
    if (!validate(value)) {
      // `validate.errors` — состояние функции ajv, общей для всех свойств этого типа;
      // читается сразу же, до любого следующего вызова.
      violations.push({
        code: 'TYPE',
        propertyId,
        message: ajv.errorsText(validate.errors, { dataVar: propertyId }),
      });
      continue;
    }
    const bounds = decimalBounds(schema);
    if (bounds !== undefined) {
      const message = decimalViolation(bounds, value);
      if (message !== undefined) violations.push({ code: 'TYPE', propertyId, message });
    }
  }

  for (const aspectId of entity.aspects) {
    const aspect = reg.aspects.get(aspectId);
    if (aspect === undefined) {
      violations.push({ code: 'UNKNOWN_ASPECT', aspectId });
      continue;
    }
    for (const ref of aspect.properties) {
      // Аспект добавляет к свойству ровно обязательность и порядок (Р5); слитое свойство
      // одним значением закрывает требование обоих носителей (В1).
      if (ref.required && entity.props[ref.propertyId] === undefined) {
        violations.push({ code: 'REQUIRED', aspectId, propertyId: ref.propertyId });
      }
    }
  }

  return violations;
}
