import { useState } from 'react';
import type { RouterOutputs } from '../../trpc';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Input } from '../../ui/Input';
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
      {Object.entries(aspects).map(([aspectId, fields]) => (
        <Card key={aspectId} data-testid={`aspect-${aspectId}`} className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <p className="font-medium">{aspectId}</p>
            <Button
              variant="ghost"
              aria-label={`Снять ${aspectId}`}
              onClick={() => mutation.mutate({ id: entity.id, aspects: { [aspectId]: null } })}
            >
              Снять аспект
            </Button>
          </div>
          <dl className="flex flex-col gap-1 text-sm">
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
        </Card>
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
  return (
    <div className="flex items-center gap-2">
      <dt className="text-text-secondary">{field}:</dt>
      <dd className="flex-1">
        <Input
          aria-label={`${aspectId} ${field}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => draft !== initial && onSave(draft)}
          className="w-full"
        />
      </dd>
    </div>
  );
}
