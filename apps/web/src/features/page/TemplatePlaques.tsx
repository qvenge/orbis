import {
  type BrokenTemplate,
  recordDisputeChoice,
  TEMPLATE_WINS_OVER_PROPERTY,
  templatesFromRows,
} from '@orbis/shared';
import { useState } from 'react';
import { aspectLabel } from '../../lib/registry/labels';
import { useRegistry } from '../../lib/registry/useRegistry';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import type { WireEntity } from '../entity-detail/record-host';
import { PAGE_TEMPLATES_QUERY, patchTemplatesList } from './usePageTemplates';
import { useUpdateBatch } from './useUpdateBatch';

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
 * Экран переключается патчем списка до ответа (`patchTemplatesList`, Л-2): функция выбора находит
 * победителя сама по патченому кешу — второй копии правды «кто выбран» у экрана нет. Правда
 * сервера — перечитыванием после записи; отказ пачки — откат снимком.
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
  const runBatch = useUpdateBatch();
  // Закрыта — выбор сделан. Два пути: повторный выбор текущего победителя (меню «Сменить выбор»,
  // задача 15) — писать нечего, а плашка, оставшаяся висеть после нажатия, выглядела бы отказом;
  // и записанный выбор — до перечитывания списка кнопки снова нажимаемы, а второе нажатие дало бы
  // вторую пачку и второй Undo. Закрытость не переживает решённый спор: плашка размонтируется, и
  // вернувшийся спор (Undo, новый участник) встретит свежую.
  const [closed, setClosed] = useState(false);
  // Пачка в полёте — кнопки заперты: второе нажатие до ответа дало бы вторую пачку. Отказ снимает
  // замок, плашка остаётся (перечитанный список соберёт выбор заново).
  const [pending, setPending] = useState(false);
  if (closed) return null;

  const mine = rows.filter((r) => contenders.includes(r.id)).sort(byCreation);
  const aspects = [...new Set(templatesFromRows(mine).flatMap((t) => t.forAspects))];
  const subject = aspects.map((a) => aspectLabel(reg, a).toLocaleLowerCase('ru')).join(' + ');

  async function choose(winner: string) {
    const changes = recordDisputeChoice(winner, contenders, templatesFromRows(rows));
    if (changes.size === 0) {
      setClosed(true);
      return;
    }
    setPending(true);
    // Экран переключается сразу: функция выбора видит патч списка (Л-2), не дожидаясь пачки.
    const rollback = await patchTemplatesList(utils, changes);
    // Одна копия механизма «пачка → тост „Отменить“ → Undo → перечитывание» с меню ⋮ (C1-I4);
    // тексты отказа — свои: плашка знает, что именно не записано.
    const written = await runBatch(
      [...changes].map(([id, next]) => ({
        tool: 'entity_update' as const,
        input:
          next.length === 0
            ? { id, unset: [TEMPLATE_WINS_OVER_PROPERTY] }
            : { id, props: { [TEMPLATE_WINS_OVER_PROPERTY]: next } },
      })),
      'Выбор шаблона запомнен',
      {
        action: 'Выбор шаблона',
        failed: 'Не удалось запомнить выбор шаблона',
        undoFailed: 'Не удалось отменить выбор',
      },
    );
    if (!written) {
      // Отказ: экран и плашка — как до жеста.
      rollback();
      setPending(false);
      return;
    }
    // Плашка закрывается после перечитывания: до него кнопки заперты, второе нажатие дало бы
    // вторую пачку. `cancelRefetch: false` — ждать перечитывание, уже начатое пачкой
    // (`invalidateGraph`), а не гасить его и слать второе.
    await utils.entity.query.invalidate({ query: PAGE_TEMPLATES_QUERY }, undefined, {
      cancelRefetch: false,
    });
    setPending(false);
    setClosed(true);
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
            disabled={pending}
            onClick={() => void choose(t.id)}
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
 * человек узнаёт, какой шаблон и почему, — и одним нажатием открывает его НАСТРОЙКУ (§9.1): чинить
 * шаблон — правкой его тела, а не чтением страницы шаблона. Молча показать другой шаблон значило
 * бы спрятать поломку навсегда (§6.5).
 */
export function BrokenTemplatePlaque({
  broken,
  title,
  onConfigure,
}: {
  broken: BrokenTemplate;
  title: string;
  /** Не задан — показывать некуда (нет экрана, который умеет настройку): только текст. */
  onConfigure?: () => void;
}) {
  return (
    <Card role="alert" data-testid="broken-template" className="flex flex-col gap-2 border-danger">
      <p className="text-danger text-sm">
        Шаблон „{title}“ не разобран: {broken.reason}
      </p>
      {onConfigure !== undefined && (
        <div>
          <Button
            variant="outline"
            size="sm"
            aria-label={`Настроить шаблон „${title}“`}
            onClick={onConfigure}
          >
            Настроить шаблон
          </Button>
        </div>
      )}
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

/**
 * Реестр не приехал (§6.5): свой шаблон без него не проверить (§4.2 шаг 7 смотрит и блоки
 * запросов), поэтому запись показана шаблоном хоста — и человек знает почему.
 */
export function RegistryErrorPlaque() {
  return (
    <Card role="alert" data-testid="registry-error" className="border-danger">
      <p className="text-danger text-sm">Реестр не загрузился — запись показана шаблоном хоста.</p>
    </Card>
  );
}
