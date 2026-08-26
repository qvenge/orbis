// packages/shared/src/contracts/tools.ts
// Envelope-схемы тулов — wire-контракт §9.2 (нотация `*`/`?`), общий для tRPC/AI/MCP.
// expectedUpdatedAt в entity_update — решение 4 плана 1a: §9.2 поле не показывает,
// но §5.2 требует optimistic-check по updated_at при правке body; поле опционально
// в envelope, обязательность при body enforce'ит executor.
import { z } from 'zod';
import { RELATION_TYPES } from '../constants';

export const entityCreateInput = z
  .object({
    id: z.string().uuid().optional(),
    title: z.string().min(1),
    emoji: z.string().optional(),
    body: z.string().optional(),
    tags: z.array(z.string()), // обязателен по §9.2 (может быть пустым)
    meta: z.record(z.unknown()).optional(),
    aspects: z.record(z.record(z.unknown())).optional(),
  })
  .strict();

export const entityUpdateInput = z
  .object({
    id: z.string().uuid(),
    expectedUpdatedAt: z.string().datetime().optional(), // §5.2; обязателен при body — executor
    title: z.string().min(1).optional(),
    emoji: z.string().nullable().optional(),
    body: z.string().optional(),
    tags: z.array(z.string()).optional(),
    meta: z.record(z.unknown()).optional(),
    aspects: z.record(z.union([z.record(z.unknown()), z.null()])).optional(),
    archived: z.boolean().optional(),
  })
  .strict();

// Форму документа контракт не разбирает: её знает схема нод (@orbis/shared/doc), а дублирующая
// zod-модель дерева ProseMirror разъехалась бы с ней при первой же новой ноде. Импортировать
// сюда сам `@orbis/shared/doc` тоже нельзя: этот модуль лежит в эагерном барреле, а тот тянет
// всю схему Tiptap (~156 kB gzip) — она уехала бы в первый кадр web.
//
// Но «не моделировать ноды» — не то же самое, что «не проверять ничего»: структура верхнего
// уровня стоит одну строку и ловит формы, которые serializeBody МОЛЧА превращает в пустую
// строку (`{}`, `content` не массивом), стирая тело вместе с body_refs. `.passthrough()`
// обязателен: без него zod срезал бы всё, чего нет в форме, и правда о теле приехала бы в БД
// урезанной. Версию сверяет executor — здесь про DOC_SCHEMA_VERSION знать нечем.
// Экспортирована (Ш1.11): правка предложения владельцем везёт тело ДОКУМЕНТОМ, и её
// контракт обязан описывать тело ровно этой схемой. Вторая zod-модель дерева ProseMirror
// разъехалась бы с этой ровно так же, как обе разъехались бы со схемой нод (см. выше).
export const bodyDocSchema = z.object({
  v: z.number().int().positive(),
  doc: z.object({ type: z.literal('doc'), content: z.array(z.record(z.unknown())) }).passthrough(),
});

// Тело приходит в ОДНОЙ из двух форм — гейт нужен обеим широким схемам (UI и exec).
// Предикат и текст вынесены в общее место намеренно: два одинаковых по смыслу `.refine`
// разъехались бы при первой же правке, а сообщение видит пользователь редактора.
const bodyXorBodyDoc = (v: { body?: string | undefined; bodyDoc?: unknown }): boolean =>
  !(v.body !== undefined && v.bodyDoc !== undefined);
const BODY_XOR_BODY_DOC_ISSUE = {
  message: 'body и bodyDoc одновременно недопустимы',
  path: ['bodyDoc'],
};

/**
 * Вход tRPC-роутера entity.update: то же, что у тула, плюс структурная форма тела.
 *
 * Почему отдельной схемой, а не расширением `entityUpdateInput`: та — контракт ТУЛА, её парность
 * с рукописной JSON Schema реестра (tools/registry.ts) проверяет тест, и рост схемы показал бы
 * `bodyDoc` модели — а дизайн держит тул-контракт строковым. Один путь записи (executor), два
 * входа с разными полномочиями.
 */
export const entityUpdateUiInput = entityUpdateInput
  .extend({ bodyDoc: bodyDocSchema.optional() })
  .refine(bodyXorBodyDoc, BODY_XOR_BODY_DOC_ISSUE);
