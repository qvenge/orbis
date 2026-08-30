#!/usr/bin/env bun
// scripts/probe-p4.ts — ПРОБА П4 (§С9, приёмка §С8-12): чем Р14 обходится словарю владельца.
//
// Р14 разрешил модели заводить свои свойства (`property_create` со статусом `proposed`,
// §А2-7). Плата за это — разрастание словаря, и спека назвала ПОРОГ, за которым право
// сужается до «только существующие свойства + текст в body»:
//     >1 нового `proposed`/день устойчиво  ИЛИ  >20 % несведённых дублей.
//
// ПЕРВУЮ ЦИФРУ СКРИПТ МЕРЯЕТ, ВТОРУЮ — ТОЛЬКО ПОКАЗЫВАЕТ (рулинг Р-17-5). Разница не в
// аккуратности, а в наличии эталона: «сколько свойств модель завела на обращение» —
// объективный счёт строк, а «сколько из них дубли» требует знать, что такое дубль. Эталона у
// нас нет (корпус не размечен), строковая эвристика измерена и негодна (её точность — ниже,
// в докблоке `duplicatePairs`), а блокирующий вердикт по мерке с неизвестной точностью хуже
// отсутствующего: владелец примет его за факт. Поэтому вторая цифра печатается СПИСКОМ пар и
// кода выхода не выставляет вовсе.
//
// ЧТО ИМЕННО ГОНЯЕТСЯ. Корпус П1 (`docs/superpowers/specs/assets/2026-08-26-properties-reform/
// p1-tasks.json`, 20 сценариев пяти классов) прогоняется через `ai.sendMessage` — тот же вход,
// которым пользуется чат владельца, с тем же промптом и теми же тулами. Подменять его прямым
// вызовом `property_create` было бы измерением собственной фикстуры: вопрос П4 — не «работает
// ли тул», а «как часто модель РЕШАЕТ завести новое свойство вместо существующего».
//
// ПОЧЕМУ ЖИВОЙ ПРОВАЙДЕР ОБЯЗАТЕЛЕН. `EchoProvider` тулов не зовёт вовсе: на нём обе цифры
// вышли бы нулевыми, то есть проба «прошла бы» ничего не измерив.
//
// КОДЫ ВЫХОДА — их различает ТОТ, КТО ЗАПУСКАЕТ, и различать он должен без чтения исходника:
//   0 — замер СОСТОЯЛСЯ; порог первой цифры не превышен (либо дневной объём не назван);
//   2 — ЗАМЕР НЕ СОСТОЯЛСЯ. Три способа: провайдера нет (нет ключа, echo, кривой
//       ORBIS_LLM_PROVIDER), корпус пройден не полностью, прогон садовника не довёл работу
//       до конца (см. `measurementUsable`);
//   3 — измерено, порог ПЕРВОЙ цифры превышен при названном дневном объёме;
//   1 — замер СЛОМАЛСЯ (БД, исключение внутри пробы).
// Кода «порог второй цифры превышен» НЕТ и быть не должно — см. Р-17-5 выше.
//
// Скрипт одновременно и деливеребл, и модуль: `probe-p4.test.ts` импортирует чистую часть
// (выбор провайдера, годность замера, разбор пар), поэтому сам прогон запускается только при
// прямом вызове.
//
// Запуск (из корня репозитория, `.env` подхватывается bun'ом):
//     bun scripts/probe-p4.ts
// Переменные: ORBIS_LLM_PROVIDER / OPENAI_API_KEY / ANTHROPIC_API_KEY — как у боевого сервера;
// DATABASE_URL — база, в которой проба заведёт СВОЕГО владельца (чужих данных не трогает);
// ORBIS_P4_MSGS_PER_DAY — дневной объём обращений владельца (не задан → вердикта по первой
// цифре нет, печатается только таблица переводов и граница превышения).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { routineById } from '../apps/server/src/agent-loop/queries';
import {
  LLM_REFUSAL_CODE,
  MAX_TOKENS_NOTE,
  type SendMessageResult,
  STEP_LIMIT_NOTE,
  sendMessage,
} from '../apps/server/src/ai/send-message';
import { ensureGlobalThread } from '../apps/server/src/chat/threads';
import { makeDb } from '../apps/server/src/db/client';
import { withIdentity } from '../apps/server/src/db/with-identity';
import { type LLMProviderEnv, makeLLMProvider } from '../apps/server/src/llm/provider';
import type { LLMProvider } from '../apps/server/src/llm/types';
import { approvePending } from '../apps/server/src/policy/pending';
import { startBucketRun } from '../apps/server/src/routines/lifecycle';
import { isReportTruncated, type RunEnd, runRoutineRun } from '../apps/server/src/routines/runner';
import { GARDENER_SLUG, GARDENER_TITLE, seedRoutineId } from '../apps/server/src/seed/gardener';
import { seedOwner } from '../apps/server/src/seed/onboarding';

/**
 * Порог ПЕРВОЙ цифры §С9 — литералом здесь и нигде больше: вердикт обязан читаться в одном
 * месте вместе с числом, иначе «порог» превращается в разбросанные по коду сравнения,
 * которые никто не пересчитает при правке спеки.
 *
 * Порога ВТОРОЙ цифры в коде нет намеренно (Р-17-5): по ней скрипт вердикта не выносит.
 */
