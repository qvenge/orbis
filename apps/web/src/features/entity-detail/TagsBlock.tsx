import { useState } from 'react';
import { Chip } from '../../ui/Chip';
import { useRecordHost } from './record-host';
import { useEntityUpdate } from './useEntityDetail';

/**
 * `{{tags}}` — теги записи с правкой (спека страниц 1а §5.3, §7.3). До среза правки тегов в web
 * не было нигде: они ставились только AI и при создании.
 *
 * Запись — `entity.update {tags}` ПОЛНОЙ ЗАМЕНОЙ списка (контракт `entityUpdateInput.tags`): патча
 * «добавь один» у тегов нет. Через общую обвязку `useEntityUpdate` — тот же оптимистичный патч под
 * ключом записи, откат при отказе и Undo журналом, что у прочих правок экрана.
 *
 * Ввод — по образцу фильтра Browser (`browser/Filters.tsx`): Enter добавляет, дубликат — ничего,
 * Enter подтверждения IME тег не добавляет (иначе слово уехало бы недонабранным).
 */
export function TagsBlock() {
  const { entity } = useRecordHost();
  const { mutation } = useEntityUpdate(entity.id);
  const [draft, setDraft] = useState('');
  const tags = entity.tags;

  function write(next: string[]) {
    mutation.mutate({ id: entity.id, tags: next });
  }

  return (
    <div data-testid="tags-block" className="flex flex-wrap items-center gap-2">
      {tags.map((t) => (
        <Chip key={t} onRemove={() => write(tags.filter((x) => x !== t))}>
          {t}
        </Chip>
      ))}
      <input
        aria-label="Добавить тег"
        value={draft}
        placeholder="Добавить тег…"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
          // Строчными — как их хранит сервер (`normalizeTags`): иначе оптимистичный патч
          // показал бы «Работа», а перечитывание — «работа», и «дубликат» сверялся бы не с тем,
          // что на самом деле лежит в записи.
          const tag = draft.trim().toLowerCase();
          if (tag === '') return;
          if (!tags.includes(tag)) write([...tags, tag]);
          setDraft('');
        }}
        className="min-w-32 flex-1 rounded-md bg-transparent px-1 py-1 text-sm text-text outline-none transition placeholder:text-text-muted focus-visible:bg-surface-2/70"
      />
    </div>
  );
}
