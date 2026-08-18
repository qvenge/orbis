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
// Остальные слои — те же и теми же функциями (инструкции аспектов, память, якорь):
// разъехавшись, они дали бы «в фоне модель видит другой Orbis».
//
// Роль 'system' в messages ЗАПРЕЩЕНА (контракт провайдера — ai-sdk.ts бросает): и
// история, и «сработала рутина» едут как 'user'. Инвариант «messages начинается с user»
// здесь держится по построению — оба сообщения user.
import type { ProposalStatus, RoutineAspect, RunSummary } from '@orbis/shared';
import type { Tx } from '../db/with-identity';
import {
  anchorBlock,
  aspectInstructionsSection,
  loadMemory,
  MEMORY_SECTION_HEADER,
  memoryLine,
} from '../llm/context';
import { ROUTINE_SYSTEM_PROMPT, routineModeSection } from '../llm/prompts/routine-v1';
import type { LLMMessage } from '../llm/types';

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
}

/** Рутина в объёме контекста: расписание и права — в аспекте, задание — в теле (V1.1). */
export interface RoutineContextRoutine {
  id: string;
  title: string;
  body: string;
  routine: RoutineAspect;
}

export interface BuildRoutineContextInput {
  ownerId: string;
  routine: RoutineContextRoutine;
  run: { id: string; bucket: string };
  history: RoutineHistoryItem[];
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

/** Метки исходов прогона для строки истории. */
const OUTCOME_LABEL: Record<string, string> = {
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
 * Одна строка истории: слот, исход и то, что от прогона осталось владельцу, — в порядке
 * «что рутина сделала → чем это кончилось». Строка на прогон, а не абзац: семь абзацев
 * прозы модель читает хуже семи строк одинаковой формы.
 */
function historyLine(item: RoutineHistoryItem): string {
  const r = item.run;
  const parts: string[] = [];
  const slot = r.bucket ?? r.started_at;
  parts.push(`— ${slot}: ${OUTCOME_LABEL[r.outcome] ?? r.outcome}`);

  const explanation = item.explanation ?? (r.proposal !== undefined ? r.report : undefined);
  if (explanation !== undefined) parts.push(`предлагал: ${quote(explanation)}`);
  const status = item.proposalStatus ?? r.proposal?.status;
  if (status !== undefined) parts.push(`предложение: ${PROPOSAL_STATUS_LABEL[status]}`);
  // Отчёт прогона БЕЗ предложения — это отчёт режима act, а не проза предложения
  if (r.proposal === undefined && r.report !== undefined) parts.push(`отчёт: ${quote(r.report)}`);
  if (r.checkpoint !== undefined) parts.push(`спрашивал: ${quote(r.checkpoint.question)}`);
  const reply = item.reply ?? r.reply?.text;
  if (reply !== undefined) parts.push(`ответ владельца: ${quote(reply)}`);
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
    routineModeSection({
      mode: routine.routine.mode,
      allowedTools: routine.routine.allowed_tools ?? [],
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
