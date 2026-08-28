// apps/server/src/policy/confirmation.ts
// Политика подтверждений AI-действий §7.10 — детерминированная таблица MVP (решение 4
// плана 1b). Уровень определяет ЭТОТ серверный слой по типизированным фактам вызова —
// не модель и не текст её рассуждений. Правила едины для внутреннего чата и MCP (§9.3):
// классификатор сознательно НЕ смотрит на source — внешний агент не может получить
// более широкие права, обойдя политику другим транспортом. Каждый ряд таблицы и границы
// закреплены юнит-тестами (confirmation.test.ts); подключение — tools/dispatch.ts.
import { batchExecuteInput } from '@orbis/shared';
import type { ActionRecord, ActorKind } from '../executor/types';

/** Уровни подтверждения §7.10 (семантика каждого — таблица PRD 01 §7.10). */
export type ConfirmationLevel = 'execute' | 'preview' | 'explicit-confirmation' | 'forbidden';

/** Типизированные факты tool-call — входы классификации §7.10. */
export interface ToolCallFacts {
  tool: string;
  kind: 'read' | 'mutate';
  known: boolean; // тул есть в реестре (§9.2)
  actorKind: ActorKind;
  explicitCommand: boolean; // §7.10 «явность намерения»; в 1b всегда false (ToolCallCtx)
  archives: boolean; // мутация архивации: archived: true в input (мягкое удаление)
  isBatch: boolean;
  batchSize?: number;
  /**
   * Выдача автономии рутине (V1.10): создание/attach рутины с `mode: 'act'` либо правка
   * её доверенности (`mode`/`allowed_tools`). Право писать в граф без спроса выдаёт только
   * владелец — модели и внешнему агенту оно достаётся через карточку подтверждения.
   */
  grantsAutonomy: boolean;
}

/**
 * Классификатор §7.10 — таблица правил MVP, первое совпадение сверху (порядок значим):
 *
 * | Условие                      | Уровень                | Обоснование §7.10 |
 * |------------------------------|------------------------|-------------------|
 * | !known                       | forbidden              | fail-closed: незнакомый вызов не исполняется |
 * | kind === 'read'              | execute                | чтение без внешних эффектов |
 * | archives && !explicitCommand | explicit-confirmation  | архивация = мягкое удаление; инициатива модели/агента без прямой команды — чувствительно |
 * | isBatch && batchSize > 10    | explicit-confirmation  | масштаб приближается к bulk |
 * | grantsAutonomy && !owner     | explicit-confirmation  | V1.10: право рутины писать в граф выдаёт только владелец |
 * | isBatch                      | preview                | bounded-масштаб: исполнить + информационный diff |
 * | иначе (одиночная мутация)    | execute                | single, обратимо (inverse в журнале §7.8) |
 *
 * actorKind — вход политики §7.10; MVP-таблица ветвится по нему ровно в одном ряду —
 * автономии рутины (V1.10): владельцу подтверждать нечего, он и есть тот, у кого спрашивают.
 * Прочие ряды по актору не ветвятся: ряд archives адресует инициативу модели/агента, а
 * owner-актор до классификатора обычно не доходит (прямые действия владельца идут
 * UI-роутерами мимо dispatch).
 *
 * Ряд автономии стоит ВЫШЕ «isBatch → preview» намеренно: preview исполняет действие и лишь
 * показывает diff, то есть batch из двух операций провёз бы выдачу прав молча.
 */
export function classifyToolCall(facts: ToolCallFacts): ConfirmationLevel {
  if (!facts.known) return 'forbidden';
  if (facts.kind === 'read') return 'execute';
  if (facts.archives && !facts.explicitCommand) return 'explicit-confirmation';
  if (facts.isBatch && facts.batchSize !== undefined && facts.batchSize > 10) {
    return 'explicit-confirmation';
  }
  if (facts.grantsAutonomy && facts.actorKind !== 'owner') return 'explicit-confirmation';
  if (facts.isBatch) return 'preview';
  return 'execute';
}

