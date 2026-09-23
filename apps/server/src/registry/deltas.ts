// apps/server/src/registry/deltas.ts
//
// ДЕЛЬТЫ ВЛАДЕЛЬЦА ПОВЕРХ СИСТЕМНОГО РЕЕСТРА (§А3-2) и трёхстороннее слияние при обновлении
// системы под живой дельтой (§А3-3).
//
// Почему дельта, а не правка строки. Системное определение приходит из кода через сид и
// неизменяемо: правка его строки в базе означала бы, что следующий деплой либо затрёт
// пользовательскую работу, либо навсегда останется «дрейфом» (`db/registry-drift.ts`).
// Дельта разводит эти два слоя: система живёт своей версией, владелец — своей, а читатель
// видит их сумму (⊕). Сумма считается ЗДЕСЬ и нигде больше — снимок кеша (`cache.ts`)
// содержит уже эффективные определения, и ни один потребитель реестра про дельты не знает.
//
// ЧТО ДЕЛЬТА МОЖЕТ (§А3-2, закрытый список — всё остальное форма просто не разберёт):
// подпись и смысл (label/description), иконку аспекта, состав свойств аспекта (добавить,
// скрыть, переставить), ослабление обязательности по белому списку и добавленные варианты
// `select`. Тип и key встроенного она не меняет — на них стоят данные и адреса Q-AST. У действия
// (§С3, Б-2) — только подпись и смысл: шаги встроенного меняет форк, а не дельта.
//
// ОТКАЗ ЗДЕСЬ — FAIL-CLOSED, как и у разбора самих строк реестра (`load.ts`): дельта,
// которая не складывается с системой, ломает чтение реестра целиком, а не «применяется
// частично». Частичное применение означало бы аспект, у которого обязательное поле пропало
// из формы, но осталось в валидации, — то есть запись, которую нельзя ни сделать, ни понять
// почему. Все такие дельты отклоняются на записи (Задача 15), так что живой отказ здесь —
// признак ручной правки базы или незакрытого слияния.
import {
  type AspectDefinition,
  BUILTIN_ASPECT_DEFS,
  type ContractDefinition,
  canonicalJson,
  type LocalizedText,
  localizedTextSchema,
  type PropertyDefinition,
  RULE_ID_RE,
  type RuleDefinition,
  ruleDefinitionSchema,
  type SelectOption,
  SLOT_KEY_RE,
  selectOptionSchema,
  subscriptionDefinitionSchema,
} from '@orbis/shared';
import type { QueryFilterNode } from '@orbis/shared/query';
import { z } from 'zod';
import { ExecError } from '../errors';
// Только тип — рантайм-цикла с `load.ts` (тот берёт отсюда тип строки дельты) нет.
import type { RegistrySnapshot, SubscriptionRow } from './load';
// Цикла нет: `rules.ts` отсюда не импортирует ничего, а из `load.ts` берёт только тип снимка.
import { ruleConflictsOf } from './rules';

/** Цели дельты — те же шесть, что перечисляет CHECK-ограничение `registry_deltas` (0014). */
export const REGISTRY_DELTA_TARGET_KINDS = [
  'property',
  'aspect',
  'contract',
  'relation_role',
  'subscription',
  'action',
] as const;
export type RegistryDeltaTargetKind = (typeof REGISTRY_DELTA_TARGET_KINDS)[number];

/**
 * Строка `registry_deltas` как её отдаёт SELECT — с ЕЩЁ НЕ разобранным `delta`.
 *
 * Разбор отложен намеренно: форма делты зависит от `target_kind`, и разбирать её на месте
 * чтения значило бы вносить в `load.ts` знание о видах целей. Разбирает `applyDeltas`.
 */
export interface RegistryDeltaRow {
  id: string;
  /** Колонка строки КАК ОНА ЛЕЖИТ — голый uuid; бренд графа ей выдаёт читатель (`parseGraphId`). */
  graphId: string;
  targetKind: RegistryDeltaTargetKind;
  targetId: string;
  baseVersion: number;
  delta: unknown;
}

/**
 * Дельта аспекта. `icon` — единственное поле `view_config`, которое владелец правит в срезе
 * А: `keyFields` — это раскладка карточки, и её правка потребовала бы проверки, что все
 * названные свойства ещё в составе аспекта (§А9); отдельного жеста для неё нет.
 *
 * `selectOptions` — карта по id СВОЙСТВА, а не по имени поля: вариант добавляется к типу
 * свойства, а аспект здесь лишь место, откуда жест сделан (§А3-2 «добавленные варианты
 * select»).
 *
 * `classMap` — та же карта по id СВОЙСТВА: отнесение ДОБАВЛЕННОГО варианта к классу контракта
 * (§Б2-2). Отдельным полем, а не внутри `selectOptions[].add[]`: вариант описан
 * `selectOptionSchema` (`shared/registry/types.ts`), и расширение той схемы поменяло бы форму
 * ВСЕХ встроенных свойств ради поля, которое есть только у дельты (Р6). Отнесение едет ПАРОЙ со
 * своим вариантом: снимается вариант — снимается и оно (`threeWayMerge`, `merge-conflict.ts`).
 */
export const aspectDeltaSchema = z
  .object({
    label: localizedTextSchema.optional(),
    description: localizedTextSchema.optional(),
    icon: z.string().min(1).optional(),
    properties: z
      .object({
        add: z
          .array(
            z
              .object({
                propertyId: z.string().min(1),
                required: z.boolean(),
                rank: z.number().int(),
              })
              .strict(),
          )
          .optional(),
        hide: z.array(z.string().min(1)).optional(),
        relaxRequired: z.array(z.string().min(1)).optional(),
        rank: z.record(z.string().min(1), z.number().int()).optional(),
      })
      .strict()
      .optional(),
    selectOptions: z
      .record(z.string().min(1), z.object({ add: z.array(selectOptionSchema).optional() }).strict())
      .optional(),
    classMap: z
      .record(
        z.string().min(1), // id свойства — тот же адрес, что у `selectOptions` (Р6)
        z.array(
          z
            .object({
              contract: z.string().min(1),
              slot: z.string(),
              variant: z.union([z.string(), z.boolean()]),
              class: z.string(),
            })
            .strict(),
        ),
      )
      .optional(),
    /** Правила владельца поверх ВСТРОЕННОЙ строки (§Б4-1, В-6): системную строку правит только сид, а форк
     *  аспекта увёл бы данные (§А3-5). Роли полей не получают — схемы дельты роли нет вовсе (Р-2). */
    rules: z.array(ruleDefinitionSchema).optional(),
    /** Отключённые правила носителя (§С3 «удалить = отключить», §Б4-4, Р-2а). Владелец кладёт сюда id
     *  СИСТЕМНОГО правила (своё правило дельты он снимает из `rules`, а не отключением — строка его и есть);
     *  id СВОЕГО правила сюда кладёт только пересев, выключая проигравшее в конфликте с новым системным
     *  (`mergeRules`, Р-И-35): декларация остаётся, исполнение — нет, и единица пачки меняет их местами. */
    rulesDisabled: z.array(z.string().regex(RULE_ID_RE)).optional(),
  })
  .strict();
