// apps/server/src/routers/apps.ts
// Действия владельца над записью-приложением (срез 1б §8.6, РП-12): «Выключить/Включить
// приложение» и «Удалить приложение». Каждое — ОДНА пачка исполнителя: правка записи-приложения и
// `module_set` отмеченных расширений, один action, один Undo.
//
// Почему своя ручка, а не `entity.updateBatch`: «Выключено» пишет ТОЛЬКО механизм `app-toggle`
// (флаг `writer`, Н-8) — правкой записи его не поставить ни агенту, ни форме свойства. Маску меняет
// только `module_set` от владельца: правка «Состава» маску не меняет (С1б-11), и ручка — единственное
// место, где выключение приложения и выключение его расширений сходятся в одно действие.
import {
  APP_ASPECT,
  APP_DISABLED,
  appArchiveInput,
  appSetDisabledInput,
  newId,
  SUPPLY_KEY,
} from '@orbis/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { ExecError, execErrorToTRPC } from '../errors';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { Identity } from '../identity';
import { ownerOnlyProcedure, router } from '../trpc';

const sink = makeChatJournalSink();

/** Ключ эталона оболочки хоста: хост выключить и удалить нельзя (§4.2). */
const HOST_SHELL_KEY = 'host-shell';

/**
 * Запись-приложение по id под RLS: чужая и несуществующая — `NOT_FOUND`; не приложение, архивное и
 * оболочка хоста — `VALIDATION`. Проверка оболочки стоит здесь, а не правилом каталога: ключ эталона пишет
 * только механизм `supply`, и признак не меняется между чтением и пачкой.
 */
async function loadApp(
  ctx: { db: Db; identity: Identity },
  appId: string,
  hostRefusal: string,
): Promise<{ title: string }> {
  const rows = await withIdentity(ctx.db, ctx.identity, (tx) =>
    tx
      .select({
        title: entities.title,
        aspects: entities.aspects,
        props: entities.props,
        archived: entities.archived,
      })
      .from(entities)
      .where(and(eq(entities.id, appId), eq(entities.graphId, ctx.identity.graph))),
  );
  const row = rows[0];
  if (row === undefined) {
    throw execErrorToTRPC(new ExecError('NOT_FOUND', 'приложение не найдено', { id: appId }));
  }
  if (!row.aspects.includes(APP_ASPECT)) {
    throw execErrorToTRPC(
      new ExecError('VALIDATION', 'запись не приложение: у неё нет аспекта «приложение»', {
        id: appId,
      }),
    );
  }
  // Архивное приложение уже удалено: выключать его или «удалять» повторно — действие над тем, чего
  // у владельца нет, и в журнале легло бы «Удалить приложение» с выключением расширений.
  if (row.archived) {
    throw execErrorToTRPC(new ExecError('VALIDATION', 'приложение в архиве', { id: appId }));
  }
  if ((row.props as Record<string, unknown>)[SUPPLY_KEY] === HOST_SHELL_KEY) {
    throw execErrorToTRPC(new ExecError('VALIDATION', hostRefusal, { id: appId }));
  }
  return { title: row.title };
}

/** Одна пачка `app-toggle`: правка приложения первой, затем `module_set` в порядке списка. */
async function runAppBatch(
  ctx: { db: Db; identity: Identity },
  label: string,
  appUpdate: Record<string, unknown>,
  extensions: ReadonlyArray<{ module: string; enabled: boolean }>,
): Promise<{ actionId: string }> {
  const r = await execute(
    ctx.db,
    {
      identity: ctx.identity,
      actorKind: 'owner',
      source: 'ui',
      // `app-toggle` — единственный писатель «Выключено» (Н-8); прочие поля пачки он пишет как
      // обычная правка владельца (докблок `writeDenial`, `executor/props.ts`).
      mechanism: 'app-toggle',
      batchId: newId(),
      batchLabel: label,
      operations: [
        { tool: 'entity_update', input: appUpdate },
        ...extensions.map((m) => ({ tool: 'module_set', input: m })),
      ],
    },
    { sink },
  );
  if (!r.ok) throw execErrorToTRPC(r.error);
  return { actionId: r.actionId };
}

export const appsRouter = router({
  /**
   * «Выключить приложение» / «Включить приложение» (§8.6). Выключение ставит «Выключено», включение
   * снимает его (пустое значение и есть «включено»); расширения из списка переключаются в ту же
   * сторону. Какие отметить — решает диалог клиента (Р-9), сервер переключает ровно их.
   */
  setDisabled: ownerOnlyProcedure.input(appSetDisabledInput).mutation(async ({ ctx, input }) => {
    const { title } = await loadApp(ctx, input.appId, 'приложение хоста не выключается');
    return runAppBatch(
      ctx,
      input.disabled ? `Выключить приложение «${title}»` : `Включить приложение «${title}»`,
      input.disabled
        ? { id: input.appId, props: { [APP_DISABLED]: true } }
        : { id: input.appId, unset: [APP_DISABLED] },
      input.extensions.map((module) => ({ module, enabled: !input.disabled })),
    );
  }),

  /**
   * «Удалить приложение» (§8.6): архив записи и выключение осиротевших расширений, которые владелец
   * отметил. Расширения поставки не удаляются — только выключаются. Страницы с «Домом» = это
   * приложение получают `needs-review` (ссылка на архивное, вопрос В-7); само приложение — нет.
   */
  archive: ownerOnlyProcedure.input(appArchiveInput).mutation(async ({ ctx, input }) => {
    const { title } = await loadApp(ctx, input.appId, 'приложение хоста не удаляется');
    return runAppBatch(
      ctx,
      `Удалить приложение «${title}»`,
      { id: input.appId, archived: true },
      input.disableExtensions.map((module) => ({ module, enabled: false })),
    );
  }),
});
