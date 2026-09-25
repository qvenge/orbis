import {
  type AspectDefinition,
  effectiveLabel,
  OWNER_LOCALE,
  PAGE_ASPECT,
  TEMPLATE_FOR_PROPERTY,
  TEMPLATE_WINS_OVER_PROPERTY,
} from '@orbis/shared';
import { useState } from 'react';
import { AspectsManyControl } from '../../lib/registry/PropertyControl';
import { useRegistry } from '../../lib/registry/useRegistry';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import type { UpdateBatchOperation } from './useUpdateBatch';

/**
 * Чипы диалога: без служебных аспектов и без самой «страницы». Шаблон для прогонов агента или для
 * страниц владелец руками не собирает, а чип, который предлагает такое, звал бы сделать это.
 */
const offered = (a: AspectDefinition) => !a.service && a.id !== PAGE_ASPECT;

const listOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/**
 * Правка «Шаблон для» из диалога (спека страниц 1а §3.2, §8.4) — одной операцией пачки.
 *
 * Снять все — законный путь «шаблон → черновик», и пишется он СНЯТИЕМ обоих свойств одной
 * правкой: правило «Главнее, чем непусто → Шаблон для непуст» отвергло бы правку, которая
 * оставила бы запомненные выборы у страницы без «Шаблон для». Пустой список не пишется вовсе:
 * `has` у пустого списка истинен, и черновик считался бы шаблоном (Ф-1а-3). `null` — писать нечего.
 */
export function templateForOperation(
  entityId: string,
  current: readonly string[],
  next: readonly string[],
): UpdateBatchOperation | null {
  if (sameSet(current, next)) return null;
  return {
    tool: 'entity_update',
    input:
      next.length === 0
        ? { id: entityId, unset: [TEMPLATE_FOR_PROPERTY, TEMPLATE_WINS_OVER_PROPERTY] }
        : { id: entityId, props: { [TEMPLATE_FOR_PROPERTY]: [...next] } },
  };
}

/**
 * «Сделать шаблоном для…» (меню ⋮ страницы): набор аспектов, записям с которыми подходит страница.
 *
 * Правка копится в диалоге и уходит по «Сохранить», а не с каждого чипа: набор из трёх аспектов,
 * записанный тремя правками, трижды сменил бы вид всех записей с каждым промежуточным набором и
 * дал бы три Undo. Порог `minItems` чипов (РП-27) здесь снят: карточка закрывает последний чип,
 * потому что пустой список сервер отвергнет, а диалог пишет пустоту снятием (см.
 * `templateForOperation`) — это тот самый путь, на который указывает подсказка карточки.
 */
export function TemplateForDialog({
  entityId,
  value,
  onSave,
  onCancel,
}: {
  entityId: string;
  /** Текущее значение «Шаблон для» у страницы. */
  value: unknown;
  onSave: (operation: UpdateBatchOperation) => void;
  onCancel: () => void;
}) {
  const registry = useRegistry();
  const current = listOf(value);
  const [draft, setDraft] = useState<string[]>(current);
  const def = registry.property(TEMPLATE_FOR_PROPERTY);
  const label = def === undefined ? 'Шаблон для' : effectiveLabel(def.label, OWNER_LOCALE);
  // Без порога: пустоту диалог пишет снятием, а не пустым списком (докблок компонента).
  const free =
    def?.type.kind === 'registry_ref'
      ? { ...def, type: { ...def.type, minItems: undefined } }
      : def;

  function save() {
    const op = templateForOperation(entityId, current, draft);
    if (op === null) onCancel();
    else onSave(op);
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title="Сделать шаблоном для…"
    >
      <div className="flex flex-col gap-3 pt-2">
        <p className="text-sm text-text-secondary">
          Записи, у которых есть все отмеченные аспекты, будут показываться этой страницей. Снять
          все — страница перестанет быть шаблоном.
        </p>
        {free === undefined ? (
          <p className="text-sm text-text-muted">Реестр загружается…</p>
        ) : (
          <AspectsManyControl
            def={free}
            label={label}
            value={draft}
            onChange={(v) => setDraft(listOf(v))}
            offered={offered}
          />
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Отмена
          </Button>
          <Button onClick={save} disabled={free === undefined}>
            Сохранить
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
