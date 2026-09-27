/**
 * Правило открытия записи с приложением в адресе (спека 1б §5.1–§5.3, §4.3, §7.4, §9.2) и память
 * выбора места. Продолжение `chooseTemplate` 1а: одна чистая функция на всех клиентов — ответ «в
 * какой рамке и чем показать запись» у экрана записи, меню «⋯» и будущего нативного клиента обязан
 * совпадать. Ни БД, ни React: вход — уже прочитанные записи-приложения и шаблоны.
 *
 * Функция тотальна по входу (Фокус ревью п. 3): адрес на выключенное, архивное, неизвестное или
 * «не-приложение» даёт хост и плашку, никогда пустоту или исключение.
 *
 * Шаги (A — приложение адреса, R — запись, P — места спора):
 * | шаг  | условие                                    | рамка                  | вид                          | плашка                  |
 * |------|--------------------------------------------|------------------------|------------------------------|-------------------------|
 * | Р-20 | R — включённое неархивное приложение       | —                      | —                            | `openApp` = его домашняя |
 * | Р-20 | R — оболочка хоста                         | —                      | —                            | `openApp` = домашняя хоста |
 * | 0    | A — оболочка хоста (id или ключ)           | как хост               |                              | нет; адрес нормализуется |
 * | 0    | A — `budget`                               | как хост               |                              | `reserved`              |
 * | 0    | A не найдено / не приложение               | как хост               |                              | `app-unknown`           |
 * | 0    | A выключено или в архиве                   | как хост               |                              | `app-off`               |
 * | Р-20 | R — выключенное или архивное приложение    | хост                   | шаблон владельца / хоста     | `app-off` R             |
 * | 1    | R — страница                               | дом (пуст — хост)      | своё тело                    | дом выкл. — `app-off`   |
 * | 2    | A — приложение, есть подходящий шаблон A   | A                      | шаблон A (правило 1а); все   | спор/сломан — во `view` |
 * |      |                                            |                        | сломаны — шаблон хоста       |                         |
 * | 3    | A — приложение, подходящего нет            | A                      | шаблон хоста                 | `no-view` (P без A)     |
 * | 4    | A — хост: P пусто                          | хост                   | шаблон владельца / хоста     | —                       |
 * | 4    | P = одно, или запомненный победитель       | это приложение         | его шаблон (правило 1а); все | спор/сломан — во `view` |
 * |      |                                            |                        | сломаны — шаблон хоста       |                         |
 * | 4    | P ≥ 2 без выбора                           | хост                   | шаблон владельца / хоста     | `place-dispute` (РП-20) |
 * Шаг 5 (не отрисовался даже шаблон хоста → базовый вид) — забота рендерера.
 *
 * «Подходящий шаблон» — слово 1а: набор ⊆ аспекты записи (`fitsSubject`). Сломанность P не меняет
 * (R-26): приложение, чьи подходящие шаблоны все сломаны, остаётся местом, а поломку показывает
 * правило 1а уже внутри выбранного приложения (шаблон хоста в его рамке + плашка сломанного). Иначе
 * запомненный выбор молча уходил бы к сопернику, и владелец не узнал бы ни о поломке, ни о том, что
 * его выбор перестал действовать.
 *
 * Почему хост вне спора мест (Р-28 п. 1): хост — не место «для таких записей», а то, что остаётся,
 * когда ни одно приложение не подходит. Шаблоны владельца с пустым домом — запасной вид хоста, а не
 * соперник приложений: иначе единственное приложение с видом для задач никогда не открывалось бы
 * «сразу», пока у владельца есть свой шаблон задач, а вопрос «где открывать» спрашивал бы о выборе
 * между приложением и «ничем». Поэтому и выбор «в пользу хоста» хранить не нужно (§5.3).
 *
 * `redirect` — место уточнено правилом (РП-21): экран заменяет адрес `/a/<рамка>/r/<id>`, не
 * добавляя шаг. Замены нет, когда рамка — хост из-за плашки шага 0 (выключено, резерв, неизвестно):
 * адрес держит плашку — «включить» обязано вернуть владельца в то самое приложение. Оболочка хоста в
 * адресе — синоним хоста, её адрес заменяется каноническим всегда.
 *
 * Плашки шага 0 при `redirect:true` (A выключено, а шаг 1 или 4 увёл в другое приложение — буква
 * §5.2: «дальше — как A = хост», «одно → сразу туда»; R-25) живут в решении, вызвавшем замену:
 * пересчёт для заменённого адреса их уже не даст. Показать их до следующего перехода — забота web
 * (`features/apps/useOpening.ts`); функция остаётся функцией адреса.
 */
