import {
  type AspectDefinition,
  type ExtensionId,
  isExtensionEnabled,
  type PropertyDefinition,
  type RowRegistry,
} from '@orbis/shared';
import { lazy, Suspense } from 'react';
import { refQueryAst, refTargetOf, useRefTitle } from '../../lib/entity-ref/RefField';
import { invalidateBudget } from '../../lib/invalidate';
import { displayText, valueText } from '../../lib/registry/format';
import { aspectLabel, fieldLabel, type RegistryLookup } from '../../lib/registry/labels';
import { PropertyControl } from '../../lib/registry/PropertyControl';
import { rowRegistryOf, touchesMoneyContract } from '../../lib/registry/row';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import type { AspectSnapshot, Entity } from './AspectSection';
import { propertyEditRule } from './property-edit-rule';
import { useEntityUpdate } from './useEntityDetail';

const ExtensionOffPlaque = lazy(() =>
  import('./ExtensionOffPlaque').then((m) => ({ default: m.ExtensionOffPlaque })),
);
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
 * его сумма на карточках конверта жила неверной до перезагрузки страницы — наблюдатели
 * агрегатов живут дольше экрана и сами не протухают.
 *
 * Правка аспекта гасит агрегаты ВСЕГДА, каким бы аспект ни был, и это не перестраховка:
 * зависимость живёт на СЕРВЕРЕ, а не в реестре. `orbis/schedule` не связывает ни одного слота
 * денежных контрактов — и всё же его `orbis/recurrence` превращает операцию в шаблон, который
 * `spent` не считает. Правило «по привязкам аспекта» пропустило бы ровно этот случай, а список
 * аспектов-исключений в коде разъехался бы с сервером при первом же новом агрегате. Цена ошибки
 * в другую сторону — один лишний `budget.invalidate()` на редкий осознанный жест.
 *
 * Правка значений — по признаку контракта (`touchesMoneyContract`, спека 1б §8.4, Н-5): свойство
 * связано слотом «движения денег» или «конверта». Прежний признак `module === 'finance'` после
 * переноса суммы и даты операции в язык (`module: null`) перестал бы видеть правку суммы.
 */
function touchesMoneyAggregates(
  reg: RowRegistry,
  vars: {
    props?: Record<string, unknown>;
    unset?: string[];
    aspects?: { attach?: string[]; detach?: string[] };
  },
): boolean {
  const aspects = vars.aspects;
  if ((aspects?.attach?.length ?? 0) > 0 || (aspects?.detach?.length ?? 0) > 0) return true;
  return touchesMoneyContract([...Object.keys(vars.props ?? {}), ...(vars.unset ?? [])], reg);
}

/**
 * Правка свойств и аспектов записи из секций — ОДНА обвязка на все секции, что стоят рядом.
 *
 * Подписи, состав формы и типы контролов — из одного снимка реестра: он же уходит пропом в
 * строки, чтобы каждая из них не подписывалась на снимок отдельно.
 */
function useAspectEdits(entity: Entity, snapshot: AspectSnapshot) {
  const utils = trpc.useUtils();
  const { registry, readOnly, disabled } = snapshot;
  const { mutation, conflict } = useEntityUpdate(entity.id, {
    undoToast: (vars, prior) => {
      const key = [...Object.keys(vars.props ?? {}), ...(vars.unset ?? [])][0];
      const def = key ? registry.property(key) : undefined;
      const ast = def ? refQueryAst(refTargetOf(def), '') : null;
      const options = ast ? utils.entity.query.getData({ ast }) : undefined;
      return propertyEditRule(
        registry,
        vars,
        prior,
        (id) =>
          options?.find((entry) => entry.id === id)?.title ??
          utils.entity.get.getData({ id })?.entity.title,
      );
    },
    /**
     * Денежные агрегаты считает сервер, и `invalidateGraph` о них не знает по построению (он
     * про `entity.query/get/count`) — после правки они протухли.
     *
     * УРОВЕНЬ МУТАЦИИ, а не поштучный колбэк `mutate`: правка «Суммы» и немедленный переход
     * на вкладку Бюджета размонтируют этот экран (роутер рисует только активную вкладку), и
     * поштучный колбэк библиотека не позвала бы вовсе — остаток конверта и бейдж вкладки
     * остались бы вчерашними ровно в том сюжете, ради которого механизм и написан.
     */
    onSettled: (vars) => {
      if (touchesMoneyAggregates(rowRegistryOf(registry.data), vars)) void invalidateBudget(utils);
    },
  });

  /**
   * Правка одного свойства. `undefined` из контрола — СНЯТЬ (`unset`), а не «записать
   * пусто»: `null` — законное значение json-свойства, и подмена одного другим навсегда
   * запретила бы его записывать (докблок `entityPropsPatch`).
   *
   * Замка у правки свойства нет: замок текста (ревизия тела, спека скорости §8.1) стоит только у
   * правки тела (см. `checksVersion`), и правку свойств сервер проводит по LWW. Прежняя метка
   * `updatedAt` уходила сюда «для единообразия» и не сверялась никогда — её больше нет.
   */
  function writeProp(propertyId: string, value: unknown | undefined) {
    mutation.mutate({
      id: entity.id,
      ...(value === undefined ? { unset: [propertyId] } : { props: { [propertyId]: value } }),
    });
  }

  // Снятие аспекта ЗНАЧЕНИЙ не трогает (Р9): аспект — интерпретация, а не владелец поля, и его
  // снятие не повод терять факт владельца. Строки уедут в секцию «Свойства» — там их и можно
  // снять по одной.
  function detach(aspectId: string) {
    mutation.mutate({ id: entity.id, aspects: { detach: [aspectId] } });
  }

  return { registry, conflict, readOnly, disabled, writeProp, detach };
}

