import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { applyTheme, getThemePref, setThemePref } from './theme';

function mockMatchMedia(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    })),
  });
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  // meta[name=theme-color] для проверки обновления
  document.head.querySelector('meta[name="theme-color"]')?.remove();
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'theme-color');
  meta.setAttribute('content', '#fbfbfa');
  document.head.appendChild(meta);
  mockMatchMedia(false);
});

afterEach(() => {
  document.head.querySelector('meta[name="theme-color"]')?.remove();
});

test('getThemePref по умолчанию — system', () => {
  expect(getThemePref()).toBe('system');
});

test("setThemePref('dark') пишет в localStorage и ставит data-theme + meta", () => {
  setThemePref('dark');
  expect(localStorage.getItem('orbis:theme')).toBe('dark');
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
    '#161616',
  );
});

test("setThemePref('light') снимает атрибут и возвращает светлый meta", () => {
  setThemePref('dark');
  setThemePref('light');
  expect(localStorage.getItem('orbis:theme')).toBe('light');
  expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
    '#fbfbfa',
  );
});

test('system-фоллбек: ОС тёмная → data-theme=dark', () => {
  mockMatchMedia(true);
  setThemePref('system');
  expect(document.documentElement.dataset.theme).toBe('dark');
});

test('system-фоллбек: ОС светлая → без data-theme', () => {
  mockMatchMedia(false);
  applyTheme('system');
  expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
});
