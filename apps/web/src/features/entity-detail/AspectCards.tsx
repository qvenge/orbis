// Свойства записи — форма, ПОСТРОЕННАЯ ПО РЕЕСТРУ (§А9-2), а не по тому, что в записи
// заполнено.
//
// Что это меняет для владельца. Прежде цикл шёл по карте `aspects[аспект][поле]`, то есть по
// ЗАПОЛНЕННЫМ значениям: у задачи без срока строки «Срок» на экране не было вовсе — поставить
// срок из формы было нечем, приходилось звать AI или ждать, пока поле появится само. Теперь
// секцию рисует АСПЕКТ, а строки — его состав свойств из реестра: незаполненные показаны
// пустыми и правятся, порядок — `rank` ссылки аспекта на свойство, контрол — тип свойства
// (`PropertyControl`), право на правку — флаги §А2-5.
//
// Отсюда же и зависимость от снимка: пока реестр не приехал, состав формы неизвестен, и строк
// нет. Рисовать в этот момент «то, что заполнено» значило бы показать ВТОРУЮ форму той же
// записи — короче настоящей и с другим порядком строк.
//
// Правки уезжают НОВОЙ формой (§А1-1): значение — `props` по id свойства, снятие — `unset`,
// снятие аспекта — `aspects.detach`. Старой карты «аспект → поля» этот экран больше не шлёт.
import type { AspectDefinition } from '@orbis/shared';
import { useState } from 'react';
import { FIELD_CLASS } from '../../lib/registry/controls';
import { valueText } from '../../lib/registry/format';
import { aspectLabel, fieldLabel, type RegistryLookup } from '../../lib/registry/labels';
import { PropertyControl } from '../../lib/registry/PropertyControl';
import { useRegistry } from '../../lib/registry/useRegistry';
import { type RouterOutputs, trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { invalidateBudget } from '../budget/useBudget';
import { useEntityUpdate } from './useEntityDetail';

type Entity = RouterOutputs['entity']['get']['entity'];

/**
 * Аспекты, у которых на экране ЕСТЬ СВОЯ карточка (ADE-срез 1): назначение исполнителя
 * (AssignmentCard) и прогон агента (RunsList на тикете, лента шагов на самом прогоне).
 *
 * Дело не в дублировании вида, а в правке. Общая карточка предлагает контрол на каждое
 * правимое свойство, и правка `orbis/executor` в обход инварианта исполнителя (executor=agent
 * ⇔ живой grant, invariants.ts:295-326) отдавала бы VALIDATION на каждом втором нажатии.
 * Свойства прогона от этого не зависят — они `system_writable` и без того только для чтения,
 * — но лента шагов рассказывает о прогоне несравнимо больше, чем девятнадцать строк.
 */
const HIDDEN_ASPECT_CARDS = new Set(['orbis/assignment', 'orbis/agent-run']);

/**
 * Модуль, чьи агрегаты считает сервер и которые протухают от правки любого его свойства.
 *
 * Признак — `module` СВОЙСТВА из реестра, а не список id: остаток конверта двигают и сумма, и
 * категория, и признак плана, и дата операции, а перечисление их руками разъезжалось бы с
 * реестром при каждом новом поле Финансов. Прежде инвалидация висела на одной категории, и
 * правка суммы оставляла бейдж вкладки и остаток конверта вчерашними.
 */
const AGGREGATED_MODULE = 'finance';

/**
 * Тронула ли ОТПРАВЛЕННАЯ правка то, от чего зависят серверные агрегаты.
 *
 * Считается по `vars` мутации, а не по замыканию строки: колбэк исполняется на уровне
 * мутации и переживает размонтирование экрана, а значит обязан решать по тому, ЧТО УЕХАЛО.
 * Снятие (`unset`) двигает агрегаты ровно так же, как запись, — оба списка сюда и входят.
 *
 * ЧЛЕНСТВО В АСПЕКТЕ — ВТОРОЙ ВХОД, и его отсутствие было дефектом. Серверные агрегаты
 * Финансов ключуются не только на значениях, но и на самом факте аспекта
 * (`budget/aggregates.ts`: `spent` считает записи с `orbis/financial`, привязку к конверту
 * снимает `unbindOps` на detach). Пока признак считался по одним `props`/`unset`, «Снять
 * аспект» отвечало `false`: операция выпадала из `spent`, конверт переставал гаситься, а
 * бейдж вкладки жил неверным до перезагрузки страницы — наблюдатель `useBudgetAlertCount`
 * смонтирован в оболочке приложения и сам не протухает.
 *
 * Правка аспекта гасит агрегаты ВСЕГДА, каким бы аспект ни был, и это не перестраховка:
 * зависимость живёт на СЕРВЕРЕ, а не в реестре. `orbis/schedule` не объявляет ни одного
 * свойства модуля Финансов — и всё же его `orbis/recurrence` превращает операцию в шаблон,
 * который `spent` не считает. Правило «по модулю свойств аспекта» пропустило бы ровно этот
 * случай, а список аспектов-исключений в коде разъехался бы с сервером при первом же новом
 * агрегате. Цена ошибки в другую сторону — один лишний `budget.invalidate()` на редкий
 * осознанный жест.
 */
function touchesAggregatedModule(
  reg: RegistryLookup,
  vars: {
    props?: Record<string, unknown>;
    unset?: string[];
    aspects?: { attach?: string[]; detach?: string[] };
  },
): boolean {
  const aspects = vars.aspects;
  if ((aspects?.attach?.length ?? 0) > 0 || (aspects?.detach?.length ?? 0) > 0) return true;
  const touched = [...Object.keys(vars.props ?? {}), ...(vars.unset ?? [])];
  return touched.some((propertyId) => reg.property(propertyId)?.module === AGGREGATED_MODULE);
}

export function AspectCards({ entity }: { entity: Entity }) {
  const utils = trpc.useUtils();
  // Подписи, состав формы и типы контролов — из ОДНОГО снимка на все карточки: он же уходит
  // пропом в строки, чтобы каждая из них не подписывалась на снимок отдельно.
  const registry = useRegistry();
  const { mutation, conflict } = useEntityUpdate(entity.id, {
    /**
     * Агрегаты модуля считает сервер, и `invalidateGraph` о них не знает по построению (он
     * про `entity.query/get/count`) — после правки они протухли.
     *
     * УРОВЕНЬ МУТАЦИИ, а не поштучный колбэк `mutate`: правка «Суммы» и немедленный переход
     * на вкладку Бюджета размонтируют этот экран (роутер рисует только активную вкладку), и
     * поштучный колбэк библиотека не позвала бы вовсе — остаток конверта и бейдж вкладки
     * остались бы вчерашними ровно в том сюжете, ради которого механизм и написан.
     */
    onSettled: (vars) => {
      if (touchesAggregatedModule(registry, vars)) void invalidateBudget(utils);
    },
  });
  const props = entity.props as Record<string, unknown>;

  /**
   * Аспекты записи в порядке реестра. Порядок наблюдаем: секции стоят так же, как строки
   * каталога полей в конструкторе запросов и как поля в промпте, — «как легло в объект»
   * означало бы «как вернул SELECT».
   */
  const attached = new Set(entity.aspects);
  const carriers = (registry.data?.aspects ?? []).filter((a) => attached.has(a.id));

  /**
   * Свойства, у которых на этой записи нет носителя: свои свойства владельца, следы снятых
   * аспектов (Р9: снятие аспекта значений не трогает) и §А10-3 — значение под id свойства,
   * которого в снимке уже нет. Показываются отдельной секцией, а не прячутся: спрятанное
   * значение продолжает участвовать в запросах и агрегатах, и владелец не может ни увидеть
   * его, ни снять.
   *
   * Носителями считаются ВСЕ навешенные аспекты, включая те, у кого своя карточка: иначе
   * девятнадцать свойств прогона всплыли бы в «Свойствах» ровно потому, что их секция скрыта.
   */
  const carried = new Set(carriers.flatMap((a) => a.properties.map((p) => p.propertyId)));
  const free = Object.keys(props)
    .filter((id) => !carried.has(id))
    .sort((a, b) => {
      const ra = registry.property(a)?.rank;
      const rb = registry.property(b)?.rank;
      // Свойства без строки в снимке — последними и по алфавиту: `rank` у них взять негде,
      // а произвольный порядок делал бы секцию разной на двух перезагрузках.
      if (ra === undefined || rb === undefined)
        return (ra === undefined ? 1 : 0) - (rb === undefined ? 1 : 0) || a.localeCompare(b);
      return ra - rb || a.localeCompare(b);
    });

  /**
   * Правка одного свойства. `undefined` из контрола — СНЯТЬ (`unset`), а не «записать
   * пусто»: `null` — законное значение json-свойства, и подмена одного другим навсегда
   * запретила бы его записывать (докблок `entityPropsPatch`).
   *
   * Метка версии шлётся для единообразия с прочими правками экрана; 409 она здесь не даёт
   * никогда — гейт §5.2 стоит под условием `body || bodyDoc` (см. `checksVersion`), и правку
   * свойств сервер проводит по LWW.
   */
  function writeProp(propertyId: string, value: unknown | undefined) {
    mutation.mutate({
      id: entity.id,
      expectedUpdatedAt: entity.updatedAt,
      ...(value === undefined ? { unset: [propertyId] } : { props: { [propertyId]: value } }),
    });
  }

  const row = (propertyId: string) => (
    <PropertyRow
      key={propertyId}
      registry={registry}
      propertyId={propertyId}
      value={props[propertyId]}
      onChange={(v) => writeProp(propertyId, v)}
    />
  );

  return (
    <div className="flex flex-col gap-2">
      {conflict && (
        <p role="alert" className="text-sm text-danger">
          Аспект изменён в другом месте — обновите.
        </p>
      )}
      {/* Notion-style свойства: секция без карточной рамки, значения — тихие контролы
          без бордера (hover подсказывает редактируемость). */}
      {carriers
        .filter((a) => !HIDDEN_ASPECT_CARDS.has(a.id))
        .map((aspect) => (
          <section
            key={aspect.id}
            data-testid={`aspect-${aspect.id}`}
            className="flex flex-col gap-1"
          >
            <div className="flex items-center justify-between">
              <p className="text-2xs font-medium uppercase tracking-wide text-text-muted">
                {aspectLabel(registry, aspect.id)}
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-text-muted"
                // Имя кнопки — ПОДПИСЬЮ аспекта из реестра, а не его id: скринридер читал
                // «Снять orbis/task» ровно там, где заголовок секции рядом подписан словом.
                aria-label={`Снять аспект «${aspectLabel(registry, aspect.id)}»`}
                // Снятие аспекта ЗНАЧЕНИЙ не трогает (Р9): аспект — интерпретация, а не
                // владелец поля, и его снятие не повод терять факт владельца. Строки уедут
                // в секцию «Свойства» — там их и можно снять по одной.
                onClick={() => mutation.mutate({ id: entity.id, aspects: { detach: [aspect.id] } })}
              >
                Снять аспект
              </Button>
            </div>
            <dl className="grid grid-cols-[minmax(7rem,max-content)_1fr] items-center gap-x-3 gap-y-0.5 text-sm">
              {orderedProperties(aspect).map((ref) => row(ref.propertyId))}
            </dl>
          </section>
        ))}
      {free.length > 0 && (
        <section data-testid="aspect-free" className="flex flex-col gap-1">
          <p className="text-2xs font-medium uppercase tracking-wide text-text-muted">Свойства</p>
          <dl className="grid grid-cols-[minmax(7rem,max-content)_1fr] items-center gap-x-3 gap-y-0.5 text-sm">
            {free.map((id) => row(id))}
          </dl>
        </section>
      )}
    </div>
  );
}

/** Состав аспекта в объявленном порядке; при равенстве `rank` — по id (тот же тие-брейк, что у выдачи реестра). */
function orderedProperties(aspect: AspectDefinition): AspectDefinition['properties'] {
  return [...aspect.properties].sort(
    (a, b) => a.rank - b.rank || a.propertyId.localeCompare(b.propertyId),
  );
}

/**
 * Строка «подпись — контрол». Подпись — из реестра ВСЕГДА, включая строку, у которой самого
 * свойства в снимке нет: `fieldLabel` в этом случае показывает сырой адрес, и это честнее
 * пустого места — значение существует.
 */
function PropertyRow({
  registry,
  propertyId,
  value,
  onChange,
}: {
  registry: RegistryLookup;
  propertyId: string;
  value: unknown;
  onChange: (v: unknown | undefined) => void;
}) {
  const def = registry.property(propertyId);
  return (
    <>
      <dt className="text-text-muted">{fieldLabel(registry, propertyId)}</dt>
      <dd>
        {def === undefined ? (
          // Свойства нет в снимке (§А10-3: строка реестра снята, значения остались).
          // Правки нет — тип неизвестен, и любой контрол здесь угадывал бы форму значения.
          <span
            data-testid={`prop-${propertyId}`}
            className="break-words px-2 py-1 text-sm text-text-secondary"
          >
            {valueText(value)}
          </span>
        ) : (
          // Контрол ОДИН на все типы, включая `ref`: пикер категории (K6) переехал в общий
          // `RefField` по цели свойства из реестра (§А6-1) вместе с четырьмя своими копиями
          // на экранах Финансов и импорта.
          <PropertyControl def={def} value={value} onChange={onChange} />
        )}
      </dd>
    </>
  );
}

// Восстановление типа поля из исходного значения (правка идёт как строка из Input).
// Нескалярное сюда не доходит вовсе — такие строки не редактируются (см. `isScalar`).
export function coerce(original: unknown, raw: string): unknown {
  if (typeof original === 'number') return Number(raw);
  if (typeof original === 'boolean') return raw === 'true';
  return raw;
}

/**
 * Строка «поле → значение» с тихой правкой по blur — для СЛОЯ ПРЕДЛОЖЕНИЯ (Ш1.3).
 *
 * Родитель у неё с этой задачи ОДИН: на самой записи строки рисует `PropertyRow` выше, и
 * контрол там выбирается по типу свойства из реестра. У строки предложения такого выбора
 * нет и быть не может: она правит `after` ОПЕРАЦИИ, а адресом там бывает и поле самой
 * записи (`title`, `tags`), у которого строки реестра в срезе А нет вовсе. Поэтому здесь
 * остаётся прежнее правило — «правится то, что скаляр», а тип восстанавливается из
 * исходного значения (`coerce`).
 *
 * Компонент НИЧЕГО не сохраняет сам: `onSave(raw)` отдаёт сырую строку из инпута, а что с
 * ней делать — дело родителя (слой кладёт правку в буфер, потому что граф там двигает
 * «Принять», а не набор в поле).
 */
export function AspectField({
  registry,
  aspectId,
  field,
  value,
  onSave,
}: {
  /**
   * Снимок реестра для подписи поля (§А9-2) — ПРОПОМ, а не своим `useRegistry()` внутри:
   * строк предложения на экране десятки, и свой хук в каждой из них подписал бы на снимок
   * каждую строку.
   */
  registry: RegistryLookup;
  /**
   * Аспект-НОСИТЕЛЬ поля; `undefined` — носителя нет вовсе (поле самой записи в плашке
   * предложения). Работает на два: подсказка резолву подписи (старое имя поля переводится
   * в id свойства по паре «аспект + поле») и различитель в `aria-label` — без него у пяти
   * инпутов подряд одно имя на всех.
   *
   * Пустой строкой «носителя нет» НЕ выражается: `''` — это не аспект, и подставлять его
   * значило бы сказать резолву «носитель есть, вот он», уведя поле записи в сырой ключ
   * (Important-1 гейт-ревью 13a).
   */
  aspectId?: string;
  field: string;
  value: unknown;
  onSave: (raw: string) => void;
}) {
  const initial = String(value ?? '');
  const [draft, setDraft] = useState(initial);
  const [serverValue, setServerValue] = useState(initial);

  // D6c п.3: значение сменилось извне — подхватываем его, но ТОЛЬКО если черновик не
  // трогали. Иначе текст, который владелец печатает прямо сейчас, был бы затёрт. Приём тот
  // же, что у редактора тела (BodyEditor подменяет содержимое только вне фокуса): сравнение
  // с последним известным серверным значением в рендере, а не useEffect на каждый рендер.
  if (initial !== serverValue) {
    setServerValue(initial);
    if (draft === serverValue) setDraft(initial);
  }

  // dt/dd — прямые дети `<dl>`-грида родителя (grid-cols-[auto_1fr]): все инпуты
  // начинаются с одной вертикали независимо от длины лейбла (лейблы выровнены вправо).
  return (
    <>
      <dt className="text-text-muted">{fieldLabel(registry, field, aspectId)}</dt>
      <dd>
        <input
          aria-label={aspectId === undefined ? field : `${aspectId} ${field}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => draft !== initial && onSave(draft)}
          className={FIELD_CLASS}
        />
      </dd>
    </>
  );
}
