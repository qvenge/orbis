// packages/shared/src/nav/links.test.ts
// ЗАЧЕМ ЭТОТ ТЕСТ: маршруты — публичный контракт приложения (02-core-os §1.3). Ссылку
// на экран пользователь кладёт в закладки и отправляет себе же в другой браузер, поэтому
// цена ошибки здесь не «неудобно», а «ссылка ведёт не туда» или «ссылка мертва».
// Тест держит три инварианта: round-trip (что построили — то и разобрали), отказ вместо
// догадки на чужом и битом пути, и стабильную вкладку экрана (её читает системный «назад»).
import { describe, expect, test } from 'bun:test';
import { buildAppPath, parseAppPath, tabOfScreen } from './links';

const ID = '0198f0a1-1111-7000-8000-000000000001';

describe('контракт маршрутов (02-core-os §1.3)', () => {
  test('round-trip: путь ↔ экран', () => {
    const screens = [
      { kind: 'tab-root', tab: 'chat' },
      { kind: 'tab-root', tab: 'browser' },
      { kind: 'tab-root', tab: 'agenda' },
      { kind: 'tab-root', tab: 'budget' },
      { kind: 'entity', id: ID },
      { kind: 'thread', threadId: ID },
      { kind: 'budget-category', id: ID },
    ] as const;
    for (const s of screens) expect(parseAppPath(buildAppPath(s))).toEqual(s);
  });

  test('пути записаны буквально — форма ссылки часть контракта, а не деталь реализации', () => {
    expect(buildAppPath({ kind: 'tab-root', tab: 'budget' })).toBe('/budget');
    expect(buildAppPath({ kind: 'entity', id: ID })).toBe(`/entity/${ID}`);
    expect(buildAppPath({ kind: 'thread', threadId: ID })).toBe(`/thread/${ID}`);
    expect(buildAppPath({ kind: 'budget-category', id: ID })).toBe(`/budget/category/${ID}`);
  });

  test('чужой и битый путь — null, а не догадка', () => {
    expect(parseAppPath('/entity/not-a-uuid')).toBeNull();
    expect(parseAppPath('/nope')).toBeNull();
    expect(parseAppPath('/entity')).toBeNull();
    expect(parseAppPath('/entity/')).toBeNull();
    expect(parseAppPath(`/entity/${ID}/edit`)).toBeNull(); // лишний хвост — не «почти entity»
    expect(parseAppPath(`/budget/${ID}`)).toBeNull(); // категория живёт только под /budget/category
    expect(parseAppPath('/budget/category')).toBeNull();
    expect(parseAppPath('')).toBeNull();
    expect(parseAppPath('/')).toBeNull();
    expect(parseAppPath('budget')).toBeNull(); // без ведущего слэша это не путь приложения
    expect(parseAppPath('//budget')).toBeNull();
  });

  test('ровно один завершающий слэш прощаем, регистр литералов — нет', () => {
    expect(parseAppPath('/budget/')).toEqual({ kind: 'tab-root', tab: 'budget' });
    expect(parseAppPath(`/entity/${ID}/`)).toEqual({ kind: 'entity', id: ID });
    expect(parseAppPath('/budget//')).toBeNull();
    expect(parseAppPath('/Budget')).toBeNull();
    expect(parseAppPath(`/Entity/${ID}`)).toBeNull();
    expect(parseAppPath(`/budget/Category/${ID}`)).toBeNull();
  });

  test('на вход только pathname: query и хеш путём не считаются', () => {
    expect(parseAppPath('/budget?tab=envelopes')).toBeNull();
    expect(parseAppPath('/budget#top')).toBeNull();
    expect(parseAppPath(`/entity/${ID}?from=chat`)).toBeNull();
  });

  test('UUID в любом регистре разбирается и приводится к нижнему — id годится как ключ кеша', () => {
    expect(parseAppPath(`/entity/${ID.toUpperCase()}`)).toEqual({ kind: 'entity', id: ID });
    expect(parseAppPath(`/thread/${ID.toUpperCase()}`)).toEqual({ kind: 'thread', threadId: ID });
    expect(parseAppPath(`/budget/category/${ID.toUpperCase()}`)).toEqual({
      kind: 'budget-category',
      id: ID,
    });
  });

  test('вкладка экрана', () => {
    expect(tabOfScreen({ kind: 'entity', id: ID })).toBe('browser');
    expect(tabOfScreen({ kind: 'budget-category', id: ID })).toBe('budget');
    expect(tabOfScreen({ kind: 'tab-root', tab: 'agenda' })).toBe('agenda');
    expect(tabOfScreen({ kind: 'tab-root', tab: 'chat' })).toBe('chat');
    // Тред по умолчанию — тред сущности, а он живёт в Browser. Глобальный тред (Chat) —
    // особый случай, который знает только вызывающий по данным: чистая функция угадывать
    // его не может и не пытается (§1.3).
    expect(tabOfScreen({ kind: 'thread', threadId: ID })).toBe('browser');
  });
});