/**
 * Извлечение фактов формы вызова из (def, input). Контракт (fix round Task 5; §7.10
 * дословно: уровень получает tool-call ПОСЛЕ структурной валидации input'а): dispatch
 * передаёт сюда уже envelope-ВАЛИДИРОВАННЫЙ input (validateMutationEnvelope /
 * validateBatchOperations) — классификация невалидированного payload'а в dispatch не
 * происходит. Ветки на сырой input (не-объект → archives false, невалидный
 * batch-envelope → fallback «не batch») сохранены как защитные и покрыты юнитами:
 * функция не падает на мусоре, а невалидный вызов отклоняет валидация вызывающего.
 * Акторные факты (actorKind, explicitCommand) добавляет вызывающий из ToolCallCtx;
 * known: true — сюда доходит только найденный реестром def, ряд «!known» dispatch
 * строит сам по результату резолва.
 */
export function factsFromToolCall(
  def: { name: string; kind: 'read' | 'mutate' },
  input: unknown,
): Omit<ToolCallFacts, 'actorKind' | 'explicitCommand'> {
  const base = { tool: def.name, kind: def.kind, known: true as const };
  if (def.name === 'batch_execute') {
    const parsed = batchExecuteInput.safeParse(input);
    if (parsed.success) {
      return {
        ...base,
        archives: parsed.data.operations.some((op) => op.input.archived === true),
        isBatch: true,
        batchSize: parsed.data.operations.length,
        // ЛЮБАЯ операция batch, выдающая автономию, поднимает уровень всего вызова:
        // batch исполняется «всё или ничего», подтверждать его тоже приходится целиком
        grantsAutonomy: parsed.data.operations.some((op) =>
          grantsRoutineAutonomy(op.tool, op.input),
        ),
      };
    }
    return { ...base, archives: false, isBatch: false, grantsAutonomy: false };
  }
  return {
    ...base,
    // Архивация — только entity_update (§9.2: archived есть лишь в его envelope);
    // archived в чужом strict-envelope — невалидный input, честный отказ
    // envelope-валидации dispatch (fix round) ещё до классификации
    archives: def.name === 'entity_update' && isRecord(input) && input.archived === true,
    isBatch: false,
    grantsAutonomy: grantsRoutineAutonomy(def.name, input),
  };
}

/**
 * Адреса ДОВЕРЕННОСТИ рутины (§А9-1) — ОДНО объявление на систему.
 *
 * Читателей ШЕСТЬ, и вопросы у них разные:
 *  1. гейт §7.10 ниже — поднимать ли уровень до `explicit-confirmation`;
 *  2. сводка карточки (`tools/dispatch.ts`, `autonomySummary` и `AUTONOMY_LABEL`) — что
 *     назвать владельцу;
 *  3. проба носителя (`autonomyChangedByCarrier`, там же) — что вызов отнимает или выдаёт;
 *  4. гейт правки инструкции (`actRoutineInstructionTargets`, там же) — act-рутина ли цель;
 *  5. `routines/runner.ts` — режим прогона и белый список реестра тулов;
 *  6. `routines/context.ts` — секция режима в системном слое.
 * Первые четыре решают, что показать владельцу, последние два — что рутине ПОЗВОЛЕНО; пока
 * адреса стояли врозь, карточка могла рассказывать не о том, что подняло уровень. Это класс
 * обоих Critical ветки («множество должно быть ОДНИМ у всех потребителей»). Перечень
 * пересчитан грепом по обеим константам и `AUTONOMY_PROPERTIES`; седьмого читателя нет.
 *
 * ОДНОГО МНОЖЕСТВА МАЛО — читать его все шестеро обязаны ОДИНАКОВО ПОЛНО. Фикс-раунд 2 нашёл
 * ровно этот недобор: адреса уже были общими, а сводка ходила только в `props`, и вызов
 * `{unset:['orbis/allowed_tools']}` поднимал уровень с ПУСТОЙ карточкой. Правя одного
 * читателя, проверь остальных — унификация имён сама по себе ничего не гарантирует. Тот же
 * недобор в перечне: фикс-раунд 4 насчитал ПЯТЬ, пропустив четвёртого, — а ценен докблок
 * именно инструкцией «проверь остальных», и перечень с пропуском её подводит.
 *
 * Двое из шести живут в `routines/*` и читают доверенность из типизированного `RoutineProps`
 * — там расхождение константы с адресом не компилируется. Литеральные читатели, до которых
 * константа дойти не может (`@orbis/shared`, `legacy-field-map.ts`), связаны с ней пином в
 * `confirmation.test.ts` («адреса доверенности ≡ реестр»).
 *
 * Режим отдельной константой рядом со списком: у НАБОРА, кладущегося целиком, значимы оба, но
 * по-разному (`autonomyArmed` ниже), а у ПАТЧА значим сам факт правки любого из двух.
 */
