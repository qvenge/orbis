// apps/server/src/executor/home.ts
// «Первое место задаёт дом» (срез 1б §4.3, Д-6): бездомная страница, поставленная домашней или
// разделом приложения A (A ≠ оболочка хоста), получает «Дом» = A.
//
// Исполняет СЕРВЕР, follow-up'ом исполнителя в том же action с inverse — чтобы агент и владелец
// получали одно и то же (агент меняет навигацию обычной правкой записи-приложения, §4.4), и чтобы
// один Undo снимал и раздел, и дом. Хост — пустой «Дом» (Н-1): правка оболочки хоста ничего не пишет,
// и сама оболочка «Дом» не раздаёт. Ни клиент, ни хост «Дом» сами не ставят — тихих записей нет
// (§0.2 п. 2): запись рождается только как следствие действия владельца или агента.
//
// Модуль не знает устройства исполнителя: признак операции (`HomeHook`) считается на её стадии
// подготовки, а применение дописанной правки — колбэк исполнителя (`prepareOp` + `apply` в том же
// ctx, по образцу `applyBudgetFollowUps`).
import {
  APP_ASPECT,
  APP_HOME,
  APP_NAV,
  type GraphId,
  HOME_PROPERTY,
  PAGE_ASPECT,
  SUPPLY_KEY,
} from '@orbis/shared';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/with-identity';

/** Ключ эталона оболочки хоста: её правка «Дом» не раздаёт (Н-1). */
const HOST_SHELL_KEY = 'host-shell';

/** Признак операции над записью-приложением: какие записи она НОВЫМИ поставила на место. */
export interface HomeHook {
  appId: string;
  /** Новые id «Домашней» и «Навигации» — в порядке: домашняя, затем разделы по порядку. */
  added: readonly string[];
}

/** Строка записи в той мере, в какой её читает признак (`props` — jsonb колонки, объект по id свойств). */
interface HomeRow {
  id: string;
  aspects: readonly string[];
  props: unknown;
  archived: boolean;
}

function propsObject(props: unknown): Record<string, unknown> | undefined {
  return typeof props === 'object' && props !== null
    ? (props as Record<string, unknown>)
    : undefined;
}

/** Места записи-приложения: «Домашняя» и разделы «Навигации». */
function placesOf(raw: unknown): string[] {
  const props = propsObject(raw);
  if (props === undefined) return [];
  const out: string[] = [];
  const home = props[APP_HOME];
  if (typeof home === 'string') out.push(home);
  const nav = props[APP_NAV];
  if (Array.isArray(nav)) {
    for (const id of nav) if (typeof id === 'string') out.push(id);
  }
  return out;
}

/**
 * Признак для плана операции: запись после операции — живое приложение, не оболочка хоста, и
 * у неё появились НОВЫЕ места ((`app_home` ∪ `app_nav`) после \ до). Иначе — пусто, и хук не стоит
 * ни одного запроса: так правка любой другой записи платит за «дом» одной проверкой аспекта.
 */
export function homeHookOf(
  before: Pick<HomeRow, 'props'> | null,
  after: HomeRow,
): { homeHook?: HomeHook } {
  if (after.archived || !after.aspects.includes(APP_ASPECT)) return {};
  if (propsObject(after.props)?.[SUPPLY_KEY] === HOST_SHELL_KEY) return {};
  const had = new Set(placesOf(before?.props));
  const added = [...new Set(placesOf(after.props))].filter((id) => !had.has(id));
  return added.length === 0 ? {} : { homeHook: { appId: after.id, added } };
}

/** Дописанная операция: поставить странице «Дом». Форма входа `entity_update` исполнителя. */
export interface HomeFollowUp {
  tool: 'entity_update';
  input: { id: string; props: Record<string, string> };
}

/**
 * Кандидаты на «Дом» среди новых мест приложения — по ИТОГОВОМУ состоянию транзакции (после стадии 5):
 *  - A всё ещё живое приложение и держит запись местом (пачка могла снять место или заархивировать A
 *    следующей операцией — «Дом» на архивное приложение отверг бы весь action проверкой ссылок);
 *  - запись — живая страница с пустым «Домом».
 * Для каждого кандидата — ДЕРЖАТЕЛИ: другие живые записи-приложения Q ≠ A, у которых она раздел или
 * домашняя, ВКЛЮЧАЯ оболочку хоста (страница из навигации хоста — не бездомная, §4.3). Бездомность
 * решает вызывающий: ему известен порядок операций пачки. Поиск — containment по `props`
 * (GIN `entities_props_gin`), а не по рёбрам-зеркалам: зеркало одно на пару концов и не различает,
 * каким свойством держится ссылка (Д-5).
 */
