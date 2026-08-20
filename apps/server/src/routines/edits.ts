// apps/server/src/routines/edits.ts
// Правка предложения рутины владельцем ДО принятия (Ш1.4, Ш1.11, Развилка 3): контракт
// того, что владелец прислал, устойчивая личность этой правки и сборка правленого payload.
//
// Всё здесь — ЧИСТЫЕ функции: БД не читается, ничего не пишется. Лестницу транзакций
// (гашение P1 → создание P2 → перевод указателя → применение) строит вызывающий; ему
// нужны ровно три вещи, и все три обязаны быть проверяемы без БД:
//  1) `editsSchema` — форма правки на границе (скалярное значение, тело документом);
//  2) `editsHash` — детерминированная личность правки: из неё складывается `dedupeKey` P2,
//     а из него — его PK. Двойной тап по «Принять» обязан попасть в ТОТ ЖЕ pending, иначе
//     правка применится дважды;
//  3) `buildEditedOperations` — правленый payload, собранный из исходного так, что правка
//     меняет ЗНАЧЕНИЯ и не может изменить СОСТАВ предложения.
//
// Последнее — главный инвариант работы. Владелец согласился на список правок, который
// прочитал; правка значения остаётся его же решением, а появление в payload'е нового поля,
// новой операции или другого предусловия — это уже НЕ то предложение, которое он читал,
// и «принять» под ним значило бы применить непрочитанное. Поэтому состав и предусловия
// сверяются здесь же, а не только тестами: тест ловит ошибку у нас, проверка — в проде.
import { createHash } from 'node:crypto';
import {
  bodyDocSchema,
  canonicalJson,
  entityCreateInput,
  entityUpdateExecInput,
  relationCreateInput,
  relationDeleteInput,
} from '@orbis/shared';
import { z } from 'zod';
import { ExecError } from '../errors';
import { CORE_FIELD_LABELS, MAX_PROPOSAL_OPERATIONS } from './constants';

/**
 * Потолок правок полей. Не бюджет, а граница абсурда: правка приходит с экрана, где строк
 * столько же, сколько их у предложения из 50 операций (MAX_PROPOSAL_OPERATIONS), — своё
 * число, а не потолок операций, потому что строк у одной операции законно несколько.
 */
const MAX_FIELD_EDITS = 200;

/**
 * Правка тела: тело едет ДОКУМЕНТОМ (Ш1.11), а не markdown-строкой. Адресуется только
 * номером операции — тело у сущности одно, а `collides` (propose.ts:435-444) гарантирует,
 * что правка тела сущности X в предложении единственная.
 *
 * `bodyDocSchema` — та же схема, которой тело описывает контракт записи: второй zod-модели
 * дерева ProseMirror в кодовой базе нет и быть не должно (contracts/tools.ts:35-38).
 */
const bodyEditSchema = z
  .object({ index: z.number().int().min(0), bodyDoc: bodyDocSchema })
  .strict();

/**
 * Правка значения одного поля. `aspect` нет — поле вне аспектов (title/emoji/tags/…).
 *
 * Значение СКАЛЯРНОЕ намеренно: это граница Ш1.4, поставленная в контракт, а не в
 * проверку. Владелец правит строку предложения так же, как правит сырое поле записи, —
 * поштучно; массив или объект целиком это уже не «поправить значение», а «прислать своё
 * предложение». `null` внутри — осмысленное значение «пусто» (так его и печатает карточка).
 */
const fieldEditSchema = z
  .object({
    index: z.number().int().min(0),
    aspect: z.string().min(1).optional(),
    field: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  })
  .strict();

/** Правка предложения целиком: пустая (`{}`) — законный вход, он значит «без правок». */
export const editsSchema = z
  .object({
    body: z.array(bodyEditSchema).max(MAX_PROPOSAL_OPERATIONS).default([]),
    fields: z.array(fieldEditSchema).max(MAX_FIELD_EDITS).default([]),
  })
  .strict();
export type ProposalEdits = z.infer<typeof editsSchema>;

/** Правок нет — вызывающий обязан пойти сегодняшним путём: ни P2, ни лестницы. */
export function isEmptyEdits(edits: ProposalEdits): boolean {
  return edits.body.length === 0 && edits.fields.length === 0;
}

/**
 * Личность правки: sha256 от канонической формы, НИЖНИМ РЕГИСТРОМ HEX.
 *
 * Регистр — не косметика. Хеш уезжает в `dedupeKey` P2, а `pendingMessageId` ключ
 * ЛОУЭРКЕЙСИТ (ids.ts:63-64): в base64/base32 две разные правки, различающиеся только
 * регистром символа, схлопнулись бы в один PK, и владелец получил бы на свою правку чужую
 * карточку с ответом «применено» — ровно та беда, от которой детерминизм и защищает.
 *
 * Порядок элементов во входе личность НЕ меняет (клиент волен слать правки в порядке
 * экрана), порядок ключей объектов — тоже (`canonicalJson`, jsonb его не хранит).
 */
