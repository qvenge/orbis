import { type FastPathCategory, type FastPathCtx, newId, parseFastPath } from '@orbis/shared';
import { useQueryClient } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { useOnline, useRetryBuffer } from '../../state/retry';
import { mapSendError } from '../../state/retry-send';
import { trpc } from '../../trpc';
import { type ChatMessage, chatThreadKey, upsertNewest, useSendMessage } from './useChatThread';

const CATEGORY_QUERY = { query: 'aspect=orbis/category' } as const;

/**
 * «Сегодня» в таймзоне пользователя (§7.5): без этого parseFastPath берёт UTC-дату, и ввод
 * «такси 500» в 00:40 по Москве записывается вчерашним днём. en-CA форматирует как YYYY-MM-DD.
 * Зона из настроек валидируется сервером, но кэш может быть старым — падать здесь незачем.
 */
function todayIn(timezone: string | undefined): string {
  try {
    return new Intl.DateTimeFormat('en-CA', timezone ? { timeZone: timezone } : {}).format(
      new Date(),
    );
  } catch {
    return new Intl.DateTimeFormat('en-CA').format(new Date());
  }
}

// Метка синтетической карточки fast-path на сообщении треда: entityId+исходная строка →
// «разобрать с AI» (архив + LLM); status разграничивает подтверждённую (⚡) и офлайн (⏳).
type FastPathMeta = { entityId?: string; text: string; status: 'confirmed' | 'pending' };

/**
 * Оркестратор ввода в Chat (02 §2.5/§2.6):
 *  - уверенный parseFastPath онлайн → мгновенная entity_card «⚡ без AI» + entity.create(fast_path);
 *  - неуверенный онлайн → LLM (ai.sendMessage);
 *  - офлайн уверенный → retry-буфер + карточка «⏳ ждёт отправки» (LLM офлайн недоступен).
 * reparse — «разобрать с AI»: архив fast-сущности + исходная строка LLM-путём (одна строка ≠ две сущности).
 */
