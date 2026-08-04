// Прогресс цели на detail-экране (01-architecture §11.3, Task E3).
//
// Число здесь НЕ считается: `goalProgress` приезжает соседом сущности в ответе entity.get,
// сервер обходит граф по `progress_source` на каждом чтении (E2, goals/progress.ts).
// Клиенту остаётся полоса, подпись и — когда посчитать не вышло — объяснение.
//
// Три решения, которые важнее кода:
//
// 1. РАЗМЕТКА СВОЯ, НЕ Radix Progress. Роли progressbar нужны ровно четыре атрибута
//    (role + aria-valuemin/max/now), и пакет radix-ui дал бы их ценой ещё одного модуля
//    в бандле, который и так на диете (бэклог слайса 3). Хуже того, Radix ВАЛИДИРУЕТ
//    value ≤ max и на перевыполнении свалился бы в indeterminate с console.error, а
//    его дефолтный aria-valuetext печатает округлённый процент от клампнутого значения —
//    ровно ту ложь, которую запрещает контракт ниже. Жёлоб/заливка — по образцу
//    EnvelopeCard (Budget §3.1), чтобы две полосы приложения выглядели одной вещью.
// 2. ПЕРЕВЫПОЛНЕНИЕ ЧЕСТНОЕ. Полоса не переполняется, `aria-valuenow` клампится в 100
//    (контракт роли — 0..100), а настоящие 120% видны и глазом (подпись), и скринридеру
//    (`aria-valuetext`, который объявляется ВМЕСТО valuenow). Клампить показания молча
//    значило бы прятать от одних пользователей то, что видят другие.
// 3. ПРОЦЕНТ — ПО DECIMAL-СТРОКАМ. `ratio` от сервера — число, и floor(ratio*100) на нём
//    врёт: 0.29*100 в IEEE-754 = 28.999999999999996 → «28%». Считаем точно, из тех же
//    строк, тем же BigInt-примитивом, что пороги Budget (envelopePercent). Сервер сделал
//    ровно тот же выбор — goals/progress.ts берёт decRatio из budget/decimal.ts, а не
//    заводит второй разбор decimal-строк.
import { formatAmount } from '../../lib/format';
import type { RouterOutputs } from '../../trpc';
import { envelopePercent } from '../budget/EnvelopeCard';

type GoalProgressData = NonNullable<RouterOutputs['entity']['get']['goalProgress']>;
type Unsupported = NonNullable<GoalProgressData['unsupported']>;

/**
 * Почему прогресса нет — РАЗНЫМИ словами (решение Р20). Одна фраза на четыре причины
 * врала бы дважды: `array_field` — осознанное ограничение механизма (§12 п.6), чинить
 * пользователю нечего; `invalid_query`/`invalid_field` — сломанная цель, и текст обязан
 * называть, ЧТО именно чинить; `compute_failed` — беда прямо сейчас, а не навсегда.
 *
 * Record по литералам сервера, а не Partial: пятая причина, добавленная в E2, уронит
 * типизацию здесь, а не выедет в прод пустым местом под заголовком «Цель».
 */
const UNSUPPORTED_TEXT: Record<Unsupported, string> = {
  array_field: 'Прогресс по полю внутри списка механизм целей пока не поддерживает.',
  invalid_query: 'Запрос источника прогресса не разобран — поправьте в нём query через чат.',
  invalid_field:
    'Поле агрегата не найдено или не числовое — поправьте в источнике прогресса field через чат.',
  compute_failed: 'Прогресс не удалось посчитать сейчас — попробуйте обновить экран.',
};

/** Ограничение механизма — не поломка: тон у него спокойный, у трёх остальных — тревожный. */
const UNSUPPORTED_TONE: Record<Unsupported, string> = {
  array_field: 'text-text-secondary',
  // text-alert, а НЕ text-warning: --color-warning объявлен цветом заливки бара и на белом
  // листе даёт 3.18:1 (документировано в NativeRow).
  invalid_query: 'text-alert',
  invalid_field: 'text-alert',
  compute_failed: 'text-alert',
};

export function GoalProgress({ progress, unit }: { progress: GoalProgressData; unit?: string }) {
  const { current, target, unsupported } = progress;

  // Полосы при отказе нет ВОВСЕ. Сервер отдаёт current='0', и нарисованные 0% читались бы
  // как «пока ничего не накоплено» — утверждение о данных, которого никто не проверял.
  if (unsupported !== undefined) {
    return (
      <p
        data-testid="goal-unsupported"
        className={`text-sm ${UNSUPPORTED_TONE[unsupported] ?? 'text-alert'}`}
      >
        {UNSUPPORTED_TEXT[unsupported] ?? UNSUPPORTED_TEXT.compute_failed}
      </p>
    );
  }

  const percent = envelopePercent(current, target);
  const width = Math.min(100, percent);
  const reached = percent >= 100;
  const amounts = `${formatAmount(current)} / ${formatAmount(target)}`;
  const valueText = `${percent}% — ${amounts}${unit ? ` ${unit}` : ''}`;

  return (
    <div data-testid="goal-progress" className="flex flex-col gap-1 pb-1">
      <div className="flex items-center gap-2">
        {/* Имя роли — только aria-label: у progressbar нет содержимого, из которого имя
            берётся, а числа живут в подписи ниже и НЕ дублируются сюда как имя (урок
            фазы B: aria-label, заменяющий содержимое, прячет его от скринридера).
            Точное значение — в aria-valuetext, оно объявляется вместо клампнутого
            valuenow, поэтому перевыполнение слышно так же, как видно. */}
        <div
          role="progressbar"
          aria-label="Прогресс цели"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={width}
          aria-valuetext={valueText}
          className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2"
        >
          <div
            data-testid="goal-bar"
            className="h-full rounded-full transition-[width]"
            style={{
              width: `${width}%`,
              backgroundColor: reached ? 'var(--color-success)' : 'var(--color-accent)',
            }}
          />
        </div>
        <span className="shrink-0 text-xs tabular-nums text-text-secondary">{percent}%</span>
      </div>
      {/* Числа и единица — РАЗНЫМИ узлами: «150 000 / 300 000» остаётся цельной подписью
          суммы, а единица прилипает к ней словом (тот же приём, что у сумм Budget). */}
      <p className="text-sm text-text-secondary">
        <span className="tabular-nums">{amounts}</span>
        {unit !== undefined && unit !== '' && <span> {unit}</span>}
        {reached && <span className="text-success"> · цель достигнута</span>}
      </p>
    </div>
  );
}
