/**
 * Словарь типов свойств — решение §А2-2 спеки «Реформа свойств» (принят владельцем 25.08, В8).
 *
 * Словарь ЗАКРЫТ: 10 базовых kind + `time` и `registry_ref` из добавок. Расширять его дальше
 * можно только по правилу «форма встретилась ≥ 2 раза» (бриф §4-3) — потому союз здесь
 * дискриминированный и каждая ветка `.strict()`: конфиг, придуманный на месте, отвергается
 * разбором, а не проезжает в jsonb молча. Остальные добавки В8 (`cardinality`+`maxItems`,
 * `exclusiveMin`, `pattern`/`format`/`maxLength`, границы) — не kind, а сквозные конфиги,
 * и лежат внутри веток.
 *
 * Почему `decimal` — отдельный kind, а не `number`: деньги хранятся decimal-строкой, и
 * границы у него тоже СТРОКИ. Число IEEE-754 в границе потеряло бы хвост копеек ровно там,
 * где его и сравнивают (§А7-3: `"10.0"` = `"10.00"` — сравнение по типу, не по тексту).
 */
import { z } from 'zod';
import { queryAstSchema } from '../query/ast';

/** Закрытый словарь §А2-2. Порядок — как в таблице решения; на нём стоит приёмка «ровно 12». */
export const PROPERTY_KINDS = [
  'text',
  'number',
  'decimal',
  'boolean',
  'date',
  'timestamp',
  'time',
  'select',
  'ref',
  'json',
  'grant',
  'registry_ref',
] as const;
export type PropertyKind = (typeof PROPERTY_KINDS)[number];

/**
 * Подпись/смысл в локалях владельца: `{ru: …, en: …}` (§А2-1, Р4/В4). Fallback читателя —
 * локаль пользователя → en → любая, поэтому пустой объект запрещён: у текста без единой
 * локали нечего показать вообще.
 */
export type LocalizedText = Record<string, string>;

/** Код локали: `ru`, `en`, `pt-BR`. Ключ-опечатка (`em`) должна падать разбором, а не UI. */
const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;

export const localizedTextSchema: z.ZodType<LocalizedText> = z
  .record(
    z.string().regex(LOCALE_RE, 'код локали'),
    z.string().min(1, 'подпись не может быть пустой'),
  )
  .refine((value) => Object.keys(value).length > 0, 'нужна хотя бы одна локаль');

/**
 * Текст записи реестра в локали читателя: локаль пользователя → en → любая (§А2-1).
 *
 * Дом функции — здесь, рядом с самим типом `LocalizedText`, а не у разбора запросов, где
 * она жила прежде: правило fallback принадлежит ТИПУ, и читателей у него с Задачи 12 три —
 * печать имён (`query/print.ts`), разбор закавыченных подписей (`query/parse-ast.ts`) и
 * описания параметров `attach_*` (`registry/tool-schema.ts`). Вторая копия правила дала бы
 * тулу одну подпись, а парсеру — другую, то есть имя, которое модель прочитала, но не
 * может написать обратно. `query/parse-ast.ts` реэкспортирует её под прежним именем —
 * потребители канона Q-AST импорт не меняли.
 */
export function effectiveLabel(label: LocalizedText, locale: string): string {
  return label[locale] ?? label.en ?? (Object.values(label)[0] as string);
}

/**
 * Форматы текстовых свойств (§А2-2): цвет, url и валюта закрываются конфигом, а не новыми
 * kind. Проверку формата ставит валидатор записи (Задача 2) — здесь объявлен только словарь.
 */
export const TEXT_FORMATS = ['url', 'iana-tz', 'color', 'currency', 'email'] as const;
export type TextFormat = (typeof TEXT_FORMATS)[number];

/** Цели ссылки на запись реестра (§А2-2, В3 инвентаря: `memory.scope` → контракт). */
export const REGISTRY_REF_TARGETS = ['contract', 'aspect', 'property', 'relation_role'] as const;
export type RegistryRefTarget = (typeof REGISTRY_REF_TARGETS)[number];

/**
 * Сквозной конфиг списка скаляров (§А2-2, «cardinality: many + maxItems»): у `many` без
 * верхней границы значение растёт неограниченно и утаскивает за собой строку jsonb.
 */
