import { useState } from 'react';
import { aspectLabel, fieldLabel } from '../../lib/field-labels';
import { type RouterOutputs, trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { CATEGORIES_QUERY, toOption } from '../budget/categories';
import { invalidateBudget } from '../budget/useBudget';
import { useEntityUpdate } from './useEntityDetail';

type Entity = RouterOutputs['entity']['get']['entity'];

const FINANCIAL = 'orbis/financial';
const CATEGORY_REF = 'category_ref';

// Тихий инпут-в-строке-свойства: тот же вид у текстового поля и у пикера категории.
const FIELD_CLASS =
  'w-full rounded-md bg-transparent px-2 py-1 text-sm text-text outline-none transition hover:bg-surface-2 focus-visible:bg-surface-2/70 focus-visible:ring-2 focus-visible:ring-accent/40';

// Восстановление типа поля из исходного значения (правка идёт как строка из Input).
function coerce(original: unknown, raw: string): unknown {
  if (typeof original === 'number') return Number(raw);
  if (typeof original === 'boolean') return raw === 'true';
  return raw;
}

// Карточки установленных аспектов: типизированная inline-правка полей (§5.2 — та же
// optimistic + expectedUpdatedAt, что и body; правка подлежит Undo журнала сервера) и
// снятие аспекта целиком (aspects:{id:null}).
export function AspectCards({ entity }: { entity: Entity }) {
  const { mutation, conflict } = useEntityUpdate(entity.id);
  const utils = trpc.useUtils();
  const aspects = entity.aspects as Record<string, Record<string, unknown>>;

  // Смена категории (sign-off владельца K6) — обычный entity.update: перепривязку
  // транзакции к конверту делает серверный хук (фаза A), клиент ничего не связывает.
  // Бюджетные агрегаты после этого протухли — инвалидируем их тем же приёмом, что
  // экраны Budget (invalidateBudget); entity.get/entity.query обновит useEntityUpdate.
  function setCategory(categoryId: string) {
    mutation.mutate(
      {
        id: entity.id,
        expectedUpdatedAt: entity.updatedAt,
        aspects: { [FINANCIAL]: { [CATEGORY_REF]: categoryId } },
      },
      { onSuccess: () => void invalidateBudget(utils) },
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {conflict && (
        <p role="alert" className="text-sm text-danger">
          Аспект изменён в другом месте — обновите.
        </p>
      )}
      {/* Notion-style свойства: секция без карточной рамки, значения — тихие инпуты
          без бордера (hover подсказывает редактируемость). */}
      {Object.entries(aspects).map(([aspectId, fields]) => (
        <section key={aspectId} data-testid={`aspect-${aspectId}`} className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <p className="text-2xs font-medium uppercase tracking-wide text-text-muted">
              {aspectLabel(aspectId)}
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs text-text-muted"
              aria-label={`Снять ${aspectId}`}
              onClick={() => mutation.mutate({ id: entity.id, aspects: { [aspectId]: null } })}
            >
              Снять аспект
            </Button>
          </div>
          <dl className="grid grid-cols-[minmax(7rem,max-content)_1fr] items-center gap-x-3 gap-y-0.5 text-sm">
            {Object.entries(fields).map(([field, value]) =>
              // Единственное поле с собственным контролом: категория финансовой записи
              // выбирается из списка, а не вписывается UUID'ом руками (K6). Прочие
              // поля аспектов не трогаем — правка только пути category_ref.
              aspectId === FINANCIAL && field === CATEGORY_REF ? (
                <CategoryField
                  key={field}
                  value={typeof value === 'string' ? value : ''}
                  onSelect={setCategory}
                />
              ) : (
                <AspectField
                  key={field}
                  aspectId={aspectId}
                  field={field}
                  value={value}
                  onSave={(raw) =>
                    mutation.mutate({
                      id: entity.id,
                      expectedUpdatedAt: entity.updatedAt,
                      aspects: { [aspectId]: { [field]: coerce(value, raw) } },
                    })
                  }
                />
              ),
            )}
          </dl>
        </section>
      ))}
    </div>
  );
}

/**
 * Пикер категории для orbis/financial.category_ref (K6): показывает НАЗВАНИЯ категорий,
 * а не идентификатор. Список — тот же запрос и тот же кэш, что у экранов Budget.
 * Смонтирован только на financial-сущностях, поэтому запрос категорий не уходит с
 * каждого detail-экрана.
 */
function CategoryField({ value, onSelect }: { value: string; onSelect: (id: string) => void }) {
  const q = trpc.entity.query.useQuery({ query: CATEGORIES_QUERY });
  // Array.isArray — та же защита, что в TransactionsScreen: карточка живёт на общем
  // detail-экране, и неожиданная форма ответа не должна ронять всю страницу.
  const categories = (Array.isArray(q.data) ? q.data : []).map(toOption);
  const known = categories.some((c) => c.id === value);

  return (
    <>
      <dt className="text-text-muted">{fieldLabel(CATEGORY_REF)}</dt>
      <dd>
        <select
          aria-label={`${FINANCIAL} ${CATEGORY_REF}`}
          value={value}
          onChange={(e) => {
            if (e.target.value !== value) onSelect(e.target.value);
          }}
          className={FIELD_CLASS}
        >
          {/* Своя опция под текущее значение, пока список грузится или ссылка ведёт
              в архивную/удалённую категорию: иначе select показал бы пустоту и первым
              же изменением молча переставил категорию. */}
          {!known && (
            <option value={value}>
              {q.isLoading ? 'Загрузка…' : value === '' ? 'Без категории' : 'Категория не найдена'}
            </option>
          )}
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.icon ? `${c.icon} ` : ''}
              {c.title}
            </option>
          ))}
        </select>
      </dd>
    </>
  );
}

function AspectField({
  aspectId,
  field,
  value,
  onSave,
}: {
  aspectId: string;
  field: string;
  value: unknown;
  onSave: (raw: string) => void;
}) {
  const initial = String(value ?? '');
  const [draft, setDraft] = useState(initial);
  // dt/dd — прямые дети grid'а из AspectCards (grid-cols-[auto_1fr]): все инпуты
  // начинаются с одной вертикали независимо от длины лейбла (лейблы выровнены вправо).
  return (
    <>
      <dt className="text-text-muted">{fieldLabel(field)}</dt>
      <dd>
        <input
          aria-label={`${aspectId} ${field}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => draft !== initial && onSave(draft)}
          className="w-full rounded-md bg-transparent px-2 py-1 text-sm text-text outline-none transition hover:bg-surface-2 focus-visible:bg-surface-2/70 focus-visible:ring-2 focus-visible:ring-accent/40"
        />
      </dd>
    </>
  );
}
