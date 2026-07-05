import { type FastPathCategory, type FastPathCtx, newId, parseFastPath } from '@orbis/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useOnline, useRetryBuffer } from '../../state/retry';
import { trpc } from '../../trpc';
import { type ChatMessage, chatThreadKey, upsertNewest, useSendMessage } from './useChatThread';

const CATEGORY_QUERY = { query: 'aspect=orbis/category' } as const;

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
  const { sendMessage } = useSendMessage(threadId);

  const create = trpc.entity.create.useMutation();
  const update = trpc.entity.update.useMutation();
  const key = chatThreadKey(threadId);

  // Свежий контекст парсера: категории (aspect=orbis/category) + валюта по умолчанию.
  // getData() — тёплый кэш (в т.ч. офлайн после онлайн-загрузки); иначе fetch (staleTime 30s).
  async function loadCtx(): Promise<FastPathCtx> {
    const cats =
      utils.entity.query.getData(CATEGORY_QUERY) ??
      (await utils.entity.query.fetch(CATEGORY_QUERY));
    const settings = utils.user.getSettings.getData() ?? (await utils.user.getSettings.fetch());
    const categories: FastPathCategory[] = (cats ?? []).map((e) => {
      const meta = (e.aspects['orbis/category'] ?? {}) as {
        aliases?: string[];
        spend_class?: string;
      };
      return { id: e.id, aliases: meta.aliases ?? [], spendClass: meta.spend_class };
    });
    return { categories, defaultCurrency: settings?.defaultCurrency ?? 'RUB' };
  }

  function insertCard(card: Record<string, unknown>, note: string, fastPath: FastPathMeta) {
    const synthetic: ChatMessage = {
      id: newId(),
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
  }

  async function submit(text: string): Promise<void> {
    const ctx = await loadCtx();
    const parsed = parseFastPath(text, ctx);

    if (!online) {
      // Офлайн: LLM недоступен. Уверенный → retry-буфер + «⏳ ждёт отправки»; иначе — подсказка.
      if (parsed.ok) {
        enqueueCreate(parsed.create, 'fast_path');
        const fin = (parsed.create.aspects?.['orbis/financial'] ?? {}) as Record<string, unknown>;
        insertCard({ ...fin, title: parsed.create.title }, '⏳ ждёт отправки', {
          text,
          status: 'pending',
        });
      } else {
        insertSystemNote('Нет сети — доступен только быстрый ввод (сумма + категория).');
      }
      return;
    }

    if (!parsed.ok) {
      // Неуверенно → LLM-путь (ошибку и потерю текста закрывает useSendMessage.onError, §3).
      sendMessage(text);
      return;
    }

    // Онлайн + уверенно → мгновенная карточка «⚡ без AI» + entity.create.
    const fin = (parsed.create.aspects?.['orbis/financial'] ?? {}) as Record<string, unknown>;
    insertCard({ ...fin, title: parsed.create.title }, '⚡ без AI', {
      entityId: parsed.create.id,
      text,
      status: 'confirmed',
    });
    try {
      await create.mutateAsync({ input: parsed.create, source: 'fast_path' });
    } catch {
      // Потеря сети во время отправки — переложить в буфер и дренировать позже.
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

  return { submit, reparse, resend: sendMessage };
}