import { PAGE_ASPECT } from '../constants';
import type { Address, AppRef } from '../nav/address';
import { HOST_SHELL_KEY, RESERVED_APP_KEYS } from '../supply/etalons';
import {
  type ChoiceSubject,
  chooseTemplate,
  fitsSubject,
  type TemplateCandidate,
  type TemplateChoice,
  winnerAmong,
} from './choose-template';

export interface AppInfo {
  id: string;
  supplyKey: string | null;
  title: string;
  disabled: boolean;
  archived: boolean;
  opensOver: readonly string[];
  createdAt: string;
}
export interface OpenInput {
  app: AppRef; // из адреса
  record: { id: string; aspects: readonly string[]; home: string | null };
  apps: readonly AppInfo[]; // все записи-приложения, кроме оболочки хоста; архивные и выключенные — тоже (для плашек)
  hostShellId: string | null; // id записи-оболочки хоста: `/a/<он>` и ссылка на него — хост
  templates: readonly TemplateCandidate[]; // templatesFromRows (с home, без шаблона хоста)
  isBroken: (templateId: string) => string | null;
}
export type OpenPlaque =
  | { kind: 'app-off'; appId: string; archived: boolean } // выключено — [включить], в архиве — [восстановить] (Э-20)
  | { kind: 'reserved'; key: 'budget' } // /a/budget — «придёт со следующим срезом», без «включить»
  | { kind: 'app-unknown'; ref: string } // приложение не найдено или не приложение: из адреса ИЛИ из «Дома» страницы
  | { kind: 'no-view'; appId: string; alternatives: readonly string[] } // шаг 3
  | { kind: 'place-dispute'; contenders: readonly string[] }; // шаг 4, ≥2 без выбора (РП-20)
export interface OpenDecision {
  frame: { kind: 'host' } | { kind: 'app'; id: string };
  view: TemplateChoice; // own-body | template | host (шаблон хоста)
  plaques: readonly OpenPlaque[];
  redirect: boolean; // место уточнено правилом (РП-21): экран заменяет адрес
  openApp?: Address; // R — запись-приложение: открыть его домашнюю (§7.4, Р-20); экран заменяет адрес
}

type Frame = OpenDecision['frame'];
const HOST_FRAME: Frame = { kind: 'host' };

/** Место в споре — только включённое неархивное приложение (§5.2 шаг 4, §5.3). */
const isLive = (a: AppInfo) => !a.disabled && !a.archived;

/** В архиве важнее, чем выключено: включение архивного приложения ничего не открыло бы (Э-20). */
const offPlaque = (a: AppInfo): OpenPlaque => ({
  kind: 'app-off',
  appId: a.id,
  archived: a.archived,
});

/**
 * Приложение по ссылке: id записи или ключ эталона поставки (адрес §7.1 допускает оба). Среди
 * нескольких с одним ключом — живое: архивная копия ключа не должна перехватывать адрес.
 */
function findApp(apps: readonly AppInfo[], ref: string): AppInfo | undefined {
  const byId = apps.find((a) => a.id === ref);
  if (byId !== undefined) return byId;
  const byKey = apps.filter((a) => a.supplyKey === ref);
  return byKey.find(isLive) ?? byKey[0];
}

/** Что адрес говорит о месте после шага 0: хост, его синоним, хост из-за плашки или приложение. */
type AddressPlace =
  | { kind: 'host' }
  | { kind: 'alias' } // оболочка хоста: хост, адрес нормализуется
  | { kind: 'fallback' } // шаг 0 с плашкой: хост, адрес держит плашку
  | { kind: 'app'; app: AppInfo };

