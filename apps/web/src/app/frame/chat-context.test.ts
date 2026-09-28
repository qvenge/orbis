/**
 * Контекст чата и «＋» (спека 1б §6.4, РП-27, РП-9) — чистые функции над моделью навигации.
 */
import { type Address, HOME_SECTION, HOST_APP, type NavModel } from '@orbis/shared/nav';
import { describe, expect, test } from 'vitest';
import { withRecordContext } from '../../features/chat/record-context';
import { CHAT_ABOUT_VIEW, captureContextOf, chatContextOf } from './chat-context';

const A = '00000000-0000-4000-8000-0000000025a1';
const B = '00000000-0000-4000-8000-0000000025b2';
const APP = '00000000-0000-4000-8000-0000000025c3';

const home: Address = { kind: 'home', app: { kind: 'host' } };
const rec = (id: string): Address => ({ kind: 'record', app: { kind: 'host' }, id });
const chat: Address = { kind: 'host-screen', screen: 'chat' };
const settings: Address = { kind: 'host-screen', screen: 'settings' };

/** Хост, раздел «Домой», стопка из адресов (верх — последний). */
function model(stack: readonly (Address | { address: Address; view: Record<string, string> })[]) {
  return {
    activeApp: HOST_APP,
    apps: {
      [HOST_APP]: {
        activeSection: HOME_SECTION,
        stacks: { [HOME_SECTION]: stack.map((e) => ('address' in e ? e : { address: e })) },
      },
    },
  } satisfies NavModel;
}

describe('chatContextOf: про что открыт чат', () => {
  test("'screen' — место под экраном чата в стопке раздела", () => {
    expect(chatContextOf(model([home, rec(A), chat]), 'screen')).toEqual({ kind: 'record', id: A });
    expect(chatContextOf(model([home, settings, chat]), 'screen')).toBeNull();
    expect(chatContextOf(model([home, chat]), 'screen')).toEqual({ kind: 'home', app: HOST_APP });
    // Под чатом ничего нет (старт по ссылке `/chat` без стопки) — без контекста.
    expect(chatContextOf(model([chat]), 'screen')).toBeNull();
  });

  test("'screen' — чат, открытый с экрана хоста (он встал вместо него), — без контекста", () => {
    // Экран хоста поверх экрана хоста встаёт ВМЕСТО него (§7.3), и место под чатом — уже не то,
    // откуда его позвали: 💬 на «Настройках» помечает чат, и чипа нет (§6.4: экраны хоста — без чипа).
    expect(
      chatContextOf(
        model([home, { address: chat, view: { [CHAT_ABOUT_VIEW]: 'none' } }]),
        'screen',
      ),
    ).toBeNull();
  });

  test("'side' — текущее место основной области", () => {
    expect(chatContextOf(model([home, rec(B)]), 'side')).toEqual({ kind: 'record', id: B });
    expect(chatContextOf(model([home, settings]), 'side')).toBeNull();
    expect(chatContextOf(model([home]), 'side')).toEqual({ kind: 'home', app: HOST_APP });
  });

  test('домашняя своего приложения — его ключ', () => {
    const m: NavModel = {
      activeApp: APP,
      apps: {
        [APP]: {
          activeSection: HOME_SECTION,
          stacks: {
            [HOME_SECTION]: [{ address: { kind: 'home', app: { kind: 'app', ref: APP } } }],
          },
        },
      },
    };
    expect(chatContextOf(m, 'side')).toEqual({ kind: 'home', app: APP });
  });
});

describe('captureContextOf: контекст «＋» (РП-9)', () => {
  test('запись, не страница, — подзадача; страница, домашняя и экраны хоста — без контекста', () => {
    expect(captureContextOf({ kind: 'record', id: A }, false)).toEqual({
      kind: 'entity',
      parentId: A,
    });
    expect(captureContextOf({ kind: 'record', id: A }, true)).toEqual({ kind: 'root' });
    expect(captureContextOf({ kind: 'home', app: HOST_APP }, false)).toEqual({ kind: 'root' });
    expect(captureContextOf(null, false)).toEqual({ kind: 'root' });
  });
});

test('withRecordContext: ссылка на запись первой строкой (РП-27)', () => {
  expect(withRecordContext('когда?', A)).toBe(`[[entity:${A}]]\nкогда?`);
});
