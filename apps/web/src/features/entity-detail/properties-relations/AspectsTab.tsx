import { effectiveLabel, OWNER_LOCALE } from '@orbis/shared';
import { useState } from 'react';
import { lookupOf } from '../../../lib/registry/labels';
import { Button } from '../../../ui/Button';
import {
  type AssignmentDraft,
  AssignmentFields,
  assignmentDraftOf,
  assignmentPatch,
  useAssignmentGrants,
} from '../assignment-form';
import { acceptRemote, editField, keepLocal, observeDraft, startDraft } from './draft';
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
  useResetForm,
  valueText,
} from './form-shared';
import { aspectAccess } from './metadata';

export function AspectsTab(form: PanelFormProps) {
  useObserveForm(form);
  const { entity, registry, context, draft, onDraftChange } = form;
  const [search, setSearch] = useState('');
  const [detach, setDetach] = useState<string>();
  const [errors, setErrors] = useFormErrors(draft?.editor ?? detach);
  useResetForm(form, () => {
    setDetach(undefined);
    setErrors(undefined);
  });
  const lookup = lookupOf(registry);
  const attached = entity.aspects
    .slice()
    .sort(
      (a, b) =>
        (lookup.aspect(a)?.rank ?? Infinity) - (lookup.aspect(b)?.rank ?? Infinity) ||
        a.localeCompare(b),
    );
  const selected =
    draft?.editor.kind === 'attach' ? lookup.aspect(draft.editor.aspectId) : undefined;
  const assignment = { ...assignmentDraftOf(entity) };
  if (draft?.editor.kind === 'assignment') {
    const executor = draft.fields['orbis/executor']?.input;
    const grant = draft.fields['orbis/grant']?.input;
    const mayClose = draft.fields['orbis/may_close']?.input;
    if (executor?.kind === 'value')
      assignment.executor = executor.value === 'agent' ? 'agent' : 'human';
    if (grant?.kind === 'value')
      assignment.grantId = typeof grant.value === 'string' ? grant.value : '';
    if (grant?.kind === 'unset') assignment.grantId = '';
    if (mayClose?.kind === 'value') assignment.mayClose = mayClose.value === true;
    if (mayClose?.kind === 'unset') assignment.mayClose = false;
  }
  // This observer is disabled outside the assignment editor and uses the shared query key.
  const { revoked } = useAssignmentGrants(
    draft?.editor.kind === 'assignment'
      ? assignment
      : { executor: 'human', grantId: '', mayClose: false },
  );
  function assignmentDraft(next: AssignmentDraft) {
    let result =
      draft?.editor.kind === 'assignment'
        ? draft
        : startDraft(entity, registry, { kind: 'assignment' }, context);
    const command = assignmentPatch(entity.id, next);
    for (const [id, value] of Object.entries(command.patch.props ?? {}))
      result = editField(result, id, { kind: 'value', value });
    for (const id of command.patch.unset ?? []) result = editField(result, id, { kind: 'unset' });
    return result;
  }
  const assignmentIds = ['orbis/executor', 'orbis/grant', 'orbis/may_close'];
  const assignmentCandidate =
    draft?.editor.kind === 'assignment' && draft.entityId === entity.id
      ? observeDraft(assignmentDraft(assignment), entity, registry, context)
      : undefined;
  const assignmentConflict = assignmentIds.some((id) => assignmentCandidate?.fields[id]?.conflict);
  function resolveAssignment(choice: 'keep' | 'accept') {
    if (!assignmentCandidate || submissionLocked(form.submission)) return;
    let next = assignmentCandidate;
    // Keep acknowledges remote baselines only; metadata fingerprints and access stay intact.
    // Accept resets the complete generated group, without independent property writes.
    for (const id of assignmentIds)
      next = choice === 'keep' ? keepLocal(next, id) : acceptRemote(next, id);
    onDraftChange(next);
    setErrors(undefined);
  }
  function save() {
    if (!draft || submissionLocked(form.submission)) return;
    if (draft.editor.kind === 'assignment') {
      if (assignment.executor === 'agent' && (!assignment.grantId || revoked)) {
        setErrors({ $editor: 'Выберите живой доступ агента' });
        return;
      }
      const result = checkedPatch(form, assignmentDraft(assignment));
      if (!result.ok) {
        setErrors(result.errors);
        return;
      }
      setErrors(undefined);
      form.onSubmit({ ...assignmentPatch(entity.id, assignment), patch: result.patch });
      return;
    }
    if (draft.editor.kind !== 'attach') return;
    const access = aspectAccess(lookup.aspect(draft.editor.aspectId), context);
    if (!access.canAttach) {
      setErrors({ $editor: access.reason ?? 'Аспект правится специальным редактором' });
      return;
    }
    const result = checkedPatch(form, draft);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors(undefined);
    form.onSubmit({
      kind: 'attach',
      entityId: entity.id,
      aspectId: draft.editor.aspectId,
      patch: result.patch,
    });
  }
  const choices = registry.aspects
    .filter(
      (def) =>
        !entity.aspects.includes(def.id) &&
        !def.service &&
        `${lookup.label(def.id)} ${def.key} ${effectiveLabel(def.description, OWNER_LOCALE)}`
          .toLocaleLowerCase()
          .includes(search.toLocaleLowerCase()),
    )
    .slice()
    .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  return (
    <section aria-label="Аспекты" className="flex flex-col gap-3">
      {attached.map((id) => {
        const def = lookup.aspect(id);
        const access = aspectAccess(def, context);
        return (
          <div key={id} className="flex flex-col gap-2 rounded-control border border-line p-3">
            <p className="text-sm font-medium">{lookup.label(id)}</p>
            {moduleReason(def?.module ?? null, context) && (
              <p className="text-sm text-text-muted">
                {moduleReason(def?.module ?? null, context)}
              </p>
            )}
            {access.reason && <p className="text-sm text-text-muted">{access.reason}</p>}
            {access.canDetach && (
              <Button
                disabled={submissionLocked(form.submission)}
                onClick={() =>
                  form.onRequestAction ? form.onRequestAction(() => setDetach(id)) : setDetach(id)
                }
              >
                Снять: {lookup.label(id)}
              </Button>
            )}
            {access.route !== 'generic' && access.route !== 'readonly' && (
              <Button
                disabled={
                  submissionLocked(form.submission) ||
                  Boolean(form.specialReason?.(access.route as 'assignment' | 'page' | 'app'))
                }
                onClick={() => form.onSpecial(access.route as 'assignment' | 'page' | 'app')}
              >
                Открыть редактор: {lookup.label(id)}
              </Button>
            )}
            {access.route !== 'generic' &&
              access.route !== 'readonly' &&
              form.specialReason?.(access.route) && <p>{form.specialReason(access.route)}</p>}
          </div>
        );
      })}
      {detach && (
        <FormFooter form={form} errors={errors} onSave={() => {}} hideActions>
          <p>Значения свойств сохранятся. Связанные вычисления и правила могут измениться</p>
          <Button
            disabled={submissionLocked(form.submission)}
            onClick={() => {
              const access = aspectAccess(lookup.aspect(detach), context);
              if (!access.canDetach) {
                setErrors({ $editor: access.reason ?? 'Снятие недоступно' });
                return;
              }
              form.onSubmit({ kind: 'detach', entityId: entity.id, aspectId: detach });
            }}
          >
            Подтвердить снятие
          </Button>
          <Button
            disabled={form.submission?.result === 'pending'}
            onClick={() => {
              setDetach(undefined);
              form.onCancel();
            }}
          >
            Не снимать
          </Button>
        </FormFooter>
      )}
      {contextReason(context) && (
        <p className="text-sm text-text-muted">{contextReason(context)}</p>
      )}
      {!draft && !contextReason(context) && (
        <>
          <label className="flex flex-col gap-1 text-sm">
            Поиск аспектов
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="min-h-11 rounded-control border border-line bg-surface px-3"
            />
          </label>
          {choices.map((def) => {
            const access = aspectAccess(def, context);
            return (
              <div key={def.id}>
                <Button
                  className="min-h-11"
                  disabled={
                    access.route === 'readonly' ||
                    submissionLocked(form.submission) ||
                    (access.route !== 'generic' && Boolean(form.specialReason?.(access.route)))
                  }
                  onClick={() => {
                    if (access.route === 'assignment')
                      onDraftChange(startDraft(entity, registry, { kind: 'assignment' }, context));
                    else if (access.route === 'page' || access.route === 'app')
                      form.onSpecial(access.route);
                    else if (access.canAttach)
                      onDraftChange(
                        startDraft(entity, registry, { kind: 'attach', aspectId: def.id }, context),
                      );
                  }}
                >
                  Добавить: {lookup.label(def.id)}
                </Button>
                {moduleReason(def.module, context) && <p>{moduleReason(def.module, context)}</p>}
                {access.route !== 'generic' &&
                  access.route !== 'readonly' &&
                  form.specialReason?.(access.route) && <p>{form.specialReason(access.route)}</p>}
              </div>
            );
          })}
        </>
      )}
      {selected && (
        <>
          <h3 className="text-sm font-medium">{lookup.label(selected.id)}</h3>
          {[
            ...new Set([
              ...selected.properties.map((prop) => prop.propertyId),
              ...Object.keys(draft?.entityId === entity.id ? draft.fields : {}),
            ]),
          ]
            .sort(
              (a, b) =>
                (selected.properties.find((prop) => prop.propertyId === a)?.rank ??
                  lookup.property(a)?.rank ??
                  Infinity) -
                  (selected.properties.find((prop) => prop.propertyId === b)?.rank ??
                    lookup.property(b)?.rank ??
                    Infinity) || a.localeCompare(b),
            )
            .map((id) => {
              const declaration = selected.properties.find((prop) => prop.propertyId === id);
              return (
                <div key={id} className="flex flex-col gap-1">
                  {!declaration && (
                    <p className="text-sm text-text-muted">
                      Поле больше не объявлено выбранным аспектом. Ввод сохранён; определение
                      аспекта изменилось.
                    </p>
                  )}
                  <FieldRow form={form} id={id} required={declaration?.required ?? false} />
                </div>
              );
            })}
          <FormFooter form={form} errors={errors} onSave={save} />
        </>
      )}
      {draft?.editor.kind === 'assignment' && (
        <>
          <AssignmentFields
            draft={assignment}
            onChange={(next) => onDraftChange(assignmentDraft(next))}
            disabled={Boolean(contextReason(context)) || submissionLocked(form.submission)}
          />
          {assignmentConflict && (
            <div className="flex flex-col gap-2 text-sm">
              <p>Назначение изменилось. Сейчас в записи:</p>
              <dl>
                {assignmentIds.map((id) => (
                  <div key={id}>
                    <dt>{lookup.label(id)}</dt>
                    <dd>{valueText(entity.props[id])}</dd>
                  </div>
                ))}
              </dl>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={submissionLocked(form.submission)}
                  onClick={() => resolveAssignment('keep')}
                >
                  Оставить мой ввод назначения
                </Button>
                <Button
                  disabled={submissionLocked(form.submission)}
                  onClick={() => resolveAssignment('accept')}
                >
                  Принять новое назначение
                </Button>
              </div>
            </div>
          )}
          <p className="text-sm">
            {lookup.label('orbis/assignee')}: {valueText(entity.props['orbis/assignee'])}. Имя
            человека в этом редакторе доступно только для чтения.
          </p>
          <FormFooter form={form} errors={errors} onSave={save} />
        </>
      )}
      {draft?.editor.kind === 'attach' && !selected && (
        <>
          <p className="text-sm">
            Определение аспекта неизвестно. Ввод сохранён; отмените правку или выберите аспект
            повторно.
          </p>
          {Object.entries(draft.fields).map(([id, state]) => (
            <p key={id} className="break-words text-sm">
              {lookup.label(id)}:{' '}
              {state.input.kind === 'raw'
                ? state.input.raw
                : state.input.kind === 'value'
                  ? valueText(state.input.value)
                  : state.input.kind === 'list'
                    ? valueText(state.input.items)
                    : 'Значение будет снято'}
            </p>
          ))}
          <FormFooter form={form} errors={errors} onSave={save} />
        </>
      )}
      {!draft && !detach && (errors || form.submission) && (
        <FormFooter form={form} errors={errors} onSave={() => {}} hideActions />
      )}
    </section>
  );
}
