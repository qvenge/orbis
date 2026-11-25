import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderWithProviders } from '../../test/harness';
import { BUILTIN_REGISTRY } from '../../test/registry';
import { AspectsList } from './AspectsList';

test('определение существующего файла сохраняет подпись и исходную кратность', async () => {
  const def = {
    ...BUILTIN_REGISTRY.properties[0],
    id: 'user/estimate',
    key: 'user/estimate',
    graphId: crypto.randomUUID(),
    label: { ru: 'Смета', en: 'Estimate' },
    description: { ru: 'Смета', en: 'Estimate' },
    type: { kind: 'file', cardinality: 'many', maxItems: 3 },
  };
  const { calls } = renderWithProviders(<AspectsList />, (path) =>
    path === 'registry.effective' ? { ...BUILTIN_REGISTRY, properties: [def] } : {},
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Изменить поле Смета' }, { timeout: 5000 }),
  );
  expect(screen.getByLabelText('Количество файлов')).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Название поля'), { target: { value: 'Бюджет' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить поле' }));
  await waitFor(() =>
    expect(calls.find((c) => c.path === 'registry.updateProperty')?.input).toMatchObject({
      id: def.id,
      label: { ru: 'Бюджет', en: 'Estimate' },
    }),
  );
  expect(calls.find((c) => c.path === 'registry.updateProperty')?.input).not.toHaveProperty('type');
});
