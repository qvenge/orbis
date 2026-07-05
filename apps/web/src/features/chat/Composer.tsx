import { type FormEvent, useState } from 'react';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';

export function Composer({
  onSubmit,
  disabled,
  placeholder,
}: {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState('');
  function submit(e: FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    onSubmit(value);
    setText('');
  }
  return (
    <form onSubmit={submit} className="flex gap-2 border-t border-line p-2">
      <Input
        aria-label="Сообщение"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder ?? 'Напишите сообщение…'}
        className="flex-1"
      />
      <Button type="submit" variant="primary" disabled={disabled}>
        Отправить
      </Button>
    </form>
  );
}
