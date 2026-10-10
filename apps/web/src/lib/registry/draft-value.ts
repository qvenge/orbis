import { HHMM_RE, hasValidCalendar, type PropertyDefinition } from '@orbis/shared';

export type DraftValue =
  | { kind: 'value'; value: unknown }
  | { kind: 'raw'; raw: string }
  | { kind: 'list'; items: readonly string[] }
  | { kind: 'unset' };
export type ParsedDraft =
  | { ok: true; value: unknown }
  | { ok: true; unset: true }
  | { ok: false; message: string };

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const DECIMAL = /^-?\d+(\.\d+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Readability only: required, limits and conditional defaults remain server authority. */
function parseRaw(kind: PropertyDefinition['type']['kind'], raw: string): ParsedDraft {
  if (kind === 'text') return { ok: true, value: raw };
  const text = raw.trim();
  switch (kind) {
    case 'number': {
      const value = Number(text);
      return NUMBER.test(text) && Number.isFinite(value)
        ? { ok: true, value }
        : { ok: false, message: 'Введите число целиком' };
    }
    case 'decimal': {
      const value = text.replace(',', '.');
      return DECIMAL.test(value)
        ? { ok: true, value }
        : { ok: false, message: 'Введите десятичное число целиком' };
    }
    case 'date':
      return DATE.test(text) && hasValidCalendar(text)
        ? { ok: true, value: text }
        : { ok: false, message: 'Введите существующую дату ГГГГ-ММ-ДД' };
    case 'time':
      return HHMM_RE.test(text)
        ? { ok: true, value: text }
        : { ok: false, message: 'Введите время ЧЧ:ММ от 00:00 до 23:59' };
    case 'timestamp':
      return TIMESTAMP.test(text) && hasValidCalendar(text)
        ? { ok: true, value: text }
        : { ok: false, message: 'Введите существующий момент ISO с секундами и часовым поясом' };
    default:
      return { ok: false, message: 'Для этого типа нет текстового редактора' };
  }
}

export function parseDraftValue(def: PropertyDefinition, draft: DraftValue): ParsedDraft {
  if (draft.kind === 'unset') return { ok: true, unset: true };
  if (draft.kind === 'value') return { ok: true, value: draft.value };
  if (draft.kind === 'raw') return parseRaw(def.type.kind, draft.raw);
  if (
    !('cardinality' in def.type) ||
    def.type.cardinality !== 'many' ||
    !['text', 'number', 'decimal'].includes(def.type.kind)
  ) {
    return { ok: false, message: 'Для этого типа нет редактора списка скаляров' };
  }
  const values: unknown[] = [];
  for (const [index, item] of draft.items.entries()) {
    const parsed = parseRaw(def.type.kind, item);
    if (!parsed.ok) return { ok: false, message: `Строка ${index + 1}: ${parsed.message}` };
    if ('value' in parsed) values.push(parsed.value);
  }
  return { ok: true, value: values };
}
