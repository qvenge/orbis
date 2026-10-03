import { screen, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderWithProviders } from '../../test/harness';
import { PAGE_TEMPLATES_QUERY, usePageTemplates } from './usePageTemplates';
import { SUPPLY_RECORDS_QUERY, useSupplyRecords } from './useSupplyRecords';

function Probe() {
  const templates = usePageTemplates();
  const supply = useSupplyRecords();
  return (
    <div>
      {templates.status}/{supply.status}
    </div>
  );
}
test('списки шаблонов и поставки явно просят текст целиком', async () => {
  const { calls } = renderWithProviders(<Probe />, () => []);
  await waitFor(() => expect(screen.getByText('ok/ok')).toBeInTheDocument());
  const queries = calls.filter((c) => c.path === 'entity.query').map((c) => c.input);
  expect(queries).toContainEqual({ query: PAGE_TEMPLATES_QUERY, fields: 'full' });
  expect(queries).toContainEqual({ query: SUPPLY_RECORDS_QUERY, fields: 'full' });
});
