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
import {
  BLOCKS_BATCH_CAP,
  type BlockError,
  type BlockResult,
  type EntityBlocksInput,
  entityBlocksInput,
} from '@orbis/shared';
import { EMPTY_QUERY_MESSAGE } from '@orbis/shared/doc/placement';
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

type BlockItem = EntityBlocksInput['blocks'][number];
/** Просьба без ключа пачки: ключ раздаёт сброс очереди, он живёт один вызов. */
type BlockAsk = Omit<BlockItem, 'key'>;
type Pending = { ask: BlockAsk; resolve: (r: BlockResult) => void; reject: (e: unknown) => void };

/**
 * Отказ ОДНОГО блока: код и позиция едут до плашки. Наследник `Error`, чтобы `useQuery` вёл его
 * как любую ошибку запроса (`isError`), а соседние блоки пачки о нём не знали.
 */
export class BlockDataError extends Error {
  readonly code: string;
  readonly position?: number;
  constructor(error: BlockError) {
    super(error.message);
    this.name = 'BlockDataError';
    this.code = error.code;
    if (error.position !== undefined) this.position = error.position;
  }
}

/**
 * Схема ТЕКСТА элемента пачки — из самого контракта, а не копией его пределов: текст сверх
 * предела отвергла бы схема ВСЕЙ пачки, и один длинный блок погасил бы все блоки страницы.
 */
const blockTextSchema = entityBlocksInput.innerType().shape.blocks.element.shape.text;

type Batcher = { ask: (ask: BlockAsk) => Promise<BlockResult> };
const BatchContext = createContext<Batcher | null>(null);

/**
 * Живые клиенты кеша под провайдером пачки — адресат инвалидации блоков. Счётчик, а не
 * множество: вложенный провайдер над тем же клиентом, снявшись, не должен снять внешний.
 */
const LIVE_CLIENTS = new Map<QueryClient, number>();

/**
 * Протушить данные ВСЕХ блоков (префикс `[QUERY_BLOCK_KEY]`). Зовёт `invalidateGraph`: блоки —
 * четвёртый взгляд на граф рядом с `entity.query/get/count` и протухают вместе с ними.
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
        const { results } = await clientRef.current.entity.blocks.mutate({ blocks });
        chunk.forEach((p, i) => {
          const r = results[String(i)];
          if (r === undefined) {
            p.reject(new Error('сервер не вернул ответа этому блоку'));
          } else if (r.ok) {
            p.resolve(r);
          } else {
            p.reject(new BlockDataError(r.error));
          }
        });
      } catch (e) {
        // Отказ всей пачки (сеть, авторизация) — отказ каждого её блока: промолчать значило бы
        // оставить блоки в вечной загрузке.
        for (const p of chunk) p.reject(e);
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
        new Promise<BlockResult>((resolve, reject) => {
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
 * `retry: false` по умолчанию, и соседи по пачке о ней не узнают. Пустой и сверхдлинный текст
 * отвергаются здесь же, не доходя до сети: схема пачки отвергла бы их вместе со всеми соседями.
 *
 * Прежние данные держатся ТОЛЬКО при смене `limit` («ещё N»: без них раскрываемый список мигал
 * бы загрузкой на месте уже показанных строк). Сменился текст или `this` — это другой запрос, и
 * чужие строки под ним были бы неправдой (тот же довод, что у `useTicketRuns`).
 */
export function useBlockData(
  text: string,
  opts: { limit?: number } = {},
): UseQueryResult<BlockResult> {
  const batcher = useContext(BatchContext);
  if (batcher === null) {
    throw new Error('useBlockData: нет QueryBatchProvider над деревом (main.tsx, test/harness)');
  }
  const thisEntityId = useThisEntityId();
  const trimmed = text.trim();
  const limit = opts.limit;
  return useQuery({
    queryKey: [QUERY_BLOCK_KEY, trimmed, thisEntityId ?? null, limit ?? null],
    queryFn: () => {
      if (trimmed === '') {
        return Promise.reject(new BlockDataError({ code: 'EMPTY', message: EMPTY_QUERY_MESSAGE }));
      }
      const checked = blockTextSchema.safeParse(trimmed);
      if (!checked.success) {
        return Promise.reject(
          new BlockDataError({
            code: 'TOO_LONG',
            message: checked.error.issues[0]?.message ?? 'текст запроса не принят',
          }),
        );
      }
      return batcher.ask({
        text: trimmed,
        ...(thisEntityId !== null && { thisEntityId }),
        ...(limit !== undefined && { limit }),
      });
    },
    placeholderData: (prev, prevQuery) =>
      prevQuery?.queryKey[1] === trimmed && prevQuery.queryKey[2] === (thisEntityId ?? null)
        ? prev
        : undefined,
  });
}
