import { effectiveLabel, mirrorPropertyId, OWNER_LOCALE } from '@orbis/shared';
import { useState } from 'react';
import {
  contractTarget,
  implementsContract,
  useEntityOptions,
} from '../../../lib/entity-ref/useEntityOptions';
import { useResolvedRefs } from '../../../lib/entity-ref/useResolvedRefs';
import { FIELD_CLASS } from '../../../lib/registry/controls';
import { lookupOf } from '../../../lib/registry/labels';
import { Button } from '../../../ui/Button';
import { type PanelDraft, startDraft } from './draft';
import {
  checkedPatch,
  contextReason,
  FormFooter,
  type PanelFormProps,
  submissionLocked,
  useFormErrors,
  useObserveForm,
  useResetForm,
} from './form-shared';
import { roleAccess } from './metadata';
import type { Relation, RelationKey } from './types';

export type RelationsTabProps = Omit<PanelFormProps, 'onSpecial'> & {
  relations: readonly Relation[];
  onNavigate: (id: string) => void;
  onShowProperties: (propertyId?: string) => void;
  onOpenBody: () => void;
  /** Shell routes opening another editor through its dirty/unknown action guard. */
  onRequestAction?: (action: () => void) => void;
};
const keyOf = (r: Relation): RelationKey => ({
  source_id: r.sourceId,
  target_id: r.targetId,
  role: r.role,
});
const contains = (rows: readonly Relation[], key: RelationKey) =>
  rows.some(
    (r) => r.sourceId === key.source_id && r.targetId === key.target_id && r.role === key.role,
  );
