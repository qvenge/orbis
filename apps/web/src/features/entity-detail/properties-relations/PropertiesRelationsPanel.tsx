import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { lookupOf } from '../../../lib/registry/labels';
import { useNoteRegistryVersion, useRegistry } from '../../../lib/registry/useRegistry';
import { mayLeave, registerLeaveGuard } from '../../../state/leave-guard';
import { useNav } from '../../../state/navigation';
import { trpc } from '../../../trpc';
import { Button } from '../../../ui/Button';
import { Dialog } from '../../../ui/Dialog';
import { Sheet } from '../../../ui/Sheet';
import { useToast } from '../../../ui/toast-store';
import { useDisabledExtensions } from '../../settings/extension-mask';
import type { PanelHostAction, PanelHostActions, PanelTarget } from '../PropertiesRelationsSlot';
import { detailGetInput } from '../useEntityDetail';
import { usePageIdentityActions } from '../usePageIdentityActions';
import { AspectsTab } from './AspectsTab';
import { editField, type PanelDraft, startDraft } from './draft';
import {
  checkedPatch,
  FormFooterTarget,
  type FormSubmission,
  type PanelFormProps,
  type SpecialEditor,
} from './form-shared';
import { aspectAccess, roleAccess } from './metadata';
import { PropertiesTab } from './PropertiesTab';
import { RelationsTab } from './RelationsTab';
import type { PanelCommand } from './types';
import { usePanelCommands } from './useCommands';

type Tab = 'Аспекты' | 'Свойства' | 'Связи';
const tabs: readonly Tab[] = ['Аспекты', 'Свойства', 'Связи'];
const ownerOf = (draft: PanelDraft): Tab =>
  draft.editor.kind === 'values'
    ? 'Свойства'
    : draft.editor.kind === 'relation'
      ? 'Связи'
      : 'Аспекты';
/** A fresh hook lifetime after explicit finish/discard releases only the old uncertain identity.
 * Its pending async closures still invalidate/Undo their immutable original command. */
