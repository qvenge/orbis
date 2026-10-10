import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { EffectiveRegistry } from '../../../lib/registry/labels';
import {
  type MockHandler,
  renderWithProviders,
  trpcError,
  wireEntity,
} from '../../../test/harness';
import { type PanelDraft, startDraft } from './draft';
import type { FormSubmission } from './form-shared';
import { RelationsTab } from './RelationsTab';
import { context, entity, registry } from './test-fixtures';
import type { Context, Entity, PanelCommand, Relation } from './types';

const A = '00000000-0000-4000-8000-000000000001';
const B = entity.id;
const C = '00000000-0000-4000-8000-000000000003';
const record = { ...entity, title: 'Задача' };
const title = (id: string) => (id === A ? 'Проект' : id === B ? 'Задача' : 'Сосед');
const ref = (id: string, archived = false) => ({
  id,
  title: title(id),
  emoji: null,
  archived,
  completable: null,
});
const edge = (id: string, role = 'subitem', sourceId = A, targetId = B, meta = {}): Relation => ({
  id,
  role,
  sourceId,
  targetId,
  meta,
  createdAt: '2026-10-11T00:00:00Z',
  updatedAt: '2026-10-11T00:00:00Z',
});
const renamed = {
  ...registry,
  roles: registry.roles.map((r) =>
    ['subitem', 'dependency'].includes(r.id)
      ? { ...r, sourceLabel: { ru: `Начало ${r.id}` }, targetLabel: { ru: `Конец ${r.id}` } }
      : r,
  ),
};
const handler: MockHandler = (path, input) =>
  path === 'entity.resolveRefs'
    ? (input as { ids: string[] }).ids.map((id) => ref(id))
    : path === 'entity.query'
      ? [
          wireEntity({ id: A, title: 'Проект', props: {}, aspects: [] }),
          wireEntity({ id: B, title: 'Задача', props: {}, aspects: [] }),
          wireEntity({ id: C, title: 'Сосед', props: {}, aspects: [] }),
        ]
      : {};
function Host({
  edges = [],
  reg = registry,
  ctx = context,
  current = record,
  initial = null,
  sent = vi.fn(),
  navigate = vi.fn(),
  show = vi.fn(),
  body = vi.fn(),
  submission,
}: {
  edges?: Relation[];
  reg?: EffectiveRegistry;
  ctx?: Context;
  current?: Entity;
  initial?: PanelDraft | null;
  sent?: (c: PanelCommand) => void;
  navigate?: (id: string) => void;
  show?: (id?: string) => void;
  body?: () => void;
  submission?: FormSubmission;
}) {
  const [draft, onDraftChange] = useState(initial);
  const [now, setContext] = useState<Context>(ctx);
  const [catalog, setCatalog] = useState(reg);
  return (
    <>
      <button type="button" onClick={() => setContext({ ...now, readOnly: true })}>
        preview
      </button>
      <button type="button" onClick={() => setContext({ ...now, archived: true })}>
        archive
      </button>
      <button
        type="button"
        onClick={() =>
          setCatalog({ ...catalog, roles: catalog.roles.filter((r) => r.id !== 'subitem') })
        }
      >
        remove role
      </button>
      <RelationsTab
        entity={current}
        relations={edges}
        registry={catalog}
        context={now}
        draft={draft}
        onDraftChange={onDraftChange}
        onSubmit={sent}
        onCancel={() => onDraftChange(null)}
        onNavigate={navigate}
        onShowProperties={show}
        onOpenBody={body}
        submission={submission}
      />
    </>
  );
}
function relationDraft(
  roleId = 'subitem',
  side: 'source' | 'target' = 'source',
  otherId?: string,
  reg = registry,
  current = record,
) {
  return startDraft(current, reg, { kind: 'relation', roleId, side, otherId }, context);
}

