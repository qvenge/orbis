/**
 * Структура экрана записи против эталона (приёмка С1а-5, база сторожа С1а-6; РП-10, РП-11).
 *
 * Эталон снят задачей 2 на экране до среза 1а; не перезаписывается; задача 14 сравнивает через
 * `INTENDED_1A`. Три намеренных отличия нового экрана (спека §8.2) снимаются функцией поверх
 * `golden/*.json`, а не правкой файлов: пересъёмка эталона с нового экрана превратила бы
 * приёмку «расхождения — только намеренные» в «экран похож сам на себя».
 *
 * Съёмка — `structure.capture.test.tsx` (по `CAPTURE=1`); этот файл только сверяет.
 */
import { BUILTIN_ASPECT_IDS } from '@orbis/shared';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { installCrashTrap } from '../../test/harness';
import goldenRequests from './golden/detail-requests.json';
import goldenStructure from './golden/detail-structure.json';
import { captureDetail, STRUCTURE_FIXTURES, type StructureFixture } from './structure-fixtures';
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

test('проба средства: снимок цели видит вкладки, прогресс и карточку аспекта', async () => {
  const { structure } = await captureDetail(fixture('goal'));
  expect(structure.tabs.map((t) => t.label)).toEqual(['Сущность', 'Детали', 'Тред']);
  expect(structure.tabs[0]?.parts).toContain('goal-progress');
  expect(structure.tabs[1]?.parts.some((p) => p.startsWith('aspect:orbis/goal['))).toBe(true);
});

test('фикстуры покрывают все 13 встроенных аспектов и частые сочетания', () => {
  const single = STRUCTURE_FIXTURES.filter((f) => f.entity.aspects.length === 1).map(
    (f) => f.entity.aspects[0],
  );
  expect(new Set(single)).toEqual(new Set(BUILTIN_ASPECT_IDS));
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
 * Карточка, которой аспект виден на экране. У двух аспектов общей секции нет
 * (`HIDDEN_ASPECT_CARDS` в AspectCards) — их показывает своя карточка.
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

describe('эталон = экран', () => {
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
      expect(got.structure).toEqual(structures[f.name]);
      expect(got.requests).toEqual(requests[f.name]);
    });
  }
});
