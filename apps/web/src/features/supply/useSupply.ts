import { etalonOf, type SupplyKey, type SupplyKeyValue } from '@orbis/shared/supply';
import { useCallback } from 'react';
import { invalidateGraph } from '../../lib/invalidate';
import { type RouterOutputs, trpc } from '../../trpc';
import { useToast } from '../../ui/toast-store';
import { UNDO_FAILED } from '../page/useUpdateBatch';

/**
 * Обновления поставки в интерфейсе (срез 1б §9.1 п. 2–5, С1б-6 web). Всё здесь — ПРЕДЛОЖЕНИЯ: релиз
 * записи поставки не трогает никогда, пишет только действие владельца (кнопка), и у каждого действия
 * тост «Отменить» (`ai.undo` по его `actionId`).
 */

/** Пункт «Обновлений» — как его отдаёт `supply.updates` (сервер: `SupplyUpdate`, `supply/mechanism.ts`). */
export type SupplyUpdate = RouterOutputs['supply']['updates'][number];

/** Подписи кнопок — спека §9.1 п. 2–5 дословно; одна строка на кнопку и на то, что ищут тесты. */
export const COMPARE = 'Сравнить';
export const ACCEPT = 'Принять — прежняя версия сохранится';
export const DECLINE = 'Оставить своё';
export const ACCEPT_ALL = 'Принять все';
export const ADD = 'Добавить';
export const REVERT = 'Вернуть как было';
export const STATUS_ETALON = 'Как в поставке';
export const STATUS_EDITED = 'Изменено вами';

/**
 * Что именно сохранится при «Принять» — честно по роду записи (перенос Fable M-2 задачи 11): версия,
 * которую закрепляет механизм (`entity_version_pin`), хранит только ТЕЛО. Прежние заголовок и значок
 * страницы, как и прежнее место приложения (у приложения тела нет вовсе), возвращает «Отменить» —
 * журнал, а не версия. Подпись кнопки дословна по спеке, поэтому уточнение — рядом с ней.
 */
export function acceptNote(key: SupplyKey): string {
  return etalonOf(key).kind === 'app'
    ? 'Прежние навигацию, домашнюю, имя и значок вернёт «Отменить» — версий у приложения нет.'
    : 'Прежний текст страницы останется в её версиях; прежние заголовок и значок вернёт «Отменить».';
}

/** Имя записи поставки владельцу — по эталону кода: у новой записи другого имени и нет. */
export function supplyTitleOf(key: SupplyKey): string {
  const e = etalonOf(key);
  return `${e.emoji} ${e.title}`;
}

const NO_UPDATES: readonly SupplyUpdate[] = [];

/** Срок свежести «Обновлений» (докблок `useSupplyUpdates`). */
export const SUPPLY_UPDATES_STALE_MS = 30_000;

/**
 * Что предлагает поставка (`supply.updates`, ничего не пишет). Свежесть — двумя путями:
 *  - гашение: ключ гасит `invalidateGraph` (любая правка графа из этого клиента — в том числе правка
 *    записи поставки меняет «правлена ли она») и действия поставки ниже;
 *  - таймер 30 с (умолчание клиента, `trpc.ts`, — здесь явно, чтобы не зависеть от него): правку в
 *    обход этого клиента — агентом или со второй вкладки — гашение не видит, и без конечного срока
 *    плашка молчала бы «Вы правили…» до перезагрузки (раунд 2 гейта 22, N-1). Переход между записями
 *    поставки в пределах срока второго запроса не шлёт (С1б-16).
 */
export function useSupplyUpdates(): {
  updates: readonly SupplyUpdate[];
  status: 'loading' | 'ok' | 'error';
} {
  const q = trpc.supply.updates.useQuery(undefined, { staleTime: SUPPLY_UPDATES_STALE_MS });
  return {
    updates: q.data ?? NO_UPDATES,
    status: q.data !== undefined ? 'ok' : q.isError ? 'error' : 'loading',
  };
}

