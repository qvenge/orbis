// apps/server/src/oauth/pat-args.ts
// Разбор аргументов выдачи headless-токена (§9.3, Р4) — ОДИН на оба входа: локальный
// `scripts/issue-pat.ts` и прод-обёртку `scripts/ops.ts issue-pat`.
//
// Второй копии здесь быть не должно: разъедься разбор, `--scope worker` выдавал бы на
// проде и на стенде разный доступ, и обнаружилось бы это только выданным токеном —
// показанным один раз и невосстановимым. Модуль живёт в src сервера, а не в scripts/:
// тот каталог не входит ни в один workspace, его не покрывают ни `bun run test`, ни
// `tsc --noEmit` (apps/server/tsconfig.json: include ["src"]).
import { GRANT_SCOPES, type GrantScope } from '@orbis/shared';

export interface PatArgs {
  ownerId: string;
  label: string;
  scope: GrantScope;
}

/** Строка использования — одна на оба скрипта и на help белого списка ops.ts. */
export const PAT_USAGE = '<owner-uuid> [метка] [--scope worker]';

/** Метка по умолчанию: строка в списке «Агенты» без подписи была бы безымянной. */
const DEFAULT_LABEL = 'headless-агент';

const SCOPES_HINT = GRANT_SCOPES.join(' | ');

/**
 * Позиционные — `<owner-uuid> [метка]`, область — флагом `--scope <значение>` (или
 * `--scope=<значение>`) в любом месте строки.
 *
 * Флагом, а не третьим позиционным: метка необязательна, и позиционная область
 * прочиталась бы МЕТКОЙ у всякого, кто метку пропустил, — то есть выдала бы полный
 * доступ там, где просили исполнителя, да ещё и подписала бы его словом «worker».
 *
 * Всё непонятное — отказ, а не умолчание. Незнакомая область (`--scope wroker`) и
 * незнакомый флаг (`--scpoe worker`) молча оборачивались бы САМЫМ ШИРОКИМ доступом
 * вместо самого узкого: первая — откатом на 'full', второй — превращением опечатки в
 * метку. Ошибка выдачи доступа не восстановима отменой: токен уже показан.
 */
export function parsePatArgs(args: readonly string[]): PatArgs | { error: string } {
  const positional: string[] = [];
  let scope: GrantScope = 'full';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;

    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    // Значение либо приклеено через '=', либо стоит следующим аргументом.
    const glued = arg.startsWith('--scope=') ? arg.slice('--scope='.length) : null;
    if (glued === null && arg !== '--scope') {
      return { error: `неизвестный флаг «${arg}»: поддерживается только --scope` };
    }
    const value = glued ?? args[++i];
    if (value === undefined || value === '') {
      return { error: `--scope без значения: ожидается ${SCOPES_HINT}` };
    }
    // includes на readonly-кортеже литералов не принимает произвольную строку — сверка
    // идёт через расширенный тип, а сужение до GrantScope делает уже она сама.
    if (!(GRANT_SCOPES as readonly string[]).includes(value)) {
      return { error: `неизвестная область «${value}»: ожидается ${SCOPES_HINT}` };
    }
    scope = value as GrantScope;
  }

  const ownerId = positional[0];
  if (ownerId === undefined || ownerId === '') return { error: 'нужен owner-uuid' };
  return { ownerId, label: positional[1] ?? DEFAULT_LABEL, scope };
}
