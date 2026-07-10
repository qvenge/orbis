import { useState } from 'react';
import { aspectLabel, fieldLabel } from '../../lib/field-labels';
import type { RouterOutputs } from '../../trpc';
import { Button } from '../../ui/Button';
import { useEntityUpdate } from './useEntityDetail';

type Entity = RouterOutputs['entity']['get']['entity'];

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
  const aspects = entity.aspects as Record<string, Record<string, unknown>>;

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
            {Object.entries(fields).map(([field, value]) => (
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
            ))}
          </dl>
        </section>
      ))}
    </div>
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
