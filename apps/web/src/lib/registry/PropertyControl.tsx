// apps/web/src/lib/registry/PropertyControl.tsx
//
// Один контрол свойства — по ТИПУ из реестра (§А2-2/§А9-2).
//
// Живёт в `lib/`, а не в карточках записи, потому что потребителей у него будет больше
// одного экрана: форма записи сегодня, формы модулей — с Задачи 13c. Зависимости у него
// ровно две — снимок реестра (через проп `def`) и чип ссылки; ни запросов, ни знания о том,
// куда уедет правка, в нём нет: `onChange` отдаёт значение, а что с ним делать — дело
// родителя (на записи это `entity.update`, в слое предложения — буфер правок).
//
// Zod/ajv здесь НЕТ и не будет (гейт задачи): границы типа проверяет валидатор записи на
// сервере, а схема на клиенте — это и вторая правда о допустимом, и вес схемы в первом
// кадре записи.
import {
  type AspectDefinition,
  effectiveLabel,
  OWNER_LOCALE,
  type PropertyDefinition,
} from '@orbis/shared';
import { Check } from 'lucide-react';
import { useState } from 'react';
import { EntityRef } from '../entity-ref/EntityRef';
import { RefField } from '../entity-ref/RefField';
import {
  COMPUTED_NOTE,
  type ControlKind,
  controlKindOf,
  controlText,
  FIELD_CLASS,
  parseControlValue,
  writeModeOf,
} from './controls';
import { displayText, EMPTY_TEXT } from './format';
import { aspectLabel } from './labels';
import { useRegistry } from './useRegistry';

/**
 * Контрол свойства.
 *
 * `readOnly` — решение РОДИТЕЛЯ (строка чужой записи, слой без права правки), а флаги
 * реестра компонент читает сам: право на запись — свойство ОБЪЯВЛЕНИЯ, и спрашивать его у
 * каждого вызывающего значило бы завести столько ответов, сколько экранов.
 *
 * `onChange(undefined)` означает СНЯТЬ свойство (§А1-1: `unset`), а не «записать пусто».
 */
export function PropertyControl({
  def,
  value,
  onChange,
  readOnly = false,
}: {
  def: PropertyDefinition;
  value: unknown;
  onChange: (v: unknown | undefined) => void;
  readOnly?: boolean;
}) {
  const label = effectiveLabel(def.label, OWNER_LOCALE);
  const mode = writeModeOf(def);
  const kind = controlKindOf(def);
  const locked = readOnly || mode !== 'editable' || kind === 'readonly';

  if (locked) {
    return (
      <span
        data-testid={`prop-${def.id}`}
        data-kind={kind}
        className="flex flex-wrap items-baseline gap-2 break-words px-2 py-1 text-sm text-text-secondary"
      >
        {kind === 'ref' && typeof value === 'string' && value !== '' ? (
          <EntityRef id={value} />
        ) : def.type.kind === 'ref' && Array.isArray(value) && value.length > 0 ? (
          // Список ссылок (срез 1а, «Главнее, чем») — по чипу на ссылку: сырые uuid через
          // запятую владельцу не прочитать.
          value
            .filter((id): id is string => typeof id === 'string' && id !== '')
            .map((id) => <EntityRef key={id} id={id} />)
        ) : kind === 'aspects-many' ? (
          <AspectsText def={def} value={value} />
        ) : (
          displayText(def, value)
        )}
        {/* Пометка — только у КЭША ВЫЧИСЛЕНИЯ (`model_writable: false`). У системного
            свойства её нет намеренно: «вычисляется» о поле, которое пишет импорт или
            глагол исполнителя, было бы неправдой, а два флага — два разных ответа
            владельцу на вопрос «почему я не могу это поправить». */}
        {mode === 'computed' && !readOnly && (
          <span className="text-2xs text-text-muted">{COMPUTED_NOTE}</span>
        )}
      </span>
    );
  }

  /**
   * Ссылка правится ПИКАЛКОЙ по цели свойства (§А6-1, ref Р6) — той же, что стоит в формах
   * Финансов и в сверке импорта. До Задачи 13c `ref` попадал в ветку `locked` выше: цель
   * жила только в реестре, а спросить у неё список было нечем, и владелец видел ссылку, но
   * не мог её сменить. ЧИТАЕТСЯ она по-прежнему чипом (`EntityRef`) — в ветке `locked`:
   * `orbis/parent_project` и `orbis/root_project` считает правило (`model_writable: false`),
   * и пикер у них означал бы обещание правки, которую сервер отвергнет.
   */
  if (kind === 'ref') return <RefField def={def} label={label} value={value} onChange={onChange} />;
  if (kind === 'boolean')
    return <BooleanControl def={def} label={label} value={value} onChange={onChange} />;
  if (kind === 'select')
    return <SelectControl def={def} label={label} value={value} onChange={onChange} />;
  if (kind === 'select-many')
    return <SelectManyControl def={def} label={label} value={value} onChange={onChange} />;
  if (kind === 'aspects-many')
    return <AspectsManyControl def={def} label={label} value={value} onChange={onChange} />;
  return <TextControl def={def} label={label} kind={kind} value={value} onChange={onChange} />;
}

