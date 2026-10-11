// Назначение исполнителя (С2, С8): кому поручена задача — человеку или агенту, каким доступом
// он ходит и волен ли закрыть тикет сам. Собственный контрол, а не строки в общей форме
// свойств: у трёх свойств есть ОБЩИЙ ИНВАРИАНТ (executor=agent ⇔ есть грант — строки каталога
// `assignment_grant_required`/`_forbidden`, `builtin-rules.ts`; грант жив — `assertGrantAlive`,
// `executor/invariants.ts`), а форма правит их по одному — переключение исполнителя без гранта
// отдавало бы отказ `INVARIANT` на каждом втором нажатии.
import { useRef, useState } from 'react';
import type { RouterOutputs } from '../../trpc';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import {
  AssignmentFields,
  assignmentDraftOf,
  assignmentPatch,
  assignmentScopeLabel,
  useAssignmentGrants,
} from './assignment-form';
import { useHostReadOnly } from './record-host';
import { useEntityUpdate } from './useEntityDetail';

type Entity = RouterOutputs['entity']['get']['entity'];

const ASSIGNMENT = 'orbis/assignment';
/** Адреса значений — id СВОЙСТВ (§А1-1); `orbis/grant` слит с полем прогона (В1). */
const EXECUTOR = 'orbis/executor';
const GRANT = 'orbis/grant';
const ASSIGNEE = 'orbis/assignee';

export function AssignmentCard({ entity }: { entity: Entity }) {
  // Предпросмотр шаблона (хост `readOnly`): кто назначен — видно, выбора исполнителя, доступа и
  // кнопок назначения нет.
  const readOnly = useHostReadOnly();
  const { mutation } = useEntityUpdate(entity.id);
  const [draft, setDraft] = useState(() => assignmentDraftOf(entity));
  // Экран монтируется БЕЗ key (router.tsx), и переход запись→запись меняет только проп: без
  // сброса черновик соседней задачи предлагал бы сохранить чужого исполнителя.
  const prevIdRef = useRef(entity.id);
  if (prevIdRef.current !== entity.id) {
    prevIdRef.current = entity.id;
    setDraft(assignmentDraftOf(entity));
  }
  const { grants, live, revoked: draftGrantRevoked } = useAssignmentGrants(draft);

  // «Назначение есть» — факт СПИСКА аспектов (§А1-1), а не «в карте есть ключ»: назначение
  // без единого заполненного свойства (сервер их не требует) прежде было неотличимо от
  // снятого, и карточка показывала «Не назначен» на записи, которую агент считает своей.
  const assigned = entity.aspects.includes(ASSIGNMENT);
  const props = entity.props;
  const savedGrantId = typeof props[GRANT] === 'string' ? props[GRANT] : undefined;
  const savedGrant = live.find((g) => g.id === savedGrantId);
  // Shared fields keep an unavailable saved grant visible and explain revocation only
  // after the grant list has arrived; the card summary uses the same evidence.
  const grantsLoaded = grants.data !== undefined;
  const savedGrantRevoked = grantsLoaded && savedGrantId !== undefined && savedGrant === undefined;

  function save() {
    const command = assignmentPatch(entity.id, draft);
    mutation.mutate({
      id: entity.id,
      ...command.patch,
      aspects: { attach: [command.aspectId] },
    });
  }

  return (
    <div data-testid="assignment-card" className="flex flex-col gap-2">
      <p className="text-2xs font-medium uppercase tracking-wide text-text-muted">Назначение</p>
      {!assigned ? (
        <p className="text-sm text-text-muted">Не назначен</p>
      ) : props[EXECUTOR] === 'agent' ? (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          Агент
          {/* break-words: подпись гранта пишет тот, кто регистрировался (сервер режет её до 64
              код-поинтов, но не до узкой). */}
          <span className="break-words">
            {savedGrant?.label ?? (grants.isLoading ? '…' : (savedGrantId ?? '—'))}
          </span>
          {savedGrant !== undefined && <Badge>{assignmentScopeLabel(savedGrant.scope)}</Badge>}
          {savedGrantRevoked && <Badge tone="danger">грант отозван</Badge>}
          {/* Согласие дано, а токены агент не забрал: ходить он не может, и назначение на него
              будет ждать вечно — молчать об этом нельзя (та же ветка в ConnectedAgents). */}
          {savedGrant?.connected === false && <Badge tone="danger">не подключён</Badge>}
        </p>
      ) : (
        <p className="text-sm">
          Человек
          {typeof props[ASSIGNEE] === 'string' ? ` · ${props[ASSIGNEE]}` : ''}
        </p>
      )}

      {!readOnly && (
        <>
          <AssignmentFields draft={draft} onChange={setDraft} disabled={mutation.isPending} />

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              // Агент без гранта — гарантированный `INVARIANT` сервера (`assignment_grant_required`),
              // с отозванным — NOT_FOUND:
              // не отправляем вовсе ни то, ни другое.
              disabled={
                mutation.isPending ||
                (draft.executor === 'agent' && (draft.grantId === '' || draftGrantRevoked))
              }
              onClick={save}
            >
              Сохранить
            </Button>
            {assigned && (
              <Button
                size="sm"
                variant="ghost"
                disabled={mutation.isPending}
                onClick={() =>
                  mutation.mutate({
                    id: entity.id,
                    // `detach` снимает АСПЕКТ (§А1-1) — задача остаётся задачей, но ничьей.
                    // Значений снятие не трогает (Р9): исполнитель, которого сняли, остаётся
                    // фактом владельца и виден в секции «Свойства».
                    aspects: { detach: [ASSIGNMENT] },
                  })
                }
              >
                Снять назначение
              </Button>
            )}
          </div>
        </>
      )}
      {/* Отказ сервера показываем текстом: он здесь содержательный — отозванный между открытием
          экрана и нажатием грант отвечает «не найден или отозван», и без этой строки владелец
          видел бы нажатую кнопку и прежнее назначение, не понимая, сохранилось ли что-нибудь. */}
      {mutation.isError && (
        <p role="alert" className="text-danger text-sm">
          {mutation.error.message}
        </p>
      )}
    </div>
  );
}
