/**
 * Переключатель параметра страницы (спека 1в §5.1): на месте блока `{{param}}`; до четырёх
 * вариантов — сегменты, больше — выпадающий список; подписи вариантов — из словаря токенов (§3.4);
 * заголовок — `title`, без него — имя. Смена значения пишет состояние экрана в историю (`setView`),
 * не в тело. Точка лени — `ParamSwitchSlot` (сам переключатель — отдельным чанком, РП-18).
 */
import { type PageNode, parsePageText } from '@orbis/shared/doc/page-grammar';
import { currentEntry } from '@orbis/shared/nav';
import { QUERY_DATE_TOKEN_LABELS } from '@orbis/shared/query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { BodyKindProvider } from '../../../lib/query-blocks/body-kind';
import { useNav } from '../../../state/navigation';
import { renderWithProviders } from '../../../test/harness';
import { navAt } from '../../../test/nav';
import { PageParamsProvider } from '../params';
import { ParamSwitchSlot, resetParamSwitchForTests } from './ParamSwitchSlot';

const PAGE_ID = '00000000-0000-4000-8000-000000000701';

beforeEach(() => {
  navAt(PAGE_ID);
});

/** Переключатель первого параметра тела — внутри провайдера значений, как его рисует рендерер. */
function renderSwitch(marker: string) {
  const nodes: PageNode[] = parsePageText(marker);
  const node = nodes[0];
  if (node?.kind !== 'param' || node.decl === null) throw new Error(`не параметр: ${marker}`);
  const view = currentEntry(useNav.getState().model).view;
  return renderWithProviders(
    <BodyKindProvider kind="page">
      <PageParamsProvider nodes={nodes} {...(view !== undefined && { view })}>
        <ParamSwitchSlot decl={node.decl} />
      </PageParamsProvider>
    </BodyKindProvider>,
  );
}

test('два варианта — сегменты radiogroup с подписями словаря и заголовком «Горизонт»', async () => {
  renderSwitch(
    '{{param: period, type=period, default=next_7d, options=next_7d|next_14d, title="Горизонт"}}',
  );
  const group = await screen.findByRole('radiogroup', { name: 'Горизонт' });
  expect(screen.getByText('Горизонт')).toBeInTheDocument();
  const radios = within(group).getAllByRole('radio') as HTMLInputElement[];
  expect(radios.map((r) => r.closest('label')?.textContent)).toEqual(['7 дней', '14 дней']);
  expect(radios.map((r) => r.checked)).toEqual([true, false]);
  expect(screen.queryByRole('combobox')).toBeNull();

  fireEvent.click(radios[1] as HTMLElement);
  expect(currentEntry(useNav.getState().model).view).toEqual({ 'param:period': 'next_14d' });
});

test('четыре варианта — ещё сегменты: нативные радиокнопки одной группы (клавиатура — у браузера)', async () => {
  renderSwitch(
    '{{param: p, type=period, default=today, options=today|this_week|this_month|last_month}}',
  );
  const group = await screen.findByRole('radiogroup', { name: 'p' });
  const radios = within(group).getAllByRole('radio') as HTMLInputElement[];
  expect(radios).toHaveLength(4);
  expect(new Set(radios.map((r) => r.name)).size).toBe(1);
  expect(radios.every((r) => r.type === 'radio')).toBe(true);
  fireEvent.click(within(group).getByRole('radio', { name: 'эта неделя' }));
  expect(currentEntry(useNav.getState().model).view).toEqual({ 'param:p': 'this_week' });
});

test('пять вариантов — нативный <select> с подписями словаря', async () => {
  const options = ['today', 'next_7d', 'next_14d', 'this_month', 'last_month'] as const;
  renderSwitch(
    `{{param: span, type=period, default=next_14d, options=${options.join('|')}, title="Период"}}`,
  );
  const select = (await screen.findByRole('combobox', { name: 'Период' })) as HTMLSelectElement;
  expect(select.tagName).toBe('SELECT');
  expect([...select.options].map((o) => [o.value, o.text])).toEqual(
    options.map((t) => [t, QUERY_DATE_TOKEN_LABELS[t]]),
  );
  expect(select.value).toBe('next_14d');
  expect(screen.queryByRole('radiogroup')).toBeNull();
  fireEvent.change(select, { target: { value: 'this_month' } });
  expect(currentEntry(useNav.getState().model).view).toEqual({ 'param:span': 'this_month' });
});

test('без title — заголовок — имя параметра', async () => {
  renderSwitch('{{param: horizon, type=period, default=today, options=today|next_7d}}');
  expect(await screen.findByRole('radiogroup', { name: 'horizon' })).toBeInTheDocument();
  expect(screen.getByText('horizon')).toBeInTheDocument();
});

test('выбранное значение — из истории экрана; пока чанк едет — скелетон на месте блока', async () => {
  resetParamSwitchForTests();
  useNav.getState().setView({ 'param:period': 'next_14d' });
  renderSwitch('{{param: period, type=period, default=next_7d, options=next_7d|next_14d}}');
  expect(screen.getByRole('status', { name: 'Загрузка' })).toBeInTheDocument();
  const group = await screen.findByRole('radiogroup', { name: 'period' });
  await waitFor(() => expect(within(group).getByRole('radio', { name: '14 дней' })).toBeChecked());
});
