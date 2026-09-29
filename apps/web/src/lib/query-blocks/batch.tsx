/**
 * Единый механизм данных блоков (спека страниц 1а §6.3, Р-11): любой блок данных — тело заметки,
 * предпросмотр редактора, первый кадр, страница, шаблон — просит одно и то же: «результат моего
 * запроса для этого `this`». Одновременные просьбы уходят ОДНОЙ пачкой `entity.blocks`.
 *
 * Почему у каждого блока СВОЙ ключ кеша, а не один `useQuery` на пачку:
 *  - правка одного блока меняет только его ключ — уходит пачка из одного, соседи не
 *    перезапрашиваются (§6.3: «блок, поправленный в редакторе, уходит пачкой из одного»);
 *  - инвалидация — по ПРЕФИКСУ `[QUERY_BLOCK_KEY]`: протухшие блоки рефетчатся в одном кадре и
 *    снова собираются в одну пачку;
 *  - ключ — ТЕКСТ без краёв, а не дерево: первый кадр читает тело текстом, а у редактора в узле
 *    лежит ещё и привязанное дерево. Ключ по дереву развёл бы их, и блок перезапрашивался бы на
 *    подъёме редактора (recon W3: так и было при `{query}` против `{ast}`).
 *
 * Почему пачка — мутация (POST, РП-8): вход несёт до 30 текстов запросов по 4000 символов, и в
 * GET-строку `httpBatchLink` он не помещается. Кешем служит react-query этого модуля, а не кеш
 * процедуры: у мутации его нет, и это ровно то, что нужно, — ключ живёт на блоке.
 */
// Всё — из корня `@orbis/shared`: файл в начальной загрузке (`main.tsx`), и листовой сабпат
// `/doc/placement` ради одной строки тянул бы туда препроход тела и разбор дат.
import {
  BLOCKS_BATCH_CAP,
  type BlockError,
  type BlockResult,
  EMPTY_QUERY_MESSAGE,
  type EntityBlockBadgeItem,
  type EntityBlockTextItem,
  entityBlockTextItem,
} from '@orbis/shared';
import {
  type QueryClient,
  type UseQueryResult,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef } from 'react';
import { trpc } from '../../trpc';
import { useThisEntityId } from './this-entity';

export const QUERY_BLOCK_KEY = 'query-block';

// Блок страницы — элемент по тексту; бейдж раздела навигации (`badgeOf`, срез 1б §9.3, РП-8) —
// элемент второго вида В ТОЙ ЖЕ очереди: все бейджи навигации и блоки, попросившие данные в одном
// кадре, уходят одной пачкой `entity.blocks`.
type BlockItem = EntityBlockTextItem | EntityBlockBadgeItem;
/** Просьба без ключа пачки: ключ раздаёт сброс очереди, он живёт один вызов. */
type BlockAsk = Omit<EntityBlockTextItem, 'key'> | Omit<EntityBlockBadgeItem, 'key'>;
/**
 * Ответ блока в кеше. Группы по дням (спека 1в §5.2) несут «сегодня» и пояс ПАЧКИ (верх ответа
 * `EntityBlocksResult`): подписи дней и колонка времени считаются в поясе ответа, а не браузера.
 * Прочие виды — как пришли: верх пачки им не нужен.
 */
export type BlockData =
  | Exclude<BlockResult, { kind: 'groups' }>
  | (Extract<BlockResult, { kind: 'groups' }> & { today: string; timeZone: string });
type Pending = { ask: BlockAsk; resolve: (r: BlockData) => void; reject: (e: unknown) => void };

/**
 * Отказ ОДНОГО блока: код и позиция едут до плашки. Наследник `Error`, чтобы `useQuery` вёл его
 * как любую ошибку запроса (`isError`), а соседние блоки пачки о нём не знали.
 */
export class BlockDataError extends Error {
  readonly code: string;
  readonly position?: number;
  constructor(error: BlockError, options?: { cause?: unknown }) {
    super(error.message, options);
    this.name = 'BlockDataError';
    this.code = error.code;
    if (error.position !== undefined) this.position = error.position;
  }
}

