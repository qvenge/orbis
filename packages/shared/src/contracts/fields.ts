import { z } from 'zod';
/** Выбор полей (§9): без текста (умолчание списков), начало текста, текст целиком. */
export const ENTITY_FIELDS = ['none', 'start', 'full'] as const;
export type EntityFields = (typeof ENTITY_FIELDS)[number];
export const entityFieldsSchema = z.enum(ENTITY_FIELDS);