export type AspectDelta = z.infer<typeof aspectDeltaSchema>;

/**
 * Дельта свойства — подпись и смысл (Р19 заметок: «переопределение подписи встроенного») и, с
 * Б-2, правила владельца поверх встроенной строки (§Б4-1, В-6). Тип, key, `scope` и флаги сюда не
 * входят: смена типа — это форк свойства (§А3-5), а не дельта, и данные под ней не переезжают.
 */
export const propertyDeltaSchema = z
  .object({
    label: localizedTextSchema.optional(),
    description: localizedTextSchema.optional(),
    /** Правила владельца поверх ВСТРОЕННОЙ строки (§Б4-1, В-6): системную строку правит только сид, а форк
     *  аспекта увёл бы данные (§А3-5). Роли полей не получают — схемы дельты роли нет вовсе (Р-2). */
    rules: z.array(ruleDefinitionSchema).optional(),
    /** Отключённые правила носителя (§С3 «удалить = отключить», §Б4-4, Р-2а). Владелец кладёт сюда id
     *  СИСТЕМНОГО правила (своё правило дельты он снимает из `rules`, а не отключением — строка его и есть);
     *  id СВОЕГО правила сюда кладёт только пересев, выключая проигравшее в конфликте с новым системным
     *  (`mergeRules`, Р-И-35): декларация остаётся, исполнение — нет, и единица пачки меняет их местами. */
    rulesDisabled: z.array(z.string().regex(RULE_ID_RE)).optional(),
  })
  .strict();
export type PropertyDelta = z.infer<typeof propertyDeltaSchema>;

/**
 * Дельта действия — ТОЛЬКО подпись и смысл (§Б6-5 дословно: «правка чужого действия —
 * дельта label; шаги встроенных — форк»). Шаги, предусловие и кап сюда не входят: правка
 * шагов чужого действия меняет то, ЧТО оно делает, а не то, как оно названо, и переживать
 * пересев такой дельте нечем.
 */
export const actionDeltaSchema = z
  .object({ label: localizedTextSchema.optional(), description: localizedTextSchema.optional() })
  .strict();
export type ActionDelta = z.infer<typeof actionDeltaSchema>;

/**
 * Дельта контракта — ТОЛЬКО пользовательские наборы (§Б5-2): встроенный контракт есть API модуля, и
 * правка его слотов и классов сменила бы смысл уже записанных данных. Имя, занятое встроенным набором,
 * отвергается, а не «перекрывает»: перекрытие значило бы, что фильтр `class=…:closed` у двух владельцев
 * значит разное.
 */
export const contractDeltaSchema = z
  .object({
    setsDelta: z.record(
      z.string().regex(SLOT_KEY_RE),
      z.array(z.string().regex(SLOT_KEY_RE)).min(1),
    ),
  })
  .strict();
export type ContractDelta = z.infer<typeof contractDeltaSchema>;

/**
 * Дельта подписки — ПОЛНАЯ ЗАМЕНА, а не патч: патч-языка для вложенных строгих объектов у нас нет, а
 * замена диффуется Ш1 как «было → станет» тем же кодом, что и всё прочее. Движок обязан совпасть с
 * системным: подписка другого движка — другая подписка, и поверхность получила бы декларацию, которую
 * её движок не понимает.
 */
export const subscriptionDeltaSchema = z
  .object({ definition: subscriptionDefinitionSchema })
  .strict();
export type SubscriptionDelta = z.infer<typeof subscriptionDeltaSchema>;

// Союз перечисляет РОДА, а не формы: `ActionDelta` совпадает с `PropertyDelta` по форме, но это
// другая цель (см. докблок `relationDeleteInput` о тождестве форм).
export type RegistryDelta =
  | AspectDelta
  | PropertyDelta
  | ContractDelta
  | SubscriptionDelta
  | ActionDelta;

/**
 * БЕЛЫЙ СПИСОК ОСЛАБЛЕНИЯ ОБЯЗАТЕЛЬНОСТИ (§А3-2: «по явному списку мест, где код
 * null-толерантен»).
 *
 * Обязательность свойства — это обещание КОДУ, а не украшение формы: движки читают значение
 * и на его отсутствие не рассчитаны. Поэтому ослабить можно не «что угодно, что владельцу
 * мешает», а ровно те свойства, чьё отсутствие каждый читатель уже обрабатывает как штатный
 * случай:
 *
 * - `orbis/due_date` — «без срока» это нормальное состояние задачи: Agenda отбирает записи
 *   ПО НАЛИЧИЮ срока (предикат `has`/сравнение), а не считает его у всех подряд.
 * - `orbis/priority` — сортировка кладёт запись без приоритета в конец списка; ни один
 *   движок на приоритете не стоит.
 *
 * Обратная сторона списка — инвариант, который проверяет тест: ни одно свойство,
 * ОБЯЗАТЕЛЬНОЕ во встроенном аспекте, в списке стоять не может (`assertRelaxWhitelistSane`).
 * `orbis/finance_category` обязателен у `orbis/financial` и `orbis/budget`, на нём стоят
 * бюджет-хук и все ведомости — попытка ослабить его отклоняется (§А3-2).
 */
export const RELAXABLE_REQUIRED_PROPERTY_IDS: ReadonlySet<string> = new Set([
  'orbis/due_date',
  'orbis/priority',
]);

/**
 * Инвариант белого списка: ослабляемым не может быть свойство, которое ТРЕБУЕТ встроенный
 * аспект. Проверка вынесена функцией, а не написана в тесте: тот же вопрос задаёт сид при
 * пересеве, а два экземпляра правила разъехались бы на первом же новом модуле.
 */
export function relaxWhitelistViolations(
  aspects: readonly AspectDefinition[] = BUILTIN_ASPECT_DEFS,
): string[] {
  const bad: string[] = [];
  for (const aspect of aspects) {
    for (const ref of aspect.properties) {
      if (ref.required && RELAXABLE_REQUIRED_PROPERTY_IDS.has(ref.propertyId)) {
        bad.push(`${aspect.id}/${ref.propertyId}`);
      }
    }
  }
  return bad;
}

/** Отказ разбора дельты: VALIDATION с ПРИЧИНОЙ в details — коды §А3 закрыты (errors.ts). */
function deltaError(reason: string, message: string, details: Record<string, unknown>): ExecError {
  return new ExecError('VALIDATION', message, { reason, ...details });
}

/** Снимок системных определений, которого достаточно и `applyDeltas`, и слиянию. */
export interface SystemDefinitions {
  properties: ReadonlyMap<string, PropertyDefinition>;
  aspects: ReadonlyMap<string, AspectDefinition>;
  contracts: ReadonlyMap<string, ContractDefinition>;
  subscriptions: ReadonlyMap<string, SubscriptionRow>;
}

/**
 * Называет ли статический `scope` свойства (Р15) ЭТОТ аспект.
 *
 * Обход ИТЕРАТИВНЫЙ, со своим стеком, хотя дерево уже разобрано `queryAstSchema`: рекурсия
 * здесь была бы ВТОРЫМ местом, чья глубина упирается в стек интерпретатора. Гейт записи
 * определения (ВХОД-ДЕРЕВА 4, `registry/ops.ts`) кап держит, но заводить второго читателя,
 * чья прочность зависит от чужой константы, всё равно незачем: итерация стоит столько же.
 */
