/**
 * Схемы деклараций реестров реформы: свойство (§А2-1), аспект (§А3-1), роль ребра (§А4-2).
 *
 * Схемы живут в shared, а не на сервере, потому что одну и ту же строку реестра пишет сид,
 * читает компилятор запросов и показывает web: форма обязана быть одна на всех, иначе
 * повторяется история `aspect_definitions`, где «список служебных лежал в трёх копиях»
 * (inv §3). Разбор строгий (`.strict()`): сид пишет строку в jsonb дословно, и молча
 * отброшенное поле уехало бы в базу как отсутствующее.
 */
import { z } from 'zod';
import { queryAstSchema } from '../query/ast';
import { localizedTextSchema, propertyTypeSchema } from './types';

/**
 * Код отказа «паттерн вне класса RE2» (§А2-2, паспорт P). Заведён строковой константой
 * ЗДЕСЬ, а не литералом на месте: единственная таблица кодов отказов реформы собирается
 * Задачей 3 и импортирует эту константу — второго определения того же кода быть не должно.
 */
export const PATTERN_NOT_REGULAR = 'PATTERN_NOT_REGULAR';

export class PatternNotRegularError extends Error {
  readonly code = PATTERN_NOT_REGULAR;
  constructor(
    readonly pattern: string,
    readonly construct: string,
  ) {
    super(`паттерн вне класса RE2: ${construct} в «${pattern}»`);
    this.name = 'PatternNotRegularError';
  }
}

/**
 * Конструкции, которых в RE2 нет. Именно из-за одной такой (`(?!` в «строго положительной
 * decimal-строке», `aspects.ts:27-29`) сгенерированная JSON Schema не компилируется у
 * не-ECMA потребителя, и именно это вынудило `strict:false` в D29. Реформа снимает причину:
 * граница «строго > 0» стала конфигом типа (`exclusiveMin`), а всё, что остаётся паттерном,
 * проходит через этот гейт.
 *
 * Отрицательный просмотр `(?<…` отличается от именованной группы `(?<имя>` последним
 * символом — потому проверяются ровно `(?<=` и `(?<!`, а `(?:` и `(?<имя>` законны.
 */
