import { bindQueryBlocks, parseBody } from '@orbis/shared/doc';
import { FIXTURE_PARSE_REGISTRY } from '@orbis/shared/query/fixtures';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { EditorShell } from '../../features/entity-editor/EditorShell';
import { DataBlock } from '../../features/page/blocks/DataBlock';
import {
  type BlockReplyValue,
  blocksReply,
  blockTexts,
  installCrashTrap,
  type MockHandler,
  renderWithProviders,
  wireEntity,
} from '../../test/harness';
import { registryReply } from '../../test/registry';
import { trpc } from '../../trpc';
import { invalidateGraph } from '../invalidate';
import { ThisEntityProvider } from './this-entity';

// Единый механизм данных блоков (спека страниц 1а §6.3): блок просит «результат моего запроса
// для этого this» по своему ключу, одновременные просьбы уходят ОДНОЙ пачкой `entity.blocks`.

installCrashTrap();

afterEach(() => {
  vi.unstubAllGlobals();
});

const ent = (id: string) => wireEntity({ id, title: id });

/** Реестр + пачка блоков; прочее — пустой ответ (соглашение корпуса). */
const handler =
  (map: Parameters<typeof blocksReply>[0]): MockHandler =>
  (path, input) =>
    registryReply(path) ?? blocksReply(map)(path, input) ?? {};

const batches = (calls: { path: string; input: unknown }[]) =>
  calls.filter((c) => c.path === 'entity.blocks');

test('(а) три блока одного рендера — ОДИН вызов entity.blocks с тремя элементами (С1а-4)', async () => {
  const { calls } = renderWithProviders(
    <>
      <DataBlock text="tags=a" />
      <DataBlock text="tags=b" />
      <DataBlock text="tags=c" />
    </>,
    handler({ 'tags=a': [ent('A')], 'tags=b': [ent('B')], 'tags=c': [ent('C')] }),
  );
  await waitFor(() => expect(screen.getAllByTestId('qb-item')).toHaveLength(3));
  expect(screen.getAllByTestId('qb-item').map((li) => li.textContent)).toEqual(['A', 'B', 'C']);
  expect(batches(calls)).toHaveLength(1);
  expect([...blockTexts(batches(calls)[0] as { input: unknown })].sort()).toEqual([
    'tags=a',
    'tags=b',
    'tags=c',
  ]);
});

test('(б) 31 блок — два вызова (30 + 1), и каждый блок показал СВОИ строки', async () => {
  const texts = Array.from({ length: 31 }, (_, i) => `tags=t${i}`);
  const map: Record<string, BlockReplyValue> = {};
  texts.forEach((t, i) => {
    map[t] = [ent(`строка-${i}`)];
  });
  const { calls } = renderWithProviders(
    texts.map((t) => <DataBlock key={t} text={t} />),
    handler(map),
  );
  await waitFor(() => expect(screen.getAllByTestId('qb-item')).toHaveLength(31));
  // Порядок строк на экране — порядок блоков: ответ разложен по СВОИМ ключам, а не по порядку
  // прихода кусков пачки.
  expect(screen.getAllByTestId('qb-item').map((li) => li.textContent)).toEqual(
    texts.map((_, i) => `строка-${i}`),
  );
  expect(batches(calls).map((c) => blockTexts(c).length)).toEqual([30, 1]);
  expect(batches(calls).flatMap(blockTexts).sort()).toEqual([...texts].sort());
});

test('(в) ok:false у одного блока — у него плашка с причиной, соседи со строками', async () => {
  renderWithProviders(
    <>
      <DataBlock text="tags=a" />
      <DataBlock text="orbis/due_date=today" />
      <DataBlock text="tags=c" />
    </>,
    handler({
      'tags=a': [ent('A')],
      'orbis/due_date=today': {
        ok: false,
        error: { code: 'EXECUTION', message: 'свойство «срок сдачи» не найдено' },
      },
      'tags=c': [ent('C')],
    }),
  );
  expect(await screen.findByTestId('qb-error')).toHaveTextContent(
    'свойство «срок сдачи» не найдено',
  );
  await waitFor(() => expect(screen.getAllByTestId('qb-item')).toHaveLength(2));
  expect(screen.getAllByTestId('qb-error')).toHaveLength(1);
});

test('(г) hide_empty прячет ЧЕСТНО пустой блок, но не ошибку', async () => {
  renderWithProviders(
    <>
      <DataBlock text="tags=a, title=Видимый" />
      <DataBlock text="tags=empty, hide_empty, title=Пустой" />
      <DataBlock text="tags=bad, hide_empty, title=Сломанный" />
    </>,
    handler({
      'tags=a, title=Видимый': [ent('A')],
      'tags=bad, hide_empty, title=Сломанный': {
        ok: false,
        error: { code: 'EXECUTION', message: 'запрос блока не выполнился' },
      },
    }),
  );
  await screen.findByTestId('qb-item');
  expect(await screen.findByTestId('qb-error')).toHaveTextContent('запрос блока не выполнился');
  // Все три ответили — загрузки нет ни у кого, и пустой блок не нарисован вовсе.
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByText('Видимый')).toBeInTheDocument();
  expect(screen.queryByText('Пустой')).toBeNull();
  expect(screen.getAllByTestId('qb-count')).toHaveLength(1);
});