function scopeNamesAspect(node: QueryFilterNode | null | undefined, aspectId: string): boolean {
  if (node === null || node === undefined) return false;
  const stack: QueryFilterNode[] = [node];
  while (stack.length > 0) {
    const cur = stack.pop() as QueryFilterNode;
    if ('aspect' in cur && cur.aspect === aspectId) return true;
    if ('and' in cur) stack.push(...cur.and);
    else if ('or' in cur) stack.push(...cur.or);
    else if ('not' in cur) stack.push(cur.not);
  }
  return false;
}

/** Копия ссылок аспекта на свойства — правка состава не мутирует исходный снимок. */
function refsOf(aspect: AspectDefinition): AspectDefinition['properties'] {
  return aspect.properties.map((r) => ({ ...r }));
}

/**
 * ДЕЛЬТА АСПЕКТА, КОТОРУЮ ЗАПИШЕТ `aspect_delta_set` (Ф-Б2-27 (г)): поля правил, НЕ названные во входе,
 * переносятся из прежней дельты — правила аспекта правят `rule_set`/`rule_remove`, а полная замена
 * дельты иначе снимала бы свои правила и включала отключённые системные без слова в вызове. Названное
 * поле (в том числе пустым) — замена. Одна функция на исполнителя и на карточку (`snapshotRegistryUnit`):
 * «станет» в карточке обязано быть тем, что ляжет в строку, иначе владелец видит потерю, которой не будет.
 */
export function aspectDeltaAfterSet(before: AspectDelta | null, input: AspectDelta): AspectDelta {
  return {
    ...input,
    ...(!('rules' in input) && before?.rules !== undefined && { rules: before.rules }),
    ...(!('rulesDisabled' in input) &&
      before?.rulesDisabled !== undefined && { rulesDisabled: before.rulesDisabled }),
  };
}

/**
 * ЧТО ОСТАНЕТСЯ ПОСЛЕ `aspect_delta_remove` (Ф-Б2-29): непустые поля правил — правила аспекта правят
 * только `rule_set`/`rule_remove`, и снятие «настройки иконки» не вправе снять свои правила и включить
 * обратно отключённые системные. `null` — правил в дельте нет, строка снимается целиком. Одна функция на
 * операцию (`registry/ops.ts`) и карточку.
 */
export function aspectDeltaAfterRemove(before: AspectDelta | null): AspectDelta | null {
  const rules = before?.rules ?? [];
  const rulesDisabled = before?.rulesDisabled ?? [];
  if (rules.length === 0 && rulesDisabled.length === 0) return null;
  return {
    ...(rules.length > 0 && { rules }),
    ...(rulesDisabled.length > 0 && { rulesDisabled }),
  };
}

/**
 * Эффективные правила: системные ПЛЮС правила владельца МИНУС отключённые (Р-2а). Складывается ЗДЕСЬ и
 * нигде больше — движок читает `row.rules` и про дельты не знает; второй экземпляр ответил бы иначе.
 * Отключение режет ОБА источника: владелец отключает системное, пересев — своё проигравшее (`mergeRules`).
 */
function effectiveRules(
  base: readonly RuleDefinition[],
  delta: { rules?: RuleDefinition[]; rulesDisabled?: string[] },
): RuleDefinition[] {
  const off = new Set(delta.rulesDisabled ?? []);
  return [...base, ...(delta.rules ?? [])].filter((r) => !off.has(r.id));
}

/**
 * Система ⊕ дельты владельца = ЭФФЕКТИВНОЕ определение (§А3-2).
 *
 * Порядок применения детерминирован — дельты сортируются по `(target_kind, target_id)`, а
 * не берутся «как вернул SELECT»: на порядке стоит состав `attach_*`-тула, а тот
 * сравнивается с эталоном списком (`tools/registry-golden.test.ts`).
 *
 * Входной снимок НЕ мутируется: правятся копии тронутых определений. Снимок приезжает сюда
 * прямо из `loadRegistryRows`, но результат кладётся в процессный кеш и живёт дольше вызова
 * — общая с кешем ссылка однажды дала бы правку чужого снимка задним числом.
 */
