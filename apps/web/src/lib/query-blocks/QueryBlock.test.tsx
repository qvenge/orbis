import { screen, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderWithProviders, wireEntity } from '../../test/harness';
import { registryReply } from '../../test/registry';
import { QueryBlock } from './QueryBlock';
import { ThisEntityProvider } from './this-entity';

const ent = (id: string) => wireEntity({ id, title: id });

test('валидный блок → список сущностей + счётчик; entity.query получил inner', async () => {
  const { calls } = renderWithProviders(<QueryBlock query="tags=work" title="Работа" />, (path) => {
    const reg = registryReply(path);
    if (reg !== undefined) return reg;
    if (path === 'entity.query') return [ent('a'), ent('b')];
    return {};
  });
  await waitFor(() => expect(screen.getByTestId('qb-count')).toHaveTextContent('2'));
  expect(screen.getAllByTestId('qb-item')).toHaveLength(2);
  // Аргумент запроса — строго inner (обёртка {{query:...}} снята вызывающим, значение не пустое).
  expect(calls.find((c) => c.path === 'entity.query')?.input).toEqual({ query: 'tags=work' });
});

test('без title (DetailScreen) → счётчик с подписью «Совпадений: N», а не голое число', async () => {
  renderWithProviders(<QueryBlock query="tags=work" />, (path) => {
    const reg = registryReply(path);
    if (reg !== undefined) return reg;
    if (path === 'entity.query') return [ent('a'), ent('b')];
    return {};
  });
  await waitFor(() => expect(screen.getByTestId('qb-count')).toHaveTextContent('Совпадений: 2'));
});

// §3.4: «заголовок (из title=; нет параметра — без заголовка)». Без этого три секции
// Daily Planning (§3.3) рендерились бы тремя безымянными карточками.
test('заголовок берётся из title= самого блока, когда пропа нет', async () => {
  const { calls } = renderWithProviders(<QueryBlock query="tags=work, title=Сегодня" />, (path) => {
    const reg = registryReply(path);
    if (reg !== undefined) return reg;
    if (path === 'entity.query') return [ent('a')];
    return {};
  });
  // при заголовке счётчик — голое число (подпись «Совпадений:» не нужна)
  await waitFor(() => expect(screen.getByTestId('qb-count')).toHaveTextContent('1'));
  expect(screen.getByText('Сегодня')).toBeInTheDocument();
  // title= — параметр представления: в entity.query строка уходит целиком, как есть
  expect(calls.find((c) => c.path === 'entity.query')?.input).toEqual({
    query: 'tags=work, title=Сегодня',
  });
});

test('невалидный блок → красная плашка с позицией, без списка и без вызова entity.query (§6.4)', async () => {
  const { calls } = renderWithProviders(<QueryBlock query="foo" title="Битый" />, (path) => {
    const reg = registryReply(path);
    if (reg !== undefined) return reg;
    throw new Error(`unexpected ${path}`); // entity.query не должен вызываться
  });
  // Ждём плашку ошибки: к этому моменту регрессный вызов entity.query успел бы зарегистрироваться.
  await screen.findByTestId('qb-error');
  expect(screen.getByRole('alert')).toBeInTheDocument();
  expect(screen.getByTestId('qb-error')).toHaveTextContent('позиция 0');
  expect(screen.getByTestId('qb-error')).toHaveTextContent(/ожидается конструкция/i);
  expect(screen.queryByTestId('qb-item')).not.toBeInTheDocument();
  // §6.4-гейт: при ошибке entity.query не вызывается вовсе (enabled: ok === false).
  expect(calls.some((c) => c.path === 'entity.query')).toBe(false);
});

