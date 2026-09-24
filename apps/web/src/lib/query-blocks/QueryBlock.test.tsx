import { screen, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import {
  type BlockReplyValue,
  blocksReply,
  type MockHandler,
  renderWithProviders,
  wireEntity,
} from '../../test/harness';
import { registryReply } from '../../test/registry';
import { QueryBlock } from './QueryBlock';
import { ThisEntityProvider } from './this-entity';

const ent = (id: string) => wireEntity({ id, title: id });

/** Запись-контекст `this`: uuid — схема элемента пачки иного не принимает. */
const P1 = '0198a0c2-0000-7000-8000-0000000000a1';

// Данные блока идут единым механизмом (спека страниц 1а §6.3): пачкой `entity.blocks`, блок —
// ТЕКСТОМ. Смысл тестов прежний — что ушло по блоку и что показано; путь сменился.
const reply =
  (map: Record<string, BlockReplyValue>): MockHandler =>
  (path, input) =>
    registryReply(path) ?? blocksReply(map)(path, input) ?? {};

/** Единственный элемент пачки, ушедший на сервер. */
const sentBlock = (calls: { path: string; input: unknown }[]) =>
  (calls.find((c) => c.path === 'entity.blocks')?.input as { blocks: object[] } | undefined)
    ?.blocks[0];

test('валидный блок → список сущностей + счётчик; в пачку ушёл inner', async () => {
  const { calls } = renderWithProviders(
    <QueryBlock query="tags=work" title="Работа" />,
    reply({ 'tags=work': [ent('a'), ent('b')] }),
  );
  await waitFor(() => expect(screen.getByTestId('qb-count')).toHaveTextContent('2'));
  expect(screen.getAllByTestId('qb-item')).toHaveLength(2);
  // Аргумент запроса — строго inner (обёртка {{query:...}} снята вызывающим, значение не пустое).
  expect(sentBlock(calls)).toEqual({ key: '0', text: 'tags=work' });
});

test('без title (DetailScreen) → счётчик с подписью «Совпадений: N», а не голое число', async () => {
  renderWithProviders(
    <QueryBlock query="tags=work" />,
    reply({ 'tags=work': [ent('a'), ent('b')] }),
  );
  await waitFor(() => expect(screen.getByTestId('qb-count')).toHaveTextContent('Совпадений: 2'));
});

// §3.4: «заголовок (из title=; нет параметра — без заголовка)». Без этого три секции
// Daily Planning (§3.3) рендерились бы тремя безымянными карточками.
test('заголовок берётся из title= самого блока, когда пропа нет', async () => {
  const { calls } = renderWithProviders(
    <QueryBlock query="tags=work, title=Сегодня" />,
    reply({ 'tags=work, title=Сегодня': [ent('a')] }),
  );
  // при заголовке счётчик — голое число (подпись «Совпадений:» не нужна)
  await waitFor(() => expect(screen.getByTestId('qb-count')).toHaveTextContent('1'));
  expect(screen.getByText('Сегодня')).toBeInTheDocument();
  // title= — параметр представления: в пачку строка уходит целиком, как есть
  expect(sentBlock(calls)).toEqual({ key: '0', text: 'tags=work, title=Сегодня' });
});

test('невалидный блок → красная плашка с позицией, без списка и без вызова entity.blocks (§6.4)', async () => {
  const { calls } = renderWithProviders(<QueryBlock query="foo" title="Битый" />, (path) => {
    const reg = registryReply(path);
    if (reg !== undefined) return reg;
    throw new Error(`unexpected ${path}`); // entity.blocks не должен вызываться
  });
  // Ждём плашку ошибки: к этому моменту регрессный вызов entity.blocks успел бы зарегистрироваться.
  await screen.findByTestId('qb-error');
  expect(screen.getByRole('alert')).toBeInTheDocument();
  expect(screen.getByTestId('qb-error')).toHaveTextContent('позиция 0');
  expect(screen.getByTestId('qb-error')).toHaveTextContent(/ожидается конструкция/i);
  expect(screen.queryByTestId('qb-item')).not.toBeInTheDocument();
  // §6.4-гейт: при ошибке пачка не уходит вовсе (хук данных у битого блока не зовётся).
  expect(calls.some((c) => c.path === 'entity.blocks')).toBe(false);
});

// --- контекст сущности: `this` в блоке (§6.1) ------------------------------------------
// Компилятор разрешает `this` только из thisEntityId (`query/compile-ast.ts` → `relTarget`), а виджет его
// не передавал — блоки заготовки проекта (children_of=this) отвечали структурной ошибкой
// «this вне контекста сущности». Проверяем оба края: с провайдером id уходит, без него — нет.
test('внутри ThisEntityProvider элемент пачки получает thisEntityId (this разрешим)', async () => {
  const { calls } = renderWithProviders(
    <ThisEntityProvider id={P1}>
      <QueryBlock query="children_of=this, aspect=orbis/task" />
    </ThisEntityProvider>,
    reply({ 'children_of=this, aspect=orbis/task': [ent('a')] }),
  );
  await waitFor(() => expect(screen.getByTestId('qb-count')).toHaveTextContent('1'));
  expect(sentBlock(calls)).toEqual({
    key: '0',
    text: 'children_of=this, aspect=orbis/task',
    thisEntityId: P1,
  });
});

// Вне ТЕЛА записи (Browser, закреплённые списки) контекст не передаётся намеренно: поля в
// запросе быть НЕ должно — иначе виджет тихо подставил бы чужой контекст.
test('без провайдера поля thisEntityId в запросе нет вовсе', async () => {
  const { calls } = renderWithProviders(
    <QueryBlock query="children_of=this, aspect=orbis/task" />,
    reply({}),
  );
  await waitFor(() => expect(screen.getByTestId('qb-count')).toBeInTheDocument());
  expect(sentBlock(calls)).toEqual({ key: '0', text: 'children_of=this, aspect=orbis/task' });
});

// --- блок ДОКУМЕНТА: {ast, text} ---------------------------------------------------------

test('привязанный блок уходит на сервер ТЕКСТОМ (key-печатью дерева), заголовок — из него', async () => {
  // Было: дерево уходило на сервер как есть (§А11-1). Единый механизм данных (спека страниц 1а
  // §6.3) адресует блок текстом: текст привязанного блока — key-печать его же дерева
  // (`bindQueryBlocks`), сервер разбирает его реестром владельца, а ключ кеша по тексту общий у
  // первого кадра (дерева там нет) и у редактора.
  const ast = { filter: { tag: 'work' }, title: 'Работа' };
  const { calls } = renderWithProviders(
    <QueryBlock query={{ ast, text: 'tags=work, title=Работа' }} />,
    reply({ 'tags=work, title=Работа': [ent('a')] }),
  );
  await waitFor(() => expect(screen.getByTestId('qb-count')).toHaveTextContent('1'));
  expect(screen.getByText('Работа')).toBeInTheDocument();
  expect(sentBlock(calls)).toEqual({ key: '0', text: 'tags=work, title=Работа' });
});

test('НЕразобранный блок документа: плашка с сообщением из его же text', async () => {
  // `ast === null` значит «дерева нет». Сообщение берётся разбором `text` — того же самого,
  // что лежит в блоке: иначе владелец видел бы отказ, не относящийся к его запросу.
  const { calls } = renderWithProviders(
    <QueryBlock query={{ ast: null, text: 'foo' }} />,
    (path) => {
      const reg = registryReply(path);
      if (reg !== undefined) return reg;
      throw new Error(`unexpected ${path}`);
    },
  );
  await screen.findByTestId('qb-error');
  expect(screen.getByTestId('qb-error')).toHaveTextContent(/ожидается конструкция/i);
  expect(calls.some((c) => c.path === 'entity.blocks')).toBe(false);
});

test('ПУСТОЙ блок — плашка «блок не настроен», а НЕ все сущности владельца (Р-21-8)', async () => {
  // Грамматика пустой запрос принимает: `parseQueryAst('')` → `{filter: null}`, законное
  // дерево «весь корпус». До реформы такой блок отвергал вход `min(1)` и показывал пустой
  // список; молча превратить его во «все сущности» значило бы сменить смысл при обновлении.
  for (const text of ['', '   ', '\n  ']) {
    const { calls, unmount } = renderWithProviders(
      <QueryBlock query={{ ast: null, text }} />,
      (path) => {
        const reg = registryReply(path);
        if (reg !== undefined) return reg;
        throw new Error(`unexpected ${path}`);
      },
    );
    await screen.findByTestId('qb-error');
    expect(screen.getByTestId('qb-error')).toHaveTextContent(/пустой запрос/i);
    expect(calls.some((c) => c.path === 'entity.blocks')).toBe(false);
    unmount();
  }
});

test('блок БЕЗ дерева, но с разбираемым текстом, живёт как раньше (markdown-путь)', async () => {
  // `ast === null` бывает не только у отказа: так выглядит любой блок, построенный разбором
  // markdown в браузере («Применить» в MarkdownToggle) — реестра в том слое нет структурно.
  // Показывать на нём плашку значило бы краснеть на здоровом запросе владельца.
  const { calls } = renderWithProviders(
    <QueryBlock query={{ ast: null, text: 'tags=work' }} />,
    reply({ 'tags=work': [ent('a')] }),
  );
  await waitFor(() => expect(screen.getByTestId('qb-count')).toHaveTextContent('1'));
  expect(screen.queryByTestId('qb-error')).toBeNull();
  expect(sentBlock(calls)).toEqual({ key: '0', text: 'tags=work' });
});

test('отказ блока сервером — ПЛАШКА с причиной, а не «Совпадений: 0» (§А5-3ж/§6.4)', async () => {
  // Клиентская предпроверка ловит не всё: реестр сервера — правда, и расхождение с ним
  // (свойство снято между загрузкой реестра и запросом, сбой исполнения) видно только по
  // ответу. Раньше ответ-ошибку никто не смотрел, `entities = list.data ?? []` давал пустой
  // список — молчаливый ноль строк, худший из отказов.
  const { calls } = renderWithProviders(
    <QueryBlock query="tags=work" />,
    reply({
      'tags=work': {
        ok: false,
        error: { code: 'UNKNOWN_PROPERTY', message: "неизвестное свойство 'user/нет-такого'" },
      },
    }),
  );
  await screen.findByTestId('qb-error');
  expect(screen.getByTestId('qb-error')).toHaveTextContent(/нет-такого/);
  expect(screen.queryByTestId('qb-count')).toBeNull();
  expect(calls.some((c) => c.path === 'entity.blocks')).toBe(true);
});

test('отказ ВСЕЙ пачки (сеть, сервер) — русская плашка, а не вечная загрузка и не «Failed to fetch»', async () => {
  renderWithProviders(<QueryBlock query="tags=work" />, (path) => {
    const reg = registryReply(path);
    if (reg !== undefined) return reg;
    // Так браузер отвечает на обрыв сети: сообщение транспорта английское и владельцу ни о чём.
    if (path === 'entity.blocks') throw new TypeError('Failed to fetch');
    return {};
  });
  const plaque = await screen.findByTestId('qb-error');
  expect(plaque).toHaveTextContent('сервер недоступен — данные блока не получены');
  expect(plaque).not.toHaveTextContent('Failed to fetch');
  expect(screen.queryByRole('status')).toBeNull();
});