async function homeCandidates(
  tx: Tx,
  graphId: GraphId,
  hook: HomeHook,
): Promise<Map<string, string[]>> {
  const ids = sql.join(
    hook.added.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = (await tx.execute(sql`
    SELECT p.id::text AS id,
           coalesce(array_agg(q.id::text) FILTER (WHERE q.id IS NOT NULL), '{}') AS holders
      FROM entities p
      JOIN entities a
        ON a.id = ${hook.appId}::uuid AND a.graph_id = ${graphId}::uuid
       AND NOT a.archived AND ${APP_ASPECT} = ANY(a.aspects)
      LEFT JOIN entities q
        ON q.graph_id = ${graphId}::uuid
       AND q.id <> a.id
       AND NOT q.archived
       AND ${APP_ASPECT} = ANY(q.aspects)
       AND (q.props @> jsonb_build_object(${APP_NAV}::text, jsonb_build_array(p.id::text))
            OR q.props @> jsonb_build_object(${APP_HOME}::text, p.id::text))
     WHERE p.graph_id = ${graphId}::uuid
       AND p.id = ANY(ARRAY[${ids}]::uuid[])
       AND NOT p.archived
       AND ${PAGE_ASPECT} = ANY(p.aspects)
       AND (p.props ->> ${HOME_PROPERTY}) IS NULL
       AND (a.props @> jsonb_build_object(${APP_NAV}::text, jsonb_build_array(p.id::text))
            OR a.props @> jsonb_build_object(${APP_HOME}::text, p.id::text))
     GROUP BY p.id`)) as unknown as Array<{ id: string; holders: string[] }>;
  return new Map(rows.map((r) => [r.id, r.holders]));
}

/**
 * Follow-up «дом» (спека §4.3; сервер — чтобы агент и владелец получали одно; хост — пустой «Дом»,
 * Н-1). «Первое место» — по ПОРЯДКУ ОПЕРАЦИЙ пачки (рулинг R-15 п. 2): хуки обрабатываются по порядку,
 * и держатель, получивший ту же страницу местом ПОЗЖЕ в этой же пачке, бездомность не отнимает —
 * иначе пачка «A.nav += P, B.nav += P» видела бы из каждого хука другое приложение и оставляла P без
 * «Дома» навсегда (после неё P уже в двух навигациях). Итог: «Дом» = первое по порядку приложение;
 * следующий хук видит поставленный «Дом» и страницу пропускает. Держатель, получивший место РАНЬШЕ
 * в пачке, в исключение не входит: его хук шёл первым, и если «Дом» не поставил — страница не была
 * бездомной и для него.
 *
 * `apply` — prepare + apply исполнителя в том же ctx; его планы уходят в тот же action (Undo
 * откатывает целиком). Исполнитель НЕ зовёт это в режиме `internalUndo` и на повторе (replay):
 * откат воспроизводит записанные inverse, ничего не довычисляя.
 */
export async function applyHomeFollowUps<P>(
  tx: Tx,
  graphId: GraphId,
  hooks: readonly HomeHook[],
  apply: (desc: HomeFollowUp) => Promise<P>,
): Promise<P[]> {
  const applied: P[] = [];
  for (const [i, hook] of hooks.entries()) {
    const candidates = await homeCandidates(tx, graphId, hook);
    for (const id of hook.added) {
      const page = id.toLowerCase();
      const holders = candidates.get(page);
      if (holders === undefined) continue;
      // Приложения, которым ту же страницу поставила ПОЗДНЕЙШАЯ операция этой пачки.
      const later = new Set(
        hooks
          .slice(i + 1)
          .filter((h) => h.added.some((x) => x.toLowerCase() === page))
          .map((h) => h.appId.toLowerCase()),
      );
      if (!holders.every((q) => later.has(q))) continue;
      applied.push(
        await apply({
          tool: 'entity_update',
          input: { id, props: { [HOME_PROPERTY]: hook.appId } },
        }),
      );
    }
  }
  return applied;
}