export const ROUTINE_MODE_PROPERTY = 'orbis/routine_mode';
export const ROUTINE_TOOLS_PROPERTY = 'orbis/allowed_tools';
export const AUTONOMY_PROPERTIES: readonly string[] = [
  ROUTINE_MODE_PROPERTY,
  ROUTINE_TOOLS_PROPERTY,
];

/**
 * Выдаёт ли одна операция автономию рутине (V1.10): `mode: 'act'` — это доверенность писать
 * в граф без спроса, а `allowed_tools` — её область. Правка ЛЮБОГО из двух полей считается
 * выдачей, включая возврат в `propose`: разоружение рутины владелец обязан видеть так же,
 * как её вооружение, иначе модель тихо снимала бы права, о которых он думает, что они есть.
 * Правка расписания (`at`, `days`) и жизненного цикла (`stage`) доверенности не касается.
 *
 * Имя тула — единственный вход помимо payload'а: у attach-пути (`attach_orbis_routine`)
 * аспект в имени, у create/update доверенность лежит в `props` по СВОЙСТВАМ
 * `orbis/routine_mode` и `orbis/allowed_tools` (§А9-1). Прежде она читалась из старой карты
 * (`aspects['orbis/routine']`), и с переводом контрактов тулов замок остался бы висеть на
 * форме, которой модель больше не пользуется, — то есть перестал бы держать.
 *
 * НАБОР ЦЕЛИКОМ (`attach_*`, `entity_create`) и ПАТЧ (`entity_update`) отвечают по-разному, и
 * разница не в строгости, а в том, что видно в самом вызове.
 *  - Патч дописывает свойства в живую запись: значим сам ФАКТ упоминания доверенности, а её
 *    значение — нет (act ↔ propose и правка белого списка — одно решение владельца).
 *  - Набор кладётся ВЕСЬ и потому ОПИСЫВАЕТ СОСТОЯНИЕ: выдача — это `act` ИЛИ НЕПУСТОЙ белый
 *    список (`autonomyArmed` ниже — ОДНА функция с пробой состояния, см. её докблок). Второй
 *    случай — не перестраховка, а закрытая дыра (фикс-раунд 3): молчаливым шагом
 *    `{routine_mode:'propose', allowed_tools:[…]}` модель заранее расширяла доверенность, а
 *    потом просила только режим — и карточка вооружения про инструменты молчала по правилу
 *    «у update молчание значит прежний». Владелец подтверждал `act`, не увидев, ЧЕМ рутина
 *    вооружена. Шума на обычной рутине это не добавляет: `orbis/routine_mode` в аспекте
 *    обязателен, а `orbis/allowed_tools` — нет, и ПУСТОЙ список выдачей не считается.
 *
 * ЧЕГО ЗДЕСЬ НЕ ВИДНО — ещё два пути разоружения, различимые только по СОСТОЯНИЮ цели. Оба
 * держит диспатч (`autonomyChangedByCarrier`, `tools/dispatch.ts`), потому что классификатор
 * §7.10 чист по построению — типизированные факты вызова, без БД:
 *  1. `attach_*` заменяет носитель целиком (§А7-4): уносит свойства, которых нет в его `data`,
 *     и ОБЕСЦЕНИВАЕТ перезаписанные (`act` → `propose` эхом прежнего белого списка). По форме
 *     вызова это неотличимо от безобидного attach на безоружную рутину (рулинг Р-12-2).
 *  2. `entity_update {aspects:{detach:['orbis/routine']}}` снимает САМ НОСИТЕЛЬ, оставляя
 *     значения доверенности в `props` (Р9): рутина исчезает из носителей и перестаёт
 *     работать. У вооружённой это то же разоружение, четвёртым путём.
 *  3. `entity_update {aspects:{attach:['orbis/routine']}}` — зеркало предыдущего и ВЫДАЧА
 *     (рулинг Р-12-5): значения пережили снятие аспекта, вызов возвращает им носитель, и
 *     act-рутина оживает с прежним белым списком — без единого свойства в payload'е. Ветка
 *     `entity_update` ниже смотрит только `props`/`unset` и такого вызова не видит вовсе.
 * Ветка attach ниже спрашивает ровно то, что видно в payload'е.
 *
 * СПИСОК ПУТЕЙ ЗДЕСЬ НЕ ИСЧЕРПЫВАЮЩИЙ, и вот известные непокрытые — ВЫКЛЮЧАТЕЛИ ЖИЗНЕННОГО
 * ЦИКЛА. Рутину делают живой ТРИ условия (`activeRoutines`, `agent-loop/queries.ts`): аспект
 * на строке, `orbis/routine_stage: active` и `NOT archived`. Первое замок держит (Р-12-5
 * выше), два других — нет: ПАУЗА
 * (`entity_update {props:{'orbis/routine_stage':'paused'}}`): модель одной строкой
 * останавливает вооружённую act-рутину, и замок молчит. Это не дыра реформы, а давнее
 * осознанное исключение жизненного цикла (первый абзац: «правка расписания и жизненного цикла
 * доверенности не касается»), и направление риска у него ДРУГОЕ — пауза права модели не
 * расширяет, а сужает: не скрытая эскалация, а скрытая остановка. **Рулинг Р-12-4: в этой
 * задаче НЕ покрывается**, вопрос ушёл владельцу; в части Б политика §7.10 становится данными
 * (`assign_level`), и там это правится строкой правила, а не кодом.
 *
 * РАЗАРХИВАЦИЯ — тот же выключатель и та же семья: `entity_update {id, archived: false}` над
 * вооружённой act-рутиной возвращает её в отбор `activeRoutines`, а классификатор смотрит
 * только `archived === true` (ряд «архивация = мягкое удаление»). Направление здесь, в отличие
 * от паузы, — эскалация, поэтому под Р-12-4 оно не подводится автоматически; путь назван
 * владельцу отдельной строкой отчёта фикс-раунда 5 и ждёт рулинга. Чинить его в этой задаче
 * не поручено.
 *
 * СМОТРЯТСЯ ОБЕ ПОЛОВИНЫ ПАТЧА — `props` И `unset`, и это не симметрия ради симметрии.
 * В старой карте разоружение выражалось значением (`{allowed_tools: null}`) и попадало под
 * то же `'allowed_tools' in routine`; в новой форме снятие — ОТДЕЛЬНЫЙ СПИСОК, и читатель
 * одних `props` пропускал бы `unset: ['orbis/allowed_tools']` мимо замка. Дыра найдена
 * гейт-ревью фикс-раундом 1: `classifyToolCall` при `actorKind: 'ai'` давал на таком входе
 * `execute`, то есть чатовая модель или MCP-агент снимали бы белый список рутины молча, без
 * карточки. Обещание докблока выше («разоружение владелец обязан видеть так же, как
 * вооружение») до этой правки было ложным ровно на новой форме.
 *
 * Свойства адресуются id, а не `key`: у встроенных они совпадают (§А2-1), а подменить
 * встроенное свойство своей строкой с тем же ключом владелец не может — частичный индекс
 * реестра разводит собственные и системные записи по разным namespace'ам. Форма проверяется
 * защитно (input сюда доезжает уже envelope-валидированным, см. докблок factsFromToolCall).
 */
