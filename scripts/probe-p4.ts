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
// КОДЫ ВЫХОДА: 0 — измерено, порог не превышен; 2 — нет живого провайдера (нечего мерить);
// 3 — измерено, порог ПРЕВЫШЕН (решение владельца о сужении Р14); 1 — сбой самой пробы.
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
import { makeLLMProvider } from '../apps/server/src/llm/provider';
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

interface CorpusTask {
  n: number;
  class: string;
  text: string;
}

interface PropertyRow {
  id: string;
  key: string;
  label: Record<string, string>;
  description: Record<string, string>;
  status: string;
  merged_into: string | null;
}

function fail(message: string): never {
  console.error(`probe-p4: ${message}`);
  process.exit(1);
}

/**
 * Осознанный обрыв пробы с УЖЕ выставленным кодом выхода — в отличие от исключения, которое
 * означает сбой самой пробы (код 1). Отдельный класс, а не флаг: `catch` обязан различать
 * «мы решили не мерить» и «у нас сломалось», иначе неполный корпус доложится как баг скрипта.
 */
class ProbeAbort extends Error {}

// ---------------------------------------------------------------------------
// 1. Живой провайдер — предусловие пробы, а не деталь запуска
// ---------------------------------------------------------------------------
const provider = makeLLMProvider(process.env);
if (provider.modelId === 'echo') {
  console.error('probe-p4: живого провайдера нет — выбран EchoProvider.');
  console.error(
    'Он не зовёт инструменты вовсе: обе цифры П4 вышли бы нулями, и проба «прошла бы», ничего не измерив.',
  );
  console.error(
    "Задайте ключ (OPENAI_API_KEY либо ANTHROPIC_API_KEY) и ORBIS_LLM_PROVIDER='openai'|'anthropic'.",
  );
  process.exit(2);
}

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
const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as CorpusTask[];
if (!Array.isArray(corpus) || corpus.length === 0) fail(`корпус пуст: ${CORPUS_PATH}`);

const { db, client } = makeDb({ max: 3 });

/** Строки СЛОВАРЯ владельца — источник обеих цифр; встроенные в него не входят (они не растут). */
async function ownDictionary(ownerId: string): Promise<PropertyRow[]> {
  return (await withIdentity(db, ownerId, (tx) =>
    tx.execute(sql`SELECT id, key, label, description, status, merged_into
                     FROM property_definitions
                    WHERE owner_id = ${ownerId}::uuid
                    ORDER BY created_at, id`),
  )) as unknown as PropertyRow[];
}

const ru = (t: Record<string, string>): string => t.ru ?? t.en ?? Object.values(t)[0] ?? '';

/**
 * КАНДИДАТЫ В ДУБЛИ — по НАЗВАННОЙ лексической мерке, а не «на глаз».
 *
 * Мерка: доля общих слов (по 4-символьным основам, без слов короче трёх букв) в подписи и
 * описании пары ≥ 0.5. Она заведомо груба — но она ВОСПРОИЗВОДИМА и печатается парами, так
 * что каждую цифру можно проверить глазами в выводе. Скрытая «умная» мерка (спросить ту же
 * модель, дубль ли это) сделала бы пробу измерением самой себя.
 *
 * Пары строятся по ВСЕМУ видимому словарю: дубль бывает и «своё против своего», и «своё
 * против встроенного» (сценарии класса А корпуса — ровно про второе).
 */
function stems(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(' ')
      .filter((w) => w.length >= 3)
      .map((w) => w.slice(0, 4)),
  );
}

function similarity(a: string, b: string): number {
  const [sa, sb] = [stems(a), stems(b)];
  if (sa.size === 0 || sb.size === 0) return 0;
  let common = 0;
  for (const s of sa) if (sb.has(s)) common += 1;
  return common / Math.min(sa.size, sb.size);
}

interface Pair {
  a: string;
  b: string;
  score: number;
}