function addressPlace(
  input: Pick<OpenInput, 'app' | 'apps' | 'hostShellId'>,
  plaques: OpenPlaque[],
): AddressPlace {
  if (input.app.kind === 'host') return { kind: 'host' };
  const ref = input.app.ref;
  if (ref === HOST_SHELL_KEY || (input.hostShellId !== null && ref === input.hostShellId)) {
    return { kind: 'alias' };
  }
  const reserved = RESERVED_APP_KEYS.find((k) => k === ref);
  if (reserved !== undefined) {
    plaques.push({ kind: 'reserved', key: reserved });
    return { kind: 'fallback' };
  }
  const a = findApp(input.apps, ref);
  if (a === undefined) {
    // Id обычной записи в списке приложений не встречается — «не-приложение» и «не найдено» одно.
    plaques.push({ kind: 'app-unknown', ref });
    return { kind: 'fallback' };
  }
  if (!isLive(a)) {
    plaques.push(offPlaque(a));
    return { kind: 'fallback' };
  }
  return { kind: 'app', app: a };
}

function redirectOf(frame: Frame, place: AddressPlace): boolean {
  switch (place.kind) {
    case 'alias':
      return true;
    case 'host':
    case 'fallback':
      return frame.kind === 'app';
    case 'app':
      return frame.kind !== 'app' || frame.id !== place.app.id;
  }
}

/**
 * Одна и та же плашка: одно приложение — одна плашка, даже если X — и A адреса, и дом страницы
 * (выключено или не найдено); резерв, «нет вида» в том же приложении и вопрос спора мест — по одному
 * на экран. Общая для правила и для web: плашки решения, вызвавшего замену адреса (R-25), web
 * сверяет с плашками нового решения этой же функцией — иначе одна плашка выходила дважды (гейт 20, I-2).
 */
export function samePlaque(a: OpenPlaque, b: OpenPlaque): boolean {
  if (a.kind === 'app-off' && b.kind === 'app-off') return a.appId === b.appId;
  if (a.kind === 'app-unknown' && b.kind === 'app-unknown') return a.ref === b.ref;
  if (a.kind === 'no-view' && b.kind === 'no-view') return a.appId === b.appId;
  return a.kind === b.kind && (a.kind === 'reserved' || a.kind === 'place-dispute');
}
function pushPlaque(plaques: OpenPlaque[], p: OpenPlaque): void {
  if (!plaques.some((q) => samePlaque(q, p))) plaques.push(p);
}

/** Шаблоны хоста — шаблоны владельца с пустым домом; «Дом» = оболочка хоста правило каталога запрещает, но читается как хост. */
const hostTemplates = (input: Omit<OpenInput, 'app'>) =>
  input.templates.filter((t) => t.home === null || t.home === input.hostShellId);
const templatesOf = (input: Omit<OpenInput, 'app'>, appId: string) =>
  input.templates.filter((t) => t.home === appId);

/**
 * P — включённые неархивные приложения с подходящим шаблоном (§5.2 шаг 4). Подходящий — набор ⊆
 * аспектов, без разбора тел (R-26, см. докблок модуля). Хоста в P нет (Р-28 п. 1) — и оболочки хоста
 * тоже, даже если вызывающий вопреки контракту передал её в `apps`: шаблоны с «Дом» = оболочка
 * читаются как шаблоны хоста. Порядок — по id: плашка и меню детерминированы.
 */
