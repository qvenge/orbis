import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { Markdown } from './Markdown';

const E1 = '019e4466-1111-7000-8000-0123456789ab';

test('заголовки, списки и код рендерятся разметкой, а не текстом', () => {
  render(<Markdown source={'## Итоги\n\n- раз\n- два\n\n`code`'} />);
  expect(screen.getByRole('heading', { level: 2, name: 'Итоги' })).toBeInTheDocument();
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  expect(screen.getByText('code').tagName).toBe('CODE');
});

test('gfm: таблица рендерится таблицей и лежит в собственном скролл-контейнере', () => {
  render(<Markdown source={'| товар | сумма |\n| --- | --- |\n| кофе | 340 |'} />);
  const table = screen.getByRole('table');
  expect(screen.getAllByRole('columnheader')).toHaveLength(2);
  // Широкая таблица обязана скроллиться внутри себя, а не растягивать пузырь сообщения.
  expect(table.parentElement?.className).toContain('overflow-x-auto');
});

test('сырой html из источника не исполняется и не попадает в разметку', () => {
  const { container } = render(<Markdown source={'<img src=x onerror="alert(1)">'} />);
  expect(container.querySelector('img')).toBeNull();
  // Оба ассерта различают наличие rehype-sanitize (проверено снятием плагина): сам
  // react-markdown узел сырого HTML не исполняет, но печатает его экранированным текстом,
  // и 'onerror' остаётся в разметке. Схема санитизации выбрасывает такой узел целиком.
  expect(container.innerHTML).not.toContain('onerror');
});

test('javascript:-ссылка обезврежена санитизацией: href снят целиком', () => {
  const onEntityLink = vi.fn();
  const { container } = render(
    <Markdown source={'[жми](javascript:alert(1))'} onEntityLink={onEntityLink} />,
  );
  const link = container.querySelector('a');
  expect(link).not.toBeNull();
  // Атрибут снят ЦЕЛИКОМ — подпись rehype-sanitize: сам react-markdown опасный протокол
  // тоже не пропускает, но оставляет пустой href="" (проверено снятием плагина).
  expect(link).not.toHaveAttribute('href');
  expect(container.innerHTML).not.toContain('javascript:');
  fireEvent.click(link as HTMLAnchorElement);
  expect(onEntityLink).not.toHaveBeenCalled();
});

test('[[entity:id]] становится ссылкой на detail-экран, клик перехвачен', () => {
  const onEntityLink = vi.fn();
  render(<Markdown source={`см. [[entity:${E1}]]`} onEntityLink={onEntityLink} />);
  const link = screen.getByRole('link');
  expect(link).toHaveAttribute('href', `/entity/${E1}`);
  const click = createEvent.click(link);
  fireEvent(link, click);
  expect(onEntityLink).toHaveBeenCalledWith(E1);
  // Без preventDefault браузер перезагрузил бы документ вместо push поверх стека.
  expect(click.defaultPrevented).toBe(true);
});

test('[[entity:id|подпись]] — текстом ссылки становится подпись', () => {
  render(<Markdown source={`[[entity:${E1}|Wishlist: бег]]`} onEntityLink={vi.fn()} />);
  expect(screen.getByRole('link', { name: 'Wishlist: бег' })).toHaveAttribute(
    'href',
    `/entity/${E1}`,
  );
});

test('UUID в верхнем регистре — та же ссылка (сервер регистр игнорирует)', () => {
  const onEntityLink = vi.fn();
  render(<Markdown source={`[[entity:${E1.toUpperCase()}]]`} onEntityLink={onEntityLink} />);
  fireEvent.click(screen.getByRole('link'));
  expect(onEntityLink).toHaveBeenCalledWith(E1);
});

test('спецсимволы подписи экранируются и не ломают ссылку', () => {
  // Хвостовой обратный слэш без экранирования съел бы закрывающую скобку markdown-ссылки,
  // ведущая «[» открыла бы вложенную скобочную группу.
  render(<Markdown source={`[[entity:${E1}|[черновик\\]]`} onEntityLink={vi.fn()} />);
  expect(screen.getByRole('link', { name: '[черновик\\' })).toHaveAttribute(
    'href',
    `/entity/${E1}`,
  );
});

test('битый id остаётся текстом, а не ссылкой', () => {
  const { container } = render(
    <Markdown
      source={'[[entity:не-uuid]] и [[entity:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa]]'}
      onEntityLink={vi.fn()}
    />,
  );
  expect(container.querySelector('a')).toBeNull();
  expect(screen.getByText(/\[\[entity:не-uuid\]\]/)).toBeInTheDocument();
  // Вторая форма проходит по серверному классу символов ([0-9a-f-]{36}), но UUID не является.
  expect(screen.getByText(/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/)).toBeInTheDocument();
});

test('внешняя ссылка открывается в новой вкладке и клик не перехватывается', () => {
  const onEntityLink = vi.fn();
  render(<Markdown source={'[док](https://example.com/a)'} onEntityLink={onEntityLink} />);
  const link = screen.getByRole('link', { name: 'док' });
  expect(link).toHaveAttribute('href', 'https://example.com/a');
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
  const click = createEvent.click(link);
  fireEvent(link, click);
  expect(onEntityLink).not.toHaveBeenCalled();
  expect(click.defaultPrevented).toBe(false);
});

test('{{query:…}} в ленте остаётся текстом (виджеты — объём detail-экрана)', () => {
  render(<Markdown source={'{{query: aspect=orbis/task}}'} />);
  expect(screen.getByText(/\{\{query: aspect=orbis\/task\}\}/)).toBeInTheDocument();
});
