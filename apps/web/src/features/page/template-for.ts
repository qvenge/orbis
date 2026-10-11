import { TEMPLATE_FOR_PROPERTY } from '@orbis/shared';

/** Значение «Шаблон для» — список id аспектов; иное (не массив, не строки) — пусто. */
export function templateForOf(props: Readonly<Record<string, unknown>>): string[] {
  const value = props[TEMPLATE_FOR_PROPERTY];
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}
