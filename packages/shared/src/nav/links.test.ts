// packages/shared/src/nav/links.test.ts
// Путь экрана согласия OAuth — контракт сервера (метаданные authorization server) и SPA (выбор
// экрана в main.tsx). Контракт маршрутов вкладок 1а снят срезом 1б — адреса стережёт
// `address.test.ts`.
import { describe, expect, test } from 'bun:test';
import { parseAddress } from './address';
import { isOAuthAuthorizePath, OAUTH_AUTHORIZE_PATH } from './links';

// ---------------------------------------------------------------------------
// Экран согласия OAuth (§9.3, слайс 4b): один путь на два пакета
// ---------------------------------------------------------------------------
//
// ЗАЧЕМ: до этой константы путь `/oauth/authorize` был записан ДВАЖДЫ и независимо —
// в `authorization_endpoint` метаданных сервера (apps/server/src/oauth/metadata.ts) и в
// выборе экрана в SPA (apps/web/src/main.tsx). Односторонний переезд сервера ловил пин в
// metadata.test.ts, а вот согласованное переименование в сервере ВМЕСТЕ с его тестом
// оставляло SPA со старым литералом: метаданные увели бы владельца по ссылке, на которой
// рендерится обычное приложение вместо экрана согласия, и ни один тест этого не увидел бы
// (main.tsx не импортирует ни один тест проекта). Теперь правда одна, и пины ниже — про
// саму форму пути, а не про совпадение двух копий.

describe('путь экрана согласия OAuth (§9.3)', () => {
  test('канонический путь записан буквально: он уезжает в метаданные наружу', () => {
    // Литерал здесь намеренный и единственный на весь монорепо: это и есть контракт.
    expect(OAUTH_AUTHORIZE_PATH).toBe('/oauth/authorize');
    // Ведущий слэш и отсутствие хвостового — сервер клеит `${origin}${PATH}`
    expect(OAUTH_AUTHORIZE_PATH.startsWith('/')).toBe(true);
    expect(OAUTH_AUTHORIZE_PATH.endsWith('/')).toBe(false);
  });

  test('канонический путь распознаётся, хвостовые слэши прощаются', () => {
    expect(isOAuthAuthorizePath(OAUTH_AUTHORIZE_PATH)).toBe(true);
    // Ссылка на согласие приходит к владельцу через руки и копипасту: слэш дописывают
    // браузеры и почтовые клиенты, и мёртвая от этого ссылка была бы чистой обидой.
    expect(isOAuthAuthorizePath('/oauth/authorize/')).toBe(true);
    expect(isOAuthAuthorizePath('/oauth/authorize///')).toBe(true);
  });

  test('чужой путь — не «почти наш»: подстрока, префикс и регистр не проходят', () => {
    for (const path of [
      '/',
      '/chat',
      '/oauth',
      '/oauth/authorized',
      '/oauth/authorize/extra',
      '/x/oauth/authorize',
      '/OAuth/Authorize',
      // pathname приходит без query и хеша; если вызывающий передал их — это не наш путь,
      // а не «наш с хвостом»: молча отбросить хвост значило бы сделать вид, что мы его поняли
      '/oauth/authorize?client_id=x',
      '/oauth/authorize#frag',
      // без ведущего слэша это не pathname вовсе
      'oauth/authorize',
      '',
    ]) {
      expect(isOAuthAuthorizePath(path), path).toBe(false);
    }
  });

  test('адресом приложения согласие НЕ является: разбор адреса о нём не знает', () => {
    // Оно живёт вне OnboardingGate и вне навигации (main.tsx), поэтому parseAddress обязан
    // отвечать null: попади оно в адреса — «назад» и рамка начали бы считать экран согласия
    // частью приложения.
    expect(parseAddress(OAUTH_AUTHORIZE_PATH)).toBeNull();
  });
});
