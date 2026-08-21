// apps/server/src/routines/proposal-diff.ts
// Дифф тела предложения для ПОКАЗА (Ш1.1, Ш1.2): владелец обязан видеть, ЧТО рутина меняет в
// тексте, а не стену нового текста, под которой различие приходится искать глазами.
//
// Считает сервер, а не клиент. Клиенту дифф нужен второй раз — в режиме правки, когда тело
// меняется под руками (Ш1.11), — и там он свой; здесь же показ обязан совпадать с тем, что
// произойдёт на «Принять», а это знание серверное: снятое CAS по `updated_at`, тело записи
// под RLS, канон предложенного markdown.
//
// Почему отдельный модуль, а не ещё один кусок lifecycle.ts (1993 строки и несколько
// несвязных тем): тема здесь ровно одна — как из payload'а предложения и тела записи
// получается картинка различий, и у неё своё чтение БД, свои потолки и своя цена. Ни одной
// приватной функции lifecycle.ts она не требует, поэтому ребро одностороннее
// (`lifecycle` → `proposal-diff`) и цикла не даёт.
//
// Кеша здесь нет намеренно (Развилка 7): открытое предложение у рутины не больше одного
// (V1.8), дифф считается только для `pending` и только по запросу карточки, а худший случай
// держат до-разборные потолки.
import { bodyDocSchema } from '@orbis/shared';
import {
  type BodyDoc,
  bodyDocError,
  canonicalizeBody,
  readBodyDoc,
  serializeBody,
} from '@orbis/shared/doc';
import { type BodyDiffSkipReason, type DiffUnit, diffBodyDocs } from '@orbis/shared/doc/diff';
import { inArray } from 'drizzle-orm';
import { entities } from '../db/schema';
import type { Tx } from '../db/with-identity';
import { PROPOSAL_DIFF_MAX_BODY_BYTES, PROPOSAL_DIFF_MAX_SOURCE_LINES } from './constants';
import { hasBody } from './edits';

/**
 * Различие тела для строки предложения — либо единицы показа, либо ПРИЧИНА, по которой их
 * нет. Молчаливого отсутствия быть не должно: «дифф не построен» это состояние, о котором
 * владельцу говорят словами, а не пустое место на экране.
 *
 * `body_changed` — своя причина сверх тех, что знает сам `diffBodyDocs`: тело записи тронуто
 * после составления предложения, и рисовать по нему различие нельзя (см. `diffRow`).
 */
export type ProposalBodyDiff =
  | { units: DiffUnit[] }
  | { skipped: 'body_changed' | BodyDiffSkipReason };

/** Всё, что показ добавляет к строке тела предложения. */
export interface ProposalBodyRow {
  /**
   * Полный markdown «станет» — запасная форма показа: она была строкой тела до Ш1 и
   * остаётся ею при любом `skipped` (приёмка 16 — кнопки живы, форма прежняя). У правленого
   * предложения тело едет документом, и здесь лежит его проекция.
   */
  after?: string;
  bodyDiff?: ProposalBodyDiff;
  /**
   * Документ предложенного тела — редактору слоя правки (Ш1.3, Ш1.11): его владелец
   * открывает и правит, по нему клиент считает свой дифф.
   *
   * Есть ровно тогда, когда сервер довёл предложенное тело ДО ДОКУМЕНТА, — и это условие
   * про РАЗБОР, а не про исход диффа. Документ отдаётся и при `units`, и при обоих
   * ПОСЛЕ-разборных отказах: `rewritten`, а равно и `too_large` по `maxBlocks` — там разбор
   * уже состоялся, и открывать владельцу есть что.
   *
   * Нет его в двух случаях, и оба — «разбора не было»: `body_changed` (за него не брались,
   * принимать всё равно нечего) и ДО-разборный `too_large` (`PROPOSAL_DIFF_MAX_*` в
   * `diffRow`) — там документ и есть то, чего потолок не даёт построить.
   *
   * Различать это обязательно: одно слово `too_large` носят два разных отказа, и «при
   * `too_large` документа нет» — неправда ровно в половине случаев.
   */
  proposedDoc?: BodyDoc;
}

/** Операция payload'а в том виде, в каком её читает показ (см. StoredOperation lifecycle.ts). */
interface OperationLike {
  tool: string;
  input: Record<string, unknown>;
}

/**
 * Строки тела предложения по номеру операции: `after`, а для живого предложения ещё и дифф с
 * документом. Ключ карты — тот же `index`, которым строки адресует экран.
 *
 * `withDiff` — это `status === 'pending'` вызывающего (Ш1.1): у решённого предложения дифф не
 * считается вовсе. Решать по нему нечего, а тело записи с тех пор ушло вперёд — «различие»
 * между принятым предложением и сегодняшним телом рассказывало бы не о предложении.
 */
