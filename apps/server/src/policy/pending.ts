// apps/server/src/policy/pending.ts
// Pending-подтверждения §7.10 (Task 6): «одобрение исполняет сохранённый payload,
// не повторяет вызов модели». explicit-confirmation-действие НЕ исполняется — в тред
// пишется карточка-запрос с immutable payload'ом (envelope-валидированным в момент
// запроса), и до approve НИЧЕГО не записано ни в граф, ни в журнал §7.8. approve
// прогоняет сохранённый payload ПОЛНЫМ конвейером executor'а (стадии 1–7) без
// обращения к LLM; reject — системное сообщение-отказ (журнал append-only, §4.6).
//
// РЕШЕНИЕ ПО КОНТРАКТУ levelGate (dispatch): полная провалидированность payload'а
// (стадии 2–4 конвейера §9.2 — aspects-схемы, инварианты, expectedUpdatedAt/§5.2) —
// обязанность РЕВАЛИДАЦИИ APPROVE, а не dry-run'а при создании pending: dry-run не
// спасает от изменения состояния за время ожидания (ревалидация на approve обязательна
// в любом случае), а двойная валидация избыточна. Цена: структурная ошибка возможна
// после «Подтвердить» — честно и приемлемо для MVP.
//
// МЕХАНИКА ИДЕМПОТЕНТНОСТИ approve — batch §7.8 без нового механизма: payload
// исполняется атомарной группой с batch_id = pendingId (одиночный тул — batch из
// одной операции, валиден по §9.2; payload-batch_execute — собственная структура с
// ПЕРЕЗАПИСЬЮ его batch_id на pendingId — двойная идемпотентность по одному ключу).
// Детерминированный audit-id = batchAuditMessageId(owner, pendingId) — он заменяет
// отдельную формулу uuidv5('approval:<owner>:<pendingId>') ранней редакции брифа:
// та же детерминированность и идемпотентность по PK chat_messages, но одним общим
// механизмом (резолюция координатора). Подмена batch_id безопасна: pendingId
// генерирует сервер (uuidv7), коллизия с клиентским batch_id невероятна. Повторный
// approve: findByAuditId → replay сохранённого результата; гонка одинаковых approve →
// AuditIdConflictError → тот же replay (§7.8).
//
// ЕДИНИЦЫ ПАЧКИ (D42 ОЧ.2): тот же носитель несёт отложенные действия и ВОПРОСЫ рутины —
// второго механизма «отложенного» не заводим. Отличие единицы от чатового pending и от
// предложения рутины — ЯВНЫЙ `kind` в записи: по нему единицы находит `listRunUnits`, по
// нему же approve/reject отказывают на вопросе (на вопрос отвечают, а не принимают его).
// Всё остальное — идемпотентность по PK, advisory-замок, append-only судьба, атрибуция
// сквозь одобрение — работает единицам как есть, ради чего носитель и переиспользован.
import { createHash } from 'node:crypto';
import {
  answerMessageId,
  batchAuditMessageId,
  batchExecuteInput,
  canonicalJson,
  newId,
  pendingMessageId,
  QUESTION_MAX,
  QUESTION_OPTION_MAX,
  QUESTION_OPTIONS_MAX,
  questionStaleMessageId,
  rejectMessageId,
} from '@orbis/shared';
import { eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { escalateAfterMutation } from '../ai/escalation';
import { appendMessageIdempotent } from '../chat/messages';
import { ensureGlobalThread } from '../chat/threads';
import type { Db } from '../db/client';
import { chatMessages } from '../db/schema';
import { type Tx, withIdentity } from '../db/with-identity';
import { ExecError, type StructuredError } from '../errors';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { ActorKind, ExecuteResult } from '../executor/types';
import type { Card } from '../tools/registry';
import type { ConfirmationLevel } from './confirmation';

// Боевой синк §7.8 — audit-сообщение approve пишется тем же tx, что стадия 5
const sink = makeChatJournalSink();

/** Русский плюрал операций batch: 1 операция, 2 операции, 5 операций. */
export function operationsNoun(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return 'операций';
  const mod10 = n % 10;
  if (mod10 === 1) return 'операция';
  if (mod10 >= 2 && mod10 <= 4) return 'операции';
  return 'операций';
}

/**
 * Границы содержимого вопроса — ОДНА пара схем на читателя и писателя (Minor-2 ревью
 * Задачи 2). Разъехаться они не могут по построению: обе стороны ссылаются сюда, а не
 * повторяют числа. САМИ ЧИСЛА — тоже не здесь: они пришли из `@orbis/shared` (Minor Р3-2
 * ревью Задачи 3), потому что тех же границ держатся вход тула `askInput` и его JSON
 * Schema в реестре, а тихо разъехавшийся писатель отказал бы там, где тул пропустил.
 */
const questionText = z.string().min(1).max(QUESTION_MAX);
const questionOptions = z
  .array(z.string().min(1).max(QUESTION_OPTION_MAX))
  .max(QUESTION_OPTIONS_MAX);

/**
 * Формат metadata.pending карточки-запроса. Zod-парс при чтении — fail-closed:
 * повреждённая/чужеродная запись не исполняется. Без .strict() — форвард-совместимость
 * с будущими полями. actor_kind/source — атрибуция ИСХОДНОГО актора (§7.8, D11):
 * approve владельца исполняет план от имени запросившего AI/агента.
 */
const pendingRecord = z
  .object({
    id: z.string().uuid(),
    /**
     * Род записи (D42 ОЧ.2): `action` — отложенное действие, `question` — вопрос пачки.
     *
     * У ЕДИНИЦ прогона ключ обязателен и ЯВЕН (Б5 ревью): по нему их находит проба пачки
     * `{pending:{run_id, kind}}`, и только явность отделяет единицу от предложения рутины
     * (`orbis_propose`), которое живёт под тем же `run_id`. Отсутствие ключа читается как
     * `action` ТОЛЬКО при одиночном чтении по id — это обратная совместимость чатовых
     * pending'ов и предложений, а не «умолчание для новых записей».
     */
    kind: z.enum(['question', 'action']).optional(),
    tool: z.string().min(1).optional(), // executor-форма (attach_<aspect_id с заменой «/»>)
    input: z.record(z.unknown()).optional(), // immutable payload — envelope-валидирован при создании
    /** Текст вопроса владельцу (kind:'question'); границы — те же, что у `askInput`. */
    question: questionText.optional(),
    /** Готовые ответы кнопками (kind:'question'), до четырёх — как в `askInput`. */
    options: questionOptions.optional(),
    actor_kind: z.enum(['owner', 'ai', 'agent']),
    source: z.enum(['chat', 'mcp', 'routine']),
    /**
     * Грант исходного вызова (С2) — вторая половина той же атрибуции: approve владельца
     * исполняет план от имени запросившего, и владелец обязан видеть, КАКОЙ доступ его
     * попросил. Ключа нет у владельческих и чатовых путей (за ними стоит сам владелец) и
     * не было у записей до этой работы — потому optional, а не обязательное поле;
     * миграции не нужно: metadata — jsonb, схема читается без .strict().
     */
    actor_grant_id: z.string().optional(),
    /**
     * Прогон рутины, предложивший этот план (V1.6). Тот же приём, что с грантом: одобрил
     * владелец, но в журнале §7.8 остаётся видно, ЧЕЙ прогон это предложил — по run_id
     * действие находит откат прогона (rollback.ts) и история рутины. Ключа нет у чата,
     * UI и MCP — там прогона нет; у записей до этой работы его тоже не было.
     */
    run_id: z.string().uuid().optional(),
    /**
     * Предложение, из правки которого это рождено (Ш1.5): владелец поправил значения ДО
     * принятия, исходное погашено причиной `edited`, а рядом легло вот это. Тот же приём,
     * что с грантом и прогоном: ключа нет у всех, кто родился не из правки.
     *
     * Поле не декоративно — им лестница правки НАХОДИТ своё дитя контейнмент-пробой
     * `{pending: {edited_from: <исходное>}}`, когда перевод указателя прогона не дошёл
     * (крэш между шагами). Оно же уезжает в action журнала §7.8 (В-1).
     */
    edited_from: z.string().uuid().optional(),
    created_at: z.string(),
  })
  /**
   * Условная обязательность payload'а (ОЧ.2, §4): у ДЕЙСТВИЯ обязаны быть `tool`/`input`
   * (их исполняет approve), у ВОПРОСА они запрещены, а обязателен `question`.
   *
   * Проверка живёт в схеме, а не у вызывателей, потому что это единственное место, через
   * которое запись ЧИТАЕТСЯ: перепутанная комбинация — либо баг записи, либо чужеродное
   * сообщение с ключом `pending`, и обе ведут туда же, куда повреждённый payload —
   * в VALIDATION «pending-запись повреждена», а не в исполнение наугад. Действие без
   * тула исполнять нечем, а «вопрос» с тулом проехал бы в executor мимо решения владельца.
   *
   * Записи БЕЗ `kind` (чатовые pending'ы и предложения рутины) идут по ветке действия —
   * то самое правило обратной совместимости из докблока `kind`.
   *
   * ЗАПРЕТ ЗЕРКАЛЕН (Minor-3 ревью Задачи 2): у действия не может быть `question`/
   * `options` ровно так же, как у вопроса — `tool`/`input`. Без второй половины запись
   * `{kind:'action', tool, input, question}` схему проходила бы, и читатели, выводящие
   * подпись единицы из полей (экран пачки, история), рисовали бы гибрид — действие,
   * выглядящее вопросом. Запрет живёт в схеме, а не в сборке `RunUnit`, потому что схема
   * стоит РАНЬШЕ и общая: она ловит гибрид и при одиночном чтении по id (approve/reject),
   * а условие в спреде `RunUnit` чинило бы только пачку. Цена — та же, что у зеркальной
   * комбинации: повреждённая единица роняет чтение целиком, и это намеренно (см.
   * `parsePendingRecord`).
   */
  .superRefine((rec, ctx) => {
    const kindName = rec.kind ?? 'action';
    const forbid = (path: string, kind: string) =>
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path],
        message: `у записи kind:'${kind}' поля «${path}» быть не может`,
      });
    const require = (path: string, kind: string) =>
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path],
        message: `у записи kind:'${kind}' поле «${path}» обязательно`,
      });
    if (rec.kind === 'question') {
      if (rec.tool !== undefined) forbid('tool', 'question');
      if (rec.input !== undefined) forbid('input', 'question');
      if (rec.question === undefined) require('question', 'question');
      return;
    }
    // Запрет накрывает и записи БЕЗ `kind`: они читаются как действие, и гибрид остаётся
    // гибридом независимо от того, явен ключ или нет. Совместимости это не стоит ничего —
    // `question` в записи без `kind` не писал никто и никогда (единственный писатель —
    // `createPending`, и до D42 поля вопроса у него не было вовсе)
    if (rec.question !== undefined) forbid('question', kindName);
    if (rec.options !== undefined) forbid('options', kindName);
    if (rec.tool === undefined) require('tool', kindName);
    if (rec.input === undefined) require('input', kindName);
  });

