#!/usr/bin/env bun
// scripts/probe-p4.ts — ПРОБА П4 (§С9, приёмка §С8-12): чем Р14 обходится словарю владельца.
//
// Р14 разрешил модели заводить свои свойства (`property_create` со статусом `proposed`,
// §А2-7). Плата за это — разрастание словаря, и спека назвала ПОРОГ, за которым право
// сужается до «только существующие свойства + текст в body»:
//     >1 нового `proposed`/день устойчиво  ИЛИ  >20 % несведённых дублей.
// Проба меряет обе цифры на настоящем провайдере и настоящем конвейере. Решение о сужении
// принимает ВЛАДЕЛЕЦ: скрипт печатает вердикт, но Р14 не трогает.
//
// ЧТО ИМЕННО ГОНЯЕТСЯ. Корпус П1 (`docs/superpowers/specs/assets/2026-08-26-properties-reform/
// p1-tasks.json`, 20 сценариев пяти классов) прогоняется через `ai.sendMessage` — тот же вход,
// которым пользуется чат владельца, с тем же промптом и теми же тулами. Подменять его прямым
// вызовом `property_create` было бы измерением собственной фикстуры: вопрос П4 — не «работает
// ли тул», а «как часто модель РЕШАЕТ завести новое свойство вместо существующего».
//
// ПОЧЕМУ ЖИВОЙ ПРОВАЙДЕР ОБЯЗАТЕЛЕН. `EchoProvider` тулов не зовёт вовсе: на нём обе цифры
// вышли бы нулевыми, то есть проба «прошла бы» ничего не измерив. Без настоящего ключа скрипт
// выходит с кодом 2 и НЕ печатает вердикт.
//
// КОДЫ ВЫХОДА — их различает ТОТ, КТО ЗАПУСКАЕТ, и различать он должен без чтения исходника:
//   0 — измерено, порог не превышен;
//   2 — ЗАМЕР НЕ СОСТОЯЛСЯ: провайдера нет (нет ключа, echo, кривой ORBIS_LLM_PROVIDER) либо
//       корпус пройден не полностью;
//   3 — измерено, порог ПРЕВЫШЕН (решение владельца о сужении Р14);
//   1 — замер СЛОМАЛСЯ (БД, исключение внутри пробы).
//
// Скрипт одновременно и деливеребл, и модуль: `probe-p4.test.ts` импортирует чистую часть
// (выбор провайдера и разбор пар), поэтому сам прогон запускается только при прямом вызове.
//
// Запуск (из корня репозитория, `.env` подхватывается bun'ом):
//     bun scripts/probe-p4.ts
// Переменные: ORBIS_LLM_PROVIDER / OPENAI_API_KEY / ANTHROPIC_API_KEY — как у боевого сервера;
// DATABASE_URL — база, в которой проба заведёт СВОЕГО владельца (чужих данных не трогает).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { routineById } from '../apps/server/src/agent-loop/queries';
import { sendMessage } from '../apps/server/src/ai/send-message';
import { ensureGlobalThread } from '../apps/server/src/chat/threads';
import { makeDb } from '../apps/server/src/db/client';
import { withIdentity } from '../apps/server/src/db/with-identity';
import { type LLMProviderEnv, makeLLMProvider } from '../apps/server/src/llm/provider';
import type { LLMProvider } from '../apps/server/src/llm/types';
import { approvePending } from '../apps/server/src/policy/pending';
import { startBucketRun } from '../apps/server/src/routines/lifecycle';
import { runRoutineRun } from '../apps/server/src/routines/runner';
import { GARDENER_SLUG, GARDENER_TITLE, seedRoutineId } from '../apps/server/src/seed/gardener';
import { seedOwner } from '../apps/server/src/seed/onboarding';

