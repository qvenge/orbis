// Листовой модуль: его рисует первый кадр тела (эагерный, `EditorShell`) и рендерер показа, а
// оттуда нельзя дотянуться до барреля `@orbis/shared/doc` (сторожа `check-lazy-chunks.ts` и
// `save.test.tsx`). Только листовые сабпаты и React.
import type { RecordBlockName } from '@orbis/shared/doc/page-grammar';
import { aspectOfCardText } from '@orbis/shared/doc/placement';
import { effectiveLabel, type ParseRegistry } from '@orbis/shared/query';
import type { ReactNode } from 'react';

/**
 * Вид тела страницы и шаблона при настройке (спека страниц 1а §9.1): контейнеры — подписанными
 * рамками одна под другой, блоки обвязки — подписанными заглушками без данных.
 *
 * Одна копия подписей и коробок на двоих — первый кадр тела и NodeView редактора. Редактор
 * подменяет собой первый кадр, и разойдись они видом или словом — рамка дёргалась бы на другую
 * ровно в момент монтирования. Меню «/» называет блоки теми же словами, что заглушки: блок,
 * вставленный пунктом «Подзадачи», встаёт заглушкой «[Подзадачи]», а не чем-то третьим.
 */

/** Имя блока обвязки на человеческом языке (§5.3) — подпись заглушки и пункта меню «/». */
export const RECORD_BLOCK_TITLES: Readonly<Record<RecordBlockName, string>> = {
  title: 'Заголовок записи',
  tags: 'Теги',
  body: 'Тело записи',
  cards: 'Карточки аспектов',
  subtasks: 'Подзадачи',
  blockers: 'Блокировки',
  backlinks: 'Обратные ссылки',
  versions: 'Версии',
  thread: 'Тред',
};

/** Подпись заглушки блока обвязки: имя в квадратных скобках — видно, что это место, а не данные. */
export const recordStubLabel = (name: RecordBlockName): string => `[${RECORD_BLOCK_TITLES[name]}]`;

export const cardStubLabel = (aspect: string): string => `[Карточка: ${aspect}]`;

/** Колонки нумеруются с единицы — так их считает человек, а не массив. */
export const columnFrameLabel = (index: number): string => `Колонка ${index + 1}`;

/**
 * Вкладка подписывается своей подписью; пустая (голый `{{tab}}`) — одним словом: «Вкладка: »
 * с пустым хвостом читалось бы как недописанная строка.
 */
export const tabFrameLabel = (label: string): string =>
  label.trim() === '' ? 'Вкладка' : `Вкладка: ${label.trim()}`;

/**
 * Ярлык вкладки на ПОКАЗЕ. Пустая подпись (голый `{{tab}}` — законная печать пустой подписи) —
 * «Вкладка N», тем же словом и номером, каким «/» называет новую вкладку в настройке: пустой ярлык
 * был бы вкладкой, на которую нечем нажать (финальное ревью, F-M2).
 */
export const tabShowLabel = (label: string, index: number): string =>
  label.trim() === '' ? `Вкладка ${index + 1}` : label;

/**
 * Подпись аспекта карточки. Аспект атрибута (id, документ уже привязан сервером) — правда, текст —
 * его печать; тот же приоритет, что у привязки (`bindCardAttrs`). Не узнан или реестр ещё едет —
 * текст как написан: заглушка честно покажет, что назвал автор, а не пустоту.
 */
export function cardAspectTitle(
  text: string,
  aspectId: string | null,
  reg: ParseRegistry | null,
): string {
  if (reg === null) return text.trim();
  const def =
    (aspectId === null ? undefined : reg.aspects.get(aspectId)) ?? aspectOfCardText(text, reg);
  return def === undefined ? text.trim() : effectiveLabel(def.label, reg.locale);
}

/**
 * Выделен ли узел целиком (NodeSelection ProseMirror, проп `selected` NodeView): рамка — цветом
 * акцента и фоном. Без этого первое Backspace в начале колонки выделяло соседнюю часть НЕВИДИМО
 * (стиля `.ProseMirror-selectednode` в web нет), и следующее нажатие молча стирало её текст.
 * `data-selected` — тот же признак для тестов и для глаз в инспекторе.
 */
const selectedProps = (selected: boolean) => ({
  'data-selected': selected ? 'true' : undefined,
});
const FRAME_IDLE = 'border-line border-dashed';
const FRAME_SELECTED = 'border-accent bg-accent/10';

/**
 * Рамка части контейнера: подпись сверху, содержимое — под ней. Подпись вне правки тела
 * (`contentEditable={false}`): внутри редактора каретке в ней делать нечего, это не текст тела.
 * Подпись — узел, а не строка: у вкладки в настройке это поле правки её подписи (1а новое-4).
 */
export function LayoutFrameBox({
  label,
  selected = false,
  children,
}: {
  label: ReactNode;
  selected?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-testid="layout-frame"
      {...selectedProps(selected)}
      className={`flex flex-col gap-2 rounded-control border px-3 py-2 ${selected ? FRAME_SELECTED : FRAME_IDLE}`}
    >
      <div
        contentEditable={false}
        data-testid="layout-frame-label"
        className="select-none text-text-muted text-xs"
      >
        {label}
      </div>
      {children}
    </div>
  );
}

/** Контейнер при настройке — его части одна под другой (раскладкой их рисует только показ, §9.1). */
export function LayoutStack({
  selected = false,
  children,
}: {
  selected?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-testid="layout-stack"
      {...selectedProps(selected)}
      className={`flex flex-col gap-2 rounded-control${selected ? ' ring-2 ring-accent' : ''}`}
    >
      {children}
    </div>
  );
}

/** Заглушка блока обвязки: подпись без данных (§9.1), по желанию — действие справа. */
export function StubBox({
  label,
  selected = false,
  children,
}: {
  label: string;
  selected?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      data-testid="record-stub"
      {...selectedProps(selected)}
      className={`flex items-center justify-between gap-2 rounded-control border px-3 py-2 text-sm text-text-muted ${selected ? FRAME_SELECTED : FRAME_IDLE}`}
    >
      <span>{label}</span>
      {children}
    </div>
  );
}
