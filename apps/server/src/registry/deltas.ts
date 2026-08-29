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
// `select`. Тип и key встроенного она не меняет — на них стоят данные и адреса Q-AST.
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
  type LocalizedText,
  localizedTextSchema,
  type PropertyDefinition,
  type SelectOption,
  selectOptionSchema,
} from '@orbis/shared';
import type { QueryFilterNode } from '@orbis/shared/query';
import { z } from 'zod';
import { ExecError } from '../errors';
// Только тип — рантайм-цикла с `load.ts` (тот берёт отсюда тип строки дельты) нет.
import type { RegistrySnapshot } from './load';

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
  ownerId: string;
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
 * select»). Карты классов контракта в срезе А нет (РП-19) — она приезжает с частью Б.
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
  })
  .strict();
export type AspectDelta = z.infer<typeof aspectDeltaSchema>;

/**
 * Дельта свойства — только подпись и смысл (Р19 заметок: «переопределение подписи
 * встроенного»). Тип, key, `scope` и флаги сюда не входят: смена типа — это форк свойства
 * (§А3-5), а не дельта, и данные под ней не переезжают.
 */
export const propertyDeltaSchema = z
  .object({
    label: localizedTextSchema.optional(),
    description: localizedTextSchema.optional(),
  })
  .strict();
export type PropertyDelta = z.infer<typeof propertyDeltaSchema>;

export type RegistryDelta = AspectDelta | PropertyDelta;

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
}

/**
 * Называет ли статический `scope` свойства (Р15) ЭТОТ аспект.
 *
 * Обход ИТЕРАТИВНЫЙ, со своим стеком, хотя дерево уже разобрано `queryAstSchema`: рекурсия
 * здесь была бы ВТОРЫМ местом, чья глубина упирается в стек интерпретатора, и гейт входа
 * дерева (`QUERY_TREE_DEPTH_CAP`, `@orbis/shared`, `query/ast.ts`) её бы не прикрыл — он
 * стоит на входе, а `scope` строки реестра проходит мимо него (ВХОД-ДЕРЕВА 4).
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
  const ordered = [...deltas].sort(
    (a, b) => a.targetKind.localeCompare(b.targetKind) || a.targetId.localeCompare(b.targetId),
  );

  for (const row of ordered) {
    if (row.targetKind === 'property') {
      const base = properties.get(row.targetId);
      // Определения может не быть: строки реестров не удаляются (§А10-3), но модуль бывает
      // выключен (§Б8) — и тогда дельта на его свойство просто некуда прикладывать.
      if (base === undefined) continue;
      const delta = parseDelta(row);
      properties.set(row.targetId, {
        ...base,
        ...(delta.label !== undefined && { label: delta.label }),
        ...(delta.description !== undefined && { description: delta.description }),
      });
      continue;
    }
    if (row.targetKind !== 'aspect') {
      // contract/subscription/action/relation_role: их реестры срез А создаёт пустыми
      // (§А12-1), тулов записи дельт ещё нет (Задача 15) — такая строка может появиться
      // только ручной правкой базы, и молча её игнорировать нельзя: владелец увидел бы
      // «настройка не применилась» без единого следа причины.
      throw deltaError(
        'DELTA_TARGET_UNSUPPORTED',
        `дельта цели «${row.targetKind}» в срезе А не поддерживается`,
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
  }

  return { ...system, properties, aspects };
}

/** Разбор `delta` строки по её `target_kind`; форма закрыта (`.strict()`). */
function parseDelta(row: RegistryDeltaRow): AspectDelta & PropertyDelta {
  const schema = row.targetKind === 'aspect' ? aspectDeltaSchema : propertyDeltaSchema;
  const parsed = schema.safeParse(row.delta);
  if (!parsed.success) {
    throw deltaError('DELTA_MALFORMED', `дельта ${row.targetKind}/${row.targetId} не разобрана`, {
      targetKind: row.targetKind,
      targetId: row.targetId,
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  return parsed.data as AspectDelta & PropertyDelta;
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
  kind: 'variant-merge' | 'hidden-required';
  targetKind: RegistryDeltaTargetKind;
  targetId: string;
  propertyId?: string;
  detail: string;
}

/**
 * СТОРОНА «ДО» ДЛЯ ДЕЛЬТЫ С НЕИЗВЕСТНЫМ ПРОШЛЫМ: пусто.
 *
 * Пустой снимок — это утверждение «система могла измениться ВСЯ», и правила §А3-3 на нём
 * срабатывают максимально широко: обязательным считается всё, что обязательно СЕЙЧАС
 * (`requiredIn(undefined, …)` = false → скрытие такого свойства идёт в конфликт), а новым
 * системным вариантом — любой вариант, который есть сейчас. Ошибиться такой базой можно
 * только в сторону ЛИШНЕГО конфликта, никогда — в сторону пропущенного.
 */
export const UNKNOWN_PREV_SYSTEM: SystemDefinitions = {
  properties: new Map(),
  aspects: new Map(),
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
 * Дельта, чья цель — не аспект, конфликтов дать не может: `PropertyDelta` состоит из
 * label/description, а у них правило одно и молчаливое.
 */
export function threeWayMerge(
  prevSystem: SystemDefinitions,
  nextSystem: SystemDefinitions,
  row: RegistryDeltaRow,
): { merged: RegistryDelta; conflicts: RegistryConflict[] } {
  const conflicts: RegistryConflict[] = [];
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
  for (const [propertyId, patch] of Object.entries(delta.selectOptions ?? {})) {
    const before = new Set(optionsOf(prevSystem.properties.get(propertyId)).map((o) => o.key));
    const fresh = optionsOf(nextSystem.properties.get(propertyId)).filter(
      (o) => !before.has(o.key),
    );
    const kept = (patch.add ?? []).filter((mine) => {
      const twin = fresh.find((o) => o.key === mine.key || sameLabel(o.label, mine.label));
      if (twin === undefined) return true;
      const sameKey = twin.key === mine.key;
      conflicts.push({
        kind: 'variant-merge',
        targetKind: 'aspect',
        targetId: row.targetId,
        propertyId,
        detail: sameKey
          ? `система завела вариант «${twin.key}» с тем же ключом — пользовательский снят, ` +
            `значения уже записанных сущностей указывают на общий ключ`
          : `система завела вариант «${twin.key}», похожий на пользовательский «${mine.key}» — ` +
            `оба оставлены, слить их может только владелец`,
      });
      return !sameKey;
    });
    if (kept.length > 0) selectOptions[propertyId] = { add: kept };
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
  };
  return { merged, conflicts };
}