export function editsHash(edits: ProposalEdits): string {
  return createHash('sha256')
    .update(canonicalJson(normalizeEdits(edits)), 'utf8')
    .digest('hex');
}

/** Сортировки, задающие каноничный порядок массивов: body по index, fields по ключу строки. */
function normalizeEdits(edits: ProposalEdits): ProposalEdits {
  return {
    body: [...edits.body].sort((a, b) => a.index - b.index),
    fields: [...edits.fields].sort((a, b) => {
      if (a.index !== b.index) return a.index - b.index;
      const byAspect = compareText(a.aspect ?? '', b.aspect ?? '');
      return byAspect !== 0 ? byAspect : compareText(a.field, b.field);
    }),
  };
}

function compareText(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Причина отказа в `details.reason` — вызывающий различает их, не разбирая текст. */
type EditRejection =
  /** `index` правки указывает мимо payload'а. */
  | 'edit_index_out_of_range'
  /** Правка адресует ключ, которого в исходной операции нет (Б3: запись без предусловия). */
  | 'edit_key_missing'
  /** Правка тела там, где тела не было: писать его было бы не правкой, а дописыванием. */
  | 'edit_body_missing'
  /** Две правки одного ключа: последняя молча выиграла бы у первой. */
  | 'edit_duplicate'
  /** Исходную операцию нечем разобрать: не та форма или тул без контракта исполнения. */
  | 'edit_source_unsupported'
  /** После правки операция не проходит контракт своего тула. */
  | 'edit_result_invalid';

function reject(
  reason: EditRejection,
  message: string,
  details: Record<string, unknown>,
): ExecError {
  return new ExecError('VALIDATION', message, { reason, ...details });
}

/** Одна операция payload'а, как она лежит в `metadata.pending.input.operations`. */
const storedOperationSchema = z
  .object({ tool: z.string().min(1), input: z.record(z.unknown()) })
  .strict();
type StoredOperation = z.infer<typeof storedOperationSchema>;

/**
 * Контракт ИСПОЛНЕНИЯ каждого тула, допустимого в предложении (PROPOSAL_ALLOWED_TOOLS) —
 * зеркало диспетчера executor'а (`prepareOp` → `parseEnvelope`, по схеме на тул).
 *
 * Именно exec-форма, а не контракт входа тула (propose.ts OPERATION_SCHEMAS): в payload'е
 * уже лежат снятые предусловия и CAS тела, и `entityUpdateInput` отверг бы собственную
 * работу propose. И именно ПО ТУЛУ, а не безусловно `entityUpdateExecInput`: создание идёт
 * без предусловий (propose.ts:200-205), и одна схема на всех превратила бы нормальное
 * предложение в отказ у владельца на кнопке.
 *
 * `Map`, а не объект: имя тула приезжает из payload'а, а у объектного литерала поиск по
 * произвольной строке достаёт `constructor`/`toString` с прототипа — проверка «схемы нет»
 * прошла бы, и на `safeParse` функции конвейер упал бы TypeError вместо внятного отказа.
 */
const EXEC_SCHEMAS = new Map<string, z.ZodTypeAny>([
  ['entity_create', entityCreateInput],
  ['entity_update', entityUpdateExecInput],
  ['relation_create', relationCreateInput],
  ['relation_delete', relationDeleteInput],
]);

/**
 * Разделитель ключа строки предложения — NUL, а не пробел (как в `collides`,
 * propose.ts:451): имена полей приходят из схем аспектов владельца, и пробел ВНУТРИ
 * имени склеил бы два разных ключа в один, молча пропустив дубль правки.
 */
const KEY_SEP = '\u0000';

/** Ключ строки предложения: та же тройка, которой строки адресует экран владельца. */
function rowKey(index: number, aspect: string | undefined, field: string): string {
  return `${index}${KEY_SEP}${aspect ?? ''}${KEY_SEP}${field}`;
}

/**
 * Тело у операции есть в ЛЮБОЙ из двух форм. Ключ строки предложения у них общий (`body`):
 * подстановка документа вместо строки — это правка той же строки, а не новая.
 */
function hasBody(input: Record<string, unknown>): boolean {
  return input.body !== undefined || input.bodyDoc !== undefined;
}

/** Патч аспекта операции, если он там есть и это объект (снятие аспекта payload не несёт). */
function aspectPatch(
  input: Record<string, unknown>,
  aspect: string,
): Record<string, unknown> | undefined {
  const aspects = input.aspects as Record<string, unknown> | undefined;
  const patch = aspects?.[aspect];
  return patch !== null && typeof patch === 'object' && !Array.isArray(patch)
    ? (patch as Record<string, unknown>)
    : undefined;
}

/**
 * Множество ключей строк одной операции — то, что владелец видит списком и на что даёт
 * согласие. Считается из САМОЙ операции, а не из предусловий: у core-полей предусловий нет
 * (propose.ts:564-571 снимает их только по аспектам), а строками предложения они являются.
 */
function operationKeys(index: number, input: Record<string, unknown>): Set<string> {
  const keys = new Set<string>();
  const aspects = (input.aspects as Record<string, unknown> | undefined) ?? {};
  for (const aspect of Object.keys(aspects)) {
    const patch = aspectPatch(input, aspect);
    if (patch === undefined) continue;
    for (const field of Object.keys(patch)) keys.add(rowKey(index, aspect, field));
  }
  for (const field of Object.keys(CORE_FIELD_LABELS)) {
    if (field === 'body') {
      if (hasBody(input)) keys.add(rowKey(index, undefined, 'body'));
      continue;
    }
    if (input[field] !== undefined) keys.add(rowKey(index, undefined, field));
  }
  return keys;
}

function sameKeys(before: Set<string>, after: Set<string>): boolean {
  if (before.size !== after.size) return false;
  for (const key of before) if (!after.has(key)) return false;
  return true;
}

/**
 * Правленый payload P2 из исходного P1 и правок владельца.
 *
 * Что функция гарантирует вызывающему (проверяется здесь, а не только тестами):
 *  - операций столько же и в том же порядке — `index` правки и `index` строки на экране
 *    остаются одним и тем же числом;
 *  - множество ключей строк не изменилось: правка меняет значение, а не состав;
 *  - `precondition` каждой операции перенесено без изменений — сверяется каноническими
 *    формами, а не побайтно: payload приехал из jsonb, который порядок ключей нормализует;
 *  - `expectedUpdatedAt` перенесён КАК ЕСТЬ (Ш1.6): CAS снят при составлении предложения,
 *    и правка тела владельцем не делает его свежее;
 *  - каждая операция — включая непатченные — проходит контракт своего тула. Провал
 *    контракта, пропущенный здесь, вылезет у владельца на кнопке, внутри executor'а.
 *
 * Исходный массив не мутируется: вызывающий читает его же, сверяя, что предложил прогон.
 */
export function buildEditedOperations(operations: unknown[], edits: ProposalEdits): unknown[] {
  const source = operations.map((op, index) => parseSource(op, index));
  const result: StoredOperation[] = source.map((op) => ({ tool: op.tool, input: { ...op.input } }));
  const claimed = new Set<string>();

  for (const edit of edits.body) {
    const input = at(source, edit.index).input;
    if (!hasBody(input)) {
      throw reject(
        'edit_body_missing',
        `операция ${edit.index + 1} не правит тело — подставить его правкой нельзя (правка меняет значение строки, а не состав предложения)`,
        { index: edit.index },
      );
    }
    claim(claimed, edit.index, undefined, 'body');
    const target = at(result, edit.index).input;
    // XOR тела — refine, а не union (contracts/tools.ts:137-140): ключ `body` обязан УЙТИ,
    // иначе операция развалится не здесь, а в executor'е, у владельца на кнопке.
    delete target.body;
    target.bodyDoc = edit.bodyDoc;
  }

  for (const edit of edits.fields) {
    const input = at(source, edit.index).input;
    assertRowExists(input, edit.index, edit.aspect, edit.field);
    claim(claimed, edit.index, edit.aspect, edit.field);
    const target = at(result, edit.index).input;
    if (edit.aspect === undefined) {
      target[edit.field] = edit.value;
      continue;
    }
    // Копии, а не запись на месте: `aspects` и патч приехали из исходного payload'а.
    // Читается ТЕКУЩИЙ патч сборки, а не исходный: двум правкам одного аспекта иначе
    // выжила бы только последняя — первая молча потерялась бы вместе со своей строкой.
    const aspects = { ...(target.aspects as Record<string, unknown>) };
    aspects[edit.aspect] = { ...aspectPatch(target, edit.aspect), [edit.field]: edit.value };
    target.aspects = aspects;
  }

  assertInvariants(source, result);
  return result;
}

/** Операция payload'а по номеру — с отказом вместо `undefined`: правка мимо списка. */
function at(ops: StoredOperation[], index: number): StoredOperation {
  const op = ops[index];
  if (op === undefined) {
    throw reject('edit_index_out_of_range', `в предложении нет операции ${index + 1}`, {
      index,
      operations: ops.length,
    });
  }
  return op;
}

/** Разбор исходной операции: без формы и без контракта её тула править нечего и нечем. */
function parseSource(op: unknown, index: number): StoredOperation {
  const parsed = storedOperationSchema.safeParse(op);
  if (!parsed.success) {
    throw reject(
      'edit_source_unsupported',
      `операция ${index + 1} предложения не разбирается — править её нельзя`,
      { index },
    );
  }
  if (!EXEC_SCHEMAS.has(parsed.data.tool)) {
    // Fail-closed: тул без известного контракта исполнения пронести «как есть» нельзя —
    // проверить, что правка не изменила его состав, нечем.
    throw reject(
      'edit_source_unsupported',
      `операция ${index + 1}: тул «${parsed.data.tool}» правке предложения не поддаётся`,
      { index, tool: parsed.data.tool },
    );
  }
  return parsed.data;
}

/** Правка адресует СУЩЕСТВУЮЩУЮ строку предложения — иначе это дописывание, а не правка. */
function assertRowExists(
  input: Record<string, unknown>,
  index: number,
  aspect: string | undefined,
  field: string,
): void {
  if (aspect !== undefined) {
    // Ключа нет в патче аспекта — значит и предусловия под него никто не снимал (Б3):
    // правка записала бы поле мимо CAS, молча выиграв у того, кто заполнил его первым.
    const patch = aspectPatch(input, aspect);
    if (patch === undefined || !Object.hasOwn(patch, field)) {
      throw reject(
        'edit_key_missing',
        `операция ${index + 1} не правит ${aspect}.${field} — такой строки в предложении нет`,
        { index, aspect, field },
      );
    }
    return;
  }
  if (field === 'body') {
    throw reject(
      'edit_key_missing',
      `тело правится документом (Ш1.11), а не значением поля — для него отдельный список правок`,
      { index, field },
    );
  }
  // Вне аспектов правится только то, что владелец видит СТРОКОЙ предложения, и только там,
  // где операция это поле уже трогает: `id`, `precondition` и CAS — не строки, а механика.
  if (!Object.hasOwn(CORE_FIELD_LABELS, field) || input[field] === undefined) {
    throw reject(
      'edit_key_missing',
      `операция ${index + 1} не правит поле «${field}» — такой строки в предложении нет`,
      { index, field },
    );
  }
}

/** Два раза один ключ — отказ: иначе последняя правка молча выиграла бы у первой. */
function claim(
  claimed: Set<string>,
  index: number,
  aspect: string | undefined,
  field: string,
): void {
  const key = rowKey(index, aspect, field);
  if (claimed.has(key)) {
    throw reject(
      'edit_duplicate',
      `в правке дважды встречается одна и та же строка предложения (операция ${index + 1}${aspect === undefined ? '' : `, ${aspect}`}, ${field})`,
      { index, ...(aspect !== undefined && { aspect }), field },
    );
  }
  claimed.add(key);
}

/**
 * Пост-условия сборки. Нарушение состава — ошибка ЭТОГО кода, а не отказ домену (правка
 * состав изменить не может по построению), поэтому голый Error: тот же приём, что у
 * fail-closed проверки сборки предложения (propose.ts:586-589). А вот провал контракта
 * тула владелец вызвать МОЖЕТ (скалярное значение не того типа), и это отказ домену.
 */
function assertInvariants(source: StoredOperation[], result: StoredOperation[]): void {
  if (result.length !== source.length) {
    throw new Error('buildEditedOperations: число операций изменилось');
  }
  for (const [index, before] of source.entries()) {
    const op = at(result, index);
    if (canonicalJson(op.input.precondition) !== canonicalJson(before.input.precondition)) {
      throw new Error(`buildEditedOperations: предусловие операции ${index + 1} изменилось`);
    }
    if (!sameKeys(operationKeys(index, before.input), operationKeys(index, op.input))) {
      throw new Error(`buildEditedOperations: состав операции ${index + 1} изменился`);
    }
    // Схема есть у каждой операции: тул без контракта отсеял `parseSource`.
    const schema = EXEC_SCHEMAS.get(op.tool);
    if (schema === undefined) throw new Error(`buildEditedOperations: тул «${op.tool}» без схемы`);
    const parsed = schema.safeParse(op.input);
    if (!parsed.success) {
      throw reject(
        'edit_result_invalid',
        `после правки операция ${index + 1} не проходит контракт тула «${op.tool}»`,
        { index, tool: op.tool, issues: parsed.error.issues },
      );
    }
  }
}
