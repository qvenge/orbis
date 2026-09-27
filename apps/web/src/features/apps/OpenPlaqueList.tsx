import { HOME_PROPERTY, type OpenPlaque } from '@orbis/shared';
import type { ReactNode } from 'react';
import { invalidateGraph } from '../../lib/invalidate';
import { appRefOf, useNav } from '../../state/navigation';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { useUpdateBatch } from '../page/useUpdateBatch';
import type { OpenPlaquesProps } from './OpenPlaques';
import { PlaceQuestion } from './PlaceQuestion';

/**
 * Плашки правила открытия (срез 1б §5.2, §3.4; Фокус ревью п. 3) над показом записи или вместо
 * домашней приложения: хост показан не молча, а с причиной и выходом. Модуль ЛЕНИВЫЙ — грузит его
 * `OpenPlaques.tsx`, только когда плашки есть (вес первого кадра записи, РП-25).
 *
 * - `app-off` — «[A] выключено — [включить]» (`app.setDisabled`, расширения «Состава» не трогаются:
 *   их включает диалог настроек, а кнопка плашки — одно действие, которое владелец видит); в архиве —
 *   «[A] в архиве — [восстановить]» одной пачкой `archived: false` (Э-20: включение архивного ничего
 *   не открыло бы);
 * - `reserved` — «Бюджет придёт со следующим срезом», без кнопки (§3.4);
 * - `app-unknown` — из адреса «Приложение не найдено», из «Дома» страницы — «Дом страницы не найден»
 *   (carry задачи 20, Fable M-4): это разные поломки, и чинятся они в разных местах;
 * - `no-view` — «В „A“ нет вида для таких записей — открыть в [X]»: X — разовый переход (новый шаг,
 *   «‹» вернёт в A), выбор места не запоминается;
 * - `place-dispute` — вопрос «Где открывать такие записи?» (`PlaceQuestion`, РП-20).
 *
 * `record` — запись экрана (для «открыть в X» и ответа на вопрос; её «Дом» отличает `app-unknown`
 * «Дома» от `app-unknown` адреса); на домашней приложения записи нет — там бывают только плашки
 * шага 0.
 */
export function OpenPlaqueList({ plaques, apps, record }: OpenPlaquesProps) {
  const recordId = record?.id ?? null;
  const pageHome = record?.props[HOME_PROPERTY] ?? null;
  const titleOf = (id: string) => apps.byId.get(id)?.title || 'Приложение';
  const goTo = (appId: string) => {
    if (recordId === null) return;
    useNav.getState().replacePlace({ kind: 'record', app: appRefOf(appId), id: recordId }, appId);
  };
  return (
    <div className="flex flex-col gap-2 px-4 pt-3 md:px-6">
      {plaques.map((p): ReactNode => {
        switch (p.kind) {
          case 'app-off':
            return <AppOff key={`off:${p.appId}`} plaque={p} title={titleOf(p.appId)} />;
          case 'reserved':
            return <Plaque key="reserved">Бюджет придёт со следующим срезом</Plaque>;
          case 'app-unknown':
            return (
              <Plaque key={`unknown:${p.ref}`}>
                {p.ref === pageHome
                  ? 'Дом страницы не найден — страница показана в хосте'
                  : 'Приложение не найдено — показано в хосте'}
              </Plaque>
            );
          case 'no-view':
            return (
              <Plaque key={`no-view:${p.appId}`}>
                В «{titleOf(p.appId)}» нет вида для таких записей
                {p.alternatives.length > 0 && ' — открыть в'}
                {p.alternatives.map((id) => (
                  <Button
                    key={id}
                    variant="outline"
                    size="sm"
                    className="ml-2"
                    onClick={() =>
                      recordId !== null && useNav.getState().openRecord(recordId, { app: id })
                    }
                  >
                    {titleOf(id)}
                  </Button>
                ))}
              </Plaque>
            );
          case 'place-dispute':
            return (
              <PlaceQuestion
                key={p.key ?? 'dispute'}
                contenders={p.contenders}
                apps={apps}
                onGo={goTo}
              />
            );
          default:
            return null;
        }
      })}
    </div>
  );
}

function Plaque({ children }: { children: ReactNode }) {
  return (
    <Card
      role="note"
      data-testid="open-plaque"
      className="border-dashed text-sm text-text-secondary"
    >
      {children}
    </Card>
  );
}

function AppOff({
  plaque,
  title,
}: {
  plaque: Extract<OpenPlaque, { kind: 'app-off' }>;
  title: string;
}) {
  const utils = trpc.useUtils();
  const enable = trpc.app.setDisabled.useMutation({ onSettled: () => invalidateGraph(utils) });
  const runBatch = useUpdateBatch();
  const id = plaque.appId;
  return (
    <Plaque>
      {title} {plaque.archived ? 'в архиве' : 'выключено'} —
      <Button
        variant="outline"
        size="sm"
        className="ml-2"
        disabled={enable.isPending}
        onClick={() =>
          plaque.archived
            ? void runBatch(
                [{ tool: 'entity_update', input: { id, archived: false } }],
                `«${title}» восстановлено`,
                { action: 'Восстановить приложение' },
              )
            : enable.mutate({ appId: id, disabled: false, extensions: [] })
        }
      >
        {plaque.archived ? 'восстановить' : 'включить'}
      </Button>
    </Plaque>
  );
}