export function grantsRoutineAutonomy(tool: string, input: unknown): boolean {
  if (!isRecord(input)) return false;
  if (tool === 'attach_orbis_routine') {
    return isRecord(input.data) && autonomyArmed(input.data);
  }
  if (tool !== 'entity_create' && tool !== 'entity_update') return false;
  const props = isRecord(input.props) ? input.props : {};
  // Снятия у создания не бывает вовсе: снимать нечего, записи ещё нет, — но носитель
  // кладётся целиком, и правило у него общее с attach (см. шапку).
  if (tool === 'entity_create') return autonomyArmed(props);
  // update: патч дописывает свойства в живую запись, поэтому значим сам ФАКТ правки
  // доверенности, а не значение (act ↔ propose и правка белого списка — одно решение).
  const unset = Array.isArray(input.unset) ? input.unset : [];
  return AUTONOMY_PROPERTIES.some((p) => p in props || unset.includes(p));
}

/**
 * Diff карточки preview (§7.10) для entity_update: новые значения — operations[0].payload
 * журнала §7.8 («как исполнено», после нормализаций), прежние — inverse[0].payload;
 * id — не изменение, исключается. Поле, которого прежде не было, честно даёт
 * before: undefined.
 *
 * Свойства раскрываются ПОШТУЧНО, каждое своей строкой. С §А7-4 они приезжают мешком
 * (`props`, `unset`), и обход по верхним ключам показал бы владельцу одну строку «props:
 * {объект} → {объект}» вместо перечня правок — то есть карточка подтверждения перестала бы
 * называть, что именно подтверждают. Снятое свойство — строка с `after: undefined`, ровно
 * так же, как добавленное даёт `before: undefined`.
 *
 * `aspects` строкой и остаётся: это смена интерпретации (`{attach, detach}`), а не значение
 * свойства, и разбирать её на поля было бы враньём про то, что изменилось.
 */
