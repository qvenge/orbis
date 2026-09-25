import {
  type BrokenTemplate,
  recordDisputeChoice,
  TEMPLATE_WINS_OVER_PROPERTY,
  templatesFromRows,
} from '@orbis/shared';
import { useState } from 'react';
import { invalidateGraph } from '../../lib/invalidate';
import { aspectLabel } from '../../lib/registry/labels';
import { useRegistry } from '../../lib/registry/useRegistry';
import { openEntity } from '../../state/navigation';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { useToast } from '../../ui/toast-store';
import type { WireEntity } from '../entity-detail/record-host';

/**
 * Плашки выбора шаблона над показом записи (спека страниц 1а §4.2 шаг 7, §4.3; РП-14): спор,
 * сломанный шаблон, не приехавший список. Все три — над рендером, а не на месте блока: говорят они
 * о выборе шаблона целиком, а не о строке его текста.
 */

const COUNT_WORD: Readonly<Record<number, string>> = { 2: 'два', 3: 'три', 4: 'четыре' };
const templatesWord = (n: number) =>
  COUNT_WORD[n] === undefined ? `${n} шаблонов` : `${COUNT_WORD[n]} шаблона`;

/** Раньше созданный — первым: тот же порядок, в каком выбор показывает шаблон до решения (§4.2 шаг 6). */
const byCreation = (a: WireEntity, b: WireEntity) =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1;

/**
 * Плашка спора (§4.3): «Для записей „проект + задача“ подходят два шаблона: [A] [B]. Какой
 * использовать?». Подпись — объединение наборов спорящих.
 *
 * Выбор пишется ОДНОЙ пачкой `entity.updateBatch` — один журнал, один Undo (тост «Отменить»).
 * Правки — `recordDisputeChoice`: победителю «главнее» всех спорящих, у спорящих победитель из
 * «главнее» убран, id вне списка шаблонов (архивные, снятые) вычищены — иначе сервер отверг бы всю
 * пачку «цель архивна» (РП-21). Пустое «Главнее, чем» пишется СНЯТИЕМ: пустой список у ссылочного
 * свойства — не «ничего», а значение, и держать его незачем.
 *
 * Экран переключается после инвалидации: перечитанный список несёт выбор, и функция выбора
 * находит победителя сама — второй копии правды «кто выбран» у экрана нет.
 */
export function DisputePlaque({
  contenders,
  rows,
}: {
  contenders: readonly string[];
  rows: WireEntity[];
}) {
  const reg = useRegistry();
  const utils = trpc.useUtils();
  const { show } = useToast();
  // Закрыта без записи: повторный выбор текущего победителя (меню «Сменить выбор», задача 15) —
  // писать нечего, а плашка, оставшаяся висеть после нажатия, выглядела бы отказом.
  const [closed, setClosed] = useState(false);
  const write = trpc.entity.updateBatch.useMutation({
    onSuccess: ({ actionId }) => {
      invalidateGraph(utils);
      show('Выбор шаблона запомнен', 'default', {
        label: 'Отменить',
        // Клиентом, а не хуком мутации: к нажатию плашки уже нет (спор решён), а колбэки мутации
        // размонтированного компонента React Query не зовёт.
        onSelect: () => {
          void utils.client.ai.undo
            .mutate({ actionId })
            .then(() => invalidateGraph(utils))
            .catch(() => show('Не удалось отменить выбор', 'danger'));
        },
      });
    },
    onError: () => show('Не удалось запомнить выбор шаблона', 'danger'),
  });
  if (closed) return null;

  const mine = rows.filter((r) => contenders.includes(r.id)).sort(byCreation);
  const aspects = [...new Set(templatesFromRows(mine).flatMap((t) => t.forAspects))];
  const subject = aspects.map((a) => aspectLabel(reg, a).toLocaleLowerCase('ru')).join(' + ');

  function choose(winner: string) {
    const changes = recordDisputeChoice(winner, contenders, templatesFromRows(rows));
    if (changes.size === 0) {
      setClosed(true);
      return;
    }
    write.mutate({
      operations: [...changes].map(([id, next]) => ({
        tool: 'entity_update' as const,
        input:
          next.length === 0
            ? { id, unset: [TEMPLATE_WINS_OVER_PROPERTY] }
            : { id, props: { [TEMPLATE_WINS_OVER_PROPERTY]: next } },
      })),
    });
  }

  return (
    <Card role="note" data-testid="dispute-plaque" className="flex flex-col gap-2 border-dashed">
      <p className="text-sm text-text-secondary">
        Для записей „{subject}“ подходят {templatesWord(mine.length)}:
      </p>
      <div className="flex flex-wrap gap-2">
        {mine.map((t) => (
          <Button
            key={t.id}
            variant="outline"
            size="sm"
            disabled={write.isPending}
            onClick={() => choose(t.id)}
          >
            {t.title}
          </Button>
        ))}
      </div>
      <p className="text-sm text-text-secondary">Какой использовать?</p>
    </Card>
  );
}

/**
 * Шаблон не разобран или не отрисовался (§4.2 шаг 7): выбор его исключил и показал следующий, а
 * человек узнаёт, какой шаблон и почему, — и открывает его одним нажатием. Молча показать другой
 * шаблон значило бы спрятать поломку навсегда (§6.5).
 */
export function BrokenTemplatePlaque({ broken, title }: { broken: BrokenTemplate; title: string }) {
  return (
    <Card role="alert" data-testid="broken-template" className="flex flex-col gap-2 border-danger">
      <p className="text-danger text-sm">
        Шаблон „{title}“ не разобран: {broken.reason}
      </p>
      <div>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Открыть шаблон „${title}“`}
          onClick={() => openEntity(broken.id)}
        >
          Открыть шаблон
        </Button>
      </div>
    </Card>
  );
}

/** Список шаблонов не приехал (РП-14): запись показана шаблоном хоста, экран работает. */
export function TemplatesErrorPlaque() {
  return (
    <Card role="alert" data-testid="templates-error" className="border-danger">
      <p className="text-danger text-sm">
        Список шаблонов не загрузился — запись показана шаблоном хоста.
      </p>
    </Card>
  );
}