export type PendingRecord = z.infer<typeof pendingRecord>;

export interface PendingActor {
  userId: string; // владелец графа (D11)
  kind: ActorKind;
  source: 'chat' | 'mcp' | 'routine';
  /** Грант, от имени которого пришёл запрос (С2); нет у чата и UI — там актор сам владелец. */
  grantId?: string;
  /** Прогон рутины, предложивший план (V1.6); есть только у source 'routine'. */
  runId?: string;
  /** Предложение, из правки которого рождено это (Ш1.5); есть только у правленых. */
  editedFrom?: string;
}

/**
 * Личность единицы пачки: sha256 от канонической формы, НИЖНИМ РЕГИСТРОМ HEX.
 *
 * Регистр — не косметика (то же правило, что у `editsHash`, Развилка 3 Ш1): хеш уезжает
 * в `dedupeKey`, а `pendingMessageId` ключ ЛОУЭРКЕЙСИТ (`ids.ts`) — в регистро-значимой
 * кодировке две разные единицы схлопнулись бы в один PK, и повторная постановка вернула
 * бы владельцу чужую карточку.
 *
 * Порядок ключей объектов личность НЕ меняет (`canonicalJson`: jsonb порядок ключей не
 * хранит, и прошедший через БД payload обязан дать тот же хеш). Порядок ЭЛЕМЕНТОВ
 * массива — меняет: варианты ответа владелец видит в присланном порядке, и переставленные
 * кнопки — другой вопрос. Этим `unitHash` и отличается от `editsHash`, который массивы
 * сортирует: у правки порядок строк — порядок экрана, у единицы — часть содержимого.
 * Вторая функция той же формы заведена ровно из-за этой разницы нормализации.
 */
export function unitHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/**
 * Ключ дедупа вопроса (ОЧ.9): повтор ТОГО ЖЕ вопроса в том же прогоне обязан сойтись в
 * ту же карточку — по СОДЕРЖИМОМУ, а не по ключу от модели (его она вольна выдумать
 * заново, потому у `askInput` ключа идемпотентности и нет).
 *
 * «Нет вариантов» и «пустой список вариантов» — один и тот же вопрос: `?? []`.
 */
export function askDedupeKey(runId: string, question: string, options?: string[]): string {
  return `ask:${runId}:${unitHash({ question, options: options ?? [] })}`;
}

/**
 * Ключ дедупа отложенного действия (ОЧ.9): повторная попытка того же вызова в том же
 * прогоне (модель повторила шаг) кладёт в пачку одну единицу, а не вторую такую же.
 */
export function deferDedupeKey(runId: string, tool: string, input: unknown): string {
  return `defer:${runId}:${unitHash({ tool, input })}`;
}

/** Общая часть аргументов запроса — всё, что не зависит от рода записи. */
interface CreatePendingCommon {
  threadId?: string; // нет → глобальный тред владельца (как у audit-синка §7.8)
  actor: PendingActor;
  level: ConfirmationLevel;
  /**
   * Исходный batch_id модели: детерминирует pendingId (pendingMessageId) → ретрай
   * того же batch на explicit-уровне даёт тот же PK, appendMessageIdempotent
   * возвращает исходную карточку, а не плодит вторую (митигация Minor-4 Task 6).
   * Нет ключа (одиночная мутация без batch_id) → серверный uuidv7, дедуп не применим.
   */
  dedupeKey?: string;
  clock?: () => Date;
  /**
   * Карточка вместо confirmation_card по умолчанию (V1.6): предложение рутины рисуется
   * своей карточкой (proposal_card) — у неё другой текст, другие кнопки и статус с
   * сервера. Механика pending при этом та же: карточка — только представление, а
   * исполняет approve сохранённый payload. Не задана → confirmation_card.
   */
  card?: Card;
  /**
   * Человекочитаемая сводка вместо умолчания (имя тула / «N операций») — для карточки и
   * текста сообщения. Нужна там, где содержимое payload'а определяет ПРАВА (выдача
   * автономии рутине, V1.10): владелец обязан видеть, что подтверждает — режим и белый
   * список, а не «attach_orbis_routine».
   */
  summary?: string;
  /**
   * Текст сообщения-запроса вместо «Требуется подтверждение: <summary>». Предложение
   * рутины — не подтверждение чата: его строка в ленте называет само событие.
   */
  content?: string;
}

/**
 * Полезная нагрузка запроса — РАЗНАЯ у действия и у вопроса (D42 ОЧ.2), и союз, а не
 * набор optional-полей, потому что перепутать их нельзя даже случайно: вопрос с тулом
 * поехал бы в executor мимо решения владельца, а действие без тула нечего исполнять.
 * Схема чтения (`pendingRecord`) ловит обе беды в проде; здесь их ловит компилятор.
 *
 * `kind` у единиц пачки ОБЯЗАН передаваться явно (Б5 ревью) — по нему их находит проба
 * `{pending:{run_id, kind}}`. Ветка `kind?: 'action'` без ключа — это сегодняшние
 * вызыватели (чат, `orbis_propose`, лестница правки Ш1): их записи остаются байт-в-байт
 * прежними, потому что отсутствующий `kind` в metadata не пишется вовсе.
 */