export function useFastPath(threadId: string) {
  const queryClient = useQueryClient();
  const utils = trpc.useUtils();
  const online = useOnline();
  const enqueueCreate = useRetryBuffer((s) => s.enqueueCreate);
  const flushNow = useRetryBuffer((s) => s.flushNow);
  const { sendMessage, retryMessage, isSending } = useSendMessage(threadId);

  const create = trpc.entity.create.useMutation();
  const update = trpc.entity.update.useMutation();
  const key = chatThreadKey(threadId);

  // Категории (aspect=orbis/category) + валюта → контекст парсера. `cats`/`settings` — сырьё кэша/сети.
  type QueryOut = ReturnType<typeof utils.entity.query.getData>;
  type SettingsOut = ReturnType<typeof utils.user.getSettings.getData>;
  function mapCtx(cats: QueryOut, settings: SettingsOut): FastPathCtx {
    const categories: FastPathCategory[] = (cats ?? []).map((e) => {
      const meta = (e.aspects?.['orbis/category'] ?? {}) as {
        aliases?: string[];
        spend_class?: string;
      };
      return { id: e.id, aliases: meta.aliases ?? [], spendClass: meta.spend_class };
    });
    return {
      categories,
      defaultCurrency: settings?.defaultCurrency ?? 'RUB',
      today: todayIn(settings?.timezone),
    };
  }

  // Онлайн: свежий ctx (getData() тёплый кэш → иначе fetch, staleTime 30s).
  async function loadCtx(): Promise<FastPathCtx> {
    const cats =
      utils.entity.query.getData(CATEGORY_QUERY) ??
      (await utils.entity.query.fetch(CATEGORY_QUERY));
    const settings = utils.user.getSettings.getData() ?? (await utils.user.getSettings.fetch());
    return mapCtx(cats, settings);
  }

  // Офлайн: ТОЛЬКО тёплый кэш (без fetch) — иначе onlineManager заморозит запрос и submit зависнет (§2.6).
  function cachedCtx(): FastPathCtx {
    return mapCtx(utils.entity.query.getData(CATEGORY_QUERY), utils.user.getSettings.getData());
  }

  // Возвращает id синтетического сообщения; повторный вызов с тем же messageId ПЕРЕПИСЫВАЕТ
  // карточку (upsertNewest дедупит по id) — так «⚡ без AI» деградирует в «⏳ ждёт отправки».
  function insertCard(
    card: Record<string, unknown>,
    note: string,
    fastPath: FastPathMeta,
    messageId: string = newId(),
  ): string {
    const synthetic: ChatMessage = {
      id: messageId,
      threadId,
      role: 'assistant',
      content: note,
      metadata: {
        cards: [
          {
            kind: 'entity_card',
            entityId: fastPath.entityId ?? '',
            title: String(card.title ?? ''),
            aspects: ['orbis/financial'],
            keyFields: card,
          },
        ],
        fastPath,
      },
      createdAt: new Date().toISOString(),
    } as ChatMessage;
    queryClient.setQueryData(key, (old) => upsertNewest(old as never, synthetic));
    return messageId;
  }

  // Бизнес-отказ сервера: карточка успеха заменяется error_card (§5.3 — такой отказ
  // показывается пользователю и в буфер не попадает).
  function replaceCardWithError(messageId: string, message: string, code: string) {
    const errorMsg: ChatMessage = {
      id: messageId,
      threadId,
      role: 'assistant',
      content: '',
      metadata: { cards: [{ kind: 'error_card', code, message }] },
      createdAt: new Date().toISOString(),
    } as ChatMessage;
    queryClient.setQueryData(key, (old) => upsertNewest(old as never, errorMsg));
  }

  async function submit(text: string): Promise<void> {
    // Гейт !online — ДО любого сетевого ctx: офлайн строим ctx только из кэша, сеть не трогаем (§2.6).
    if (!online) {
      const ctx = cachedCtx();
      const parsed = parseFastPath(text, ctx);
      if (parsed.ok) {
        // Уверенный (категории прогреты) → retry-буфер + «⏳ ждёт отправки».
        try {
          enqueueCreate(parsed.create, 'fast_path');
        } catch {
          // localStorage недоступен (квота, private mode): Composer уже очистил поле —
          // молча потерять ввод нельзя, возвращаем его пользователю текстом заметки.
          insertSystemNote(`Не удалось сохранить запись офлайн — скопируйте текст: «${text}»`);
          return;
        }
        const fin = (parsed.create.aspects?.['orbis/financial'] ?? {}) as Record<string, unknown>;
        insertCard({ ...fin, title: parsed.create.title }, '⏳ ждёт отправки', {
          text,
          status: 'pending',
        });
      } else if (ctx.categories.length === 0) {
        // Холодный кэш: категории не загружались онлайн — честно сообщаем, НЕ виснем.
        insertSystemNote(
          'Нет сети — быстрый ввод недоступен, пока категории не загружены (откройте приложение онлайн).',
        );
      } else {
        insertSystemNote('Нет сети — доступен только быстрый ввод (сумма + категория).');
      }
      return;
    }

    const ctx = await loadCtx();
    const parsed = parseFastPath(text, ctx);
    if (!parsed.ok) {
      // Неуверенно → LLM-путь (ошибку и потерю текста закрывает useSendMessage.onError, §3).
      sendMessage(text);
      return;
    }

    // Онлайн + уверенно → мгновенная карточка «⚡ без AI» + entity.create (оптимизм §2.5).
    const fin = (parsed.create.aspects?.['orbis/financial'] ?? {}) as Record<string, unknown>;
    const card = { ...fin, title: parsed.create.title };
    const cardId = insertCard(card, '⚡ без AI', {
      entityId: parsed.create.id,
      text,
      status: 'confirmed',
    });
    try {
      await create.mutateAsync({ input: parsed.create, source: 'fast_path' });
      // §5.1: созданная сущность обязана появиться в списках Browser и счётчиках.
      void utils.entity.query.invalidate();
      void utils.entity.count.invalidate();
      // 03-budget §4.1/§6.1: запись учтена сервером — остаток конверта на карточке
      // и бейдж alertCount перечитываются ПОСЛЕ записи, не до.
      void utils.budget.invalidate();
    } catch (err) {
      const outcome = mapSendError(err);
      // CONFLICT по своему id — сервер уже принял эту запись (идемпотентность §5.3): успех.
      if (outcome === 'confirmed') return;
      if (outcome === 'business_rejection') {
        // §5.3: бизнес-отказ НЕ буферизуется, а показывается — иначе ввод исчезал молча
        // (карточка успеха на экране, сущности нет, запись вычищена из очереди при flush).
        const code =
          err instanceof TRPCClientError && typeof err.data?.code === 'string'
            ? err.data.code
            : 'BAD_REQUEST';
        replaceCardWithError(cardId, 'Запись отклонена сервером — проверьте ввод.', code);
        return;
      }
      // Транспортный сбой: карточка деградирует в «⏳ ждёт отправки» — без entityId, то есть
      // без «Разобрать с AI» (02 §2.5: действия недоступны до подтверждения сервером).
      // Иначе reparse архивировал бы несуществующий id, а буфер позже создал вторую сущность.
      insertCard(card, '⏳ ждёт отправки', { text, status: 'pending' }, cardId);
      enqueueCreate(parsed.create, 'fast_path');
      void flushNow();
    }
  }

  // «Разобрать с AI»: снять fast-сущность (archived) и отправить исходную строку LLM-путём.
  // Архив гарантирует «одна строка ≠ две сущности» (D-плана): первая (fast) уходит, LLM создаёт свою.
  function reparse(entityId: string, text: string): void {
    if (entityId) update.mutate({ id: entityId, archived: true });
    sendMessage(text);
  }

  function insertSystemNote(note: string) {
    const synthetic: ChatMessage = {
      id: newId(),
      threadId,
      role: 'assistant',
      content: note,
      metadata: {},
      createdAt: new Date().toISOString(),
    } as ChatMessage;
    queryClient.setQueryData(key, (old) => upsertNewest(old as never, synthetic));
  }

  // isSending — pending LLM-отправки (typing-индикатор в ChatScreen); проброс строго аддитивен.
  return { submit, reparse, retry: retryMessage, isSending };
}