// ---------------------------------------------------------------------------
// Пороги §С9 — литералами ЗДЕСЬ и нигде больше в скрипте: вердикт обязан читаться
// в одном месте вместе с числами, иначе «порог» превращается в разбросанные по коду
// сравнения, которые никто не пересчитает при правке спеки.
// ---------------------------------------------------------------------------
const THRESHOLD_PROPOSED_PER_DAY = 1;
const THRESHOLD_UNMERGED_SHARE = 0.2;

/**
 * Сколько обращений владельца в день считать «устойчивым» режимом.
 *
 * Корпус П1 — это 20 ОБРАЩЕНИЙ, а не 20 дней: перевод в «на день» требует допущения о
 * дневном объёме, и допущение это НЕ ИЗОБРЕТАЕТСЯ здесь. Скрипт печатает удельную цифру
 * («proposed на обращение») и таблицу переводов по этому ряду — владелец видит, при какой
 * его интенсивности порог начинает превышаться, и решает по своему настоящему объёму.
 */
const DAILY_VOLUMES = [1, 2, 3, 5, 10, 20] as const;

/** Порог лексической мерки, ниже которого пара дублем не считается (см. `duplicatePairs`). */
export const SIMILARITY_THRESHOLD = 0.5;

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
  /** Оба конца — свои строки владельца. Садовник их сводит; по ним считается порог §С9. */
  own: Pair[];
  /** Один конец встроенный (`orbis/…`). Садовник бессилен по устройству — это сигнал о Р14. */
  vsBuiltin: Pair[];
}