export function applyDeltas(
  system: RegistrySnapshot,
  deltas: RegistryDeltaRow[],
): RegistrySnapshot {
  if (deltas.length === 0) return system;
  const properties = new Map(system.properties);
  const aspects = new Map(system.aspects);
  const contracts = new Map(system.contracts);
  const subscriptions = new Map(system.subscriptions);
  const actions = new Map(system.actions);
  const ordered = [...deltas].sort(
    (a, b) => a.targetKind.localeCompare(b.targetKind) || a.targetId.localeCompare(b.targetId),
  );

  for (const row of ordered) {
    if (row.targetKind === 'property') {
      const base = properties.get(row.targetId);
      // Определения может не быть: строки реестров не удаляются (§А10-3), но модуль бывает
      // выключен (§Б8) — и тогда дельта на его свойство просто некуда прикладывать.
      if (base === undefined) continue;
      const delta = parseDelta(row) as PropertyDelta;
      properties.set(row.targetId, {
        ...base,
        ...(delta.label !== undefined && { label: delta.label }),
        ...(delta.description !== undefined && { description: delta.description }),
        rules: effectiveRules(base.rules ?? [], delta),
      });
      continue;
    }
    if (row.targetKind === 'contract') {
      const base = contracts.get(row.targetId);
      if (base === undefined) continue;
      const delta = parseDelta(row) as ContractDelta;
      if (base.kind !== 'slots') {
        // ПУСТАЯ дельта наборов ничего не утверждает, и отказывать ей не на чем: ровно её
        // оставляет слияние, когда обновление сделало контракт словарём фактов (`set-merge`).
        // Отказать здесь значило бы запереть владельца дельтой, которую сам же пересев и
        // обнулил, — а починить её нечем: `execute` берёт снимок первым действием (Р-И-7).
        if (Object.keys(delta.setsDelta).length === 0) continue;
        throw deltaError(
          'DELTA_SET_ON_FACTS',
          `у контракта ${row.targetId} нет наборов: это словарь фактов`,
          { targetId: row.targetId },
        );
      }
      const classes = new Set(base.classes.map((c) => c.key));
      for (const [name, members] of Object.entries(delta.setsDelta)) {
        // `Object.hasOwn`, а не `in`: имя набора приезжает из ДЕЛЬТЫ владельца, и `constructor`
        // либо `toString` нашлись бы в прототипе — набор с таким именем отказывал бы
        // `DELTA_SET_BUILTIN`, которого в контракте нет (то же правило, что у `setPredicate`).
        if (Object.hasOwn(base.sets, name)) {
          throw deltaError(
            'DELTA_SET_BUILTIN',
            `набор «${name}» контракта ${row.targetId} — встроенный`,
            { targetId: row.targetId, set: name },
          );
        }
        for (const cls of members) {
          if (!classes.has(cls)) {
            throw deltaError(
              'DELTA_SET_UNKNOWN_CLASS',
              `класса «${cls}» у контракта ${row.targetId} нет`,
              { targetId: row.targetId, set: name, class: cls },
            );
          }
        }
      }
      contracts.set(row.targetId, { ...base, sets: { ...base.sets, ...delta.setsDelta } });
      continue;
    }
    if (row.targetKind === 'subscription') {
      const base = subscriptions.get(row.targetId);
      if (base === undefined) continue;
      const delta = parseDelta(row) as SubscriptionDelta;
      if (delta.definition.engine !== base.definition.engine) {
        throw deltaError('DELTA_ENGINE_MISMATCH', `дельта подписки ${row.targetId} меняет движок`, {
          targetId: row.targetId,
          engine: base.definition.engine,
        });
      }
      // СМЫСЛ ЗДЕСЬ НЕ ПРОВЕРЯЕТСЯ (Р-И-7): assertSubscription живёт на записи — fail-closed по смыслу
      // на чтении запер бы владельца после пересева контракта.
      subscriptions.set(row.targetId, { ...base, definition: delta.definition });
      continue;
    }
    if (row.targetKind === 'action') {
      // §С3: подпись и смысл встроенного действия; шаги форма дельты не пропускает (`.strict()`).
      const base = actions.get(row.targetId);
      if (base === undefined) continue;
      const delta = parseDelta(row) as ActionDelta;
      actions.set(row.targetId, {
        ...base,
        ...(delta.label !== undefined && { label: delta.label }),
        ...(delta.description !== undefined && { description: delta.description }),
      });
      continue;
    }
    if (row.targetKind !== 'aspect') {
      // relation_role: тула записи у этого рода нет — строка появляется только ручной
      // правкой базы, и молчать нельзя: владелец увидел бы «настройка не применилась» без
      // единого следа причины.
      throw deltaError(
        'DELTA_TARGET_UNSUPPORTED',
        `дельта цели «${row.targetKind}» не поддерживается`,
        { targetKind: row.targetKind, targetId: row.targetId },
      );
    }

    const base = aspects.get(row.targetId);
    if (base === undefined) continue;
    const delta = parseDelta(row) as AspectDelta;
    const refs = refsOf(base);

    for (const add of delta.properties?.add ?? []) {
      if (refs.some((r) => r.propertyId === add.propertyId)) {
        // Свойство уже в составе аспекта. Молча заменить ссылку нельзя: подмена
        // `required: true` на `false` обошла бы белый список ослабления ниже.
        throw deltaError(
          'DELTA_PROPERTY_PRESENT',
          `свойство ${add.propertyId} уже входит в аспект ${row.targetId}`,
          { targetId: row.targetId, propertyId: add.propertyId },
        );
      }
      // §А3-4: два механизма «где показывается свойство» разведены — дельта аспекта ИЛИ
      // `scope`, называющий тот же аспект. Двойное объявление означало бы, что свойство
      // приходит в форму дважды и по разным правилам.
      if (scopeNamesAspect(properties.get(add.propertyId)?.scope?.filter, row.targetId)) {
        throw deltaError(
          'SCOPE_DUPLICATE',
          `свойство ${add.propertyId} уже объявлено на аспекте ${row.targetId} через scope — уберите scope`,
          { targetId: row.targetId, propertyId: add.propertyId },
        );
      }
      refs.push({ propertyId: add.propertyId, required: add.required, rank: add.rank });
    }

    const hidden = new Set(delta.properties?.hide ?? []);
    const relaxed = new Set(delta.properties?.relaxRequired ?? []);
    for (const propertyId of relaxed) {
      if (!RELAXABLE_REQUIRED_PROPERTY_IDS.has(propertyId)) {
        throw deltaError(
          'REQUIRED_NOT_RELAXABLE',
          `обязательность ${propertyId} ослабить нельзя: код рассчитывает на значение`,
          { targetId: row.targetId, propertyId },
        );
      }
    }

    const ranks = delta.properties?.rank ?? {};
    const nextRefs = refs
      .filter((r) => !hidden.has(r.propertyId))
      .map((r) => ({
        propertyId: r.propertyId,
        required: relaxed.has(r.propertyId) ? false : r.required,
        rank: ranks[r.propertyId] ?? r.rank,
      }))
      .sort((a, b) => a.rank - b.rank || a.propertyId.localeCompare(b.propertyId));

    aspects.set(row.targetId, {
      ...base,
      ...(delta.label !== undefined && { label: delta.label }),
      ...(delta.description !== undefined && { description: delta.description }),
      properties: nextRefs,
      viewConfig:
        delta.icon === undefined ? base.viewConfig : { ...base.viewConfig, icon: delta.icon },
      rules: effectiveRules(base.rules ?? [], delta),
    });

    for (const [propertyId, patch] of Object.entries(delta.selectOptions ?? {})) {
      const added = patch.add ?? [];
      if (added.length === 0) continue;
      const property = properties.get(propertyId);
      if (property === undefined) continue;
      if (property.type.kind !== 'select') {
        throw deltaError(
          'DELTA_OPTION_NOT_SELECT',
          `у свойства ${propertyId} нет вариантов: тип ${property.type.kind}`,
          { targetId: row.targetId, propertyId },
        );
      }
      const options = [...property.type.options];
      for (const option of added) {
        if (options.some((o) => o.key === option.key)) {
          // Вариант с таким key уже есть — либо владелец добавил его дважды, либо система
          // завела свой с тем же ключом. Второе — конфликт слияния (`variant-merge`), и
          // разрешает его `threeWayMerge`, а не тихая перезапись здесь.
          throw deltaError(
            'DELTA_OPTION_PRESENT',
            `вариант «${option.key}» свойства ${propertyId} уже существует`,
            { targetId: row.targetId, propertyId, option: option.key },
          );
        }
        options.push(option);
      }
      options.sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key));
      properties.set(propertyId, { ...property, type: { ...property.type, options } });
    }

    // КАРТА КЛАССОВ ⊕ ПРИВЯЗКИ (§Б2-2). Отнесение дописывается в `value_map` КАЖДОЙ привязки,
    // связывающей это свойство с названным слотом, — в чьём бы аспекте она ни стояла: вариант
    // приезжает в ТИП свойства и виден всем носителям, а отнесение, положенное только на
    // аспект-цель дельты, дало бы запись, которую `class=` находит через один аспект и теряет
    // через другой.
    // ДОПИСЫВАЕТСЯ, А НЕ ПЕРЕЗАПИСЫВАЕТ (§Б2-4 «привязку можно только дополнять»): пара (слот,
    // вариант), уже отнесённая системой, дельтой не трогается — иначе `done → active` молча
    // переопределил бы смысл встроенного набора `closed`, на котором стоят чекбокс строки,
    // Agenda и `excludeBlocked`. Тот же довод у дубля внутри одной карты: выигрывает первое
    // отнесение, порядок массива владелец видит в диффе Ш1.
    // ПРОВЕРОК ПОЛНОТЫ ЗДЕСЬ НЕТ намеренно: `applyDeltas` fail-closed на КАЖДОМ чтении реестра,
    // и отказ тут запер бы владельца снаружи графа после пересева, изменившего контракт.
    // Полноту проверяет запись — `checkClassMap` в `registry/ops.ts`.
    for (const [propertyId, entries] of Object.entries(delta.classMap ?? {})) {
      for (const entry of entries) {
        for (const aspectId of [...aspects.keys()]) {
          const carrier = aspects.get(aspectId) as AspectDefinition;
          let touched = false;
          const next = carrier.implements.map((binding) => {
            if (binding.contract !== entry.contract) return binding;
            if (binding.bind[entry.slot] !== propertyId) return binding;
            if (
              binding.value_map.some((m) => m.slot === entry.slot && m.variant === entry.variant)
            ) {
              return binding;
            }
            touched = true;
            return {
              ...binding,
              value_map: [
                ...binding.value_map,
                { slot: entry.slot, variant: entry.variant, class: entry.class },
              ],
            };
          });
          if (touched) aspects.set(aspectId, { ...carrier, implements: next });
        }
      }
    }
  }

  return { ...system, properties, aspects, contracts, subscriptions, actions };
}