const THRESHOLD_PROPOSED_PER_DAY = 1;

/**
 * Ряд дневных объёмов для таблицы переводов. Корпус П1 — это 20 ОБРАЩЕНИЙ, а не 20 дней:
 * перевод в «на день» требует допущения о дневном объёме, и допущение это НЕ ИЗОБРЕТАЕТСЯ
 * здесь. Владелец видит, при какой интенсивности порог начинает превышаться, и называет свою
 * через `ORBIS_P4_MSGS_PER_DAY` — только тогда появляется вердикт (код 3).
 */
const DAILY_VOLUMES = [1, 2, 3, 5, 10, 20] as const;

/** Порог лексической мерки, ниже которого пара в список кандидатов не попадает. */
export const SIMILARITY_THRESHOLD = 0.5;

/**
 * ИЗМЕРЕННАЯ ТОЧНОСТЬ ЛЕКСИЧЕСКОЙ МЕРКИ — обоснование того, почему вердикта по второй цифре
 * нет (Р-17-5). Текст печатается владельцу рядом со списком пар и потому живёт константой:
 * убрать его — значит выдать список за измерение, и это ловится тестом.
 *
 * Цифры получены прогоном `similarity` по ДЕЙСТВИТЕЛЬНОМУ встроенному реестру
 * (`BUILTIN_PROPERTY_META`, 77 строк) и воспроизводятся тестом, а не переписаны из чужого
 * отчёта.
 */
export const HEURISTIC_ACCURACY_NOTE = [
  'Мерка сходства — ЭВРИСТИКА, и её точность измерена, а не предположена: на встроенном',
  'реестре (77 свойств, 2926 пар) порог 0.5 пересекают 17 пар, и ВЕРНЫХ среди них 0 —',
  '«Иконка ~ Цвет», «Создана ~ Изменена», «Начало ~ Окончание». Поэтому список ниже — это',
  'КАНДИДАТЫ на глаз владельцу, а не измеренная доля дублей: решение «дубль или нет»',
  'принимает он, а скрипт вердикта по этой цифре не выносит и кода выхода ею не выставляет.',
].join('\n');

/**
 * СКОЛЬКО СЦЕНАРИЕВ В КОРПУСЕ П1. Проверяется, а не выводится из длины файла: цифры П4
 * удельные («на обращение»), и корпус другого размера даёт числа, НЕСРАВНИМЫЕ с П1 — а
 * сравнимость и есть весь смысл переноса корпуса в assets побайтно. Урезанный файл дал бы
 * «первую цифру» с тем же апломбом, что полный, и никто бы этого не заметил.
 */
const CORPUS_SIZE = 20;

interface CorpusTask {
  n: number;
  class: string;
  text: string;
}

/**
 * Строка реестра в объёме, нужном обеим цифрам. `owner_id` здесь ОБЯЗАТЕЛЕН и не декоративен:
 * по нему пара классифицируется в «своё против своего» или «своё против встроенного», а это
 * два РАЗНЫХ ответа порогу §С9 (рулинг Р-17-4, см. `duplicatePairs`).
 */
export interface PropertyRow {
  id: string;
  key: string;
  label: Record<string, string>;
  description: Record<string, string>;
  status: string;
  merged_into: string | null;
  owner_id: string | null;
}

export interface Pair {
  a: string;
  b: string;
  score: number;
}

/**
 * Пары-кандидаты, РАЗДЕЛЁННЫЕ по природе (рулинг Р-17-4). Одна цифра на оба рода была бы
 * ложью в обе стороны — разбор в докблоке `duplicatePairs`.
 */
export interface PairSplit {
  /** Оба конца — свои строки владельца. Их садовник в принципе может свести. */
  own: Pair[];
  /** Один конец встроенный (`orbis/…`). Садовник бессилен по устройству — сигнал о Р14. */
  vsBuiltin: Pair[];
}

/**
 * Осознанный обрыв пробы с УЖЕ выбранным кодом выхода — в отличие от исключения, которое
 * означает сбой самой пробы (код 1). Отдельный класс, а не флаг: `catch` обязан различать
 * «мы решили не мерить» и «у нас сломалось», иначе несостоявшийся замер доложится как баг.
 */
