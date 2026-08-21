// Единица «Пачки решений» с сервера и общий хвост её решения (D42 §7).
//
// Хук общий у обеих карточек пачки (вопрос и отложенное действие) и у блока пачки на экране
// прогона: и запрос, и четыре шага после мутации у них одни и те же, а разъехавшись, они дали
// бы владельцу разное поведение у соседних карточек одного прогона.
import { useQueryClient } from '@tanstack/react-query';
import { invalidateGraph } from '../../../lib/invalidate';
import { trpc } from '../../../trpc';
import { chatThreadKey } from '../useChatThread';
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
  settled: (result: { applied: boolean }) => void;
} {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
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
  const units = trpc.routine.runUnits.useQuery({ runId: args.runId });

  return {
    unit: units.data?.find((u) => u.pendingId === args.pendingId),
    loaded: units.data !== undefined,
    isError: units.isError,
    errorMessage: units.error?.message,
    isFetching: units.isFetching,
    /**
     * Хвост `onSuccess` ЛЮБОГО решения по единице — четыре шага, и все обязательны.
     *
     * 1. `invalidateGraph` — граф двигает не только применённое действие: и отказ, и ответ на
     *    вопрос снимают флажок `undecided` с аспекта прогона патчем бухгалтерии (§9.6), то
     *    есть меняют запись графа. Без инвалидации бейдж «ждут» и обзор рутины держали бы
     *    вчерашнее ещё 30 секунд (staleTime).
     * 2. Бюджет — только у ПРИМЕНЁННОГО: отложенная правка может тронуть сумму, категорию или
     *    статус траты, а бюджетные агрегаты живут своим ключом и в `invalidateGraph` не входят.
     * 3. Лента треда живёт СВОИМ ключом react-query, и `invalidateGraph` его не касается
     *    (`lib/invalidate.ts` — там ровно entity.query/get/count). А тред от решения меняется
     *    всегда: отказ и ответ дописывают в него свою строку. Без этой инвалидации она не
     *    появилась бы до ухода с вкладки и возврата (рулинг Р0-11, приём `ProposalCard`).
     *    Только при известном треде — на экране прогона ленты нет вовсе (П-5).
     * 4. Перечитка пачки — статус карточки с сервера ВСЕГДА, в том числе после своего же
     *    нажатия: `already` значит, что единицу решили без нас, и локальное «принято» было бы
     *    неправдой.
     */
    settled: (result) => {
      invalidateGraph(utils);
      if (result.applied) void utils.budget.invalidate();
      if (args.threadId !== undefined) {
        void queryClient.invalidateQueries({ queryKey: chatThreadKey(args.threadId) });
      }
      void units.refetch();
    },
  };
}