function duplicatePairs(rows: PropertyRow[]): Pair[] {
  const alive = rows.filter((r) => r.merged_into === null && r.status !== 'deprecated');
  const out: Pair[] = [];
  for (let i = 0; i < alive.length; i += 1) {
    for (let j = i + 1; j < alive.length; j += 1) {
      const x = alive[i];
      const y = alive[j];
      if (x === undefined || y === undefined) continue;
      const score = similarity(
        `${ru(x.label)} ${ru(x.description)}`,
        `${ru(y.label)} ${ru(y.description)}`,
      );
      if (score >= 0.5)
        out.push({ a: `${ru(x.label)} (${x.key})`, b: `${ru(y.label)} (${y.key})`, score });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. Прогон
// ---------------------------------------------------------------------------
const owner = crypto.randomUUID();
let exitCode = 0;
try {
  console.log(`probe-p4: провайдер ${provider.modelId}, владелец пробы ${owner}`);
  await seedOwner(db, owner);
  const threadId = await withIdentity(db, owner, (tx) => ensureGlobalThread(tx, owner));

  const deps = { provider, model: provider.modelId };
  let failed = 0;
  for (const task of corpus) {
    const before = (await ownDictionary(owner)).length;
    try {
      await sendMessage(db, deps, {
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
    const after = (await ownDictionary(owner)).length;
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
    exitCode = 2;
    throw new ProbeAbort('корпус неполон');
  }

  const afterCorpus = await ownDictionary(owner);
  const proposedCount = afterCorpus.filter((r) => r.status === 'proposed').length;
  const pairsBefore = duplicatePairs(afterCorpus);

  // ── Прогон садовника: он и есть механизм, которым дубли сводятся ──────────
  const clock = () => new Date();
  const routineId = seedRoutineId(owner, GARDENER_SLUG);
  const bucket = new Date().toISOString().slice(0, 16);
  const started = await startBucketRun(
    { db, provider, model: provider.modelId, clock },
    { ownerId: owner, routine: { id: routineId, title: GARDENER_TITLE }, bucket },
  );
  if (!started.started) fail(`прогон садовника не заведён: ${started.reason}`);
  const routine = await withIdentity(db, owner, (tx) => routineById(tx, routineId));
  if (routine === null) fail('садовник не найден — сид не отработал');
  // `clock` у RoutineDeps ОБЯЗАТЕЛЕН, и забыть его здесь можно молча: каталог `scripts/`
  // не входит в `include` ни одного tsconfig, то есть `bun run typecheck` этот файл не
  // видит. Первый прогон пробы упал ровно на этом — `deps.clock is not a function`.
  const end = await runRoutineRun(
    { db, provider, model: provider.modelId, clock },
    { ownerId: owner, routine, runId: started.runId, bucket },
  );
  console.log(`probe-p4: прогон садовника — ${end.outcome}${end.reason ? ` (${end.reason})` : ''}`);

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

  const pairsAfter = duplicatePairs(await ownDictionary(owner));
  const unmergedShare = pairsBefore.length === 0 ? 0 : pairsAfter.length / pairsBefore.length;
  const perMessage = proposedCount / corpus.length;

  // ── Вердикт ───────────────────────────────────────────────────────────────
  console.log('');
  console.log('=== П4 (§С8-12) ===');
  console.log(`сценариев корпуса: ${corpus.length}${failed > 0 ? ` (сбоев: ${failed})` : ''}`);
  console.log(`своих свойств в словаре после корпуса: ${afterCorpus.length}`);
  // Разбивка по статусу — не украшение: порог §С9 сформулирован про `proposed`, а тул
  // принимает и `active` («Заводя от себя, ставь proposed» — это ПРОСЬБА промпта, не гейт).
  // Словарь, выросший `active`-строками, растёт ровно так же, а `proposed`-счётчик молчит:
  // печатать надо оба числа, иначе порог можно «пройти», не заведя ни одного `proposed`.
  for (const status of ['proposed', 'active', 'deprecated']) {
    console.log(`  ${status}: ${afterCorpus.filter((r) => r.status === status).length}`);
  }
  console.log(`удельно: ${perMessage.toFixed(2)} proposed на обращение владельца`);
  console.log(
    `удельно по ВСЕМ новым своим свойствам: ${(afterCorpus.length / corpus.length).toFixed(2)} на обращение`,
  );
  console.log('перевод в «на день» (допущение о дневном объёме — не измерение):');
  for (const volume of DAILY_VOLUMES) {
    const perDay = perMessage * volume;
    const mark = perDay > THRESHOLD_PROPOSED_PER_DAY ? 'ПОРОГ ПРЕВЫШЕН' : 'в пределах';
    console.log(`  ${volume} обращений/день → ${perDay.toFixed(2)} proposed/день — ${mark}`);
  }
  console.log(`кандидатов в дубли до садовника: ${pairsBefore.length}`);
  for (const p of pairsBefore) console.log(`  «${p.a}» ~ «${p.b}» (${p.score.toFixed(2)})`);
  console.log(`садовник предложил слияний: ${units.length}, принято владельцем: ${merged}`);
  console.log(`кандидатов в дубли после разбора пачки: ${pairsAfter.length}`);
  for (const p of pairsAfter) console.log(`  «${p.a}» ~ «${p.b}» (${p.score.toFixed(2)})`);
  console.log(`доля несведённых дублей: ${(unmergedShare * 100).toFixed(1)} %`);

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
    `порог «>20 % несведённых дублей»: ${shareBreached ? 'ПРЕВЫШЕН' : 'не превышен'} (${(unmergedShare * 100).toFixed(1)} %)`,
  );
  if (shareBreached) {
    console.log('');
    console.log('ВЕРДИКТ: порог §С9 превышен — решение о сужении Р14 принимает владелец.');
    exitCode = 3;
  } else {
    console.log('');
    console.log(
      'ВЕРДИКТ: порог доли дублей не превышен; порог proposed/день — по объёму владельца выше.',
    );
  }
} catch (e) {
  if (!(e instanceof ProbeAbort)) {
    console.error('probe-p4: сбой пробы —', e);
    exitCode = 1;
  }
} finally {
  await client.end();
}
process.exit(exitCode);
