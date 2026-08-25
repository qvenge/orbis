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
      // target — статическое подмножество Q-AST (§А6-1: без date-токенов, `search=`, `this`,
      // проекции). Пока `unknown`: канон Q-AST и его схему заводит Задача 8, она же сужает
      // это поле и подключает отказ SCOPE_NOT_STATIC. Раньше сужать нечем — типа ещё нет.
      target: z.unknown(),
      cardinality: z.enum(['one', 'many']).optional(),
      max: z.number().int().min(1).optional(),
    })
    .strict(),
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
