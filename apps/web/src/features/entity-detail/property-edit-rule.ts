import { displayText } from '../../lib/registry/format';
import { fieldLabel, type RegistryLookup } from '../../lib/registry/labels';
import type { RouterOutputs } from '../../trpc';
import type { UndoToastRule } from '../undo/undo-toast';

type Entity = RouterOutputs['entity']['get']['entity'];
/** Свободные значения (§7.5 п. 1): прежнее с экрана исчезает, «тем же элементом» его не вернуть — подпись называет его. */
const FREE_VALUE_KINDS: ReadonlySet<string> = new Set([
  'text',
  'number',
  'decimal',
  'date',
  'timestamp',
  'time',
]);
export function propertyEditRule(
  registry: RegistryLookup,
  vars: import('../../trpc').RouterInputs['entity']['update'],
  prior: Entity | undefined,
): UndoToastRule | null {
  if (vars.aspects !== undefined) return null; // аспект — без плашки
  const id = [...Object.keys(vars.props ?? {}), ...(vars.unset ?? [])][0];
  if (id === undefined) return null;
  const def = registry.property(id);
  const label = fieldLabel(registry, id);
  // Ссылка: прежнее значение — id записи, подпись без него честнее uuid; разыменование — хук, а правило вне рендера.
  if (def?.type.kind === 'ref') return { kind: 'always', title: `${label} изменено` };
  const next = displayText(def, vars.props?.[id], registry);
  if (def !== undefined && FREE_VALUE_KINDS.has(def.type.kind))
    return {
      kind: 'free-value',
      title: label,
      prior: displayText(def, prior?.props[id], registry),
      next,
    };
  return { kind: 'if-consequences', title: `${label}: ${next}` }; // закрытый список: статус, флаг, выбор аспекта
}