export type EntityUpdateUiInput = z.infer<typeof entityUpdateUiInput>;

/**
 * Пункт CAS-предусловия правки (С7): условие на одно поле аспекта, при котором правка
 * допустима. Executor сверяет его со строкой, прочитанной ПОД `FOR UPDATE`, и пишет в той
 * же транзакции — это и делает захват тикета исполнителем атомарным (два конкурентных
 * `planned → in_progress` не могут оба увидеть `planned`).
 *
 * Форм две, и вторая не сводится к первой:
 * - `in` — список ДОПУСТИМЫХ текущих значений (min 1: пустой список запрещал бы правку
 *   всегда, и это была бы опечатка, а не намерение);
 * - `absent: true` — «применимо, пока поля НЕТ» (V1.7). Через `in` это невыразимо: там
 *   отсутствие поля намеренно не совпадает ни с чем (докблок `assertPrecondition`), а
 *   предложение рутины сплошь и рядом ДОПИСЫВАЕТ поле, которого ещё не было, — и обязано
 *   проиграть тому, кто заполнил его первым, а не затереть его молча.
 *
 * Обе половины union strict, поэтому смесь `in` + `absent` отклоняется: лишний ключ в
 * предусловии почти всегда опечатка имени поля, а «предусловие с опечаткой» молча
 * пропускало бы ровно ту гонку, ради которой его и поставили. По той же причине нет
 * `absent: false` — «поле есть, значение любое» это отдельное намерение, и пока за ним
 * никто не пришёл, его отсутствие лучше молчаливого согласия на опечатку.
 *
 * ЗАРЕЗЕРВИРОВАННЫЙ id аспекта — `orbis/entity` (D42 ОЧ.13). Настоящего аспекта с таким
 * именем нет и не будет (реестр `ASPECT_SCHEMAS` закрыт, запрет пиннится тестом): под ним
 * предусловие адресует КОЛОНКИ строки сущности, а не карту аспектов, — так выражается
 * «применимо, пока запись не в архиве» (`{aspect:'orbis/entity', field:'archived',
 * in:[false]}`), невыразимое иначе, потому что `archived` — колонка. Здесь это ровно
 * соглашение об имени: форма пункта та же, схема не меняется, а разбор — в executor'е
 * (`ENTITY_PSEUDO_ASPECT`). Поддержана одна колонка — `archived`; любое другое поле под
 * этим id даёт расхождение (fail-closed), то есть отказ, а не молчаливый пропуск.
 */
export const entityUpdatePreconditionItem = z.union([
  z
    .object({
      aspect: z.string().min(1),
      field: z.string().min(1),
      in: z.array(z.unknown()).min(1),
    })
    .strict(),
  z
    .object({
      aspect: z.string().min(1),
      field: z.string().min(1),
      absent: z.literal(true),
    })
    .strict(),
]);
export type EntityUpdatePreconditionItem = z.infer<typeof entityUpdatePreconditionItem>;

export const entityUpdatePrecondition = z.array(entityUpdatePreconditionItem).min(1);
export type EntityUpdatePrecondition = z.infer<typeof entityUpdatePrecondition>;

/**
 * Одно расхождение предусловия — executor кладёт в `details.mismatches` ПО ОДНОМУ на
 * каждый провалившийся пункт (V1.7). `expected` повторяет форму пункта: список допустимых
 * значений либо литерал `'absent'`.
 *
 * Почему весь список, а не первое расхождение: предложение рутины применяется «всё или
 * ничего», и владельцу, чтобы решить «принять заново или отклонить», нужно видеть, ЧТО
 * разошлось. С одним первым пунктом разбор превращается в угадайку — поправил его,
 * применил, получил тот же отказ по следующему.
 */
export interface PreconditionMismatch {
  aspect: string;
  field: string;
  expected: unknown[] | 'absent';
  actual: unknown;
}

