// apps/server/src/routines/context.ts
// Контекст LLM-вызова прогона рутины (V1.5). От чатового (llm/context.ts) отличается
// ровно двумя вещами — и обе принципиальные:
//
//   1. СИСТЕМНЫЙ СЛОЙ СВОЙ (ROUTINE_SYSTEM_PROMPT + секция режима): у фонового прогона
//      нет собеседника, зато есть режим, белый список и терминальные глаголы. С промптом
//      чат-ассистента модель завершала бы цикл «ответом пользователю», которого никто не
//      прочтёт.
//   2. ВМЕСТО ЛЕНТЫ ТРЕДА — ИСТОРИЯ ПРОГОНОВ: что рутина предлагала, что владелец
//      решил, о чём спрашивала и что он ответил. Это единственный механизм обратной
//      связи в V1 (обучения правил нет — «Известные границы» спеки).
//
// Остальные слои — те же и теми же функциями (дата владельца, инструкции аспектов,
// память, якорь): разъехавшись, они дали бы «в фоне модель видит другой Orbis».
//
// Роль 'system' в messages ЗАПРЕЩЕНА (контракт провайдера — ai-sdk.ts бросает): и
// история, и «сработала рутина» едут как 'user'. Инвариант «messages начинается с user»
// здесь держится по построению — оба сообщения user.
import type { ProposalStatus, RunOutcome, RunSummary } from '@orbis/shared';
import type { RoutineProps } from '../agent-loop/queries';
import type { Tx } from '../db/with-identity';
import {
  anchorBlock,
  aspectInstructionsSection,
  loadMemory,
  MEMORY_SECTION_HEADER,
  memoryLine,
  todaySectionFor,
} from '../llm/context';
import { ROUTINE_SYSTEM_PROMPT, routineModeSection } from '../llm/prompts/routine-v2';
import type { LLMMessage } from '../llm/types';
import type { RejectReason } from '../policy/pending';
import { decisionsNoun } from './constants';

/**
 * Прошлый прогон в объёме, который читает модель.
 *
 * `run` — полная сводка (её же показывают экраны), а три поля рядом — проекции того, что
 * сводка держит вложенными объектами: статус предложения, текст ответа владельца и проза
 * объяснения. Проекции здесь не ради удобства рендера, а ради явности контракта: именно
 * эти три вещи и есть обратная связь V1, и сборщик истории обязан их заполнить
 * (routineHistory), а не оставить читателю догадываться, где они лежат.
 */
export interface RoutineHistoryItem {
  run: RunSummary;
  proposalStatus?: ProposalStatus;
  reply?: string;
  explanation?: string;
  /**
   * Единицы пачки прогона с их судьбами — не больше `MAX_RUN_UNITS` штук. Ключа НЕТ, если
   * единиц у прогона не было: пустой массив поменял бы форму элемента у прогонов до D42, а
   * их строка истории обязана остаться байт-в-байт прежней.
   *
   * Усечение считает сборщик (`routineHistory`), а не эта строка: он один знает, сколько
   * единиц было на самом деле.
   */
  units?: RoutineHistoryUnit[];
  /** Сколько единиц не поместилось под потолок; ключа нет, когда поместились все. */
  unitsOmitted?: number;
}

/**
 * Единица пачки в объёме, который читает модель, — проекция `RunUnit` (`policy/pending.ts`)
 * без того, что истории не нужно: id, payload'а действия, карточки, отметки времени.
 *
 * `text` — вопрос ЛИБО сводка действия («Архивация: «Прошлогодний отчёт»»), то есть ровно
 * то, что видел владелец. Полным, а не усечённым: потолок `HISTORY_TEXT_CAP` накладывает
 * печать (`quote`), одна на все тексты истории.
 *
 * `reason` тут не для полноты: подпись отклонённого ДЕЙСТВИЯ выводится из ПАРЫ
 * (`fate`, `reason`) — «отклонено» рутина обязана прочитать как «так не делай», а
 * «устарело»/«снято» — как «состояние ушло, попробуй заново». `fate:'stale'` у действий
 * недостижим (контракт `RunUnit`): протухшее действие — это `rejected` с причиной.
 */
