// Тексты «Пачки решений» (D42 §7), общие для ленты треда рутины и экрана прогона.
//
// Тем же рулингом контроллёра, что вынес тексты предложения в `proposal-text.ts`: мест показа
// у одной единицы ДВА — карточка в ленте (`QuestionCard`/`DeferredActionCard` по
// `metadata.cards`) и блок пачки на экране прогона, — и владелец ходит между ними. Одно
// событие обязано называться там одним и тем же словом: «снят следующим прогоном», «устарело»,
// «принято». Две копии этих строк разошлись бы на первой же правке текста.
//
// Здесь только ТЕКСТ — без JSX и без политики показа: что сворачивать, что прятать и в каком
// порядке рисовать, каждое место решает само.
import { aspectLabel, fieldLabel } from '../../../lib/field-labels';
import type { RouterOutputs } from '../../../trpc';

/** Единица пачки С СУДЬБОЙ — ровно то, что отдаёт `routine.runUnits` (Р-10). */
export type RunUnitView = RouterOutputs['routine']['runUnits'][number];
export type UnitFate = RunUnitView['fate'];
/** Почему отказано; поле есть только у `fate:'rejected'`. */
export type UnitRejectReason = NonNullable<RunUnitView['reason']>;
/**
 * Судьба ОТКЛОНЁННОГО действия словами — по ПАРЕ `fate + reason`, а не по одному полю:
 * протухшее и снятое действие сервер записывает тем же `rejected` (контракт `RunUnit`), и без
 * причины владелец прочитал бы «отклонено» там, где он ничего не отклонял.
 *
 * Ключ — сам союз причин, а не `string`: серверный `REJECT_CONTENT` типизирован тем же союзом
 * и падает СБОРКОЙ на новой причине, а `Record<string, string>` ронял бы её в запасное
 * «отклонено» молча (приём `REPLACED_NOTES` предложения).
 *
 * Слова — ПРО ЕДИНИЦУ (С6 ревью спеки), а не серверные строки предложения: «Предложение
 * заменено новым прогоном» на отложенной архивации владелец прочитал бы как неправду.
 */
export const UNIT_REJECT_NOTES: Record<UnitRejectReason, string> = {
  owner: 'отклонено',
  stale: 'устарело',
  superseded: 'снято новым прогоном',
  edited: 'заменено правкой',
};

/** Вопрос погашен следующим прогоном (ОЧ.8) — ответа он больше не принимает (§14 В2). */
export const QUESTION_STALE_NOTE = 'снят следующим прогоном';

/**
 * Судьба единицы одним словом — для подписи «решать было нечего» (исход `already`, где сервер
 * отдаёт только `fate`, без причины). Record по союзу судеб: новая судьба упадёт сборкой.
 */
export const UNIT_FATE_NOTES: Record<UnitFate, string> = {
  open: 'ждёт решения',
  approved: 'принято',
  rejected: 'отклонено',
  answered: 'отвечен',
  stale: 'снят',
};

/**
 * Судьба ДЕЙСТВИЯ для строки-итога; `null` — единица ещё ждёт решения, итога у неё нет.
 *
 * Причина по умолчанию — `'owner'`, ровно как у сервера (`rejectedReason` роняет запись без
 * причины туда же): второе умолчание разъехалось бы с первым молча.
 */
export function actionFateNote(unit: Pick<RunUnitView, 'fate' | 'reason'>): string | null {
  if (unit.fate === 'open') return null;
  if (unit.fate === 'approved') return 'принято';
  if (unit.fate === 'rejected') return UNIT_REJECT_NOTES[unit.reason ?? 'owner'];
  // `answered`/`stale` у ДЕЙСТВИЯ не рождаются (контракт `RunUnit`: протухшее действие — это
  // `rejected` с причиной `stale`). Печатаем общее слово, а не молчим: молчание на
  // невозможном состоянии — это единица без подписи, то есть исчезнувшая для владельца.
  return UNIT_FATE_NOTES[unit.fate];
}

/**
 * Судьба ВОПРОСА для строки-итога; `null` — вопрос ещё открыт.
 *
 * Ответ печатается ЦЕЛИКОМ: строка-итог — всё, что увидит владелец, не разворачивавший
 * карточку, и «отвечен» без слов ответа не сообщает ему ничего.
 */
export function questionFateNote(unit: Pick<RunUnitView, 'fate' | 'answer'>): string | null {
  if (unit.fate === 'open') return null;
  if (unit.fate === 'answered') {
    // Ответ БЕЗ текста — сообщение ответа, написанное мимо процедуры (контракт `listRunUnits`)
    return unit.answer === undefined ? 'отвечен' : `ответ: «${unit.answer}»`;
  }
  if (unit.fate === 'stale') return QUESTION_STALE_NOTE;
  // `approved`/`rejected` у вопроса не рождаются — гейт рода отвергает обе кнопки (С7)
  return UNIT_FATE_NOTES[unit.fate];
}

/**
 * Подпись строки «было → станет». Поле аспекта — парой по-русски («Задача · статус»); поле
 * САМОЙ ЗАПИСИ (заголовок, метки, архив) — одним `fieldLabel`: аспекта у такой строки нет
 * вовсе, его не кладёт производитель (`snapshotDeferredUnit`), и выдуманный разделитель
 * «· » перед пустым местом читался бы как потерянное слово.
 */
export function unitRowLabel(row: { aspect?: string; field: string }): string {
  return row.aspect === undefined
    ? fieldLabel(row.field)
    : `${aspectLabel(row.aspect)} · ${fieldLabel(row.field)}`;
}
