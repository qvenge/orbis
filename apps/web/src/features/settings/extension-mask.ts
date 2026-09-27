import { type ExtensionId, isExtensionEnabled, SWITCHABLE_EXTENSION_IDS } from '@orbis/shared';
import { useMemo } from 'react';
import { trpc } from '../../trpc';

/**
 * Маска выключенных расширений — чтение, ЛИСТОВОЙ модуль (срез 1б §8.3, §8.4).
 *
 * Отдельно от переключателя (`useDisabledExtensions.ts`: действие с тостом «Отменить») ради веса
 * первого кадра: маску читают экран записи и строки списков на каждом открытии, а переключатель
 * нужен только плашке «Включить» и экрану настроек. Модуль с переключателем, притянутый статически,
 * тащил бы в первый кадр и тост, и отмену — и вылезал за порог замыкания `DetailScreen`
 * (`check-lazy-chunks`, задача 23). Интерфейс задачи 22 не меняется: `useDisabledExtensions.ts`
 * реэкспортирует оба хука.
 */

const NONE: readonly ExtensionId[] = [];

const isExtension = (v: unknown): v is ExtensionId =>
  typeof v === 'string' && (SWITCHABLE_EXTENSION_IDS as readonly string[]).includes(v);

/**
 * Выключенные расширения — маска владельца (`user.getSettings().disabledModules`, срез 1б §8.3).
 * Настройки не приехали — пусто: «выключено» без ответа сервера было бы догадкой.
 */
export function useDisabledExtensions(): readonly ExtensionId[] {
  const settings = trpc.user.getSettings.useQuery();
  const raw = settings.data?.disabledModules;
  return useMemo(() => (raw === undefined ? NONE : raw.filter(isExtension)), [raw]);
}

/**
 * Включено ли расширение по маске графа (РП-30). Маска не приехала — включено: сервер всё равно
 * последняя линия (отказ `MODULE_DISABLED`), а «выключено» до ответа спрятало бы у каждого открытия
 * поля и бейджи, которые через кадр вернулись бы. Запрос — тот же ключ `user.getSettings`, что у
 * `useDisabledExtensions`: экрану записи лишнего запроса нет.
 */
export function useExtensionEnabled(ext: ExtensionId): boolean {
  return isExtensionEnabled(ext, useDisabledExtensions());
}