export async function proposalBodyRows(
  tx: Tx,
  operations: readonly OperationLike[],
  args: { withDiff: boolean },
): Promise<Map<number, ProposalBodyRow>> {
  const targets: BodyTarget[] = [];
  for (const [index, op] of operations.entries()) {
    // Тело правит только `entity_update`: у создания записи «было» не существует
    if (op.tool === 'entity_update' && hasBody(op.input)) targets.push(bodyTarget(index, op.input));
  }
  const rows = new Map<number, ProposalBodyRow>();
  if (targets.length === 0) return rows;
  if (!args.withDiff) {
    for (const target of targets) rows.set(target.index, textRow(target));
    return rows;
  }
  const current = await currentBodies(
    tx,
    targets.map((t) => t.id),
  );
  for (const target of targets) rows.set(target.index, diffRow(target, current.get(target.id)));
  return rows;
}

/** Цель одной строки тела: что предложено и с чем это сверять. */
interface BodyTarget {
  index: number;
  id: string;
  /** CAS, снятый при составлении (propose.ts ставит его только при правке тела). */
  expectedUpdatedAt?: string;
  /** markdown «станет»; `undefined` — тело в payload'е нечитаемо (см. `editedDoc`). */
  after?: string;
  /** Документ «станет» у ПРАВЛЕНОГО предложения — он же уедет в запись, канонизировать нечего. */
  edited?: BodyDoc;
}

function bodyTarget(index: number, input: Record<string, unknown>): BodyTarget {
  const id = String(input.id);
  const expected =
    typeof input.expectedUpdatedAt === 'string' ? input.expectedUpdatedAt : undefined;
  const base = { index, id, ...(expected !== undefined && { expectedUpdatedAt: expected }) };
  // Исходное предложение несёт тело markdown-строкой, правленое — документом (Ш1.11); ключ
  // строки предложения у обеих форм общий (`body`), поэтому и строка показа одна
  if (typeof input.body === 'string') return { ...base, after: input.body };
  const edited = editedDoc(input.bodyDoc);
  if (edited === null) return base;
  return { ...base, after: serializeBody(edited), edited };
}

/**
 * Документ правленого тела из payload'а. Форма спрашивается ДВАЖДЫ и обе проверки нужны:
 * `bodyDocSchema` — что это вообще `{v, doc}` (payload приезжает из jsonb сырым), а
 * `bodyDocError` — что документ пригоден ПО СХЕМЕ, потому что `serializeBody` на непригодном
 * падает TypeError'ом из недр @tiptap/markdown (то же место знает executor.ts).
 *
 * `null` в проде недостижим: `buildEditedOperations` парсит каждую операцию P2 контрактом
 * `entityUpdateExecInput` ещё до создания предложения. Ветка существует потому, что показ не
 * вправе падать от содержимого БД: строка тела остаётся на месте (иначе владелец не увидит,
 * что предложение вообще правит тело), но ни диффа, ни документа по нечитаемому телу не
 * отдаётся — показывать нечего, и придумывать нечего.
 */
function editedDoc(value: unknown): BodyDoc | null {
  const parsed = bodyDocSchema.safeParse(value);
  if (!parsed.success) return null;
  const doc = parsed.data as BodyDoc;
  return bodyDocError(doc) === undefined ? doc : null;
}

/** Строка решённого предложения: только текст «станет», без диффа и без документа. */
function textRow(target: BodyTarget): ProposalBodyRow {
  return target.after === undefined ? {} : { after: target.after };
}

/**
 * Строка живого предложения. Порядок проверок — не вкусовой:
 *
 *  1. тело записи тронуто после составления → `body_changed` и НИКАКОГО диффа. Дифф против
 *     нового тела нарисовал бы согласие там, где «Принять» ответит отказом (CAS по
 *     `updated_at` проверяет executor, и он же вернёт STALE_VERSION);
 *  2. до-разборные потолки на ОБЕ стороны → `too_large`. Именно до разбора: сторож стоит
 *     0.22 мс на худшем РАЗРЕШЁННОМ теле (64 КБ, 300 строк — замерено на этой реализации),
 *     а `canonicalizeBody` того же тела — 190–225 мс, и до полутора секунд на 236 КБ;
 *  3. «было» — документом (`readBodyDoc`, 0.9 мс против 225 у канона на теле у границы); у
 *     записи без `body_doc` платится полная цена `parseBody`, и потому потолок применяется
 *     и к этой стороне тоже — бэкфилл на проде не предусловие (В-3). Цена решения —
 *     консервативность: у записи С документом сторона «было» стоила бы 0.9 мс при любом
 *     размере, а потолок её всё равно отсечёт. Разделить ветки значило бы отвечать на вопрос
 *     «покажется ли дифф» по-разному в зависимости от того, дошёл ли до записи бэкфилл;
 *  4. «стало» — сам присланный документ у правленого предложения (канонизировать его нельзя:
 *     канон снёс бы блочные id, а в запись уедет ровно вход) или канон markdown у исходного.
 */