export function RelationsTab(props: RelationsTabProps) {
  const { entity, relations, registry, context, draft, onDraftChange, onSubmit } = props;
  const [page, setPage] = useState({ id: entity.id, count: 50 });
  const [confirmation, setConfirmation] = useState<{
    entityId: string;
    edge: Relation;
    draft: PanelDraft;
  }>();
  const [term, setTerm] = useState('');
  const form: PanelFormProps = {
    ...props,
    onSpecial: () => {},
    onCancel: () => {
      setConfirmation(undefined);
      props.onCancel();
    },
  };
  useObserveForm(form);
  const editor = draft?.editor.kind === 'relation' ? draft.editor : undefined;
  const confirm = confirmation?.entityId === entity.id ? confirmation : undefined;
  const [errors, setErrors] = useFormErrors(
    confirm ? `${entity.id}:${confirm.edge.id}` : draft?.editor,
  );
  useResetForm(form, () => {
    setConfirmation(undefined);
    setErrors(undefined);
  });
  const lookup = lookupOf(registry);
  const role = editor ? lookup.role(editor.roleId) : undefined;
  const manual = registry.roles
    .filter((r) => roleAccess(r, context).canCreate)
    .slice()
    .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  const locked = submissionLocked(props.submission);
  const controlsLocked =
    locked || Boolean(contextReason(context)) || Boolean(draft && draft.entityId !== entity.id);
  const submitted = props.submission?.command;
  const submittedKey =
    submitted?.kind === 'createRelation' || submitted?.kind === 'deleteRelation'
      ? submitted.key
      : undefined;
  const ids = [
    ...relations.flatMap((r) => [r.sourceId, r.targetId]),
    ...(editor?.otherId ? [editor.otherId] : []),
    ...(submittedKey ? [submittedKey.source_id, submittedKey.target_id] : []),
  ].filter((id) => id !== entity.id);
  const resolved = useResolvedRefs(ids);
  const name = (id: string) =>
    id === entity.id
      ? entity.title
      : (resolved.byId.get(id)?.title ??
        (resolved.failedIds.has(id)
          ? 'Название не загружено'
          : resolved.pendingIds.has(id)
            ? 'Загрузка названия…'
            : 'Запись недоступна'));
  const pair = (key: RelationKey) => {
    const def = lookup.role(key.role);
    return `${def ? effectiveLabel(def.sourceLabel, OWNER_LOCALE) : key.role} — ${name(key.source_id)} → ${def ? effectiveLabel(def.targetLabel, OWNER_LOCALE) : key.role} — ${name(key.target_id)}`;
  };
  const currentContract =
    editor?.side === 'source'
      ? role?.constraints.source_contract
      : role?.constraints.target_contract;
  const otherContract =
    editor?.side === 'source'
      ? role?.constraints.target_contract
      : role?.constraints.source_contract;
  const currentReason =
    currentContract && !implementsContract(registry, entity.aspects, currentContract)
      ? `Текущая запись не реализует контракт «${lookup.contract(currentContract) ? effectiveLabel(lookup.contract(currentContract)?.label ?? {}, OWNER_LOCALE) : currentContract}»`
      : undefined;
  const target = otherContract ? contractTarget(registry, otherContract) : undefined;
  const oriented = (otherId: string): RelationKey => ({
    source_id: editor?.side === 'target' ? otherId : entity.id,
    target_id: editor?.side === 'target' ? entity.id : otherId,
    role: editor?.roleId ?? '',
  });
  const options = useEntityOptions({
    target: target ?? undefined,
    term,
    enabled: Boolean(
      editor &&
        draft?.entityId === entity.id &&
        roleAccess(role, context).canCreate &&
        !currentReason &&
        target !== null &&
        !locked,
    ),
    exclude: [entity.id],
  });
  const choices = options.rows.filter(
    (row) => !row.archived && !contains(relations, oriented(row.id)),
  );
  const selectedKey = editor?.otherId ? oriented(editor.otherId) : undefined;
  const request = (action: () => void) => {
    if (locked) return;
    if (props.onRequestAction) props.onRequestAction(action);
    else if (!draft && !confirm) action();
  };
  function change(roleId: string, side: 'source' | 'target') {
    if (controlsLocked || draft?.entityId !== entity.id) return;
    onDraftChange(startDraft(entity, registry, { kind: 'relation', roleId, side }, context));
    setErrors(undefined);
  }
  function save() {
    if (locked) return;
    if (confirm) {
      const access = roleAccess(lookup.role(confirm.edge.role), context);
      const checked = checkedPatch(form, confirm.draft);
      if (!access.canDelete || !checked.ok) {
        setErrors(!checked.ok ? checked.errors : { $editor: access.reason ?? 'Снятие недоступно' });
        return;
      }
      onSubmit({ kind: 'deleteRelation', entityId: entity.id, key: keyOf(confirm.edge) });
      return;
    }
    if (!draft || !editor) return;
    const checked = checkedPatch(form, draft);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    const access = roleAccess(lookup.role(editor.roleId), context);
    const reason = !access.canCreate
      ? access.reason
      : (currentReason ??
        (!editor.otherId
          ? 'Выберите другую запись'
          : editor.otherId === entity.id
            ? 'Самосвязь запрещена'
            : selectedKey && contains(relations, selectedKey)
              ? 'Такая связь уже существует'
              : target === null
                ? 'Нет доступных реализаций контракта'
                : undefined));
    if (reason) {
      setErrors({ $editor: reason });
      return;
    }
    if (selectedKey) onSubmit({ kind: 'createRelation', entityId: entity.id, key: selectedKey });
  }
  const ordered = [...relations].sort(
    (a, b) =>
      (a.sourceId === entity.id ? 0 : 1) - (b.sourceId === entity.id ? 0 : 1) ||
      (lookup.role(a.role)?.rank ?? Infinity) - (lookup.role(b.role)?.rank ?? Infinity) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
  const visible = ordered.slice(0, page.id === entity.id ? page.count : 50);
  const feedback =
    props.submission?.result !== 'pending' &&
    props.submission?.result.kind === 'unknown' &&
    props.submission.reconciliation === 'differs' &&
    submittedKey;
  const footer = (hideActions = false, actions?: React.ReactNode) => (
    <FormFooter form={form} errors={errors} onSave={save} hideActions={hideActions}>
      {actions}
      {feedback && (
        <div data-testid="submitted-relation">
          <p>
            {lookup.label(submittedKey.role)}: {pair(submittedKey)}
          </p>
          <p>
            {contains(relations, submittedKey)
              ? 'Исходная связь присутствует'
              : 'Исходная связь отсутствует'}
          </p>
        </div>
      )}
    </FormFooter>
  );
  const confirmationUI = confirm && (
    <div className="flex flex-col gap-2">
      <p>{pair(keyOf(confirm.edge))}</p>
      {footer(
        true,
        <>
          <Button disabled={locked} onClick={save}>
            Подтвердить снятие
          </Button>
          <Button disabled={props.submission?.result === 'pending'} onClick={form.onCancel}>
            Отмена
          </Button>
        </>,
      )}
    </div>
  );
  return (
    <section className="flex flex-col gap-3" aria-label="Связи записи">
      <p className="text-sm">
        Показано {visible.length} из {relations.length}
      </p>
      {resolved.failedIds.size > 0 && (
        <div role="alert">
          <p>Не удалось загрузить названия записей</p>
          <Button onClick={resolved.retry}>Повторить загрузку названий</Button>
        </div>
      )}
      {(['source', 'target'] as const).map((side) => (
        <div key={side} className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">{side === 'source' ? 'Исходящие' : 'Входящие'}</h3>
          {visible
            .filter((r) => (r.sourceId === entity.id) === (side === 'source'))
            .map((r) => {
              const def = lookup.role(r.role);
              const otherId = r.sourceId === entity.id ? r.targetId : r.sourceId;
              const neighbor = resolved.byId.get(otherId);
              const propertyId = def ? mirrorPropertyId(def.rules, r.meta) : undefined;
              const resolvedProperty = propertyId ? lookup.property(propertyId) : undefined;
              const access = roleAccess(def, context);
              return (
                <div
                  key={r.id}
                  data-testid={`relation-${r.id}`}
                  className="flex flex-col gap-2 rounded-control border border-line p-3"
                >
                  <p className="text-sm font-medium">
                    {r.role === 'ref' ? 'Ссылка из свойств' : lookup.label(r.role)}
                  </p>
                  {def && (
                    <details className="text-sm text-text-muted">
                      <summary className="min-h-11 cursor-pointer">О роли</summary>
                      <p>{effectiveLabel(def.description, OWNER_LOCALE)}</p>
                      <p>Ключ роли: {def.key}</p>
                    </details>
                  )}
                  <p className="text-sm">{pair(keyOf(r))}</p>
                  {neighbor?.archived && <span className="text-2xs text-text-muted">В архиве</span>}
                  {!neighbor &&
                    !resolved.pendingIds.has(otherId) &&
                    !resolved.failedIds.has(otherId) && (
                      <span className="text-sm text-text-muted">Запись недоступна</span>
                    )}
                  {neighbor && (
                    <Button onClick={() => props.onNavigate(otherId)}>
                      Открыть: {neighbor.title}
                    </Button>
                  )}
                  {!def && <p>Определение роли неизвестно</p>}
                  {def?.constraints.created_by === 'system' && <p>Управляется системой</p>}
                  {r.role === 'ref' && (
                    <>
                      {resolvedProperty && (
                        <p>Свойство из метаданных: {lookup.label(resolvedProperty.id)}</p>
                      )}
                      {r.sourceId === entity.id ? (
                        <Button onClick={() => props.onShowProperties(resolvedProperty?.id)}>
                          Изменить свойство
                        </Button>
                      ) : (
                        <Button onClick={() => props.onNavigate(r.sourceId)}>
                          Открыть запись-источник
                        </Button>
                      )}
                    </>
                  )}
                  {access.canDelete && r.role !== 'ref' && !confirm && (
                    <Button
                      disabled={locked || Boolean(draft && !props.onRequestAction)}
                      onClick={() =>
                        request(() => {
                          setConfirmation({
                            entityId: entity.id,
                            edge: r,
                            draft: startDraft(
                              entity,
                              registry,
                              {
                                kind: 'relation',
                                roleId: r.role,
                                side: r.sourceId === entity.id ? 'source' : 'target',
                                otherId,
                              },
                              context,
                            ),
                          });
                          setErrors(undefined);
                        })
                      }
                    >
                      Снять связь
                    </Button>
                  )}
                  {confirm?.edge.id === r.id && confirmationUI}
                </div>
              );
            })}
        </div>
      ))}
      {visible.length < relations.length && (
        <Button onClick={() => setPage({ id: entity.id, count: visible.length + 50 })}>
          Показать ещё
        </Button>
      )}
      {!editor && !confirm && (
        <Button
          disabled={locked || manual.length === 0 || Boolean(draft && !props.onRequestAction)}
          onClick={() =>
            request(() => {
              const first = manual[0];
              if (first) {
                setTerm('');
                onDraftChange(
                  startDraft(
                    entity,
                    registry,
                    { kind: 'relation', roleId: first.id, side: 'source' },
                    context,
                  ),
                );
              }
            })
          }
        >
          Добавить связь
        </Button>
      )}
      {editor && !confirm && (
        <div className="flex flex-col gap-3">
          <label className="text-sm">
            Роль связи
            <select
              className={FIELD_CLASS}
              value={editor.roleId}
              disabled={controlsLocked}
              onChange={(e) => change(e.target.value, editor.side)}
            >
              {!manual.some((r) => r.id === editor.roleId) && (
                <option value={editor.roleId}>{lookup.label(editor.roleId)}</option>
              )}
              {manual.map((r) => (
                <option key={r.id} value={r.id}>
                  {lookup.label(r.id)} — {effectiveLabel(r.description, OWNER_LOCALE)} ({r.key})
                </option>
              ))}
            </select>
          </label>
          {role && (
            <div className="text-sm text-text-muted">
              <p>{effectiveLabel(role.description, OWNER_LOCALE)}</p>
              <p>Ключ роли: {role.key}</p>
            </div>
          )}
          <label className="text-sm">
            Сторона текущей записи
            <select
              className={FIELD_CLASS}
              value={editor.side}
              disabled={controlsLocked}
              onChange={(e) =>
                change(editor.roleId, e.target.value === 'target' ? 'target' : 'source')
              }
            >
              <option value="source">
                {role ? effectiveLabel(role.sourceLabel, OWNER_LOCALE) : 'Источник'}
              </option>
              <option value="target">
                {role ? effectiveLabel(role.targetLabel, OWNER_LOCALE) : 'Цель'}
              </option>
            </select>
          </label>
          {currentReason && <p>{currentReason}</p>}
          {target === null && <p>Нет доступных реализаций контракта</p>}
          <label className="text-sm">
            Поиск записи
            <input
              className={FIELD_CLASS}
              value={term}
              disabled={controlsLocked}
              onChange={(e) => setTerm(e.target.value)}
            />
          </label>
          {options.isPending && <p role="status">Поиск…</p>}
          {options.isError && (
            <div role="alert">
              Не удалось выполнить поиск<Button onClick={options.retry}>Повторить поиск</Button>
            </div>
          )}
          {choices.map((row) => (
            <Button
              key={row.id}
              disabled={locked}
              onClick={() => {
                if (draft && editor && draft.entityId === entity.id && !locked)
                  onDraftChange({ ...draft, editor: { ...editor, otherId: row.id } });
              }}
            >
              Выбрать: {row.title}
            </Button>
          ))}
          {!options.isPending &&
            !options.isError &&
            choices.length === 0 &&
            target !== null &&
            !currentReason && <p>Ничего не найдено</p>}
          {options.mayHaveMore && <p>Уточните поиск: показано до 20 записей</p>}
          {selectedKey && <p data-testid="relation-preview">{pair(selectedKey)}</p>}
          {footer()}
        </div>
      )}
      {confirm && !visible.some((row) => row.id === confirm.edge.id) && confirmationUI}
      {!editor && !confirm && props.submission && footer(true)}
      <p className="text-sm text-text-muted">Ссылки в тексте изменяются в тексте записи</p>
      <Button onClick={props.onOpenBody}>Открыть текст записи</Button>
    </section>
  );
}
