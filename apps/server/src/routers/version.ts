// apps/server/src/routers/version.ts
// Роутер version (§9.1, С11): закреплённые версии тела — «сохранить как есть» перед тем,
// как отдать запись агенту, и откат к сохранённому. ТОЛЬКО трансляция: pin и restore идут
// через executor (единственный путь мутаций, 00-arch §4), list читает под withIdentity
// (RLS §4.10). Своих INSERT/DELETE здесь нет.
import { type BodyDoc, DOC_SCHEMA_VERSION } from '@orbis/shared/doc';
import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { entityVersions } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { execErrorToTRPC } from '../errors';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { ActorKind, WireEntity, WireEntityVersion } from '../executor/types';
import { ownerOnlyProcedure, router } from '../trpc';

// Боевой синк — один инстанс на модуль (без состояния, пишет тем же tx, §7.8). Без него
// закрепление не попало бы в журнал, и «отмени последнее» его бы не нашло.
const sink = makeChatJournalSink();

// Подпись версии — одна строка списка, потолок тот же, что в схеме операции executor'а;
// trim ДО min(1) — там же и по той же причине (пробельная подпись = снимок без подписи)
const labelInput = z.string().trim().min(1).max(200);

/**
 * Документ снимка, пригодный к записи, — или undefined, если восстанавливать надо строкой.
 *
 * Версию сверяем ЗДЕСЬ, до executor'а, потому что снимок мог пережить смену схемы
 * документа: чужую версию executor отверг бы отказом (§ гейт bodyDoc), а у нас есть
 * markdown-проекция того же снимка — по ней тело восстановится, потеряв оформление, но не
 * текст. Тот же порядок предпочтений, что у чтения (readBodyDoc, «правило разрешения Р1»).
 * NULL — тело «до бэкфилла»: документа в снимке нет вовсе.
 */
function pinnedDoc(stored: unknown): BodyDoc | undefined {
  if (typeof stored !== 'object' || stored === null) return undefined;
  return (stored as BodyDoc).v === DOC_SCHEMA_VERSION ? (stored as BodyDoc) : undefined;
}

export const versionRouter = router({
  /**
   * Закрепить текущее тело сущности (С11). ownerOnly, как и list/restore ниже: версии —
   * владельческая поверхность среза 1. Агент их не пишет (его путь мутаций — /mcp с
   * политикой подтверждений §7.10) и не читает: закрепление делает человек ПЕРЕД тем, как
   * отдать запись агенту, — это его страховка, а не рабочий материал исполнителя.
   */
  pin: ownerOnlyProcedure
    .input(z.object({ entityId: z.string().uuid(), label: labelInput }).strict())
    .mutation(async ({ ctx, input }): Promise<WireEntityVersion> => {
      const r = await execute(
        ctx.db,
        {
          actorUserId: ctx.actorUserId,
          actorKind: 'owner',
          source: 'ui', // прямое действие владельца в UI (не chat/mcp/system)
          operations: [
            {
              tool: 'entity_version_pin',
              input: { entity_id: input.entityId, label: input.label },
            },
          ],
        },
        { sink },
      );
      if (!r.ok) throw execErrorToTRPC(r.error);
      return r.results[0] as WireEntityVersion;
    }),

  /** Снимки сущности, свежие сверху (§4.10: RLS скоупит владельцем — своего owner_id в WHERE нет). */
  list: ownerOnlyProcedure.input(z.object({ entityId: z.string().uuid() }).strict()).query(
    ({ ctx, input }): Promise<WireEntityVersion[]> =>
      withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
        // Тела НЕ читаем: в списке их не показывают, а два тела на строку — это вес всего
        // экрана. Вместо документа — признак его наличия (тот же hasDoc, что у wire-формы
        // executor'а; форма собирается здесь, потому что в выдаче нет колонок под неё).
        // Тай-брейк по id обязателен: created_at по умолчанию now() — время НАЧАЛА
        // транзакции, и без последнего ключа порядок ровесников определял бы план
        // (id — UUIDv7, DESC читается как «свежее выше»; та же идиома — entity.suggest).
        const rows = await tx
          .select({
            id: entityVersions.id,
            entityId: entityVersions.entityId,
            label: entityVersions.label,
            hasDoc: sql<boolean>`${entityVersions.bodyDoc} IS NOT NULL`,
            actorKind: entityVersions.actorKind,
            createdAt: entityVersions.createdAt,
          })
          .from(entityVersions)
          .where(eq(entityVersions.entityId, input.entityId))
          .orderBy(desc(entityVersions.createdAt), desc(entityVersions.id));
        return rows.map((row) => ({
          id: row.id,
          entityId: row.entityId,
          label: row.label,
          hasDoc: row.hasDoc,
          actorKind: row.actorKind as ActorKind,
          createdAt: row.createdAt.toISOString(),
        }));
      }),
  ),

  /**
   * Откат тела к снимку. Восстанавливается ТОЛЬКО тело: аспекты, связи и заголовок в
   * снимок не входят, поэтому и остаются текущими (инвариант 8 среза). Идёт обычным
   * entity_update — тем же конвейером и тем же конвертером, что запись редактора (С11),
   * поэтому и optimistic-check §5.2 здесь настоящий: пока экран смотрел на версии, тело
   * мог править кто-то ещё, и молча затирать его нельзя (стухший штамп → 409).
   */
  restore: ownerOnlyProcedure
    .input(
      z.object({ versionId: z.string().uuid(), expectedUpdatedAt: z.string().datetime() }).strict(),
    )
    .mutation(async ({ ctx, input }): Promise<WireEntity> => {
      // Снимок читается под RLS: чужая и несуществующая версия неразличимы — NOT_FOUND
      const version = await withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
        const rows = await tx
          .select()
          .from(entityVersions)
          .where(eq(entityVersions.id, input.versionId));
        return rows[0];
      });
      if (!version) {
        throw execErrorToTRPC({
          code: 'NOT_FOUND',
          message: 'версия не найдена',
          details: { versionId: input.versionId },
        });
      }

      const doc = pinnedDoc(version.bodyDoc);
      const r = await execute(
        ctx.db,
        {
          actorUserId: ctx.actorUserId,
          actorKind: 'owner',
          source: 'ui',
          operations: [
            {
              tool: 'entity_update',
              input: {
                id: version.entityId,
                expectedUpdatedAt: input.expectedUpdatedAt,
                // Одна из двух форм, не обе: схема входа запрещает их вместе, а executor
                // сам достроит недостающую (body_doc — правда, body — её проекция)
                ...(doc === undefined ? { body: version.body } : { bodyDoc: doc }),
              },
            },
          ],
        },
        { sink },
      );
      if (!r.ok) throw execErrorToTRPC(r.error);
      return r.results[0] as WireEntity;
    }),
});
