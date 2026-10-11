/**
 * Дата строки формы `list` — в поясе ОТВЕТА блока (М-2 финального ревью C, «Фокус ревью» п. 1): блок
 * «Просрочено» Повестки стоит над лентой по дням, и лента печатает день в поясе владельца; строка
 * `list` в поясе браузера разошлась бы с ней на день около полуночи. Пояс процесса теста — `UTC`
 * (закреплён и сверен ниже), пояс ответа — `Asia/Novosibirsk` (+07, `BLOCKS_TIME_ZONE` мока пачки):
 * встреча 28.09 в 00:30 по Новосибирску — это 27.09 17:30 UTC.
 */
import { screen, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  BLOCKS_TIME_ZONE,
  blocksReply,
  installCrashTrap,
  type MockHandler,
  renderWithProviders,
  wireEntity,
} from '../../../test/harness';
import { registryReply } from '../../../test/registry';
import { formatDay } from '../../browser/EntityRow';
import { DataBlock } from './DataBlock';

installCrashTrap();

const savedTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'UTC';
});
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

const MIDNIGHT_NSK = '2026-09-27T17:30:00.000Z';

test('пояс процесса — UTC, пояс ответа — Новосибирск: иначе порча «пояс браузера» незаметна', () => {
  expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('UTC');
  expect(BLOCKS_TIME_ZONE).toBe('Asia/Novosibirsk');
  expect(formatDay(MIDNIGHT_NSK)).toBe('27 сент.');
});

test('list: встреча 28.09 00:30 по поясу владельца — «28 сент.», не день браузера', async () => {
  const text = 'aspect=orbis/schedule, display=list';
  const meeting = wireEntity({
    id: 'Встреча',
    title: 'Встреча',
    aspects: ['orbis/schedule'],
    props: { 'orbis/start_at': MIDNIGHT_NSK },
  });
  const handler: MockHandler = (path, input) =>
    registryReply(path) ?? blocksReply({ [text]: [meeting] })(path, input) ?? {};
  renderWithProviders(<DataBlock text={text} />, handler);
  const item = await screen.findByTestId('qb-item');
  await waitFor(() => expect(item).toHaveTextContent('28 сент.'));
  expect(item).not.toHaveTextContent('27 сент.');
});

test('formatDay: день без времени — как есть в любом поясе; битая зона — пояс браузера без исключения', () => {
  expect(formatDay('2026-09-28', 'Asia/Novosibirsk')).toBe('28 сент.');
  expect(formatDay(MIDNIGHT_NSK, 'Asia/Novosibirsk')).toBe('28 сент.');
  expect(formatDay(MIDNIGHT_NSK, 'Нет/Такой')).toBe('27 сент.');
});