function placesOf(input: Omit<OpenInput, 'app'>, subject: ChoiceSubject): AppInfo[] {
  return input.apps
    .filter(
      (a) =>
        isLive(a) &&
        a.id !== input.hostShellId &&
        templatesOf(input, a.id).some((t) => fitsSubject(subject, t)),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Р-20: запись-приложение живая — открыть его домашнюю; оболочка хоста — домашнюю хоста. */
function appRecordTarget(
  input: Omit<OpenInput, 'app'>,
): { kind: 'shell' } | { kind: 'app'; app: AppInfo } | null {
  if (input.hostShellId !== null && input.record.id === input.hostShellId) return { kind: 'shell' };
  const self = input.apps.find((a) => a.id === input.record.id);
  return self === undefined ? null : { kind: 'app', app: self };
}

export function chooseOpening(input: OpenInput): OpenDecision {
  const isBroken = input.isBroken;
  const subject: ChoiceSubject = { aspects: input.record.aspects };

  // Перед шагами §5.2 — «R — запись-приложение» (Р-20): ссылка на приложение открывает приложение,
  // откуда бы ни пришли, — даже из выключенного A: адрес чужого места ссылку на живое не портит.
  const self = appRecordTarget(input);
  if (self?.kind === 'shell') {
    return {
      frame: HOST_FRAME,
      view: { kind: 'host', broken: [] },
      plaques: [],
      redirect: false,
      openApp: { kind: 'home', app: { kind: 'host' } },
    };
  }
  if (self?.kind === 'app' && isLive(self.app)) {
    return {
      frame: { kind: 'app', id: self.app.id },
      view: { kind: 'host', broken: [] },
      plaques: [],
      redirect: false,
      openApp: { kind: 'home', app: { kind: 'app', ref: self.app.id } },
    };
  }

  const plaques: OpenPlaque[] = [];
  // Шаг 0 — раньше шага 1: страница при выключенном A тоже несёт плашку A.
  const place = addressPlace(input, plaques);
  const done = (frame: Frame, view: TemplateChoice): OpenDecision => ({
    frame,
    view,
    plaques,
    redirect: redirectOf(frame, place),
  });
  const inHostView = () => chooseTemplate(subject, hostTemplates(input), isBroken);

  // Выключенное или архивное приложение — запись в хосте: владелец видит её и может включить.
  if (self?.kind === 'app') {
    pushPlaque(plaques, offPlaque(self.app));
    return done(HOST_FRAME, inHostView());
  }

  // Шаг 1: страница — своим телом в рамке своего дома, откуда бы ни пришли.
  if (input.record.aspects.includes(PAGE_ASPECT)) {
    const home = input.record.home;
    if (home === null || home === input.hostShellId) return done(HOST_FRAME, { kind: 'own-body' });
    const h = input.apps.find((a) => a.id === home);
    if (h === undefined) {
      pushPlaque(plaques, { kind: 'app-unknown', ref: home });
      return done(HOST_FRAME, { kind: 'own-body' });
    }
    if (!isLive(h)) {
      pushPlaque(plaques, offPlaque(h));
      return done(HOST_FRAME, { kind: 'own-body' });
    }
    return done({ kind: 'app', id: h.id }, { kind: 'own-body' });
  }

  if (place.kind === 'app') {
    // Шаг 2: внутри A — правило 1а по шаблонам A (чужие шаблоны и шаблоны владельца не участвуют).
    const a = place.app;
    const frame: Frame = { kind: 'app', id: a.id };
    const own = templatesOf(input, a.id);
    // Подходящий есть (пусть и сломанный) — это шаг 2: сломанность решает правило 1а внутри A
    // (следующий + плашка; нет целого — шаблон хоста в рамке A с `view.broken`), не шаг 3 (R-26).
    if (own.some((t) => fitsSubject(subject, t))) {
      return done(frame, chooseTemplate(subject, own, isBroken));
    }
    // Шаг 3: вида нет — шаблон хоста в рамке A и подсказка, где вид есть.
    const choice: TemplateChoice = { kind: 'host', broken: [] };
    const alternatives = placesOf(input, subject)
      .map((x) => x.id)
      .filter((id) => id !== a.id);
    plaques.push({ kind: 'no-view', appId: a.id, alternatives });
    return done(frame, choice);
  }

  // Шаг 4: A — хост (или стал им на шаге 0) — спор мест между приложениями.
  const p = placesOf(input, subject);
  if (p.length === 0) return done(HOST_FRAME, inHostView());
  const w = p.length === 1 ? (p[0] ?? null) : winnerAmong(p, (x) => x.opensOver);
  if (w !== null) {
    return done(
      { kind: 'app', id: w.id },
      chooseTemplate(subject, templatesOf(input, w.id), isBroken),
    );
  }
  plaques.push({ kind: 'place-dispute', contenders: p.map((x) => x.id) });
  return done(HOST_FRAME, inHostView());
}

/**
 * Шаг 0 для домашней приложения (`/a/<ref>`): записи ещё нет — правилу открытия нечего открывать, но
 * адрес на выключенное, архивное или «не-приложение» обязан дать хост и плашку, а не пустоту (Фокус
 * ревью п. 3). Те же ответы, что у шага 0 `chooseOpening`: одна копия разбора адреса.
 *  - `host` — адрес хоста; `alias` — оболочка хоста: хост, адрес нормализуется до `/`;
 *  - `app` — живое приложение (по id или ключу поставки) — его домашняя в его рамке;
 *  - `fallback` — хост и плашка; адрес держит плашку («включить» вернёт в то самое приложение).
 */
export type HomePlace =
  | { kind: 'host' }
  | { kind: 'alias' }
  | { kind: 'app'; id: string }
  | { kind: 'fallback'; plaque: OpenPlaque };

export function homePlaceOf(input: Pick<OpenInput, 'app' | 'apps' | 'hostShellId'>): HomePlace {
  const plaques: OpenPlaque[] = [];
  const place = addressPlace(input, plaques);
  switch (place.kind) {
    case 'host':
    case 'alias':
      return place;
    case 'app':
      return { kind: 'app', id: place.app.id };
    case 'fallback':
      return { kind: 'fallback', plaque: plaques[0] as OpenPlaque };
  }
}

/**
 * P (≥ 2) — для «Сменить, где открывать такие записи»; иначе null. Запомненный выбор спорящих не
 * отменяет (как `contendersOf` 1а): пункт меню есть и при сделанном выборе. У страницы и у
 * записи-приложения спора мест нет — их место решают шаг 1 и Р-20.
 */
export function placeContendersOf(input: Omit<OpenInput, 'app'>): readonly string[] | null {
  const p = openPlacesOf(input);
  return p.length > 1 ? p : null;
}

/**
 * P любой длины — для пунктов «⋯ → Открыть в [приложение]» (§5.4: «разово, для каждого приложения
 * из P»): у единственного места пункт тоже есть — из чужой рамки туда иначе не попасть. Тот же
 * порядок и тот же отбор, что у спора мест; у страницы и записи-приложения мест нет (шаг 1, Р-20).
 */
export function openPlacesOf(input: Omit<OpenInput, 'app'>): readonly string[] {
  if (input.record.aspects.includes(PAGE_ASPECT)) return [];
  if (appRecordTarget(input) !== null) return [];
  return placesOf(input, { aspects: input.record.aspects }).map((x) => x.id);
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Новые значения `orbis/app_opens_over` победителя и проигравших (§5.3) — зеркало
 * `recordDisputeChoice` 1а: победитель получает спорящих без себя, из списков проигравших
 * победитель вычищен; одна пачка — один Undo.
 *
 * Архивные и выключенные приложения вычищаются из всех списков: архивная цель `ref` отвергла бы всю
 * пачку («цель архивна»), а выключенное в спор не входит — его место в списке только сбило бы
 * будущий выбор. Сами они не правятся. В карту попадают только изменившиеся — повтор того же выбора
 * даёт пустую карту.
 *
 * Победитель не среди живых приложений (снят, выключен, заархивирован между показом вопроса и
 * ответом) — пустая карта, а не исключение: писать нечего, и вопрос при следующем открытии честно
 * повторится; экран записи не падает.
 */
export function recordPlaceChoice(
  winner: string,
  contenders: readonly string[],
  apps: readonly AppInfo[],
): ReadonlyMap<string, string[]> {
  const live = new Map(apps.filter(isLive).map((a) => [a.id, a]));
  const out = new Map<string, string[]>();
  const w = live.get(winner);
  if (w === undefined) return out;
  const keep = (self: string, ids: readonly string[]) => {
    const seen = new Set<string>();
    return ids.filter((id) => {
      if (id === self || !live.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  };
  const next = keep(winner, [...w.opensOver, ...contenders]);
  if (!sameList(next, w.opensOver)) out.set(winner, next);
  for (const id of contenders) {
    const c = live.get(id);
    if (c === undefined || id === winner) continue;
    const cleaned = keep(
      id,
      c.opensOver.filter((x) => x !== winner),
    );
    if (!sameList(cleaned, c.opensOver)) out.set(id, cleaned);
  }
  return out;
}
