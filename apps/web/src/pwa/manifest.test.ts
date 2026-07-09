import { expect, test } from 'vitest';
import { pwaManifest } from './manifest';

test('манифест несёт имя, standalone, theme_color токена и scope', () => {
  expect(pwaManifest.name).toBe('Orbis');
  expect(pwaManifest.display).toBe('standalone');
  expect(pwaManifest.theme_color).toBe('#fbfbfa');
  expect(pwaManifest.background_color).toBe('#fbfbfa');
  expect(pwaManifest.start_url).toBe('/');
  expect(pwaManifest.scope).toBe('/');
});

test('есть иконка с purpose maskable', () => {
  expect(pwaManifest.icons.length).toBeGreaterThan(0);
  expect(pwaManifest.icons.some((i) => i.purpose?.includes('maskable'))).toBe(true);
});
