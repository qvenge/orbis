/**
 * Схема декларации контракта (§Б1-1). Контракт — API модуля: аспект его РЕАЛИЗУЕТ (`implements`),
 * подписка на него ССЫЛАЕТСЯ, и обе стороны друг о друге не знают (§Б1-3).
 * Две ветки `kind` — это и есть CHECK колонки (`schema.ts:473`), и разведены они схемой, а не
 * необязательными полями: иначе `{kind:'facts', slots:[…]}` разобралось бы молча.
 *
 * ИМПОРТ ОДНОСТОРОННИЙ (Р-К-51): отсюда — в `property-type.ts` и `types.ts`, обратно — никогда.
 * Формы имён (`NAMESPACED_KEY_RE`, `SLOT_KEY_RE`) живут там, потому что вторую читает и привязка
 * аспекта; цикл между двумя файлами схем уронил бы весь пакет на импорте — разбор в докблоке
 * `SLOT_KEY_RE`.
 */
import { z } from 'zod';
import { NAMESPACED_KEY_RE, SLOT_KEY_RE } from './property-type';
import { localizedTextSchema, PROPERTY_KINDS } from './types';

/** key контракта — та же четвёрка §А2-3, что у свойства и аспекта. */
export const CONTRACT_KEY_RE = NAMESPACED_KEY_RE;

// `z.union`, а не `discriminatedUnion`: у первой ветки дискриминатор — enum из двенадцати
// литералов, и разведение по ним читалось бы хуже. `.min(2)`: «любой из одного» — опечатка.
export const contractSlotTypeSchema = z.union([
  z.object({ kind: z.enum(PROPERTY_KINDS) }).strict(),
  z.object({ kind: z.literal('relation_role') }).strict(),
  z.object({ kind: z.literal('any_of'), kinds: z.array(z.enum(PROPERTY_KINDS)).min(2) }).strict(),
]);

export const contractSlotSchema = z
  .object({
    name: z.string().regex(SLOT_KEY_RE, 'имя слота'),
    type: contractSlotTypeSchema,
    required: z.boolean(),
    label: localizedTextSchema,
    /** Слот-СТАТУС: его варианты ложатся на классы контракта через `value_map` (§Б2-2). */
    status: z.boolean().default(false),
  })
  .strict();
export type ContractSlot = z.infer<typeof contractSlotSchema>;

export const contractClassSchema = z
  .object({
    key: z.string().regex(SLOT_KEY_RE, 'имя класса'),
    label: localizedTextSchema,
  })
  .strict();

/**
 * Набор (§Б1-1): список классов ЛИБО тотальный E-предикат по слотам. Вторую ветку добавляет
 * задача 4 вместе с `exprNodeSchema`: порядок «сид (1) → язык E (3) → узел class (4)» задан
 * рамкой §6, и сид не вправе ждать схемы выражений.
 */
export const contractSetSchema = z.array(z.string().regex(SLOT_KEY_RE, 'имя класса')).min(1);

const HEAD = {
  id: z.string().min(1),
  // v1 — только NULL: пользовательские контракты приезжают с view-декларациями (Ч7, v1.5).
  ownerId: z.string().uuid().nullable(),
  key: z.string().regex(CONTRACT_KEY_RE, 'namespaced ASCII-слаг'),
  label: localizedTextSchema,
  description: localizedTextSchema,
  module: z.string().nullable(),
  rank: z.number().int(),
};
export const contractSlotsSchema = z
  .object({
    ...HEAD,
    kind: z.literal('slots'),
    slots: z.array(contractSlotSchema).min(1),
    classes: z.array(contractClassSchema).default([]),
    sets: z.record(z.string().regex(SLOT_KEY_RE, 'имя набора'), contractSetSchema).default({}),
    facts: z.null().default(null),
  })
  .strict();
export const contractFactsSchema = z
  .object({
    ...HEAD,
    kind: z.literal('facts'),
    slots: z.null().default(null),
    classes: z.null().default(null),
    sets: z.null().default(null),
    facts: z.array(contractClassSchema).min(1),
  })
  .strict();
export const contractDefinitionSchema = z.discriminatedUnion('kind', [
  contractSlotsSchema,
  contractFactsSchema,
]);
export type ContractDefinition = z.infer<typeof contractDefinitionSchema>;

/**
 * Род набора — им дифф Ш1 помечает предикат-набор (§Б1-1). До задачи 4 предикатов не бывает, но
 * ветка нужна уже здесь: иначе первый E-набор молча прочитался бы как «неизвестный».
 */
export function contractSetKind(
  def: ContractDefinition,
  set: string,
): 'list' | 'predicate' | 'unknown' {
  const value = def.sets === null ? undefined : def.sets[set];
  if (value === undefined) return 'unknown';
  return Array.isArray(value) ? 'list' : 'predicate';
}