// --- контекст сущности: `this` в блоке (§6.1) ------------------------------------------
// Компилятор разрешает `this` только из thisEntityId (`query/compile-ast.ts` → `relTarget`), а виджет его
// не передавал — блоки заготовки проекта (children_of=this) отвечали структурной ошибкой
// «this вне контекста сущности». Проверяем оба края: с провайдером id уходит, без него — нет.
test('внутри ThisEntityProvider entity.query получает thisEntityId (this разрешим)', async () => {
  const { calls } = renderWithProviders(
    <ThisEntityProvider id="p1">
      <QueryBlock query="children_of=this, aspect=orbis/task" />
    </ThisEntityProvider>,
    (path) => {
      const reg = registryReply(path);
      if (reg !== undefined) return reg;
      if (path === 'entity.query') return [ent('a')];
      return {};
    },
  );
  await waitFor(() => expect(screen.getByTestId('qb-count')).toHaveTextContent('1'));
  expect(calls.find((c) => c.path === 'entity.query')?.input).toEqual({
    query: 'children_of=this, aspect=orbis/task',
    thisEntityId: 'p1',
  });
});

// Вне ТЕЛА записи (Browser, закреплённые списки) контекст не передаётся намеренно: поля в
// запросе быть НЕ должно — иначе виджет тихо подставил бы чужой контекст.
test('без провайдера поля thisEntityId в запросе нет вовсе', async () => {
  const { calls } = renderWithProviders(
    <QueryBlock query="children_of=this, aspect=orbis/task" />,
    (path) => {
      const reg = registryReply(path);
      if (reg !== undefined) return reg;
      if (path === 'entity.query') return [];
      return {};
    },
  );
  await waitFor(() => expect(screen.getByTestId('qb-count')).toBeInTheDocument());
  expect(calls.find((c) => c.path === 'entity.query')?.input).toEqual({
    query: 'children_of=this, aspect=orbis/task',
  });
});

// --- блок ДОКУМЕНТА: дерево вместо строки (§А11-1) --------------------------------------

test('привязанный блок уходит на сервер ДЕРЕВОМ, заголовок берётся из дерева', async () => {
  // Разобранный блок реестра не ждёт вовсе: заголовок в дереве, дерево — на сервер. Печатать
  // его обратно в текст, чтобы сервер разобрал заново, значило бы гонять запрос через форму,
  // в которую он не обязан помещаться (§А5-3д).
  const ast = { filter: { tag: 'work' }, title: 'Работа' };
  const { calls } = renderWithProviders(
    <QueryBlock query={{ ast, text: 'tags=work, title=Работа' }} />,
    (path) => {
      const reg = registryReply(path);
      if (reg !== undefined) return reg;
      if (path === 'entity.query') return [ent('a')];
      return {};
    },
  );
  await waitFor(() => expect(screen.getByTestId('qb-count')).toHaveTextContent('1'));
  expect(screen.getByText('Работа')).toBeInTheDocument();
  expect(calls.find((c) => c.path === 'entity.query')?.input).toEqual({ ast });
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
  expect(calls.some((c) => c.path === 'entity.query')).toBe(false);
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
    expect(calls.some((c) => c.path === 'entity.query')).toBe(false);
    unmount();
  }
});

test('блок БЕЗ дерева, но с разбираемым текстом, живёт как раньше (markdown-путь)', async () => {
  // `ast === null` бывает не только у отказа: так выглядит любой блок, построенный разбором
  // markdown в браузере («Применить» в MarkdownToggle) — реестра в том слое нет структурно.
  // Показывать на нём плашку значило бы краснеть на здоровом запросе владельца.
  const { calls } = renderWithProviders(
    <QueryBlock query={{ ast: null, text: 'tags=work' }} />,
    (path) => {
      const reg = registryReply(path);
      if (reg !== undefined) return reg;
      if (path === 'entity.query') return [ent('a')];
      return {};
    },
  );
  await waitFor(() => expect(screen.getByTestId('qb-count')).toHaveTextContent('1'));
  expect(screen.queryByTestId('qb-error')).toBeNull();
  expect(calls.find((c) => c.path === 'entity.query')?.input).toEqual({ query: 'tags=work' });
});
