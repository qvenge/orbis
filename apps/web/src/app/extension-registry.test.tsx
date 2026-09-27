/**
 * Реестр карточек расширений и свои карточки ядра (спека 1б §4.1, §8.5; РП-23).
 *
 * Порядок и состав своих карточек объявляет shared (`ownCardOrder()` — ранги манифестов и хоста), а
 * компоненты — web. Две половины одного списка сверяются здесь: карточка, объявленная в манифесте,
 * но без компонента, молча пропала бы с экрана; компонент без объявления встал бы вне порядка.
 */
import { EXTENSION_IDS, EXTENSION_MANIFESTS, ownCardOrder } from '@orbis/shared';
import { expect, test } from 'vitest';
import { ownCardComponents } from '../features/entity-detail/own-cards';
import { EXTENSION_CARDS } from './extension-registry';

test('ownCardComponents() — ровно карточки ownCardOrder(), в порядке рангов', () => {
  const cards = ownCardComponents();
  expect(cards.map((c) => c.aspect)).toEqual(ownCardOrder().map((c) => c.aspect));
  expect(cards.map((c) => c.rank)).toEqual(ownCardOrder().map((c) => c.rank));
  // Порядок снимка 1а (РП-23): цель, исполнитель, рутина, прогон, финансы.
  expect(cards.map((c) => c.aspect)).toEqual([
    'orbis/goal',
    'orbis/assignment',
    'orbis/routine',
    'orbis/agent-run',
    'orbis/financial',
  ]);
});

test('у карточки расширения extension — id манифеста, объявившего её; у карточки ядра — null', () => {
  const declaredBy = new Map(
    EXTENSION_IDS.flatMap((id) =>
      EXTENSION_MANIFESTS[id].cards.map((c) => [c.aspect, id] as const),
    ),
  );
  // Реестр web знает ровно карточки манифестов — ни одной лишней, ни одной забытой.
  expect(new Set(Object.keys(EXTENSION_CARDS))).toEqual(new Set(declaredBy.keys()));
  for (const card of ownCardComponents()) {
    expect(card.extension, card.aspect).toBe(declaredBy.get(card.aspect) ?? null);
  }
  expect(EXTENSION_CARDS['orbis/goal']?.extension).toBe('goals');
  expect(EXTENSION_CARDS['orbis/financial']?.extension).toBe('finance');
});

test('showWhen: карточка исполнителя — у любой задачи, прочие — по своему аспекту', () => {
  const byAspect = new Map(ownCardComponents().map((c) => [c.aspect, c]));
  const task = { aspects: ['orbis/task'] };
  expect(byAspect.get('orbis/assignment')?.showWhen(task)).toBe(true);
  expect(byAspect.get('orbis/goal')?.showWhen(task)).toBe(false);
  expect(byAspect.get('orbis/goal')?.showWhen({ aspects: ['orbis/goal'] })).toBe(true);
  expect(byAspect.get('orbis/financial')?.showWhen({ aspects: ['orbis/financial'] })).toBe(true);
});