type AspectEdits = ReturnType<typeof useAspectEdits>;
/**
 * Строки свойств для одного id — общие у секции аспекта и у секции «Свойства».
 *
 * Только чтение — ПО СВОЙСТВУ, а не по секции: сервер отказывает ровно по `module` свойства, и у
 * финансовой записи при выключенных Финансах сумма, валюта, направление и дата (стандартные
 * свойства ядра, `module: null`, Р-7) правятся, а категория — нет. То же правило — в секции
 * «Свойства»: значение, пережившее снятие аспекта, остаётся свойством своего расширения.
 */
function rowFor(entity: Entity, edits: AspectEdits, propertyId: string) {
  const props = entity.props as Record<string, unknown>;
  const module = edits.registry.property(propertyId)?.module;
  return (
    <PropertyRow
      key={propertyId}
      registry={edits.registry}
      propertyId={propertyId}
      selfId={entity.id}
      value={props[propertyId]}
      readOnly={edits.readOnly || !isExtensionEnabled(module, edits.disabled)}
      onChange={(v) => edits.writeProp(propertyId, v)}
    />
  );
}

function ConflictAlert() {
  return (
    <p role="alert" className="text-sm text-danger">
      Аспект изменён в другом месте — обновите.
    </p>
  );
}

/**
 * Секция одного аспекта: подпись, «Снять аспект», строки его состава из реестра. У аспекта
 * выключенного расширения на месте «Снять аспект» — плашка «Расширение «…» выключено — [Включить]»
 * (§8.3): снять такой аспект сервер не даст, а пустое место не сказало бы почему. Плашка стоит
 * здесь, в секции, — одно место и для своих карточек (цель и финансы рисуют секцию своего аспекта),
 * и для общих (`{{cards}}`: проект, репозиторий).
 */
function SectionView({
  entity,
  aspect,
  edits,
}: {
  entity: Entity;
  aspect: AspectDefinition;
  edits: AspectEdits;
}) {
  const label = aspectLabel(edits.registry, aspect.id);
  // Маска несёт только id словаря (`useDisabledExtensions`), поэтому «выключен» значит «аспект
  // известного расширения» — приведение ниже не угадывает.
  const off = !isExtensionEnabled(aspect.module, edits.disabled);
  return (
    // Notion-style свойства: секция без карточной рамки, значения — тихие контролы без бордера
    // (hover подсказывает редактируемость).
    <section data-testid={`aspect-${aspect.id}`} className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <p className="text-2xs font-medium uppercase tracking-wide text-text-muted">{label}</p>
        {!edits.readOnly && !off && (
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-text-muted"
            // Имя кнопки — ПОДПИСЬЮ аспекта из реестра, а не его id: скринридер читал
            // «Снять orbis/task» ровно там, где заголовок секции рядом подписан словом.
            aria-label={`Снять аспект «${label}»`}
            onClick={() => edits.detach(aspect.id)}
          >
            Снять аспект
          </Button>
        )}
      </div>
      {off && (
        <Suspense fallback={null}>
          <ExtensionOffPlaque extension={aspect.module as ExtensionId} readOnly={edits.readOnly} />
        </Suspense>
      )}
      <dl className="grid grid-cols-[minmax(7rem,max-content)_1fr] items-center gap-x-3 gap-y-0.5 text-sm">
        {orderedProperties(aspect).map((ref) => rowFor(entity, edits, ref.propertyId))}
      </dl>
    </section>
  );
}

