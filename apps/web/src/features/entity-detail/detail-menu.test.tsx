/**
 * Меню ⋮ — ленивым чанком (задача 14 страниц 1а): отказ загрузки чанка на жест не проглатывается.
 *
 * Чанк не приехал (сеть, старая вкладка после деплоя с новыми именами) — нажатие обязано дать
 * видимый кадр ошибки экрана (`ChunkErrorBoundary`, с перезагрузкой), а не мёртвую кнопку; и
 * отказ не запоминается: следующий жест после возврата сети грузит меню заново.
 */
import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ChunkErrorBoundary } from '../../app/ChunkErrorBoundary';
import { useNav } from '../../state/navigation';
import { installCrashTrap, renderWithProviders, wireEntity } from '../../test/harness';
import { registryReply } from '../../test/registry';
import { resetDetailMenuModuleForTests } from './DetailMenuSlot';
import { DetailScreen } from './DetailScreen';

/**
 * «Сеть»: пока `down`, загрузка модуля меню отказывает, как отказал бы `import()` чанка.
 * `attempts` — сколько раз модуль реально запрашивали: запомненный промис не запрашивает.
 */
const network = vi.hoisted(() => ({ down: false, attempts: 0 }));

installCrashTrap();

const ENTITY_ID = '00000000-0000-4000-8000-000000000a01';

beforeEach(() => {
  localStorage.clear();
  resetDetailMenuModuleForTests();
  // Мок — заново на каждый тест: реестр модулей vitest помнит УДАВШУЮСЯ загрузку, и без
  // перерегистрации второй тест получил бы меню из кеша прошлого — «сети нет» не проверялось бы.
  vi.doMock('./DetailMenu', async (importOriginal) => {
    network.attempts += 1;
    if (network.down) throw new Error('Failed to fetch dynamically imported module');
    return importOriginal();
  });
  // Простой не наступает: загрузку начинает только жест теста.
  vi.stubGlobal('requestIdleCallback', () => 1);
  useNav.setState({
    activeTab: 'browser',
    stacks: { chat: [], browser: [{ kind: 'entity', id: ENTITY_ID }], agenda: [], budget: [] },
  });
});

afterEach(() => {
  vi.doUnmock('./DetailMenu');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  network.down = false;
  network.attempts = 0;
});

/** Граница ошибок экрана, как в роутере; смена `resetKey` — уход с экрана и возврат. */
function Screen() {
  const [visit, setVisit] = useState(0);
  return (
    <>
      <button type="button" data-testid="revisit" onClick={() => setVisit((v) => v + 1)}>
        снова
      </button>
      <ChunkErrorBoundary resetKey={`entity-${visit}`}>
        <DetailScreen entityId={ENTITY_ID} />
      </ChunkErrorBoundary>
    </>
  );
}

const handler = (path: string) => {
  if (path === 'entity.get')
    return {
      entity: wireEntity({ id: ENTITY_ID, title: 'Задача', aspects: ['orbis/task'] }),
      relations: [],
      thread: null,
    };
  return registryReply(path) ?? {};
};

test('чанк меню не приехал: нажатие — кадр ошибки экрана; после возврата сети жест грузит меню заново', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  network.down = true;
  renderWithProviders(<Screen />, handler);
  fireEvent.click(await screen.findByTestId('detail-menu'));
  expect(await screen.findByText('Не удалось открыть экран')).toBeInTheDocument();

  network.down = false;
  fireEvent.click(screen.getByTestId('revisit'));
  fireEvent.click(await screen.findByTestId('detail-menu'));
  expect(await screen.findByRole('menuitem', { name: 'Скопировать ссылку' })).toBeInTheDocument();
});

test('отказ прогрева (наведение) молчит, кнопка жива: жест повторяет загрузку', async () => {
  // Необработанный отказ vitest ловит только ПОСЛЕ теста, под чужим именем, — ловим его здесь.
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  network.down = true;
  renderWithProviders(<Screen />, handler);
  const button = await screen.findByTestId('detail-menu');
  fireEvent.pointerEnter(button);
  fireEvent.focus(button);
  // Дать отказу прогрева осесть: он не должен ни уронить экран, ни стать необработанным.
  await new Promise((r) => setTimeout(r, 50));
  process.off('unhandledRejection', onUnhandled);
  // Прогрев действительно ходил за модулем (и получил отказ), а не взял запомненный.
  expect(network.attempts).toBe(1);
  expect(unhandled).toEqual([]);
  expect(screen.queryByText('Не удалось открыть экран')).toBeNull();

  network.down = false;
  fireEvent.click(screen.getByTestId('detail-menu'));
  expect(await screen.findByRole('menuitem', { name: 'Скопировать ссылку' })).toBeInTheDocument();
  // Жест повторил загрузку: отказ прогрева не запомнен.
  expect(network.attempts).toBe(2);
});