function Commands({
  publish,
}: {
  publish: (commands: ReturnType<typeof usePanelCommands>) => void;
}) {
  const commands = usePanelCommands();
  useEffect(() => {
    publish(commands);
  });
  return null;
}
export function PropertiesRelationsPanel({
  target,
  host,
  onClose,
}: {
  target: PanelTarget;
  host: PanelHostActions;
  onClose: () => void;
}) {
  const emptyGate = useRef(null);
  const pageActions = usePageIdentityActions(
    host.pageContext?.entity,
    host.pageContext?.bodyGate ?? emptyGate,
  );
  // Publishing refs does not render the parent; stale bridge ids are refused by the host.
  host.pageContext?.publish({ id: host.pageContext.entity?.id, ...pageActions });
  const get = trpc.entity.get.useQuery(detailGetInput(target.entityId));
  const reg = useRegistry();
  useNoteRegistryVersion(get.data?.registryVersion, get.dataUpdatedAt);
  const disabledExtensions = useDisabledExtensions();
  const latestExecutionContext = useRef({
    readOnly: target.readOnly,
    metadataUnavailable: reg.refreshFailed || reg.versionStale,
  });
  latestExecutionContext.current = {
    readOnly: target.readOnly,
    metadataUnavailable: reg.refreshFailed || reg.versionStale,
  };
  const utils = trpc.useUtils();
  const { show } = useToast();
  const [tab, setTab] = useState<Tab>('Аспекты');
  const tabId = useId();
  const tabRefs = useRef(new Map<Tab, HTMLButtonElement>());
  const continueRef = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState<PanelDraft | null>(null);
  const [localOwner, setLocalOwner] = useState<Tab | null>(null);
  const [submission, setSubmission] = useState<FormSubmission>();
  const [epoch, setEpoch] = useState(0);
  const [footer, setFooter] = useState<HTMLDivElement | null>(null);
  const [confirmation, setConfirmation] = useState<{ action: () => void }>();
  const commandRef = useRef<ReturnType<typeof usePanelCommands> | null>(null);
  const resetters = useRef(new Set<() => void>());
  const registerReset = useCallback((reset: () => void) => {
    resetters.current.add(reset);
    return () => {
      resetters.current.delete(reset);
    };
  }, []);
  const epochRef = useRef(epoch);
  const submissionAttempt = useRef(0);
  const reconciliationRead = useRef(0);
  const mounted = useRef(true);
  const allowing = useRef(false);
  const state = useRef({ draft, localOwner, submission });
  state.current = { draft, localOwner, submission };
  const hostRef = useRef(host);
  hostRef.current = host;
  const pending = () => hostRef.current.pending || state.current.submission?.result === 'pending';
  const dirty = useCallback(
    () =>
      Boolean(
        hostRef.current.pending ||
          state.current.draft ||
          state.current.localOwner ||
          state.current.submission,
      ),
    [],
  );
  function reset() {
    if (pending()) return;
    for (const clear of resetters.current) clear();
    state.current = { draft: null, localOwner: null, submission: undefined };
    setDraft(null);
    setLocalOwner(null);
    setSubmission(undefined);
    epochRef.current += 1;
    submissionAttempt.current += 1;
    reconciliationRead.current += 1;
    setEpoch(epochRef.current);
  }
  function execute(action: () => void) {
    allowing.current = true;
    try {
      action();
    } finally {
      allowing.current = false;
    }
  }
  function request(action: () => void) {
    if (pending()) {
      show('Дождитесь окончания сохранения');
      return;
    }
    if (dirty()) setConfirmation({ action });
    else execute(action);
  }
  const latestRequest = useRef(request);
  latestRequest.current = request;
  useEffect(() => {
    mounted.current = true;
    const off = registerLeaveGuard(() => {
      if (allowing.current) return true;
      if (!dirty()) return true;
      latestRequest.current(() => show('Изменения отброшены — повторите переход'));
      return false;
    });
    const unload = (event: BeforeUnloadEvent) => {
      if (dirty()) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', unload);
    return () => {
      mounted.current = false;
      off();
      window.removeEventListener('beforeunload', unload);
    };
  }, [show, dirty]);
  async function reconcile(command: PanelCommand, ticket = epochRef.current) {
    const submitted = state.current.submission;
    if (
      !submitted ||
      submitted.command !== command ||
      submitted.result === 'pending' ||
      submitted.result.kind !== 'unknown'
    )
      return;
    const attempt = submissionAttempt.current;
    const read = ++reconciliationRead.current;
    const result = await commandRef.current?.reconcile(structuredClone(command));
    if (
      !mounted.current ||
      ticket !== epochRef.current ||
      attempt !== submissionAttempt.current ||
      read !== reconciliationRead.current ||
      state.current.submission?.command !== command ||
      !result
    )
      return;
    // reconcile fetch publishes the fresh detail key before exposing matches/differs.
    const fresh = utils.entity.get.getData(detailGetInput(target.entityId));
    if (result !== 'unavailable' && fresh?.entity.id !== target.entityId) return;
    if (
      state.current.submission.result === 'pending' ||
      state.current.submission.result.kind !== 'unknown'
    )
      return;
    const reconciled = { ...state.current.submission, reconciliation: result };
    state.current.submission = reconciled;
    setSubmission(reconciled);
  }
  if (!get.data || !reg.data || get.data.entity.id !== target.entityId)
    return (
      <Sheet
        open
        side="right"
        size="wide"
        title="Свойства и связи"
        onOpenChange={(open) => {
          if (!open) request(onClose);
        }}
      >
        {get.isError || reg.failed ? (
          <div role="alert" tabIndex={-1} ref={(node) => node?.focus()}>
            <p>Не удалось прочитать запись и определения</p>
            <Button
              onClick={() => {
                void get.refetch();
                reg.retry();
              }}
            >
              Повторить чтение
            </Button>
          </div>
        ) : (
          <p role="status">Загрузка панели…</p>
        )}
      </Sheet>
    );
  const entity = get.data.entity;
  const registry = reg.data;
  const metadataUnavailable = reg.refreshFailed
    ? 'Не удалось обновить определения'
    : reg.versionStale
      ? 'Определения изменились — дождитесь актуальной версии'
      : undefined;
  const context = { readOnly: target.readOnly, archived: entity.archived, disabledExtensions };
  const owner = draft ? ownerOf(draft) : localOwner;
  function change(next: PanelDraft | null) {
    if (pending()) return;
    if (!next) {
      reset();
      return;
    }
    if (next.entityId !== target.entityId) return;
    const previous = state.current.draft;
    const sameEditor =
      previous &&
      ownerOf(previous) === ownerOf(next) &&
      previous.editor.kind === next.editor.kind &&
      (next.editor.kind !== 'attach' ||
        (previous.editor.kind === 'attach' && previous.editor.aspectId === next.editor.aspectId));
    if (metadataUnavailable && !sameEditor) return;
    const apply = () => {
      state.current.draft = next;
      state.current.localOwner = null;
      setDraft(next);
      setLocalOwner(null);
    };
    if (allowing.current || sameEditor || !dirty()) apply();
    else request(apply);
  }
  async function submit(command: PanelCommand) {
    if (
      confirmation ||
      metadataUnavailable ||
      pending() ||
      command.entityId !== target.entityId ||
      context.readOnly ||
      context.archived ||
      !commandRef.current ||
      owner !== tab
    )
      return;
    if (
      submission?.result !== 'pending' &&
      submission?.result.kind === 'unknown' &&
      submission.reconciliation !== 'differs'
    )
      return;
    const lookup = lookupOf(registry);
    let reason: string | undefined;
    if (command.kind === 'detach') {
      const access = aspectAccess(lookup.aspect(command.aspectId), context);
      if (!access.canDetach) reason = access.reason ?? 'Снятие недоступно';
    } else if (command.kind === 'createRelation' || command.kind === 'deleteRelation') {
      const access = roleAccess(lookup.role(command.key.role), context);
      if (
        !(command.kind === 'createRelation' ? access.canCreate : access.canDelete) ||
        ![command.key.source_id, command.key.target_id].includes(target.entityId) ||
        command.key.source_id === command.key.target_id
      )
        reason = access.reason ?? 'Связь недоступна';
    } else {
      let candidate = state.current.draft;
      if (!candidate || candidate.entityId !== entity.id) return;
      for (const [id, value] of Object.entries(command.patch.props ?? {}))
        candidate = editField(candidate, id, { kind: 'value', value });
      for (const id of command.patch.unset ?? [])
        candidate = editField(candidate, id, { kind: 'unset' });
      const checked = checkedPatch(
        {
          entity,
          registry,
          context,
          draft: candidate,
          onDraftChange: change,
          onSubmit: () => {},
          onCancel: reset,
          onSpecial: () => {},
        },
        candidate,
      );
      if (!checked.ok) reason = Object.values(checked.errors).join('; ');
      if (command.kind === 'attach') {
        const access = aspectAccess(lookup.aspect(command.aspectId), context);
        const assignment =
          command.aspectId === 'orbis/assignment' &&
          candidate.editor.kind === 'assignment' &&
          access.route === 'assignment';
        if (!access.canAttach && !assignment) reason = access.reason ?? 'Добавление недоступно';
      }
    }
    if (reason) {
      submissionAttempt.current += 1;
      const next: FormSubmission = {
        command: structuredClone(command),
        result: { kind: 'rejected', message: reason },
      };
      state.current.submission = next;
      setSubmission(next);
      return;
    }
    const snapshot = structuredClone(command);
    submissionAttempt.current += 1;
    const ticket = epochRef.current;
    const next: FormSubmission = { command: snapshot, result: 'pending' };
    state.current.submission = next;
    setSubmission(next);
    const result = await commandRef.current.run(snapshot);
    if (!mounted.current || ticket !== epochRef.current) return;
    const finished = { command: snapshot, result };
    state.current.submission = finished;
    setSubmission(finished);
    if (result.kind === 'confirmed') reset();
    else if (result.kind === 'unknown') void reconcile(snapshot, ticket);
  }
  const hostReady = host.screenEntityId === target.entityId && !target.readOnly;
  function specialReason(editor: SpecialEditor) {
    if (metadataUnavailable) return metadataUnavailable;
    if (editor === 'assignment') return undefined;
    if (!hostReady) return 'Откройте эту запись, чтобы выполнить действие';
    const action =
      editor === 'page'
        ? entity.aspects.includes('orbis/page')
          ? 'stopPage'
          : 'makePage'
        : 'configureApp';
    if (!host.available.has(action)) return 'Действие недоступно в текущем режиме';
    return undefined;
  }
  function hostAction(action: PanelHostAction) {
    if (action !== 'openBody' && metadataUnavailable) return;
    const frozen = { ...target };
    request(() =>
      host.run(action, frozen, (dispatch) => {
        let result = Promise.resolve();
        if (
          action !== 'openBody' &&
          (latestExecutionContext.current.readOnly ||
            latestExecutionContext.current.metadataUnavailable)
        )
          return result;
        // Only this approved gesture skips our own leave guard, synchronously.
        // The async mutation remains locked for every later event/navigation.
        execute(() => {
          if (mayLeave()) result = dispatch();
        });
        return result;
      }),
    );
  }
  function special(editor: SpecialEditor) {
    if (editor === 'assignment')
      change(startDraft(entity, registry, { kind: 'assignment' }, context));
    else
      hostAction(
        editor === 'page'
          ? entity.aspects.includes('orbis/page')
            ? 'stopPage'
            : 'makePage'
          : 'configureApp',
      );
  }
  function form(forTab: Tab): PanelFormProps {
    return {
      metadataUnavailable,
      actionPending: host.pending,
      specialReason,
      registerReset,
      entity,
      registry,
      context,
      draft: owner === forTab ? draft : null,
      onDraftChange: change,
      onSubmit: (command) => {
        if (tab === forTab) void submit(command);
      },
      onCancel: reset,
      onSpecial: special,
      submission: owner === forTab ? submission : undefined,
      onReconcile: (command) => void reconcile(command),
      onAcceptCurrent: reset,
      onRequestAction: (action) => {
        if (metadataUnavailable) return;
        request(() => {
          state.current.localOwner = forTab;
          setLocalOwner(forTab);
          action();
        });
      },
    };
  }
  return (
    <Sheet
      open
      side="right"
      size="wide"
      title="Свойства и связи"
      contentClassName="flex flex-col overflow-hidden gap-3"
      onOpenChange={(open) => {
        if (!open) request(onClose);
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        document.querySelector<HTMLButtonElement>('[data-testid="screen-menu"]')?.focus();
      }}
    >
      <Commands
        key={`command-${epoch}`}
        publish={(commands) => {
          commandRef.current = commands;
        }}
      />
      <header className="pr-8">
        <h2 className="text-base font-medium">{entity.title || entity.id}</h2>
        <p className="break-all text-2xs text-text-muted">{entity.id}</p>
      </header>
      {target.readOnly && <p>Предпросмотр — только чтение</p>}
      {metadataUnavailable && (
        <div role="alert">
          <p>{metadataUnavailable}</p>
          <Button
            onClick={() => {
              void get.refetch();
              reg.retry();
            }}
          >
            Повторить загрузку определений
          </Button>
        </div>
      )}
      {entity.archived && (
        <div>
          <p>Запись в архиве — только чтение</p>
          <Button
            disabled={
              !hostReady ||
              pending() ||
              Boolean(metadataUnavailable) ||
              !host.available.has('restore')
            }
            onClick={() => hostAction('restore')}
          >
            Восстановить запись
          </Button>
        </div>
      )}
      {!hostReady && !target.readOnly && <p>Откройте эту запись, чтобы выполнить действие</p>}
      <div role="tablist" aria-label="Раздел панели" className="flex gap-2">
        {tabs.map((name, index) => (
          <Button
            key={name}
            ref={(node) => {
              if (node) tabRefs.current.set(name, node);
              else tabRefs.current.delete(name);
            }}
            role="tab"
            id={`${tabId}-tab-${index}`}
            aria-controls={`${tabId}-panel-${index}`}
            tabIndex={tab === name ? 0 : -1}
            aria-selected={tab === name}
            disabled={
              pending() ||
              Boolean(submission?.result !== 'pending' && submission?.result.kind === 'unknown')
            }
            onClick={() => setTab(name)}
            onKeyDown={(event) => {
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? tabs.length - 1
                    : event.key === 'ArrowRight'
                      ? (index + 1) % tabs.length
                      : event.key === 'ArrowLeft'
                        ? (index + tabs.length - 1) % tabs.length
                        : null;
              const nextTab = next === null ? undefined : tabs[next];
              if (!nextTab) return;
              event.preventDefault();
              setTab(nextTab);
              tabRefs.current.get(nextTab)?.focus();
            }}
          >
            {name}
          </Button>
        ))}
      </div>
      <fieldset
        disabled={host.pending}
        data-testid="panel-scroll"
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {tabs.map((name, index) => (
          <div
            key={name}
            role="tabpanel"
            id={`${tabId}-panel-${index}`}
            aria-labelledby={`${tabId}-tab-${index}`}
            hidden={tab !== name}
          >
            <FormFooterTarget value={tab === name ? footer : null}>
              {name === 'Аспекты' ? (
                <AspectsTab {...form(name)} />
              ) : name === 'Свойства' ? (
                <PropertiesTab {...form(name)} />
              ) : (
                <RelationsTab
                  {...form(name)}
                  relations={get.data.relations ?? []}
                  onNavigate={(id) => request(() => useNav.getState().openRecord(id))}
                  onShowProperties={() => setTab('Свойства')}
                  onOpenBody={() => hostAction('openBody')}
                />
              )}
            </FormFooterTarget>
          </div>
        ))}
        {tab !== 'Связи' && (
          <Button onClick={() => hostAction('openBody')}>Открыть текст записи</Button>
        )}
        {(['makePage', 'stopPage', 'configureApp'] as const)
          .filter((action) => host.available.has(action))
          .map((action) => (
            <Button
              key={action}
              disabled={!hostReady || pending() || Boolean(metadataUnavailable)}
              onClick={() => hostAction(action)}
            >
              {action === 'makePage'
                ? 'Сделать страницей'
                : action === 'stopPage'
                  ? 'Перестать быть страницей'
                  : 'Настроить приложение'}
            </Button>
          ))}
      </fieldset>
      <div
        ref={setFooter}
        data-testid="panel-footer"
        className="shrink-0 border-t border-line pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      />
      {confirmation && (
        <Dialog
          open
          title="Несохранённые изменения"
          onOpenChange={(open) => {
            if (!open) setConfirmation(undefined);
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            continueRef.current?.focus();
          }}
        >
          <div className="flex flex-col gap-2">
            <p>Есть несохранённые изменения</p>
            <Button ref={continueRef} onClick={() => setConfirmation(undefined)}>
              Продолжить редактирование
            </Button>
            <Button
              onClick={() => {
                const action = confirmation.action;
                setConfirmation(undefined);
                reset();
                execute(action);
              }}
            >
              Отбросить изменения
            </Button>
          </div>
        </Dialog>
      )}
    </Sheet>
  );
}
