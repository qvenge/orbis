import { Ban, Plus } from 'lucide-react';
import { useState } from 'react';
import { useNav } from '../../state/navigation';
import { type RouterOutputs, trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { quoteValue } from '../budget/txQuery';
import { detailGetInput } from './useEntityDetail';

type Relation = NonNullable<RouterOutputs['entity']['get']['relations']>[number];

// «Незакрытая» — ровно семантика excludeBlocked (§6.1): блокер БЕЗ task-аспекта живой,
// COALESCE(status,'') NOT IN ('done','cancelled'). Разъезд с ней ломает lock-иконку §3.6.
const CLOSED = new Set(['done', 'cancelled']);
const SECTION_LABEL = 'text-2xs font-medium uppercase tracking-wide text-text-muted';
const ROW =
  'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition hover:bg-surface-2/60';

/**
 * Секция 6 «Блокировки» (02-core-os §3.5.6): «блокирует» — исходящие blocks-связи,
 * «заблокирована» — входящие от НЕзакрытых задач. Связи приходят готовыми в
 * entity.get(include:['relations']) экрана (prop relations) — своего relation.listFor
 * секция не заводит; титул и статус второй стороны дочитываются per-id entity.get
 * (прецедент EntityRef/PinnedList: React Query кэширует и дедупит, списки короткие).
 *
 * Пустые списки скрыты (§3.5), но заголовок секции и «+» остаются: это единственный
 * путь создания blocks-связи из UI, и прятать его вместе с пустотой значило бы сделать
 * фичу недостижимой (та же логика, что у «тихой строки добавления» подзадач).
 */
export function Blocks({ entityId, relations }: { entityId: string; relations: Relation[] }) {
  const push = useNav((s) => s.push);
  const activeTab = useNav((s) => s.activeTab);
  const utils = trpc.useUtils();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');

  const blocks = relations.filter((r) => r.relationType === 'blocks');
  const outgoing = blocks.filter((r) => r.sourceId === entityId).map((r) => r.targetId);
  const incoming = blocks.filter((r) => r.targetId === entityId).map((r) => r.sourceId);
  const ids = [...outgoing, ...incoming];

  const sides = trpc.useQueries((t) => ids.map((id) => t.entity.get({ id })));
  const byId = new Map(ids.map((id, i) => [id, sides[i]?.data?.entity]));
  const title = (id: string) => byId.get(id)?.title ?? `${id.slice(0, 8)}…`;
  // Пока сущность не доехала — блокер считается живым: спрятать реальную блокировку
  // хуже, чем показать лишнюю строку на время загрузки.
  const alive = (id: string) => {
    const e = byId.get(id);
    return !e || !CLOSED.has(String(e.aspects['orbis/task']?.status ?? ''));
  };
  const blockedBy = incoming.filter(alive);

  const q = draft.trim();
  const search = trpc.entity.query.useQuery(
    { query: `search=${quoteValue(q)}, limit=10` },
    { enabled: adding && q.length >= 2 },
  );
  const known = new Set([entityId, ...ids]);
  const found = (search.data ?? []).filter((e) => !known.has(e.id));

  // Ацикличность blocks проверяет сервер (§4.2): путь цикла доезжает ТОЛЬКО в message
  // (cause по HTTP не сериализуется) — его и показываем плашкой (02 §6).
  const relate = trpc.relation.create.useMutation({
    onSuccess: () => {
      setDraft('');
      setAdding(false);
      void utils.entity.get.invalidate(detailGetInput(entityId));
    },
  });

  const open = (id: string) => push(activeTab, { kind: 'entity', id });
  const list = (label: string, items: string[]) => (
    <div className="flex flex-col">
      <p className={SECTION_LABEL}>{label}</p>
      <ul className="flex flex-col">
        {items.map((id) => (
          <li key={id} data-testid="block-row" className={ROW}>
            <Ban size={14} aria-hidden className="shrink-0 text-text-muted/70" />
            <button
              type="button"
              onClick={() => open(id)}
              className="min-w-0 flex-1 cursor-pointer truncate text-left hover:underline"
            >
              {title(id)}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <p className={SECTION_LABEL}>Блокировки</p>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Добавить блокировку"
          title="Добавить блокировку"
          onClick={() => setAdding((v) => !v)}
        >
          <Plus size={14} aria-hidden />
        </Button>
      </div>
      {outgoing.length > 0 && list('Блокирует', outgoing)}
      {blockedBy.length > 0 && list('Заблокирована', blockedBy)}
      {adding && (
        <div className="flex flex-col gap-1 px-2 py-1.5">
          <input
            aria-label="Поиск сущности"
            value={draft}
            placeholder="Найти сущность…"
            onChange={(e) => setDraft(e.target.value)}
            className="min-w-0 rounded-md bg-transparent px-1 text-sm text-text outline-none transition placeholder:text-text-muted focus-visible:bg-surface-2/70"
          />
          <ul className="flex flex-col">
            {found.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  disabled={relate.isPending}
                  onClick={() =>
                    relate.mutate({
                      source_id: entityId,
                      target_id: e.id,
                      relation_type: 'blocks',
                    })
                  }
                  className="w-full cursor-pointer truncate rounded-md px-2 py-1.5 text-left text-sm transition hover:bg-surface-2/60"
                >
                  {e.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {relate.error && (
        <p role="alert" className="px-2 text-sm text-danger">
          {relate.error.message}
        </p>
      )}
    </div>
  );
}