export type CreatePendingArgs =
  | (CreatePendingCommon & {
      kind: 'question';
      /** Текст вопроса владельцу — единственное обязательное содержимое вопроса. */
      question: string;
      /** До четырёх готовых ответов кнопками; порядок значим — владелец видит его. */
      options?: string[];
      tool?: never;
      input?: never;
    })
  | (CreatePendingCommon & {
      /** Явный `action` — у единиц пачки; отсутствие ключа — сегодняшние вызыватели. */
      kind?: 'action';
      tool: string; // executor-форма; для batch — 'batch_execute'
      input: unknown; // envelope-валидированный payload (для batch — с транслированными именами)
      question?: never;
      options?: never;
    });

/**
 * Карточка-запрос explicit-confirmation (§7.10): системное сообщение с
 * metadata.pending (immutable payload) + metadata.cards[confirmation_card
 * mode:'explicit'] — или карточка из args.card, если вызывающий рисует запрос по-своему
 * (V1.6). НИЧЕГО в граф и журнал: сообщение не несёт metadata.actions,
 * поэтому для журнала §7.8 (undo-сканы containment'ом по actions) невидимо.
 *
 * id сообщения = pendingId — прямая адресация; поиск при approve/reject —
 * containment по metadata.pending.id (GIN chat_messages_metadata_gin).
 * input обязан быть envelope-валидированным (контракт levelGate, fix round Task 5);
 * полная провалидированность — ревалидация approve (см. шапку модуля).
 */
export async function createPending(
  tx: Tx,
  args: CreatePendingArgs,
): Promise<{ pendingId: string; card: Card }> {
  if (args.level !== 'explicit-confirmation') {
    // Программная ошибка вызывающего, не доменный отказ: pending порождает только
    // explicit-уровень (§7.10) — прочие уровни исполняются/отклоняются в dispatch
    throw new Error(`createPending: уровень «${args.level}» pending не порождает (§7.10)`);
  }
  const pendingId =
    args.dedupeKey !== undefined ? pendingMessageId(args.actor.userId, args.dedupeKey) : newId();
  if (args.kind === 'question') assertQuestionBounds(pendingId, args.question, args.options);
  const threadId = args.threadId ?? (await ensureGlobalThread(tx, args.actor.userId));
  // У вопроса тула нет — `pendingSummary` вернул бы `undefined` в summary карточки и в
  // «Требуется подтверждение: undefined»; сводка вопроса — сам вопрос, усечённый
  const summary =
    args.summary ??
    (args.kind === 'question'
      ? questionSummary(args.question)
      : pendingSummary(args.tool, args.input));
  const card: Card = args.card ?? {
    kind: 'confirmation_card',
    mode: 'explicit',
    pendingId,
    summary,
  };
  const createdAt = (args.clock ?? (() => new Date()))();
  // Идемпотентность по pendingId: при dedupeKey (batch_id) повтор того же batch даёт тот
  // же PK → ON CONFLICT возвращает ИСХОДНУЮ запись (append-only — сохранённый payload
  // первого запроса, §4.6), вторая карточка не пишется. Карточка детерминирована (тот же
  // pendingId и summary при идентичном ретрае), поэтому реконструируется, а не читается.
  await appendMessageIdempotent(tx, {
    id: pendingId,
    threadId,
    role: 'system',
    content: args.content ?? `Требуется подтверждение: ${summary}`,
    metadata: {
      pending: {
        id: pendingId,
        // Условная запись, как у `run_id`/`edited_from` ниже: у сегодняшних вызывателей
        // (чат, предложение рутины, лестница правки) ключа нет вовсе, и их записи
        // остаются байт-в-байт прежними — на это опираются пины Ш1
        ...(args.kind !== undefined && { kind: args.kind }),
        // Содержимое по роду записи (ОЧ.2): вопрос НЕ несёт tool/input, действие — несёт.
        // Ровно эту пару комбинаций и стережёт `pendingRecord.superRefine` при чтении
        ...(args.kind === 'question'
          ? {
              question: args.question,
              ...(args.options !== undefined && { options: args.options }),
            }
          : { tool: args.tool, input: args.input }),
        actor_kind: args.actor.kind,
        source: args.actor.source,
        // Условная запись, а не `actor_grant_id: undefined`: ключ отсутствует у путей
        // без гранта — как в action'е журнала (executor.ts) и как проверяет тест
        ...(args.actor.grantId !== undefined && { actor_grant_id: args.actor.grantId }),
        // То же и для прогона (V1.6): ключа нет у путей без рутины
        ...(args.actor.runId !== undefined && { run_id: args.actor.runId }),
        // И для правки (Ш1.5): ключ есть только у правленого предложения, и его отсутствие
        // у всех прочих — то, что делает пробу «дитя этого предложения» точной
        ...(args.actor.editedFrom !== undefined && { edited_from: args.actor.editedFrom }),
        created_at: createdAt.toISOString(),
      },
      cards: [card],
    },
  });
  return { pendingId, card };
}

/**
 * Границы вопроса ПРИ ЗАПИСИ (Minor-2 ревью Задачи 2) — теми же схемами, что при чтении.
 *
 * Читатель fail-closed: `parsePendingRecord` внутри `listRunUnits` роняет ВСЮ пачку
 * прогона, если хоть одна запись не прошла схему, — вместе с гашением и сверкой
 * `undecided`. Значит запись, склеенная мимо `askInput` (внутренний вызыватель, собравший
 * вопрос из строк), убила бы владельцу всю пачку целиком. Цена отказа писателю —
 * непоставленный вопрос, цена молчания — неразбираемая пачка; поэтому проверяем здесь.
 *
 * ExecError VALIDATION, а не `Error` (как у неверного уровня выше): текст вопроса
 * приходит от модели, и это доменный отказ вызывающему тулу, а не баг вызывателя.
 */
function assertQuestionBounds(pendingId: string, question: string, options?: string[]): void {
  const parsed = z
    .object({ question: questionText, options: questionOptions.optional() })
    .safeParse({ question, options });
  if (!parsed.success) {
    throw new ExecError(
      'VALIDATION',
      'вопрос не помещается в границы записи — карточка не поставлена',
      { pendingId, issues: parsed.error.issues },
    );
  }
}

/**
 * Сводка вопроса — сам вопрос, усечённый до строки карточки. Отдельная функция, а не
 * ветка в `pendingSummary`: та работает от тула, которого у вопроса нет.
 */
function questionSummary(question: string): string {
  const one = question.trim().replace(/\s+/g, ' ');
  return one.length > QUESTION_SUMMARY_MAX ? `${one.slice(0, QUESTION_SUMMARY_MAX)}…` : one;
}

/** Потолок сводки вопроса: карточка показывает строку, а не все 4000 символов текста. */
const QUESTION_SUMMARY_MAX = 120;

/** Summary карточки-запроса: batch — «N операций» (как preview), одиночный — имя тула. */
function pendingSummary(tool: string, input: unknown): string {
  if (tool === 'batch_execute') {
    const env = batchExecuteInput.safeParse(input);
    if (env.success) {
      const n = env.data.operations.length;
      return `${n} ${operationsNoun(n)}`;
    }
  }
  return tool;
}

interface FoundPending {
  threadId: string;
  pending: PendingRecord;
}

/** Карточка-запрос по pendingId — containment по GIN (RLS скоупит владельцем). */
async function findPendingMessage(tx: Tx, pendingId: string): Promise<FoundPending | undefined> {
  const probe = JSON.stringify({ pending: { id: pendingId } });
  const rows = await tx.execute(
    sql`SELECT thread_id, metadata FROM chat_messages
        WHERE metadata @> ${probe}::jsonb
        LIMIT 1`,
  );
  const row = rows[0];
  if (!row) return undefined;
  return {
    threadId: row.thread_id as string,
    pending: parsePendingRecord(pendingId, (row.metadata as { pending?: unknown }).pending),
  };
}

/**
 * Разбор записи с fail-closed отказом — общий для одиночного чтения по id и для пробы
 * пачки (`listRunUnits`). Повреждённая единица не прячется из списка НАМЕРЕННО: спрятать
 * её значило бы показать владельцу пачку решённой, пока в ней висит нерешённое.
 */