/**
 * Схема ЭЛЕМЕНТА пачки без ключа — из самого контракта, а не копией его пределов. Элемент,
 * который она отвергает (текст сверх предела, `this` не uuid, кривой `limit`), отвергла бы схема
 * ВСЕЙ пачки на сервере, и один такой блок погасил бы всех соседей (§6.3 — изоляция блоков).
 * Сверка до очереди делает отказ отказом только этого блока. Сообщения схемы — русские
 * (`BLOCK_ITEM_MESSAGES`): их видит плашка.
 */
const blockAskSchema = entityBlockTextItem.omit({ key: true });

/** Отказ всей пачки (сеть, авторизация, сбой сервера) — одним текстом, без английского транспорта. */
const TRANSPORT_MESSAGE = 'сервер недоступен — данные блока не получены';

type Batcher = { ask: (ask: BlockAsk) => Promise<BlockData> };
const BatchContext = createContext<Batcher | null>(null);

/**
 * Собиратель пачки над деревом — для просьб, у которых свой хук (бейдж раздела, `useBadgeData`).
 * Нет провайдера — ошибка сразу, а не вечная загрузка.
 */
export function useBlockBatcher(who: string): Batcher {
  const batcher = useContext(BatchContext);
  if (batcher === null) {
    throw new Error(`${who}: нет QueryBatchProvider над деревом (main.tsx, test/harness)`);
  }
  return batcher;
}

/**
 * Живые клиенты кеша под провайдером пачки — адресат инвалидации блоков. Счётчик, а не
 * множество: вложенный провайдер над тем же клиентом, снявшись, не должен снять внешний.
 */
const LIVE_CLIENTS = new Map<QueryClient, number>();

/**
 * Протушить данные ВСЕХ блоков (префикс `[QUERY_BLOCK_KEY]`). Зовёт `invalidateGraph`: данные
 * блоков — ещё один взгляд на граф рядом с `entity.query/get/count`, и протухают они вместе с
 * ними.
 *
 * Клиент кеша берётся у смонтированных провайдеров, а не синглтон `trpc.ts`: `invalidateGraph`
 * получает только `utils` tRPC, у которых клиента react-query наружу нет, а тестовая обвязка
 * живёт на своём клиенте — синглтон протушил бы чужой кеш.
 */
export function invalidateQueryBlocks(): void {
  for (const qc of LIVE_CLIENTS.keys()) {
    void qc.invalidateQueries({ queryKey: [QUERY_BLOCK_KEY] });
  }
}

export function QueryBatchProvider({ children }: { children: ReactNode }) {
  const utils = trpc.useUtils();
  const qc = useQueryClient();
  // Клиент tRPC — через ссылку: собиратель живёт весь срок провайдера, а смена клиента
  // (перелогин) не должна рвать уже поставленную очередь.
  const clientRef = useRef(utils.client);
  clientRef.current = utils.client;

  useEffect(() => {
    LIVE_CLIENTS.set(qc, (LIVE_CLIENTS.get(qc) ?? 0) + 1);
    return () => {
      const left = (LIVE_CLIENTS.get(qc) ?? 1) - 1;
      if (left > 0) LIVE_CLIENTS.set(qc, left);
      else LIVE_CLIENTS.delete(qc);
    };
  }, [qc]);

  const batcher = useMemo<Batcher>(() => {
    let queue: Pending[] = [];
    let scheduled = false;

    const send = async (chunk: Pending[]) => {
      const blocks: BlockItem[] = chunk.map((p, i) => ({ ...p.ask, key: String(i) }));
      try {
        const { results, today, timeZone } = await clientRef.current.entity.blocks.mutate({
          blocks,
        });
        chunk.forEach((p, i) => {
          const r = results[String(i)];
          if (r === undefined) {
            p.reject(
              new BlockDataError({
                code: 'NO_RESULT',
                message: 'сервер не вернул ответа этому блоку',
              }),
            );
          } else if (r.ok) {
            p.resolve(r.kind === 'groups' ? { ...r, today, timeZone } : r);
          } else {
            p.reject(new BlockDataError(r.error));
          }
        });
      } catch (e) {
        // Отказ всей пачки (сеть, авторизация) — отказ каждого её блока: промолчать значило бы
        // оставить блоки в вечной загрузке. Текст транспорта («Failed to fetch») на плашку не
        // идёт: он английский и ничего не говорит владельцу; исходная ошибка — в `cause`.
        for (const p of chunk) {
          p.reject(
            new BlockDataError({ code: 'TRANSPORT', message: TRANSPORT_MESSAGE }, { cause: e }),
          );
        }
      }
    };

    // `setTimeout(0)`, а не микротаска: монтирования одного коммита React разнесены по
    // эффектам разных поддеревьев, и микротаска могла бы сработать между ними — пачка
    // рассыпалась бы на несколько.
    const flush = () => {
      scheduled = false;
      const taken = queue;
      queue = [];
      for (let i = 0; i < taken.length; i += BLOCKS_BATCH_CAP) {
        void send(taken.slice(i, i + BLOCKS_BATCH_CAP));
      }
    };

    return {
      ask: (ask) =>
        new Promise<BlockData>((resolve, reject) => {
          queue.push({ ask, resolve, reject });
          if (!scheduled) {
            scheduled = true;
            setTimeout(flush, 0);
          }
        }),
    };
  }, []);

  return <BatchContext.Provider value={batcher}>{children}</BatchContext.Provider>;
}

