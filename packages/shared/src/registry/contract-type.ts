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
// Из `../expr/ast`, а не из барреля `../expr`: баррель тянет `check.ts`, который типы
// контракта импортирует обратно, и цикл модулей на старте пакета не нужен.
import { type ExprNode, exprNodeSchema } from '../expr/ast';
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
 * Набор — ЛИБО список классов, ЛИБО E-предикат по слотам контракта (§Б1-1). Списком
 * выражается «эти классы»; предикатом — то, что классами не выражается вовсе: `facts` у
 * money-movement отбирает по значениям слотов и по классу ЧУЖОГО контракта.
 */
export const contractSetSchema = z.union([
  z.array(z.string().regex(SLOT_KEY_RE, 'имя класса')).min(1),
  exprNodeSchema,
]);

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
  // `Object.hasOwn`, а не индексация: имя набора приезжает из ТЕКСТА запроса
  // (`class=orbis/completable:constructor`), и цепочка прототипа объявила бы предикатом
  // `constructor`, `toString` и прочие имена, которых в декларации нет.
  const value = def.sets !== null && Object.hasOwn(def.sets, set) ? def.sets[set] : undefined;
  if (value === undefined) return 'unknown';
  return Array.isArray(value) ? 'list' : 'predicate';
}

/**
 * Тот же вердикт по одному ЗНАЧЕНИЮ набора — без пары (определение, имя). Нужен там, где
 * значение уже на руках: дифф Ш1 помечает предикат-набор отдельной строкой (§Б1-1), а
 * читатель подписки задачи 9 отличает `plans` от `outflow`, имея `def.sets?.[name]`.
 * Разбор СТРУКТУРНЫЙ, а не `exprNodeSchema.safeParse`: сузить тип обязан и невалидный
 * объект — иначе сломанный предикат молча уехал бы в ветку списочных наборов.
 */
export function isPredicateSet(v: unknown): v is ExprNode {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
