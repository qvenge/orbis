// Презентация различия тела предложения (Ш1.1): единицы показа списком и словарь причин,
// по которым различия нет.
//
// Своим модулем, а не куском ProposalCard.tsx, потому что потребителей ДВА и они в разных
// фичах: карточка в ленте треда (`features/chat`) и слой предложения на записи
// (`features/entity-detail`, Ш1.3). Импорт презентации из файла КОМПОНЕНТА чужой фичи
// работал бы, но читался бы как «слой зависит от карточки», а зависит он от общего показа —
// тексты владельцу обязаны совпадать дословно в ленте и на записи.
//
// Здесь ТОЛЬКО общее. Политика показа — что резать, сколько единиц оставить, считать ли
// счётчики — у каждого потребителя своя и живёт у него (`CollapsedBodyDiff` в карточке
// режет до трёх и выбрасывает `same`; слой на записи рисует всё, включая контекст).
//
// ВАЖНО ПРО ВЕС: модуль не импортирует НИЧЕГО из `@orbis/shared/doc` — типы выведены из
// `RouterOutputs`. Оба потребителя живут в эагерных чанках (лента чата и экран записи), и
// ребро на схему Tiptap стоило бы там +154 кБ gzip (страж `scripts/check-lazy-chunks.ts`).
import type { RouterOutputs } from '../../../trpc';

type ProposalView = NonNullable<RouterOutputs['routine']['proposal']>;
type Operation = ProposalView['operations'][number];
type BodyDiff = NonNullable<Operation['bodyDiff']>;
/** Единица показа диффа тела — блок документа в терминах `@orbis/shared/doc/diff`. */
export type DiffUnit = Extract<BodyDiff, { units: unknown }>['units'][number];
/** Почему различие не построено — ровно три причины сервера (`proposal-diff.ts`). */
export type BodyDiffSkipReason = Extract<BodyDiff, { skipped: unknown }>['skipped'];

/**
 * Почему различия тела нет — СЛОВАМИ (Ш1.1). Причины три, и они означают разное: у
 * `body_changed` предложение вдобавок предскажет `stale` на «Принять», у остальных двух
 * предложение живо и принимается целиком — не построилась только картинка.
 *
 * Отсутствие `bodyDiff` вовсе в этот словарь НЕ входит и пометки не даёт: «диффа нет» — это
 * не «дифф не построен», и лишняя строка под решённым предложением была бы шумом.
 *
 * Ключ — не `string`, а сам союз причин: серверные собратья этого словаря типизированы по
 * enum и падают СБОРКОЙ, когда причин становится больше, а `Record<string, string>` ронял бы
 * новую причину в запасной текст молча.
 */
export const BODY_DIFF_SKIP_NOTES: Record<BodyDiffSkipReason, string> = {
  body_changed: 'Тело изменилось после составления',
  too_large: 'Слишком большое тело — дифф не построен',
  rewritten: 'Тело переписано целиком — дифф не построен',
};

const PART_CLASS: Record<string, string> = {
  same: '',
  added: 'text-accent',
  removed: 'text-text-muted line-through',
};

/**
 * Единицы различия тела списком — по одной строке на блок документа.
 *
 * Что рисуется: `added` — только «стало», `removed` — только «было» зачёркнутым, `changed` —
 * внутриблочные куски (`parts`), а если их нет (блок длиннее потолка слов) — «было → стало»
 * целиком. `same` в списке остаётся серым: он не мусор, а контекст, по которому владелец
 * узнаёт место правки.
 *
 * Компонент рисует ВСЕ переданные единицы: фильтрацию и потолок делает вызывающий (в ленте
 * место у различия одно, на записи — весь экран).
 */
export function BodyDiffUnits({ units }: { units: readonly DiffUnit[] }) {
  return (
    <ul data-testid="proposal-body-diff" className="flex w-full flex-col gap-0.5">
      {units.map((unit, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: порядок единиц документный и жёсткий (diff.ts), тексты блоков повторяются — место в списке и есть личность единицы
        <li key={i} className="flex flex-wrap items-baseline gap-x-1">
          {unit.parts !== undefined ? (
            unit.parts.map((part, p) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: куски идут в порядке слов блока — место и есть личность куска
              <span key={p} className={PART_CLASS[part.kind]}>
                {part.text}
              </span>
            ))
          ) : (
            <>
              {unit.kind !== 'same' && unit.before !== undefined && (
                <span className="text-text-muted line-through">{unit.before}</span>
              )}
              {unit.kind === 'changed' && unit.after !== undefined && <span aria-hidden>→</span>}
              {unit.after !== undefined && (
                <span className={unit.kind === 'same' ? 'text-text-muted' : 'text-accent'}>
                  {unit.after}
                </span>
              )}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
