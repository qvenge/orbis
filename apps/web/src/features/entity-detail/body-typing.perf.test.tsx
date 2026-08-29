/**
 * Замер цены НАЖАТИЯ КЛАВИШИ в теле записи.
 *
 * Лежит в дереве и по умолчанию ПРОПУСКАЕТСЯ. Цена пропущенного файла не нулевая и не та, что
 * тут стояла раньше: сам тест не идёт, но окружение поднимается и экран импортируется — соло
 * ~4.6 с, из них на тест ~1 с. Запуск:
 *
 *   cd apps/web && PERF=1 PERF_OUT=/tmp/perf.txt bun run test src/features/entity-detail/body-typing.perf.test.tsx
 *
 * Чем он был нужен (ре-ревью раунда 2, пункт 2): редакция, кладущая показанный документ в
 * СОСТОЯНИЕ на каждый штрих, переносит на путь клавиши перерисовку тела, сравнение по смыслу
 * (две стабильные сериализации всего документа), пересбор сегментов первого кадра, пересчёт
 * ссылок и эффект приезда.
 *
 * ЧТО ЭТОТ ФАЙЛ МЕРЯЕТ И ЧЕГО НЕ МЕРЯЕТ. Он даёт число для ТЕКУЩЕЙ редакции — и только. Чтобы
 * получить пару и увидеть разницу («+3 мс, +60 %», раунд 2), надо руками вернуть прежнее
 * поведение: в `DetailScreen.onEditorChange` вместо записи в реф позвать `setLocalDoc(next)`,
 * снять числа, вернуть как было. Сам по себе скрипт заявленную разницу НЕ воспроизводит.
 *
 * ДВЕ ОГОВОРКИ, без которых числа читаются неверно:
 *  1. Прогон даёт ОДНО число за процесс, и между процессами разброс мал. Серию всё равно надо
 *     смотреть по медиане, но «первый замер — выброс» относится к прогонам ВНУТРИ процесса, а
 *     здесь такого нет: штрих «на прогрев» внутри теста прогрева не даёт, он лишь снимает с
 *     измеряемого участка первую сериализацию и первый круг эффектов.
 *  2. В jsdom нет ни раскладки, ни отрисовки. Значит постоянная часть круга нажатия занижена, а
 *     ОТНОСИТЕЛЬНАЯ разница между редакциями — ВЕРХНЯЯ оценка: в браузере тот же лишний рендер
 *     утонет в раскладке сильнее, чем здесь.
 */
import { appendFileSync } from 'node:fs';
import { parseBody } from '@orbis/shared/doc';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { useNav } from '../../state/navigation';
import { renderWithProviders, wireEntity } from '../../test/harness';
import { DetailScreen } from './DetailScreen';

/** Бытовое тело: сорок блоков с жирным и курсивом — тот размер, на котором в коде уже замерена
 *  сериализация (~1 мс). Тела бывают и длиннее. */
const BODY = Array.from(
  { length: 40 },
  (_, i) => `Абзац номер ${i} с **жирным** словом и _курсивом_ для веса разбора.`,
).join('\n\n');

const entity = wireEntity({ id: 'e1', title: 'Задача', body: BODY, bodyDoc: parseBody(BODY) });

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('requestIdleCallback', () => 1);
  useNav.setState({
    activeTab: 'browser',
    stacks: { chat: [], browser: [{ kind: 'entity', id: 'e1' }], agenda: [], budget: [] },
  });
});

const CHARS = 30;

test.runIf(process.env.PERF === '1')(
  'ЗАМЕР: тридцать нажатий по телу из сорока блоков',
  async () => {
    renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
      if (path === 'entity.get') return { entity, relations: [], thread: null };
      if (path === 'entity.update') return { ...entity, updatedAt: '2026-07-05T11:00:00.000Z' };
      return {};
    });
    fireEvent.click(await screen.findByTestId('editor-preview'));
    await screen.findByTestId('body-editor', undefined, { timeout: 10_000 });
    const field = screen
      .getByTestId('body-editor')
      .querySelector('[contenteditable]') as HTMLElement;
    await userEvent.click(field);

    // Один штрих ВНЕ замера: он уносит с измеряемого участка первую сериализацию и первый круг
    // эффектов. Прогревом в смысле JIT это не является (см. оговорку 1).
    await userEvent.type(field, 'x');
    await waitFor(() => expect(screen.getByTestId('body-editor')).toHaveTextContent('x'));

    const t0 = performance.now();
    await userEvent.type(field, 'y'.repeat(CHARS));
    const dt = performance.now() - t0;

    const line = `ЗАМЕР: ${CHARS} нажатий за ${dt.toFixed(1)} мс → ${(dt / CHARS).toFixed(2)} мс/штрих\n`;
    const out = process.env.PERF_OUT;
    if (out === undefined) throw new Error(`некуда писать замер: задайте PERF_OUT. ${line}`);
    appendFileSync(out, line);
    expect(dt).toBeGreaterThan(0);
  },
  120_000,
);
