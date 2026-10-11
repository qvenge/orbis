import type { JournalRef } from '@orbis/shared';
// apps/server/src/routers/user.ts
// Роутер user (§9.1): онбординг-сидирование (02 §7), настройки §7.3/§4.4, экспорт §9.4.
// Только трансляция: сид/экспорт — примитивы seed/onboarding.ts и export.ts (RLS §4.10).
// Экспорт идёт одним withIdentity-tx; заведение графа — `setupGraph`
// (`seed/setup-graph.ts`, срез 1б): план маски → мир → записи поставки → рутины → маска и тред →
// оболочка хоста последней (R-20), каждый шаг своей транзакцией. Роутер не вправе знать, сколько их,
// — иначе следующая фаза заведения потребовала бы правки и здесь.
// Настройки идут через executor (settings_set, §10.2 п. 1), маска расширений — module_set.
import { setExtensionEnabledInput, settingsSetInput } from '@orbis/shared';
import { eq } from 'drizzle-orm';
import { userSettings } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { ExecError, execErrorToTRPC } from '../errors';
import { execute } from '../executor/executor';
import { makeJournalSink } from '../executor/journal';
import { journalRef } from '../executor/journal-ref';
import { exportData, type OrbisExport } from '../export';
import { seedOwner } from '../seed/onboarding';
import { ownerOnlyProcedure, protectedProcedure, router } from '../trpc';
import { toWireUserSettings, type WireUserSettings } from '../wire';

// Боевой синк журнала — один инстанс на модуль (состояния не хранит), как в роутерах 1a:
// без него действие ушло бы в NOOP_SINK, и «отмени последнее» переключение не нашло бы.
const journalSink = makeJournalSink();

export const userRouter = router({
  // §9.3: сид/настройки/экспорт — управление аккаунтом, PAT-агенту закрыто (ownerOnly);
  // read-путь getSettings остаётся protectedProcedure — агенту нужны timezone/currency.
  // Заведение графа (срез 1б §8.6, РП-15): `{seeded: true}` — граф завёл этот вызов, `{seeded:
  // false}` — граф уже заведён, и вход не записал НИЧЕГО (С1б-5). Граф старой формы — отказ
  // `GRAPH_NEEDS_MIGRATION` структурной ошибкой, как у прочих ручек исполнителя.
  seedOnboarding: ownerOnlyProcedure.mutation(async ({ ctx }) => {
    try {
      return await seedOwner(ctx.db, ctx.identity);
    } catch (e) {
      if (e instanceof ExecError) {
        throw execErrorToTRPC({ code: e.code, message: e.message, details: e.details });
      }
      throw e;
    }
  }),

  getSettings: protectedProcedure.query(
    ({ ctx }): Promise<WireUserSettings> =>
      withIdentity(ctx.db, ctx.identity, async (tx) => {
        const rows = await tx
          .select()
          .from(userSettings)
          .where(eq(userSettings.graphId, ctx.identity.graph));
        if (!rows[0]) {
          // Нет строки → онбординг не проходил (или чужая под RLS): единый NOT_FOUND
          throw execErrorToTRPC({ code: 'NOT_FOUND', message: 'настройки не найдены' });
        }
        return toWireUserSettings(rows[0]);
      }),
  ),

  updateSettings: ownerOnlyProcedure
    .input(settingsSetInput)
    .mutation(async ({ ctx, input }): Promise<WireUserSettings & JournalRef> => {
      const r = await execute(
        ctx.db,
        {
          identity: ctx.identity,
          actorKind: 'owner',
          source: 'ui',
          operations: [{ tool: 'settings_set', input }],
        },
        { sink: journalSink },
      );
      if (!r.ok) throw execErrorToTRPC(r.error);
      // Настройки — из результата операции той же транзакции: второй транзакции чтения нет.
      return {
        ...(r.results[0] as WireUserSettings),
        actionId: r.actionId,
        consequences: r.consequences,
      };
    }),

  /**
   * §Б8-1 №28: трансляция в операцию тем же приёмом, что `registryMutation`
   * (`registryMutation`, `routers/registry.ts`) — `actorKind: 'owner'`, `source: 'ui'`, одна
   * операция. Имя ручки прежнее (РП-10) — его зовёт web; переключается расширение.
   * `settingsSetInput` маской НЕ расширяется: у одной настройки было бы два пути
   * записи — один с журналом и undo, другой без.
   *
   * Ответ — настройки и `actionId` действия (срез 1б, задача 22): переключатель «Приложений и
   * расширений» показывает тост «Отменить», а `ai.undo` отменяет ИМЕННО это действие. «Отмени
   * последнее» (`ai.undoLast`) вместо него отменило бы правку агента, успевшую лечь в журнал позже.
   */
  setModuleEnabled: ownerOnlyProcedure
    .input(setExtensionEnabledInput)
    .mutation(async ({ ctx, input }): Promise<WireUserSettings & JournalRef> => {
      const r = await execute(
        ctx.db,
        {
          identity: ctx.identity,
          actorKind: 'owner',
          source: 'ui',
          operations: [{ tool: 'module_set', input }],
        },
        { sink: journalSink },
      );
      if (!r.ok) throw execErrorToTRPC(r.error);
      return withIdentity(ctx.db, ctx.identity, async (tx) => {
        const rows = await tx
          .select()
          .from(userSettings)
          .where(eq(userSettings.graphId, ctx.identity.graph));
        if (!rows[0]) {
          throw execErrorToTRPC({ code: 'NOT_FOUND', message: 'настройки не найдены' });
        }
        return { ...toWireUserSettings(rows[0]), ...journalRef(r) };
      });
    }),

  exportData: ownerOnlyProcedure.query(
    ({ ctx }): Promise<OrbisExport> =>
      withIdentity(ctx.db, ctx.identity, (tx) => exportData(tx, ctx.identity.graph)),
  ),
});
