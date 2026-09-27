import { HOST_SHELL_KEY } from '@orbis/shared/supply';
import { useMemo, useState } from 'react';
import { refIdsKey } from '../../lib/registry/ref-clean';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import type { WireEntity } from '../entity-detail/record-host';
import { shellRevertPlan } from './revert-shell';
import { REVERT, useSupplyAction } from './useSupply';

/**
 * «Вернуть как было» у оболочки хоста (срез 1б §9.1 п. 4): ДО возврата диалог показывает, какие
 * разделы, добавленные владельцем, исчезнут, — и что не вернётся: эталон пишется без архивных целей
 * (R-16), поэтому архивный раздел поставки не вернётся, а при «Домой» в архиве домашней после
 * возврата не будет вовсе, даже если своя была (перенос из ревью задачи 11). «Отменить» в тосте
 * возвращает всё как сейчас — это сказано в диалоге.
 *
 * Модуль ЛЕНИВЫЙ: диалог нужен после жеста в меню «⋯».
 */
export function RevertShellDialog({ row, onClose }: { row: WireEntity; onClose: () => void }) {
  const run = useSupplyAction();
  const [busy, setBusy] = useState(false);
  const plan = useMemo(() => shellRevertPlan(row.props), [row.props]);
  const ids = useMemo(
    () =>
      plan === null
        ? []
        : refIdsKey(
            [...plan.vanishing, ...plan.etalonNav, plan.home, plan.etalonHome].filter(
              (x): x is string => x !== null,
            ),
          ),
    [plan],
  );
  const refs = trpc.entity.resolveRefs.useQuery({ ids }, { enabled: ids.length > 0 });
  const byId = useMemo(() => new Map((refs.data ?? []).map((r) => [r.id, r])), [refs.data]);
  const known = ids.length === 0 || refs.data !== undefined || refs.isError;
  const name = (id: string) => `«${byId.get(id)?.title || id}»`;
  const alive = (id: string | null) =>
    id !== null && byId.get(id) !== undefined && byId.get(id)?.archived !== true;

  if (plan === null) return null;
  // Живо ли то, что эталон вернёт, — знает только ответ `resolveRefs`; до него о домашней и архивных
  // разделах молчим, а кнопка ждёт (`known`): предупреждение, пришедшее после нажатия, опоздало бы.
  const loaded = refs.data !== undefined;
  const lostNav = loaded ? plan.etalonNav.filter((id) => !alive(id)) : [];
  const homeLost = plan.etalonHome === null || (loaded && !alive(plan.etalonHome));

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`${REVERT}: «${row.title}»`}
    >
      <div data-testid="revert-shell-dialog" className="flex flex-col gap-3 pt-2 text-sm">
        {plan.vanishing.length > 0 ? (
          <p data-testid="revert-vanishing">
            Исчезнут разделы, которые вы добавили: {plan.vanishing.map(name).join(', ')}.
          </p>
        ) : (
          <p>Разделов, которые вы добавили, нет — навигация станет как в поставке.</p>
        )}
        {homeLost && (plan.home !== null || plan.etalonHome !== null) && (
          <p data-testid="revert-home">
            Домашней после возврата не будет:{' '}
            {plan.etalonHome === null
              ? 'у поставки её нет'
              : `страница поставки ${name(plan.etalonHome)} в архиве`}
            {plan.home !== null && plan.home !== plan.etalonHome
              ? `, а ваша домашняя ${name(plan.home)} будет снята`
              : ''}
            .
          </p>
        )}
        {loaded && !homeLost && plan.etalonHome !== null && plan.home !== plan.etalonHome && (
          <p data-testid="revert-home">
            Домашней снова станет {name(plan.etalonHome)}
            {plan.home !== null ? ` вместо ${name(plan.home)}` : ''}.
          </p>
        )}
        {lostNav.length > 0 && (
          <p data-testid="revert-lost">
            Разделы поставки в архиве не вернутся: {lostNav.map(name).join(', ')}.
          </p>
        )}
        <p className="text-xs text-text-muted">«Отменить» в уведомлении вернёт всё как сейчас.</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            disabled={!known || busy}
            onClick={() => {
              setBusy(true);
              void run({ kind: 'revert', key: HOST_SHELL_KEY }).then((ok) => {
                setBusy(false);
                if (ok) onClose();
              });
            }}
          >
            {REVERT}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
