// apps/server/src/registry/merge-conflict.ts
//
// КОНФЛИКТ ЗНАЧЕНИЙ ПРИ СЛИЯНИИ (§А10-2) → ЕДИНИЦА ПАЧКИ ВЛАДЕЛЬЦУ.
//
// Почему это отдельный модуль, а не ветка внутри `mergeProperty`. Слияние, нашедшее записи
// с двумя разными значениями, НЕ ПРИМЕНЯЕТ НИЧЕГО — его транзакция откатывается целиком.
// Карточка, записанная в той же транзакции, откатилась бы вместе с ней: владелец получил бы
// отказ и ни следа причины. Значит единица обязана лечь ДРУГОЙ транзакцией, а открыть её
// может только тот, у кого на руках `Db`, — то есть вызывающий `execute`, а не операция.
//
// Почему не в `policy/pending.ts` и не в `executor/`. `policy/pending.ts` зовёт `execute`
// (approve исполняет сохранённый payload), поэтому исполнитель не может звать pending —
// это был бы цикл модулей. Здесь его нет: этот файл зовёт pending, pending зовёт
// исполнителя, исполнитель сюда не смотрит.
//
// ВЫЗЫВАЮЩИХ ДВА, и оба — границы, где мутация реестра приходит снаружи: тул
// (`tools/dispatch.ts`) и ручка владельца (`routers/registry.ts`). Функция безопасна на
// ЛЮБОМ отказе: не тот код — молча ничего. Поэтому вызывающему не нужно знать, какой именно
// отказ он держит, и третья граница (если появится) добавляется одной строкой, а не разбором.
import type { Db } from '../db/client';
import { type Tx, withIdentity } from '../db/with-identity';
import type { StructuredError } from '../errors';
import { createSystemPending, unitHash } from '../policy/pending';
import type { AspectDelta, RegistryConflict, RegistryDelta } from './deltas';

/** Сколько записей назвать в сводке поимённо: карточка — строка ленты, а не отчёт. */
const NAMED_IN_SUMMARY = 3;

/**
 * ЧТО ИМЕННО ДЕЛАЕТ «ПРИНЯТЬ» у единицы drift-конфликта — константой, а не строкой внутри
 * сводки, и это не оформление.
 *
 * Прежняя редакция обещала «записи будут указывать на общий ключ», а approve применяет
 * дельту без спорного варианта и значений на записях НЕ ТРОГАЕТ. Текст был неправдой один
 * раз — значит удержать его должен не следующий читатель, а тест: `merge-conflict.test`
 * сверяет сводку карточки с ЭТОЙ константой и отдельно проверяет, что после approve
 * значение на записи осталось прежним. Разъедутся обещание и поведение — падёт вторая
 * половина, а не первая.
 */
export const DRIFT_MERGE_EFFECT =
  'Принять — снять ваш вариант из настройки; записи, у которых уже стоит старый вариант, ' +
  'останутся с ним, и их придётся перевести вручную. Отклонить — оставить оба варианта.';

interface MergeConflictDetails {
  reason?: unknown;
  source?: unknown;
  into?: unknown;
  entities?: Array<{ entityId?: unknown }>;
}

/**
 * Единица пачки о неслучившемся слиянии — В СВОЕЙ транзакции, поверх отката слияния.
 *
 * `tool`/`input` единицы — ТО ЖЕ САМОЕ слияние: разобрав конфликт (стерев лишнее значение
 * там, где оба заполнены), владелец жмёт «Принять», и слияние идёт заново. Единица,
 * несущая «сообщение о проблеме» вместо действия, потребовала бы от него второй раз найти
 * и повторить операцию вручную.
 *
 * Дедуп — по ПАРЕ свойств и СОСТАВУ конфликтующих записей: повторная попытка того же
 * слияния возвращает ту же карточку (второй такой же в ленте не появляется), а попытка
 * после частичного разбора — новую, потому что и разбирать в ней осталось другое.
 */
export async function reportMergeConflictUnit(
  db: Db,
  ownerId: string,
  error: StructuredError,
): Promise<void> {
  if (error.code !== 'REGISTRY_CONFLICT') return;
  const details = (error.details ?? {}) as MergeConflictDetails;
  if (details.reason !== 'MERGE_VALUES') return;
  const source = String(details.source ?? '');
  const into = String(details.into ?? '');
  const ids = (details.entities ?? [])
    .map((e) => String(e.entityId ?? ''))
    .filter((id) => id !== '');
  if (source === '' || into === '' || ids.length === 0) return;

  const named = ids.slice(0, NAMED_IN_SUMMARY).join(', ');
  const tail = ids.length > NAMED_IN_SUMMARY ? ` и ещё ${ids.length - NAMED_IN_SUMMARY}` : '';
  await withIdentity(db, ownerId, (tx) =>
    createSystemPending(tx, {
      ownerId,
      tool: 'property_merge',
      input: { source, into },
      summary:
        `Слияние ${source} → ${into} остановлено: у ${ids.length} записей заполнены оба ` +
        `свойства разными значениями (${named}${tail}). Уберите лишнее и подтвердите — ` +
        `слияние пойдёт заново.`,
      dedupeKey: `merge-conflict:${source}:${into}:${unitHash(ids)}`,
    }),
  );
}

