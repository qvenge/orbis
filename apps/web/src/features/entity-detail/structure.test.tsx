/**
 * Структура экрана записи против эталона (приёмка С1а-5, база сторожа С1а-6; РП-10, РП-11).
 *
 * Эталон снят задачей 2 на экране до среза 1а и не перезаписывается никогда. Новый экран (шаблон
 * хоста, задача 14) сравнивается с `INTENDED_1A(эталон)`: три намеренных отличия (спека §8.2)
 * снимаются поимёнными функциями поверх `golden/*.json`, а не правкой файлов — пересъёмка эталона
 * с нового экрана превратила бы приёмку «расхождения — только намеренные» в «экран похож сам на
 * себя». Любое иное расхождение — дефект экрана, а не повод для четвёртой функции.
 *
 * Съёмка — `structure.capture.test.tsx` (по `CAPTURE=1`); этот файл только сверяет.
 */
import { BUILTIN_ASPECT_IDS } from '@orbis/shared';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { installCrashTrap, renderWithProviders } from '../../test/harness';
import { queryClient } from '../../trpc';
import { DetailScreen } from './DetailScreen';
import goldenRequests from './golden/detail-requests.json';
import goldenStructure from './golden/detail-structure.json';
import { INTENDED_1A } from './intended-1a';
import {
  captureDetail,
  STRUCTURE_FIXTURES,
  type StructureFixture,
  structureHandler,
  TICKET_ROUTINE_FIXTURE,
} from './structure-fixtures';
import type { DetailStructure } from './structure-snapshot';

installCrashTrap();

