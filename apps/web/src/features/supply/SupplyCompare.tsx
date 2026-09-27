// Модуль ЛЕНИВЫЙ (грузится нажатием «Сравнить»): разбор тела страницы — баррель `@orbis/shared/doc`
// (схема Tiptap, ≈154 кБ gzip), и в первый кадр экрана записи или настроек он ехать не должен
// (сторожа `check-lazy-chunks.ts`, `save.test.tsx`).
import { parseBody } from '@orbis/shared/doc';
import { diffBodyDocs } from '@orbis/shared/doc/diff';
import { etalonOf } from '@orbis/shared/supply';
import { parsePagePrint } from '@orbis/shared/supply/print';
import { useMemo } from 'react';
import { refIdsKey } from '../../lib/registry/ref-clean';
import { trpc } from '../../trpc';
import { Dialog } from '../../ui/Dialog';
import { BODY_DIFF_SKIP_NOTES, BodyDiffUnits } from '../chat/cards/BodyDiff';
import { lineDiff } from './line-diff';
import { COMPARE, type SupplyUpdate, supplyTitleOf } from './useSupply';

/** Подпись сторон — одна на оба рода записи. */
export const COMPARE_LEGEND = 'Зачёркнуто — сейчас у вас, выделено — в поставке.';

/**
 * «Сравнить» (срез 1б §9.1 п. 2): ДВУСТОРОННЕЕ сравнение записи с новым эталоном — дифф Ш1, слияние
 * трёх сторон — позже. Стороны — `recordText` и `etalonText` из `supply.updates`, а не тело записи из
 * кеша и не эталон кода: канон тела считает только сервер, и шаблон хоста в графе ≠ сырому эталону
 * байт-в-байт (перенос из ревью задачи 11) — сравнение «кеш против кода» показало бы шум канона как
 * правку.
 *
 * Страница — блочный дифф тела со сравнением по словам (`@orbis/shared/doc/diff`) и строка
 * заголовка, если он разный. Приложение — построчно по канонической печати (`printAppProps`), id
 * записей показаны их заголовками.
 */
export function SupplyCompare({ update, onClose }: { update: SupplyUpdate; onClose: () => void }) {
  const app = etalonOf(update.key).kind === 'app';
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`${COMPARE}: ${supplyTitleOf(update.key)}`}
    >
      <div data-testid="supply-compare" className="flex flex-col gap-3 pt-2 text-sm">
        <p className="text-xs text-text-muted">{COMPARE_LEGEND}</p>
        {app ? (
          <AppCompare before={update.recordText ?? ''} after={update.etalonText} />
        ) : (
          <PageCompare before={update.recordText ?? ''} after={update.etalonText} />
        )}
      </div>
    </Dialog>
  );
}

/** Печать страницы, которую не разобрать, — пустая страница с текстом как есть (показ, не запись). */
function pagePrintOf(text: string): { title: string; emoji: string | null; body: string } {
  try {
    return parsePagePrint(text);
  } catch {
    return { title: '', emoji: null, body: text };
  }
}

function PageCompare({ before, after }: { before: string; after: string }) {
  const a = useMemo(() => pagePrintOf(before), [before]);
  const b = useMemo(() => pagePrintOf(after), [after]);
  const diff = useMemo(() => diffBodyDocs(parseBody(a.body).doc, parseBody(b.body).doc), [a, b]);
  const head = (p: { title: string; emoji: string | null }) =>
    p.emoji === null ? p.title : `${p.emoji} ${p.title}`;
  return (
    <>
      {head(a) !== head(b) && (
        <p data-testid="supply-compare-title" className="flex flex-wrap gap-x-1">
          Заголовок:
          <span className="text-text-muted line-through">{head(a)}</span>
          <span aria-hidden>→</span>
          <span className="text-accent">{head(b)}</span>
        </p>
      )}
      {'units' in diff ? (
        <BodyDiffUnits units={diff.units} />
      ) : (
        <>
          <p className="text-xs text-text-muted">{BODY_DIFF_SKIP_NOTES[diff.skipped]}</p>
          <SideText label="Сейчас у вас" text={a.body} />
          <SideText label="В поставке" text={b.body} />
        </>
      )}
    </>
  );
}

function SideText({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-text-secondary">{label}</span>
      <pre className="whitespace-pre-wrap rounded-control bg-surface-2 p-2 text-xs">{text}</pre>
    </div>
  );
}

const noCommas = (text: string) => text.replace(/,$/gm, '');

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

const LINE_CLASS = {
  same: 'text-text-muted',
  removed: 'text-text-muted line-through',
  added: 'text-accent',
} as const;

function AppCompare({ before, after }: { before: string; after: string }) {
  // Запятые JSON в конце строк — не содержимое: без них последний раздел, за которым владелец
  // дописал свой, читался бы «убран и добавлен заново».
  const lines = useMemo(() => lineDiff(noCommas(before), noCommas(after)), [before, after]);
  const ids = useMemo(
    () => refIdsKey([...(before.match(UUID_RE) ?? []), ...(after.match(UUID_RE) ?? [])]),
    [before, after],
  );
  const refs = trpc.entity.resolveRefs.useQuery({ ids }, { enabled: ids.length > 0 });
  const names = useMemo(
    () =>
      new Map(
        (refs.data ?? []).map((r) => [
          r.id,
          `«${r.title || r.id}»${r.archived ? ' (в архиве)' : ''}`,
        ]),
      ),
    [refs.data],
  );
  return (
    <ul data-testid="supply-compare-lines" className="flex flex-col font-mono text-xs">
      {lines.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: порядок строк печати жёсткий, тексты повторяются — место и есть личность строки
        <li key={i} data-kind={l.kind} className={`whitespace-pre-wrap ${LINE_CLASS[l.kind]}`}>
          {l.kind === 'removed' ? '− ' : l.kind === 'added' ? '+ ' : '  '}
          {l.text.replace(UUID_RE, (id) => names.get(id) ?? id)}
        </li>
      ))}
    </ul>
  );
}
