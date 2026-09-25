import { PAGE_ASPECT } from '@orbis/shared';
import type { QueryAst } from '@orbis/shared/query';
import { useId, useState } from 'react';
import { aspectLabel } from '../../lib/registry/labels';
import { useRegistry } from '../../lib/registry/useRegistry';
import { type RouterOutputs, trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Skeleton } from '../../ui/Skeleton';
import { detailGetInput } from '../entity-detail/useEntityDetail';
import { PageView } from './PageView';
import { RecordView } from './RecordView';
import { templateForOf } from './TemplateBanner';

type EntityGetReply = RouterOutputs['entity']['get'];

/** Сколько подходящих записей предлагает выбор: последние изменённые — самые вероятные образцы. */
export const PREVIEW_CANDIDATES_LIMIT = 20;

/**
 * Подходящие записи шаблона (§9.3): у записи есть ВСЕ аспекты набора (как у выбора шаблона, §4.2),
 * последние изменённые — первыми. Черновику (без «Шаблон для») подходит любая запись. Деревом, а не
 * текстом: id аспектов в нём лежат как есть, разбора с реестром не нужно.
 */
export function previewCandidatesAst(forAspects: readonly string[]): QueryAst {
  return {
    filter: forAspects.length === 0 ? null : { and: forAspects.map((aspect) => ({ aspect })) },
    sortBy: [{ field: 'orbis/updated_at', dir: 'desc' }],
    limit: PREVIEW_CANDIDATES_LIMIT,
  };
}

/**
 * Шаблон на показ (спека страниц 1а §9.3): открытый шаблон — или черновик шаблона по пункту
 * «Предпросмотр на записи…» — показывается на выбранной записи, с плашкой «Шаблон для: проект ·
 * предпросмотр на: [запись ▾]».
 *
 * По умолчанию — последняя изменённая подходящая запись; подходящих нет — страница сама на себе
 * (`this` = она, `PageView`). Запись предпросмотра — СВОЙ `entity.get` (под ключом экрана записи):
 * это другая запись, не запись экрана, и данных её обвязки у экрана нет. Страницы в выбор не
 * попадают: их показывает своё тело, а не шаблон (§4.2 шаг 1).
 *
 * Тело записи в предпросмотре — только чтение (`readOnly`): запись взята для примера.
 *
 * Выбор держит снимок `{pageId, recordId}`: экран монтируется без key, и выбор, переживший переход
 * на соседнюю страницу, показал бы её шаблон на записи, выбранной для прежней.
 */
export function TemplatePreview({
  page,
  onClose,
}: {
  page: EntityGetReply;
  /** Закрыть предпросмотр черновика; у шаблона предпросмотр — его обычный показ, закрывать нечего. */
  onClose?: () => void;
}) {
  const { entity } = page;
  const forAspects = templateForOf(entity.props);
  const reg = useRegistry();
  const selectId = useId();
  const candidates = trpc.entity.query.useQuery({ ast: previewCandidatesAst(forAspects) });
  const rows = (candidates.data ?? []).filter(
    (r) => r.id !== entity.id && !r.aspects.includes(PAGE_ASPECT),
  );
  const [picked, setPicked] = useState<{ pageId: string; recordId: string } | null>(null);
  const chosen = picked?.pageId === entity.id ? picked.recordId : (rows[0]?.id ?? entity.id);
  // Пока подходящие едут, выбирать не из чего: страница сама на себе мелькнула бы и сменилась
  // записью. Отказ списка — не ожидание: показ идёт на самой странице.
  const waiting = candidates.data === undefined && !candidates.isError;
  const labels = forAspects.map((id) => aspectLabel(reg, id));

  return (
    <div className="flex flex-col gap-2">
      <Card
        role="note"
        data-testid="template-preview-plaque"
        className="mx-4 mt-3 flex flex-wrap items-center gap-2 border-dashed md:mx-6"
      >
        {/* Пробелы между кусками — явные: перевод строки в JSX пробела не даёт, и строка
            читалась бы «проект ·предпросмотр на:». */}
        <span className="text-sm text-text-secondary">
          Шаблон для: {labels.length === 0 ? '—' : labels.join(', ')} ·
        </span>{' '}
        <label htmlFor={selectId} className="text-sm text-text-secondary">
          предпросмотр на:
        </label>{' '}
        <select
          id={selectId}
          value={chosen}
          disabled={waiting}
          onChange={(e) => setPicked({ pageId: entity.id, recordId: e.target.value })}
          className="min-w-0 max-w-full rounded-control border border-line bg-surface px-2 py-1 text-sm"
        >
          {rows.map((r) => (
            <option key={r.id} value={r.id}>
              {r.title || r.id}
            </option>
          ))}
          <option value={entity.id}>сама страница</option>
        </select>
        {candidates.isError && (
          <span className="text-danger text-sm">подходящие записи не загрузились</span>
        )}
        {onClose !== undefined && (
          <Button variant="ghost" size="sm" onClick={onClose}>
            Закрыть предпросмотр
          </Button>
        )}
      </Card>
      {waiting ? (
        <div className="flex flex-col gap-4 px-4 pt-5 md:px-6">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-24" />
        </div>
      ) : chosen === entity.id ? (
        <PageView reply={page} />
      ) : (
        <PreviewOn recordId={chosen} template={entity} />
      )}
    </div>
  );
}

/** Шаблон на выбранной записи — её данными, телом только для чтения. */
function PreviewOn({
  recordId,
  template,
}: {
  recordId: string;
  template: Pick<EntityGetReply['entity'], 'id' | 'body'>;
}) {
  const get = trpc.entity.get.useQuery(detailGetInput(recordId));
  if (get.isError) {
    return (
      <p role="alert" className="px-4 pt-5 text-danger text-sm md:px-6">
        Запись для предпросмотра не загрузилась: {get.error.message}
      </p>
    );
  }
  if (get.data === undefined) {
    return (
      <div className="flex flex-col gap-4 px-4 pt-5 md:px-6">
        <Skeleton className="h-24" />
      </div>
    );
  }
  return (
    <RecordView reply={get.data} preview={{ id: template.id, body: template.body }} readOnlyBody />
  );
}
