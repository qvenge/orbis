import { screen, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderWithProviders } from '../../test/harness';
import { registryReply } from '../../test/registry';
import { QueryBlock } from './QueryBlock';
import { ThisEntityProvider } from './this-entity';

const ent = (id: string) => ({
  id,
  ownerId: 'u',
  title: id,
  emoji: null,
  body: '',
  bodyRefs: [],
  tags: [],
  meta: {},
  aspectsMap: {},
  props: {},
  aspects: [],
  queryRefs: [],
  createdAt: 'x',
  updatedAt: 'y',
  archived: false,
});

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