function parsePendingRecord(pendingId: string, value: unknown): PendingRecord {
  const parsed = pendingRecord.safeParse(value);
  if (!parsed.success) {
    // fail-closed: повреждённый payload не исполняем (metadata неизменяема §4.6 —
    // сюда ведёт только баг записи или чужеродное сообщение с ключом pending)
    throw new ExecError('VALIDATION', 'pending-запись повреждена — исполнение невозможно', {
      pendingId,
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

/**
 * Гейт рода записи (С7 ревью): на вопрос ОТВЕЧАЮТ, а не принимают и не отклоняют.
 *
 * Стоит в policy, а не в роутере: approve/reject зовут семь мест (кнопка чата, MCP,
 * раннер рутины, лестница правки Ш1, компенсация propose), и роутерный гейт закрыл бы
 * два из них. Судьба вопроса — своя пара сообщений (`answerMessageId` /
 * `questionStaleMessageId`), и запись сюда чужой судьбы сделала бы вопрос неотвечаемым:
 * судьба единственна и первая записанная финальна (ОЧ.8).
 */
function assertNotQuestion(pending: PendingRecord): void {
  if (pending.kind === 'question') {
    throw new ExecError('VALIDATION', 'это вопрос — на него отвечают, а не принимают/отклоняют', {
      pendingId: pending.id,
    });
  }
}

/**
 * Причина отказа (V1.8): «владелец отказался» и «прогон заменил своё же предложение
 * новым» — разные события, и рутина обязана их различать, иначе замена читалась бы как
 * отказ владельца и останавливала бы её навсегда.
 *
 * 'owner' — кнопка владельца (по умолчанию); 'superseded' — раннер гасит предложение
 * прошлого прогона своим новым; 'stale' — состояние изменилось, предложение больше
 * не применимо; 'edited' — владелец поправил предложение до принятия (Ш1.5), и вместо
 * этого рядом легло новое, правленое.
 *
 * 'edited' — это НЕ отказ владельца, и различать их обязаны все: рутина иначе прочитала
 * бы «мой текст не подошёл» там, где владелец его дописал, а гашение новым прогоном
 * переписало бы судьбу предложения, которого уже нет. Отдельного статуса предложения
 * причина не заводит: судьба исходного живёт здесь, в ленте, а признак на живом — поле
 * `edited_from` (Ш1.8).
 */
export type RejectReason = 'owner' | 'superseded' | 'stale' | 'edited';

// ВНИМАНИЕ: единственное из четырёх мест причины, где расширение НЕ ловит компилятор
// (тип, REJECT_CONTENT и STATUS_BY_REJECT_REASON — Record'ы, они падают сборкой). Строка,
// забытая здесь, откатывается fallback'ом rejectedReason к 'owner' — то есть правка
// владельца молча превращается в его же отказ.
const rejectReason = z.enum(['owner', 'superseded', 'stale', 'edited']);

/** Текст reject-сообщения по причине — владелец читает ленту, а не значение поля. */
const REJECT_CONTENT: Record<RejectReason, string> = {
  owner: 'Подтверждение отклонено',
  superseded: 'Предложение заменено новым прогоном',
  stale: 'Предложение устарело: состояние изменилось',
  edited: 'Предложение заменено правкой владельца',
};

/**
 * Причина отказа pending'а, если он отклонён; undefined — не отклонён.
 *
 * Проба контейнментом — прежняя, {type, rejects} БЕЗ причины: отказ обязан находиться
 * независимо от того, кто и почему его записал (иначе approve исполнил бы заменённое
 * предложение). Причина читается уже из найденного сообщения.
 *
 * Сообщения, написанные до появления причины, ключа reason не несут (metadata
 * неизменяема, §4.6) — читаются как отказ владельца: до V1.8 отклонить pending могла
 * только его кнопка, так что это не догадка, а факт истории.
 */
export async function rejectedReason(tx: Tx, pendingId: string): Promise<RejectReason | undefined> {
  const probe = JSON.stringify({ type: 'confirmation_rejected', rejects: pendingId });
  const rows = await tx.execute(
    sql`SELECT metadata FROM chat_messages WHERE metadata @> ${probe}::jsonb LIMIT 1`,
  );
  const row = rows[0];
  if (!row) return undefined;
  const parsed = rejectReason.safeParse((row.metadata as { reason?: unknown }).reason);
  return parsed.success ? parsed.data : 'owner';
}

/** Pending отклонён ⇔ существует сообщение {type:'confirmation_rejected', rejects}. */
async function isRejected(tx: Tx, pendingId: string): Promise<boolean> {
  return (await rejectedReason(tx, pendingId)) !== undefined;
}

/**
 * Сериализация approve/reject одного pendingId (fix round Task 6): advisory-lock
 * уровня транзакции — умирает на commit/rollback. Без него approve (проверки в одном
 * tx, исполнение в другом) и reject образуют write-skew — оба проходят свои проверки
 * до чужого коммита, и владелец получает «исполнено» И «отклонено» одновременно.
 *
 * КОНТРАКТ: замок берётся до ПЕРВОГО ЧТЕНИЯ СОСТОЯНИЯ этого pendingId в транзакции и
 * не отпускается до её конца (xact-замок отдельно не отпускается вовсе). Формулировка
 * «первым statement'ом транзакции» была бы неточной: первые два statement'а всегда
 * ставит withIdentity (set_config + SET LOCAL ROLE, with-identity.ts) — проверяемое
 * требование именно в порядке относительно ЧТЕНИЙ: всё, что прочитано после захвата,
 * прочитано снапшотом READ COMMITTED, снятым уже под замком.
 *
 * Повторный захват того же ключа в ТОЙ ЖЕ транзакции — no-op: pg_advisory_xact_lock
 * re-entrant для своей сессии и второй записи в pg_locks не заводит (замерено). Поэтому
 * вызыватель, взявший замок сам, ничего не передаёт и ничего не отключает, а
 * rejectPendingTx берёт замок безусловно — контракт держится механикой, а не
 * дисциплиной вызывателя.
 *
 * Ключ — hashtextextended(pendingId): pendingId глобально уникален (uuidv7),
 * межвладельческие коллизии хэша безвредны (кратковременная лишняя сериализация,
 * не ошибка).
 *
 * Экспортирован ради лестницы правки (Ш1.5): её шаг 1 читает состояние P1 сам, ДО
 * гашения, и обязан делать это под замком.
 */
export async function acquirePendingLock(tx: Tx, pendingId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${pendingId}, 0))`);
}

/** Операции ExecuteRequest из сохранённого payload (batch — собственная структура). */
function toOperations(pending: PendingRecord): Array<{ tool: string; input: unknown }> {
  if (pending.tool === undefined) {
    // Недостижимо у валидной записи: `tool` обязателен всюду, кроме вопроса, а вопрос
    // сюда не доходит — его отсекает `assertNotQuestion`. Проверка стоит потому, что
    // условную обязательность держит `superRefine`, а его компилятор не видит: без неё
    // «действие без тула» уехало бы в executor строкой `undefined`
    throw new ExecError('VALIDATION', 'pending-запись повреждена — исполнение невозможно', {
      pendingId: pending.id,
    });
  }
  if (pending.tool === 'batch_execute') {
    const env = batchExecuteInput.safeParse(pending.input);
    if (!env.success) {
      throw new ExecError('VALIDATION', 'pending-запись повреждена — batch-envelope невалиден', {
        pendingId: pending.id,
        issues: env.error.issues,
      });
    }
    // batch_id из payload НЕ используется — идемпотентность approve ключуется
    // pendingId (перезапись batch_id, см. шапку модуля)
    return env.data.operations;
  }
  return [{ tool: pending.tool, input: pending.input }];
}

/**
 * Одобрение §7.10: исполнить СОХРАНЁННЫЙ payload, не повторяя вызов модели.
 * Порядок проверок: (1) pending виден под RLS (чужой и несуществующий → единый
 * NOT_FOUND); (2) не отклонён → VALIDATION «отклонено»; (3) исполненность проверяет
 * сам executor batch-путём (findByAuditId по batchAuditMessageId(owner, pendingId) →
 * идемпотентный replay сохранённого результата — «как executor для batch», §7.8).
 * Исполнение — полный конвейер (стадии 1–7): это и есть «ревалидация текущего
 * состояния» §7.10 — изменившееся/удалённое состояние даёт структурную ошибку
 * (NOT_FOUND/STALE_VERSION/INVARIANT/...), не тихий провал, и ничего не пишет.
 *
 * Сериализация против reject (fix round): проверка (2) в отдельном tx — лишь
 * fast-path; авторитетная перепроверка «не отклонён» выполняется ПОД advisory-lock'ом
 * по pendingId, взятым ДО ПЕРВОГО ЧТЕНИЯ СОСТОЯНИЯ в audit-tx executor'а (beforeStages) —
 * В ТОМ ЖЕ tx, где пишется audit-сообщение. Именно «до первого чтения», а не «первым
 * statement'ом»: два первых statement'а любого такого tx ставит сам `withIdentity`
 * (set_config + SET LOCAL ROLE), и буквальная формулировка не выполнялась бы НИКОГДА —
 * ни здесь, ни у reject'а. Точный контракт и цена ошибки — в доке `acquirePendingLock`. Конкурентный reject держит тот же замок: он либо
 * закоммитился ДО захвата (перепроверка увидит reject-сообщение свежим snapshot'ом
 * READ COMMITTED → «отклонено», ни одной записи), либо ждёт наш commit и увидит
 * audit-сообщение → «уже исполнено». Write-skew исключён; закреплено гонным тестом.
 */
export async function approvePending(
  db: Db,
  args: { ownerId: string; pendingId: string; clock?: () => Date },
): Promise<ExecuteResult> {
  try {
    const found = await withIdentity(db, args.ownerId, async (tx) => {
      const msg = await findPendingMessage(tx, args.pendingId);
      if (!msg) {
        throw new ExecError('NOT_FOUND', `pending-подтверждение ${args.pendingId} не найдено`, {
          pendingId: args.pendingId,
        });
      }
      assertNotQuestion(msg.pending); // род записи неизменяем — перепроверять под замком нечего
      if (await isRejected(tx, args.pendingId)) {
        throw new ExecError(
          'VALIDATION',
          `подтверждение ${args.pendingId} отклонено — исполнение невозможно (§7.10)`,
          { pendingId: args.pendingId },
        );
      }
      return msg;
    });
    // Вне tx проверок: execute открывает собственный withIdentity-tx (вложить нельзя).
    // Чтение pending отдельным tx безопасно: journal append-only, metadata неизменяема
    // (§4.6). audit — в тред карточки-запроса; атрибуция — исходный актор (§7.8)
    const operations = toOperations(found.pending);
    const r = await execute(
      db,
      {
        actorUserId: args.ownerId,
        actorKind: found.pending.actor_kind,
        source: found.pending.source,
        // Грант исходного вызова доживает до исполнения (С2): подтвердил владелец, но в
        // журнале §7.8 видно, КАКОЙ доступ этот план попросил
        actorGrantId: found.pending.actor_grant_id,
        // Прогон рутины — та же логика, что с грантом (V1.6): предложение одобрил
        // владелец, но сделала правку рутина, и по run_id её найдёт откат прогона
        runId: found.pending.run_id,
        // И правка владельца (Ш1.5, В-1): применено не то, что предложила рутина, а
        // правленое — журнал §7.8 обязан хранить, ЧТО именно эта правка заменила
        editedFrom: found.pending.edited_from,
        threadId: found.threadId,
        operations,
        batchId: args.pendingId,
        clock: args.clock,
      },
      {
        sink,
        // Первый statement audit-tx (до replay-проверки и стадий 1–7): замок +
        // авторитетная перепроверка «не отклонён» — см. док approvePending
        beforeStages: async (tx) => {
          await acquirePendingLock(tx, args.pendingId);
          if (await isRejected(tx, args.pendingId)) {
            throw new ExecError(
              'VALIDATION',
              `подтверждение ${args.pendingId} отклонено — исполнение невозможно (§7.10)`,
              { pendingId: args.pendingId },
            );
          }
        },
      },
    );

    // Эскалация повторных исправлений (§7.8) — ВТОРАЯ точка вызова (уборочная фаза,
    // решение 4). Батч из 11+ операций classifyToolCall уводит в explicit-confirmation,
    // и диспатч возвращает pending_confirmation ДО execute — то есть мимо своего вызова
    // эскалации. Исполняет сохранённый payload только этот путь, поэтому «перенеси все 12
    // покупок в Пятёрочке из Еды в Развлечения» дважды не давало предложения правила
    // никогда: рекатегоризации в журнал попадали, но триггер не срабатывал.
    // Задвоения нет — из диспатча этот payload не исполняется вовсе; повторный approve
    // отсекается idempotentReplay (журналировать нечего). Ошибку эскалация логирует
    // внутри и не пробрасывает: правки уже закоммичены.
    if (r.ok && !r.idempotentReplay && found.pending.source === 'chat') {
      await escalateAfterMutation(db, {
        ownerId: args.ownerId,
        actionId: r.actionId,
        operations,
      });
    }
    return r;
  } catch (e) {
    if (e instanceof ExecError) {
      return { ok: false, error: { code: e.code, message: e.message, details: e.details } };
    }
    throw e;
  }
}

/**
 * Аргументы отклонения — общие у tx-формы и обёртки.
 *
 * `text` (D42 С6 ревью) — своя строка ленты для ЕДИНИЦЫ пачки: «Отложенное действие
 * снято новым прогоном» вместо «Предложение заменено новым прогоном». Причина при этом
 * остаётся тем же enum'ом и в metadata пишется прежней: текст — только представление, и
 * второго источника правды о судьбе он не заводит (её читают `rejectedReason` и статус
 * прогона). Повтор ничего не переписывает — журнал append-only, §4.6.
 */
export interface RejectPendingArgs {
  ownerId: string;
  pendingId: string;
  reason?: RejectReason;
  text?: string;
}

/**
 * Успешный исход отклонения — общая часть tx-варианта и обёртки.
 *
 * threadId — тред карточки-запроса, который findPendingMessage и так прочитал. Нужен
 * лестнице правки (Ш1.5): новое предложение обязано лечь в ТОТ ЖЕ тред рутины, иначе
 * createPending уронит его в глобальный тред владельца и лента треда разорвётся.
 */
export interface RejectPendingTxResult {
  pendingId: string;
  alreadyRejected: boolean;
  reason: RejectReason;
  threadId: string;
}

export type RejectPendingResult =
  | ({ ok: true } & RejectPendingTxResult)
  | { ok: false; error: StructuredError };

/**
 * Отклонение §7.10 В ЧУЖОЙ ТРАНЗАКЦИИ — тело rejectPending без собственного withIdentity.
 * Журнал append-only (§4.6): карточка-запрос не правится, в её тред пишется НОВОЕ
 * системное сообщение {type:'confirmation_rejected', rejects} с детерминированным PK
 * rejectMessageId(owner, pendingId) — идемпотентность reject по PK, как у audit-сообщений
 * (§7.8). Уже исполненный pending отклонить нельзя (audit-сообщение по детерминированному
 * PK уже существует) → VALIDATION.
 *
 * Сериализация против approve (fix round): advisory-lock по pendingId берётся ЗДЕСЬ, до
 * первого чтения состояния (см. док acquirePendingLock) — конкурентный approve держит тот
 * же замок в audit-tx; проверка «уже исполнено» идёт строго после захвата, поэтому видит
 * его закоммиченный audit (или сама коммитится первой, и approve увидит reject).
 * Повторный reject идемпотентен: проверка isRejected под замком + ON CONFLICT DO NOTHING
 * по детерминированному PK (двойная страховка — второго сообщения не бывает).
 *
 * Причина (V1.8) определяет текст сообщения и уезжает в metadata.reason. Повторный
 * reject возвращает ИСХОДНУЮ причину, а не переданную: сообщение append-only, и врать
 * про то, что записано в ленте, нельзя — раннер, гасящий уже отклонённое владельцем
 * предложение, обязан увидеть 'owner', а не своё 'superseded'.
 *
 * КОНТРАКТ ВЫЗЫВАТЕЛЯ:
 *  - tx открыт withIdentity(db, ownerId) для ТОГО ЖЕ владельца. Проверка этого стоила бы
 *    round-trip на каждый вызов, поэтому её нет: findPendingMessage/rejectedReason
 *    скоупит RLS по identity транзакции, а rejectMessageId/batchAuditMessageId считаются
 *    от args.ownerId — рассинхрон дал бы отказ мимо цели. Тот же контракт у createPending.
 *  - никакого чтения состояния этого pendingId в этой транзакции ДО вызова: замок берётся
 *    здесь, и прочитанное раньше — снапшот до захвата (тот самый write-skew). Вызывателю,
 *    которому состояние нужно раньше (лестница Ш1.5), — сначала acquirePendingLock.
 *  - функция БРОСАЕТ ExecError вместо {ok:false}: внутри чужой транзакции отказ обязан её
 *    откатить, а не позволить закоммитить половину лестницы. alreadyRejected при этом НЕ
 *    ошибка и возвращается значением — решать по чужой причине вызывателю.
 */
export async function rejectPendingTx(
  tx: Tx,
  args: RejectPendingArgs,
): Promise<RejectPendingTxResult> {
  const reason = args.reason ?? 'owner';
  await acquirePendingLock(tx, args.pendingId); // до первого чтения — см. док выше
  const msg = await findPendingMessage(tx, args.pendingId);
  if (!msg) {
    throw new ExecError('NOT_FOUND', `pending-подтверждение ${args.pendingId} не найдено`, {
      pendingId: args.pendingId,
    });
  }
  // Гейт — в tx-форме, а не в обёртке: иначе мимо него прошли бы вызовы из открытых
  // транзакций (лестница правки Ш1, гашение пачки)
  assertNotQuestion(msg.pending);
  const auditId = batchAuditMessageId(args.ownerId, args.pendingId);
  const executed = await tx
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(eq(chatMessages.id, auditId));
  if (executed.length > 0) {
    throw new ExecError(
      'VALIDATION',
      `подтверждение ${args.pendingId} уже исполнено — отклонить нельзя`,
      { pendingId: args.pendingId, auditId },
    );
  }
  const already = await rejectedReason(tx, args.pendingId);
  if (already !== undefined) {
    return {
      pendingId: args.pendingId,
      alreadyRejected: true,
      reason: already,
      threadId: msg.threadId,
    };
  }
  await appendMessageIdempotent(tx, {
    id: rejectMessageId(args.ownerId, args.pendingId),
    threadId: msg.threadId,
    role: 'system',
    content: args.text ?? REJECT_CONTENT[reason],
    metadata: { type: 'confirmation_rejected', rejects: args.pendingId, reason },
  });
  return {
    pendingId: args.pendingId,
    alreadyRejected: false,
    reason,
    threadId: msg.threadId,
  };
}

/**
 * Отклонение §7.10 собственной транзакцией — публичный вход для всех, у кого своей ещё
 * нет (кнопка владельца, раннер рутины, компенсация propose). Вся семантика — в
 * rejectPendingTx; здесь только identity-транзакция и превращение ExecError в
 * {ok:false}. try/catch стоит СНАРУЖИ withIdentity намеренно: брошенный внутри ExecError
 * сначала откатывает транзакцию и только потом становится структурным отказом.
 *
 * ИЗНУТРИ ОТКРЫТОЙ ТРАНЗАКЦИИ ЭТУ ФУНКЦИЮ ЗВАТЬ НЕЛЬЗЯ. Вложенного tx у postgres-js нет:
 * db.transaction резервирует ДРУГУЮ коннекцию пула, и вызов повиснет на собственном же
 * advisory-замке, который держит внешняя транзакция, — до statement_timeout (замерено
 * 2546 мс до отказа). Это не ошибка компиляции и не исключение по месту, а зависание,
 * которое найдёт только ревью. Из открытой транзакции — только rejectPendingTx(tx, …).
 */
export async function rejectPending(db: Db, args: RejectPendingArgs): Promise<RejectPendingResult> {
  try {
    const r = await withIdentity(db, args.ownerId, (tx) => rejectPendingTx(tx, args));
    return { ok: true, ...r };
  } catch (e) {
    if (e instanceof ExecError) {
      return { ok: false, error: { code: e.code, message: e.message, details: e.details } };
    }
    throw e;
  }
}

/**
 * Гейт рода записи для судеб ВОПРОСА — зеркало `assertNotQuestion`: на действие
 * отвечать нечем, его принимают. Запись сюда чужой судьбы сделала бы действие
 * «отвеченным» для пачки, а approve — по-прежнему возможным: две судьбы у одной единицы.
 *
 * Запись без `kind` (чатовый pending, предложение рутины) читается как действие — то же
 * правило обратной совместимости, что в `pendingRecord`.
 */
function assertQuestion(pending: PendingRecord): void {
  if (pending.kind !== 'question') {
    throw new ExecError('VALIDATION', 'это действие — его принимают, а не отвечают', {
      pendingId: pending.id,
    });
  }
}

/** Судьбы вопроса, НАЙДЕННЫЕ в ленте по двум детерминированным PK. */
interface QuestionFates {
  /** Ответ записан; `null` — сообщение есть, а строки `answer` в его metadata нет. */
  answer?: string | null;
  /** Гашение записано. */
  staled?: true;
}

/**
 * Перечитка ОБЕИХ судеб вопроса под уже взятым замком — сердце правила единственности
 * (ОЧ.8): судьба у вопроса одна, и держится это тем, что каждая из двух процедур перед
 * записью смотрит НЕ ТОЛЬКО на свой PK, но и на чужой. Смотреть только на свой — значит
 * писать вторую судьбу поверх первой; смотреть без замка — значит успеть сделать это
 * между чужой проверкой и чужим коммитом.
 *
 * Найденное СОБИРАЕТСЯ, а решение принимается вызывателями отдельным шагом: порядок
 * строк в `IN`-выборке произволен, и правило «ответ важнее гашения», написанное
 * присваиванием по ходу строк, было бы зелёным случайно (урок Задачи 2). Здесь каждая
 * строка раскладывается по СВОЕМУ ключу, а не по своему номеру.
 */
async function readQuestionFates(
  tx: Tx,
  ownerId: string,
  pendingId: string,
): Promise<QuestionFates> {
  const answerId = answerMessageId(ownerId, pendingId);
  const staleId = questionStaleMessageId(ownerId, pendingId);
  const rows = await tx
    .select({ id: chatMessages.id, metadata: chatMessages.metadata })
    .from(chatMessages)
    .where(inArray(chatMessages.id, [answerId, staleId]));
  const fates: QuestionFates = {};
  for (const row of rows) {
    if (row.id === answerId) {
      const answer = (row.metadata as { answer?: unknown }).answer;
      fates.answer = typeof answer === 'string' ? answer : null;
    } else if (row.id === staleId) {
      fates.staled = true;
    }
  }
  return fates;
}

/**
 * Исход ответа на вопрос пачки (ОЧ.9). Ошибки в союз НЕ входят и бросаются `ExecError`
 * (NOT_FOUND на чужом и несуществующем, VALIDATION на действии): союз описывает СУДЬБУ
 * вопроса, и «ошибка значением» в том же поле, где лежит применившийся ответ, заставила
 * бы роутер различать их по строке.
 */
export type AnswerQuestionResult =
  | { status: 'answered'; pendingId: string } // записан этот ответ — или его replay
  | { status: 'already'; answer: string } // раньше применился ДРУГОЙ ответ (С5)
  | { status: 'stale' }; // вопрос погашен, ответ НЕ записан (В2)

/**
 * Ответ владельца на вопрос пачки (§6, ОЧ.8/ОЧ.9): append-сообщение с детерминированным
 * PK `answerMessageId(owner, pendingId)`; сама pending-запись не правится (§4.6), как и
 * у остальных судеб.
 *
 * Автор ответа — ВЛАДЕЛЕЦ: `role:'user'` + `source:'ui'` (§6/§9.5 «ответы — ui-сообщения»),
 * в отличие от гашения, автор которого — система. Сообщение не несёт `metadata.actions`,
 * поэтому в журнал §7.8 и в Undo не попадает — это требование инварианта §9.5, а не
 * деталь: ответ владельца ничего не меняет в графе и откатывать в нём нечего.
 *
 * ЕДИНСТВЕННОСТЬ СУДЬБЫ (ОЧ.8, Б4 ревью): замок берётся ДО ПЕРВОГО ЧТЕНИЯ СОСТОЯНИЯ (см.
 * док `acquirePendingLock`), под ним перечитываются ОБА PK, первая записанная судьба
 * финальна. Порядок разбора найденного:
 *  - записан ответ, ТОТ ЖЕ текст → replay `answered`: повтор кнопки — не вторая запись;
 *  - записан ответ, ДРУГОЙ текст → `already` с ПРИМЕНИВШИМСЯ (С5 ревью): молча схлопнуть
 *    два разных ответа в «принято» нельзя — владелец ушёл бы уверенным, что рутина
 *    пойдёт по второму;
 *  - записано гашение → `stale` БЕЗ записи (В2): карточка показывает «снят следующим
 *    прогоном» и ответа не принимает.
 * Ответ проверяется РАНЬШЕ гашения намеренно. Обе записи разом эти процедуры не создают
 * (каждая уступает чужой судьбе под общим замком), но если они всё же встретились в
 * ленте — запись мимо процедур, крэш чужого пути, — истина та же, что у читателя пачки:
 * ОТВЕТ ВАЖНЕЕ ГАШЕНИЯ (`listRunUnits`, ОЧ.8). Иначе процедура отвечала бы «снят» про
 * вопрос, который в ленте помечен решённым.
 *
 * ИЗНУТРИ ОТКРЫТОЙ ТРАНЗАКЦИИ ЗВАТЬ НЕЛЬЗЯ — тот же капкан, что у `rejectPending`:
 * вложенного tx у postgres-js нет, `db.transaction` резервирует ДРУГУЮ коннекцию пула, и
 * вызов повиснет на собственном advisory-замке, который держит внешняя транзакция, — до
 * statement_timeout (замерено 2546 мс). Это не ошибка компиляции и не исключение по
 * месту, а зависание, которое найдёт только ревью. Tx-варианта у судеб вопроса пока нет
 * намеренно: единственный вызыватель гашения из недр (`closeOpenOfRun`) принимает `deps`
 * и открывает `withIdentity` по месту, а ответ приходит только роутером. Понадобится
 * вызвать из открытой транзакции — заводить tx-форму, как у `rejectPendingTx`.
 */
export async function answerPendingQuestion(
  db: Db,
  args: { ownerId: string; pendingId: string; answer: string; option?: number },
): Promise<AnswerQuestionResult> {
  return withIdentity(db, args.ownerId, async (tx): Promise<AnswerQuestionResult> => {
    await acquirePendingLock(tx, args.pendingId); // до первого чтения состояния
    const msg = await findPendingMessage(tx, args.pendingId);
    if (!msg) {
      // Чужой и несуществующий неразличимы (RLS скоупит журнал владельцем) — как у
      // approve/reject: по коду отказа нельзя узнать о чужих вопросах
      throw new ExecError('NOT_FOUND', `вопрос ${args.pendingId} не найден`, {
        pendingId: args.pendingId,
      });
    }
    assertQuestion(msg.pending); // род записи неизменяем — перепроверять под замком нечего
    const fates = await readQuestionFates(tx, args.ownerId, args.pendingId);
    if (fates.answer !== undefined) {
      if (fates.answer === args.answer) return { status: 'answered', pendingId: args.pendingId };
      // `null` — сообщение ответа без текста (запись мимо процедуры): показать нечего,
      // но выдать это за «твой ответ принят» нельзя — С5 запрещает схлопывание
      return { status: 'already', answer: fates.answer ?? '' };
    }
    if (fates.staled === true) return { status: 'stale' };
    await appendMessageIdempotent(tx, {
      id: answerMessageId(args.ownerId, args.pendingId),
      threadId: msg.threadId, // тред карточки-запроса: ответ ложится в ту же ленту
      role: 'user',
      content: `Ответ: «${args.answer}»`,
      metadata: {
        type: 'question_answered',
        answers: args.pendingId,
        answer: args.answer,
        // Условная запись, как у `run_id`/`edited_from`: `option` — ИНДЕКС выбранного
        // варианта (0..3), у свободного ответа его нет вовсе. Текст ответа при выборе
        // кнопки — в `answer`, поэтому читателям пачки индекс не нужен
        ...(args.option !== undefined && { option: args.option }),
        source: 'ui',
      },
    });
    return { status: 'answered', pendingId: args.pendingId };
  });
}

/**
 * Гашение вопроса пачки (ОЧ.8): нерешённые единицы прошлых прогонов снимает новый
 * прогон — плановый или «Продолжить сейчас». Append-сообщение с детерминированным PK
 * `questionStaleMessageId(owner, pendingId)`, автор — СИСТЕМА (`role:'system'`), в отличие
 * от ответа. `metadata.actions` нет, как и у ответа: в журнал §7.8 и Undo не попадает.
 *
 * `text` — параметром, а не таблицей причин: у гашения вопроса нет `RejectReason`
 * (четвёрка причин описывает судьбу ДЕЙСТВИЯ), а формулировка зависит от того, кто гасит
 * — следующий прогон, откат или «Продолжить сейчас».
 *
 * `staled:false` — судьба уже записана, и НЕ ЭТА: либо вопрос отвечен (ОТВЕТ ВАЖНЕЕ
 * ГАШЕНИЯ, ОЧ.8 — то же правило, что у терминального пути `lifecycle.ts:331-334`: сказать
 * владельцу «снято» про то, что он уже решил, — потерять его решение), либо уже погашен
 * раньше (повтор идемпотентен, исходный текст не переписывается — журнал append-only).
 * Отличать эти два случая вызывателю не нужно: и там, и там гасить нечего.
 *
 * Замок, перечитка обоих PK и запрет вызова ИЗНУТРИ ОТКРЫТОЙ ТРАНЗАКЦИИ — те же, что у
 * `answerPendingQuestion`; см. её докблок.
 */
export async function stalePendingQuestion(
  db: Db,
  args: { ownerId: string; pendingId: string; text: string },
): Promise<{ staled: boolean }> {
  return withIdentity(db, args.ownerId, async (tx) => {
    await acquirePendingLock(tx, args.pendingId); // до первого чтения состояния
    const msg = await findPendingMessage(tx, args.pendingId);
    if (!msg) {
      throw new ExecError('NOT_FOUND', `вопрос ${args.pendingId} не найден`, {
        pendingId: args.pendingId,
      });
    }
    assertQuestion(msg.pending);
    const fates = await readQuestionFates(tx, args.ownerId, args.pendingId);
    if (fates.answer !== undefined || fates.staled === true) return { staled: false };
    await appendMessageIdempotent(tx, {
      id: questionStaleMessageId(args.ownerId, args.pendingId),
      threadId: msg.threadId,
      role: 'system',
      content: args.text,
      metadata: { type: 'question_stale', stales: args.pendingId },
    });
    return { staled: true };
  });
}

/**
 * Единица пачки прогона (D42): отложенное действие или вопрос — вместе с судьбой.
 *
 * ВАЖНО читателям: `fate:'stale'` достижим ТОЛЬКО у вопросов. Погашенное или протухшее
 * ДЕЙСТВИЕ — это `fate:'rejected'` с причиной: `'owner'` — «отклонено», `'stale'` —
 * «устарело», `'superseded'` — «снято новым прогоном», `'edited'` — «заменено правкой».
 * Подпись в UI выводится из ПАРЫ `fate + reason`, а не из одного поля.
 */
export interface RunUnit {
  pendingId: string;
  kind: 'question' | 'action';
  /** Метка самой записи (`metadata.pending.created_at`), а не строки ленты. */
  createdAt: string;
  question?: string; // kind:'question'
  options?: string[]; // kind:'question'
  tool?: string; // kind:'action'
  input?: Record<string, unknown>; // kind:'action'
  /** Карточка из `metadata.cards[0]` — то, что владелец видит в ленте. */
  card?: Card;
  fate: 'open' | 'approved' | 'rejected' | 'answered' | 'stale';
  reason?: RejectReason; // fate:'rejected'
  answer?: string; // fate:'answered'
}

/**
 * Единицы прогона с судьбами — единая проба для всех читателей пачки (сверка `undecided`,
 * «принять все», гашение, история, экран прогона).
 *
 * ТОЛЬКО записи с ЯВНЫМ `kind` (Б5 ревью): предложение рутины (`orbis_propose`) живёт под
 * тем же `run_id`, но `kind` не несёт — и в пачку не попадает. Именно поэтому у единиц
 * ключ обязателен и явен, а правило «нет `kind` = действие» оставлено только одиночному
 * чтению по id.
 *
 * ДВА запроса, и это дешевле одного на каждую единицу:
 *  1) единицы — ОДИН containment-запрос с OR по двум пробам. Обоснование — не «оба по
 *     GIN»: под RLS containment идёт Seq Scan (`jsonb_contains` не leakproof — замер Ш1,
 *     `routines/lifecycle.ts`, докблок `liveProposalRuns`), поэтому выигрыш в том, что
 *     таблица проходится ОДИН раз вместо двух, а дедуп и порядок получаются построением;
 *  2) судьбы — SELECT по IN-списку детерминированных PK (`uuid_eq` leakproof, индекс под
 *     RLS берётся): approve → `batchAuditMessageId`, reject → `rejectMessageId`, ответ →
 *     `answerMessageId`, гашение → `questionStaleMessageId`. Ни одной пробы по ленте.
 *
 * Порядок — `created_at, id`: тай-брейк по id обязателен, иначе обход пачки («принять
 * все») в разных вызовах шёл бы по единицам вразнобой — сводка разъезжалась бы со списком
 * карточек на экране. Это НЕ защита от дедлока, и записывать её так нельзя: замок берётся
 * по одному ключу на транзакцию и отпускается на коммите (`acquirePendingLock` выше), а
 * каждая единица решается своей короткой транзакцией — двух замков разом никто не держит,
 * и цикл из них непостроим. Разбор целиком — докблок `decideAllOfRun` (routines/lifecycle).
 *
 * ОТВЕТ ВАЖНЕЕ ГАШЕНИЯ (ОЧ.8): если у вопроса есть и ответ, и гашение (крэш между шагами
 * следующего прогона), судьба — `answered`. То же правило, что у терминального пути.
 *
 * КОНТРАКТ ВЫЗЫВАТЕЛЯ (Minor-1 ревью Задачи 2), тот же, что у `rejectPendingTx`: tx обязан
 * быть открыт `withIdentity(db, ownerId)` для ТОГО ЖЕ владельца. Проверка этого стоила бы
 * round-trip на каждый вызов, поэтому её нет, а цена рассинхрона МОЛЧАЛИВАЯ и потому
 * высокая: строки единиц скоупит RLS транзакции, а PK судеб считаются от переданного
 * `ownerId` — единицы вернутся, но ни одна судьба не найдётся, и ВСЯ пачка прочитается
 * как `open`. Владелец увидит навсегда нерешённую пачку, «Принять все» будет повторно
 * жевать решённое, а сверка `undecided` никогда не снимет флажок. Ошибки при этом нет
 * нигде — пин в `pending.test.ts` фиксирует именно этот исход.
 */
export async function listRunUnits(tx: Tx, ownerId: string, runId: string): Promise<RunUnit[]> {
  const asQuestion = JSON.stringify({ pending: { run_id: runId, kind: 'question' } });
  const asAction = JSON.stringify({ pending: { run_id: runId, kind: 'action' } });
  const rows = await tx.execute(
    sql`SELECT id, metadata FROM chat_messages
        WHERE metadata @> ${asQuestion}::jsonb OR metadata @> ${asAction}::jsonb
        ORDER BY created_at, id`,
  );

  const units: RunUnit[] = [];
  /** PK судьбы → чья она и что означает; из ключей складывается второй запрос. */
  const fateKeys = new Map<string, { pendingId: string; fate: RunUnit['fate'] }>();
  for (const raw of rows as unknown as Array<Record<string, unknown>>) {
    const record = parsePendingRecord(
      raw.id as string,
      (raw.metadata as { pending?: unknown }).pending,
    );
    const kind = record.kind;
    if (kind === undefined) {
      // Недостижимо: проба отбирает только записи с явным kind. Но молча пропустить
      // такую строку нельзя — пачка выглядела бы решённой, пока в ней висит открытое
      throw new ExecError('VALIDATION', 'pending-запись повреждена — единица без kind', {
        pendingId: record.id,
      });
    }
    const card = (raw.metadata as { cards?: unknown[] }).cards?.[0] as Card | undefined;
    units.push({
      pendingId: record.id,
      kind,
      createdAt: record.created_at,
      ...(record.question !== undefined && { question: record.question }),
      ...(record.options !== undefined && { options: record.options }),
      ...(record.tool !== undefined && { tool: record.tool }),
      ...(record.input !== undefined && { input: record.input }),
      ...(card !== undefined && { card }),
      fate: 'open',
    });
    if (kind === 'question') {
      fateKeys.set(answerMessageId(ownerId, record.id), { pendingId: record.id, fate: 'answered' });
      fateKeys.set(questionStaleMessageId(ownerId, record.id), {
        pendingId: record.id,
        fate: 'stale',
      });
    } else {
      fateKeys.set(batchAuditMessageId(ownerId, record.id), {
        pendingId: record.id,
        fate: 'approved',
      });
      fateKeys.set(rejectMessageId(ownerId, record.id), { pendingId: record.id, fate: 'rejected' });
    }
  }
  if (fateKeys.size === 0) return units;

  const fates = await tx
    .select({ id: chatMessages.id, metadata: chatMessages.metadata })
    .from(chatMessages)
    .where(inArray(chatMessages.id, [...fateKeys.keys()]));
  /** Что НАШЛОСЬ по каждой единице; выбор судьбы — ниже, отдельно от порядка выборки. */
  const found = new Map<string, WrittenFates>();
  for (const row of fates) {
    const key = fateKeys.get(row.id);
    if (key === undefined) continue; // недостижимо: список PK и составил этот запрос
    const metadata = row.metadata as { reason?: unknown; answer?: unknown };
    const seen = found.get(key.pendingId) ?? {};
    if (key.fate === 'answered') {
      seen.answer = typeof metadata.answer === 'string' ? metadata.answer : null;
    } else if (key.fate === 'stale') {
      seen.stale = true;
    } else if (key.fate === 'approved') {
      seen.approved = true;
    } else {
      // Та же терпимость к истории, что у rejectedReason: сообщение без причины —
      // отказ владельца (до V1.8 отклонить мог только он)
      const parsed = rejectReason.safeParse(metadata.reason);
      seen.rejected = parsed.success ? parsed.data : 'owner';
    }
    found.set(key.pendingId, seen);
  }

  for (const unit of units) {
    const seen = found.get(unit.pendingId);
    if (seen === undefined) continue; // ни одной судьбы не записано — единица открыта
    if (unit.kind === 'question') {
      // ОТВЕТ ВАЖНЕЕ ГАШЕНИЯ (ОЧ.8). Выбор сделан ЗДЕСЬ, а не присваиванием по ходу
      // выборки: порядок строк в IN-запросе произволен, и правило, зависящее от него,
      // было бы зелёным случайно.
      if (seen.answer !== undefined) {
        unit.fate = 'answered';
        if (seen.answer !== null) unit.answer = seen.answer;
      } else if (seen.stale === true) {
        unit.fate = 'stale';
      }
      continue;
    }
    // У действия судьбы взаимоисключены замком (approve ∥ reject), но если в ленте
    // лежат обе — истина та, что ИСПОЛНЕНА: эффект в графе уже есть
    if (seen.approved === true) {
      unit.fate = 'approved';
    } else if (seen.rejected !== undefined) {
      unit.fate = 'rejected';
      unit.reason = seen.rejected;
    }
  }
  return units;
}

/** Судьбы, НАЙДЕННЫЕ в ленте по детерминированным PK: `answer: null` — ответ без текста. */
interface WrittenFates {
  approved?: true;
  rejected?: RejectReason;
  answer?: string | null;
  stale?: true;
}