export interface RoutineHistoryUnit {
  kind: 'question' | 'action';
  text: string;
  fate: 'open' | 'approved' | 'rejected' | 'answered' | 'stale';
  reason?: RejectReason; // fate:'rejected'
  answer?: string; // fate:'answered'
}

/** Рутина в объёме контекста: расписание и права — свойствами, задание — в теле (V1.1). */
export interface RoutineContextRoutine {
  id: string;
  title: string;
  body: string;
  props: RoutineProps;
}

export interface BuildRoutineContextInput {
  ownerId: string;
  routine: RoutineContextRoutine;
  run: { id: string; bucket: string };
  history: RoutineHistoryItem[];
  /** Часы прогона (§Б7-6-1) — те же, что у дедлайна и метеринга; по умолчанию системные. */
  clock?: () => Date;
}

export interface BuiltRoutineContext {
  system: string;
  messages: LLMMessage[];
}

/**
 * Потолок одного текста в сводке истории. Отчёт прогона по схеме — до 20000 символов, и
 * семь таких хвостов вытеснили бы из контекста саму инструкцию: истории нужен смысл
 * прошлого решения, а не его полный текст (полный лежит на экране прогона).
 */
const HISTORY_TEXT_CAP = 500;

/** Метки статуса предложения — человеческим языком, а не значением поля (его читает модель). */
const PROPOSAL_STATUS_LABEL: Record<ProposalStatus, string> = {
  pending: 'ждёт решения владельца',
  approved: 'владелец принял',
  rejected: 'владелец отклонил',
  superseded: 'заменено новым прогоном',
  stale: 'снято: состояние изменилось',
};

/**
 * Метки исходов прогона для строки истории.
 *
 * `Record<RunOutcome, …>` — ИСЧЕРПЫВАЮЩИЙ по вариантам свойства `orbis/run_outcome`: новый
 * вариант в словаре обязан ловиться КОМПИЛЯТОРОМ, а не рантаймом. С открытым
 * `Record<string, string>` пропущенный исход просто уезжал бы моделью в историю своим
 * ключом (`stale` вместо «вопрос снят…»), и заметить это было бы нечем.
 */
const OUTCOME_LABEL: Record<RunOutcome, string> = {
  running: 'идёт',
  checkpoint: 'задан вопрос, ответа нет',
  finished: 'завершён',
  abandoned: 'брошен',
  failed: 'сбой',
  answered: 'владелец ответил',
  stale: 'вопрос снят следующим прогоном',
};

/**
 * Схлопывание пробельных прогонов — тот же приём, что в llm/context.ts: данные графа
 * (отчёт, вопрос, ответ) попадают в сообщение, где структуру задают переводы строк, и
 * многострочный отчёт дописал бы в историю произвольные «строки списка».
 */