describe('complete directional relation browser', () => {
  it.each([
    'subitem',
    'dependency',
  ])('registry direction %s remains original from either end', async (role) => {
    const sent = vi.fn();
    renderWithProviders(<Host edges={[edge('one', role)]} reg={renamed} sent={sent} />, handler);
    expect(
      await screen.findByText(`Начало ${role} — Проект → Конец ${role} — Задача`),
    ).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Снять связь' }));
    expect(sent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить снятие' }));
    expect(sent).toHaveBeenCalledExactlyOnceWith({
      kind: 'deleteRelation',
      entityId: B,
      key: { source_id: A, target_id: B, role },
    });
  });
  it('two roles of one pair retain two edge IDs and outgoing direction', async () => {
    renderWithProviders(
      <Host
        current={{ ...record, id: A, title: 'Проект' }}
        edges={[edge('one'), edge('two', 'dependency')]}
      />,
      handler,
    );
    expect(await screen.findByTestId('relation-one')).toBeVisible();
    expect(screen.getByTestId('relation-two')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Исходящие' })).toBeVisible();
  });
  it.each([
    'run',
    'ref',
    'unknown',
  ])('%s is visible but never removable or pickable', async (role) => {
    renderWithProviders(<Host edges={[edge('one', role)]} />, handler);
    await screen.findByTestId('relation-one');
    expect(screen.queryByRole('button', { name: 'Снять связь' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Добавить связь' }));
    expect(
      within(screen.getByLabelText('Роль связи')).queryByRole('option', { name: role }),
    ).toBeNull();
    expect(
      screen.getByText(role === 'unknown' ? 'Определение роли неизвестно' : 'Управляется системой'),
    ).toBeVisible();
  });
  it('123 full edges page 50 total then 100 then 123, not 50 per group', async () => {
    const edges = Array.from({ length: 123 }, (_, i) =>
      edge(`r${i}`, 'mention', i % 2 ? A : B, i % 2 ? B : A),
    );
    renderWithProviders(<Host edges={edges} />, handler);
    expect(screen.getByText('Показано 50 из 123')).toBeVisible();
    expect(screen.getAllByTestId(/^relation-/)).toHaveLength(50);
    fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }));
    expect(screen.getByText('Показано 100 из 123')).toBeVisible();
    expect(screen.getAllByTestId(/^relation-/)).toHaveLength(100);
    fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }));
    expect(screen.getByText('Показано 123 из 123')).toBeVisible();
    expect(screen.getAllByTestId(/^relation-/)).toHaveLength(123);
    expect(screen.queryByRole('button', { name: 'Показать ещё' })).toBeNull();
  });
  it('401 unique neighbors resolve in <=200 batches including unrendered tail, without get', async () => {
    const ids = Array.from(
      { length: 401 },
      (_, i) => `00000000-0000-4000-8000-${String(i + 100).padStart(12, '0')}`,
    );
    const { calls } = renderWithProviders(
      <Host edges={ids.map((id, i) => edge(`r${i}`, 'mention', B, id))} />,
      handler,
    );
    await waitFor(() =>
      expect(calls.filter((c) => c.path === 'entity.resolveRefs')).toHaveLength(3),
    );
    const batches = calls
      .filter((c) => c.path === 'entity.resolveRefs')
      .map((c) => (c.input as { ids: string[] }).ids);
    expect(batches.map((b) => b.length)).toEqual([200, 200, 1]);
    expect(new Set(batches.flat()).size).toBe(401);
    expect(calls.some((c) => c.path === 'entity.get')).toBe(false);
  });
  it('failed labels retain edges, retry restores archived and unavailable states', async () => {
    let failure = true;
    renderWithProviders(
      <Host edges={[edge('one'), edge('two', 'mention', B, C)]} />,
      (path, input) => {
        if (path === 'entity.resolveRefs') {
          if (failure) throw trpcError('INTERNAL_SERVER_ERROR');
          return (input as { ids: string[] }).ids
            .filter((id) => id !== C)
            .map((id) => ref(id, true));
        }
        return [];
      },
    );
    expect(await screen.findByText('Не удалось загрузить названия записей')).toBeVisible();
    expect(screen.getAllByTestId(/^relation-/)).toHaveLength(2);
    expect(screen.queryByText('Запись недоступна')).toBeNull();
    failure = false;
    fireEvent.click(screen.getByRole('button', { name: 'Повторить загрузку названий' }));
    expect(await screen.findByText('В архиве')).toBeVisible();
    expect(await screen.findByText('Запись недоступна')).toBeVisible();
  });
  it('ref follows catalog mirror key and opens only source properties or guarded source', async () => {
    const refRole = registry.roles.find((r) => r.id === 'ref');
    if (!refRole) throw new Error('ref');
    const rules = refRole.rules.map((r) =>
      r.template === 'mirror_relation' ? { ...r, params: { ...r.params, meta_key: 'cause' } } : r,
    );
    const reg = {
      ...registry,
      roles: registry.roles.map((r) => (r.id === 'ref' ? { ...r, rules } : r)),
    };
    const show = vi.fn(),
      navigate = vi.fn();
    renderWithProviders(
      <Host
        reg={reg}
        edges={[
          edge('in', 'ref', A, B, { cause: 'user/title' }),
          edge('out', 'ref', B, C, { cause: 'user/title' }),
        ]}
        show={show}
        navigate={navigate}
      />,
      handler,
    );
    await screen.findAllByText('Свойство из метаданных: Поле теста');
    fireEvent.click(
      within(screen.getByTestId('relation-in')).getByRole('button', {
        name: 'Открыть запись-источник',
      }),
    );
    expect(navigate).toHaveBeenCalledWith(A);
    expect(show).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByTestId('relation-out')).getByRole('button', { name: 'Изменить свойство' }),
    );
    expect(show).toHaveBeenCalledWith('user/title');
    expect(screen.getAllByTestId(/^relation-/)).toHaveLength(2);
  });
  it('unresolved mirror label opens properties without fabricated property ID; body link is separate', async () => {
    const show = vi.fn(),
      body = vi.fn();
    renderWithProviders(
      <Host
        edges={[edge('out', 'ref', B, C, { property: 'user/missing' })]}
        show={show}
        body={body}
      />,
      handler,
    );
    await screen.findByTestId('relation-out');
    fireEvent.click(screen.getByRole('button', { name: 'Изменить свойство' }));
    expect(show).toHaveBeenCalledWith(undefined);
    expect(screen.getByText('Ссылки в тексте изменяются в тексте записи')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Открыть текст записи' }));
    expect(body).toHaveBeenCalledOnce();
  });
});
describe('manual relation commands', () => {
  it('target side preview and save send other to self', async () => {
    const sent = vi.fn();
    renderWithProviders(<Host initial={relationDraft('subitem', 'target')} sent={sent} />, handler);
    fireEvent.change(screen.getByLabelText('Поиск записи'), { target: { value: 'Про' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Выбрать: Проект' }));
    expect(await screen.findByText('Родитель — Проект → Подпункт — Задача')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(sent).toHaveBeenCalledExactlyOnceWith({
      kind: 'createRelation',
      entityId: B,
      key: { source_id: A, target_id: B, role: 'subitem' },
    });
  });
  it('self excluded even mention; duplicate excludes only oriented triple, not reverse or another role', async () => {
    renderWithProviders(
      <Host
        edges={[edge('dup', 'mention', B, A), edge('reverse', 'mention', C, B)]}
        initial={relationDraft('mention')}
      />,
      handler,
    );
    expect(await screen.findByRole('button', { name: 'Выбрать: Сосед' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Выбрать: Проект' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Выбрать: Задача' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Роль связи'), { target: { value: 'subitem' } });
    expect(await screen.findByRole('button', { name: 'Выбрать: Проект' })).toBeVisible();
  });
  it('role and side changes clear only other choice and do not submit', () => {
    const sent = vi.fn();
    renderWithProviders(
      <Host initial={relationDraft('subitem', 'source', A)} sent={sent} />,
      handler,
    );
    expect(screen.getByText(/Родитель — Задача → Подпункт/)).toBeVisible();
    fireEvent.change(screen.getByLabelText('Сторона текущей записи'), {
      target: { value: 'target' },
    });
    expect(screen.queryByTestId('relation-preview')).toBeNull();
    fireEvent.change(screen.getByLabelText('Роль связи'), { target: { value: 'mention' } });
    expect(screen.getByLabelText('Сторона текущей записи')).toHaveValue('target');
    expect(sent).not.toHaveBeenCalled();
  });
  it.each([
    'preview',
    'archive',
    'remove role',
  ])('latest %s is checked before create while choice retained', async (button) => {
    const sent = vi.fn();
    renderWithProviders(
      <Host initial={relationDraft('subitem', 'source', A)} sent={sent} />,
      handler,
    );
    fireEvent.click(screen.getByRole('button', { name: button }));
    if (button !== 'remove role') {
      expect(screen.getByLabelText('Роль связи')).toBeDisabled();
      expect(screen.getByLabelText('Сторона текущей записи')).toBeDisabled();
      expect(screen.getByLabelText('Поиск записи')).toBeDisabled();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(sent).not.toHaveBeenCalled();
    expect(screen.getByTestId('relation-preview')).toBeVisible();
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
  });
  it('foreign draft cannot address the new entity', () => {
    const sent = vi.fn();
    renderWithProviders(
      <Host
        initial={relationDraft('subitem', 'source', A, registry, { ...record, id: C })}
        sent={sent}
      />,
      handler,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(sent).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Открыта другая запись');
  });
  it.each([
    'Цикл',
    'Предел входящих связей',
    'Контракт не выполнен',
  ])('server rejection %s preserves selection and no autosubmit', (message) => {
    const command: PanelCommand = {
      kind: 'createRelation',
      entityId: B,
      key: { source_id: B, target_id: A, role: 'subitem' },
    };
    renderWithProviders(
      <Host
        initial={relationDraft('subitem', 'source', A)}
        submission={{ command, result: { kind: 'rejected', message } }}
      />,
      handler,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(screen.getByTestId('relation-preview')).toBeVisible();
  });
  it('unavailable target contract disables search instead of falling back to all', async () => {
    const reg = { ...registry, aspects: [] };
    const { calls } = renderWithProviders(
      <Host reg={reg} initial={relationDraft('ticket', 'source', undefined, reg)} />,
      handler,
    );
    expect(screen.getByText(/Нет доступных реализаций/)).toBeVisible();
    await new Promise((r) => setTimeout(r, 250));
    expect(calls.some((c) => c.path === 'entity.query')).toBe(false);
  });
  it('current target contract uses shared bindings, disabled aspect module does not prohibit role', () => {
    const task = registry.aspects.find((a) => a.id === 'orbis/task');
    if (!task) throw new Error('task');
    const reg = {
      ...registry,
      aspects: [
        ...registry.aspects,
        { ...task, id: 'user/complete', key: 'user/complete', module: 'finance' },
      ],
    };
    const current = { ...record, aspects: ['user/complete'] };
    const sent = vi.fn();
    renderWithProviders(
      <Host
        current={current}
        reg={reg}
        ctx={{ ...context, disabledExtensions: ['finance'] }}
        initial={relationDraft('ticket', 'target', A, reg, current)}
        sent={sent}
      />,
      handler,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(sent).toHaveBeenCalledWith({
      kind: 'createRelation',
      entityId: B,
      key: { source_id: A, target_id: B, role: 'ticket' },
    });
  });
  it('obviously incompatible current target reports contract and blocks submit', () => {
    const sent = vi.fn();
    renderWithProviders(
      <Host initial={relationDraft('ticket', 'target', A)} sent={sent} />,
      handler,
    );
    expect(screen.getByText(/Текущая запись не реализует/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(sent).not.toHaveBeenCalled();
  });
  it.each([
    'pending',
    'unknown',
  ] as const)('%s locks selection and Save without replacing command', (state) => {
    const sent = vi.fn();
    const command: PanelCommand = {
      kind: 'createRelation',
      entityId: B,
      key: { source_id: B, target_id: A, role: 'subitem' },
    };
    renderWithProviders(
      <Host
        initial={relationDraft('subitem', 'source', A)}
        sent={sent}
        submission={{
          command,
          result: state === 'pending' ? 'pending' : { kind: 'unknown', message: 'secret' },
        }}
      />,
      handler,
    );
    expect(screen.getByLabelText('Роль связи')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    expect(screen.queryByText('secret')).toBeNull();
    expect(sent).not.toHaveBeenCalled();
  });
  it.each([
    true,
    false,
  ])('unknown differs shows original triple actual presence=%s, no empty dl', (exists) => {
    const command: PanelCommand = {
      kind: 'createRelation',
      entityId: B,
      key: { source_id: A, target_id: B, role: 'mention' },
    };
    renderWithProviders(
      <Host
        edges={exists ? [edge('actual', 'mention')] : []}
        initial={relationDraft('subitem', 'source', C)}
        submission={{
          command,
          result: { kind: 'unknown', message: 'private' },
          reconciliation: 'differs',
        }}
      />,
      handler,
    );
    expect(
      screen.getByText(exists ? 'Исходная связь присутствует' : 'Исходная связь отсутствует'),
    ).toBeVisible();
    expect(screen.getByTestId('submitted-relation')).toHaveTextContent('Упоминание');
    expect(document.querySelector('dl')).toBeNull();
  });
});

describe('relation current-state and shell seams', () => {
  it.each([
    'preview',
    'archive',
    'remove role',
  ])('delete repeats current %s guard after opening confirmation', (button) => {
    const sent = vi.fn();
    renderWithProviders(<Host edges={[edge('one')]} sent={sent} />, handler);
    fireEvent.click(screen.getByRole('button', { name: 'Снять связь' }));
    fireEvent.click(screen.getByRole('button', { name: button }));
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить снятие' }));
    expect(sent).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    expect(screen.getByTestId('relation-one')).toBeVisible();
  });
  it('rank then createdAt then edge.id sorting remains within direction', () => {
    const edges = [
      edge('z', 'mention'),
      edge('b'),
      edge('a'),
      { ...edge('early'), createdAt: '2026-10-10T00:00:00Z' },
      edge('out', 'mention', B, A),
    ];
    renderWithProviders(<Host edges={edges} />, handler);
    expect(screen.getAllByTestId(/^relation-/).map((el) => el.dataset.testid)).toEqual([
      'relation-out',
      'relation-early',
      'relation-a',
      'relation-b',
      'relation-z',
    ]);
  });
  it('system remove absent at both ends and read-only context has no manual delete', () => {
    renderWithProviders(
      <Host
        ctx={{ ...context, readOnly: true }}
        edges={[edge('system-in', 'run'), edge('system-out', 'run', B, C), edge('manual')]}
      />,
      handler,
    );
    expect(screen.queryByRole('button', { name: 'Снять связь' })).toBeNull();
    expect(screen.getAllByText('Управляется системой')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Добавить связь' })).toBeDisabled();
  });
  it('dirty unrelated draft cannot silently open local deletion without shell guard', () => {
    renderWithProviders(
      <Host
        edges={[edge('one')]}
        initial={startDraft(record, registry, { kind: 'values' }, context)}
      />,
      handler,
    );
    expect(screen.getByRole('button', { name: 'Снять связь' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Добавить связь' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Подтвердить снятие' })).toBeNull();
  });
  it('requestAction defers local delete until shell explicitly runs guarded action', () => {
    let action: (() => void) | undefined;
    const request = vi.fn((next: () => void) => {
      action = next;
    });
    function Shell() {
      const [draft, onDraftChange] = useState<PanelDraft | null>(
        startDraft(record, registry, { kind: 'values' }, context),
      );
      return (
        <>
          <button
            type="button"
            onClick={() => {
              onDraftChange(null);
              action?.();
            }}
          >
            discard confirmed
          </button>
          <RelationsTab
            entity={record}
            relations={[edge('one')]}
            registry={registry}
            context={context}
            draft={draft}
            onDraftChange={onDraftChange}
            onSubmit={() => {}}
            onCancel={() => onDraftChange(null)}
            onNavigate={() => {}}
            onShowProperties={() => {}}
            onOpenBody={() => {}}
            onRequestAction={request}
          />
        </>
      );
    }
    renderWithProviders(<Shell />, handler);
    fireEvent.click(screen.getByRole('button', { name: 'Снять связь' }));
    expect(request).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Подтвердить снятие' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'discard confirmed' }));
    expect(screen.getByRole('button', { name: 'Подтвердить снятие' })).toBeVisible();
  });
  it('shared ref edge remains one row after refresh removes one reflected property', () => {
    function Shell() {
      const [record, setRecord] = useState({ ...entity, props: { 'user/one': A, 'user/two': A } });
      return (
        <>
          <button
            type="button"
            onClick={() =>
              setRecord({ ...record, props: { 'user/two': A } as typeof record.props })
            }
          >
            one property cleared
          </button>
          <Host current={record} edges={[edge('shared', 'ref', B, A, { property: 'user/two' })]} />
        </>
      );
    }
    renderWithProviders(<Shell />, handler);
    expect(screen.getAllByTestId(/^relation-/)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'one property cleared' }));
    expect(screen.getAllByTestId(/^relation-/)).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Снять связь' })).toBeNull();
  });
  it('role module off remains manual create and delete authority', () => {
    const reg = {
      ...registry,
      roles: registry.roles.map((r) => (r.id === 'subitem' ? { ...r, module: 'finance' } : r)),
    };
    const sent = vi.fn();
    renderWithProviders(
      <Host
        reg={reg}
        ctx={{ ...context, disabledExtensions: ['finance'] }}
        initial={relationDraft('subitem', 'source', A, reg)}
        sent={sent}
      />,
      handler,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(sent).toHaveBeenCalledOnce();
  });
  it('create duplicate discovered after latest full response is rejected with choice intact', () => {
    const sent = vi.fn();
    renderWithProviders(
      <Host
        edges={[edge('duplicate', 'subitem', B, A)]}
        initial={relationDraft('subitem', 'source', A)}
        sent={sent}
      />,
      handler,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(sent).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Такая связь уже существует');
    expect(screen.getByTestId('relation-preview')).toBeVisible();
  });
  it('contract search query uses shared custom binding scope and 20-result limit', async () => {
    const task = registry.aspects.find((a) => a.id === 'orbis/task');
    if (!task) throw new Error('task');
    const reg = { ...registry, aspects: [{ ...task, id: 'user/complete', key: 'user/complete' }] };
    const { calls } = renderWithProviders(
      <Host reg={reg} initial={relationDraft('ticket', 'source', undefined, reg)} />,
      handler,
    );
    await waitFor(() => expect(calls.some((c) => c.path === 'entity.query')).toBe(true));
    expect(calls.find((c) => c.path === 'entity.query')?.input).toMatchObject({
      ast: { filter: { or: [{ aspect: 'user/complete' }] }, limit: 20 },
    });
  });
  it('20 results ask refinement; archived choices excluded; fast typing debounces scope query', async () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      wireEntity({
        id: `00000000-0000-4000-8000-${String(i + 100).padStart(12, '0')}`,
        title: `Choice ${i}`,
        props: {},
        aspects: [],
        archived: i === 0,
      }),
    );
    const { calls } = renderWithProviders(
      <Host initial={relationDraft('mention')} />,
      (path, input) => (path === 'entity.query' ? rows : handler(path, input)),
    );
    await screen.findByText('Уточните поиск: показано до 20 записей');
    expect(screen.queryByRole('button', { name: 'Выбрать: Choice 0' })).toBeNull();
    expect(screen.getAllByRole('button', { name: /Выбрать: Choice/ })).toHaveLength(19);
    const input = screen.getByLabelText('Поиск записи');
    fireEvent.change(input, { target: { value: 'П' } });
    fireEvent.change(input, { target: { value: 'Пр' } });
    fireEvent.change(input, { target: { value: 'Про' } });
    expect(screen.queryByRole('button', { name: 'Выбрать: Choice 1' })).toBeNull();
    await waitFor(() => expect(calls.filter((c) => c.path === 'entity.query')).toHaveLength(2));
    expect(calls.filter((c) => c.path === 'entity.query')[1]?.input).toMatchObject({
      ast: { filter: { search: 'Про' }, limit: 20 },
    });
  });
  it('search failure distinct from empty, explicit retry preserves relation choice', async () => {
    let fail = true;
    renderWithProviders(<Host initial={relationDraft('mention', 'source', A)} />, (path, input) => {
      if (path === 'entity.query' && fail) throw trpcError('INTERNAL_SERVER_ERROR');
      return handler(path, input);
    });
    expect(await screen.findByText('Не удалось выполнить поиск')).toBeVisible();
    expect(screen.queryByText('Ничего не найдено')).toBeNull();
    expect(screen.getByTestId('relation-preview')).toBeVisible();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Повторить поиск' }));
    expect(await screen.findByRole('button', { name: 'Выбрать: Сосед' })).toBeVisible();
  });
  it.each([
    'matches',
    'unavailable',
  ] as const)('unknown %s keeps retry blocked and offers the explicit lifecycle', (reconciliation) => {
    const reconcile = vi.fn(),
      accept = vi.fn();
    const command: PanelCommand = {
      kind: 'deleteRelation',
      entityId: B,
      key: { source_id: A, target_id: B, role: 'mention' },
    };
    renderWithProviders(
      <RelationsTab
        entity={record}
        relations={[]}
        registry={registry}
        context={context}
        draft={relationDraft('mention', 'source', C)}
        onDraftChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
        onNavigate={() => {}}
        onShowProperties={() => {}}
        onOpenBody={() => {}}
        onReconcile={reconcile}
        onAcceptCurrent={accept}
        submission={{ command, result: { kind: 'unknown', message: 'stack' }, reconciliation }}
      />,
      handler,
    );
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    if (reconciliation === 'matches') {
      fireEvent.click(screen.getByRole('button', { name: 'Принять текущее состояние' }));
      expect(accept).toHaveBeenCalledOnce();
      expect(reconcile).not.toHaveBeenCalled();
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Проверить состояние' }));
      expect(reconcile).toHaveBeenCalledExactlyOnceWith(command);
    }
    expect(screen.queryByText('stack')).toBeNull();
  });
});

it('foreign host draft never searches or offers choices under the new entity address', async () => {
  const { calls } = renderWithProviders(
    <Host initial={relationDraft('mention', 'source', A, registry, { ...record, id: C })} />,
    handler,
  );
  await new Promise((r) => setTimeout(r, 250));
  expect(calls.some((c) => c.path === 'entity.query')).toBe(false);
  expect(screen.queryByRole('button', { name: 'Выбрать: Проект' })).toBeNull();
});
it('current end contract is rechecked before parent has observed new aspects', () => {
  const initialRecord = { ...record, aspects: ['orbis/task'] };
  const draft = relationDraft('ticket', 'target', A, registry, initialRecord);
  const sent = vi.fn();
  renderWithProviders(
    <RelationsTab
      entity={record}
      relations={[]}
      registry={registry}
      context={context}
      draft={draft}
      onDraftChange={() => {}}
      onSubmit={sent}
      onCancel={() => {}}
      onNavigate={() => {}}
      onShowProperties={() => {}}
      onOpenBody={() => {}}
    />,
    handler,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  expect(sent).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('Текущая запись не реализует контракт');
  expect(screen.getByTestId('relation-preview')).toBeVisible();
});
it.each([
  'subitem',
  'dependency',
])('outgoing %s uses refreshed side labels and original delete triple', async (role) => {
  const sent = vi.fn();
  renderWithProviders(
    <Host
      reg={renamed}
      current={{ ...record, id: A, title: 'Проект' }}
      edges={[edge('one', role)]}
      sent={sent}
    />,
    handler,
  );
  expect(await screen.findByText(`Начало ${role} — Проект → Конец ${role} — Задача`)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Снять связь' }));
  fireEvent.click(screen.getByRole('button', { name: 'Подтвердить снятие' }));
  expect(sent).toHaveBeenCalledExactlyOnceWith({
    kind: 'deleteRelation',
    entityId: A,
    key: { source_id: A, target_id: B, role },
  });
});
it('old unscoped search response cannot enter the new contract role scope', async () => {
  let release: (value: unknown) => void = () => {};
  const old = new Promise((resolve) => {
    release = resolve;
  });
  const { calls } = renderWithProviders(
    <Host initial={relationDraft('mention')} />,
    (path, input) => {
      if (path === 'entity.query') {
        const ast = (input as { ast: { filter: unknown } }).ast;
        return ast.filter === null
          ? old
          : [wireEntity({ id: C, title: 'Подходящий тикет', aspects: ['orbis/task'], props: {} })];
      }
      return handler(path, input);
    },
  );
  await waitFor(() => expect(calls.some((c) => c.path === 'entity.query')).toBe(true));
  fireEvent.change(screen.getByLabelText('Роль связи'), { target: { value: 'ticket' } });
  expect(await screen.findByRole('button', { name: 'Выбрать: Подходящий тикет' })).toBeVisible();
  release([wireEntity({ id: A, title: 'Старый ответ', aspects: [], props: {} })]);
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Выбрать: Старый ответ' })).toBeNull(),
  );
  expect(screen.getByRole('button', { name: 'Выбрать: Подходящий тикет' })).toBeVisible();
});
it('delete confirmation and both endpoint preview stay inside the original edge row', async () => {
  renderWithProviders(<Host edges={[edge('one')]} />, handler);
  await screen.findByText('Родитель — Проект → Подпункт — Задача');
  fireEvent.click(screen.getByRole('button', { name: 'Снять связь' }));
  const row = within(screen.getByTestId('relation-one'));
  expect(row.getByRole('button', { name: 'Подтвердить снятие' })).toBeVisible();
  expect(row.getByRole('button', { name: 'Отмена' })).toBeVisible();
  expect(row.getAllByText('Родитель — Проект → Подпункт — Задача').length).toBeGreaterThan(0);
});
it('role and side changes retain search text while clearing only the other selection', () => {
  renderWithProviders(<Host initial={relationDraft('subitem', 'source', A)} />, handler);
  const input = screen.getByLabelText('Поиск записи');
  fireEvent.change(input, { target: { value: 'Про' } });
  fireEvent.change(screen.getByLabelText('Сторона текущей записи'), {
    target: { value: 'target' },
  });
  expect(input).toHaveValue('Про');
  expect(screen.queryByTestId('relation-preview')).toBeNull();
  fireEvent.change(screen.getByLabelText('Роль связи'), { target: { value: 'mention' } });
  expect(input).toHaveValue('Про');
  expect(screen.getByLabelText('Сторона текущей записи')).toHaveValue('target');
});

const collidingRoles = {
  ...registry,
  roles: registry.roles.map((role) =>
    ['subitem', 'dependency'].includes(role.id)
      ? {
          ...role,
          label: { ru: 'Одинаковая роль' },
          sourceLabel: { ru: 'Начало' },
          targetLabel: { ru: 'Конец' },
          key: `user/${role.id}`,
          description: { ru: role.id === 'subitem' ? 'Часть целого' : 'Ожидание другой работы' },
        }
      : role,
  ),
};
it('coincident role rows expose accessible description and key before original incoming delete', async () => {
  const sent = vi.fn();
  renderWithProviders(
    <Host reg={collidingRoles} edges={[edge('part'), edge('wait', 'dependency')]} sent={sent} />,
    handler,
  );
  for (const [id, description, key] of [
    ['part', 'Часть целого', 'user/subitem'],
    ['wait', 'Ожидание другой работы', 'user/dependency'],
  ] as const) {
    const row = within(screen.getByTestId(`relation-${id}`));
    fireEvent.click(row.getByText('О роли'));
    expect(row.getByText(description)).toBeVisible();
    expect(row.getByText(`Ключ роли: ${key}`)).toBeVisible();
  }
  fireEvent.click(
    within(screen.getByTestId('relation-wait')).getByRole('button', { name: 'Снять связь' }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Подтвердить снятие' }));
  expect(sent).toHaveBeenCalledExactlyOnceWith({
    kind: 'deleteRelation',
    entityId: B,
    key: { source_id: A, target_id: B, role: 'dependency' },
  });
});
it('coincident picker options expose descriptions and keys, selected detail updates without confusing command IDs', async () => {
  const sent = vi.fn();
  renderWithProviders(
    <Host
      reg={collidingRoles}
      initial={relationDraft('subitem', 'source', undefined, collidingRoles)}
      sent={sent}
    />,
    handler,
  );
  const picker = screen.getByLabelText('Роль связи');
  expect(
    within(picker).getByRole('option', { name: 'Одинаковая роль — Часть целого (user/subitem)' }),
  ).toBeVisible();
  expect(
    within(picker).getByRole('option', {
      name: 'Одинаковая роль — Ожидание другой работы (user/dependency)',
    }),
  ).toBeVisible();
  expect(screen.getByText('Часть целого')).toBeVisible();
  expect(screen.getByText('Ключ роли: user/subitem')).toBeVisible();
  fireEvent.change(picker, { target: { value: 'dependency' } });
  expect(screen.getByText('Ожидание другой работы')).toBeVisible();
  expect(screen.getByText('Ключ роли: user/dependency')).toBeVisible();
  expect(screen.queryByText('Часть целого')).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: 'Выбрать: Проект' }));
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  expect(sent).toHaveBeenCalledExactlyOnceWith({
    kind: 'createRelation',
    entityId: B,
    key: { source_id: B, target_id: A, role: 'dependency' },
  });
});
