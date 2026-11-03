// Единица «Пачки решений» с сервера и общий хвост её решения (D42 §7).
//
// Хук общий у обеих карточек пачки (вопрос и отложенное действие) и у блока пачки на экране
// прогона: и запрос, и четыре шага после мутации у них одни и те же, а разъехавшись, они дали
// бы владельцу разное поведение у соседних карточек одного прогона.
import { useFreshnessVisible } from '../../../lib/freshness/screen';
import { trpc } from '../../../trpc';
import { useChatThreadCatchup } from '../useChatThread';
import type { RunUnitView } from './unit-text';

export function useRunUnit(args: {
  runId: string;
  /** Какую именно единицу прогона показывает карточка (адрес из `metadata.cards`). */
  pendingId: string;
  /** Тред, в ленте которого стоит карточка; `undefined` — экран прогона (ленты нет, П-5). */
  threadId?: string;
}): {
  unit: RunUnitView | undefined;
  /** Ответ пачки приехал (пусть и пустой) — иначе «единицы нет» неотличимо от «ещё грузим». */
  loaded: boolean;
  isError: boolean;
  errorMessage: string | undefined;
  /** Перечитывается ли пачка прямо сейчас — часть `busy` у кнопок. */
  isFetching: boolean;
  settled: (result: { applied: boolean; already: boolean }) => void;
} {
  /**
   * СУДЬБА ЕДИНИЦЫ — ВСЕГДА С СЕРВЕРА (Р-10). `useState`-приём `ConfirmationCard`
   * (`ConfirmationCard.tsx:20`, `:79-80`: локальное «подтверждено» после нажатия) здесь не
   * копируется: решают пачку и позже, и со второго экрана, и её же гасит следующий прогон, —
   * локальный флажок врал бы ровно в тех случаях, ради которых карточка и написана.
   *
   * Ключ — ОДИН на весь прогон (`{runId}`), а не на единицу: карточек у прогона до десяти
   * (кап ОЧ.10), и запрос на каждую означал бы десять проб на одну ленту. Кэш общий, и
   * перечитка любой карточки обновляет все.
   */
  const units = trpc.routine.runUnits.useQuery(
    { runId: args.runId },
    { enabled: useFreshnessVisible() },
  );
  const catchUpThread = useChatThreadCatchup(args.threadId);

  return {
    unit: units.data?.find((u) => u.pendingId === args.pendingId),
    loaded: units.data !== undefined,
    isError: units.isError,
    errorMessage: units.error?.message,
    isFetching: units.isFetching,
    // An already resolved unit may produce no new feed event.
    settled: (result) => {
      if (!result.applied) void units.refetch();
      if (result.already) catchUpThread();
    },
  };
}
