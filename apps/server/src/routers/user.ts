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
import { setModuleEnabledInput } from '@orbis/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { userSettings } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { execErrorToTRPC } from '../errors';
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
  // Идемпотентно (02 §7): { seeded: false } — «онбординг уже был», ответ про фазу настроек,
  // а не про граф (сев мира идёт на каждом заходе и держится пробой по PK, Р-24-6). Транзакций
  // ТРИ, а не одна: мир пачкой через исполнитель, настройки с тредом, садовник словаря
  // (рулинг Р-17-1, разбор — в докблоке seedOwner).
  seedOnboarding: ownerOnlyProcedure.mutation(({ ctx }) => seedOwner(ctx.db, ctx.actorUserId)),

  getSettings: protectedProcedure.query(
    ({ ctx }): Promise<WireUserSettings> =>
      withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
        const rows = await tx
          .select()
          .from(userSettings)
          .where(eq(userSettings.ownerId, ctx.actorUserId));
        if (!rows[0]) {
          // Нет строки → онбординг не проходил (или чужая под RLS): единый NOT_FOUND
          throw execErrorToTRPC({ code: 'NOT_FOUND', message: 'настройки не найдены' });
        }
        return toWireUserSettings(rows[0]);
      }),
  ),

  updateSettings: ownerOnlyProcedure.input(updateSettingsInput).mutation(
    ({ ctx, input }): Promise<WireUserSettings> =>
      withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
        // LWW-правка конфигурации (§5.2): body-optimistic-check не применяется — это не сущность
        const rows = await tx
          .update(userSettings)
          .set({ ...input, updatedAt: new Date() })
          .where(eq(userSettings.ownerId, ctx.actorUserId))
          .returning();
        if (!rows[0]) {
          throw execErrorToTRPC({ code: 'NOT_FOUND', message: 'настройки не найдены' });
        }
        return toWireUserSettings(rows[0]);
      }),
  ),

  /**
   * §Б8-1 №28: трансляция в операцию тем же приёмом, что `registryMutation`
   * (`routers/registry.ts:48`) — `actorKind: 'owner'`, `source: 'ui'`, одна операция.
   * `updateSettingsInput` модулями НЕ расширяется: у одной настройки было бы два пути
   * записи — один с журналом и undo, другой без.
   */
  setModuleEnabled: ownerOnlyProcedure
    .input(setModuleEnabledInput)
    .mutation(async ({ ctx, input }): Promise<WireUserSettings> => {
      const r = await execute(
        ctx.db,
        {
          actorUserId: ctx.actorUserId,
          actorKind: 'owner',
          source: 'ui',
          operations: [{ tool: 'module_set', input }],
        },
        { sink: journalSink },
      );
      if (!r.ok) throw execErrorToTRPC(r.error);
      return withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
        const rows = await tx
          .select()
          .from(userSettings)
          .where(eq(userSettings.ownerId, ctx.actorUserId));
        if (!rows[0]) {
          throw execErrorToTRPC({ code: 'NOT_FOUND', message: 'настройки не найдены' });
        }
        return toWireUserSettings(rows[0]);
      });
    }),

  exportData: ownerOnlyProcedure.query(
    ({ ctx }): Promise<OrbisExport> =>
      withIdentity(ctx.db, ctx.actorUserId, (tx) => exportData(tx, ctx.actorUserId)),
  ),
});