const listConfig = {
  cardinality: z.enum(['one', 'many']).optional(),
  maxItems: z.number().int().min(1).optional(),
  minItems: z.number().int().min(0).optional(),
};

/**
 * Вариант select. `key` — стабильный ASCII-слаг, он лежит В ДАННЫХ; переименование варианта
 * для человека — смена `label`, не `key` (Р3). `rank` задаёт порядок сортировки смарт-листов.
 */
export const selectOptionSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_-]*$/, 'ASCII-слаг варианта'),
    label: localizedTextSchema,
    rank: z.number().int(),
  })
  .strict();
export type SelectOption = z.infer<typeof selectOptionSchema>;

export const propertyTypeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('text'),
      pattern: z.string().optional(),
      format: z.enum(TEXT_FORMATS).optional(),
      // minLength — РП-8/Р-17: §А8 молча теряет `min(1)` шести полей, где сегодня пустая
      // строка запрещена кодом; граница возвращает запрет в реестр, а не в код валидатора.
      minLength: z.number().int().min(0).optional(),
      maxLength: z.number().int().min(1).optional(),
      ...listConfig,
    })
    .strict(),
  z
    .object({
      kind: z.literal('number'),
      min: z.number().optional(),
      max: z.number().optional(),
      integer: z.boolean().optional(),
      ...listConfig,
    })
    .strict(),
  z
    .object({
      kind: z.literal('decimal'),
      // Границы — decimal-СТРОКИ (см. шапку файла).
      min: z.string().optional(),
      max: z.string().optional(),
      exclusiveMin: z.string().optional(),
      ...listConfig,
    })
    .strict(),
  // `default` — семантика ЧТЕНИЯ, не записи (РП-9): на записи он не материализуется, иначе
  // `has(orbis/planned)` стал бы истинным у каждой транзакции. Применяет его читатель.
  z.object({ kind: z.literal('boolean'), default: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('date') }).strict(),
  z.object({ kind: z.literal('timestamp') }).strict(),
  z.object({ kind: z.literal('time') }).strict(),
  z
    .object({
      kind: z.literal('select'),
      options: z.array(selectOptionSchema).min(1, 'select без вариантов бессмыслен'),
      ...listConfig,
    })
    .strict(),
  z
    .object({
      kind: z.literal('ref'),
      // target — Q-AST цели ссылки (§А6-1), одна или список альтернативных множеств.
      // Форма проверяется схемой канона ЗДЕСЬ, а «статичность» (без date-токенов, `search`,
      // `this` и проекции) — отдельным гейтом `assertStaticQuery` (`query/static.ts`,
      // код SCOPE_NOT_STATIC): статичность зависит не от формы узла, а от его содержимого,
      // и zod-схема, которая её проверяет, дала бы отказ БЕЗ имени причины.
      target: z.union([queryAstSchema, z.array(queryAstSchema)]).optional(),
      cardinality: z.enum(['one', 'many']).optional(),
      max: z.number().int().min(1).optional(),
    })
    .strict(),
  // ПРАВИЛО ветки `json` (наследство гейта Задачи 1, читает его генератор
  // `propertyValueJsonSchema`): `maxItems` — признак того, что значение свойства МАССИВ, и
  // тогда `schema` описывает ЭЛЕМЕНТ, а не всё значение. Без `maxItems` `schema` описывает
  // значение целиком. Второго признака (`cardinality`) у `json` нет намеренно: массив
  // объектов без верхней границы — тот самый неограниченный список внутри строки, который
  // запрещает правило 1 §10, и здесь кап обязателен по построению. Единственный случай
  // v1 — `orbis/run_steps` (`maxItems: 500`), у остальных шести json-свойств значение —
  // объект.
  z
    .object({
      kind: z.literal('json'),
      schema: z.record(z.unknown()).optional(),
      maxItems: z.number().int().min(1).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('grant') }).strict(),
  z.object({ kind: z.literal('registry_ref'), target: z.enum(REGISTRY_REF_TARGETS) }).strict(),
]);
export type PropertyType = z.infer<typeof propertyTypeSchema>;
