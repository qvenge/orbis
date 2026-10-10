import type { AspectDefinition } from '@orbis/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_REGISTRY } from '../../../test/registry';
import { useToastStore } from '../../../ui/toast-store';

afterEach(() => {
  for (const toast of useToastStore.getState().toasts) useToastStore.getState().dismiss(toast.id);
});

import { type EffectiveRegistry, lookupOf } from '../../../lib/registry/labels';
import { renderWithProviders, trpcError } from '../../../test/harness';
import { trpc } from '../../../trpc';
import { useDisabledExtensions } from '../../settings/extension-mask';
import { AspectsTab } from './AspectsTab';
import { editField, type PanelDraft, startDraft } from './draft';
import type { FormSubmission } from './form-shared';
import { PropertiesTab } from './PropertiesTab';
import { context, entity, field, registry } from './test-fixtures';
import type { Context, Entity, PanelCommand } from './types';
import { usePanelCommands } from './useCommands';

const due = field({ kind: 'date' }, 'user/due');
const task = BUILTIN_REGISTRY.aspects.find((a) => a.id === 'orbis/task');
if (!task) throw new Error('task fixture');
const custom: AspectDefinition = {
  ...task,
  id: 'user/aspect',
  key: 'user/aspect',
  label: { ru: 'Свой аспект' },
  properties: [
    { propertyId: due.id, required: true, rank: 0 },
    { propertyId: 'user/title', required: false, rank: 1 },
  ],
};
const customRegistry: EffectiveRegistry = {
  ...registry,
  properties: [...registry.properties, due],
  aspects: [...registry.aspects, custom],
};
function Host({
  tab = 'properties',
  initial = null,
  reg = registry,
  record = entity,
  ctx = context,
  sent = vi.fn(),
}: {
  tab?: 'properties' | 'aspects';
  initial?: PanelDraft | null;
  reg?: EffectiveRegistry;
  record?: Entity;
  ctx?: Context;
  sent?: (c: PanelCommand) => void;
}) {
  const [draft, onDraftChange] = useState(initial);
  const [current, setContext] = useState(ctx);
  const Tab = tab === 'aspects' ? AspectsTab : PropertiesTab;
  return (
    <>
      <button type="button" onClick={() => setContext({ ...current, readOnly: true })}>
        preview
      </button>
      <button type="button" onClick={() => setContext({ ...current, archived: true })}>
        archive
      </button>
      <button
        type="button"
        onClick={() => setContext({ ...current, disabledExtensions: ['finance'] })}
      >
        mask
      </button>
      <output data-testid="draft">{JSON.stringify(draft?.fields)}</output>
      <Tab
        entity={record}
        registry={reg}
        context={current}
        draft={draft}
        onDraftChange={onDraftChange}
        onSubmit={sent}
        onCancel={() => onDraftChange(null)}
        onSpecial={() => {}}
      />
    </>
  );
}
function initialValues(reg = registry, record = entity) {
  return startDraft(record, reg, { kind: 'values' }, context);
}

