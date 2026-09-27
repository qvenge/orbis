// Чипы «Сделать шаблоном для…» (срез 1а §3.2): какие аспекты диалог предлагает. Снимок по встроенному
// реестру, а не по заглушке: новый аспект, который диалог обязан спрятать, краснит здесь.
import {
  BUILTIN_ASPECT_DEFS,
  HOME_PROPERTY,
  TEMPLATE_FOR_PROPERTY,
  TEMPLATE_WINS_OVER_PROPERTY,
} from '@orbis/shared';
import { expect, test } from 'vitest';
import { homeForTemplate, offeredForTemplate, templateForOperation } from './TemplateForDialog';

test('«Поставка», «страница», «приложение» и служебный прогон агента чипом не предлагаются (Э-19, M-2 гейта задачи 9, R-14)', () => {
  const hidden = BUILTIN_ASPECT_DEFS.filter((a) => !offeredForTemplate(a)).map((a) => a.id);
  expect(hidden).toEqual(['orbis/agent-run', 'orbis/page', 'orbis/app', 'orbis/supply']);
  // Не вырожденно: обычные аспекты на месте.
  const shown = BUILTIN_ASPECT_DEFS.filter(offeredForTemplate).map((a) => a.id);
  expect(shown).toContain('orbis/task');
  // R-14: запись-приложение открывает своё приложение (Р-20) — шаблон для неё не показался бы никогда.
  expect(shown).not.toContain('orbis/app');
});

test('«Дом» шаблона из рамки (§4.3): своё приложение и пустой «Дом» — пишется той же операцией; иначе нет', () => {
  const PAGE = '00000000-0000-4000-8000-00000000b001';
  const APP = '00000000-0000-4000-8000-00000000b002';
  const OTHER = '00000000-0000-4000-8000-00000000b003';
  expect(homeForTemplate(APP, undefined)).toBe(APP);
  expect(homeForTemplate(APP, '')).toBe(APP);
  // Хост — это пустой «Дом»; дом, назначенный владельцем, не перетирается.
  expect(homeForTemplate(null, undefined)).toBeNull();
  expect(homeForTemplate(APP, OTHER)).toBeNull();
  expect(templateForOperation(PAGE, [], ['orbis/task'], APP)).toEqual({
    tool: 'entity_update',
    input: { id: PAGE, props: { [TEMPLATE_FOR_PROPERTY]: ['orbis/task'], [HOME_PROPERTY]: APP } },
  });
  // Снятие всех — черновик остаётся там, где был: «Дом» не трогается.
  expect(templateForOperation(PAGE, ['orbis/task'], [], APP)).toEqual({
    tool: 'entity_update',
    input: { id: PAGE, unset: [TEMPLATE_FOR_PROPERTY, TEMPLATE_WINS_OVER_PROPERTY] },
  });
});
