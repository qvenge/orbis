import type { AnyExtension, Range } from '@tiptap/core';
import { Extension } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import Suggestion, { exitSuggestion, type SuggestionOptions } from '@tiptap/suggestion';

/** Два входа в одно меню: `/` — блоки документа, `@` — сущности графа. */
export type SuggestKind = 'slash' | 'mention';

export const SLASH_CHAR = '/';
export const MENTION_CHAR = '@';

/**
 * У каждого входа СВОЙ экземпляр ключа, и это не украшение: умолчание `@tiptap/suggestion` —
 * один общий `SuggestionPluginKey` на всех, а ProseMirror на двух плагинах с ОДНИМ
 * экземпляром ключа бросает `RangeError: Adding different instances of a keyed plugin` ещё
 * при сборке состояния — редактор не поднимается вовсе, и падает почти весь файл тестов
 * вместе с монтированием (проверено мутацией). Числа тестов здесь намеренно нет: оно
 * устаревает от каждого нового теста, а замер от этого не меняется.
 *
 * Речь именно об экземплярах, а не об именах: `new PluginKey('x')` дважды даёт РАЗНЫЕ ключи
 * (ProseMirror дописывает к имени счётчик), и одинаковые строки сами по себе безвредны —
 * тоже замерено мутацией. Имена всё же разные — ради читаемости той самой ошибки.
 *
 * Ключи модульные, а не свои на каждый редактор: ключ адресует плагин ВНУТРИ состояния, а у
 * каждого редактора состояние своё — пять BodyEditor'ов рядом (сиды в тестах) не конфликтуют.
 */
const KEYS: Record<SuggestKind, PluginKey> = {
  slash: new PluginKey('orbisSlashSuggestion'),
  mention: new PluginKey('orbisMentionSuggestion'),
};

/** Что меню знает об открытом запросе. `range` живой: он едет за набором на каждой букве. */
export type SuggestSnapshot = {
  kind: SuggestKind;
  query: string;
  range: Range;
  view: EditorView;
  /**
   * Прямоугольник каретки в координатах ОКНА — ФУНКЦИЯ, а не снимок, и это принципиально.
   * `@tiptap/suggestion` отдаёт `clientRect`, который КАЖДЫЙ раз заново находит узел
   * декорации и меряет его (`clientRectFor` в dist/index.js:81-91): вызвав её однажды и
   * сохранив число, меню осталось бы стоять на координатах момента открытия, а прокрутка
   * увозила бы каретку из-под него. В jsdom функция отдаёт нули — геометрии там нет вовсе.
   */
  rect: () => DOMRect | null;
};

export type SuggestHandlers = {
  /** Меню открылось или обновилось набором. */
  onOpen: (snapshot: SuggestSnapshot) => void;
  /** Меню закрылось — набором мимо, уходом каретки или Esc. */
  onClose: (kind: SuggestKind) => void;
  /**
   * Клавиша при открытом меню. `true` — меню событие ЗАБРАЛО (ProseMirror гасит его
   * `preventDefault`), `false` — событие идёт своим чередом в редактор.
   */
  onKeyDown: (kind: SuggestKind, event: KeyboardEvent) => boolean;
};

/**
 * Общая обёртка для `/` и `@`.
 *
 * Позиционирование меню считаем сами по `clientRect` каретки: floating-ui в дереве есть (его
 * тянет сам `@tiptap/suggestion`), но выпадашке по известной позиции каретки хватает
 * координат — лишний слой ей ни к чему. `items` намеренно пуст: строки меню приезжают из
 * React (у `@` — из `entity.suggest` через tRPC), а плагинный `items` жил бы вне React Query,
 * то есть без кэша, без отмены и без единого следа в тестовом харнессе.
 */
function makeSuggestionExtension(
  name: string,
  kind: SuggestKind,
  char: string,
  handlers: SuggestHandlers,
): AnyExtension {
  const pluginKey = KEYS[kind];
  const options: Omit<SuggestionOptions, 'editor'> = {
    char,
    pluginKey,
    /**
     * Где меню не открывается ВООБЩЕ — в текстовых блоках со схемным флагом `code`.
     *
     * Умолчание `@tiptap/suggestion` — «разрешено всегда» (`allow = () => true`, dist/index.js),
     * исключения для кода в плагине нет, а префиксом служит пробел, — поэтому меню открывали
     * самые обычные строки кода: ` /usr/bin`, `a / b`, ` @media`, ` @import`. Цена промаха
     * несоразмерна опечатке: Enter после ` @media` (поиск ничего не нашёл, в меню одна строка
     * «Создать «media»») ЗАВОДИЛ БЫ В ГРАФЕ настоящую сущность и вставлял в блок кода
     * inline-ноду, которой там не место, а Enter после одиночного ` /` превращал блок кода в
     * заголовок и съедал набранный хвост запроса.
     *
     * Признак — ФЛАГ СХЕМЫ `code` у текстблока, а не имя `codeBlock`: тот же флаг читает и сам
     * ProseMirror, решая, вставлять ли буфер как чистый текст (`parseFromClipboard`), — то есть
     * «здесь код» уже определено схемой, и второе определение разъехалось бы с первым.
     *
     * Марка `code` (одиночные обратные кавычки посреди абзаца) сюда НЕ попадает намеренно:
     * плагин ищет совпадение по тексту блока и о марках не знает вовсе, а закрывать меню
     * посреди обычного абзаца — это отнимать `@` у самого частого места, где его набирают.
     */
    allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
    items: () => [],
    render: () => {
      const open = (p: {
        editor: { view: EditorView };
        query: string;
        range: Range;
        clientRect?: (() => DOMRect | null) | null;
      }) =>
        handlers.onOpen({
          kind,
          query: p.query,
          range: p.range,
          view: p.editor.view,
          rect: p.clientRect ?? (() => null),
        });
      return {
        onStart: open,
        onUpdate: open,
        onExit: () => handlers.onClose(kind),
        // Клавиатура идёт ИМЕННО отсюда, а не через `window.addEventListener(…, true)`:
        // слушатель на окне глушил бы стрелки, Enter и Escape во ВСЁМ приложении, пока меню
        // открыто, и конкурировал бы с самим @tiptap/suggestion (ревью И18). Здесь же
        // событие видно только когда оно пришло В РЕДАКТОР и меню действительно открыто.
        onKeyDown: (p) => handlers.onKeyDown(kind, p.event),
      };
    },
  };
  return Extension.create({
    name,
    addProseMirrorPlugins() {
      return [Suggestion({ editor: this.editor, ...options })];
    },
  });
}

/** Оба входа разом — состав редактора собирает их одним спредом. */
export function suggestionExtensions(handlers: SuggestHandlers): AnyExtension[] {
  return [
    makeSuggestionExtension('orbisSlash', 'slash', SLASH_CHAR, handlers),
    makeSuggestionExtension('orbisMention', 'mention', MENTION_CHAR, handlers),
  ];
}

/**
 * Закрыть меню, не тронув документ. Через штатный `exitSuggestion` (транзакция из одной
 * метаданной), а не удалением набранного: по Esc набранный `/` обязан остаться ТЕКСТОМ —
 * человек мог печатать дробь, а не звать меню.
 */
export function closeSuggest(view: EditorView, kind: SuggestKind): void {
  exitSuggestion(view, KEYS[kind]);
}
