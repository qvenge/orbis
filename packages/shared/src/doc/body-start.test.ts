import { describe, expect, test } from 'bun:test';
import { BODY_START_MAX, bodyStartOf } from './body-start';

const p = (...text: Array<string | { br: true }>) => ({
  type: 'paragraph',
  content: text.map((t) =>
    typeof t === 'string' ? { type: 'text', text: t } : { type: 'hardBreak' },
  ),
});
describe('начало текста (§9)', () => {
  test('первая непустая строка; блоки, маркеры и разметка пропускаются', () => {
    expect(
      bodyStartOf([
        { type: 'queryBlock', attrs: { text: 'aspect=orbis/task' } },
        { type: 'recordBlock', attrs: { name: 'title' } },
        p('  '),
        { type: 'heading', content: [{ type: 'text', text: 'План' }] },
      ]),
    ).toBe('План');
    expect(
      bodyStartOf([
        { type: 'rawBlock', attrs: { markdown: '| a |' } },
        { type: 'bulletList', content: [{ type: 'listItem', content: [p('купить хлеб')] }] },
      ]),
    ).toBe('купить хлеб');
    expect(bodyStartOf([p('', { br: true }, 'вторая строка')])).toBe('вторая строка');
    expect(
      bodyStartOf([
        { type: 'aspectCard', attrs: { text: 'orbis/task' } },
        { type: 'ownCards' },
        { type: 'hostBlock', attrs: { name: 'nav' } },
      ]),
    ).toBeNull();
    expect(bodyStartOf([{ type: 'queryBlock', content: [p('скрыто')] }, p('видно')])).toBe('видно');
    expect(bodyStartOf([p('до ', { br: true }, 'после')])).toBe('до');
    expect(bodyStartOf([])).toBeNull();
  });
  test('≤160 символов, граница слова и одно длинное слово', () => {
    const s = bodyStartOf([p(`${'слово '.repeat(40)}конец`)]) ?? '';
    expect(s.length).toBeLessThanOrEqual(BODY_START_MAX);
    expect(s.endsWith('…')).toBe(true);
    expect(s.slice(0, -1).endsWith(' ')).toBe(false);
    expect(bodyStartOf([p('x'.repeat(200))])).toBe(`${'x'.repeat(BODY_START_MAX - 1)}…`);
  });
  test('unknown[]: null, нетекстовые узлы и сломанный content пропускаются', () => {
    expect(
      bodyStartOf([
        null,
        5,
        false,
        'текст',
        { type: 'paragraph', content: 'сломано' },
        { type: 'bulletList', content: [null, { type: 'listItem', content: 1 }] },
        {
          type: 'paragraph',
          content: [
            null,
            { type: 'queryBlock', text: 'скрыто' },
            { type: 'text', text: 5 },
            { type: 'text', text: 'живой текст', marks: [{ type: 'bold' }] },
          ],
        },
      ]),
    ).toBe('живой текст');
  });
  test('обрезка длинного слова не оставляет половину surrogate pair', () => {
    expect(bodyStartOf([p(`${'x'.repeat(158)}😀${'y'.repeat(20)}`)])).toBe(`${'x'.repeat(158)}…`);
  });
});