/**
 * Данные блока по его тексту (`{{query:…}}` без обёртки). `this` — из `ThisEntityProvider`:
 * вне тела записи поля в просьбе нет вовсе, а не `null` (см. `this-entity.tsx`).
 *
 * Отказ блока (`ok:false`) — ошибка запроса (`BlockDataError`), а не данные: у `useQuery`
 * `retry: false` по умолчанию, и соседи по пачке о ней не узнают. Пустой текст и элемент, который
 * не проходит схему элемента пачки, отвергаются здесь же, не доходя до сети: схема пачки
 * отвергла бы их вместе со всеми соседями.
 *
 * `this` — часть ключа: один и тот же текст с `children_of=this` у двух записей — два разных
 * запроса, и без него второй блок получил бы строки первого из кеша.
 *
 * `params` — значения параметров страницы, на которые ссылается текст (`$<имя>`, спека 1в §5.1):
 * едут полем элемента, подстановка — на сервере. Они — часть ключа (другое значение — другой
 * запрос); объектом, а не своей строкой пар: хеш ключа react-query сортирует ключи объекта сам, и
 * порядок ключей ничего не значит. Пустые значения — без поля и с тем же ключом, что без них.
 *
 * Прежние данные держатся при смене `limit` («ещё N»: без них раскрываемый список мигал бы
 * загрузкой на месте уже показанных строк) и значений параметров (переключатель на странице: строки
 * прежнего периода видны до ответа, а не «Загрузка…»). Сменился текст или `this` — это другой
 * запрос, и чужие строки под ним были бы неправдой (тот же довод, что у `useTicketRuns`).
 */
export function useBlockData(
  text: string,
  opts: { limit?: number; params?: Readonly<Record<string, string>> } = {},
): UseQueryResult<BlockData> {
  const batcher = useBlockBatcher('useBlockData');
  const thisEntityId = useThisEntityId();
  const trimmed = text.trim();
  const { limit } = opts;
  const params = opts.params && Object.keys(opts.params).length > 0 ? opts.params : null;
  return useQuery({
    queryKey: [QUERY_BLOCK_KEY, trimmed, thisEntityId ?? null, limit ?? null, params],
    queryFn: () => {
      if (trimmed === '') {
        return Promise.reject(new BlockDataError({ code: 'EMPTY', message: EMPTY_QUERY_MESSAGE }));
      }
      const ask: BlockAsk = {
        text: trimmed,
        ...(thisEntityId !== null && { thisEntityId }),
        ...(limit !== undefined && { limit }),
        ...(params && { params }),
      };
      const checked = blockAskSchema.safeParse(ask);
      if (!checked.success) {
        return Promise.reject(
          new BlockDataError({
            code: 'INVALID_ITEM',
            message: checked.error.issues[0]?.message ?? 'просьба блока не принята',
          }),
        );
      }
      return batcher.ask(ask);
    },
    placeholderData: (prev, prevQuery) =>
      prevQuery?.queryKey[1] === trimmed && prevQuery.queryKey[2] === (thisEntityId ?? null)
        ? prev
        : undefined,
  });
}
