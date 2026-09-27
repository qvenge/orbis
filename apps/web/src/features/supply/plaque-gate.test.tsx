/**
 * Плашка обновления поставки ждёт досыла набранного текста (раунд 1 гейта 22, M-3; С1а-8): «Принять»
 * и «Оставить своё» переписывают запись, и пачка поверх неотправленного тела потеряла бы его мимо
 * версий — правило одно с меню «⋯» (`settleBody`).
 */

import { SUPPLY_ASPECT } from '@orbis/shared';
import { printPageRecord } from '@orbis/shared/supply/print';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { installCrashTrap, renderWithProviders } from '../../test/harness';
import { useToastStore } from '../../ui/toast-store';
import { BODY_SAVING } from '../entity-detail/body-gate';
import { type BodyGate, BodyScreenProvider } from '../entity-detail/EntityBody';
import { SupplyPlaqueSlot } from './SupplyPlaqueSlot';
import type { SupplyUpdate } from './useSupply';

installCrashTrap();

beforeEach(() => useToastStore.setState({ toasts: [] }));

const RECORD = '00000000-0000-4000-8000-000000002401';
const print = (body: string) => printPageRecord({ title: 'Рутины', emoji: '🔁', body });
const UPDATE: SupplyUpdate = {
  key: 'routines',
  kind: 'update',
  recordId: RECORD,
  edited: true,
  declined: false,
  etalonText: print('Новое.'),
  recordText: print('Моё.'),
};

test.each([
  ['Принять — прежняя версия сохранится', 'supply.accept'],
  ['Оставить своё', 'supply.decline'],
])('«%s» при неотправленном тексте — досыл, а не пачка; после досыла — %s', async (label, path) => {
  let unsent = true;
  const flush = vi.fn();
  const gate = {
    hasUnsent: () => unsent,
    blocked: () => false,
    flush,
    offline: () => false,
    keptOffline: () => false,
  } as unknown as BodyGate;
  // Экран записи под плашкой: затвор тела — из контекста экрана, как у `DetailScreen`.
  const screen_ = {
    asMarkdown: false,
    onCloseMarkdown: () => {},
    screenConflict: false,
    noticeHost: null,
    onRefresh: () => {},
    bodyGate: { current: gate },
  };
  const ui = (
    <BodyScreenProvider value={screen_}>
      <SupplyPlaqueSlot entity={{ id: RECORD, aspects: [SUPPLY_ASPECT] }} />
    </BodyScreenProvider>
  );
  const { calls } = renderWithProviders(ui, (p) =>
    p === 'supply.updates' ? [UPDATE] : p.startsWith('supply.') ? { actionId: RECORD } : {},
  );
  const plaque = await screen.findByTestId('supply-plaque');
  fireEvent.click(within(plaque).getByRole('button', { name: label }));
  expect(flush).toHaveBeenCalledTimes(1);
  expect(useToastStore.getState().toasts.map((t) => t.title)).toContain(BODY_SAVING);
  expect(calls.filter((c) => c.path === path)).toEqual([]);
  // Текст ушёл — повтор жеста проходит.
  unsent = false;
  fireEvent.click(within(plaque).getByRole('button', { name: label }));
  await waitFor(() =>
    expect(calls.filter((c) => c.path === path).map((c) => c.input)).toEqual([{ key: 'routines' }]),
  );
});
