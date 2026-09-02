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
import { BODY_NOTE_PROPERTY } from '@orbis/shared';
import { propertyIdOf, type RegistryLookup } from '../../../lib/registry/labels';
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
 * Инвариант 8 одним словом: это предложение рождено ПРАВКОЙ ВЛАДЕЛЬЦА, а не составлено
 * рутиной. Признак — не статус (его у правки нет и не будет), а происхождение: `editedFrom`.
 *
 * Строка ОБЩАЯ, потому что мест показа два и владелец ходит между ними: карточка в ленте
 * треда и плашка на записи. Хвост у каждого свой и остаётся у него — лента дописывает
 * «— исходное предложение выше» (оно там правда выше, соседним сообщением), а на записи
 * исходного нет вовсе: погашенное предложение из `proposalsForEntity` не приходит, и обещать
 * его значило бы послать владельца искать то, чего на экране нет.
 */
export const OWNER_EDIT_NOTE = 'Правка владельца';

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
 * Подпись строки предложения: подпись свойства из реестра, а если реестр этого адреса не
 * знает — запасной текст сервера (`summary`).
 *
 * Почему именно так, а не «сырой адрес». Строка предложения бывает трёх родов: правка
 * свойства (`field` — id свойства, §А1-1), правка поля записи (`title`, `tags`, `body`,
 * `emoji`) и операция без единой видимой правки (создание, связь) — у последней `field` нет
 * вовсе. У полей `body`/`tags`/`emoji` свойства в срезе А нет, зато `summary` сервера уже
 * несёт их русские имена (`CORE_FIELD_LABELS`), и печатать вместо «тело» слово `body` было
 * бы шагом назад. Поэтому запасной текст — не заглушка, а ответ для тех адресов, о которых
 * реестр молчит; своего словаря этих слов на клиенте по-прежнему нет.
 *
 * Ключ `aspect` у строки предложения сервер не пишет с Задачи 12 (`routines/lifecycle.ts`:
 * «строка на СВОЙСТВО, а не на пару»), поэтому прежней ветки с парой «Аспект · поле» здесь
 * больше нет — она была недостижима.
 */
export function rowLabel(reg: RegistryLookup, op: ProposalRow): string {
  const property = op.field === undefined ? undefined : propertyIdOf(reg, op.field);
  return property === undefined ? op.summary : propertyLabel(reg, property);
}

/** Чего ждало предложение: список допустимых значений либо «поля не было». */
function expectedText(expected: Mismatch['expected']): string {
  return expected === 'absent' ? 'поля не было' : expected.map(fmt).join(' / ');
}

/**
 * Расхождение по ТЕЛУ приезжает ФЛАГОМ `bodyChanged` (§А7-3, РП-10), а не пунктом списка: у
 * тела нет ни адреса в пространстве свойств, ни значения — его CAS сравнивает версии строки,
 * и печатать владельцу две отметки `updated_at` значило бы показать ему то, что не читается.
 * Смысл один: запись менялась после того, как рутина её видела.
 */
export const BODY_MISMATCH_TEXT = 'Тело: запись изменилась после составления предложения';

/** Расхождение, как оно лежит в аспекте прогона: по свойству (§А7-4) либо парой. */
export type ProposalNote =
  | { property: string; note: string }
  | { aspect: string; field: string; note: string };

/**
 * Подпись свойства: «Аспект-носитель · Свойство» либо одно имя, когда носителя нет.
 *
 * Носителя даёт РЕЕСТР (`carrierOf`), а не переходная карта старой формы, по которой пара
 * собиралась раньше: карта знает только тринадцать встроенных аспектов и умирает Задачей 23,
 * а у свойства владельца носителя в ней нет вовсе — и расхождение по нему читалось бы без
 * единого слова о том, где это поле живёт.
 *
 * Носителя нет у core-проекций (§А1-3: `orbis/archived` отложенной архивации) и у свободных
 * свойств владельца — тогда подпись одна (ровно как у строк отложенной единицы,
 * `unitRowLabel`). Прежде таким строкам подставлялся псевдо-аспект `orbis/entity` либо
 * пустая строка — два разных способа сказать «носителя нет», из которых один печатался
 * словом «Запись», а второй — пустым местом перед разделителем.
 *
 * Слитое свойство (В1) имеет двух носителей; берётся первый — от выбора зависит только слово
 * слева от точки, а не смысл строки.
 *
 * Свойства, которого в снимке нет вовсе (снято, реестр ещё едет), — короткое имя из его id:
 * `user/часы` читается как «часы», а не как машинный адрес с namespace.
 */
