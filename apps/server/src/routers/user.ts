// apps/server/src/routers/user.ts
// Роутер user (§9.1): онбординг-сидирование (02 §7), настройки §7.3/§4.4, экспорт §9.4.
// Только трансляция: сид/экспорт — примитивы seed/onboarding.ts и export.ts (RLS §4.10).
// Экспорт и настройки идут одним withIdentity-tx; сид — ТРЕМЯ транзакциями (мир пачкой через
// исполнитель, настройки с тредом, садовник словаря), и все три держит `seedOwner`: роутер не
// вправе знать, сколько их, — иначе следующая фаза сева потребует правки и здесь.
// `user_settings` — конфигурация, НЕ сущность: LWW-поля (§7.3) пишутся напрямую. ИСКЛЮЧЕНИЕ —
// `disabled_modules`: включённость модуля меняет всё, что видит владелец (тулы, промпт,
// подписки, запись), и §Б8-1 №28 требует журнал и undo — она идёт через executor операцией
// `module_set`, как реестровые.
import { setExtensionEnabledInput } from '@orbis/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { userSettings } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { ExecError, execErrorToTRPC } from '../errors';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import { exportData, type OrbisExport } from '../export';
import { isValidTimeZone } from '../query/context';
import { seedOwner } from '../seed/onboarding';
import { ownerOnlyProcedure, protectedProcedure, router } from '../trpc';
import { toWireUserSettings, type WireUserSettings } from '../wire';

// Партиал настроек §1.6/§7.3: правятся «Общие» (timezone/currency/weekStartDay) и
// прикладные поля (pinned/views/цвета тегов/preferences). plan НЕ редактируется отсюда —
// это entitlements (§8), меняется серверным конфигом.
const updateSettingsInput = z
  .object({
    // Зона обязана быть IANA-идентификатором: queryContext строит из неё Intl.DateTimeFormat,
    // и невалидная строка (принятая как z.string()) роняла бы RangeError → 500 на каждом
    // entity.query/count и на тулах агента — самоотказ чтения одним валидным вызовом API.
    timezone: z
      .string()
      .min(1)
      .refine(isValidTimeZone, { message: 'неизвестная таймзона (IANA, напр. Europe/Moscow)' })
      .optional(),
    defaultCurrency: z.string().length(3).optional(),
    weekStartDay: z.enum(['monday', 'sunday']).optional(),
    tagColors: z.record(z.unknown()).optional(),
    installedViews: z.array(z.string()).optional(),
    pinnedEntities: z
      .array(z.object({ id: z.string().uuid(), order: z.number().int() }).strict())
      .optional(),
    viewPreferences: z.record(z.unknown()).optional(),
  })
  .strict();

// Боевой синк журнала — один инстанс на модуль (состояния не хранит), как в роутерах 1a:
// без него действие ушло бы в NOOP_SINK, и «отмени последнее» переключение не нашло бы.
const journalSink = makeChatJournalSink();

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

  updateSettings: ownerOnlyProcedure.input(updateSettingsInput).mutation(
    ({ ctx, input }): Promise<WireUserSettings> =>
      withIdentity(ctx.db, ctx.identity, async (tx) => {
        // LWW-правка конфигурации (§5.2): body-optimistic-check не применяется — это не сущность
        const rows = await tx
          .update(userSettings)
          .set({ ...input, updatedAt: new Date() })
          .where(eq(userSettings.graphId, ctx.identity.graph))
          .returning();
        if (!rows[0]) {
          throw execErrorToTRPC({ code: 'NOT_FOUND', message: 'настройки не найдены' });
        }
        return toWireUserSettings(rows[0]);
      }),
  ),

  /**
   * §Б8-1 №28: трансляция в операцию тем же приёмом, что `registryMutation`
   * (`registryMutation`, `routers/registry.ts`) — `actorKind: 'owner'`, `source: 'ui'`, одна
   * операция. Имя ручки прежнее (РП-10) — его зовёт web; переключается расширение.
   * `updateSettingsInput` маской НЕ расширяется: у одной настройки было бы два пути
   * записи — один с журналом и undo, другой без.
   *
   * Ответ — настройки и `actionId` действия (срез 1б, задача 22): переключатель «Приложений и
   * расширений» показывает тост «Отменить», а `ai.undo` отменяет ИМЕННО это действие. «Отмени
   * последнее» (`ai.undoLast`) вместо него отменило бы правку агента, успевшую лечь в журнал позже.
   */
  setModuleEnabled: ownerOnlyProcedure
    .input(setExtensionEnabledInput)
    .mutation(async ({ ctx, input }): Promise<WireUserSettings & { actionId: string }> => {
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
        return { ...toWireUserSettings(rows[0]), actionId: r.actionId };
      });
    }),

  exportData: ownerOnlyProcedure.query(
    ({ ctx }): Promise<OrbisExport> =>
      withIdentity(ctx.db, ctx.identity, (tx) => exportData(tx, ctx.identity.graph)),
  ),
});
