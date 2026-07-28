import { type FastPathCategory, type FastPathCtx, newId, parseFastPath } from '@orbis/shared';
import { useQueryClient } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { useOnline, useRetryBuffer } from '../../state/retry';
import { isConflict, mapSendError } from '../../state/retry-send';
import { trpc } from '../../trpc';
import { MEMORY_RULES_QUERY, MEMORY_RULES_STALE_TIME } from './memoryRules';
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

  // Категории (aspect=orbis/category) + валюта + memory-правила → контекст парсера.
  // `cats`/`settings`/`rules` — сырьё кэша/сети.
  type QueryOut = ReturnType<typeof utils.entity.query.getData>;
  type SettingsOut = ReturnType<typeof utils.user.getSettings.getData>;
  function mapCtx(cats: QueryOut, settings: SettingsOut, rules: QueryOut): FastPathCtx {
    const categories: FastPathCategory[] = (cats ?? []).map((e) => {
      const meta = (e.aspects?.['orbis/category'] ?? {}) as {
        aliases?: string[];
        spend_class?: string;
      };
      // title — для резолва категории, названной в memory-правиле (§7.8: id в правиле нет).
      return {
        id: e.id,
        title: e.title,
        aliases: meta.aliases ?? [],
        spendClass: meta.spend_class,
      };
    });
    return {
      categories,
      defaultCurrency: settings?.defaultCurrency ?? 'RUB',
      today: todayIn(settings?.timezone),
      // Заголовок правила уходит в парсер КАК ЕСТЬ (разбирает его shared, не клиент);
      // updatedAt — арбитр конфликта двух правил на один паттерн (applyMemoryRules).
      rules: (rules ?? []).map((e) => ({ title: e.title, updatedAt: e.updatedAt })),
    };
  }

  /**
   * Фоновая догрузка правил: свежесть догоняет К СЛЕДУЮЩЕМУ вводу, текущий не ждёт сеть.
   * Отказ гасим здесь же — правило это обогащение поверх алиасов, и его сбой не имеет
   * права всплыть unhandled rejection'ом (retry у клиента выключен).
   */
  function refreshRules(): void {
    void utils.entity.query
      .fetch(MEMORY_RULES_QUERY, { staleTime: MEMORY_RULES_STALE_TIME })
      .catch(() => {});
  }

  // Онлайн: свежий ctx (getData() тёплый кэш → иначе fetch, staleTime 30s).
  async function loadCtx(): Promise<FastPathCtx> {
    const cats =
      utils.entity.query.getData(CATEGORY_QUERY) ??
      (await utils.entity.query.fetch(CATEGORY_QUERY));
    const settings = utils.user.getSettings.getData() ?? (await utils.user.getSettings.fetch());
    // Правила — getData-first, ровно как категории. Блокирующий fetch здесь означал бы
    // СЕТЬ ПЕРЕД КАЖДЫМ вводом: успешный create инвалидирует весь префикс entity.query, а
    // fetchQuery на инвалидированной query перечитывает независимо от staleTime. Карточка
    // «⚡ без AI» переставала быть мгновенной (§2.5), а зависший запрос съедал бы ввод
    // целиком — Composer текст уже стёр, ни карточки, ни entity.create.
    // Свежесть обеспечивают два пути: точечный refetch после [Запомнить]
    // (MemoryRuleCard — правило работает со следующего же ввода) и фоновая догрузка ниже.
    const cached = utils.entity.query.getData(MEMORY_RULES_QUERY);
    if (cached !== undefined) {
      refreshRules();
      return mapCtx(cats, settings, cached);
    }
    // Холодный кэш (правила в этой сессии не читались): один раз ждём — иначе первый ввод
    // молча уехал бы на одни алиасы. Цена та же, что уже платят категории. Отказ запроса
    // быстрый ввод НЕ роняет: терять из-за правил стёртый композером текст нельзя.
    let rules: QueryOut;
    try {
      rules = await utils.entity.query.fetch(MEMORY_RULES_QUERY, {
        staleTime: MEMORY_RULES_STALE_TIME,
      });
    } catch (e) {
      // Деградация остаётся (правила необязательны), но она больше не немая. Сюда падают
      // и транспортный отказ, и BAD_REQUEST парсера запроса: на непересеянном реестре
      // аспектов (ловушка релиза фазы C) «aspect=orbis/memory» не разбирается, и правила
      // молча не применяются — снаружи это неотличимо от «правил нет». console.warn —
      // единственный доступный в проекте сигнал.
      console.warn('[fast-path] правила памяти не загрузились, разбираем по алиасам:', e);
      rules = undefined;
    }
    return mapCtx(cats, settings, rules);
  }

  // Офлайн: ТОЛЬКО тёплый кэш (без fetch) — иначе onlineManager заморозит запрос и submit зависнет (§2.6).
  function cachedCtx(): FastPathCtx {
    return mapCtx(
      utils.entity.query.getData(CATEGORY_QUERY),
      utils.user.getSettings.getData(),
      utils.entity.query.getData(MEMORY_RULES_QUERY),
    );
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
      // CONFLICT — НЕ успех (уборочная фаза, решение 7; прецедент QuickAddBar B4):
      // честный повтор владельца executor отдаёт replay-успехом, а CONFLICT кидается
      // ровно тогда, когда id занят невидимой под RLS чужой строкой — записи владельца
      // на сервере нет. Повторяем один раз со свежим id: карточка уже на экране, и ввод
      // терять нельзя, а ждать бессмысленно — чужой id своим не станет.
      if (isConflict(err)) {
        try {
          await create.mutateAsync({
            input: { ...parsed.create, id: newId() },
            source: 'fast_path',
          });
          void utils.entity.query.invalidate();
          void utils.entity.count.invalidate();
          void utils.budget.invalidate();
        } catch {
          // Второй отказ не разбираем по кодам: карточка деградирует в «⏳ ждёт отправки»
          // тем же путём, что транспортный сбой ниже, — ввод уходит в буфер.
          insertCard(card, '⏳ ждёт отправки', { text, status: 'pending' }, cardId);
          enqueueCreate({ ...parsed.create, id: newId() }, 'fast_path');
          void flushNow();
        }
        return;
      }
      const outcome = mapSendError(err);
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