class ProbeAbort extends Error {
  constructor(readonly code: number) {
    super(`probe aborted with code ${code}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Живой провайдер — предусловие пробы, а не деталь запуска
// ---------------------------------------------------------------------------

export type ProviderChoice =
  | { kind: 'live'; provider: LLMProvider }
  | { kind: 'unavailable'; reason: string };

/**
 * Выбор провайдера, приведённый к ДВУМ исходам вместо трёх.
 *
 * `makeLLMProvider` отвечает на «нет ключа» двумя разными способами, и это правильно для
 * сервера, но губительно для кода выхода пробы: вне production без ключей она отдаёт
 * `EchoProvider` (fail-safe для dev), а при ЯВНОМ `ORBIS_LLM_PROVIDER='openai'|'anthropic'`
 * без соответствующего ключа — БРОСАЕТ. Боевой `.env` репозитория прописывает
 * `ORBIS_LLM_PROVIDER`, то есть живьём срабатывает именно вторая ветка: непойманное
 * исключение доехало бы до общего `catch` и дало код 1 — «замер сломался» вместо честного
 * «мерить нечем». Для того, кто запускает пробу после пополнения кредитов, это разные
 * новости, и различать их по исходнику он не должен.
 *
 * Обе ветки поэтому сводятся здесь к одному ответу `unavailable` с текстом причины.
 */
export function chooseProvider(env: LLMProviderEnv): ProviderChoice {
  let provider: LLMProvider;
  try {
    provider = makeLLMProvider(env);
  } catch (e) {
    return { kind: 'unavailable', reason: e instanceof Error ? e.message : String(e) };
  }
  if (provider.modelId === 'echo') {
    return {
      kind: 'unavailable',
      reason: 'выбран EchoProvider — он не зовёт инструменты вовсе, и обе цифры П4 вышли бы нулями',
    };
  }
  return { kind: 'live', provider };
}

// ---------------------------------------------------------------------------
// 2. Годность замера: прогон садовника довёл работу до конца?
// ---------------------------------------------------------------------------

export type Usable = { ok: true } | { ok: false; reason: string };

/** Прогон садовника в объёме, по которому судят о годности замера. */
export interface GardenerRun {
  report: string | undefined;
}

/**
 * ДОВЁЛ ЛИ САДОВНИК РАБОТУ ДО КОНЦА. Ответ решает, есть ли вообще замер, — и потому
 * спрашивается ЯВНО, а не выводится из того, что вызов вернулся без исключения.
 *
 * ЗАЧЕМ. Цикл рутины ловит сбой провайдера САМ и наружу не бросает (`routines/runner.ts`):
 * «кредиты кончились на садовнике» выглядит как обычный возврат `RunEnd`. Проба, которая
 * исход только печатала, шла дальше и считала по МЁРТВОМУ САДОВНИКУ. Ошибка при этом
 * ОДНОСТОРОННЯЯ — в сторону «сужать Р14». Сценарий не краевой: ровно так проба и умерла в
 * первый раз.
 *
 * ГОДЕН РОВНО ОДИН ИСХОД: `finished` без причины, с НЕПУСТЫМ и НЕОБРЕЗАННЫМ отчётом. Ниже —
 * ВСЕ способы, которыми «не годен» доходит до пробы, и чем каждый ловится; перечень собран по
 * возвратам, а не по тому, где удобно проверять.
 *
 *  1. `failed` (provider/deadline/limit/refusal/aborted/internal) — поле `outcome`.
 *  2. **`checkpoint` — ТОЖЕ несостоявшийся замер**, хотя для `act`-рутины исход штатный.
 *     Садовник остановился вопросом, не дойдя до конца словаря: часть дублей он не смотрел,
 *     и «сколько он не свёл» по такому прогону — домысел. Штатность говорит о рутине, а не о
 *     пробе: пробе нужен ПОЛНЫЙ обход, иначе знаменатель неполон.
 *  3. `finished` с `reason` — поле `reason` (сегодня такой формы нет; проверка fail-closed).
 *  4. Отчёт ПУСТ или отсутствует — прогон без текста и без вызовов ничего не измерил
 *     (`settle` пустой отчёт не пишет вовсе, поэтому сюда он приходит как `undefined`).
 *  5. **Отчёт ОБРЕЗАН (`isReportTruncated`) — не годен, и это fail-closed, а не педантизм.**
 *     `cap` в `settle` дописывает пометку обрыва в КОНЕЦ и режет ровно хвост: на отчёте
 *     длиннее потолка пометка теряется молча. Отличить «обрезанный без пометки» от
 *     «обрезанного с пометкой» нечем, поэтому обрезанный отчёт годным не считается вовсе.
 *     Спрашивается ПРАВИЛОМ, живущим рядом с резаком, а не сравнением с числом: условие
 *     выведено из устройства `cap` и при смене резака обязано меняться вместе с ним.
 *  6. Пометки `STEP_LIMIT_NOTE` / `MAX_TOKENS_NOTE` в тексте — единственный носитель обоих
 *     обрывов (см. долг ниже).
 *
 * ДОЛГ, НАЗВАННЫЙ ЧЕСТНО И НЕ ЗАКРЫТЫЙ ЗДЕСЬ: у ОБОИХ обрывов — и у потолка токенов, и у
 * лимита шагов — СТРУКТУРНОГО носителя в строке прогона нет. В режиме `act` обе ветки
 * возвращают голый `{outcome:'finished'}`, а в аспекте прогона поля исхода нет:
 *  • `orbis/step_count` НЕ ГОДИТСЯ и намеренно здесь не используется. Он растёт на каждый
 *    НЕТЕРМИНАЛЬНЫЙ ВЫЗОВ ТУЛА (`runner.ts` → `runAgentVerb('orbis_run_step')`), а
 *    `ROUTINE_MAX_STEPS` ограничивает обращения К ПРОВАЙДЕРУ — докблок самой константы
 *    говорит это прямым текстом («несколько tool_use одним ответом считаются ОДНИМ шагом»).
 *    Признак ошибается в ОБЕ стороны: здоровый прогон с 13 тулами в одном ответе дал бы
 *    «упёрся в лимит (13 из 12)» и заблокировал бы замер, а настоящий упор (12 ответов по
 *    одному тулу) дал бы `step_count = 11` и промолчал. Раунд 3 объявил его структурным
 *    исправлением — это была ошибка, и она снята вместе с проверкой;
 *  • `orbis/run_usage` тоже не годится: это `{input_tokens, output_tokens}`, СУММА по шагам,
 *    не равная `MAX_OUTPUT_TOKENS` ни необходимо, ни достаточно; счётчика обращений к
 *    провайдеру в прогоне нет вовсе (`requestCount` уходит в дневной `ai_usage`).
 * Оба обрыва поэтому ловятся ТЕКСТОМ (пункт 6) с fail-closed'ом по обрезке (пункт 5).
 * Настоящее лечение — поле исхода в аспекте прогона, то есть правка РАННЕРА и реестра, а не
 * пробы. Записано долгом координатору; за скоупом Задачи 17.
 */
export function measurementUsable(end: RunEnd, run: GardenerRun): Usable {
  if (end.outcome === 'checkpoint') {
    return {
      ok: false,
      reason:
        'садовник остановился вопросом (checkpoint) — словарь обойдён не весь, знаменатель неполон',
    };
  }
  if (end.outcome !== 'finished') {
    return {
      ok: false,
      reason: `прогон садовника — ${end.outcome} (${end.reason ?? 'без причины'})`,
    };
  }
  if (end.reason !== undefined) {
    return { ok: false, reason: `прогон садовника завершён с причиной «${end.reason}»` };
  }
  if (run.report === undefined || run.report.trim() === '') {
    return {
      ok: false,
      reason:
        'у прогона садовника пустой отчёт — прогон без текста и без вызовов ничего не измерил',
    };
  }
  if (isReportTruncated(run.report)) {
    return {
      ok: false,
      reason:
        'отчёт садовника обрезан резаком раннера — пометка обрыва живёт в хвосте, и отличить оборванный прогон от полного нечем',
    };
  }
  for (const [note, what] of [
    [STEP_LIMIT_NOTE, 'упёрся в лимит шагов'],
    [MAX_TOKENS_NOTE, 'оборван по потолку токенов'],
  ] as const) {
    if (run.report.includes(note)) {
      return { ok: false, reason: `прогон садовника ${what} — работа не доведена до конца` };
    }
  }
  return { ok: true };
}

/**
 * СОСТОЯЛСЯ ЛИ СЦЕНАРИЙ КОРПУСА — по ВОЗВРАТУ `ai.sendMessage`, а не по отсутствию исключения.
 *
 * ЗАЧЕМ. Бросает `sendMessage` ровно один класс — недоступность провайдера. Отказ модели,
 * потолок токенов и лимит шагов чата (`MAX_AGENT_STEPS`) возвращаются НОРМАЛЬНО, и
 * оборванный сценарий печатался как «+0 свойств», попадая в знаменатель 20. Это занижало
 * ЕДИНСТВЕННУЮ цифру, которая ещё выносит вердикт, — то есть ошибка односторонняя, теперь в
 * сторону «сужать не надо»: скрипт молча пропустил бы настоящую проблему.
 *
 * ВСЕ СПОСОБЫ, КОТОРЫМИ «НЕ СОСТОЯЛСЯ» ДОХОДИТ ДО ПРОБЫ:
 *  1. `{status:'processing'}` — цикл ведёт другой прогон, наш ход не исполнялся. СТРУКТУРНО.
 *  2. `replayed: true` — вернулся готовый ответ, цикл не гонялся вовсе. СТРУКТУРНО. С
 *     уникальным `newId()` недостижимо, и проверка стоит именно поэтому: fail-closed.
 *  3. Отказ модели — `error_card` с кодом `LLM_REFUSAL` в `metadata.cards` ответа.
 *     СТРУКТУРНО, и код здесь РАЗЛИЧАЕТ: карточку с любым другим кодом кладёт неудачный
 *     вызов тула (`send-message.ts`), а это законное поведение модели, которое проба и
 *     меряет, — ошибиться значило бы выбросить половину корпуса.
 *  4. Потолок токенов и лимит шагов чата — пометками в `assistantMessage.content`. Носитель
 *     ТЕКСТОВЫЙ, и это названо вслух; но в отличие от отчёта прогона он НЕ ОБРЕЗАЕТСЯ:
 *     чатовый путь пишет `content` в колонку без `cap`, пометка дописывается в конец и
 *     доезжает целиком. Структурного носителя у этих двух исходов нет — та же дыра, что у
 *     `max_tokens` садовника, и лечится она там же, в источнике.
 */
export function scenarioUsable(result: SendMessageResult): Usable {
  if ('status' in result) {
    return { ok: false, reason: 'ответ ещё готовится (processing) — ход не исполнялся' };
  }
  if (result.replayed) {
    return { ok: false, reason: 'вернулся готовый ответ (replayed) — цикл модели не гонялся' };
  }
  const cards = (result.assistantMessage.metadata as { cards?: unknown }).cards;
  if (Array.isArray(cards)) {
    for (const card of cards) {
      if (
        typeof card === 'object' &&
        card !== null &&
        (card as { kind?: unknown }).kind === 'error_card' &&
        (card as { code?: unknown }).code === LLM_REFUSAL_CODE
      ) {
        return { ok: false, reason: `модель отказалась отвечать (${LLM_REFUSAL_CODE})` };
      }
    }
  }
  for (const [note, what] of [
    [STEP_LIMIT_NOTE, 'упёрся в лимит шагов чата'],
    [MAX_TOKENS_NOTE, 'оборван по потолку токенов'],
  ] as const) {
    if (result.assistantMessage.content.includes(note)) {
      return { ok: false, reason: `ход ${what} — сценарий не доведён до конца` };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 3. Кандидаты в дубли
// ---------------------------------------------------------------------------

const ru = (t: Record<string, string>): string => t.ru ?? t.en ?? Object.values(t)[0] ?? '';

/** Основы слов: без слов короче трёх букв, по первым четырём символам. */
export function stems(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(' ')
      .filter((w) => w.length >= 3)
      .map((w) => w.slice(0, 4)),
  );
}

/** Доля общих основ в меньшем из двух наборов; 0, если сравнивать нечего. */
export function similarity(a: string, b: string): number {
  const [sa, sb] = [stems(a), stems(b)];
  if (sa.size === 0 || sb.size === 0) return 0;
  let common = 0;
  for (const s of sa) if (sb.has(s)) common += 1;
  return common / Math.min(sa.size, sb.size);
}

/**
 * КАНДИДАТЫ В ДУБЛИ, РАЗДЕЛЁННЫЕ НА ДВА РОДА (рулинг Р-17-4) — СПИСОК ВЛАДЕЛЬЦУ, А НЕ ЦИФРА
 * ПРИЁМКИ (рулинг Р-17-5).
 *
 * ЧТО СЧИТАЕТСЯ. Мерка: доля общих основ (первые 4 символа слов длиной ≥ 3) в «подпись +
 * описание» пары ≥ `SIMILARITY_THRESHOLD`.
 *
 * НАСКОЛЬКО ОНА ТОЧНА — ИЗМЕРЕНО, А НЕ ПРЕДПОЛОЖЕНО. Прогон по действительному встроенному
 * реестру (77 свойств, 2926 пар): порог 0.5 пересекают 17 пар, ВЕРНЫХ СРЕДИ НИХ 0. Примеры
 * ложных: «Иконка ~ Цвет», «Вид текста ~ Заголовок», «Создана ~ Изменена», «Предложение ~
 * Режим». Шестнадцать из семнадцати дают РОВНО 0.50 — вырождение знаменателя
 * `min(|A|,|B|)`: на короткой подписи одной общей основы хватает, чтобы пересечь порог.
 * Сам порог 0.5 не обоснован нигде — ни в коде, ни в плане, ни в спеке (§А2-7 и §С9 про мерку
 * сходства молчат).
 *
 * ОТСЮДА Р-17-5. Ложная пара садовником (правильно) не сводится, попадает и в числитель, и в
 * знаменатель и тянет «долю несведённых» к 100 % — СИСТЕМАТИЧЕСКИ в сторону «сужать Р14». На
 * наблюдавшемся масштабе (2 своих свойства на 18 обращений) одной ложной пары хватало на
 * 100 % и код 3. Подбирать порог, пока цифра не станет приятной, — не измерение; поэтому
 * доля не считается вовсе, а печатается список пар со счётом, и решает владелец.
 *
 * СЛОВАРЬ СРАВНЕНИЯ — СВОИ ∪ ВСТРОЕННЫЕ, А СПИСКА ДВА. Самый веский довод «сужать Р14»
 * выглядит так: модель завела `user/усилие` при живом `orbis/effort`, то есть продублировала
 * СИСТЕМНОЕ свойство вместо того, чтобы им воспользоваться. Мерка, глядящая только на свои
 * строки, этот случай не видит вовсе. Но и в один список рода сливать нельзя: садовник до
 * `orbis/`-конца дотянуться НЕ МОЖЕТ (адрес встроенного → `system-object` → отказ по объекту,
 * `policy/confirmation.ts`), и общий список смешал бы «садовник не свёл» с «садовник бессилен
 * по устройству».
 *
 * ЧТО НЕ СЧИТАЕТСЯ ВОВСЕ: пары «встроенное против встроенного». Они не про Р14 ни одним
 * концом (их завёл не владелец и не модель), а лексически их в реестре много — попав в
 * список, они утопили бы обе группы (те самые 17 ложных пар). Поглощённые (`merged_into`) и
 * `deprecated` строки тоже вне игры: их в словаре больше нет.
 */
export function duplicatePairs(rows: readonly PropertyRow[]): PairSplit {
  const alive = rows.filter((r) => r.merged_into === null && r.status !== 'deprecated');
  const split: PairSplit = { own: [], vsBuiltin: [] };
  for (let i = 0; i < alive.length; i += 1) {
    for (let j = i + 1; j < alive.length; j += 1) {
      const x = alive[i];
      const y = alive[j];
      if (x === undefined || y === undefined) continue;
      const ownEnds = (x.owner_id === null ? 0 : 1) + (y.owner_id === null ? 0 : 1);
      if (ownEnds === 0) continue; // встроенное против встроенного — не про Р14
      const score = similarity(
        `${ru(x.label)} ${ru(x.description)}`,
        `${ru(y.label)} ${ru(y.description)}`,
      );
      if (score < SIMILARITY_THRESHOLD) continue;
      const pair: Pair = {
        a: `${ru(x.label)} (${x.key})`,
        b: `${ru(y.label)} (${y.key})`,
        score,
      };
      if (ownEnds === 2) split.own.push(pair);
      else split.vsBuiltin.push(pair);
    }
  }
  // По убыванию счёта: список читает человек, и самое похожее должно быть сверху.
  split.own.sort((p, q) => q.score - p.score);
  split.vsBuiltin.sort((p, q) => q.score - p.score);
  return split;
}

// ---------------------------------------------------------------------------
// 4. Прогон
// ---------------------------------------------------------------------------

const CORPUS_PATH = join(
  import.meta.dir,
  '..',
  'docs',
  'superpowers',
  'specs',
  'assets',
  '2026-08-26-properties-reform',
  'p1-tasks.json',
);

function printPairs(title: string, pairs: readonly Pair[]): void {
  console.log(`${title}: ${pairs.length}`);
  for (const p of pairs) console.log(`  ${p.score.toFixed(2)}  «${p.a}» ~ «${p.b}»`);
}

async function main(): Promise<number> {
  const choice = chooseProvider(process.env);
  if (choice.kind === 'unavailable') {
    console.error(`probe-p4: живого провайдера нет — ${choice.reason}.`);
    console.error('Замер не состоялся (это код 2, а не сбой пробы): мерить нечем.');
    console.error(
      "Задайте ключ (OPENAI_API_KEY либо ANTHROPIC_API_KEY) и ORBIS_LLM_PROVIDER='openai'|'anthropic'.",
    );
    return 2;
  }
  const provider = choice.provider;

  const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as CorpusTask[];
  if (!Array.isArray(corpus) || corpus.length !== CORPUS_SIZE) {
    console.error(
      `probe-p4: корпус не тот — ${Array.isArray(corpus) ? corpus.length : 'не массив'} сценариев вместо ${CORPUS_SIZE} (${CORPUS_PATH}).`,
    );
    console.error(
      'Замер не состоялся (это код 2, а не сбой пробы): удельные цифры по другому корпусу несравнимы с П1.',
    );
    return 2;
  }

  const { db, client } = makeDb({ max: 3 });
  const owner = crypto.randomUUID();

  /**
   * СЫРЫЕ строки реестра, видимые владельцу: свои ∪ встроенные. Именно «строки», а не
   * «эффективное определение» (§ `registry/load.ts`) — дельты (§А3-2) поверх них НЕ
   * накладываются, и слово «эффективный» здесь было бы зарезервированным именем, взятым
   * напрасно.
   *
   * КОГДА РАЗНИЦА СТАНЕТ НАСТОЯЩЕЙ: дельта с `targetKind: 'property'` подменяет `label` и
   * `description` свойства (`registry/deltas.ts`) — ровно те два поля, по которым здесь и
   * считается сходство. То есть переименованное владельцем свойство проба сравнивала бы под
   * СТАРОЙ подписью. Сегодня это недостижимо: единственный продовый писатель дельт кладёт
   * `targetKind: 'aspect'` (`registry/ops.ts`), а `property_update` по встроенному адресу
   * отказывает. Появится тул дельты свойства — этот запрос обязан переехать на
   * `effectiveRegistry`, и абзац перестаёт быть верным.
   */
  const dictionaryRows = async (): Promise<PropertyRow[]> =>
    (await withIdentity(db, owner, (tx) =>
      tx.execute(sql`SELECT id, owner_id::text AS owner_id, key, label, description, status,
                            merged_into
                       FROM property_definitions
                      WHERE owner_id IS NULL OR owner_id = ${owner}::uuid
                      ORDER BY created_at, id`),
    )) as unknown as PropertyRow[];
  const ownOf = (rows: readonly PropertyRow[]): PropertyRow[] =>
    rows.filter((r) => r.owner_id !== null);

  let exitCode = 0;
  try {
    console.log(`probe-p4: провайдер ${provider.modelId}, владелец пробы ${owner}`);
    const seeded = await seedOwner(db, owner);
    // Возврат сида тоже проверяется: владелец свежий, `seeded: false` означало бы, что
    // онбординг уже был, — то есть замер пошёл бы по чужому графу. Это КОД 2, а не 1:
    // «замер не состоялся», а не «проба сломалась», — та же граница, что у отсутствия ключа.
    if (!seeded.seeded) {
      console.error('probe-p4: сид владельца пробы вернул seeded: false — граф не наш.');
      console.error('Замер не состоялся (это код 2, а не сбой пробы).');
      throw new ProbeAbort(2);
    }
    const threadId = await withIdentity(db, owner, (tx) => ensureGlobalThread(tx, owner));

    const deps = { provider, model: provider.modelId };
    let failed = 0;
    for (const task of corpus) {
      const before = ownOf(await dictionaryRows()).length;
      let answer: SendMessageResult;
      try {
        answer = await sendMessage(db, deps, {
          ownerId: owner,
          id: newId(),
          threadId,
          content: task.text,
        });
      } catch (e) {
        failed += 1;
        console.error(
          `  #${task.n} (${task.class}): СБОЙ — ${e instanceof Error ? e.message : String(e)}`,
        );
        continue;
      }
      // Исключение — лишь ОДИН из способов не состояться; остальные приходят возвратом
      // (см. `scenarioUsable`). Оборванный сценарий в знаменатель не попадает.
      const scenario = scenarioUsable(answer);
      if (!scenario.ok) {
        failed += 1;
        console.error(`  #${task.n} (${task.class}): СЦЕНАРИЙ НЕ СОСТОЯЛСЯ — ${scenario.reason}`);
        continue;
      }
      const after = ownOf(await dictionaryRows()).length;
      console.log(
        `  #${task.n} (${task.class}): +${after - before} свойств — ${task.text.slice(0, 60)}…`,
      );
    }

    // НЕПОЛНЫЙ КОРПУС — НЕ ЗАМЕР, и вердикт по нему не печатается. Проба блокирующая
    // (§С8-12), а её цифры удельные: недосчитанный сценарий занижает их, и «порог не
    // превышен» на восемнадцати из двадцати обращений — это не «прошли», а «не мерили».
    // Живьём это уже случалось: у провайдера кончились кредиты на девятнадцатом сценарии.
    if (failed > 0) {
      console.error('');
      console.error(
        `probe-p4: корпус пройден не полностью — ${failed} из ${corpus.length} сценариев упали.`,
      );
      console.error('Замер не состоялся (это код 2, а не сбой пробы): вердикт не печатается.');
      console.error('Почините провайдера (кредиты, лимиты, сеть) и повторите прогон целиком.');
      throw new ProbeAbort(2);
    }

    const dictBefore = await dictionaryRows();
    const ownBefore = ownOf(dictBefore);
    const proposedCount = ownBefore.filter((r) => r.status === 'proposed').length;
    const pairsBefore = duplicatePairs(dictBefore);

    // ── Прогон садовника: он и есть механизм, которым дубли сводятся ──────────
    const clock = () => new Date();
    const routineId = seedRoutineId(owner, GARDENER_SLUG);
    const bucket = new Date().toISOString().slice(0, 16);
    const started = await startBucketRun(
      { db, provider, model: provider.modelId, clock },
      { ownerId: owner, routine: { id: routineId, title: GARDENER_TITLE }, bucket },
    );
    // Оба исхода — того же класса, что сид выше: мерить нечем, а не сломалось.
    if (!started.started) {
      console.error(`probe-p4: прогон садовника не заведён — ${started.reason}.`);
      console.error('Замер не состоялся (это код 2, а не сбой пробы).');
      throw new ProbeAbort(2);
    }
    const routine = await withIdentity(db, owner, (tx) => routineById(tx, routineId));
    if (routine === null) {
      console.error('probe-p4: садовник не найден — сид не отработал.');
      console.error('Замер не состоялся (это код 2, а не сбой пробы).');
      throw new ProbeAbort(2);
    }
    // `clock` у RoutineDeps ОБЯЗАТЕЛЕН, и забыть его здесь можно молча: каталог `scripts/`
    // не входит в `include` ни одного tsconfig, то есть `bun run typecheck` этот файл не
    // видит. Первый прогон пробы упал ровно на этом — `deps.clock is not a function`.
    const end = await runRoutineRun(
      { db, provider, model: provider.modelId, clock },
      { ownerId: owner, routine, runId: started.runId, bucket },
    );
    const runRows = (await withIdentity(db, owner, (tx) =>
      tx.execute(sql`SELECT props ->> 'orbis/run_report' AS report FROM entities
                      WHERE id = ${started.runId}::uuid`),
    )) as unknown as Array<{ report: string | null }>;
    const usable = measurementUsable(end, { report: runRows[0]?.report ?? undefined });
    console.log(
      `probe-p4: прогон садовника — ${end.outcome}${end.reason ? ` (${end.reason})` : ''}`,
    );
    // ИСХОД ПРОВЕРЯЕТСЯ, А НЕ ПЕЧАТАЕТСЯ: разбор — в докблоке `measurementUsable`. Без этой
    // ветки мёртвый садовник давал «0 сведённых» и вердикт из воздуха.
    if (!usable.ok) {
      console.error('');
      console.error(`probe-p4: ${usable.reason}.`);
      console.error('Замер не состоялся (это код 2, а не сбой пробы): вердикт не печатается.');
      throw new ProbeAbort(2);
    }

    // Владелец принимает то, что садовник отложил: список «после» строится ПОСЛЕ разбора
    // пачки, иначе он показывал бы не работу садовника, а скорость владельца.
    const units = (await withIdentity(db, owner, (tx) =>
      tx.execute(sql`SELECT id, metadata FROM chat_messages
                      WHERE metadata @> ${JSON.stringify({ pending: { run_id: started.runId, kind: 'action' } })}::jsonb`),
    )) as unknown as Array<{ id: string; metadata: { pending: { tool?: string } } }>;
    // Считаются СЛИЯНИЯ, а не единицы вообще: владельцу это цифра про садовника, и общий
    // счёт врал бы тем сильнее, чем больше в пачке единиц другого рода (вопросы, правки).
    const mergeUnits = units.filter((u) => u.metadata.pending.tool === 'property_merge');
    let merged = 0;
    for (const unit of mergeUnits) {
      const r = await approvePending(db, { ownerId: owner, pendingId: unit.id });
      if (r.ok) merged += 1;
      else console.error(`  единица ${unit.id}: не применена — ${r.error.code} ${r.error.message}`);
    }
    const pairsAfter = duplicatePairs(await dictionaryRows());

    // ── ЦИФРА ПЕРВАЯ: рост словаря. Объективна, эталона не требует ─────────────
    const perMessage = proposedCount / corpus.length;
    console.log('');
    console.log('=== П4 (§С8-12), цифра 1: рост словаря — ИЗМЕРЕНО ===');
    console.log(`сценариев корпуса: ${corpus.length}`);
    console.log(`своих свойств в словаре после корпуса: ${ownBefore.length}`);
    // Разбивка по статусу — не украшение: порог §С9 сформулирован про `proposed`, а тул
    // принимает и `active` («Заводя от себя, ставь proposed» — это ПРОСЬБА промпта, не гейт).
    // Словарь, выросший `active`-строками, растёт ровно так же, а `proposed`-счётчик молчит:
    // печатать надо оба числа, иначе порог можно «пройти», не заведя ни одного `proposed`.
    for (const status of ['proposed', 'active', 'deprecated']) {
      console.log(`  ${status}: ${ownBefore.filter((r) => r.status === status).length}`);
    }
    console.log(`удельно: ${perMessage.toFixed(2)} proposed на обращение владельца`);
    console.log(
      `удельно по ВСЕМ новым своим свойствам: ${(ownBefore.length / corpus.length).toFixed(2)} на обращение`,
    );
    console.log('перевод в «на день» (допущение о дневном объёме — не измерение):');
    for (const volume of DAILY_VOLUMES) {
      const perDay = perMessage * volume;
      const mark = perDay > THRESHOLD_PROPOSED_PER_DAY ? 'ПОРОГ ПРЕВЫШЕН' : 'в пределах';
      console.log(`  ${volume} обращений/день → ${perDay.toFixed(2)} proposed/день — ${mark}`);
    }
    const volumeAtBreach = perMessage > 0 ? THRESHOLD_PROPOSED_PER_DAY / perMessage : Infinity;
    console.log(
      `порог «>1 proposed/день» превышается начиная с ${
        Number.isFinite(volumeAtBreach)
          ? `${Math.ceil(volumeAtBreach + 1e-9)} обращений в день`
          : 'любого объёма (proposed не заводились)'
      }`,
    );

    // ── ЦИФРА ВТОРАЯ: кандидаты в дубли. СПИСОК, а не вердикт (Р-17-5) ────────
    console.log('');
    console.log('=== П4, цифра 2: кандидаты в дубли — СПИСОК ВЛАДЕЛЬЦУ, НЕ ВЕРДИКТ ===');
    console.log(HEURISTIC_ACCURACY_NOTE);
    console.log(
      `Масштаб к тому же мал: своих свойств ${ownBefore.length}, и доля в процентах при таком ` +
        'знаменателе принимала бы всего два-три значения (0/50/100 %) — точность была бы мнимой.',
    );
    console.log('');
    console.log('— пары СВОИХ строк (их садовник в принципе может свести) —');
    printPairs('  до садовника', pairsBefore.own);
    console.log(
      `  садовник предложил слияний: ${mergeUnits.length}, принято владельцем: ${merged}` +
        (units.length > mergeUnits.length
          ? ` (всего единиц в пачке прогона: ${units.length})`
          : ''),
    );
    printPairs('  после разбора пачки', pairsAfter.own);
    console.log('');
    console.log('— пары СВОЕГО против ВСТРОЕННОГО (садовник свести их НЕ МОЖЕТ) —');
    console.log(
      '  Адрес orbis/… для фона — запрет по объекту (§С2-1): слияние отклоняется до постановки',
    );
    console.log('  в пачку. Каждая подтверждённая владельцем пара — довод по существу Р14.');
    printPairs('  всего', pairsAfter.vsBuiltin);

    // ── Вердикт: ТОЛЬКО по первой цифре и ТОЛЬКО при названном объёме ─────────
    console.log('');
    const declared = Number(process.env.ORBIS_P4_MSGS_PER_DAY);
    if (!Number.isFinite(declared) || declared <= 0) {
      console.log(
        'ВЕРДИКТ НЕ ВЫНЕСЕН: дневной объём обращений не назван (ORBIS_P4_MSGS_PER_DAY). ' +
          'Первая цифра измерена, порог по ней считается от объёма — назовите его, и вердикт появится.',
      );
    } else {
      const perDay = perMessage * declared;
      if (perDay > THRESHOLD_PROPOSED_PER_DAY) {
        console.log(
          `ВЕРДИКТ: при ${declared} обращениях/день это ${perDay.toFixed(2)} proposed/день — ` +
            'порог §С9 ПРЕВЫШЕН. Решение о сужении Р14 принимает владелец.',
        );
        exitCode = 3;
      } else {
        console.log(
          `ВЕРДИКТ: при ${declared} обращениях/день это ${perDay.toFixed(2)} proposed/день — ` +
            'порог §С9 по первой цифре не превышен.',
        );
      }
    }
    console.log(
      'По второй цифре вердикта нет и кода выхода она не выставляет (Р-17-5) — решает владелец по списку.',
    );
  } catch (e) {
    if (e instanceof ProbeAbort) exitCode = e.code;
    else {
      console.error('probe-p4: сбой пробы —', e);
      exitCode = 1;
    }
  } finally {
    await client.end();
  }
  return exitCode;
}

if (import.meta.main) {
  process.exit(await main());
}
