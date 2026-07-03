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
