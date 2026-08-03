import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { NavBadge } from './NavBadge';

test('бейдж: ноль скрыт, 100 показывается как «99+», точное число слышит скринридер', () => {
  const { rerender, container } = render(<NavBadge count={0} label="просроченных" />);
  expect(container).toBeEmptyDOMElement();

  rerender(<NavBadge count={100} label="просроченных" />);
  expect(screen.getByText('99+')).toBeInTheDocument();
  // Видимое число усечено, описание для скринридера — точное (иначе «99+» соврёт)
  expect(screen.getByText(/100 просроченных/)).toBeInTheDocument();
});

test('бейдж не рендерится при null, пустой строке и неположительном числе', () => {
  const { rerender, container } = render(<NavBadge count={null} label="просроченных" />);
  expect(container).toBeEmptyDOMElement();
  rerender(<NavBadge count="" label="просроченных" />);
  expect(container).toBeEmptyDOMElement();
  rerender(<NavBadge count={-1} label="просроченных" />);
  expect(container).toBeEmptyDOMElement();
});

test('готовая строка-метка выводится дословно и не усекается правилом 99+', () => {
  // Agenda сама решает про усечение («200+» при упоре в потолок, K18) — бейдж
  // не имеет права занижать её до «99+».
  render(<NavBadge count="200+" label="просроченных" data-testid="agenda-badge" />);
  expect(screen.getByTestId('agenda-badge')).toHaveTextContent('200+');
  expect(screen.getByText(/200\+ просроченных/)).toBeInTheDocument();
  expect(screen.queryByText('99+')).toBeNull();
});

test('99 показывается как есть, 100 — как «99+»', () => {
  const { rerender } = render(<NavBadge count={99} label="ждут отправки" />);
  expect(screen.getByText('99')).toBeInTheDocument();
  rerender(<NavBadge count={100} label="ждут отправки" />);
  expect(screen.queryByText('100')).toBeNull();
  expect(screen.getByText('99+')).toBeInTheDocument();
});

test('доступное имя контейнера считается из содержимого и включает бейдж', () => {
  // Ровно то, что происходит на кнопке вкладки: aria-label у неё нет, имя
  // собирается из подписи и sr-only-описания бейджа.
  const { rerender } = render(
    <button type="button">
      Повестка
      <NavBadge count={3} label="просроченных" />
    </button>,
  );
  expect(screen.getByRole('button', { name: 'Повестка, 3 просроченных' })).toBeInTheDocument();
  rerender(
    <button type="button">
      Повестка
      <NavBadge count={0} label="просроченных" />
    </button>,
  );
  expect(screen.getByRole('button', { name: 'Повестка' })).toBeInTheDocument();
});

test('появление анимировано только при motion-safe (jsdom стили не применяет — сторожим класс)', () => {
  // В jsdom медиазапросы к стилям не применяются, «нет анимации при reduced motion»
  // проверить рендером нельзя: сторожим сам механизм — анимация навешена вариантом
  // motion-safe:, то есть при prefers-reduced-motion правило просто не действует.
  render(<NavBadge count={1} label="ждут отправки" data-testid="chat-badge" />);
  const el = screen.getByTestId('chat-badge');
  expect(el.className).toContain('motion-safe:animate-badge-in');
  expect(el.className).not.toMatch(/(^|\s)animate-badge-in/);
});

test('className вызывающего добавляется к базовым классам (позиционирование — его дело)', () => {
  render(
    <NavBadge count={1} label="ждут отправки" className="absolute right-4 top-1" data-testid="b" />,
  );
  const el = screen.getByTestId('b');
  expect(el.className).toContain('bg-danger');
  expect(el.className).toContain('absolute');
});