/**
 * Тип элемента `<input>` по роду контрола. `timestamp` набирается ТЕКСТОМ, а не
 * `datetime-local`, и это не лень: момент хранится полным ISO с зоной, а
 * `datetime-local` работает с локальным временем без неё — round-trip через него молча
 * сдвигал бы момент на смещение зоны читателя. `date` и `time` таких потерь не несут:
 * их значения и есть 'YYYY-MM-DD' и 'HH:MM'.
 */
const INPUT_TYPE: Record<string, string> = {
  number: 'number',
  date: 'date',
  time: 'time',
};

function BooleanControl({
  def,
  label,
  value,
  onChange,
}: {
  def: PropertyDefinition;
  label: string;
  value: unknown;
  onChange: (v: unknown | undefined) => void;
}) {
  /**
   * Снятие галочки пишет `false`, а НЕ снимает свойство, и это отличие от текстовых
   * контролов намеренное: у булева «пусто» не состояние, а `false` — полноценный ответ
   * «нет». Снятие галочки как `unset` означало бы, что записать «нет» формой нельзя
   * вообще, а `default` свойства (РП-9) отсутствие поля НЕ отменяет — то есть «нет» и
   * «не сказано» на чтении разошлись бы.
   */
  return (
    <input
      type="checkbox"
      aria-label={label}
      data-testid={`prop-${def.id}`}
      data-kind="boolean"
      className="size-4 accent-accent"
      checked={value === true}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

function SelectControl({
  def,
  label,
  value,
  onChange,
}: {
  def: PropertyDefinition;
  label: string;
  value: unknown;
  onChange: (v: unknown | undefined) => void;
}) {
  const options = def.type.kind === 'select' ? def.type.options : [];
  const current = typeof value === 'string' ? value : '';
  const known = current === '' || options.some((o) => o.key === current);
  return (
    <select
      aria-label={label}
      data-testid={`prop-${def.id}`}
      data-kind="select"
      className={FIELD_CLASS}
      value={current}
      onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
    >
      {/* Пустой вариант — единственный способ СНЯТЬ значение из формы, и стоит он первым
          даже у заполненного поля: без него выбранный однажды вариант нельзя было бы
          убрать вовсе. */}
      <option value="">{EMPTY_TEXT}</option>
      {/* Вариант, которого нет в словаре: он есть В ДАННЫХ (снят из реестра, §А10-3), и
          без своей опции `select` показал бы пустоту и первым же изменением молча
          переставил бы значение — та же беда, что у пикера категории. */}
      {!known && <option value={current}>{current}</option>}
      {[...options]
        .sort((a, b) => a.rank - b.rank)
        .map((o) => (
          <option key={o.key} value={o.key}>
            {effectiveLabel(o.label, OWNER_LOCALE)}
          </option>
        ))}
    </select>
  );
}

function SelectManyControl({
  def,
  label,
  value,
  onChange,
}: {
  def: PropertyDefinition;
  label: string;
  value: unknown;
  onChange: (v: unknown | undefined) => void;
}) {
  const options = def.type.kind === 'select' ? def.type.options : [];
  const chosen = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
  /**
   * Пустой список уезжает СНЯТИЕМ, а не `[]`. Разница видна на чтении: `has(свойство)` у
   * пустого массива истинно, и рутина с `allowed_tools: []` читалась бы как рутина со
   * списком прав — пустым, но объявленным.
   */
  const toggle = (key: string) => {
    const next = chosen.includes(key) ? chosen.filter((k) => k !== key) : [...chosen, key];
    // Порядок вариантов — реестровый, а не порядок нажатий: `days` сверяются вхождением,
    // и «пт, пн» читалось бы как расписание, которого нет.
    const ordered = options.filter((o) => next.includes(o.key)).map((o) => o.key);
    onChange(ordered.length === 0 ? undefined : ordered);
  };
  return (
    <fieldset
      aria-label={label}
      data-testid={`prop-${def.id}`}
      data-kind="select-many"
      className="flex flex-wrap gap-1 px-2 py-1"
    >
      {[...options]
        .sort((a, b) => a.rank - b.rank)
        .map((o) => {
          const on = chosen.includes(o.key);
          return (
            <label
              key={o.key}
              className={`flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition ${
                on ? 'border-accent text-accent' : 'border-line text-text-muted'
              }`}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={on}
                onChange={() => toggle(o.key)}
              />
              {effectiveLabel(o.label, OWNER_LOCALE)}
            </label>
          );
        })}
    </fieldset>
  );
}

/** Показ списка аспектов подписями (строка только для чтения): реестр — у хука, а не у пропа. */
function AspectsText({ def, value }: { def: PropertyDefinition; value: unknown }) {
  const registry = useRegistry();
  return <>{displayText(def, value, registry)}</>;
}

/** Подсказка у последнего аспекта при `minItems` (РП-27): снять все — путь меню «⋯», не чип. */
const ASPECTS_MIN_HINT = 'сделать черновиком: ⋯ → «Сделать шаблоном для…» → снять все';

/**
 * Список аспектов чипами (срез 1а §3.2, «Шаблон для») — по образцу `SelectManyControl`: словарь
 * закрыт (аспекты реестра), порядок — `rank`, подпись — из реестра в локали владельца.
 *
 * `minItems` соблюдается ГЕНЕРИЧЕСКИ, а не знанием о «Шаблон для» (РП-27): при `minItems: n` у
 * выбранных `n` чипов снятие закрыто — иначе контрол отправил бы список, который сервер отвергнет
 * (`VALIDATION` по `minItems`), и поле выглядело бы «не сохранилось». Без `minItems` снятие
 * последнего уезжает СНЯТИЕМ (`undefined`), а не `[]`: пустой список — «присутствует» (Ф-1а-3).
 */
export function AspectsManyControl({
  def,
  label,
  value,
  onChange,
  offered,
}: {
  def: PropertyDefinition;
  label: string;
  value: unknown;
  onChange: (v: unknown | undefined) => void;
  /**
   * Какие аспекты предлагать чипами; без него — все аспекты снимка. Диалог «Сделать шаблоном
   * для…» (меню ⋮) прячет служебные и сам `orbis/page`: шаблон для страниц или для прогонов
   * агента — не то, что владелец собирает руками. Уже выбранный, но не предложенный id остаётся в
   * значении по тому же правилу, что id вне снимка ниже, — и виден чипом с пометкой «скрытый»,
   * который снимается как любой другой (остаток 1а №31): иначе «снять все» его не снимало бы, а
   * страница оставалась шаблоном для аспекта, которого владелец не видит. Добавить такой аспект
   * заново нельзя — среди предложенных его нет.
   */
  offered?: (aspect: AspectDefinition) => boolean;
}) {
  const registry = useRegistry();
  const aspects = [...(registry.data?.aspects ?? [])]
    .filter((a) => offered === undefined || offered(a))
    .sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key));
  const minItems = def.type.kind === 'registry_ref' ? (def.type.minItems ?? 0) : 0;
  const chosen = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
  // Пустое значение — не «на пороге»: свойства нет вовсе, и первый чип его заводит.
  const atFloor = minItems > 0 && chosen.length > 0 && chosen.length <= minItems;
  const toggle = (id: string) => {
    const on = chosen.includes(id);
    if (on && atFloor) return;
    const next = on ? chosen.filter((k) => k !== id) : [...chosen, id];
    // Порядок — реестровый, а не порядок нажатий: набор аспектов сравнивается вхождением, и
    // одно и то же множество не должно давать два разных значения в журнале.
    const known = aspects.filter((a) => next.includes(a.id)).map((a) => a.id);
    // Id, которых в снимке нет (аспект снят, реестр ещё едет) или которые не предложены, остаются
    // в значении: выбросить их молча значило бы стереть факт владельца правкой соседнего чипа.
    // Скрытый выбранный при этом виден чипом ниже и снимается сам (№31).
    const ordered = [...known, ...next.filter((id) => !known.includes(id))];
    onChange(ordered.length === 0 ? undefined : ordered);
  };
  const offeredIds = new Set(aspects.map((a) => a.id));
  // Пока снимок едет, предложенных нет вовсе — и «скрытым» оказался бы каждый выбранный.
  const hiddenChosen =
    registry.data === undefined ? [] : chosen.filter((id) => !offeredIds.has(id));
  const chip = (id: string, text: string, on: boolean, hidden: boolean) => {
    const locked = on && atFloor;
    return (
      // Выбранный чип виден не одной обводкой (Л-4 живой приёмки 1а: тонкую рамку глаз не
      // различал) — заливкой и галочкой; `data-state` — тот же признак для тестов и стилей.
      // Чекбокс спрятан (`sr-only`), поэтому видимый фокус несёт метка.
      <label
        key={id}
        data-state={on ? 'on' : 'off'}
        {...(hidden && { 'data-hidden': 'true' })}
        className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/50 ${
          on ? 'border-accent bg-accent/10 text-accent' : 'border-line text-text-muted'
        } ${locked ? 'cursor-not-allowed' : 'cursor-pointer'}`}
      >
        <input
          type="checkbox"
          className="sr-only"
          checked={on}
          disabled={locked}
          onChange={() => toggle(id)}
        />
        {on && <Check size={12} aria-hidden data-testid="chip-check" />}
        {text}
        {hidden && <span className="text-2xs text-text-muted">скрытый</span>}
      </label>
    );
  };
  return (
    <fieldset
      aria-label={label}
      data-testid={`prop-${def.id}`}
      data-kind="aspects-many"
      className="flex flex-wrap items-center gap-1 px-2 py-1"
    >
      {aspects.map((a) =>
        chip(a.id, effectiveLabel(a.label, OWNER_LOCALE), chosen.includes(a.id), false),
      )}
      {/* Выбранные, но не предложенные (служебный аспект, id вне снимка) — в порядке значения. */}
      {hiddenChosen.map((id) => chip(id, aspectLabel(registry, id), true, true))}
      {atFloor && <span className="text-2xs text-text-muted">{ASPECTS_MIN_HINT}</span>}
    </fieldset>
  );
}

function TextControl({
  def,
  label,
  kind,
  value,
  onChange,
}: {
  def: PropertyDefinition;
  label: string;
  kind: ControlKind;
  value: unknown;
  onChange: (v: unknown | undefined) => void;
}) {
  const initial = controlText(value);
  const [draft, setDraft] = useState(initial);
  const [serverValue, setServerValue] = useState(initial);

  // Значение сменилось извне (наш же save, чекбокс «Готово» в шапке, правка с другого
  // устройства) — подхватываем, но ТОЛЬКО если черновик не трогали: иначе текст, который
  // владелец печатает прямо сейчас, был бы затёрт. Тот же приём, что у редактора тела и у
  // строки предложения; сравнение с последним известным серверным значением в рендере, а
  // не useEffect на каждый рендер.
  if (initial !== serverValue) {
    setServerValue(initial);
    if (draft === serverValue) setDraft(initial);
  }

  return (
    <input
      type={INPUT_TYPE[kind] ?? 'text'}
      {...(kind === 'decimal' ? { inputMode: 'decimal' as const } : {})}
      aria-label={label}
      data-testid={`prop-${def.id}`}
      data-kind={kind}
      className={FIELD_CLASS}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft === initial) return;
        const parsed = parseControlValue(def, draft);
        // Нечитаемое значение НЕ отправляется и НЕ стирает поле: черновик остаётся на
        // экране, и владелец видит, что именно он набрал (см. `ControlParse`).
        if (parsed.kind === 'invalid') return;
        onChange(parsed.kind === 'unset' ? undefined : parsed.value);
      }}
    />
  );
}
