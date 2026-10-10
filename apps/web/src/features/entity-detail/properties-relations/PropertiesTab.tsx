import { useState } from 'react';
import { lookupOf } from '../../../lib/registry/labels';
import { Button } from '../../../ui/Button';
import { startDraft } from './draft';
import {
  checkedPatch,
  contextReason,
  FieldRow,
  FormFooter,
  moduleReason,
  type PanelFormProps,
  submissionLocked,
  useFormErrors,
  useObserveForm,
} from './form-shared';
import { aspectAccess, freePropertyDefinitions, propertyAccess, propertyRows } from './metadata';

export function PropertiesTab(form: PanelFormProps) {
  useObserveForm(form);
  const { entity, registry, context, draft, onDraftChange } = form;
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [errors, setErrors] = useFormErrors(draft?.editor);
  const lookup = lookupOf(registry);
  const shown = propertyRows(entity, registry);
  const existing = new Set(shown.map((row) => row.id));
  // A remote unset removes persisted/carrier rows, never the user's touched input.
  const extraIds = new Set([
    ...selected,
    ...Object.keys(draft?.entityId === entity.id ? draft.fields : {}),
  ]);
  const rows = [
    ...shown,
    ...[...extraIds]
      .filter((id) => !existing.has(id))
      .map((id) => ({
        id,
        carrierIds: [],
        present: false,
        rank: lookup.property(id)?.rank ?? Infinity,
      })),
  ].sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  const displayed = new Set(rows.map((row) => row.id));
  const matches = (id: string) =>
    `${lookup.label(id)} ${lookup.property(id)?.key ?? id}`
      .toLocaleLowerCase()
      .includes(search.toLocaleLowerCase());
  const available = freePropertyDefinitions(entity, registry).filter(
    (def) => !displayed.has(def.id) && matches(def.id),
  );
  function save() {
    if (draft?.editor.kind !== 'values' || submissionLocked(form.submission)) return;
    const result = checkedPatch(form, draft);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors(undefined);
    form.onSubmit({ kind: 'values', entityId: entity.id, patch: result.patch });
  }
  return (
    <section aria-label="Свойства" className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        Поиск свойств
        <input
          className="min-h-11 rounded-control border border-line bg-surface px-3"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      {rows
        .filter((row) => matches(row.id))
        .map((row) => (
          <div key={row.id} className="flex flex-col gap-1">
            <p className="text-2xs text-text-muted">
              {row.carrierIds.length
                ? row.carrierIds.map((id) => lookup.label(id)).join(', ')
                : 'Свободное'}
            </p>
            <FieldRow form={form} id={row.id} />
          </div>
        ))}
      {!draft && (
        <Button
          className="min-h-11"
          disabled={Boolean(contextReason(context)) || submissionLocked(form.submission)}
          onClick={() => onDraftChange(startDraft(entity, registry, { kind: 'values' }, context))}
        >
          Редактировать свойства
        </Button>
      )}
      {contextReason(context) && (
        <p className="text-sm text-text-muted">{contextReason(context)}</p>
      )}
      {!contextReason(context) && !submissionLocked(form.submission) && (
        <details>
          <summary className="min-h-11 cursor-pointer text-sm">Добавить свободное свойство</summary>
          <div className="flex flex-col gap-2">
            {available.map((def) => {
              const access = propertyAccess(def, context);
              const assignmentAccess = aspectAccess(lookup.aspect('orbis/assignment'), context);
              const special =
                access.editor === 'assignment'
                  ? 'assignment'
                  : access.editor === 'navigation'
                    ? 'navigation'
                    : undefined;
              const specialBlocked =
                special === 'assignment' && assignmentAccess.route !== 'assignment';
              const busy = Boolean(draft && draft.editor.kind !== 'values');
              return (
                <div key={def.id} className="flex flex-col gap-1">
                  <Button
                    disabled={!access.canSet || access.editor !== 'generic' || busy}
                    onClick={() => {
                      if (!propertyAccess(def, context).canSet || access.editor !== 'generic')
                        return;
                      setSelected((ids) => [...ids, def.id]);
                      if (!draft)
                        onDraftChange(startDraft(entity, registry, { kind: 'values' }, context));
                    }}
                  >
                    Добавить поле: {lookup.label(def.id)}
                  </Button>
                  {access.reason && <p className="text-sm text-text-muted">{access.reason}</p>}
                  {moduleReason(def.module, context) && (
                    <p className="text-sm text-text-muted">{moduleReason(def.module, context)}</p>
                  )}
                  {special && (
                    <Button
                      disabled={specialBlocked || busy}
                      onClick={() => form.onSpecial(special)}
                    >
                      {special === 'assignment' ? 'Назначение' : 'Навигация'}:{' '}
                      {lookup.label(def.id)}
                    </Button>
                  )}
                  {specialBlocked && assignmentAccess.reason && (
                    <p className="text-sm text-text-muted">{assignmentAccess.reason}</p>
                  )}
                </div>
              );
            })}
          </div>
        </details>
      )}
      {draft?.editor.kind === 'values' && <FormFooter form={form} errors={errors} onSave={save} />}
    </section>
  );
}