/**
 * Схема по роду цели — ТАБЛИЦЕЙ, а не цепочкой тернарников: родов шесть, и «схемы нет» —
 * такой же законный ответ, как схема, но отвечать на него обязан один и тот же код.
 */
const DELTA_SCHEMA: Record<RegistryDeltaTargetKind, z.ZodTypeAny | null> = {
  property: propertyDeltaSchema,
  aspect: aspectDeltaSchema,
  contract: contractDeltaSchema,
  subscription: subscriptionDeltaSchema,
  relation_role: null,
  action: actionDeltaSchema,
};

/** Разбор `delta` строки по её `target_kind`; форма закрыта (`.strict()`). */
function parseDelta(row: RegistryDeltaRow): RegistryDelta {
  const schema = DELTA_SCHEMA[row.targetKind];
  // Формы дельты у этого рода (`relation_role`) нет — строка появляется только ручной правкой базы, и
  // молчать нельзя: владелец увидел бы «настройка не применилась» без единого следа причины.
  if (schema === null) {
    throw deltaError(
      'DELTA_TARGET_UNSUPPORTED',
      `дельта цели «${row.targetKind}» не поддерживается`,
      { targetKind: row.targetKind, targetId: row.targetId },
    );
  }
  const parsed = schema.safeParse(row.delta);
  if (!parsed.success) {
    throw deltaError('DELTA_MALFORMED', `дельта ${row.targetKind}/${row.targetId} не разобрана`, {
      targetKind: row.targetKind,
      targetId: row.targetId,
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  return parsed.data as RegistryDelta;
}

// ---------------------------------------------------------------------------
// Трёхстороннее слияние (§А3-3)
// ---------------------------------------------------------------------------

/**
 * Конфликт слияния: система изменилась под живой дельтой так, что молчаливого правильного
 * ответа нет. В срезе А конфликт ДОКЛАДЫВАЕТСЯ (отчёт дрейфа, системная заметка глобального
 * треда), а единицей пачки D42 становится в Задаче 15: `createPending` требует актора, а у
 * деплойного слияния его нет (находка 46).
 */
export interface RegistryConflict {
  kind:
    | 'variant-merge'
    | 'hidden-required'
    | 'set-merge'
    | 'subscription-rebased'
    | 'rule-conflict';
  targetKind: RegistryDeltaTargetKind;
  targetId: string;
  propertyId?: string;
  detail: string;
  /**
   * Ключи двух ПОХОЖИХ вариантов — только у `variant-merge`, где оба остались (Задача 15).
   *
   * У двух родов части Б поля нет: выбора у владельца там не возникает. Набор, имя которого заняла
   * система, снимается по единственному применимому исходу (иначе `applyDeltas` отказывает
   * `DELTA_SET_BUILTIN` на каждом чтении), а замена подписки либо остаётся как есть, либо
   * сбрасывается на системную вместе со сменой движка — обе развилки решены правилом, а не
   * владельцем.
   *
   * Поле СТРУКТУРНОЕ, потому что по нему собирается единица пачки: «слить» значит убрать из
   * дельты вариант `mine`, и вытаскивать его имя из `detail` регуляркой было бы разбором
   * человеческого текста ради машинного решения. У пары, совпавшей по КЛЮЧУ, выбора уже нет
   * (слияние сняло пользовательский), поэтому поля у неё нет — и по его отсутствию единица
   * не заводится.
   */
  option?: { mine: string; theirs: string };
  /**
   * Пара правил — только у `rule-conflict`, где выбор ЕСТЬ (§А3-3, Р-И-35): новое системное правило и
   * правило владельца пишут одно (событие, свойство), и слияние выключило своё. Поле СТРУКТУРНО, потому
   * что по нему собирается единица пачки (довод `option` выше): «Принять» = обмен отключений (`mine`
   * включается, `theirs` выключается), и имя правила из `detail` регуляркой не достают. У конфликта по
   * совпавшему ID поля нет: обмен отключений по одному id невыразим (отключение режет оба источника), и
   * по отсутствию поля единица не заводится — владелец получает заметку.
   */
  rule?: { mine: string; theirs: string };
}

/**
 * СТОРОНА «ДО» ДЛЯ ДЕЛЬТЫ С НЕИЗВЕСТНЫМ ПРОШЛЫМ: пусто.
 *
 * Пустой снимок — это утверждение «система могла измениться ВСЯ», и правила §А3-3 на нём
 * срабатывают максимально широко: обязательным считается всё, что обязательно СЕЙЧАС
 * (`requiredIn(undefined, …)` = false → скрытие такого свойства идёт в конфликт), а новым
 * системным вариантом — любой вариант, который есть сейчас.
 *
 * ГДЕ ЭТО БЕЗОПАСНО САМО ПО СЕБЕ, А ГДЕ НЕТ — утверждение точное, потому что правил три:
 *  - `properties.add` базу не читает вовсе (смотрит только на текущий состав аспекта) —
 *    широкая база на него не влияет никак;
 *  - `hidden-required` базой ОГРАНИЧЕН («стало обязательным» = не было и стало), и пустая
 *    база это ограничение снимает — множество конфликтов строго расширяется, вердикт
 *    (скрытие снять) один и тот же;
 *  - `variant-merge` — ЕДИНСТВЕННОЕ, где база влияет и на ВЕРДИКТ («снять свой вариант» или
 *    «оставить оба»). Само по себе расширение здесь безопасным НЕ является, и защищено оно
 *    не базой, а тем, что проверка «ключ занят системой» идёт по ВСЕМ текущим вариантам и
 *    прежде поиска похожего (см. блок (3) в `threeWayMerge`).
 *
 * С этой оговоркой: ошибиться пустой базой можно только в сторону ЛИШНЕГО конфликта,
 * никогда — в сторону пропущенного и никогда — в сторону неприменимой дельты.
 */
export const UNKNOWN_PREV_SYSTEM: SystemDefinitions = {
  properties: new Map(),
  aspects: new Map(),
  contracts: new Map(),
  subscriptions: new Map(),
};

/**
 * Годится ли снимок `prevSystem` стороной «до» ДЛЯ ЭТОЙ дельты.
 *
 * Снимок описывает ровно одну системную версию (`prevVersion`), и трёхстороннее слияние
 * имеет смысл ТОЛЬКО когда дельта опиралась именно на неё. Отставший `base_version` бывает
 * штатно: сид упал или процесс убили посреди цикла слияния — часть строк переехала на новую
 * версию, часть осталась на старой. Для такой строки состояние, против которого её писали,
 * не сохранено НИГДЕ (системные строки уже перезаписаны), и `prev == next` для неё означал
 * бы «система не менялась» — то есть переход «свойство стало обязательным» не был бы
 * замечен, а скрытие обязательного поля уехало бы владельцу молча.
 *
 * Поэтому база при любом несовпадении версии — `UNKNOWN_PREV_SYSTEM`: конфликтов может
 * стать больше, чем при точной базе, и это правильная сторона ошибки. Обещание докблока
 * `mergeRegistryDeltas` («недоделанные доедут следующим прогоном») держится именно здесь.
 */
export function baseSystemFor(
  prevSystem: SystemDefinitions,
  row: RegistryDeltaRow,
  prevVersion: number,
): SystemDefinitions {
  return row.baseVersion === prevVersion ? prevSystem : UNKNOWN_PREV_SYSTEM;
}

/**
 * ПРЕДПРОСМОТР КОНФЛИКТОВ: какие конфликты дал бы пересев ПРЯМО СЕЙЧАС.
 *
 * Ровно тот же расчёт, что делает сид (`db/seed-registries.ts`), только без записи: три
 * стороны — системные строки, лежащие в БД (`prevSystem`), системные определения из кода
 * (`nextSystem`) и живые дельты. Именно поэтому предпросмотр живёт РЯДОМ с самим слиянием,
 * а не в отчёте дрейфа: второй экземпляр правил §А3-3 однажды ответил бы иначе, чем сид, —
 * и оператор увидел бы «конфликтов нет» ровно перед тем, как получить их пачкой.
 *
 * `base_version` здесь не фильтр, а ВЫБОР БАЗЫ: он говорит, на какую версию дельта
 * опиралась, и `baseSystemFor` решает, годится ли ей снимок БД (описывающий `prevVersion` —
 * текущую системную версию) или база неизвестна. Вопрос предпросмотра — «расходится ли КОД
 * с тем, что в базе»: дельта, слитая с текущими строками БД, при совпадении кода и базы
 * конфликтов не даст, а отставшая доложит их по широкому правилу — так же, как доложит их
 * сам пересев.
 */
export function previewMergeConflicts(
  prevSystem: SystemDefinitions,
  nextSystem: SystemDefinitions,
  rows: RegistryDeltaRow[],
  prevVersion: number,
): RegistryConflict[] {
  return rows.flatMap(
    (row) => threeWayMerge(baseSystemFor(prevSystem, row, prevVersion), nextSystem, row).conflicts,
  );
}

/** Строка отчёта — одна на конфликт, одинаковая у `ops.ts check` и у заметки треда. */
export function registryConflictLine(c: RegistryConflict): string {
  const at = c.propertyId === undefined ? c.targetId : `${c.targetId}/${c.propertyId}`;
  return `  ✗ ${c.kind} ${c.targetKind}/${at}: ${c.detail}`;
}

/** Подпись варианта, по которой «похожий» отличается от «другого»: регистр и края не в счёт. */
function normalizedLabels(label: LocalizedText): Set<string> {
  return new Set(Object.values(label).map((v) => v.trim().toLowerCase()));
}

function sameLabel(a: LocalizedText, b: LocalizedText): boolean {
  const left = normalizedLabels(a);
  for (const value of normalizedLabels(b)) if (left.has(value)) return true;
  return false;
}

function optionsOf(def: PropertyDefinition | undefined): SelectOption[] {
  return def !== undefined && def.type.kind === 'select' ? def.type.options : [];
}

function requiredIn(aspect: AspectDefinition | undefined, propertyId: string): boolean {
  return aspect?.properties.some((r) => r.propertyId === propertyId && r.required) === true;
}

/**
 * ТРЁХСТОРОННЕЕ СЛИЯНИЕ (§А3-3): система под дельтой поехала с `base_version` на текущую.
 *
 * Три стороны — системное определение НА МОМЕНТ записи дельты (`prevSystem`, это строки в
 * базе ДО пересева), системное определение из кода (`nextSystem`, то, что пересев кладёт) и
 * сама дельта. Возвращается пара: дельта, пригодная к применению поверх новой системы, и
 * список конфликтов, о которых владельцу надо сказать.
 *
 * ПРАВИЛА (по типу поля, §А3-3):
 * - label/description — ДЕЛЬТА ПОБЕЖДАЕТ МОЛЧА. Переименование системой того, что владелец
 *   уже переименовал, — не событие: он видит своё имя и до пересева, и после.
 * - добавленный системой вариант рядом с похожим пользовательским — КОНФЛИКТ
 *   `variant-merge`. Совпал `key` — пользовательский вариант из дельты снимается (иначе
 *   применение упало бы на дубле ключа), совпала только подпись — оба остаются: слить их
 *   можно только зная, одно ли это понятие, а это знает владелец.
 * - скрытие свойства, СТАВШЕГО обязательным, — КОНФЛИКТ `hidden-required`, и скрытие
 *   СНИМАЕТСЯ. Оставить его значило бы аспект, который нельзя записать: обязательное поле
 *   валидируется, но в форму и в `attach_*` не приходит. Система здесь побеждает не потому,
 *   что она главнее, а потому, что противоположный выбор — это молчаливо неработающая
 *   запись.
 *
 * - правило владельца, которому новая система завела КОНКУРЕНТА (два писателя одного (событие,
 *   свойство)), — КОНФЛИКТ `rule-conflict`, и своё правило ОТКЛЮЧАЕТСЯ (`mergeRules` ниже).
 *
 * Дельта СВОЙСТВА с Б-2 тоже способна дать конфликт — но только этот, правил (`rules` поверх встроенной
 * строки, В-6): подпись и смысл у неё сливаются молча, как и у аспекта. Дельта действия — подпись и смысл
 * и ничего больше, конфликтов у неё нет.
 */
export function threeWayMerge(
  prevSystem: SystemDefinitions,
  nextSystem: SystemDefinitions,
  row: RegistryDeltaRow,
): { merged: RegistryDelta; conflicts: RegistryConflict[] } {
  const conflicts: RegistryConflict[] = [];
  if (row.targetKind === 'contract') {
    const delta = parseDelta(row) as ContractDelta;
    const next = nextSystem.contracts.get(row.targetId);
    const nextSets = next?.sets ?? {};
    // СОСТАВ, А НЕ ТОЛЬКО ИМЯ: класс, который обновление сняло или переименовало, обязан уйти из
    // набора здесь — `applyDeltas` отказывает `DELTA_SET_UNKNOWN_CLASS` на КАЖДОМ чтении, и
    // владелец заперт снаружи графа (починить нечем: `contract_sets_delta_remove` идёт через
    // `execute`, а тот берёт снимок первым делом). `null` — «классы неизвестны»: контракта нет в
    // коде (дрейф), и `applyDeltas` такую дельту просто пропускает — снимать её незачем.
    const nextClasses =
      next === undefined || next.kind !== 'slots' ? null : new Set(next.classes.map((c) => c.key));
    const setsDelta: ContractDelta['setsDelta'] = {};
    for (const [name, members] of Object.entries(delta.setsDelta)) {
      // `Object.hasOwn` — см. довод у `applyDeltas` выше: имя приезжает из дельты владельца.
      if (!Object.hasOwn(nextSets, name)) {
        // Контракт стал словарём фактов: наборов у него нет вовсе (`DELTA_SET_ON_FACTS`).
        if (next !== undefined && next.kind !== 'slots') {
          conflicts.push({
            kind: 'set-merge',
            targetKind: 'contract',
            targetId: row.targetId,
            detail: `обновление сделало ${row.targetId} словарём фактов — ваш набор «${name}» снят`,
          });
          continue;
        }
        const kept = nextClasses === null ? members : members.filter((c) => nextClasses.has(c));
        if (kept.length === members.length) {
          setsDelta[name] = members;
          continue;
        }
        const gone = members.filter((c) => !kept.includes(c));
        conflicts.push({
          kind: 'set-merge',
          targetKind: 'contract',
          targetId: row.targetId,
          detail:
            kept.length === 0
              ? `обновление сняло класс «${gone.join('», «')}» — ваш набор «${name}» снят`
              : `обновление сняло класс «${gone.join('», «')}» — он убран из вашего набора «${name}»`,
        });
        // Набор без классов схемой не выразим (`.min(1)`), поэтому пустой снимается целиком.
        if (kept.length > 0) setsDelta[name] = kept;
        continue;
      }
      // Система завела набор с тем же именем. Оставить пользовательский нельзя: applyDeltas отказывает
      // DELTA_SET_BUILTIN на КАЖДОМ чтении — владелец заперт. Выбора нет, поэтому конфликт
      // докладывается, а единицей пачки не становится.
      conflicts.push({
        kind: 'set-merge',
        targetKind: 'contract',
        targetId: row.targetId,
        detail: `обновление завело набор «${name}» — ваш набор с тем же именем снят`,
      });
    }
    return { merged: { setsDelta }, conflicts };
  }
  if (row.targetKind === 'subscription') {
    const next = nextSystem.subscriptions.get(row.targetId);
    // МЯГКИЙ РАЗБОР — ТОЛЬКО ЗДЕСЬ. Дельта подписки это полная копия декларации под `.strict()`,
    // и первое ломающее изменение схемы (обязательное поле, удаление/переименование, сужение
    // enum) делает уже записанную дельту неразбираемой. Строгий разбор первой строкой означал бы
    // `DELTA_MALFORMED` внутри пересева — ПОСЛЕ бампа версии: сид красный, версия поднята,
    // повторный прогон падает так же, а владелец заперт на каждом вызове MCP (`dispatchTool`
    // берёт снимок первым действием). Форма устарела — настройка сбрасывается на системную и
    // владелец узнаёт об этом заметкой; сбрасывать не на что (`next === undefined`) — прежний
    // отказ, он честен. На ЧТЕНИИ (`applyDeltas`) разбор остаётся строгим: fail-closed там —
    // сознательный выбор, и лечит его сид.
    const soft = subscriptionDeltaSchema.safeParse(row.delta);
    if (!soft.success && next !== undefined) {
      conflicts.push({
        kind: 'subscription-rebased',
        targetKind: 'subscription',
        targetId: row.targetId,
        detail: 'форма настройки устарела — она сброшена на системную',
      });
      return { merged: { definition: next.definition }, conflicts };
    }
    const delta = parseDelta(row) as SubscriptionDelta;
    if (next === undefined) return { merged: delta, conflicts };
    if (next.definition.engine !== delta.definition.engine) {
      // Движок сменился — прежняя ЗАМЕНА неприменима по построению (тот же довод, что у
      // hidden-required): дельта сбрасывается на системную декларацию.
      conflicts.push({
        kind: 'subscription-rebased',
        targetKind: 'subscription',
        targetId: row.targetId,
        detail: 'обновление сменило движок подписки — ваша настройка сброшена на системную',
      });
      return { merged: { definition: next.definition }, conflicts };
    }
    const prev = prevSystem.subscriptions.get(row.targetId);
    if (prev !== undefined && canonicalJson(prev.definition) !== canonicalJson(next.definition)) {
      conflicts.push({
        kind: 'subscription-rebased',
        targetKind: 'subscription',
        targetId: row.targetId,
        detail: 'обновление изменило системную подписку — ваша замена оставлена как есть',
      });
    }
    return { merged: delta, conflicts };
  }
  if (row.targetKind === 'property') {
    const delta = parseDelta(row) as PropertyDelta;
    const { rules: _rules, rulesDisabled: _off, ...rest } = delta;
    const baseRules = nextSystem.properties.get(row.targetId)?.rules ?? [];
    return {
      merged: { ...rest, ...mergeRules(baseRules, delta, 'property', row.targetId, conflicts) },
      conflicts,
    };
  }
  if (row.targetKind !== 'aspect') return { merged: parseDelta(row), conflicts };

  const delta = parseDelta(row) as AspectDelta;
  const nextAspect = nextSystem.aspects.get(row.targetId);
  const prevAspect = prevSystem.aspects.get(row.targetId);

  // (1) Свойства, которые система сама добавила в аспект: своя ссылка на них больше не
  // нужна и применению мешает (дубль в составе). Не конфликт — система догнала владельца.
  const add = (delta.properties?.add ?? []).filter(
    (a) => !nextAspect?.properties.some((r) => r.propertyId === a.propertyId),
  );

  // (2) Скрытие того, что стало обязательным.
  const hide = (delta.properties?.hide ?? []).filter((propertyId) => {
    if (!requiredIn(nextAspect, propertyId) || requiredIn(prevAspect, propertyId)) return true;
    conflicts.push({
      kind: 'hidden-required',
      targetKind: 'aspect',
      targetId: row.targetId,
      propertyId,
      detail:
        `свойство стало обязательным в системном определении, а дельта его прячет; ` +
        `скрытие снято — иначе аспект нельзя было бы записать`,
    });
    return false;
  });

  // (3) Варианты select, добавленные системой рядом с пользовательскими.
  const selectOptions: NonNullable<AspectDelta['selectOptions']> = {};
  /** Ключи вариантов, снятых слиянием, — по свойству: их отнесения уезжают вместе с ними. */
  const droppedVariants = new Map<string, Set<string>>();
  for (const [propertyId, patch] of Object.entries(delta.selectOptions ?? {})) {
    const current = optionsOf(nextSystem.properties.get(propertyId));
    const before = new Set(optionsOf(prevSystem.properties.get(propertyId)).map((o) => o.key));
    const fresh = current.filter((o) => !before.has(o.key));
    const kept = (patch.add ?? []).filter((mine) => {
      // ЗАНЯТЫЙ КЛЮЧ ИЩЕТСЯ СРЕДИ ВСЕХ ТЕКУЩИХ ВАРИАНТОВ, а не среди «новых», и ищется
      // ПЕРВЫМ. Это единственное место слияния, где база влияет не только на НАЛИЧИЕ
      // конфликта, но и на ВЕРДИКТ, и потому единственное, где широкая база (§А3-3,
      // `UNKNOWN_PREV_SYSTEM`) сама по себе не безопасна: при ней «новыми» считаются ВСЕ
      // варианты, поиск похожего по подписи перехватывал бы вариант, совпавший по ключу, и
      // пользовательский дубль ключа ОСТАВАЛСЯ бы в дельте. Дальше `applyDeltas` отказывает
      // `DELTA_OPTION_PRESENT` на КАЖДОМ чтении реестра, а `base_version` дельты к этому
      // моменту уже переехал — повторный пересев расхождения не видит и молчит, то есть
      // владелец заперт (ровно тот исход, ради недопущения которого слияние и не отказывает).
      //
      // Отсюда правило: проверка «ключ занят» НЕ зависит от того, известна ли база.
      const byKey = current.find((o) => o.key === mine.key);
      const twin = byKey ?? fresh.find((o) => sameLabel(o.label, mine.label));
      if (twin === undefined) return true;
      const sameKey = byKey !== undefined;
      if (sameKey) {
        const set = droppedVariants.get(propertyId) ?? new Set<string>();
        set.add(mine.key);
        droppedVariants.set(propertyId, set);
      }
      conflicts.push({
        kind: 'variant-merge',
        targetKind: 'aspect',
        targetId: row.targetId,
        propertyId,
        ...(sameKey ? {} : { option: { mine: mine.key, theirs: twin.key } }),
        detail: sameKey
          ? `у системы есть вариант «${twin.key}» с тем же ключом — пользовательский снят, ` +
            `значения уже записанных сущностей указывают на общий ключ`
          : `система завела вариант «${twin.key}», похожий на пользовательский «${mine.key}» — ` +
            `оба оставлены, слить их может только владелец`,
      });
      return !sameKey;
    });
    if (kept.length > 0) selectOptions[propertyId] = { add: kept };
  }

  // (3б) Карта классов едет ПАРОЙ со своим вариантом (§Б2-2): отнесение, чей вариант слияние
  // сняло, дожило бы до `applyDeltas` и назначило класс варианту, которого в дельте нет.
  const classMap: NonNullable<AspectDelta['classMap']> = {};
  for (const [propertyId, entries] of Object.entries(delta.classMap ?? {})) {
    const dropped = droppedVariants.get(propertyId);
    // Ключ варианта — строка (`selectOptionSchema.key`); boolean-отнесения приходят от
    // boolean-слотов, которых дельта не добавляет, и под снятие не попадают никогда.
    const kept = entries.filter((e) => dropped === undefined || !dropped.has(String(e.variant)));
    if (kept.length > 0) classMap[propertyId] = kept;
  }

  const properties = {
    ...(add.length > 0 && { add }),
    ...(hide.length > 0 && { hide }),
    ...(delta.properties?.relaxRequired !== undefined && {
      relaxRequired: delta.properties.relaxRequired,
    }),
    ...(delta.properties?.rank !== undefined && { rank: delta.properties.rank }),
  };

  const merged: AspectDelta = {
    ...(delta.label !== undefined && { label: delta.label }),
    ...(delta.description !== undefined && { description: delta.description }),
    ...(delta.icon !== undefined && { icon: delta.icon }),
    ...(Object.keys(properties).length > 0 && { properties }),
    ...(Object.keys(selectOptions).length > 0 && { selectOptions }),
    ...(Object.keys(classMap).length > 0 && { classMap }),
    // (4) Правила владельца против правил НОВОЙ системы (§А3-3, Р-И-35).
    ...mergeRules(nextAspect?.rules ?? [], delta, 'aspect', row.targetId, conflicts),
  };
  return { merged, conflicts };
}

/**
 * ПРАВИЛА ВЛАДЕЛЬЦА ПРИ ПЕРЕСЕВЕ (§А3-3, Р-И-35). Правило живёт, пока новая система не завела
 * КОНФЛЮЭНТНО несовместимое (§Б4: два писателя одного (свойство, событие)). Тогда правило владельца
 * ОТКЛЮЧАЕТСЯ, а не снимается: снятие потеряло бы декларацию, а живой конфликт отдал бы движку двух
 * писателей одного свойства — запись, исход которой зависит от порядка. Fail-closed на ЧТЕНИИ невозможен
 * (Р-И-7), значит конфликт разрешается здесь, на пересеве, один раз.
 *
 * ВИСЯЧЕЕ `rulesDisabled` — id, которого нет НИ в новой системе, НИ среди своих правил дельты: отключать
 * нечего, и оно снимается молча. Своё правило, отключённое прошлым пересевом, висячим НЕ является: снять
 * его отключение значило бы молча вернуть в работу второго писателя — ровно то, от чего отключение и
 * защищало (и следующий пересев завёл бы тот же конфликт второй единицей пачки).
 *
 * СОВПАВШИЙ ID. Система завела правило с id правила владельца. Одинаковое целиком — система догнала
 * владельца, своё снимается молча (довод блока (1) `threeWayMerge` про `properties.add`). Разное —
 * своё снимается с заметкой: id — адрес правила в журнале, в отказе и в «отключить», и двум правилам
 * с одним адресом не ужиться (отключение по id выключило бы оба).
 */
function mergeRules(
  baseRules: readonly RuleDefinition[],
  delta: { rules?: RuleDefinition[]; rulesDisabled?: string[] },
  targetKind: RegistryDeltaTargetKind,
  targetId: string,
  conflicts: RegistryConflict[],
): { rules?: RuleDefinition[]; rulesDisabled?: string[] } {
  const system = new Map(baseRules.map((r) => [r.id, r]));
  const kept: RuleDefinition[] = [];
  for (const own of delta.rules ?? []) {
    const twin = system.get(own.id);
    if (twin === undefined) {
      kept.push(own);
      continue;
    }
    if (canonicalJson(twin) === canonicalJson(own)) continue;
    conflicts.push({
      kind: 'rule-conflict',
      targetKind,
      targetId,
      detail:
        `обновление завело системное правило с тем же именем «${own.id}» — ваше снято ` +
        `(два правила с одним именем не различить ни в журнале, ни в «отключить»)`,
    });
  }
  const known = new Set([...system.keys(), ...kept.map((r) => r.id)]);
  const disabled = (delta.rulesDisabled ?? []).filter((id) => known.has(id));
  const live = baseRules.filter((r) => !disabled.includes(r.id));
  for (const own of kept) {
    // Уже отключённое своё не спорит ни с кем: оно не исполняется.
    if (disabled.includes(own.id)) continue;
    const clash = ruleConflictsOf([...live, own]).find((c) => c.a === own.id || c.b === own.id);
    if (clash === undefined) continue;
    const theirs = clash.a === own.id ? clash.b : clash.a;
    disabled.push(own.id);
    conflicts.push({
      kind: 'rule-conflict',
      targetKind,
      targetId,
      rule: { mine: own.id, theirs },
      detail:
        `обновление завело правило «${theirs}», которое пишет то же (${clash.event} → ` +
        `${clash.property}), что ваше «${own.id}» — ваше отключено`,
    });
  }
  return {
    ...(kept.length > 0 && { rules: kept }),
    ...(disabled.length > 0 && { rulesDisabled: disabled }),
  };
}