export function propertyLabel(reg: RegistryLookup, propertyId: string): string {
  const def = reg.property(propertyId);
  if (def === undefined) return propertyId.split('/').at(-1) ?? propertyId;
  const carrier = reg.carrierOf(def.id);
  return carrier === undefined
    ? reg.label(def.id)
    : `${reg.label(carrier.id)} · ${reg.label(def.id)}`;
}

/**
 * Свойство ноты — из ОБЕИХ форм. Новая — сразу id свойства (§А7-4). Прежняя пара
 * «аспект + поле» осталась в СХЕМЕ (её несут прогоны, записанные до реформы), но переводить
 * её больше нечем: таблица старых имён снята «Пересевом мира» вместе с формой данных.
 * Остаётся честная догадка `orbis/<поле>` — она и была последней веткой прежнего перевода,
 * и на слитых свойствах (`category_ref`) даёт тот же ответ, что таблица.
 */
function notePropertyOf(m: ProposalNote): string {
  if ('property' in m) return m.property;
  return `orbis/${m.field}`;
}

/**
 * Строка разбора из аспекта прогона (нота уже словами). Обе формы: свойство (§А7-4) и
 * прежняя пара «аспект + поле».
 */
export function noteText(reg: RegistryLookup, m: ProposalNote): string {
  const property = notePropertyOf(m);
  if (property === BODY_NOTE_PROPERTY) return BODY_MISMATCH_TEXT;
  return `${propertyLabel(reg, property)}: ${m.note}`;
}

/** Ключ строки списка — свойство: одно и то же расхождение в обеих формах даёт один ключ. */
export function noteKey(m: ProposalNote): string {
  return notePropertyOf(m);
}

/** Строка разбора расхождения из ответа `decideProposal` (сырые значения). */
export function mismatchText(reg: RegistryLookup, m: Mismatch): string {
  return `${propertyLabel(reg, m.property)}: ожидали ${expectedText(m.expected)}, сейчас ${fmt(m.actual)}`;
}

/** Готовая строка списка «что разошлось»: ключ React и текст владельцу. */
export type StaleRow = { key: string; text: string };

/**
 * Разбор ответа `stale` строками — ОБА вида расхождения в одном списке (§А7-3, РП-10).
 *
 * Функция общая для всех четырёх мест показа (карточка предложения, слой на записи, карточка
 * отложенного действия, сводка пачки) ровно потому, что тело приезжает ФЛАГОМ, а не пунктом:
 * место, забывшее его развернуть, показало бы владельцу «Устарело» с пустым списком под ним —
 * то есть отказ без единой причины. Одна функция превращает это в невозможное состояние.
 *
 * Тело идёт первой строкой: расхождения по свойствам и тело взаимоисключающи (отказ у
 * операции один), и порядок виден только в тесте — но фиксированный порядок дешевле
 * объяснимого.
 */
export function divergenceRows(
  reg: RegistryLookup,
  divergence: {
    mismatches: readonly Mismatch[];
    bodyChanged: boolean;
  },
): StaleRow[] {
  const rows: StaleRow[] = divergence.bodyChanged
    ? [{ key: BODY_NOTE_PROPERTY, text: BODY_MISMATCH_TEXT }]
    : [];
  for (const m of divergence.mismatches) {
    rows.push({ key: m.property, text: mismatchText(reg, m) });
  }
  return rows;
}
