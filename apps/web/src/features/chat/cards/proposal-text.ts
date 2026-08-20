// Тексты предложения рутины, общие для ленты и для записи (Ш1.3).
//
// Мест показа у одного предложения ДВА: карточка в ленте треда (`ProposalCard`) и слой на
// самой записи (`features/entity-detail/ProposalOverlay`). Владелец ходит между ними в обе
// стороны — из ленты по ссылке на запись и обратно, — и одно событие обязано называться там
// одним и тем же словом: «(не было)», «пусто», «Тело: запись изменилась…», «Заменено правкой
// владельца». Две копии этих строк разошлись бы на первой же правке текста, и человек читал
// бы два разных сообщения об одном.
//
// Тем же рулингом контроллёра, что вынес презентацию диффа в `BodyDiff.tsx`: сейчас это
// чистый перенос, после второго потребителя он дорожает. Здесь только ТЕКСТ — без JSX и без
// политики показа: что резать, что прятать и в каком порядке рисовать, каждое место решает
// само (лента режет дифф до трёх блоков, запись показывает весь).
import { aspectLabel, fieldLabel } from '../../../lib/field-labels';
import type { RouterOutputs } from '../../../trpc';

type ProposalView = NonNullable<RouterOutputs['routine']['proposal']>;
/** Строка предложения на экране: у одной операции их столько, сколько полей она правит. */
export type ProposalRow = ProposalView['operations'][number];
type DecideResult = RouterOutputs['routine']['decideProposal'];
/** Сырое расхождение предусловия — форма ответа `decideProposal` (не note-форма аспекта). */
export type Mismatch = Extract<DecideResult, { status: 'stale' }>['mismatches'][number];
/** Почему умерло предложение, по которому владелец решал (ответ `replaced`). */
export type ReplacedReason = Extract<DecideResult, { status: 'replaced' }>['reason'];

/**
 * Судьба АДРЕСОВАННОГО предложения в ответе `replaced` — по причине его отказа, а не по
 * статусу живого. Тексты зеркалят серверные (`policy/pending.ts` REJECT_CONTENT): владелец
 * читает ленту и карточку подряд, и два разных слова про одно событие читались бы как два
 * события.
 *
 * Ключ — сам союз причин, а не `string`: серверный REJECT_CONTENT типизирован по
 * `RejectReason` и падает СБОРКОЙ на новой причине, а `Record<string, string>` ронял бы её
 * в запасное «Заменено» молча.
 */
export const REPLACED_NOTES: Record<ReplacedReason, string> = {
  edited: 'Заменено правкой владельца',
  superseded: 'Заменено новым прогоном',
  stale: 'Устарело — состояние изменилось',
  owner: 'Отклонено',
};

/**
 * Значение поля строкой. Пустая строка и `null` — «пусто», а не пропуск: в правке они
 * означают снятие значения, и молчание о них читалось бы как «поле не тронуто».
 */
export function fmt(value: unknown): string {
  if (value === undefined) return '—';
  if (value === null) return 'пусто';
  if (typeof value === 'string') return value === '' ? 'пусто' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length === 0 ? 'пусто' : value.map(fmt).join(', ');
  return JSON.stringify(value);
}

/** «Было» из снятого предусловия: литерал `'absent'` — контракт сервера «поля не было». */
export function beforeText(value: unknown): string {
  return value === 'absent' ? '(не было)' : fmt(value);
}

/**
 * Подпись строки. Поле аспекта — по-русски (`orbis/task` + `due_date` → «Задача · срок»);
 * всё остальное (создание записи, связь, поля вне аспектов) — запасным текстом сервера: он
 * уже собран из тех же имён, а второй словарь на клиенте разошёлся бы с ним первой же схемой.
 */
export function rowLabel(op: ProposalRow): string {
  return op.aspect !== undefined && op.field !== undefined
    ? `${aspectLabel(op.aspect)} · ${fieldLabel(op.field)}`
    : op.summary;
}

/** Чего ждало предложение: список допустимых значений либо «поля не было». */
function expectedText(expected: Mismatch['expected']): string {
  return expected === 'absent' ? 'поля не было' : expected.map(fmt).join(' / ');
}

/**
 * Расхождение по ТЕЛУ сервер отдаёт с `aspect: ''`, `field: 'body'` (тело — вне аспектов), а
 * ожидали/сейчас у него — отметки `updated_at` строки: CAS тела сравнивает версии, а не текст.
 * Печатать владельцу два timestamp'а — значит показать ему то, что не читается; смысл один:
 * запись менялась после того, как рутина её видела.
 */
export function isBodyMismatch(m: { aspect: string; field: string }): boolean {
  return m.aspect === '' && m.field === 'body';
}

export const BODY_MISMATCH_TEXT = 'Тело: запись изменилась после составления предложения';

/** Строка разбора расхождения из ответа `decideProposal` (сырые значения). */
export function mismatchText(m: Mismatch): string {
  if (isBodyMismatch(m)) return BODY_MISMATCH_TEXT;
  return `${aspectLabel(m.aspect)} · ${fieldLabel(m.field)}: ожидали ${expectedText(m.expected)}, сейчас ${fmt(m.actual)}`;
}