/**
 * Что возьмёт «Принять все» (§9.1 п. 2): обновления записей, которые владелец НЕ правил. Правленые
 * и новые записи — отдельное решение по каждой: правленую без взгляда на сравнение не переписывают,
 * новую не добавляют скопом. Решает сервер (`acceptAll` отбирает по свежему состоянию); здесь —
 * то, что владелец видит ДО нажатия, и оно обязано совпадать с правилом сервера.
 */
export function acceptAllScope(updates: readonly SupplyUpdate[]): SupplyUpdate[] {
  return updates.filter((u) => u.kind === 'update' && !u.edited);
}

/** Действие владельца над поставкой — одно на кнопку. */
export type SupplyAct =
  | { kind: 'accept' | 'decline' | 'add'; key: SupplyKey }
  // Версия записи, по которой клиент показал, что изменится (финал 1б, B1 m-3): сервер сверяет её.
  // Ключ — любой допустимый, и снятый с поставки тоже (1в §6.3): эталона кода у него нет, поэтому
  // подпись тоста — заголовок записи (`title`), как у записи журнала сервера «Вернуть как было: «…»».
  | { kind: 'revert'; key: SupplyKeyValue; title: string; expectedUpdatedAt?: string }
  | { kind: 'accept-all' };

export const SUPPLY_FAILED = 'Не удалось выполнить действие поставки';
export const NOTHING_TO_ACCEPT = 'Обновлений без ваших правок нет';

function doneTitle(act: SupplyAct, accepted: number): string {
  if (act.kind === 'accept-all') return `Принято обновлений: ${accepted}`;
  if (act.kind === 'revert') return `Возвращено как было: «${act.title}»`;
  const title = `«${etalonOf(act.key).title}»`;
  switch (act.kind) {
    case 'accept':
      return `Обновление принято: ${title}`;
    case 'decline':
      return `Оставлено своё: ${title}`;
    case 'add':
      return `Добавлено из поставки: ${title}`;
  }
}

/**
 * Исполнить действие поставки: мутация → тост с «Отменить» → перечитывание графа и «Обновлений».
 * После отмены — то же перечитывание: отменённое «Добавить» снова предлагает ключ (R-18), отменённое
 * «Принять» возвращает пункт в список. Промис сообщает исход и не отвергается — отказ виден тостом.
 */
export function useSupplyAction(): (act: SupplyAct) => Promise<boolean> {
  const utils = trpc.useUtils();
  const { show } = useToast();
  return useCallback(
    async (act) => {
      // `invalidateGraph` гасит и «Обновления» (`lib/invalidate.ts`).
      const refresh = () => invalidateGraph(utils);
      let actionId: string | null;
      let accepted = 0;
      try {
        const m = utils.client.supply;
        if (act.kind === 'accept-all') {
          const r = await m.acceptAll.mutate();
          actionId = r.actionId;
          accepted = r.accepted.length;
        } else if (act.kind === 'revert') {
          const input = { key: act.key };
          const r = await m.revert.mutate(
            act.expectedUpdatedAt === undefined
              ? input
              : { ...input, expectedUpdatedAt: act.expectedUpdatedAt },
          );
          actionId = r.actionId;
        } else {
          const input = { key: act.key };
          const r =
            act.kind === 'accept'
              ? await m.accept.mutate(input)
              : act.kind === 'decline'
                ? await m.decline.mutate(input)
                : await m.add.mutate(input);
          actionId = r.actionId;
        }
      } catch {
        show(SUPPLY_FAILED, 'danger');
        refresh();
        return false;
      }
      refresh();
      if (actionId === null) {
        // «Принять все» без единой неправленой записи: писать было нечего, отменять — тоже.
        show(NOTHING_TO_ACCEPT, 'default');
        return true;
      }
      const id = actionId;
      show(doneTitle(act, accepted), 'default', {
        label: 'Отменить',
        onSelect: () => {
          void utils.client.ai.undo
            .mutate({ actionId: id })
            .then(refresh)
            .catch(() => show(UNDO_FAILED, 'danger'));
        },
      });
      return true;
    },
    [utils, show],
  );
}