/**
 * ВНУТРЕННЯЯ форма правки значений (§А1-1, РП-3): плоский патч по свойствам плюс
 * навешивание/снятие аспектов. Живёт в exec/UI-надмножествах и НЕ показывается модели до
 * Задачи 12 — контракты тулов `entityCreateInput`/`entityUpdateInput` не растут ни на поле.
 *
 * Три части, и каждая выражает то, чего не выражают остальные:
 *  - `props` — «поставить значение». Ключ — id свойства ИЛИ его `key`; какой именно,
 *    решает резолв на границе (`resolvePropertyRef`): у встроенных они совпадают, а свои
 *    свойства владелец адресует именем, которое сам и дал;
 *  - `unset` — «снять значение». Отдельным списком, а не `null` в `props`, потому что
 *    `null` — законное ЗНАЧЕНИЕ json-свойства, и совместить их значило бы навсегда
 *    запретить его записывать;
 *  - `aspects.attach`/`detach` — «изменить интерпретацию». Снятие аспекта значений НЕ
 *    трогает (Р9): аспект — не владелец поля, и его снятие не повод терять факт владельца.
 */
export const entityPropsPatch = z
  .object({
    props: z.record(z.unknown()).optional(),
    unset: z.array(z.string()).optional(),
    aspects: z
      .object({ attach: z.array(z.string()).optional(), detach: z.array(z.string()).optional() })
      .strict()
      .optional(),
  })
  .strict();
export type EntityPropsPatch = z.infer<typeof entityPropsPatch>;

/** Старая карта правки: `{id аспекта: {поле: значение|null}}`; `null` вместо объекта — detach. */
const legacyAspectsPatch = z.record(z.union([z.record(z.unknown()), z.null()]));

/**
 * Надмножество entity_create для executor'а: старая карта аспектов ИЛИ новая форма
 * (`props` + список навешиваемых аспектов).
 *
 * `aspects` — union, а не два разных поля: у создания это ОДНО понятие «с чем сущность
 * рождается», и вторым именем оно бы просто раздвоилось. Формы различимы по типу значения
 * (список строк против карты объектов), поэтому разбор однозначен, а вызывающий выбирает ту,
 * на которую уже переведён: старую карту шлют тулы, web и не переведённые серверные пути
 * (до Задач 13c/18), новую — всё, что переводится по мере задач среза.
 */
export const entityCreateExecInput = entityCreateInput
  .extend({
    props: z.record(z.unknown()).optional(),
    aspects: z.union([z.array(z.string()), z.record(z.record(z.unknown()))]).optional(),
  })
  .strict();
export type EntityCreateExecInput = z.infer<typeof entityCreateExecInput>;

/**
 * Надмножество для executor'а: UI-форма (bodyDoc) + серверное CAS-предусловие (С7) +
 * внутренняя форма правки свойств (§А1-1).
 * Тул и tRPC его не принимают — `precondition` это рычаг серверных путей (захват тикета,
 * подметание, ответ на чекпойнт), а не поле, которое модель или клиент подставляет сами.
 * Ровно поэтому схема отдельная, а `entityUpdateInput` (контракт ТУЛА) не растёт.
 *
 * `aspects` здесь — union ДВУХ форм: старая карта (её шлют тулы, web и ещё не переведённые
 * серверные пути) и `{attach, detach}` новой формы. Пустой объект `{}` разбирается первой
 * веткой и означает пустой патч в обеих — расхождения между формами он не создаёт.
 */
export const entityUpdateExecInput = entityUpdateInput
  .extend({
    bodyDoc: bodyDocSchema.optional(),
    precondition: entityUpdatePrecondition.optional(),
    props: entityPropsPatch.shape.props,
    unset: entityPropsPatch.shape.unset,
    aspects: z.union([legacyAspectsPatch, entityPropsPatch.shape.aspects.unwrap()]).optional(),
  })
  .refine(bodyXorBodyDoc, BODY_XOR_BODY_DOC_ISSUE);
export type EntityUpdateExecInput = z.infer<typeof entityUpdateExecInput>;

export const attachAspectInput = z
  .object({
    entity_id: z.string().uuid(),
    data: z.record(z.unknown()),
  })
  .strict();

export const relationCreateInput = z
  .object({
    source_id: z.string().uuid(),
    target_id: z.string().uuid(),
    relation_type: z.enum(RELATION_TYPES),
  })
  .strict();
export const relationDeleteInput = relationCreateInput;