describe('aspect and property forms', () => {
  it('attaches task with last focused raw due date, without task status defaults', () => {
    const sent = vi.fn();
    renderWithProviders(
      <Host
        tab="aspects"
        initial={startDraft(entity, registry, { kind: 'attach', aspectId: 'orbis/task' }, context)}
        sent={sent}
      />,
    );
    fireEvent.change(screen.getByLabelText(lookupOf(registry).label('orbis/due_date')), {
      target: { value: '2026-10-12' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(sent).toHaveBeenCalledExactlyOnceWith({
      kind: 'attach',
      entityId: entity.id,
      aspectId: 'orbis/task',
      patch: { props: { 'orbis/due_date': '2026-10-12' } },
    });
  });
  it('user due id and two dependent raw fields become one touched patch', () => {
    const sent = vi.fn();
    renderWithProviders(
      <Host
        tab="aspects"
        reg={customRegistry}
        initial={startDraft(
          entity,
          customRegistry,
          { kind: 'attach', aspectId: custom.id },
          context,
        )}
        sent={sent}
      />,
    );
    const fields = screen.getAllByLabelText('Поле теста');
    fireEvent.change(fields[0] as HTMLInputElement, { target: { value: '2026-10-13' } });
    fireEvent.change(fields[1] as HTMLInputElement, { target: { value: '  новое  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(sent).toHaveBeenCalledExactlyOnceWith({
      kind: 'attach',
      entityId: entity.id,
      aspectId: custom.id,
      patch: { props: { 'user/due': '2026-10-13', 'user/title': '  новое  ' } },
    });
  });
  it('required defaultable fields do not block an untouched attach', () => {
    const sent = vi.fn();
    renderWithProviders(
      <Host
        tab="aspects"
        initial={startDraft(entity, registry, { kind: 'attach', aspectId: 'orbis/task' }, context)}
        sent={sent}
      />,
    );
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(sent).toHaveBeenCalledWith({
      kind: 'attach',
      entityId: entity.id,
      aspectId: 'orbis/task',
      patch: {},
    });
  });
  it('detach confirms property retention and sends no value patch', () => {
    const sent = vi.fn();
    renderWithProviders(
      <Host tab="aspects" record={{ ...entity, aspects: ['orbis/task'] }} sent={sent} />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: `Снять: ${lookupOf(registry).label('orbis/task')}` }),
    );
    expect(sent).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        'Значения свойств сохранятся. Связанные вычисления и правила могут измениться',
      ),
    ).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить снятие' }));
    expect(sent).toHaveBeenCalledExactlyOnceWith({
      kind: 'detach',
      entityId: entity.id,
      aspectId: 'orbis/task',
    });
  });
  it('writes one free property without attaching its carrier', () => {
    const sent = vi.fn();
    renderWithProviders(<Host initial={initialValues()} sent={sent} />);
    fireEvent.change(screen.getByLabelText('Поле теста'), { target: { value: 'без blur' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(sent).toHaveBeenCalledExactlyOnceWith({
      kind: 'values',
      entityId: entity.id,
      patch: { props: { 'user/title': 'без blur' } },
    });
    expect(screen.getByText('Свободное')).toBeVisible();
  });
  it.each([
    'preview',
    'archive',
    'mask',
  ])('current %s prevents submission and preserves raw/unset', async (action) => {
    const finance = { ...field({ kind: 'text' }, 'user/money'), module: 'finance' as const };
    const reg = { ...registry, properties: [...registry.properties, finance] };
    const record = { ...entity, props: { 'user/money': 'old' } };
    const sent = vi.fn();
    renderWithProviders(
      <Host reg={reg} record={record} initial={initialValues(reg, record)} sent={sent} />,
    );
    fireEvent.change(screen.getByLabelText('Поле теста'), { target: { value: 'незавершённый' } });
    fireEvent.click(screen.getByText(action));
    await waitFor(() => expect(screen.getByTestId('draft')).toHaveTextContent('незавершённый'));
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(sent).not.toHaveBeenCalled();
    expect(
      screen.getAllByText(
        action === 'mask'
          ? 'Расширение выключено'
          : action === 'archive'
            ? 'Запись в архиве'
            : 'Только чтение',
      )[0],
    ).toBeVisible();
  });
  it('cancel one field returns untouched baseline and keeps another edit', () => {
    const extra = field({ kind: 'text' }, 'user/extra');
    extra.label = { ru: 'Другое поле' };
    const reg = { ...registry, properties: [...registry.properties, extra] };
    const record = { ...entity, props: { ...entity.props, 'user/extra': 'old' } };
    const sent = vi.fn();
    renderWithProviders(
      <Host reg={reg} record={record} initial={initialValues(reg, record)} sent={sent} />,
    );
    fireEvent.change(screen.getByLabelText('Поле теста'), { target: { value: 'cancel me' } });
    fireEvent.change(screen.getByLabelText('Другое поле'), { target: { value: 'keep me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отменить правку: Поле теста' }));
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(sent).toHaveBeenCalledWith({
      kind: 'values',
      entityId: entity.id,
      patch: { props: { 'user/extra': 'keep me' } },
    });
  });
  it.each([
    { model_writable: false },
    { system_writable: true },
    { writer: 'supply' as const },
  ])('write flags prevent clear: %j', (flags) => {
    const def = { ...field({ kind: 'json' }, 'user/json'), flags };
    const reg = { ...registry, properties: [...registry.properties, def] };
    renderWithProviders(<Host reg={reg} record={{ ...entity, props: { 'user/json': null } }} />);
    expect(screen.getByText('null')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Снять значение: Поле теста' }),
    ).not.toBeInTheDocument();
  });
});

const finance = { ...field({ kind: 'text' }, 'user/money'), module: 'finance' as const };
const financeRegistry = { ...registry, properties: [...registry.properties, finance] };
const financeEntity = { ...entity, props: { 'user/money': 'old' } };
describe('carried current-context obligations', () => {
  it.each([
    'raw',
    'unset',
  ] as const)('actual settings mask changes with same entity/registry references: %s retained', async (mode) => {
    let disabled = false;
    const sent = vi.fn();
    function SettingsHost() {
      const [draft, onDraftChange] = useState<PanelDraft | null>(
        initialValues(financeRegistry, financeEntity),
      );
      const utils = trpc.useUtils();
      const disabledExtensions = useDisabledExtensions();
      return (
        <>
          <button
            type="button"
            onClick={() => {
              disabled = true;
              void utils.user.getSettings.invalidate();
            }}
          >
            Disable finance
          </button>
          <output data-testid="draft">{JSON.stringify(draft?.fields)}</output>
          <PropertiesTab
            entity={financeEntity}
            registry={financeRegistry}
            context={{ ...context, disabledExtensions }}
            draft={draft}
            onDraftChange={onDraftChange}
            onSubmit={sent}
            onCancel={() => {}}
            onSpecial={() => {}}
          />
        </>
      );
    }
    const result = renderWithProviders(<SettingsHost />, (path) =>
      path === 'user.getSettings' ? { disabledModules: disabled ? ['finance'] : [] } : {},
    );
    await waitFor(() => expect(result.calls.some((c) => c.path === 'user.getSettings')).toBe(true));
    if (mode === 'raw')
      fireEvent.change(screen.getByLabelText('Поле теста'), { target: { value: 'raw retained' } });
    else fireEvent.click(screen.getByRole('button', { name: 'Снять значение: Поле теста' }));
    fireEvent.click(screen.getByText('Disable finance'));
    await within(screen.getByTestId('field-user/money')).findByText(/Расширение «.*» выключено/);
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(sent).not.toHaveBeenCalled();
    expect(result.calls.filter((c) => c.path === 'entity.updateBatch')).toHaveLength(0);
    expect(screen.getByTestId('draft')).toHaveTextContent(
      mode === 'raw' ? 'raw retained' : 'unset',
    );
    expect(financeRegistry.version).toBe(registry.version);
  });
  it.each(['preview', 'archive'])('unset survives current %s and cannot write', (action) => {
    const sent = vi.fn();
    renderWithProviders(
      <Host
        reg={financeRegistry}
        record={financeEntity}
        initial={initialValues(financeRegistry, financeEntity)}
        sent={sent}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Снять значение: Поле теста' }));
    fireEvent.click(screen.getByText(action));
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(sent).not.toHaveBeenCalled();
    expect(screen.getByTestId('draft')).toHaveTextContent('unset');
    expect(screen.getByText('Значение будет снято')).toBeVisible();
  });
});

describe('remaining aspect/property contracts', () => {
  it('unsupported required field warns but permits server trial', () => {
    const json = field({ kind: 'json' }, 'user/json');
    const aspect = { ...custom, properties: [{ propertyId: json.id, required: true, rank: 0 }] };
    const reg = {
      ...registry,
      properties: [...registry.properties, json],
      aspects: [...registry.aspects, aspect],
    };
    const sent = vi.fn();
    renderWithProviders(
      <Host
        tab="aspects"
        reg={reg}
        initial={startDraft(entity, reg, { kind: 'attach', aspectId: aspect.id }, context)}
        sent={sent}
      />,
    );
    expect(screen.getByText(/Можно попробовать сохранить/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(sent).toHaveBeenCalledWith({
      kind: 'attach',
      entityId: entity.id,
      aspectId: aspect.id,
      patch: {},
    });
  });
  it('free picker creates no command until a field is touched', () => {
    const due = { ...field({ kind: 'date' }, 'user/due'), label: { ru: 'Мой срок' } };
    const reg = { ...registry, properties: [...registry.properties, due] };
    const sent = vi.fn();
    renderWithProviders(<Host reg={reg} sent={sent} />);
    fireEvent.click(screen.getByRole('button', { name: 'Добавить поле: Мой срок' }));
    expect(sent).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Мой срок'), { target: { value: '2026-10-14' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(sent).toHaveBeenCalledWith({
      kind: 'values',
      entityId: entity.id,
      patch: { props: { 'user/due': '2026-10-14' } },
    });
  });
  it.each(['preview', 'archive'])('%s disallows editor launch and assignment route', (action) => {
    renderWithProviders(
      <Host
        tab="aspects"
        ctx={{ ...context, readOnly: action === 'preview', archived: action === 'archive' }}
      />,
    );
    expect(screen.queryByRole('button', { name: /Добавить:/ })).not.toBeInTheDocument();
  });
  it('service definitions hidden, unknown attached id retained, disabled aspect names extension', () => {
    renderWithProviders(
      <Host
        tab="aspects"
        record={{ ...entity, aspects: ['missing/aspect'] }}
        ctx={{ ...context, disabledExtensions: ['finance'] }}
      />,
    );
    expect(screen.getByText('missing/aspect')).toBeVisible();
    expect(screen.getByText('Определение аспекта неизвестно')).toBeVisible();
    for (const def of registry.aspects.filter((a) => a.service))
      expect(
        screen.queryByRole('button', { name: `Добавить: ${lookupOf(registry).label(def.id)}` }),
      ).not.toBeInTheDocument();
    expect(screen.getAllByText(/Расширение «.*» выключено/).length).toBeGreaterThan(0);
  });
  it('assignment panel works without task, human generates coherent unset', () => {
    const sent = vi.fn();
    renderWithProviders(
      <Host
        tab="aspects"
        record={{ ...entity, props: { 'orbis/assignee': 'Анна' } }}
        sent={sent}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: `Добавить: ${lookupOf(registry).label('orbis/assignment')}`,
      }),
    );
    expect(screen.getByText(/Анна.*только для чтения/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(sent).toHaveBeenCalledWith({
      kind: 'attach',
      entityId: entity.id,
      aspectId: 'orbis/assignment',
      patch: { props: { 'orbis/executor': 'human' }, unset: ['orbis/grant', 'orbis/may_close'] },
    });
  });
  it.each([
    'flags',
    'mask',
    'deprecated',
  ])('assignment generated whole group guarded: %s', (gate) => {
    const reg = {
      ...registry,
      properties: registry.properties.map((p) =>
        p.id === 'orbis/grant'
          ? {
              ...p,
              ...(gate === 'flags'
                ? { flags: { model_writable: false } }
                : gate === 'mask'
                  ? { module: 'finance' as const }
                  : { status: 'deprecated' as const }),
            }
          : p,
      ),
    };
    // Deprecated unset stays legal; deprecated SET is not legal.
    const record = {
      ...entity,
      props: gate === 'deprecated' ? { 'orbis/executor': 'agent', 'orbis/grant': 'g' } : {},
    };
    const sent = vi.fn();
    renderWithProviders(
      <Host
        tab="aspects"
        reg={reg}
        record={record}
        ctx={gate === 'mask' ? { ...context, disabledExtensions: ['finance'] } : context}
        initial={startDraft(record, reg, { kind: 'assignment' }, context)}
        sent={sent}
      />,
      (p) =>
        p === 'oauth.listGrants'
          ? [{ id: 'g', label: 'Агент', scope: 'worker', connected: true, revokedAt: null }]
          : {},
    );
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(sent).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
  });
});

const oldRef = '00000000-0000-4000-8000-000000000001';
const newRef = '00000000-0000-4000-8000-000000000002';
const refDef = {
  ...field({ kind: 'ref', cardinality: 'many' }, 'user/refs'),
  label: { ru: 'Ссылки' },
};
const refRegistry = { ...registry, properties: [...registry.properties, refDef] };
const refEntity = { ...entity, props: { ...entity.props, 'user/refs': [oldRef] } };
function RefusalHost() {
  const [draft, onDraftChange] = useState<PanelDraft | null>(initialValues(refRegistry, refEntity));
  const [submission, setSubmission] = useState<FormSubmission>();
  const commands = usePanelCommands();
  return (
    <>
      <output data-testid="draft">{JSON.stringify(draft?.fields)}</output>
      <PropertiesTab
        entity={refEntity}
        registry={refRegistry}
        context={context}
        draft={draft}
        onDraftChange={onDraftChange}
        onSubmit={(command) => {
          setSubmission({ command: structuredClone(command), result: 'pending' });
          void commands
            .run(command)
            .then((result) => setSubmission({ command: structuredClone(command), result }));
        }}
        onCancel={() => onDraftChange(null)}
        onSpecial={() => {}}
        submission={submission}
      />
    </>
  );
}
describe('refusal and command lifecycle integration', () => {
  it('rejected text plus refs retains raw and archived id; explicit removal sends corrected full array only once', async () => {
    let writes = 0;
    const result = renderWithProviders(<RefusalHost />, (path) => {
      if (path === 'registry.effective') return refRegistry;
      if (path === 'entity.resolveRefs')
        return [
          { id: oldRef, title: 'Старое в архиве', emoji: null, archived: true, completable: null },
          { id: newRef, title: 'Новое', emoji: null, archived: false, completable: null },
        ];
      if (path === 'entity.query') return [{ ...entity, id: newRef, title: 'Новое' }];
      if (path === 'entity.get')
        return {
          entity: { ...entity, id: oldRef, title: 'Старое в архиве' },
          registryVersion: refRegistry.version,
        };
      if (path === 'entity.updateBatch') {
        writes++;
        if (writes === 1) throw trpcError('BAD_REQUEST', 'user/refs: цель в архиве');
        return { actionId: 'action-id' };
      }
      return {};
    });
    fireEvent.change(screen.getByLabelText('Поле теста'), {
      target: { value: '  raw survives  ' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Добавить: Новое' }));
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Ссылки: цель в архиве');
    expect(alert).toHaveFocus();
    expect(screen.getByLabelText('Поле теста')).toHaveValue('  raw survives  ');
    expect(screen.getByTestId('draft')).toHaveTextContent(oldRef);
    expect(writes).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: /^Убрать: Старое в архиве \(/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(writes).toBe(2));
    const calls = result.calls.filter((c) => c.path === 'entity.updateBatch');
    expect(calls[1]?.input).toEqual({
      operations: [
        {
          tool: 'entity_update',
          input: {
            id: entity.id,
            props: { 'user/title': '  raw survives  ', 'user/refs': [newRef] },
          },
        },
      ],
      label: 'Сохранены свойства',
    });
  });
  it('cancel concrete ref edit removes touched field from another patch', async () => {
    const sent = vi.fn();
    renderWithProviders(
      <Host
        reg={refRegistry}
        record={refEntity}
        initial={initialValues(refRegistry, refEntity)}
        sent={sent}
      />,
      (p) =>
        p === 'entity.resolveRefs'
          ? [
              {
                id: oldRef,
                title: 'Старое в архиве',
                emoji: null,
                archived: true,
                completable: null,
              },
            ]
          : p === 'entity.query'
            ? []
            : {},
    );
    fireEvent.click(await screen.findByRole('button', { name: /^Убрать: Старое в архиве \(/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Отменить правку: Ссылки' }));
    fireEvent.change(screen.getByLabelText('Поле теста'), { target: { value: 'only text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(sent).toHaveBeenCalledWith({
      kind: 'values',
      entityId: entity.id,
      patch: { props: { 'user/title': 'only text' } },
    });
  });
});

describe('shell-owned outcomes and fresh data', () => {
  it.each([
    'matches',
    'differs',
    'unavailable',
    undefined,
  ] as const)('unknown %s preserves raw and frozen command, never leaks internal details', async (reconciliation) => {
    const sent = vi.fn();
    const reconcile = vi.fn();
    const accept = vi.fn();
    const command: PanelCommand = {
      kind: 'values',
      entityId: entity.id,
      patch: { props: { 'user/title': 'mine' } },
    };
    function UnknownHost() {
      const [draft, onDraftChange] = useState<PanelDraft | null>(() => {
        const base = startDraft(entity, registry, { kind: 'values' }, context);
        return editField(base, 'user/title', { kind: 'raw', raw: 'mine' });
      });
      return (
        <PropertiesTab
          entity={entity}
          registry={registry}
          context={context}
          draft={draft}
          onDraftChange={onDraftChange}
          onSubmit={sent}
          onCancel={() => {}}
          onSpecial={() => {}}
          submission={{
            command,
            result: {
              kind: 'unknown',
              message: 'INTERNAL_SERVER_ERROR SELECT secret; stack trace',
            },
            reconciliation,
          }}
          onReconcile={reconcile}
          onAcceptCurrent={accept}
        />
      );
    }
    renderWithProviders(<UnknownHost />);
    expect(document.body).not.toHaveTextContent('SELECT');
    expect(document.body).not.toHaveTextContent('stack trace');
    if (reconciliation !== 'differs')
      expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    if (reconciliation === 'differs') {
      expect(screen.getByText('Сейчас в записи')).toBeVisible();
      expect(screen.getByText('Было')).toBeVisible();
      expect(screen.getByLabelText('Поле теста')).toHaveValue('mine');
      expect(screen.getByRole('button', { name: 'Сохранить' })).toBeEnabled();
    } else expect(screen.getByLabelText('Поле теста')).toHaveValue('mine');
    if (reconciliation === 'matches') {
      fireEvent.click(screen.getByRole('button', { name: 'Принять текущее состояние' }));
      expect(accept).toHaveBeenCalledTimes(1);
      expect(reconcile).not.toHaveBeenCalled();
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Проверить состояние' }));
      expect(reconcile).toHaveBeenCalledExactlyOnceWith(command);
    }
    expect(sent).not.toHaveBeenCalled();
  });
  it('type change shows untouched raw warning rather than coercing it into new input', async () => {
    const sent = vi.fn();
    function TypeHost() {
      const [reg, setRegistry] = useState<EffectiveRegistry>(registry);
      const [draft, onDraftChange] = useState<PanelDraft | null>(
        editField(initialValues(), 'user/title', { kind: 'raw', raw: 'incomplete -' }),
      );
      return (
        <>
          <button
            type="button"
            onClick={() =>
              setRegistry({
                ...registry,
                properties: registry.properties.map((p) =>
                  p.id === 'user/title' ? { ...p, type: { kind: 'number' } } : p,
                ),
              })
            }
          >
            change type
          </button>
          <PropertiesTab
            entity={entity}
            registry={reg}
            context={context}
            draft={draft}
            onDraftChange={onDraftChange}
            onSubmit={sent}
            onCancel={() => {}}
            onSpecial={() => {}}
          />
        </>
      );
    }
    renderWithProviders(<TypeHost />);
    fireEvent.click(screen.getByText('change type'));
    await screen.findByText('incomplete -');
    expect(screen.queryByLabelText('Поле теста')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(sent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Отменить правку: Поле теста' }));
    expect(screen.getByLabelText('Поле теста')).toHaveValue('Было');
  });
  it('unknown blocks clear even after metadata context changes and retains draft', () => {
    const sent = vi.fn();
    const initial = editField(initialValues(), 'user/title', { kind: 'raw', raw: 'mine' });
    renderWithProviders(
      <PropertiesTab
        entity={entity}
        registry={registry}
        context={context}
        draft={initial}
        onDraftChange={() => {}}
        onSubmit={sent}
        onCancel={() => {}}
        onSpecial={() => {}}
        submission={{
          command: {
            kind: 'values',
            entityId: entity.id,
            patch: { props: { 'user/title': 'mine' } },
          },
          result: { kind: 'unknown', message: 'secret' },
        }}
      />,
    );
    expect(
      screen.queryByRole('button', { name: 'Снять значение: Поле теста' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(sent).not.toHaveBeenCalled();
  });
});

it('pending preserves mounted batched ref control and disables edits without per-id fallback queries', async () => {
  function PendingHost() {
    const [submission, setSubmission] = useState<FormSubmission>();
    const [draft, onDraftChange] = useState<PanelDraft | null>(
      initialValues(refRegistry, refEntity),
    );
    return (
      <>
        <button
          type="button"
          onClick={() =>
            setSubmission({
              command: {
                kind: 'values',
                entityId: entity.id,
                patch: { props: { 'user/refs': [oldRef] } },
              },
              result: 'pending',
            })
          }
        >
          pending
        </button>
        <PropertiesTab
          entity={refEntity}
          registry={refRegistry}
          context={context}
          draft={draft}
          onDraftChange={onDraftChange}
          onSubmit={() => {}}
          onCancel={() => {}}
          onSpecial={() => {}}
          submission={submission}
        />
      </>
    );
  }
  const result = renderWithProviders(<PendingHost />, (path) =>
    path === 'entity.resolveRefs'
      ? [{ id: oldRef, title: 'Старое в архиве', emoji: null, archived: true, completable: null }]
      : path === 'entity.query'
        ? []
        : path === 'entity.get'
          ? { entity: refEntity }
          : {},
  );
  await screen.findByRole('button', { name: /^Убрать: Старое в архиве \(/ });
  fireEvent.click(screen.getByText('pending'));
  expect(screen.getByRole('button', { name: /^Убрать: Старое в архиве \(/ })).toBeDisabled();
  expect(screen.getByLabelText('Поле теста')).toBeDisabled();
  expect(result.calls.filter((c) => c.path === 'entity.get')).toHaveLength(0);
});
it('removed aspect definition retains draft values visibly and offers cancellation', async () => {
  function MissingHost() {
    const [reg, setRegistry] = useState<EffectiveRegistry>(customRegistry);
    const [draft, onDraftChange] = useState<PanelDraft | null>(
      editField(
        startDraft(entity, customRegistry, { kind: 'attach', aspectId: custom.id }, context),
        'user/due',
        { kind: 'raw', raw: '2026-10-15' },
      ),
    );
    return (
      <>
        <button
          type="button"
          onClick={() =>
            setRegistry({
              ...customRegistry,
              aspects: customRegistry.aspects.filter((a) => a.id !== custom.id),
            })
          }
        >
          remove definition
        </button>
        <AspectsTab
          entity={entity}
          registry={reg}
          context={context}
          draft={draft}
          onDraftChange={onDraftChange}
          onSubmit={() => {
            throw new Error('must not submit');
          }}
          onCancel={() => onDraftChange(null)}
          onSpecial={() => {}}
        />
      </>
    );
  }
  renderWithProviders(<MissingHost />);
  fireEvent.click(screen.getByText('remove definition'));
  await screen.findByText(/2026-10-15/);
  expect(screen.getByText(/Определение.*неизвестно|Определение изменилось/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Отменить' })).toBeEnabled();
});

it('Save compares latest entity even when parent has not applied the observed draft yet', () => {
  const sent = vi.fn();
  const draft = editField(initialValues(), 'user/title', { kind: 'raw', raw: 'mine' });
  renderWithProviders(
    <PropertiesTab
      entity={{ ...entity, props: { 'user/title': 'remote' } }}
      registry={registry}
      context={context}
      draft={draft}
      onDraftChange={() => {}}
      onSubmit={sent}
      onCancel={() => {}}
      onSpecial={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  expect(sent).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('Значение изменилось');
});

it('panel agent fields use the shared coherent patch without task or blur', async () => {
  const sent = vi.fn();
  renderWithProviders(
    <Host
      tab="aspects"
      initial={startDraft(entity, registry, { kind: 'assignment' }, context)}
      sent={sent}
    />,
    (path) =>
      path === 'oauth.listGrants'
        ? [{ id: 'g', label: 'Мой агент', scope: 'worker', connected: true, revokedAt: null }]
        : {},
  );
  fireEvent.click(screen.getByLabelText('Агент'));
  await screen.findByRole('option', { name: 'Мой агент · исполнитель' });
  fireEvent.change(screen.getByLabelText('Доступ агента'), { target: { value: 'g' } });
  fireEvent.click(screen.getByLabelText('Может закрывать сам'));
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  expect(sent).toHaveBeenCalledWith({
    kind: 'attach',
    entityId: entity.id,
    aspectId: 'orbis/assignment',
    patch: { props: { 'orbis/executor': 'agent', 'orbis/grant': 'g', 'orbis/may_close': true } },
  });
});
it('assignment current readOnly after editing retains all fields and denies Save', () => {
  const sent = vi.fn();
  renderWithProviders(
    <Host
      tab="aspects"
      initial={startDraft(entity, registry, { kind: 'assignment' }, context)}
      sent={sent}
    />,
  );
  fireEvent.click(screen.getByLabelText('Агент'));
  fireEvent.click(screen.getByText('preview'));
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  expect(sent).not.toHaveBeenCalled();
  expect(screen.getByTestId('draft')).toHaveTextContent('agent');
  expect(screen.getByLabelText('Агент')).toBeDisabled();
});
it('refused detach remains in its confirmation form with focused safe error', async () => {
  const command: PanelCommand = { kind: 'detach', entityId: entity.id, aspectId: 'orbis/task' };
  renderWithProviders(
    <AspectsTab
      entity={{ ...entity, aspects: ['orbis/task'] }}
      registry={registry}
      context={context}
      draft={null}
      onDraftChange={() => {}}
      onSubmit={() => {}}
      onCancel={() => {}}
      onSpecial={() => {}}
      submission={{ command, result: { kind: 'rejected', message: 'orbis/task: нельзя снять' } }}
    />,
  );
  const alert = screen.getByRole('alert');
  expect(alert).toHaveTextContent(`${lookupOf(registry).label('orbis/task')}: нельзя снять`);
  expect(alert).toHaveFocus();
});

it.each([
  'keep',
  'accept',
] as const)('remote conflict preserves raw until explicit %s resolution', async (choice) => {
  const sent = vi.fn();
  function ConflictHost() {
    const [record, setEntity] = useState(entity);
    const [draft, onDraftChange] = useState<PanelDraft | null>(
      editField(initialValues(), 'user/title', { kind: 'raw', raw: 'mine' }),
    );
    return (
      <>
        <button
          type="button"
          onClick={() => setEntity({ ...entity, props: { 'user/title': 'remote' } })}
        >
          remote
        </button>
        <PropertiesTab
          entity={record}
          registry={registry}
          context={context}
          draft={draft}
          onDraftChange={onDraftChange}
          onSubmit={sent}
          onCancel={() => {}}
          onSpecial={() => {}}
        />
      </>
    );
  }
  renderWithProviders(<ConflictHost />);
  fireEvent.click(screen.getByText('remote'));
  await screen.findByText('Значение изменилось. Сейчас: remote');
  expect(screen.getByLabelText('Поле теста')).toHaveValue('mine');
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  expect(sent).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole('button', {
      name: choice === 'keep' ? 'Оставить мой ввод: Поле теста' : 'Принять новое: Поле теста',
    }),
  );
  expect(screen.getByLabelText('Поле теста')).toHaveValue(choice === 'keep' ? 'mine' : 'remote');
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  expect(sent).toHaveBeenCalledExactlyOnceWith({
    kind: 'values',
    entityId: entity.id,
    patch: choice === 'keep' ? { props: { 'user/title': 'mine' } } : {},
  });
});
it('foreign entity never receives the previous draft command', () => {
  const sent = vi.fn();
  const draft = editField(initialValues(), 'user/title', { kind: 'raw', raw: 'old entity raw' });
  renderWithProviders(
    <PropertiesTab
      entity={{ ...entity, id: '00000000-0000-4000-8000-000000000099' }}
      registry={registry}
      context={context}
      draft={draft}
      onDraftChange={() => {}}
      onSubmit={sent}
      onCancel={() => {}}
      onSpecial={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  expect(sent).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('Открыта другая запись');
  expect(draft.entityId).toBe(entity.id);
  expect(draft.fields['user/title']?.input).toEqual({ kind: 'raw', raw: 'old entity raw' });
});

it('real internal refusal becomes unknown with raw preserved and no automatic repeat or SQL', async () => {
  let writes = 0;
  renderWithProviders(<RefusalHost />, (path) => {
    if (path === 'registry.effective') return refRegistry;
    if (path === 'entity.resolveRefs' || path === 'entity.query') return [];
    if (path === 'entity.updateBatch') {
      writes++;
      throw trpcError('INTERNAL_SERVER_ERROR', 'SELECT secret FROM personal_graph; stack trace');
    }
    return {};
  });
  fireEvent.change(screen.getByLabelText('Поле теста'), { target: { value: 'my raw' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  await screen.findByText('Не удалось подтвердить сохранение. Ввод сохранён.');
  expect(screen.getByLabelText('Поле теста')).toHaveValue('my raw');
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  expect(document.body).not.toHaveTextContent('SELECT');
  expect(document.body).not.toHaveTextContent('personal_graph');
  expect(document.body).not.toHaveTextContent('stack trace');
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  expect(writes).toBe(1);
});

it('cancel closes validation errors so a new values edit starts cleanly', () => {
  const def = field({ kind: 'number' });
  const reg = {
    ...registry,
    properties: registry.properties.map((p) => (p.id === def.id ? def : p)),
  };
  const record = { ...entity, props: { 'user/title': 4 } };
  renderWithProviders(<Host reg={reg} record={record} initial={initialValues(reg, record)} />);
  fireEvent.change(screen.getByLabelText('Поле теста'), { target: { value: '-' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  expect(screen.getByRole('alert')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Отменить' }));
  fireEvent.click(screen.getByRole('button', { name: 'Редактировать свойства' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Поле теста')).toHaveValue('4');
});

describe('review round 1: retained rows and coherent resolution', () => {
  it.each([
    'keep',
    'accept',
  ] as const)('remote unset retains touched free row and neighbor through explicit %s', async (choice) => {
    const extra = { ...field({ kind: 'text' }, 'user/extra'), label: { ru: 'Сосед' } };
    const reg = { ...registry, properties: [...registry.properties, extra] };
    const initial = { ...entity, props: { ...entity.props, 'user/extra': 'old' } };
    const sent = vi.fn();
    function RemoteUnsetHost() {
      const [record, setEntity] = useState(initial);
      const [draft, onDraftChange] = useState<PanelDraft | null>(() =>
        editField(
          editField(initialValues(reg, initial), 'user/title', {
            kind: 'raw',
            raw: 'retained raw',
          }),
          'user/extra',
          { kind: 'raw', raw: 'neighbor' },
        ),
      );
      return (
        <>
          <button
            type="button"
            onClick={() => setEntity({ ...initial, props: { 'user/extra': 'old' } })}
          >
            remote unset
          </button>
          <PropertiesTab
            entity={record}
            registry={reg}
            context={context}
            draft={draft}
            onDraftChange={onDraftChange}
            onSubmit={sent}
            onCancel={() => {}}
            onSpecial={() => {}}
          />
        </>
      );
    }
    renderWithProviders(<RemoteUnsetHost />);
    fireEvent.click(screen.getByText('remote unset'));
    await screen.findByText('Значение изменилось. Сейчас: Не задано');
    expect(screen.getByLabelText('Поле теста')).toHaveValue('retained raw');
    expect(screen.getByLabelText('Сосед')).toHaveValue('neighbor');
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(sent).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', {
        name: choice === 'keep' ? 'Оставить мой ввод: Поле теста' : 'Принять новое: Поле теста',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(sent).toHaveBeenCalledExactlyOnceWith({
      kind: 'values',
      entityId: entity.id,
      patch: {
        props:
          choice === 'keep'
            ? { 'user/title': 'retained raw', 'user/extra': 'neighbor' }
            : { 'user/extra': 'neighbor' },
      },
    });
  });
  it('removed declaration keeps the orphan raw and cancel action while aspect metadata blocks Save', async () => {
    const sent = vi.fn();
    function OrphanHost() {
      const [reg, setRegistry] = useState<EffectiveRegistry>(customRegistry);
      const [draft, onDraftChange] = useState<PanelDraft | null>(
        editField(
          startDraft(entity, customRegistry, { kind: 'attach', aspectId: custom.id }, context),
          'user/due',
          { kind: 'raw', raw: '2026-10-20' },
        ),
      );
      return (
        <>
          <button
            type="button"
            onClick={() =>
              setRegistry({
                ...customRegistry,
                aspects: customRegistry.aspects.map((a) =>
                  a.id === custom.id
                    ? { ...a, properties: a.properties.filter((p) => p.propertyId !== 'user/due') }
                    : a,
                ),
              })
            }
          >
            remove property
          </button>
          <AspectsTab
            entity={entity}
            registry={reg}
            context={context}
            draft={draft}
            onDraftChange={onDraftChange}
            onSubmit={sent}
            onCancel={() => {}}
            onSpecial={() => {}}
          />
        </>
      );
    }
    renderWithProviders(<OrphanHost />);
    fireEvent.click(screen.getByText('remove property'));
    await waitFor(() =>
      expect(screen.getByTestId('field-user/due')).toHaveTextContent('Поле теста'),
    );
    expect(within(screen.getByTestId('field-user/due')).getByLabelText('Поле теста')).toHaveValue(
      '2026-10-20',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(sent).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Определение изменилось');
    fireEvent.click(
      within(screen.getByTestId('field-user/due')).getByRole('button', {
        name: 'Отменить правку: Поле теста',
      }),
    );
    expect(screen.queryByTestId('field-user/due')).not.toBeInTheDocument();
  });
  it.each([
    'keep',
    'accept',
  ] as const)('assignment remote human-to-agent provides explicit group %s', async (choice) => {
    const initial = { ...entity, props: { 'orbis/executor': 'human' } };
    const remote = {
      ...entity,
      props: { 'orbis/executor': 'agent', 'orbis/grant': 'remote', 'orbis/may_close': true },
    };
    const sent = vi.fn();
    function AssignmentConflictHost() {
      const [record, setEntity] = useState(initial);
      const [draft, onDraftChange] = useState<PanelDraft | null>(
        editField(
          startDraft(initial, registry, { kind: 'assignment' }, context),
          'orbis/executor',
          { kind: 'value', value: 'human' },
        ),
      );
      return (
        <>
          <button type="button" onClick={() => setEntity(remote)}>
            remote assignment
          </button>
          <AspectsTab
            entity={record}
            registry={registry}
            context={context}
            draft={draft}
            onDraftChange={onDraftChange}
            onSubmit={sent}
            onCancel={() => {}}
            onSpecial={() => {}}
          />
        </>
      );
    }
    renderWithProviders(<AssignmentConflictHost />, (path) =>
      path === 'oauth.listGrants'
        ? [
            {
              id: 'remote',
              label: 'Remote access',
              scope: 'worker',
              connected: true,
              revokedAt: null,
            },
          ]
        : {},
    );
    fireEvent.click(screen.getByText('remote assignment'));
    await screen.findByText('Назначение изменилось. Сейчас в записи:');
    expect(screen.getByLabelText('Человек')).toBeChecked();
    expect(screen.getByText('remote')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(sent).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', {
        name: choice === 'keep' ? 'Оставить мой ввод назначения' : 'Принять новое назначение',
      }),
    );
    if (choice === 'accept') {
      expect(screen.getByLabelText('Агент')).toBeChecked();
      await screen.findByRole('option', { name: 'Remote access · исполнитель' });
      expect(screen.getByLabelText('Доступ агента')).toHaveValue('remote');
      expect(screen.getByLabelText('Может закрывать сам')).toBeChecked();
    } else expect(screen.getByLabelText('Человек')).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(sent).toHaveBeenCalledExactlyOnceWith({
      kind: 'attach',
      entityId: entity.id,
      aspectId: 'orbis/assignment',
      patch:
        choice === 'keep'
          ? { props: { 'orbis/executor': 'human' }, unset: ['orbis/grant', 'orbis/may_close'] }
          : {
              props: {
                'orbis/executor': 'agent',
                'orbis/grant': 'remote',
                'orbis/may_close': true,
              },
            },
    });
  });
});

describe('review round 1: picker and factual reconciliation', () => {
  it.each([
    'json',
    'flags',
    'mask',
  ] as const)('unavailable free %s item explains its current access', (gate) => {
    const def = {
      ...field({ kind: 'json' }, 'user/json'),
      label: { ru: 'JSON новое' },
      ...(gate === 'flags'
        ? { flags: { model_writable: false } }
        : gate === 'mask'
          ? { module: 'finance' as const }
          : {}),
    };
    const reg = { ...registry, properties: [...registry.properties, def] };
    renderWithProviders(
      <Host
        reg={reg}
        ctx={gate === 'mask' ? { ...context, disabledExtensions: ['finance'] } : context}
      />,
    );
    fireEvent.click(screen.getByText('Добавить свободное свойство'));
    const button = screen.getByRole('button', { name: 'Добавить поле: JSON новое' });
    expect(button).toBeDisabled();
    expect(
      within(button.parentElement as HTMLElement).getByText(
        gate === 'json'
          ? 'Для этого типа нет редактора; значение можно снять'
          : gate === 'flags'
            ? 'Значение вычисляется'
            : 'Расширение выключено',
      ),
    ).toBeVisible();
    if (gate === 'mask')
      expect(
        within(button.parentElement as HTMLElement).getByText(/Расширение «.*» выключено/),
      ).toBeVisible();
  });
  it.each([
    'allowed',
    'flags',
    'mask',
    'aspect-mask',
  ] as const)('free assignment route %s respects current gates', (gate) => {
    const executor = registry.properties.find((p) => p.id === 'orbis/executor');
    if (!executor) throw new Error('executor fixture');
    const reg = {
      ...registry,
      properties: [
        {
          ...executor,
          ...(gate === 'flags'
            ? { flags: { system_writable: true } }
            : gate === 'mask'
              ? { module: 'finance' as const }
              : {}),
        },
      ],
      aspects: registry.aspects.map((a) =>
        a.id === 'orbis/assignment' && gate === 'aspect-mask'
          ? { ...a, module: 'finance' as const }
          : a,
      ),
    };
    const special = vi.fn();
    renderWithProviders(
      <PropertiesTab
        entity={{ ...entity, props: {} }}
        registry={reg}
        context={
          gate === 'mask' || gate === 'aspect-mask'
            ? { ...context, disabledExtensions: ['finance'] }
            : context
        }
        draft={null}
        onDraftChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
        onSpecial={special}
      />,
    );
    fireEvent.click(screen.getByText('Добавить свободное свойство'));
    const button = screen.queryByRole('button', {
      name: `Назначение: ${lookupOf(reg).label(executor.id)}`,
    });
    if (gate === 'allowed') {
      expect(button).toBeEnabled();
      fireEvent.click(button as HTMLElement);
      expect(special).toHaveBeenCalledExactlyOnceWith('assignment');
    } else {
      if (button) expect(button).toBeDisabled();
      expect(special).not.toHaveBeenCalled();
    }
  });
  it.each([
    false,
    true,
  ])('empty attach differs shows original aspect %s presence in fresh entity', (present) => {
    const command: PanelCommand = {
      kind: 'attach',
      entityId: entity.id,
      aspectId: 'orbis/task',
      patch: {},
    };
    renderWithProviders(
      <AspectsTab
        entity={{ ...entity, aspects: present ? ['orbis/task'] : [] }}
        registry={registry}
        context={context}
        draft={startDraft(entity, registry, { kind: 'attach', aspectId: 'orbis/task' }, context)}
        onDraftChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
        onSpecial={() => {}}
        submission={{
          command,
          result: { kind: 'unknown', message: 'internal' },
          reconciliation: 'differs',
        }}
      />,
    );
    expect(
      screen.getByText(
        `${lookupOf(registry).label('orbis/task')}: ${present ? 'аспект присутствует' : 'аспект отсутствует'}`,
      ),
    ).toBeVisible();
    expect(document.querySelector('dl:empty')).toBeNull();
  });
});

describe('review round 1: coherent keep never widens access', () => {
  const initial = {
    ...entity,
    props: { 'orbis/executor': 'agent', 'orbis/grant': 'local', 'orbis/may_close': false },
  };
  function localGroup() {
    let result = startDraft(initial, registry, { kind: 'assignment' }, context);
    for (const [id, value] of Object.entries(initial.props))
      result = editField(result, id, { kind: 'value', value });
    return result;
  }
  const grants = [
    { id: 'local', label: 'Local access', scope: 'worker', connected: true, revokedAt: null },
    { id: 'remote', label: 'Remote access', scope: 'worker', connected: true, revokedAt: null },
  ];
  it('keeping agent grant conflict preserves local grant/mayClose and submits one coherent group', async () => {
    const sent = vi.fn();
    const remote = {
      ...initial,
      props: { ...initial.props, 'orbis/grant': 'remote', 'orbis/may_close': true },
    };
    function AgentHost() {
      const [draft, onDraftChange] = useState<PanelDraft | null>(localGroup());
      return (
        <AspectsTab
          entity={remote}
          registry={registry}
          context={context}
          draft={draft}
          onDraftChange={onDraftChange}
          onSubmit={sent}
          onCancel={() => {}}
          onSpecial={() => {}}
        />
      );
    }
    renderWithProviders(<AgentHost />, (path) => (path === 'oauth.listGrants' ? grants : {}));
    await screen.findByRole('option', { name: 'Local access · исполнитель' });
    fireEvent.click(screen.getByRole('button', { name: 'Оставить мой ввод назначения' }));
    expect(screen.getByLabelText('Доступ агента')).toHaveValue('local');
    expect(screen.getByLabelText('Может закрывать сам')).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(sent).toHaveBeenCalledExactlyOnceWith({
      kind: 'attach',
      entityId: entity.id,
      aspectId: 'orbis/assignment',
      patch: { props: initial.props },
    });
  });
  it.each([
    'flags',
    'mask',
    'readOnly',
    'archive',
    'metadata',
    'deprecated',
  ] as const)('group keep preserves current %s restriction', async (gate) => {
    const reg: EffectiveRegistry = {
      ...registry,
      properties: registry.properties.map((p) =>
        p.id === 'orbis/grant'
          ? {
              ...p,
              ...(gate === 'flags'
                ? { flags: { system_writable: true } }
                : gate === 'mask'
                  ? { module: 'finance' as const }
                  : gate === 'metadata'
                    ? { type: { kind: 'number' as const } }
                    : gate === 'deprecated'
                      ? { status: 'deprecated' as const }
                      : {}),
            }
          : p,
      ),
    };
    const ctx: Context = {
      ...context,
      disabledExtensions: gate === 'mask' ? ['finance'] : [],
      readOnly: gate === 'readOnly',
      archived: gate === 'archive',
    };
    const sent = vi.fn();
    const remote = { ...initial, props: { ...initial.props, 'orbis/grant': 'remote' } };
    function GuardHost() {
      const [draft, onDraftChange] = useState<PanelDraft | null>(localGroup());
      return (
        <>
          <output data-testid="draft">{JSON.stringify(draft?.fields)}</output>
          <AspectsTab
            entity={remote}
            registry={reg}
            context={ctx}
            draft={draft}
            onDraftChange={onDraftChange}
            onSubmit={sent}
            onCancel={() => {}}
            onSpecial={() => {}}
          />
        </>
      );
    }
    renderWithProviders(<GuardHost />, (path) => (path === 'oauth.listGrants' ? grants : {}));
    await screen.findByRole('option', { name: 'Local access · исполнитель' });
    fireEvent.click(screen.getByRole('button', { name: 'Оставить мой ввод назначения' }));
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(sent).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    expect(screen.getByTestId('draft')).toHaveTextContent('local');
  });
  it('unknown cannot accept or keep the group or replace the submitted snapshot', () => {
    const command: PanelCommand = {
      kind: 'attach',
      entityId: entity.id,
      aspectId: 'orbis/assignment',
      patch: { props: initial.props },
    };
    const changed = vi.fn();
    renderWithProviders(
      <AspectsTab
        entity={{ ...initial, props: { ...initial.props, 'orbis/grant': 'remote' } }}
        registry={registry}
        context={context}
        draft={localGroup()}
        onDraftChange={changed}
        onSubmit={() => {}}
        onCancel={() => {}}
        onSpecial={() => {}}
        submission={{ command, result: { kind: 'unknown', message: 'internal' } }}
      />,
      (path) => (path === 'oauth.listGrants' ? grants : {}),
    );
    expect(screen.getByRole('button', { name: 'Оставить мой ввод назначения' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Принять новое назначение' })).toBeDisabled();
    // Observation may update current read context; conflict actions cannot replace inputs.
    expect(command.patch.props).toEqual(initial.props);
  });
});

describe('review round 1: bounded semantic observation', () => {
  it.each([
    { name: 'absent to null', before: {}, after: { 'user/json': null }, conflict: true },
    { name: 'null to absent', before: { 'user/json': null }, after: {}, conflict: true },
    {
      name: 'false to null',
      before: { 'user/json': false },
      after: { 'user/json': null },
      conflict: true,
    },
    {
      name: 'ref array order',
      before: { 'user/json': ['old', 'new'] },
      after: { 'user/json': ['new', 'old'] },
      conflict: true,
    },
    {
      name: 'object key order',
      before: { 'user/json': { x: 1, y: 2 } },
      after: { 'user/json': { y: 2, x: 1 } },
      conflict: false,
    },
  ])('equivalent wrappers terminate and preserve $name semantics', async ({
    before,
    after,
    conflict,
  }) => {
    const json = field({ kind: 'json' }, 'user/json');
    const reg = { ...registry, properties: [...registry.properties, json] };
    const initial = { ...entity, props: { ...entity.props, ...before } };
    let observations = 0;
    function WrappingHost() {
      const [record, setEntity] = useState(initial);
      const [draft, setDraft] = useState<PanelDraft | null>(
        editField(
          editField(initialValues(reg, initial), 'user/title', { kind: 'raw', raw: 'retained' }),
          'user/json',
          { kind: 'unset' },
        ),
      );
      return (
        <>
          <button
            type="button"
            onClick={() => setEntity({ ...entity, props: { ...entity.props, ...after } })}
          >
            actual remote
          </button>
          <output data-testid="observations">{observations}</output>
          <PropertiesTab
            entity={{ ...record, props: { ...record.props }, aspects: [...record.aspects] }}
            registry={{ ...reg }}
            context={{ ...context }}
            draft={draft}
            onDraftChange={(next) => {
              observations++;
              if (observations > 8) throw new Error('bounded equivalent-wrapper observation loop');
              setDraft(next);
            }}
            onSubmit={() => {}}
            onCancel={() => {}}
            onSpecial={() => {}}
          />
        </>
      );
    }
    renderWithProviders(<WrappingHost />);
    expect(observations).toBe(0);
    expect(screen.getByLabelText('Поле теста')).toHaveValue('retained');
    fireEvent.click(screen.getByText('actual remote'));
    await waitFor(() => expect(observations).toBe(conflict ? 1 : 0));
    expect(screen.getByLabelText('Поле теста')).toHaveValue('retained');
    expect(Boolean(screen.queryByRole('button', { name: 'Оставить мой ввод: Поле теста' }))).toBe(
      conflict,
    );
  });
  it('recreated wrappers still observe real mask, aspects and semantic registry changes', async () => {
    const initial = { ...financeEntity, aspects: ['orbis/task'] };
    let observations = 0;
    function SemanticHost() {
      const [record, setEntity] = useState(initial);
      const [reg, setRegistry] = useState<EffectiveRegistry>(financeRegistry);
      const [ctx, setContext] = useState<Context>(context);
      const [draft, setDraft] = useState<PanelDraft | null>(
        editField(initialValues(financeRegistry, initial), 'user/money', {
          kind: 'raw',
          raw: 'original raw',
        }),
      );
      return (
        <>
          <button
            type="button"
            onClick={() => setContext({ ...context, disabledExtensions: ['finance'] })}
          >
            actual mask
          </button>
          <button
            type="button"
            onClick={() => setEntity({ ...initial, aspects: ['orbis/task', 'orbis/assignment'] })}
          >
            actual aspects
          </button>
          <button
            type="button"
            onClick={() =>
              setRegistry({
                ...financeRegistry,
                properties: financeRegistry.properties.map((p) =>
                  p.id === 'user/money' ? { ...p, type: { kind: 'number' } } : p,
                ),
              })
            }
          >
            actual registry
          </button>
          <output data-testid="observed">
            {JSON.stringify({ fields: draft?.fields, aspects: draft?.latestEntity.aspects })}
          </output>
          <PropertiesTab
            entity={{ ...record, props: { ...record.props }, aspects: [...record.aspects] }}
            registry={{ ...reg }}
            context={{ ...ctx }}
            draft={draft}
            onDraftChange={(next) => {
              observations++;
              if (observations > 8) throw new Error('bounded semantic observation loop');
              setDraft(next);
            }}
            onSubmit={() => {}}
            onCancel={() => {}}
            onSpecial={() => {}}
          />
        </>
      );
    }
    renderWithProviders(<SemanticHost />);
    expect(observations).toBe(0);
    fireEvent.click(screen.getByText('actual mask'));
    await waitFor(() => expect(observations).toBe(1));
    expect(screen.getByTestId('observed')).toHaveTextContent('Расширение выключено');
    fireEvent.click(screen.getByText('actual aspects'));
    await waitFor(() => expect(observations).toBe(2));
    expect(screen.getByTestId('observed')).toHaveTextContent('orbis/assignment');
    fireEvent.click(screen.getByText('actual registry'));
    await waitFor(() => expect(observations).toBe(3));
    expect(screen.getByTestId('observed')).toHaveTextContent('"metadataChanged":true');
    expect(screen.getByTestId('observed')).toHaveTextContent('original raw');
  });
});

it('review picker keeps APP_NAV on the named existing navigation route', () => {
  const nav = registry.properties.find((p) => p.id === 'orbis/app_nav');
  if (!nav) throw new Error('navigation fixture');
  const reg = { ...registry, properties: [nav] };
  const special = vi.fn();
  const submit = vi.fn();
  renderWithProviders(
    <PropertiesTab
      entity={{ ...entity, props: {} }}
      registry={reg}
      context={context}
      draft={null}
      onDraftChange={() => {}}
      onSubmit={submit}
      onCancel={() => {}}
      onSpecial={special}
    />,
  );
  fireEvent.click(screen.getByText('Добавить свободное свойство'));
  expect(
    screen.getByRole('button', { name: `Добавить поле: ${lookupOf(reg).label(nav.id)}` }),
  ).toBeDisabled();
  fireEvent.click(
    screen.getByRole('button', { name: `Навигация: ${lookupOf(reg).label(nav.id)}` }),
  );
  expect(special).toHaveBeenCalledExactlyOnceWith('navigation');
  expect(submit).not.toHaveBeenCalled();
});
