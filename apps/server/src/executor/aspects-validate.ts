// apps/server/src/executor/aspects-validate.ts
// Стадия 2: валидация значений аспектов по JSON Schema ИЗ БД (aspect_definitions.schema) —
// контракт «ajv по реестру» (решение 7 плана), НЕ по zod-схемам shared.
//
// Конфигурация ajv (Minor-4 ревью Task 5): strict: true + ajv-formats.
// Реестр несёт format: "uuid" (category_ref и др.); в strict-режиме незнакомый format
// БРОСАЕТ при компиляции схемы (проверено экспериментом: без addFormats компиляция
// orbis/financial падает с «unknown format "uuid"»), а вне strict — молча не проверяется.
// strict: true оставлен осознанно: builtin-схемы генерируются нами (zod-to-json-schema,
// draft-07, без незнакомых ключевых слов), а кривая КАСТОМНАЯ схема (1b) должна давать
// громкий структурированный отказ, не тихий пропуск. Кастомный format "decimal" не нужен —
// знаковость денег уже в pattern'ах реестра (Task 5).
import { Ajv, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/with-identity';
import { ExecError } from './errors';

const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);

export interface AspectRegistryEntry {
  id: string;
  ownerId: string | null; // NULL = builtin (общий для всех)
  schema: Record<string, unknown>;
}

export type AspectRegistry = Map<string, AspectRegistryEntry>;

/**
 * Реестр аспектов, видимых актору: builtin (owner_id IS NULL) + собственные кастомные.
 * Читается тем же tx под withIdentity — RLS сама ограничивает видимость.
 * ORDER BY owner_id NULLS FIRST: при коллизии id собственное определение перекрывает builtin.
 */
export async function loadAspectRegistry(tx: Tx): Promise<AspectRegistry> {
  const rows = (await tx.execute(
    sql`SELECT id, owner_id, schema FROM aspect_definitions ORDER BY owner_id NULLS FIRST`,
  )) as unknown as Array<{ id: string; owner_id: string | null; schema: Record<string, unknown> }>;
  const registry: AspectRegistry = new Map();
  for (const row of rows) {
    registry.set(row.id, { id: row.id, ownerId: row.owner_id, schema: row.schema });
  }
  return registry;
}

// Кэш скомпилированных валидаторов per (id, owner): builtin общие для всех пользователей.
// schemaJson в записи — инвалидация при изменении схемы (кастомные аспекты редактируемы).
const validatorCache = new Map<string, { schemaJson: string; validate: ValidateFunction }>();

function getValidator(entry: AspectRegistryEntry): ValidateFunction {
  const key = `${entry.ownerId ?? ''}|${entry.id}`;
  const schemaJson = JSON.stringify(entry.schema);
  const cached = validatorCache.get(key);
  if (cached && cached.schemaJson === schemaJson) return cached.validate;
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(entry.schema);
  } catch (e) {
    // Некомпилируемая схема реестра (возможно у кастомных, 1b) — структурированный отказ
    throw new ExecError('VALIDATION', `схема аспекта «${entry.id}» не компилируется`, {
      aspect: entry.id,
      reason: (e as Error).message,
    });
  }
  validatorCache.set(key, { schemaJson, validate });
  return validate;
}

/** Валидация данных одного аспекта по реестру; неизвестный аспект → VALIDATION. */
export function validateAspectData(
  registry: AspectRegistry,
  aspectId: string,
  data: unknown,
): void {
  const entry = registry.get(aspectId);
  if (!entry) {
    throw new ExecError('VALIDATION', `неизвестный аспект «${aspectId}»`, { aspect: aspectId });
  }
  const validate = getValidator(entry);
  if (!validate(data)) {
    throw new ExecError('VALIDATION', `данные аспекта «${aspectId}» не проходят схему реестра`, {
      aspect: aspectId,
      errors: validate.errors,
    });
  }
}