/**
 * Одна карточка аспекта (`{{card: X}}` для аспекта без своей карточки, §7.3). Ничего — если
 * аспекта на записи нет или реестр ещё не приехал: состав формы без снимка неизвестен (см.
 * заголовок файла).
 */
export function AspectSectionView({
  entity,
  aspectId,
  snapshot,
}: {
  entity: Entity;
  aspectId: string;
  snapshot: AspectSnapshot;
}) {
  const edits = useAspectEdits(entity, snapshot);
  const aspect = entity.aspects.includes(aspectId)
    ? edits.registry.data?.aspects.find((a) => a.id === aspectId)
    : undefined;
  if (aspect === undefined) return null;
  return (
    <div className="flex flex-col gap-2">
      {edits.conflict && <ConflictAlert />}
      <SectionView entity={entity} aspect={aspect} edits={edits} />
    </div>
  );
}

/**
 * Секции всех навешенных аспектов, КРОМЕ `exclude`, и секция «Свойства» — «остальные» карточки
 * (`{{cards}}`, общая карточка «Деталей»). Исключения задаёт вызывающий: размещённые шаблоном
 * через `card:` и аспекты, чью общую секцию заменяет своя карточка (`own-cards.tsx`).
 */
export function AspectSectionsView({
  entity,
  exclude,
  snapshot,
}: {
  entity: Entity;
  exclude: ReadonlySet<string>;
  snapshot: AspectSnapshot;
}) {
  const edits = useAspectEdits(entity, snapshot);
  const { registry } = edits;
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
   * Носителями считаются ВСЕ навешенные аспекты, включая исключённые: иначе девятнадцать
   * свойств прогона всплыли бы в «Свойствах» ровно потому, что их секция скрыта, а поля цели —
   * потому, что шаблон поставил её карточку в другое место.
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

  return (
    <div className="flex flex-col gap-2">
      {edits.conflict && <ConflictAlert />}
      {carriers
        .filter((a) => !exclude.has(a.id))
        .map((aspect) => (
          <SectionView key={aspect.id} entity={entity} aspect={aspect} edits={edits} />
        ))}
      {free.length > 0 && (
        <section data-testid="aspect-free" className="flex flex-col gap-1">
          <p className="text-2xs font-medium uppercase tracking-wide text-text-muted">Свойства</p>
          <dl className="grid grid-cols-[minmax(7rem,max-content)_1fr] items-center gap-x-3 gap-y-0.5 text-sm">
            {free.map((id) => rowFor(entity, edits, id))}
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
  selfId,
  value,
  readOnly,
  onChange,
}: {
  registry: RegistryLookup;
  propertyId: string;
  selfId: string;
  value: unknown;
  readOnly: boolean;
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
        ) : readOnly ? (
          <span
            data-testid={`prop-${propertyId}`}
            className="break-words px-2 py-1 text-sm text-text-secondary"
          >
            {def.type.kind === 'ref' && typeof value === 'string' && value !== '' ? (
              <RefTitle def={def} refId={value} />
            ) : (
              displayText(def, value, registry)
            )}
          </span>
        ) : (
          // Контрол ОДИН на все типы, включая `ref`: пикер категории (K6) переехал в общий
          // `RefField` по цели свойства из реестра (§А6-1) вместе с четырьмя своими копиями
          // на экранах Финансов и импорта.
          <PropertyControl def={def} value={value} onChange={onChange} selfId={selfId} />
        )}
      </dd>
    </>
  );
}

/**
 * Название ссылки в режиме только чтения — той же выдачей, что подпись выбранного у пикера
 * (`useRefTitle`, общий ключ с `RefField`): нового запроса нет, а сырой uuid вместо названия
 * категории владельцу не прочитать. Пока выдача едет — многоточие, не мелькающий uuid.
 */
function RefTitle({ def, refId }: { def: PropertyDefinition; refId: string }) {
  const { title, isPending } = useRefTitle(def, refId);
  return <>{isPending ? '…' : title}</>;
}
