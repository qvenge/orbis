// Чипы «Сделать шаблоном для…» (срез 1а §3.2): какие аспекты диалог предлагает. Снимок по встроенному
// реестру, а не по заглушке: новый аспект, который диалог обязан спрятать, краснит здесь.
import { BUILTIN_ASPECT_DEFS } from '@orbis/shared';
import { expect, test } from 'vitest';
import { offeredForTemplate } from './TemplateForDialog';

test('«Поставка», «страница» и служебный прогон агента чипом не предлагаются (Э-19, M-2 гейта задачи 9)', () => {
  const hidden = BUILTIN_ASPECT_DEFS.filter((a) => !offeredForTemplate(a)).map((a) => a.id);
  expect(hidden).toEqual(['orbis/agent-run', 'orbis/page', 'orbis/supply']);
  // Не вырожденно: обычные аспекты и «приложение» на месте.
  const shown = BUILTIN_ASPECT_DEFS.filter(offeredForTemplate).map((a) => a.id);
  expect(shown).toContain('orbis/task');
  expect(shown).toContain('orbis/app');
});
