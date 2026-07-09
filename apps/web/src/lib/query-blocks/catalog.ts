import { buildFieldCatalog, type FieldCatalog } from '@orbis/shared';
import type { RouterOutputs } from '../../trpc';

type AspectDef = RouterOutputs['aspect']['list'][number];

/** Каталог полей query-грамматики из ответа aspect.list (schema → поля, §6.1). */
export function buildCatalogFromAspects(defs: AspectDef[]): FieldCatalog {
  return buildFieldCatalog(
    // Guard: у aspect-definition может не быть schema (частичный/деградированный ответ) —
    // без фолбэка обращение к `.properties` внутри buildFieldCatalog роняет всё приложение
    // (нет error boundary). Пустая схема → аспект без полей, QueryBlock рендерит деградированный вид.
    defs.map((d) => ({
      id: d.id,
      schema: (d.schema ?? {}) as Record<string, unknown>,
    })),
  );
}
