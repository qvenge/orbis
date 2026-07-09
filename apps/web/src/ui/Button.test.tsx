import { render, screen } from '@testing-library/react';
import { Button } from './Button';

test('Button рендерит подпись и реагирует на variant', () => {
  render(<Button variant="primary">Сохранить</Button>);
  const btn = screen.getByRole('button', { name: 'Сохранить' });
  expect(btn).toBeInTheDocument();
  expect(btn.className).toContain('bg-');
});

test('variant по умолчанию — primary, ghost отличается классами', () => {
  const { unmount } = render(<Button>Основная</Button>);
  const primary = screen.getByRole('button', { name: 'Основная' });
  expect(primary.className).toContain('bg-accent');
  unmount();

  render(<Button variant="ghost">Позже</Button>);
  const ghost = screen.getByRole('button', { name: 'Позже' });
  expect(ghost.className).toContain('bg-transparent');
  expect(ghost.className).not.toContain('bg-accent');
});

test('variant=outline — рамка и нейтральный фон', () => {
  render(<Button variant="outline">Настроить</Button>);
  const btn = screen.getByRole('button', { name: 'Настроить' });
  expect(btn.className).toContain('border-line');
  expect(btn.className).toContain('bg-surface');
  expect(btn.className).not.toContain('bg-accent');
});

test('size: md по умолчанию, sm компактнее, icon — квадрат h-8 w-8 p-0', () => {
  const { unmount } = render(<Button>МД</Button>);
  expect(screen.getByRole('button', { name: 'МД' }).className).toContain('px-4');
  unmount();

  const { unmount: u2 } = render(<Button size="sm">СМ</Button>);
  const sm = screen.getByRole('button', { name: 'СМ' });
  expect(sm.className).toContain('px-3');
  expect(sm.className).not.toContain('px-4');
  u2();

  render(
    <Button size="icon" aria-label="иконка">
      i
    </Button>,
  );
  const icon = screen.getByRole('button', { name: 'иконка' });
  expect(icon.className).toContain('h-8');
  expect(icon.className).toContain('w-8');
  expect(icon.className).toContain('p-0');
});

test('интерактивность: cursor-pointer в базе, cursor-not-allowed на disabled', () => {
  render(<Button>Клик</Button>);
  const btn = screen.getByRole('button', { name: 'Клик' });
  expect(btn.className).toContain('cursor-pointer');
  expect(btn.className).toContain('disabled:cursor-not-allowed');
});

test('type по умолчанию — button, пробрасывает атрибуты и className', () => {
  render(
    <Button className="w-full" disabled>
      Отправить
    </Button>,
  );
  const btn = screen.getByRole('button', { name: 'Отправить' });
  expect(btn).toHaveAttribute('type', 'button');
  expect(btn).toBeDisabled();
  expect(btn.className).toContain('w-full');
});
