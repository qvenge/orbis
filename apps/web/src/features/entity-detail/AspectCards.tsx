import { useState } from 'react';
import { FIELD_CLASS } from '../../lib/registry/controls';
import { fieldLabel, type RegistryLookup } from '../../lib/registry/labels';
import type { RouterOutputs } from '../../trpc';
import { AspectSections } from './AspectSection';
import { SECTION_REPLACED } from './own-cards';

type Entity = RouterOutputs['entity']['get']['entity'];

/**
 * Свойства записи на «Деталях» — секции всех аспектов, кроме тех, чью общую секцию заменяет
 * своя карточка (`SECTION_REPLACED`), и секция «Свойства». Сами секции и их правка — в
 * `AspectSection.tsx`; здесь только выбор «какие» для экрана, где шаблон ничего не размещал.
 */
export function AspectCards({ entity }: { entity: Entity }) {
  return <AspectSections entity={entity} exclude={SECTION_REPLACED} />;
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
      <dt className="text-text-muted">{fieldLabel(registry, field)}</dt>
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