export const batchExecuteInput = z
  .object({
    batch_id: z.string().uuid(),
    // Элемент тоже strict — парность с рукописной JSON Schema реестра тулов
    // (additionalProperties: false вложенного конверта, §9.2)
    operations: z
      .array(z.object({ tool: z.string(), input: z.record(z.unknown()) }).strict())
      .min(1),
  })
  .strict();

export const entityQueryInput = z.object({ query: z.string().min(1) }).strict();
export const entityGetInput = z
  .object({
    id: z.string().uuid(),
    include: z.array(z.enum(['body', 'relations', 'backlinks', 'thread'])).optional(),
  })
  .strict();

/**
 * Симметрично для чтения: UI просит документ, тул-контракт не растёт. Объявлена ПОСЛЕ
 * `entityGetInput` намеренно — `const` в TDZ до своей инициализации, и ссылка выше по файлу
 * упала бы ReferenceError при загрузке модуля (проверено пробой).
 */
export const entityGetUiInput = entityGetInput.extend({
  include: z.array(z.enum(['body', 'bodyDoc', 'relations', 'backlinks', 'thread'])).optional(),
});
export type EntityGetUiInput = z.infer<typeof entityGetUiInput>;

/**
 * Поиск сущности для `/`-меню, @-упоминаний и пикеров. Отдельно от грамматики `search=`
 * (§6.1) намеренно: та — FTS по plainto_tsquery, то есть совпадение по ЦЕЛОМУ слову, и на
 * этой семантике стоят сидированные смарт-листы. Меню же обязано находить по началу
 * НАБРАННОГО слова: «куп» → «Купить кроссовки» (проверено пробой — `search=куп` не находит).
 *
 * `term` — набранный фрагмент. Имя намеренно НЕ `prefix`: сопоставляется он как ВХОЖДЕНИЕ
 * в заголовок (иначе «Отчёт за квартал» перестал бы находиться набором «квартал»), и имя
 * `prefix` обещало бы читателю не то, что делает код. Не `query` — это слово в кодовой базе
 * занято смарт-листами (`{{query:…}}`, `entity.query`, `QueryBlock`). Совпадения с начала
 * заголовка ранжируются выше вхождений в середине — детали у процедуры.
 *
 * Вход ТОЛЬКО tRPC: в реестре тулов (tools/registry.ts) не появляется, модели не раздаётся.
 */
export const entitySuggestInput = z
  .object({ term: z.string().min(1), limit: z.number().int().min(1).max(20).optional() })
  .strict();

/**
 * Заголовки для чипов ссылок — ПАЧКОЙ, а не entity.get на каждую ссылку в теле.
 * Потолок 200, а не 100: тело с сотней с лишним упоминаний — не выдумка, а отказ на входе
 * положил бы весь резолв и все чипы разом, вместо того чтобы просто стоить один запрос.
 * Вход ТОЛЬКО tRPC.
 */
/**
 * Потолок вынесен константой, потому что его читает и КЛИЕНТ: чипы длинного тела режутся на
 * пачки ровно по нему (web/features/entity-editor/nodes/RefTitlesContext.tsx). Второе число,
 * переписанное туда руками, разъехалось бы молча — в одну сторону вечной ошибкой валидации,
 * в другую лишним запросом.
 */
export const ENTITY_RESOLVE_REFS_MAX = 200;

export const entityResolveRefsInput = z
  .object({ ids: z.array(z.string().uuid()).min(1).max(ENTITY_RESOLVE_REFS_MAX) })
  .strict();

export type EntitySuggestInput = z.infer<typeof entitySuggestInput>;
export type EntityResolveRefsInput = z.infer<typeof entityResolveRefsInput>;

export type EntityCreateInput = z.infer<typeof entityCreateInput>;
export type EntityUpdateInput = z.infer<typeof entityUpdateInput>;
export type AttachAspectInput = z.infer<typeof attachAspectInput>;
export type RelationCreateInput = z.infer<typeof relationCreateInput>;
export type RelationDeleteInput = z.infer<typeof relationDeleteInput>;
export type BatchExecuteInput = z.infer<typeof batchExecuteInput>;
export type EntityQueryInput = z.infer<typeof entityQueryInput>;
export type EntityGetInput = z.infer<typeof entityGetInput>;