const IRREGULAR_CONSTRUCTS: readonly (readonly [RegExp, string])[] = [
  [/\(\?=/, '(?='],
  [/\(\?!/, '(?!'],
  [/\(\?<=/, '(?<='],
  [/\(\?<!/, '(?<!'],
  [/\\[1-9]/, 'обратная ссылка \\1…\\9'],
];

/** Отказ `PATTERN_NOT_REGULAR`, если паттерн выходит за класс RE2 (§А2-2). */
export function assertPatternRegular(pattern: string): void {
  for (const [probe, construct] of IRREGULAR_CONSTRUCTS) {
    if (probe.test(pattern)) throw new PatternNotRegularError(pattern, construct);
  }
}

/**
 * key свойства и аспекта — ASCII-слаг в namespace автора (§А2-1/§А2-4). `orbis` и `user`
 * названы в регулярке отдельно, хотя и покрываются общей веткой: это два зарезервированных
 * namespace системы и владельца, и в самой форме их видно.
 */
export const NAMESPACED_KEY_RE = /^(orbis|user|[a-z][a-z0-9-]*)\/[a-z][a-z0-9_-]*$/;

/**
 * key роли ребра. Namespace НЕ обязателен: системные роли v1 — голые слаги (`subitem`,
 * `envelope-binding`, §А4-3), они же лежат в колонке `relations.role`. Пользовательские роли
 * (v1.5, Ч7) приедут с namespace, и форма их уже принимает — расширять регулярку не придётся.
 */
export const RELATION_ROLE_KEY_RE = /^([a-z][a-z0-9-]*\/)?[a-z][a-z0-9_-]*$/;

export const propertyDefinitionSchema = z
  .object({
    id: z.string().min(1),
    ownerId: z.string().uuid().nullable(),
    key: z.string().regex(NAMESPACED_KEY_RE, 'namespaced ASCII-слаг'),
    label: localizedTextSchema,
    // description ОБЯЗАТЕЛЕН (Р4): единственный носитель смысла для AI — он уезжает в
    // description параметра тула и в каталог свойств.
    description: localizedTextSchema,
    type: propertyTypeSchema,
    status: z.enum(['active', 'proposed', 'deprecated']),
    /** §А1-3: `core` — хранение осталось колонкой, реестр даёт единый адрес Q-AST и CAS. */
    storage: z.enum(['props', 'core']).default('props'),
    // Статический Q-AST (Р15): свойство-«колонка» показывается пустым на подходящих
    // сущностях. Форма — канон §А5-7; «статичность» проверяет `assertStaticQuery`
    // (см. докблок `ref.target`). v1 наполняет его только формами `aspect=`/`tags=` (№24).
    scope: queryAstSchema.nullable().default(null),
    mergedInto: z.string().nullable().default(null),
    module: z.string().nullable().default(null),
    rank: z.number().int(),
    flags: z
      .object({
        model_writable: z.boolean().optional(),
        system_writable: z.boolean().optional(),
        computed: z.object({ rule: z.string() }).strict().optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type PropertyDefinition = z.infer<typeof propertyDefinitionSchema>;

/**
 * Вправе ли ТУЛ (он же UI, он же MCP) записать это свойство — §А2-5/Б6.
 *
 * Два флага, один ответ: `system_writable: true` пишет только сервер по перечню источников
 * §А4-4 (`import`, `rule`, `verb`, …), `model_writable: false` — кэш вычисления, его пишет
 * правило каталога либо материализация. У обоих механизм тула (`user`) в перечень не входит,
 * и отказ гарантирован ещё до записи (`COMPUTED_WRITE`).
 *
 * Функция ОТВЕЧАЕТ НА ВОПРОС ПОВЕРХНОСТИ, а не прав: гейт прав определён против ИСТОЧНИКА
 * мутации и живёт в исполнителе (`executor/props.ts`, `writeDenial`) — здесь механизм
 * известен заранее и всегда один. Дом в shared, потому что первый потребитель — генератор
 * схемы `attach_*` (§А9-1), а он общий. Согласие двух представлений закреплено тестом
 * `props.test.ts` («поверхность и гейт прав отвечают одно»): разъедься они — и `attach_*`
 * снова начал бы обещать модели запрещённое.
 */
export function writableFromTool(def: PropertyDefinition): boolean {
  return def.flags.system_writable !== true && def.flags.model_writable !== false;
}

/**
 * Ссылка аспекта на свойство (§А3-1, Р5): аспект — интерпретация, а не владелец поля, и
 * добавляет к свойству ровно две вещи — обязательность и место в порядке.
 */
export const aspectPropertyRefSchema = z
  .object({ propertyId: z.string(), required: z.boolean(), rank: z.number().int() })
  .strict();
export type AspectPropertyRef = z.infer<typeof aspectPropertyRefSchema>;

export const aspectDefinitionSchema = z
  .object({
    id: z.string().min(1),
    ownerId: z.string().uuid().nullable(),
    key: z.string().regex(NAMESPACED_KEY_RE, 'namespaced ASCII-слаг'),
    label: localizedTextSchema,
    description: localizedTextSchema,
    properties: z.array(aspectPropertyRefSchema),
    aiInstructions: z.string().nullable(),
    tagMappings: z.array(z.string()),
    // §Б2 (bind + value_map) — часть Б; в срезе А поле объявлено и пустует, чтобы форма
    // строки реестра не менялась миграцией между срезами.
    implements: z.array(z.unknown()).default([]),
    viewConfig: z.object({ keyFields: z.array(z.string()), icon: z.string().optional() }).strict(),
    module: z.string().nullable(),
    /**
     * §А3-1/Р-П-5: служебность — КОЛОНКА реестра, а не список в коде. Служебный аспект
     * сегодня ровно один (`orbis/agent-run`), и именно поэтому колонка, а не константа:
     * список из одного элемента заводят в коде особенно охотно.
     */
    service: z.boolean(),
    rank: z.number().int(),
  })
  .strict();
export type AspectDefinition = z.infer<typeof aspectDefinitionSchema>;

export const relationRoleDefinitionSchema = z
  .object({
    id: z.string().min(1),
    ownerId: z.string().uuid().nullable(),
    key: z.string().regex(RELATION_ROLE_KEY_RE, 'ASCII-слаг роли'),
    label: localizedTextSchema,
    description: localizedTextSchema,
    // Ч10-С3: направление ребра подписывает реестр («конверт» → «транзакция»), а не UI.
    sourceLabel: localizedTextSchema,
    targetLabel: localizedTextSchema,
    hierarchical: z.boolean(),
    // Generic-ограничения §А4-2. В срезе А поля ЛЕЖАТ: `target_max_incoming` включает
    // Задача 7a, `source_contract`/`target_contract` — часть Б (контрактов ещё нет).
    constraints: z
      .object({
        target_max_incoming: z.number().int().min(1).optional(),
        acyclic: z.boolean().optional(),
        source_contract: z.string().optional(),
        target_contract: z.string().optional(),
        created_by: z.enum(['any', 'system']).optional(),
      })
      .strict()
      .default({}),
    /**
     * named-future Ч10-С2: поле ОПИСАНО, поведение НЕ реализуется. Почему кодом, а не
     * заметкой: единственный кандидат сегодня — `mention`, и backlinks у него уже смотрят в
     * обе стороны без всякой симметрии; второго кейса нет, а форма строки реестра меняется
     * миграцией — дешевле объявить поле сразу и запретить значение, чем добавлять колонку
     * потом. Литерал `false` и есть запрет: `symmetric: true` не разберётся.
     */
    symmetric: z.literal(false).default(false),
    module: z.string().nullable(),
    rank: z.number().int(),
  })
  .strict();
export type RelationRoleDefinition = z.infer<typeof relationRoleDefinitionSchema>;