function diffRow(target: BodyTarget, current: CurrentBody | undefined): ProposalBodyRow {
  const row = textRow(target);
  if (target.after === undefined) return row;

  // Записи не видно (удалена или не наша) и CAS без значения — тот же исход: доказать, что
  // тело то самое, нечем, а показывать различие с недоказанным «было» нельзя
  if (
    current === undefined ||
    target.expectedUpdatedAt === undefined ||
    current.updatedAt.toISOString() !== target.expectedUpdatedAt
  ) {
    return { ...row, bodyDiff: { skipped: 'body_changed' } };
  }
  if (overSourceLimit(target.after) || overSourceLimit(current.body)) {
    return { ...row, bodyDiff: { skipped: 'too_large' } };
  }

  const before = readBodyDoc(current.bodyDoc, current.body);
  const after = target.edited ?? canonicalizeBody(target.after).doc;
  // Своих `DiffLimits` сервер НЕ передаёт: четыре после-разборных числа (maxBlocks,
  // maxBlockWords, maxEditRatio, minEditBudget) живут умолчаниями в самом diff.ts, и вторая
  // их копия здесь разъехалась бы с первой молча — тем более что передача трёх полей из
  // четырёх молча берёт четвёртое из умолчаний. Двигать эти числа надо там, где они одни.
  return { ...row, bodyDiff: diffBodyDocs(before.doc, after.doc), proposedDoc: after };
}

/** Коды символов, по которым строка считается пустой, — перебор идёт без аллокаций. */
const CHAR_LF = 10;
const CHAR_CR = 13;
const CHAR_TAB = 9;
const CHAR_SPACE = 32;

/**
 * Сторож ДО разбора: байты и непустые строки. Потолки объяснены в constants.ts; здесь важно
 * одно — обе величины считаются перебором строки, без единого разбора markdown.
 *
 * Непустых строк не меньше, чем топ-уровневых блоков (блок занимает не меньше строки), а
 * цена канона билинейна по (байты × блоки) — то есть эта пара и есть верхняя оценка цены,
 * которую иначе пришлось бы сначала заплатить, чтобы узнать.
 */
function overSourceLimit(markdown: string): boolean {
  if (Buffer.byteLength(markdown, 'utf8') > PROPOSAL_DIFF_MAX_BODY_BYTES) return true;
  let lines = 0;
  let filled = false;
  for (let i = 0; i < markdown.length; i += 1) {
    const code = markdown.charCodeAt(i);
    if (code === CHAR_LF) {
      if (filled) lines += 1;
      if (lines > PROPOSAL_DIFF_MAX_SOURCE_LINES) return true;
      filled = false;
    } else if (code !== CHAR_SPACE && code !== CHAR_TAB && code !== CHAR_CR) {
      filled = true;
    }
  }
  return filled && lines + 1 > PROPOSAL_DIFF_MAX_SOURCE_LINES;
}

/** Тело записи «сейчас» — сторона «было» плюс отметка времени для CAS. */
interface CurrentBody {
  body: string;
  bodyDoc: unknown;
  updatedAt: Date;
}

/**
 * Тела целей ОТДЕЛЬНЫМ запросом, а не расширением `titlesOf`: заголовки нужны каждой строке
 * предложения, а тела — только строкам тела, и таскать body всех целей ради одной строки
 * значило бы возить мегабайты по всякому показу (тот же довод, по которому `body_doc` не
 * входит в компилятор запросов, wire.ts:63).
 *
 * Опровержение спеки, зафиксированное разведкой (Р-5): «сервер и так читает тело, чтобы снять
 * предусловия» — неверно. На пути показа выбираются `id, title` (`titlesOf`), на пути
 * составления — `{id, aspects, updatedAt}` (propose.ts): тела не читает ни один. Это чтение —
 * новое.
 */
async function currentBodies(tx: Tx, ids: readonly string[]): Promise<Map<string, CurrentBody>> {
  const out = new Map<string, CurrentBody>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return out;
  const rows = await tx
    .select({
      id: entities.id,
      body: entities.body,
      bodyDoc: entities.bodyDoc,
      updatedAt: entities.updatedAt,
    })
    .from(entities)
    .where(inArray(entities.id, unique));
  for (const row of rows) {
    out.set(row.id, { body: row.body, bodyDoc: row.bodyDoc, updatedAt: row.updatedAt });
  }
  return out;
}
