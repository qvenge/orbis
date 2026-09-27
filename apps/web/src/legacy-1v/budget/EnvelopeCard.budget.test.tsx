// Интеграция конверта с экраном Бюджета — перенесена из `features/budget/EnvelopeCard.test.tsx`
// вместе с экраном (срез 1б §8.6, РП-31): каталог исключён из проверок и сборки до 1в.
// Фикстуры (`status`, `sheetHandler`, `emptyOverview`) — в исходном файле.
// --- интеграция с BudgetScreen ------------------------------------------------------------

const emptyOverview: BudgetOverview = {
  period: { start: '2026-07-01', end: '2026-07-31' },
  balance: { income: '0', expense: '0', balance: '0' },
  envelopes: [],
  comingUp: [],
  planned: [],
  unbudgeted: [{ category: { id: 'c1', title: 'Еда', icon: '🍔' }, total: '3200.00' }],
  alertCount: 0,
};

test('[+ конверт] открывает Sheet; после успешного сабмита budget.overview перезапрашивается', async () => {
  const { calls } = renderWithProviders(<BudgetScreen />, sheetHandler());
  await waitFor(() => expect(screen.getByTestId('balance-card')).toBeInTheDocument());

  fireEvent.click(screen.getByRole('button', { name: '+ конверт' }));
  await waitFor(() => expect(screen.getByRole('option', { name: /Еда/ })).toBeInTheDocument());

  const overviewCallsBefore = calls.filter((c) => c.path === 'budget.overview').length;
  fireEvent.change(screen.getByLabelText('Категория'), { target: { value: 'c1' } });
  fireEvent.change(screen.getByLabelText('Лимит'), { target: { value: '9000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Создать' }));
  await waitFor(() => expect(calls.some((c) => c.path === 'entity.create')).toBe(true));

  // invalidateBudget → повторный запрос overview
  await waitFor(() =>
    expect(calls.filter((c) => c.path === 'budget.overview').length).toBeGreaterThan(
      overviewCallsBefore,
    ),
  );
});

test('Unbudgeted: кнопка создания конверта открывает Sheet с предвыбранной категорией', async () => {
  renderWithProviders(<BudgetScreen />, sheetHandler());
  await waitFor(() => expect(screen.getByTestId('balance-card')).toBeInTheDocument());

  fireEvent.click(screen.getByRole('button', { name: 'Конверт для «Еда»' }));
  await waitFor(() =>
    expect((screen.getByLabelText('Категория') as HTMLSelectElement).value).toBe('c1'),
  );
});
