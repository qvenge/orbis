import { useState } from 'react';

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

/*
 * Свой <button>, а не ui/Button — по той же причине, по какой NavBadge не переиспользует
 * ui/Badge. Чипу нужны три свойства, которых нет ни в одном варианте Button: пилюльный
 * радиус, мелкий шрифт и вторичный цвет текста. Передавать их через className — спор с
 * базой: Button склеивает строки без tailwind-merge (ui/Button.tsx:34), а при равной
 * специфичности побеждает не порядок классов в атрибуте, а порядок правил в собранном CSS.
 * Замер бандла (apps/web/dist/assets/index-CZeHPzLM.css) показал, что сейчас выигрывают
 * ИМЕННО переопределения: .text-xs (смещение 17624) идёт после .text-sm (17440),
 * .rounded-full (12424) после .rounded-control (12371), .text-text-secondary (19002)
 * после .text-text (18574). Но этот порядок задаёт эмиттер Tailwind, а не наш код: он
 * молча меняется при апгрейде и уносит с собой весь задуманный вид. Кольцо фокуса
 * скопировано из базы Button дословно (у соседнего PinnedChip его нет — дыру не копируем).
 */
const chip =
  'shrink-0 cursor-pointer select-none whitespace-nowrap rounded-full border border-line ' +
  'bg-surface px-3 py-1 text-xs text-text-secondary outline-hidden transition ' +
  'hover:bg-surface-2 hover:text-text active:bg-line/60 ' +
  'focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg';

/**
 * Горизонтальный ряд чипов-кнопок. Переполнение скроллится по горизонтали
 * (как лента закреплённых в браузере), а не ломает раскладку ленты.
 * Пустой список — ряда нет вовсе.
 *
 * Личность ряда — сообщение, под которым он висит: MessageList монтирует его с
 * `key={id сообщения}`, поэтому «выбран» сбрасывается ровно при смене ответа — и НЕ
 * сбрасывается, если следующий ответ предложит те же формулировки.
 */
export function Suggestions({
  items,
  onPick,
}: {
  items: string[];
  onPick: (text: string) => void;
}) {
  // Выбор одноразовый: ряд гаснет сразу, не дожидаясь, пока отправка дойдёт до состояния.
  // На ChatScreen fast-path до первого await состояния не меняет (useFastPath: loadCtx при
  // холодном кэше идёт в сеть), так что «ряд исчезнет сам» защитой не является — без флага
  // двойной тап уезжал бы двумя одинаковыми сообщениями и двумя вызовами модели.
  const [picked, setPicked] = useState(false);
  if (items.length === 0 || picked) return null;
  return (
    // Список (как остальные перечисления в приложении) + имя для скринридера:
    // без имени ряд читается как набор кнопок ниоткуда.
    // Ширину не задаём — её даёт align-self: stretch родителя: ряд шире экрана обязан
    // скроллиться ВНУТРИ себя, иначе он растянул бы ленту и весь тред поехал бы вбок.
    // Паддинг ряда — не декор: кольцо фокуса выходит за кнопку на 4px (ring-2 +
    // ring-offset-2), а scrollable overflow тени обрезает — у клавиатурного фокуса
    // срезало бы верх и низ, у крайних чипов бок. Отрицательные margin'ы возвращают
    // чипы на одну вертикаль с текстом ответа.
    <ul
      aria-label="Продолжить разговор"
      data-testid="suggestions"
      className="-mx-1.5 -mt-3 flex gap-1.5 overflow-x-auto px-1.5 py-1.5"
    >
      {items.map((text, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: список статичен в пределах сообщения, тексты могут повторяться
        <li key={i} className="shrink-0">
          <button
            type="button"
            className={chip}
            onClick={() => {
              setPicked(true);
              onPick(text);
            }}
          >
            {text}
          </button>
        </li>
      ))}
    </ul>
  );
}