beforeEach(() => {
  localStorage.clear();
  // Простоя не даём: редактор, вставший сам по таймеру простоя, менял бы дерево посреди
  // стабилизации (приём goal.test.tsx). В снимке тело — один ориентир при любом из двух кадров.
  vi.stubGlobal('requestIdleCallback', () => 1);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const fixture = (name: string): StructureFixture => {
  const f = STRUCTURE_FIXTURES.find((x) => x.name === name);
  if (f === undefined) throw new Error(`нет фикстуры ${name}`);
  return f;
};

test('проба средства: снимок цели видит шапку над вкладками, вкладки и карточку цели одним куском', async () => {
  const { structure } = await captureDetail(fixture('goal'));
  expect(structure.aboveTabs).toEqual(
    expect.arrayContaining(['detail-menu', 'native-row', 'tags-block']),
  );
  expect(structure.tabs.map((t) => t.label)).toEqual(['Запись', 'Детали', 'Тред']);
  expect(structure.tabs[0]?.parts).toContain('goal-progress');
  expect(structure.tabs[0]?.parts.some((p) => p.startsWith('aspect:orbis/goal['))).toBe(true);
});

/**
 * Встроенные аспекты НА МОМЕНТ СЪЁМКИ: эталон снят до аспекта №14; страница — задачи 13–14.
 *
 * Срез, а не живой `BUILTIN_ASPECT_IDS`: задача 4 допишет `orbis/page` в конец списка, и сверка с
 * живым списком покраснела бы на неизменном экране, а эталон перезаписывать нельзя. Срез, а не
 * копия литералом: новый id, вставленный НЕ в конец, сдвинет первые 13 и покрасит тест. Порядок
 * внутри тринадцати здесь не сверяется (сравнение — множеством): его держит эталон структуры,
 * где секции аспектов стоят в порядке реестра.
 */
const ASPECTS_AT_CAPTURE: readonly string[] = BUILTIN_ASPECT_IDS.slice(0, 13);

test('фикстуры покрывают все 13 встроенных аспектов и частые сочетания', () => {
  const single = STRUCTURE_FIXTURES.filter((f) => f.entity.aspects.length === 1).map(
    (f) => f.entity.aspects[0],
  );
  expect(ASPECTS_AT_CAPTURE).toHaveLength(13);
  expect(new Set(single)).toEqual(new Set(ASPECTS_AT_CAPTURE));
  expect(STRUCTURE_FIXTURES.map((f) => f.name)).toEqual(
    expect.arrayContaining([
      'ticket',
      'recurring-payment',
      'project-task',
      'goal-schedule',
      'financial-task',
      'note-plain',
      'with-relations',
    ]),
  );
});

/**
 * Карточка, которой аспект виден на экране. У двух аспектов общей секции нет (объявление
 * `OWN_ASPECT_CARDS` в own-cards.tsx) — их показывает своя карточка.
 */
const OWN_CARD: Readonly<Record<string, string>> = {
  'orbis/assignment': 'assignment-card',
  'orbis/agent-run': 'run-feed',
};

/**
 * Сторож фикстур — НЕЗАВИСИМО от эталона: эталон, снятый с фикстуры, которой экран не ответил,
 * был бы «зелёным» против самого себя. Здесь — что каждая запись действительно показала свою
 * шапку и каждый свой аспект.
 */
describe('каждая фикстура показывает шапку и свои аспекты', () => {
  for (const f of STRUCTURE_FIXTURES) {
    test(f.name, async () => {
      const { structure } = await captureDetail(f);
      const all = [...structure.aboveTabs, ...structure.tabs.flatMap((t) => t.parts)];
      expect(all.length).toBeGreaterThan(0);
      expect(all.some((p) => p === 'native-row' || p === 'native-memory')).toBe(true);
      for (const aspect of f.entity.aspects) {
        const own = OWN_CARD[aspect];
        if (own !== undefined) expect(all, aspect).toContain(own);
        else
          expect(
            all.some((p) => p.startsWith(`aspect:${aspect}[`)),
            aspect,
          ).toBe(true);
      }
    });
  }
});

/**
 * Запросы нового экрана = эталон + ровно один запрос списка шаблонов владельца (РП-11 (2), РП-14).
 * Шаблон хоста лежит в поставке — за его текстом экран не ходит (§6.5).
 */
const withTemplatesList = (golden: Record<string, number>): Record<string, number> => {
  const out = { ...golden, 'entity.query': (golden['entity.query'] ?? 0) + 1 };
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
};

describe('INTENDED_1A(эталон) = экран (С1а-5, С1а-6)', () => {
  const structures = goldenStructure as Record<string, DetailStructure>;
  const requests = goldenRequests as Record<string, Record<string, number>>;

  test('эталон снят ровно с этих фикстур', () => {
    const names = STRUCTURE_FIXTURES.map((f) => f.name).sort();
    expect(Object.keys(structures).sort()).toEqual(names);
    expect(Object.keys(requests).sort()).toEqual(names);
  });

  for (const f of STRUCTURE_FIXTURES) {
    test(f.name, async () => {
      const got = await captureDetail(f);
      expect(got.structure).toEqual(INTENDED_1A(structures[f.name] as DetailStructure));
      expect(got.requests).toEqual(withTemplatesList(requests[f.name] ?? {}));
    });
  }
});

test('«тикет + рутина»: история прогонов одна — в карточке рутины (остаток 1а №29)', async () => {
  // Не через эталон: фикстуры в нём нет и не будет (РП-24) — дубль ловится прямо.
  const f = TICKET_ROUTINE_FIXTURE;
  renderWithProviders(<DetailScreen entityId={f.entity.id} />, structureHandler(f), {
    queries: queryClient.getDefaultOptions().queries,
  });
  const status = await screen.findByTestId('routine-status');
  await screen.findByTestId('ticket-waiting');
  await waitFor(() => expect(screen.getAllByTestId('runs-list').length).toBeGreaterThan(0));
  const lists = screen.getAllByTestId('runs-list');
  expect(lists).toHaveLength(1);
  // Та, что в карточке рутины, — после её состояния, а не в карточке назначения над ним.
  expect(
    status.compareDocumentPosition(lists[0] as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});
