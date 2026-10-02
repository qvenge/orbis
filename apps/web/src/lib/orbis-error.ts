// Структурный отказ сервера на клиенте (спека скорости §8.2, РП-5 плана А): поле `data.orbis` ошибки tRPC. Сервер
// кладёт туда код отказа исполнителя и закрытый выбор его полей (`orbisErrorData`, apps/server/src/errors.ts) — `cause`
// по HTTP не сериализуется, и без этого канала клиент знал бы только транспортный код (`CONFLICT`), общий для разных
// отказов. Модуль листовой: `@orbis/shared` — только типом, рантайм — `TRPCClientError`, который экран и так тянет.
import type { OrbisErrorData } from '@orbis/shared';
import { TRPCClientError } from '@trpc/client';

/**
 * Код и поля отказа из `data.orbis` — или `null`, если это не ошибка tRPC или сервер поля не положил (отказ вне
 * закрытого списка кодов, сеть, 500). Разбор, а не приведение: провод — чужие данные, и кривое поле не должно
 * превращаться в «отказ с кодом undefined».
 */
export function orbisErrorOf(e: unknown): OrbisErrorData | null {
  if (!(e instanceof TRPCClientError)) return null;
  const orbis: unknown = (e.data as { orbis?: unknown } | null | undefined)?.orbis;
  if (typeof orbis !== 'object' || orbis === null) return null;
  const { code, details } = orbis as { code?: unknown; details?: unknown };
  if (typeof code !== 'string') return null;
  if (typeof details !== 'object' || details === null || Array.isArray(details)) return { code };
  return { code, details: details as Record<string, unknown> };
}

/**
 * Отказ замка ТЕКСТА (§8.1): тело записи сменили после того, как клиент начал правку, — `STALE_VERSION` с текущей
 * ревизией. По нему экран поднимает плашку «Изменено в другом месте», а сохранение тела держит набранное до решения
 * человека. Другие отказы с транспортным `CONFLICT` (занятый id, будущий замок заголовка) сюда не относятся.
 */
export function isBodyStale(e: unknown): boolean {
  return orbisErrorOf(e)?.code === 'STALE_VERSION';
}

/** Замок заголовка отличается от тела и других CAS-отказов именно свойством расхождения (§8.2). */
export function isTitleStale(e: unknown): boolean {
  const mismatches = orbisErrorOf(e)?.details?.mismatches;
  return Array.isArray(mismatches) && mismatches.some((m) => m?.property === 'orbis/title');
}