function Editable() {
  const [third, setThird] = useState('tags=c');
  return (
    <>
      <DataBlock text="tags=a" />
      <DataBlock text="tags=b" />
      <DataBlock text={third} />
      <button type="button" onClick={() => setThird('tags=d')}>
        править
      </button>
    </>
  );
}

test('(д) правка текста одного блока — вызов с ОДНИМ элементом', async () => {
  const { calls } = renderWithProviders(
    <Editable />,
    handler({
      'tags=a': [ent('A')],
      'tags=b': [ent('B')],
      'tags=c': [ent('C')],
      'tags=d': [ent('D')],
    }),
  );
  await waitFor(() => expect(screen.getAllByTestId('qb-item')).toHaveLength(3));
  fireEvent.click(screen.getByRole('button', { name: 'править' }));
  await waitFor(() => expect(screen.getByText('D')).toBeInTheDocument());
  expect(batches(calls).map(blockTexts)).toEqual([expect.any(Array), ['tags=d']]);
});

test('(е) один текст в первом кадре и в NodeView редактора — ОДИН запрос (общий ключ)', async () => {
  // Документ ПРИВЯЗАН, как его отдаёт сервер (`bindQueryBlocks`): в атрибутах ноды лежит и
  // дерево. Ключ блока — текст, а не дерево: иначе первый кадр (дерева у него нет) и редактор
  // разошлись бы ключами, и блок перезапросился бы на подъёме редактора (recon W3).
  const md = 'Вступление\n\n{{query: tags=work, title=Работа}}';
  const doc = bindQueryBlocks(parseBody(md), FIXTURE_PARSE_REGISTRY);
  vi.stubGlobal('requestIdleCallback', () => 1); // редактор встаёт только по клику
  const { calls } = renderWithProviders(
    <EditorShell doc={doc} markdown={md} onChange={vi.fn()} />,
    handler({ 'tags=work, title=Работа': [ent('Отчёт')] }),
    // staleTime продукта (trpc.ts): без него каждый новый подписчик свежего ключа
    // перезапрашивал бы его, чего продукт не делает.
    { queries: { staleTime: 30_000 } },
  );
  expect(await screen.findByTestId('qb-item')).toHaveTextContent('Отчёт');
  fireEvent.click(screen.getByText('Вступление'));
  await screen.findByTestId('body-editor');
  await waitFor(() => expect(screen.getByTestId('qb-item')).toHaveTextContent('Отчёт'));
  expect(screen.queryByTestId('editor-preview')).toBeNull();
  expect(batches(calls)).toHaveLength(1);
});

function Invalidator() {
  const utils = trpc.useUtils();
  return (
    <button type="button" onClick={() => invalidateGraph(utils)}>
      запись в граф
    </button>
  );
}

test('(ж) invalidateGraph — блоки перезапрашиваются ОДНОЙ пачкой', async () => {
  const { calls } = renderWithProviders(
    <>
      <DataBlock text="tags=a" />
      <DataBlock text="tags=b" />
      <DataBlock text="tags=c" />
      <Invalidator />
    </>,
    handler({ 'tags=a': [ent('A')], 'tags=b': [ent('B')], 'tags=c': [ent('C')] }),
  );
  await waitFor(() => expect(screen.getAllByTestId('qb-item')).toHaveLength(3));
  expect(batches(calls)).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'запись в граф' }));
  await waitFor(() => expect(batches(calls)).toHaveLength(2));
  expect([...blockTexts(batches(calls)[1] as { input: unknown })].sort()).toEqual([
    'tags=a',
    'tags=b',
    'tags=c',
  ]);
});

test('(з) thisEntityId берётся из ThisEntityProvider и попадает в элемент пачки', async () => {
  const { calls } = renderWithProviders(
    <>
      <ThisEntityProvider id="0198a0c2-0000-7000-8000-000000000001">
        <DataBlock text="children_of=this, aspect=orbis/task" />
      </ThisEntityProvider>
      <DataBlock text="tags=вне" />
    </>,
    handler({ 'children_of=this, aspect=orbis/task': [ent('Тикет')] }),
  );
  await waitFor(() => expect(screen.getAllByTestId('qb-count')).toHaveLength(2));
  const items = (batches(calls)[0]?.input as { blocks: Record<string, unknown>[] }).blocks;
  const inside = items.find((b) => b.text === 'children_of=this, aspect=orbis/task');
  const outside = items.find((b) => b.text === 'tags=вне');
  expect(inside?.thisEntityId).toBe('0198a0c2-0000-7000-8000-000000000001');
  // Вне тела записи поля нет вовсе, а не null: чужой контекст не подставляется (this-entity.tsx).
  expect(outside).not.toHaveProperty('thisEntityId');
});
