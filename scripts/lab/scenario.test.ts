import { describe, expect, test } from 'bun:test';
import { SEARCH_TEXT_MAX, searchTextOf } from './scenario';

// Браузер не запускается: проверяется только чистая часть сценария.
describe('лаборатория: строка поиска по заголовку', () => {
  test('режет только по границе слова — поиск хоста ищет целые слова', () => {
    // обрезка на 18-м знаке дала бы «Протестировать вык» — полнотекст по «вык» «выкатку» не найдёт
    expect(searchTextOf('Протестировать выкатку плана А на проде', 18)).toBe('Протестировать');
    expect(searchTextOf('Протестировать выкатку плана А на проде', 22)).toBe(
      'Протестировать выкатку',
    );
    expect(searchTextOf('  Купить   хлеба  ')).toBe('Купить хлеба');
  });
  test('первое слово — целиком, даже длиннее потолка; суррогатная пара не рвётся', () => {
    expect(searchTextOf('Сверхдлинноесловобезпробелов и хвост', 5)).toBe(
      'Сверхдлинноесловобезпробелов',
    );
    // длина — в кодовых точках: «🚀» — один знак, а в UTF-16 два
    expect(searchTextOf('🚀🚀 ракета', 9)).toBe('🚀🚀 ракета');
    expect(searchTextOf('ab🚀 cd', 4)).toBe('ab🚀');
  });
  test('потолок по умолчанию — 40 знаков', () => {
    const title = `${'слово '.repeat(10)}конец`;
    const text = searchTextOf(title);
    expect([...text].length).toBeLessThanOrEqual(SEARCH_TEXT_MAX);
    expect(title.startsWith(text)).toBe(true);
    expect(text.endsWith('слово')).toBe(true);
  });
});
