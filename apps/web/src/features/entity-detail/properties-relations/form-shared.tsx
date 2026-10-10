import {
  EXTENSION_MANIFESTS,
  effectiveLabel,
  OWNER_LOCALE,
  type PropertyDefinition,
} from '@orbis/shared';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { DraftValue } from '../../../lib/registry/draft-value';
import { type EffectiveRegistry, lookupOf } from '../../../lib/registry/labels';
import { PropertyControl } from '../../../lib/registry/PropertyControl';
import { Button } from '../../../ui/Button';
import {
  acceptRemote,
  buildPatch,
  editField,
  keepLocal,
  observeDraft,
  type PanelDraft,
} from './draft';
import { propertyAccess } from './metadata';
import type { CommandOutcome, Context, Entity, PanelCommand } from './types';

export type SpecialEditor = 'assignment' | 'page' | 'app' | 'navigation';
/** Shell owns immutable submitted snapshot, host epoch, and asynchronous lifecycle.
 * Edits never replace this snapshot. Fresh reconciliation updates entity before result.
 * matches does not establish authorship or produce Undo; differs allows an explicit new Save.
 */
export type FormSubmission = {
  command: PanelCommand;
  result: 'pending' | CommandOutcome;
  reconciliation?: 'matches' | 'differs' | 'unavailable';
};
export type PanelFormProps = {
  entity: Entity;
  registry: EffectiveRegistry;
  context: Context;
  draft: PanelDraft | null;
  onDraftChange: (draft: PanelDraft | null) => void;
  onSubmit: (command: PanelCommand) => void;
  onCancel: () => void;
  onSpecial: (editor: SpecialEditor) => void;
  submission?: FormSubmission;
  onReconcile?: (command: PanelCommand) => void;
  onAcceptCurrent?: () => void;
};
export function submissionLocked(submission?: FormSubmission): boolean {
  return (
    submission?.result === 'pending' ||
    (submission?.result.kind === 'unknown' && submission.reconciliation !== 'differs')
  );
}
/** Errors belong to a controlled editor identity; reopening never inherits old validation. */
export function useFormErrors(editor: PanelDraft['editor'] | string | undefined) {
  const [failure, setFailure] = useState<{
    editor: typeof editor;
    errors?: Record<string, string>;
  }>();
  return [
    failure?.editor === editor ? failure?.errors : undefined,
    (errors: Record<string, string> | undefined) => setFailure({ editor, errors }),
  ] as const;
}
export function contextReason(context: Context): string | undefined {
  return context.readOnly ? 'Только чтение' : context.archived ? 'Запись в архиве' : undefined;
}
export function moduleReason(
  module: PropertyDefinition['module'],
  context: Context,
): string | undefined {
  const ext = context.disabledExtensions.find((id) => id === module);
  return ext
    ? `Расширение «${effectiveLabel(EXTENSION_MANIFESTS[ext].name, OWNER_LOCALE)}» выключено`
    : undefined;
}
export function valueText(value: unknown): string {
  if (value === undefined) return 'Не задано';
  if (typeof value === 'string') return value === '' ? 'Пустая строка' : value;
  return JSON.stringify(value) ?? String(value);
}
export function useObserveForm({
  draft,
  entity,
  registry,
  context,
  onDraftChange,
}: PanelFormProps) {
  useEffect(() => {
    if (!draft || draft.entityId !== entity.id) return;
    const previous = draft.observedContext;
    if (
      draft.latestEntity === entity &&
      draft.latestRegistry === registry &&
      previous.readOnly === context.readOnly &&
      previous.archived === context.archived &&
      previous.disabledExtensions.join('\0') === context.disabledExtensions.join('\0')
    )
      return;
    onDraftChange(observeDraft(draft, entity, registry, context));
  }, [draft, entity, registry, context, onDraftChange]);
}
export function FieldRow({
  form,
  id,
  required = false,
}: {
  form: PanelFormProps;
  id: string;
  required?: boolean;
}) {
  const { draft, entity, registry, context, onDraftChange } = form;
  const lookup = lookupOf(registry);
  const def = lookup.property(id);
  const state = draft?.fields[id];
  const input: DraftValue = state?.input ?? { kind: 'value', value: entity.props[id] };
  const access = propertyAccess(def, context);
  const reason = state?.metadataChanged
    ? 'Определение изменилось; отмените правку поля перед новым вводом'
    : (state?.accessReason ?? access.reason);
  const editing =
    draft && draft.entityId === entity.id && ['values', 'attach'].includes(draft.editor.kind);
  const editable = Boolean(
    editing && access.canSet && access.editor === 'generic' && !state?.metadataChanged,
  );
  const change = (next: DraftValue) => {
    if (draft && !submissionLocked(form.submission)) onDraftChange(editField(draft, id, next));
  };
  return (
    <div
      data-testid={`field-${id}`}
      className="flex flex-col gap-2 rounded-control border border-line p-3"
    >
      <p className="text-sm font-medium">
        {lookup.label(id)}
        {required ? ' · обязательно' : ''}
      </p>
      {def?.status !== 'active' && (
        <p className="text-2xs text-text-muted">
          {def?.status === 'deprecated' ? 'Устаревшее' : 'Предложенное'}
        </p>
      )}
      <fieldset disabled={submissionLocked(form.submission)} className="min-w-0">
        {def &&
        input.kind !== 'unset' &&
        !state?.metadataChanged &&
        !(def.type.kind === 'json' && input.kind === 'value' && input.value === null) ? (
          <PropertyControl
            def={def}
            value={entity.props[id]}
            onChange={() => {}}
            readOnly={!editable}
            selfId={entity.id}
            draft={editing ? { state: input, onChange: change } : undefined}
          />
        ) : (
          <p className="break-words text-sm">
            {input.kind === 'unset'
              ? 'Значение будет снято'
              : input.kind === 'raw'
                ? input.raw
                : input.kind === 'list'
                  ? valueText(input.items)
                  : input.kind === 'value'
                    ? valueText(input.value)
                    : ''}
          </p>
        )}
      </fieldset>
      {moduleReason(def?.module ?? null, context) && (
        <p className="text-sm text-text-muted">{moduleReason(def?.module ?? null, context)}</p>
      )}
      {reason && <p className="text-sm text-text-muted">{reason}</p>}
      {required && !access.canSet && access.editor !== 'assignment' && (
        <p className="text-sm text-text-muted">
          Для обязательного поля нет доступного редактора. Можно попробовать сохранить: сервер
          проверит значение или значение по умолчанию.
        </p>
      )}
      {state?.conflict && (
        <div className="flex flex-col gap-2 text-sm">
          <p>Значение изменилось. Сейчас: {valueText(entity.props[id])}</p>
          <Button onClick={() => draft && onDraftChange(acceptRemote(draft, id))}>
            Принять новое: {lookup.label(id)}
          </Button>
          <Button onClick={() => draft && onDraftChange(keepLocal(draft, id))}>
            Оставить мой ввод: {lookup.label(id)}
          </Button>
        </div>
      )}
      {access.editor === 'assignment' && (
        <Button
          disabled={submissionLocked(form.submission)}
          onClick={() => form.onSpecial('assignment')}
        >
          Назначение: {lookup.label(id)}
        </Button>
      )}
      {access.editor === 'navigation' && (
        <Button
          disabled={submissionLocked(form.submission)}
          onClick={() => form.onSpecial('navigation')}
        >
          Навигация: {lookup.label(id)}
        </Button>
      )}
      {editing && (
        <div className="flex flex-wrap gap-2">
          {access.canUnset && !submissionLocked(form.submission) && (
            <Button size="sm" className="min-h-11" onClick={() => change({ kind: 'unset' })}>
              Снять значение: {lookup.label(id)}
            </Button>
          )}
          {state && (
            <Button
              size="sm"
              className="min-h-11"
              disabled={submissionLocked(form.submission)}
              onClick={() => draft && onDraftChange(acceptRemote(draft, id))}
            >
              Отменить правку: {lookup.label(id)}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
function publicMessage(message: string, registry: EffectiveRegistry): string {
  const lookup = lookupOf(registry);
  return message.replace(/[A-Za-z0-9_][A-Za-z0-9_/-]*/g, (token) => lookup.label(token));
}
export function FormFooter({
  form,
  errors,
  onSave,
  children,
  hideActions = false,
}: {
  form: PanelFormProps;
  errors?: Record<string, string>;
  onSave: () => void;
  children?: ReactNode;
  hideActions?: boolean;
}) {
  const alert = useRef<HTMLParagraphElement>(null);
  const result = form.submission?.result;
  const rejected =
    result && result !== 'pending' && result.kind === 'rejected'
      ? publicMessage(result.message, form.registry)
      : undefined;
  useEffect(() => {
    if (form.submission && rejected) alert.current?.focus();
  }, [rejected, form.submission]);
  const submission = form.submission;
  const unknown = result && result !== 'pending' && result.kind === 'unknown';
  const touched =
    submission?.command.kind === 'values' || submission?.command.kind === 'attach'
      ? [
          ...new Set([
            ...Object.keys(submission.command.patch.props ?? {}),
            ...(submission.command.patch.unset ?? []),
          ]),
        ]
      : [];
  return (
    <div className="flex flex-col gap-3">
      {children}
      {errors &&
        Object.entries(errors).map(([id, message]) => (
          <p key={id} role="alert" className="text-danger text-sm">
            {id === '$editor' ? '' : `${lookupOf(form.registry).label(id)}: `}
            {message}
          </p>
        ))}
      {rejected && (
        <p ref={alert} tabIndex={-1} role="alert" className="text-danger text-sm">
          {rejected}
        </p>
      )}
      {unknown && (
        <div role="status" className="flex flex-col gap-2 text-sm">
          <p>Не удалось подтвердить сохранение. Ввод сохранён.</p>
          {submission?.reconciliation === 'matches' ? (
            <>
              <p>
                Сейчас запись содержит эти изменения. Не удалось подтвердить, какой запрос их
                сохранил.
              </p>
              {form.onAcceptCurrent && (
                <Button onClick={form.onAcceptCurrent}>Принять текущее состояние</Button>
              )}
            </>
          ) : (
            <>
              {submission?.reconciliation === 'unavailable' && (
                <p>Не удалось прочитать текущее состояние. Повторное сохранение недоступно.</p>
              )}
              {submission?.reconciliation === 'differs' && (
                <>
                  <p>Сейчас в записи</p>
                  <dl>
                    {touched.map((id) => (
                      <div key={id}>
                        <dt>{lookupOf(form.registry).label(id)}</dt>
                        <dd>{valueText(form.entity.props[id])}</dd>
                      </div>
                    ))}
                  </dl>
                  <p>Проверьте ввод и сохраните явно ещё раз.</p>
                </>
              )}
              {form.onReconcile && submission && (
                <Button onClick={() => form.onReconcile?.(submission.command)}>
                  Проверить состояние
                </Button>
              )}
            </>
          )}
        </div>
      )}
      {!hideActions && (
        <div className="flex flex-wrap gap-2">
          <Button className="min-h-11" disabled={submissionLocked(submission)} onClick={onSave}>
            Сохранить
          </Button>
          <Button
            className="min-h-11"
            variant="ghost"
            disabled={result === 'pending'}
            onClick={form.onCancel}
          >
            Отменить
          </Button>
        </div>
      )}
    </div>
  );
}
export function checkedPatch(form: PanelFormProps, draft: PanelDraft) {
  if (draft.entityId !== form.entity.id)
    return { ok: false as const, errors: { $editor: 'Открыта другая запись' } };
  return buildPatch(
    observeDraft(draft, form.entity, form.registry, form.context),
    form.registry,
    form.context,
  );
}