function flatten(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function preview(text: string, cap: number): string {
  const points = [...text];
  return points.length <= cap ? text : `${points.slice(0, cap).join('')}…`;
}

function quote(text: string): string {
  return `«${preview(flatten(text), HISTORY_TEXT_CAP)}»`;
}

/**
 * Судьба предложения человеческим языком. Отдельная функция, а не индекс в словаре,
 * потому что «принято» и «принято С ПРАВКАМИ» (Ш1.8) — разная обратная связь: первое
 * модель читает как «текст был верен» и повторит его слово в слово, второе — как «текст
 * пришлось переписать». Правка — не статус, а происхождение живого предложения
 * (`edited_from`), поэтому подпись подменяется здесь, а PROPOSAL_STATUS_LABEL остаётся
 * словарём ровно пяти статусов схемы.
 */
function proposalLabel(status: ProposalStatus, proposal: RunSummary['proposal']): string {
  return status === 'approved' && proposal?.edited_from !== undefined
    ? 'принято с правками владельца'
    : PROPOSAL_STATUS_LABEL[status];
}

/**
 * Подпись отклонённого ДЕЙСТВИЯ по причине отказа. Словарь, а не одно слово «отклонено»:
 * решение владельца и смерть единицы от времени — разная обратная связь, и склеенные они
 * останавливали бы рутину навсегда там, где надо было просто попробовать заново.
 *
 * `edited` для единицы недостижим: правку до принятия (Ш1.5) владелец делает над
 * ПРЕДЛОЖЕНИЕМ, а у предложения `kind` нет вовсе, и в пачку оно не попадает (Б5). Слово
 * стоит здесь потому, что `Record<RejectReason, …>` — способ узнать о пятой причине
 * сборкой, а не молчаливым «отклонено» в истории.
 */
const UNIT_REJECT_LABEL: Record<RejectReason, string> = {
  owner: 'отклонено',
  stale: 'устарело',
  superseded: 'снято',
  edited: 'заменено правкой',
};

/**
 * Одна единица пачки строкой. Глагол — от рода единицы («спрашивал» / «откладывал»),
 * подпись — от судьбы; у отклонённого действия она берётся из ПАРЫ (fate, reason).
 *
 * ОТКРЫТАЯ единица в хвосте истории — след НЕсработавшего гашения, а не обычное дело:
 * новый прогон гасит нерешённое прошлых прогонов ДО сборки контекста (`supersedeOpen`
 * зовётся раньше `routineHistory`, `runner.ts`), так что в норме открытых там нет. Но
 * гашение — гигиена и ничего не бросает: не прошло — единица доедет открытой, и назвать её
 * «отклонена» было бы враньём про решение, которого владелец не принимал.
 *
 * Комбинации, которых `listRunUnits` не порождает (вопрос с `approved`/`rejected`, действие
 * с `answered`/`stale`), падают в ветку «не решено». Отказывать здесь нечем и незачем:
 * функция печатает строку, а не решает судьбу, и уронить ею сборку контекста прогона
 * означало бы оставить утро без плана из-за подписи.
 */
function unitPart(unit: RoutineHistoryUnit): string {
  const text = quote(unit.text);
  if (unit.kind === 'question') {
    if (unit.fate === 'answered') {
      // Ответ БЕЗ текста — сообщение ответа, написанное мимо процедуры (`listRunUnits`
      // читает его как `answered` без `answer`): показать нечего, но выдать это за
      // «без ответа» нельзя — рутина спросила бы то же самое второй раз
      return unit.answer === undefined
        ? `спрашивал: ${text} — отвечено`
        : `спрашивал: ${text} — ответ: ${quote(unit.answer)}`;
    }
    return unit.fate === 'stale' ? `спрашивал: ${text} — снят` : `спрашивал: ${text} — без ответа`;
  }
  if (unit.fate === 'approved') return `откладывал: ${text} — принято`;
  if (unit.fate === 'rejected') {
    // Причины нет у записей, сделанных до её появления (`rejectedReason`, V1.8) — там она
    // и означала отказ владельца: до V1.8 отклонить pending могла только его кнопка
    return `откладывал: ${text} — ${UNIT_REJECT_LABEL[unit.reason ?? 'owner']}`;
  }
  return `откладывал: ${text} — ждёт решения`;
}

/**
 * Одна строка истории: слот, исход и то, что от прогона осталось владельцу, — в порядке
 * «что рутина сделала → чем это кончилось». Строка на прогон, а не абзац: семь абзацев
 * прозы модель читает хуже семи строк одинаковой формы.
 */
function historyLine(item: RoutineHistoryItem): string {
  const r = item.run;
  const parts: string[] = [];
  const slot = r.bucket ?? r.started_at;
  parts.push(`— ${slot}: ${OUTCOME_LABEL[r.outcome]}`);

  const explanation = item.explanation ?? (r.proposal !== undefined ? r.report : undefined);
  if (explanation !== undefined) parts.push(`предлагал: ${quote(explanation)}`);
  const status = item.proposalStatus ?? r.proposal?.status;
  if (status !== undefined) parts.push(`предложение: ${proposalLabel(status, r.proposal)}`);
  // Отчёт прогона БЕЗ предложения — это отчёт режима act, а не проза предложения
  if (r.proposal === undefined && r.report !== undefined) parts.push(`отчёт: ${quote(r.report)}`);
  if (r.checkpoint !== undefined) parts.push(`спрашивал: ${quote(r.checkpoint.question)}`);
  const reply = item.reply ?? r.reply?.text;
  if (reply !== undefined) parts.push(`ответ владельца: ${quote(reply)}`);
  // Единицы пачки (D42 ОЧ.7) — после вопроса терминального чекпойнта и до причины сбоя:
  // сначала «о чём прогон спросил и что отложил», потом «чем сам прогон кончился».
  // ЭТО ЕДИНСТВЕННАЯ ДОРОГА ОТВЕТОВ ВЛАДЕЛЬЦА В СЛЕДУЮЩИЙ ПРОГОН (блокер Б1 ревью спеки):
  // ленту треда контекст рутины не читает вовсе — см. докблок модуля.
  for (const unit of item.units ?? []) parts.push(unitPart(unit));
  if (item.unitsOmitted !== undefined) {
    parts.push(`и ещё ${item.unitsOmitted} ${decisionsNoun(item.unitsOmitted)}`);
  }
  if (r.fail_note !== undefined) parts.push(`причина сбоя: ${flatten(r.fail_note)}`);
  return parts.join('; ');
}

/**
 * Блок истории. Пустая история — тоже блок с явной строкой: «сообщения нет» модель
 * прочитала бы как «историю мне не дали», и первый прогон рутины начинался бы с догадок
 * о том, что уже предлагалось.
 */
function historyMessage(history: RoutineHistoryItem[]): LLMMessage {
  const body =
    history.length === 0
      ? 'Прошлых прогонов этой рутины ещё не было — это первое срабатывание.'
      : [
          'Прошлые прогоны этой рутины, от старых к новым. Это единственная обратная связь: не повторяй отклонённое и считайся с ответами владельца.',
          ...history.map(historyLine),
        ].join('\n');
  return { role: 'user', content: `[история прогонов]\n${body}` };
}

/**
 * Контекст прогона. Вызывается под withIdentity владельца (RLS скоупит память, реестр и
 * якорь), одним tx вместе с ensureEntityThread и сборкой реестра тулов — раннеру нужен
 * один снимок графа на прогон, а не три.
 */
export async function buildRoutineContext(
  tx: Tx,
  input: BuildRoutineContextInput,
): Promise<BuiltRoutineContext> {
  const { routine } = input;
  const sections: string[] = [
    ROUTINE_SYSTEM_PROMPT,
    // Дата — сразу за промптом, как и в чате (§Б7-6-1): рутина работает со «сроком
    // сегодня» и «просрочено», и без даты считала бы их от даты обучения модели.
    // Переставлять из-за неё нечего: блока продолжений у раннера нет.
    await todaySectionFor(tx, input.ownerId, (input.clock ?? (() => new Date()))()),
    routineModeSection({
      mode: routine.props['orbis/routine_mode'],
      allowedTools: routine.props['orbis/allowed_tools'] ?? [],
      runId: input.run.id,
      bucket: input.run.bucket,
    }),
  ];

  const instructions = await aspectInstructionsSection(tx);
  if (instructions !== null) sections.push(instructions);

  const memory = await loadMemory(tx);
  if (memory.length > 0) {
    sections.push(`${MEMORY_SECTION_HEADER}\n${memory.map(memoryLine).join('\n')}`);
  }

  // Якорь — сама рутина (V1.5): её тело и есть задание, поэтому приезжает целиком
  sections.push(
    await anchorBlock(tx, input.ownerId, routine.id, {
      intro: 'Рутина, которая сработала — работай по ней:',
      instruction: true,
    }),
  );

  return {
    system: sections.join('\n\n'),
    messages: [
      historyMessage(input.history),
      {
        role: 'user',
        content: `Сработала рутина «${flatten(routine.title)}» (бакет ${input.run.bucket}). Выполни инструкцию.`,
      },
    ],
  };
}
