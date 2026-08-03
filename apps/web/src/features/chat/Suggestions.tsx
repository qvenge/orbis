import { Button } from '../../ui/Button';

/*
 * Продолжения разговора (02-core-os §2.4, решение D19) — клиентская половина.
 * Серверная (ai/suggestions.ts) вырезает маркер из ответа модели и кладёт список
 * в `metadata.suggestions` assistant-сообщения; клиент только показывает и отдаёт
 * выбранный текст ОБЫЧНЫМ путём отправки того экрана, где чипы показаны.
 */

/**
 * Достаёт продолжения из `metadata` сообщения. `metadata` типизирована как
 * `Record<string, unknown>`, а её содержимое родом из ответа модели — поэтому
 * данные непроверенные: берём только строки, обрезаем и отбрасываем пустые.
 * Клампы «не больше 4» и «не длиннее 60 символов» уже применены сервером —
 * второй раз их здесь не повторяем (одно место правды на один инвариант).
 */
export function readSuggestions(metadata: unknown): string[] {
  const raw = (metadata as { suggestions?: unknown } | null | undefined)?.suggestions;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Горизонтальный ряд чипов-кнопок. Переполнение скроллится по горизонтали
 * (как лента закреплённых в браузере), а не ломает раскладку ленты.
 * Пустой список — ряда нет вовсе.
 */
export function Suggestions({
  items,
  onPick,
}: {
  items: string[];
  onPick: (text: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    // Список (как остальные перечисления в приложении) + имя для скринридера:
    // без имени ряд читается как набор кнопок ниоткуда.
    // w-full, а не self-start: ряд шире экрана обязан скроллиться ВНУТРИ себя,
    // иначе он растянул бы ленту и горизонтально поехал бы весь тред.
    <ul
      aria-label="Продолжить разговор"
      data-testid="suggestions"
      className="-mt-2 flex w-full gap-1.5 overflow-x-auto py-0.5"
    >
      {items.map((text, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: список статичен в пределах сообщения, тексты могут повторяться
        <li key={i} className="shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPick(text)}
            className="whitespace-nowrap rounded-full text-xs text-text-secondary"
          >
            {text}
          </Button>
        </li>
      ))}
    </ul>
  );
}