// ---------------------------------------------------------------------------
// Конфликты трёхстороннего слияния на пересеве (§А3-3) → единицы пачки
// ---------------------------------------------------------------------------

/**
 * Из КАКИХ конфликтов пересева получается единица пачки, а из каких — только заметка.
 *
 * Единица нужна там, где ВЫБОР ЕЩЁ ЕСТЬ. Правила §А3-3 два из трёх конфликтов решают сами и
 * решают правильно: вариант, совпавший по КЛЮЧУ, снимается (иначе применение упало бы на
 * дубле), а скрытие ставшего обязательным поля отменяется (иначе аспект нельзя было бы
 * записать). Предлагать владельцу «принять» то, что уже случилось, — это карточка, у которой
 * кнопка ничего не меняет.
 *
 * Остаётся ровно один ряд таблицы §А3-3: система завела вариант, ПОХОЖИЙ по подписи на
 * пользовательский, и оба оставлены — «слить их может только владелец». Вот это и есть
 * единица: «Принять» = слить (пользовательский вариант снимается, записи указывают на
 * системный ключ), «Отклонить» = оставить оба.
 */
export function driftConflictDecidable(conflicts: readonly RegistryConflict[]): RegistryConflict[] {
  return conflicts.filter((c) => c.kind === 'variant-merge' && c.option !== undefined);
}

/**
 * Единицы пачки по конфликтам пересева — ТОЙ ЖЕ транзакцией, что переписывает дельту.
 *
 * Порознь возможен исход «дельта слита, а владельцу не сказали»: следующий прогон её уже не
 * найдёт (`base_version` переехал), и конфликт замолчит навсегда. Тот же довод, по которому
 * рядом пишется системная заметка (`db/seed-registries.ts`).
 *
 * Нагрузка единицы — `aspect_delta_set` с ТОЙ ЖЕ дельтой, минус спорный вариант: одобрение
 * идёт обычным конвейером (`approvePending` → `execute`), то есть проходит проверку
 * применимости и поднимает версию реестра, как любая другая правка. Второго пути записи
 * дельты «для конфликтов» здесь нет намеренно.
 */
export async function createDriftConflictUnits(
  tx: Tx,
  args: {
    ownerId: string;
    systemVersion: number;
    deltaRowId: string;
    merged: RegistryDelta;
    conflicts: readonly RegistryConflict[];
  },
): Promise<string[]> {
  const out: string[] = [];
  for (const conflict of driftConflictDecidable(args.conflicts)) {
    const option = conflict.option;
    const propertyId = conflict.propertyId;
    if (option === undefined || propertyId === undefined) continue;
    const merged = args.merged as AspectDelta;
    const patch = merged.selectOptions?.[propertyId];
    if (patch === undefined) continue;
    const kept = (patch.add ?? []).filter((o) => o.key !== option.mine);
    const selectOptions = { ...merged.selectOptions };
    if (kept.length > 0) selectOptions[propertyId] = { add: kept };
    else delete selectOptions[propertyId];
    const delta: AspectDelta = {
      ...merged,
      ...(Object.keys(selectOptions).length > 0 ? { selectOptions } : { selectOptions: undefined }),
    };
    if (delta.selectOptions === undefined) delete delta.selectOptions;

    const { id } = await createSystemPending(tx, {
      ownerId: args.ownerId,
      tool: 'aspect_delta_set',
      input: { aspect: conflict.targetId, delta },
      // ТЕКСТ ОБЕЩАЕТ РОВНО ТО, ЧТО ДЕЛАЕТ APPROVE, и ни словом больше. Прежняя редакция
      // говорила «записи будут указывать на общий ключ» — а approve применяет дельту без
      // спорного варианта и ЗНАЧЕНИЯ НА ЗАПИСЯХ НЕ ТРОГАЕТ: после «Принять» они указывают на
      // снятый ключ, фильтры их не находят, повторная запись — отказ валидатора. Перенос
      // значений как настоящая семантика «слить» — отдельная работа (посчитать нагрузку в
      // момент постановки карточки нечем), и до неё карточка обязана называть последствие.
      summary:
        `Обновление завело вариант «${option.theirs}», похожий на ваш «${option.mine}» ` +
        `(${conflict.targetId}). ${DRIFT_MERGE_EFFECT}`,
      // Детерминированный ключ: пересев считает конфликты заново на каждом прогоне, и без
      // него повторный деплой той же версии клал бы вторую карточку о том же самом.
      dedupeKey: `drift-conflict:${args.deltaRowId}:${args.systemVersion}:${propertyId}:${option.mine}`,
    });
    out.push(id);
  }
  return out;
}