export function entityUpdatePreviewDiff(
  action: Pick<ActionRecord, 'operations' | 'inverse'>,
): Record<string, { before: unknown; after: unknown }> {
  const after = action.operations[0]?.payload ?? {};
  const before = action.inverse[0]?.payload ?? {};
  const afterProps = (after.props ?? {}) as Record<string, unknown>;
  const beforeProps = (before.props ?? {}) as Record<string, unknown>;
  const diff: Record<string, { before: unknown; after: unknown }> = {};
  for (const [key, value] of Object.entries(after)) {
    if (key === 'id' || key === 'props' || key === 'unset') continue;
    diff[key] = { before: before[key], after: value };
  }
  for (const [propertyId, value] of Object.entries(afterProps)) {
    diff[propertyId] = { before: beforeProps[propertyId], after: value };
  }
  // Снятое операцией: прежнее значение лежит в inverse — им откат его и возвращает
  for (const propertyId of (after.unset ?? []) as string[]) {
    diff[propertyId] = { before: beforeProps[propertyId], after: undefined };
  }
  return diff;
}

/**
 * ВООРУЖЕНА ЛИ рутина этим набором значений: `act`-режим ИЛИ НЕПУСТОЙ белый список.
 *
 * Функция ОДНА на два вопроса, и это не экономия, а требование: «выдаёт ли доверенность
 * набор, кладущийся целиком» (`data` у `attach_*`, `props` у `entity_create`) и «вооружена ли
 * рутина ПО СОСТОЯНИЮ» (`autonomyChangedByCarrier` в `tools/dispatch.ts`, рулинги Р-12-3 и
 * Р-12-5: у навешивания аспекта вопрос задаётся ИТОГОВЫМ значениям) —
 * это один и тот же вопрос, заданный про одно и то же множество значений: носитель, положенный
 * целиком, И ЕСТЬ будущее состояние. Фикс-раунд 3 ответил на них разными формулами (набор
 * считал выдачей само упоминание списка, состояние — только непустой), и владельцу приходила
 * карточка «инструменты: нет» — просьба подтвердить выдачу НИЧЕГО (Н-1 ре-ревью). Разные
 * ответы на один смысл — класс обоих Critical этой ветки.
 *
 * ПУСТОЙ СПИСОК ВООРУЖЕНИЕМ НЕ СЧИТАЕТСЯ: он ничего не разрешает, и рутина с
 * `allowed_tools: []` безоружна ровно так же, как рутина без свойства вовсе.
 *
 * ПАТЧ (`entity_update`) отвечает по-другому, и это не расхождение: там значим сам ФАКТ
 * правки, потому что `{'orbis/allowed_tools': []}` в патче — не «инструментов нет», а
 * «ОТНЯТЬ инструменты у живой рутины». Набор описывает состояние, патч описывает переход.
 */
export function autonomyArmed(values: Record<string, unknown>): boolean {
  const tools = values[ROUTINE_TOOLS_PROPERTY];
  return values[ROUTINE_MODE_PROPERTY] === 'act' || (Array.isArray(tools) && tools.length > 0);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
