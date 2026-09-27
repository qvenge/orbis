import { APP_EXTENSIONS, type ExtensionId, SWITCHABLE_EXTENSION_IDS } from '@orbis/shared';

/**
 * Приложение глазами каскада «Состава» (срез 1б §8.6, Р-9): id, состояние и объявленные расширения.
 */
export interface AppComposition {
  id: string;
  disabled: boolean;
  archived: boolean;
  extensions: readonly ExtensionId[];
}

const isSwitchable = (v: unknown): v is ExtensionId =>
  typeof v === 'string' && (SWITCHABLE_EXTENSION_IDS as readonly string[]).includes(v);

/**
 * «Состав» записи-приложения: только расширения, которые владелец может переключать, в порядке
 * записи и без повторов. Прочее (опечатка, расширение из будущего релиза) не переключается —
 * предложить его в диалоге значило бы получить отказ схемы `app.setDisabled`.
 */
export function compositionOf(props: Readonly<Record<string, unknown>>): ExtensionId[] {
  const raw = props[APP_EXTENSIONS];
  const list = Array.isArray(raw) ? raw : [];
  return [...new Set(list.filter(isSwitchable))];
}

/**
 * Осиротевшие расширения приложения `app` (§8.6): расширения его «Состава», которых нет в «Составе»
 * ДРУГИХ ВКЛЮЧЁННЫХ приложений и которые сейчас включены. Их диалог «Выключить приложение» и
 * «Удалить приложение» отмечает по умолчанию — владелец может снять галочки.
 *
 * Выключенное и архивное приложение расширение не держит: оно ничего не показывает, и расширение,
 * нужное только ему, — такая же сирота. Уже выключенное маской (`mask`) выключать нечего — в пачке
 * лёг бы пустой `module_set`, а в журнале — «выключено» того, что и так стояло.
 */
export function orphanExtensions(
  app: AppComposition,
  apps: readonly AppComposition[],
  mask: readonly ExtensionId[],
): ExtensionId[] {
  const held = new Set(
    apps.filter((a) => a.id !== app.id && !a.disabled && !a.archived).flatMap((a) => a.extensions),
  );
  return app.extensions.filter((ext) => !held.has(ext) && !mask.includes(ext));
}
