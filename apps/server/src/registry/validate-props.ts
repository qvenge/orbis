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
//
// `allowUnionTypes` — снят ровно один запрет strict-режима, и снят он про СХЕМУ, а не про
// данные: `strictTypes` запрещает форму `type: ['string','number','boolean']`, которой
// канон Q-AST описывает литерал предиката (`query/ast-json-schema.ts`, `SCALAR`). С Задачи
// 10b канон подставлен в схему свойства `orbis/progress_source`, и без этой опции ajv
// БРОСАЕТ на компиляции — то есть цель нельзя было бы ни записать, ни отвергнуть. Строгость
// проверки значений при этом не меняется: union по-прежнему валидируется как union.
import {
  type AspectDefinition,
  type DecimalBounds,
  hasValidCalendar,
  type PropertyDefinition,
  type PropertyType,
  propertyLiteralJsonSchema,
  propertyValueJsonSchema,
  X_ORBIS_DECIMAL,
  X_ORBIS_TYPE,
} from '@orbis/shared';
import { QUERY_TREE_DEPTH_CAP, queryTreeExceedsDepth } from '@orbis/shared/query';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { decCmp } from '../budget/decimal';

const ajv = new Ajv({ strict: true, allowUnionTypes: true, allErrors: true });
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
  | { code: 'DEPRECATED'; propertyId: string }
  | { code: 'VALUE_TOO_DEEP'; propertyId: string; cap: number };

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
 * Форма ОДНОГО ЛИТЕРАЛА по типу свойства: `undefined` — годится, строка — человеческий
 * текст нарушения.
 *
 * Живёт здесь, а не в компиляторе запросов, по одной причине: ajv в проекте настроен
 * ровно один раз (strict + ajv-formats + два собственных keyword'а), и кеш скомпилированных
 * валидаторов ключуется текстом схемы. Второй инстанс ajv рядом означал бы второй набор
 * правил strict-режима — то есть схема, годная для записи, могла бы не скомпилироваться для
 * сравнения.
 *
 * Потребитель — `query/compile-ast.ts` (гейт значения предиката): вход `ast:` тула §А5-4
 * идёт мимо парсера, и без этой проверки литерал не той формы доезжал бы до Postgres.
 */
export function literalFormViolation(type: PropertyType, value: unknown): string | undefined {
  const validate = getValidator(propertyLiteralJsonSchema(type));
  if (validate(value)) return undefined;
  // `validate.errors` — состояние функции ajv; читается сразу же, до следующего вызова.
  return ajv.errorsText(validate.errors, { dataVar: 'значение' });
}

/**
 * СУЩЕСТВУЕТ ЛИ календарный день у date/timestamp-значения. `undefined` — годится.
 *
 * Стоит рядом с `decimalViolation` и по той же причине, по которой рядом стоит тот: JSON
 * Schema выражает ФОРМУ, а то, чего она выразить не может, проверяет спутник. Календарь она
 * выразить не может вовсе — `2026-02-30` проходит паттерн `^\d{4}-\d{2}-\d{2}$` схемы
 * значения (`value-schema.ts`), и ajv тут бессилен не по недосмотру, а по устройству.
 *
 * ПОЧЕМУ ЭТО ВАЖНЕЕ, ЧЕМ ВЫГЛЯДИТ. Без проверки значение записывается МОЛЧА, а падает
 * позже и в другом месте: на первом же `::date` в запросе по этому свойству Postgres
 * отвечает 22008, и смарт-лист владельца становится красным целиком. Дефект ЗАПИСИ,
 * проявляющийся как поломка ЧТЕНИЯ, — класс, который труднее всего связать с причиной.
 * Хуже того, `assertEntityProps` валидирует ВСЁ состояние после слияния, поэтому однажды
 * записанное плохое значение стало бы замком на записи всей сущности.
 *
 * Календарь считает `date.ts` (`hasValidCalendar` поверх `lastDayOfMonth`) — дом
 * календарной арифметики монорепо. Своей копии здесь нет и быть не должно: она разошлась бы
 * с разбором запроса и компилятором ровно на високосном феврале.
 *
 * Гейт по виду свойства ОБЯЗАТЕЛЕН и стоит первой строкой: у `orbis/run_bucket` тип `text`,
 * а паттерн несёт дату внутри — без гейта проверка отвергала бы и его (рулинг Р-9b-5:
 * не трогаем, в SQL он не кастуется и чтения не роняет).
 */
function calendarViolation(type: PropertyType, value: unknown): string | undefined {
  if (type.kind !== 'date' && type.kind !== 'timestamp') return undefined;
  // Список дат во встроенном словаре не встречается, но `cardinality: many` разрешён у
  // обоих типов (§А2-2), и проверять только скаляр значило бы оставить дыру своей формы.
  const values = Array.isArray(value) ? value : [value];
  for (const item of values) {
    if (typeof item !== 'string') continue;
    if (!hasValidCalendar(item)) return `значения «${item}» нет в календаре`;
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
    /**
     * ВХОД-ДЕРЕВА 3. ГЛУБИНА ЗНАЧЕНИЯ — ПЕРВОЙ, до всякого рекурсивного читателя. Порядок здесь и есть
     * суть проверки, а не стиль.
     *
     * ЗАМЕР (проба ре-ревью, воспроизведена на `orbis/progress_source`): цепочка `not`
     * глубиной 10 000 уровней (80 КБ — `JSON.parse` её переваривает) ПРОХОДИТ ajv записи и
     * ложится в jsonb, а zod чтения (`goals/progress.ts`, `progressQuerySchema` → та же
     * рекурсия `z.lazy`) падает на ней `RangeError: Maximum call stack size exceeded`.
     * `safeParse` от этого не спасает — он ловит `ZodError`, а не переполнение стека, — и
     * `entity.get` такой цели отдаёт 500 НАВСЕГДА: чинить нечем, кроме правки jsonb руками.
     * На 20 000 уровней бросает уже сам ajv, то есть без этой проверки рекурсивен и
     * валидатор записи.
     *
     * Доступно это МОДЕЛИ: у `orbis/progress_source` нет `flags`, а отказ записи даёт
     * только `model_writable === false` (`executor/props.ts`), — значит свойство пишется
     * обычным `entity_create`/`entity_update`/`attach_orbis_goal` (рулинг Р-13c-2).
     *
     * Проверка ОБЩАЯ на все свойства, а не список из одного: «значение с Q-AST внутри»
     * реестр отдельным признаком не помечает, и перечисление таких свойств в коде
     * разъехалось бы с реестром при первом же новом. Кап тот же, что у дерева запроса
     * (`QUERY_TREE_DEPTH_CAP`), и второй константы не заводится: самое глубокое законное
     * значение словаря — это и есть Q-AST, у всего остального вложенность единицы уровней.
     *
     * МЕРЯЕТСЯ ЗНАЧЕНИЕ ЦЕЛИКОМ, вместе с конвертом (`{query, aggregate}`), а не дерево
     * внутри него: в jsonb ложится и на каждом чтении разворачивается именно значение, и
     * число в отказе обязано быть тем, которое считает код.
     *
     * ЦЕНА — РОВНО ОДИН УРОВЕНЬ, и это ЗАМЕР, а не вывод из формы конверта: у тула
     * (`assertQueryTreeDepth` меряет сам `ast`, то есть `{filter: …}`) при капе 64 проходит
     * цепочка из 62 узлов `not`, внутри свойства — из 61. Конверт значения на уровень
     * глубже конверта `ast`, поэтому разница одна, а не две: гейт тула СВОЙ конверт тоже
     * считает. Число названо точно, потому что по нему считают бюджет глубины следующему
     * свойству с Q-AST внутри.
     */
    if (queryTreeExceedsDepth(value, QUERY_TREE_DEPTH_CAP)) {
      violations.push({ code: 'VALUE_TOO_DEEP', propertyId, cap: QUERY_TREE_DEPTH_CAP });
      continue;
    }
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
    // Форма прошла — теперь то, чего форма не выражает: календарь и границы decimal.
    const calendar = calendarViolation(def.type, value);
    if (calendar !== undefined) {
      violations.push({ code: 'TYPE', propertyId, message: calendar });
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