/**
 * Осознанный обрыв пробы с УЖЕ выбранным кодом выхода — в отличие от исключения, которое
 * означает сбой самой пробы (код 1). Отдельный класс, а не флаг: `catch` обязан различать
 * «мы решили не мерить» и «у нас сломалось», иначе неполный корпус доложится как баг скрипта.
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
// 2. Кандидаты в дубли
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
 * КАНДИДАТЫ В ДУБЛИ ПО НАЗВАННОЙ ЛЕКСИЧЕСКОЙ МЕРКЕ, РАЗДЕЛЁННЫЕ НА ДВА РОДА (рулинг Р-17-4).
 *
 * Мерка: доля общих основ (первые 4 символа слов длиной ≥ 3) в «подпись + описание» пары
 * ≥ `SIMILARITY_THRESHOLD`. Она заведомо груба — но ВОСПРОИЗВОДИМА и печатается парами, так
 * что каждую цифру можно проверить глазами в выводе. «Умная» мерка (спросить ту же модель,
 * дубль ли это) сделала бы пробу измерением самой себя.
 *
 * СЛОВАРЬ СРАВНЕНИЯ — ЭФФЕКТИВНЫЙ (свои ∪ встроенные), А ЦИФРЫ — ДВЕ. Самый веский довод
 * «сужать Р14» выглядит так: модель завела `user/усилие` при живом `orbis/effort`, то есть
 * продублировала СИСТЕМНОЕ свойство вместо того, чтобы им воспользоваться. Мерка, глядящая
 * только на свои строки, этот случай не видит вовсе — а он и есть тот, ради которого замер
 * заводили. Но и в одну цифру оба рода сливать нельзя: садовник до `orbis/`-конца дотянуться
 * НЕ МОЖЕТ (адрес встроенного → `system-object` → отказ по объекту, `policy/confirmation.ts`),
 * и общая «доля несведённых» смешала бы «садовник плохо сработал» с «садовник бессилен по
 * устройству» — порог §С9 проваливался бы всегда при единственном таком дубле.
 *
 * Поэтому:
 *  • `own` — оба конца свои. ЭТО работа садовника, и ТОЛЬКО по ним считается порог «>20 %».
 *  • `vsBuiltin` — один конец встроенный. Печатается отдельной строкой с пометкой, что
 *    садовник их не сводит; сигнал не о нём, а о Р14.
 *
 * ЧТО НЕ СЧИТАЕТСЯ ВОВСЕ: пары «встроенное против встроенного». Они не про Р14 ни одним
 * концом (их завёл не владелец и не модель), а лексически их в реестре много — попав в
 * знаменатель, они утопили бы обе цифры. Поглощённые (`merged_into`) и `deprecated` строки
 * тоже вне игры: их в словаре больше нет.
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
  return split;
}

// ---------------------------------------------------------------------------
// 3. Прогон
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
  if (!Array.isArray(corpus) || corpus.length === 0) {
    console.error(`probe-p4: корпус пуст: ${CORPUS_PATH}`);
    return 1;
  }

  const { db, client } = makeDb({ max: 3 });
  const owner = crypto.randomUUID();

  /**
   * ЭФФЕКТИВНЫЙ словарь владельца: свои строки ∪ встроенные (Р-17-4). Предикат тот же, что
   * у `loadRegistryRows`; своё подмножество отбирается уже в памяти — второй запрос за теми
   * же строками разошёлся бы с первым молча.
   */
  const effectiveDictionary = async (): Promise<PropertyRow[]> =>
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
    await seedOwner(db, owner);
    const threadId = await withIdentity(db, owner, (tx) => ensureGlobalThread(tx, owner));

    const deps = { provider, model: provider.modelId };
    let failed = 0;
    for (const task of corpus) {
      const before = ownOf(await effectiveDictionary()).length;
      try {
        await sendMessage(db, deps, { ownerId: owner, id: newId(), threadId, content: task.text });
      } catch (e) {
        failed += 1;
        console.error(
          `  #${task.n} (${task.class}): СБОЙ — ${e instanceof Error ? e.message : String(e)}`,
        );
        continue;
      }
      const after = ownOf(await effectiveDictionary()).length;
      console.log(
        `  #${task.n} (${task.class}): +${after - before} свойств — ${task.text.slice(0, 60)}…`,
      );
    }

    // НЕПОЛНЫЙ КОРПУС — НЕ ЗАМЕР, и вердикт по нему не печатается. Проба блокирующая
    // (§С8-12), а её цифры удельные: недосчитанный сценарий занижает обе разом, и «порог не
    // превышен» на восемнадцати из двадцати обращений — это не «прошли», а «не мерили».
    // Живьём это уже случалось: у провайдера кончились кредиты на девятнадцатом сценарии.
    if (failed > 0) {
      console.error('');
      console.error(
        `probe-p4: корпус пройден не полностью — ${failed} из ${corpus.length} сценариев упали.`,
      );
      console.error('Удельные цифры П4 по неполному корпусу занижены; вердикт не печатается.');
      console.error('Почините провайдера (кредиты, лимиты, сеть) и повторите прогон целиком.');
      throw new ProbeAbort(2);
    }

    const dictBefore = await effectiveDictionary();
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
    if (!started.started) throw new Error(`прогон садовника не заведён: ${started.reason}`);
    const routine = await withIdentity(db, owner, (tx) => routineById(tx, routineId));
    if (routine === null) throw new Error('садовник не найден — сид не отработал');
    // `clock` у RoutineDeps ОБЯЗАТЕЛЕН, и забыть его здесь можно молча: каталог `scripts/`
    // не входит в `include` ни одного tsconfig, то есть `bun run typecheck` этот файл не
    // видит. Первый прогон пробы упал ровно на этом — `deps.clock is not a function`.
    const end = await runRoutineRun(
      { db, provider, model: provider.modelId, clock },
      { ownerId: owner, routine, runId: started.runId, bucket },
    );
    console.log(
      `probe-p4: прогон садовника — ${end.outcome}${end.reason ? ` (${end.reason})` : ''}`,
    );

    // Владелец принимает то, что садовник отложил: «несведённые» считаются ПОСЛЕ разбора
    // пачки, иначе цифра мерила бы не работу садовника, а скорость владельца.
    const units = (await withIdentity(db, owner, (tx) =>
      tx.execute(sql`SELECT id, metadata FROM chat_messages
                      WHERE metadata @> ${JSON.stringify({ pending: { run_id: started.runId, kind: 'action' } })}::jsonb`),
    )) as unknown as Array<{ id: string; metadata: { pending: { tool?: string } } }>;
    let merged = 0;
    for (const unit of units) {
      if (unit.metadata.pending.tool !== 'property_merge') continue;
      const r = await approvePending(db, { ownerId: owner, pendingId: unit.id });
      if (r.ok) merged += 1;
      else console.error(`  единица ${unit.id}: не применена — ${r.error.code} ${r.error.message}`);
    }

    const pairsAfter = duplicatePairs(await effectiveDictionary());
    const unmergedShare =
      pairsBefore.own.length === 0 ? 0 : pairsAfter.own.length / pairsBefore.own.length;
    const perMessage = proposedCount / corpus.length;

    // ── Вердикт ───────────────────────────────────────────────────────────────
    console.log('');
    console.log('=== П4 (§С8-12) ===');
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

    console.log('');
    console.log('— дубли СВОИХ строк (их сводит садовник; по ним считается порог §С9) —');
    console.log(`до садовника: ${pairsBefore.own.length}`);
    for (const p of pairsBefore.own) console.log(`  «${p.a}» ~ «${p.b}» (${p.score.toFixed(2)})`);
    console.log(`садовник предложил слияний: ${units.length}, принято владельцем: ${merged}`);
    console.log(`после разбора пачки: ${pairsAfter.own.length}`);
    for (const p of pairsAfter.own) console.log(`  «${p.a}» ~ «${p.b}» (${p.score.toFixed(2)})`);
    console.log(`доля несведённых: ${(unmergedShare * 100).toFixed(1)} %`);

    console.log('');
    console.log('— дубли СВОЕГО против ВСТРОЕННОГО (садовник свести их НЕ МОЖЕТ) —');
    console.log(
      `${pairsAfter.vsBuiltin.length} шт. Это не оценка садовника: адрес orbis/… для фона — ` +
        'запрет по объекту (§С2-1), слияние отклоняется до постановки в пачку. Каждая такая',
    );
    console.log(
      'пара — модель завела своё свойство при живом системном, то есть сигнал о Р14, а не о нём.',
    );
    for (const p of pairsAfter.vsBuiltin) {
      console.log(`  «${p.a}» ~ «${p.b}» (${p.score.toFixed(2)})`);
    }

    const shareBreached = unmergedShare > THRESHOLD_UNMERGED_SHARE;
    // По второй половине порога вердикт ОДНОЗНАЧЕН; по первой — зависит от дневного объёма,
    // и однозначным его делает только владелец, назвав свой. Скрипт называет границу.
    const volumeAtBreach = perMessage > 0 ? THRESHOLD_PROPOSED_PER_DAY / perMessage : Infinity;
    console.log('');
    console.log(
      `порог «>1 proposed/день»: превышается начиная с ${
        Number.isFinite(volumeAtBreach)
          ? `${Math.ceil(volumeAtBreach + 1e-9)} обращений в день`
          : 'любого объёма (proposed не заводились)'
      }`,
    );
    console.log(
      `порог «>20 % несведённых дублей» (свои строки): ${shareBreached ? 'ПРЕВЫШЕН' : 'не превышен'} (${(unmergedShare * 100).toFixed(1)} %)`,
    );
    console.log('');
    if (shareBreached) {
      console.log('ВЕРДИКТ: порог §С9 превышен — решение о сужении Р14 принимает владелец.');
      exitCode = 3;
    } else {
      console.log(
        'ВЕРДИКТ: порог доли дублей не превышен; порог proposed/день — по объёму владельца выше.',
      );
    }
    if (pairsAfter.vsBuiltin.length > 0) {
      console.log(
        `ОТДЕЛЬНО ВЛАДЕЛЬЦУ: ${pairsAfter.vsBuiltin.length} дублей своего со встроенным. Порогом §С9 они не ` +
          'меряются и садовником не лечатся — это довод по существу Р14.',
      );
    }
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
