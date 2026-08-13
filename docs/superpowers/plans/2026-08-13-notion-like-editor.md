# Notion-подобный редактор тела сущности — план реализации

> **Для агентных исполнителей:** ОБЯЗАТЕЛЬНЫЙ САБ-СКИЛЛ — `superpowers:subagent-driven-development`
> (рекомендуется) либо `superpowers:executing-plans`. Шаги размечены чекбоксами (`- [ ]`).

**Цель:** заменить двухрежимное тело сущности (просмотр markdown ↔ голая `<textarea>`) единым
WYSIWYG-редактором, где ссылки на сущности и смарт-листы остаются живыми во время набора, а
вставка выполняется через `/`-меню.

**Архитектура:** правда тела переезжает в структуру — новая колонка `body_doc jsonb`
(`{ v, doc }`), а `body` (markdown) становится производной проекцией и одновременно аварийным
дублем. Схема документа и обе конверсии живут ОДНИМ модулем в `@orbis/shared/doc`, поэтому
клиент и сервер понимают документ одинаково; сервер продолжает принимать от модели строковый
`body` и сам парсит его в документ. Путь записи не двоится: всё идёт через существующий
`executor`.

**Стек:** Tiptap 3.30.1 (ProseMirror) + `@tiptap/markdown`, React 19, tRPC 11, drizzle,
PostgreSQL (Supabase), vitest 4 (jsdom) на клиенте, `bun test` на сервере.

**Дизайн:** `docs/superpowers/specs/2026-08-13-notion-like-editor-design.md`
**Спайк:** `docs/superpowers/reviews/2026-08-13-editor-spike.md`
**Ревью плана:** проведено 2026-08-13; правки от него помечены «ПОСЛЕ РЕВЬЮ».

## Глобальные ограничения

- **Версии Tiptap — строго `3.30.1`** на всех пакетах: смешение минорных версий `@tiptap/*`
  ломает резолв `@tiptap/pm`. Исключение — `@tiptap/extension-bubble-menu`: он приходит
  `optionalDependencies` у `@tiptap/react` с диапазоном `^3.30.1`, ставить его отдельно
  не требуется.
- **Все нужные пакеты MIT** (проверено `npm view … license`). Платные расширения Tiptap
  (Comments, AI, Import/Export, Pages, Version) в работу не входят.
- **`@tiptap/extension-drag-handle*` НЕ ставить** — тянет `extension-collaboration` +
  `y-tiptap` + `yjs` (~25 kB gzip) ради инфраструктуры, которую эта работа не строит.
- **`@orbis/shared/doc` импортируется ТОЛЬКО из `apps/web/src/features/entity-editor/*`**
  (ленивый чанк). Любой импорт из эагерной части web затащит ~156 kB gzip в первый кадр.
  Корневой баррель `@orbis/shared` собран из `export *` и импортируется эагерными модулями —
  поэтому `doc` отдаётся отдельным подпутём и в баррель НЕ добавляется.
- **Тул-контракт не растёт ради UI.** `entityUpdateInput` / `entityGetInput` — схемы тулов
  модели и MCP, их парность с рукописными JSON Schema (`tools/registry.ts`) проверяет тест
  `tools/registry.test.ts:257-285`. Поля для UI живут в отдельных `*UiInput`-схемах.
- **Зелёный сьют считается по КОДУ ВОЗВРАТА, а не по счётчику тестов.**
- **Голый `bun test` из корня ЗАВИСАЕТ** — только `bun run test`. Код возврата lint снимать
  отдельным вызовом.
- **Язык кода и комментариев — русский**; комментарий объясняет «почему», а не «что».
- **Мутации только через `executor`.** Роутер `entity` — «ТОЛЬКО трансляция».
- **Миграции forward-only**; накат на прод — только `bun scripts/ops.ts migrate`.
- **Ветка:** `notion-editor` от свежего `main`. Ветка `spike-editor` в main не мержится;
  из неё переносится только содержимое полифилов (Задача 1) — файлом на `main` его нет.

## Ориентиры в чужом коде (проверено при ревью)

| Что нужно | Где лежит |
|---|---|
| Хелперы тестов сервера | `apps/server/test/helpers.ts`: `appDb()`, `adminDb()`, `freshUserId()`, `requireEnv()`, `truncateAll()` |
| Образец теста executor | `apps/server/src/executor/executor.test.ts`: локальные `req(tool, input, over?)`, `firstEntity(r)`, `first(items)` |
| Сигнатура execute | `execute(db: Db, req: ExecuteRequest, deps: ExecutorDeps = {})` — `executor.ts:199`, **три аргумента** |
| Обвязка ops-команд | `scripts/ops.ts`: `withDb(fn: (sql: postgres.Sql) => …)` — строка 60, отдаёт СЫРОЙ postgres.js; образец — `seedAspects()` строка 149; список — `OPS` строка 281 |
| Рендер web-тестов с провайдерами | `apps/web/src/test/harness.tsx:44` — `renderWithProviders` |
| Число тестов сегодня | web **708** (62 файла), server 721 — «533» из прежней редакции плана неверно |

---

## Карта файлов

**Новое в `packages/shared/src/doc/`** (Задача 2):
- `types.ts` — `BodyDoc`, `DOC_SCHEMA_VERSION`
- `nodes/entity-ref.ts`, `nodes/query-block.ts`, `nodes/raw.ts` — три свои ноды
- `schema.ts` — `DOC_EXTENSIONS`
- `convert.ts` — `parseBody` / `serializeBody` / `bodyRefsFromDoc` / `readBodyDoc`
- `index.ts` — публичный подпуть `@orbis/shared/doc`
- тесты: `convert.test.ts`

**Сервер:** `db/schema.ts`, `db/migrations/0007_body_doc.sql`, `db/backfill-body-doc.ts`,
`executor/executor.ts:806,1087`, `wire.ts:26`, `entity-read.ts:46`, `routers/entity.ts`,
`contracts/tools.ts`.

**Клиент, новое в `apps/web/src/features/entity-editor/`:** `BodyEditor.tsx`, `EditorShell.tsx`,
`extensions.ts`, `nodes/EntityChip.tsx`, `nodes/RefTitlesContext.tsx`, `nodes/QueryWidget.tsx`,
`slash/*`, `BubbleToolbar.tsx`, `move-block.ts`, `MarkdownToggle.tsx`, `useBodySave.ts`,
`draft-storage.ts`.

**Клиент, правки:** `tests/setup.ts`, `entity-detail/DetailScreen.tsx`,
`entity-detail/useEntityDetail.ts`, `entity-detail/Blocks.tsx`, `browser/query.ts`.

---

## Задача 1: Полифилы ProseMirror в тестовом окружении

**Почему первая.** ProseMirror зовёт `Range.prototype.getClientRects` и
`document.elementFromPoint`, которых в jsdom нет. Вызовы уходят в uncaught exception —
**тесты остаются зелёными, а прогон падает с кодом 1**. Без этого любая следующая задача
покрасит CI, и причина будет неочевидна.

**Файлы:**
- Создать: `apps/web/tests/prosemirror-polyfill.ts`
- Изменить: `apps/web/tests/setup.ts`, `apps/web/package.json`
- Тест: `apps/web/src/features/entity-editor/editor-smoke.test.tsx`

**Интерфейсы:**
- Производит: `installProseMirrorJsdomPolyfills(): void` — зовётся один раз из `setup.ts`.

- [ ] **Шаг 1: Поставить пакеты (все `3.30.1`)**

```bash
cd apps/web
bun add @tiptap/core@3.30.1 @tiptap/react@3.30.1 @tiptap/starter-kit@3.30.1 \
  @tiptap/markdown@3.30.1 @tiptap/extension-unique-id@3.30.1 \
  @tiptap/extension-list@3.30.1 @tiptap/extension-table@3.30.1 @tiptap/suggestion@3.30.1
bun add -d @testing-library/user-event
```

`@tiptap/extension-bubble-menu` отдельно НЕ ставится — приходит с `@tiptap/react`.
`@floating-ui/dom` тоже не объявляем: `@tiptap/suggestion` держит его в `peerDependencies`, а в
дерево он уже приезжает транзитом через `radix-ui` (один экземпляр 1.7.6, проверено).

- [ ] **Шаг 2: Написать падающий тест**

Создать `apps/web/src/features/entity-editor/editor-smoke.test.tsx`:

```tsx
// Дымовой тест ОКРУЖЕНИЯ, а не редактора: он проверяет, что ProseMirror вообще живёт в нашем
// jsdom. Без полифилов ассерты проходят, а ПРОГОН падает с кодом 1 — поэтому ценность теста
// раскрывается только вместе с проверкой кода возврата (шаг 3).
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { expect, test } from 'vitest';

function Probe({ onReady }: { onReady: (e: unknown) => void }) {
  const editor = useEditor({
    extensions: [StarterKit],
    content: '<p></p>',
    onCreate: ({ editor: e }) => onReady(e),
  });
  return <EditorContent editor={editor} data-testid="editor" />;
}

test('редактор принимает набор с клавиатуры в jsdom', async () => {
  let editor: any = null;
  render(<Probe onReady={(e) => (editor = e)} />);
  await waitFor(() => expect(editor).not.toBeNull());
  const area = screen.getByTestId('editor').querySelector('[contenteditable]');
  editor.commands.focus();
  await userEvent.type(area as HTMLElement, 'привет');
  expect(editor.getText()).toBe('привет');
});
```

- [ ] **Шаг 3: Убедиться, что прогон падает ИМЕННО кодом возврата**

```bash
cd apps/web && bunx vitest run src/features/entity-editor/editor-smoke.test.tsx >/dev/null 2>&1; echo "код: $?"
```

Ожидается: `код: 1` при том, что подробный вывод показывает «1 passed».

- [ ] **Шаг 4: Добавить полифилы**

Создать `apps/web/tests/prosemirror-polyfill.ts`:

```ts
// ProseMirror измеряет геометрию каретки и попадание мыши; jsdom этих API не имеет вовсе, и
// вызов уходит в uncaught exception. Тесты при этом ЗЕЛЁНЫЕ, а прогон падает с кодом 1 — то
// есть без полифилов сьют web красный в CI без единого упавшего теста.
//
// Полифилы намеренно возвращают нули и null: геометрия в jsdom всё равно ничего не значит, а
// задача — не уронить прогон, а не соврать про размеры. Всё, что зависит от настоящих координат
// (позиционирование меню, попадание мыши в блок), проверяется в браузере.
//
// Состав проверен на нашем jsdom 29: Range.prototype.getClientRects, .getBoundingClientRect и
// document.elementFromPoint отсутствуют; Element.prototype.getClientRects — есть. Guard'ы
// оставлены на всех четырёх: они дешевле, чем разбираться после обновления jsdom.
const ZERO_RECT: DOMRect = {
  x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
  toJSON: () => ({}),
};

function rectList(): DOMRectList {
  const list = [ZERO_RECT] as unknown as DOMRectList;
  Object.defineProperty(list, 'item', { value: (i: number) => (i === 0 ? ZERO_RECT : null) });
  return list;
}

export function installProseMirrorJsdomPolyfills(): void {
  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = rectList;
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => ZERO_RECT;
  if (!Element.prototype.getClientRects) Element.prototype.getClientRects = rectList;
  // Никто «не под курсором»: клик мимо текста ProseMirror переживает штатно.
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
}
```

- [ ] **Шаг 5: Подключить в setup**

В конец `apps/web/tests/setup.ts`:

```ts
import { installProseMirrorJsdomPolyfills } from './prosemirror-polyfill';

installProseMirrorJsdomPolyfills();
```

- [ ] **Шаг 6: Проверить код возврата и весь сьют**

```bash
cd apps/web && bunx vitest run src/features/entity-editor/ >/dev/null 2>&1; echo "точечно: $?"
cd /Users/birzhan/projects/orbis && bun run test 2>&1 | tail -6
```

Ожидается: `точечно: 0`. Общий сьют — **web ~709 (708 было + новый), server 721**, зелёные.

- [ ] **Шаг 7: Коммит**

```bash
git add apps/web/tests apps/web/src/features/entity-editor apps/web/package.json bun.lock
git commit -m "test(web): полифилы ProseMirror — иначе прогон падает при зелёных тестах"
```

---

## Задача 2: Схема документа, конверсия и защита от тихой потери

**Файлы:**
- Создать: `packages/shared/src/doc/{types,schema,convert,index}.ts`
- Создать: `packages/shared/src/doc/nodes/{entity-ref,query-block,raw}.ts`
- Создать: `packages/shared/src/doc/convert.test.ts`
- Изменить: `packages/shared/package.json` (зависимости + `exports`)
- **НЕ изменять** `packages/shared/src/index.ts` — см. Глобальные ограничения.

**Интерфейсы:**
- Производит (из `@orbis/shared/doc`):
  - `DOC_SCHEMA_VERSION: 1`; `type BodyDoc = { v: number; doc: JSONContent }`
  - `parseBody(markdown: string): BodyDoc`
  - `serializeBody(doc: BodyDoc | JSONContent): string`
  - `bodyRefsFromDoc(doc: BodyDoc | JSONContent): string[]`
  - `readBodyDoc(stored: unknown, fallbackMarkdown: string): BodyDoc`
  - `DOC_EXTENSIONS: AnyExtension[]`, `EntityRef`, `QueryBlock`, `RawBlock`, `QUERY_BLOCK_CLOSE`

- [ ] **Шаг 1: Поставить пакеты и объявить подпуть**

```bash
cd packages/shared
bun add @tiptap/core@3.30.1 @tiptap/starter-kit@3.30.1 @tiptap/markdown@3.30.1 \
  @tiptap/extension-list@3.30.1 @tiptap/extension-table@3.30.1
```

В `packages/shared/package.json` добавить `exports` (если поля нет — завести, сохранив текущую
точку входа):

```json
  "exports": {
    ".": "./src/index.ts",
    "./doc": "./src/doc/index.ts"
  }
```

`@tiptap/react` сюда НЕ ставить: shared обязан работать на Bun без DOM, а NodeView'ы живут в web.

- [ ] **Шаг 2: Написать падающий тест**

Создать `packages/shared/src/doc/convert.test.ts`:

```ts
// Главный инвариант работы: сидированные тела взяты из §3.3 PRD ДОСЛОВНО (переносы строк и
// девятипробельные отступы continuation-строк). Сравнение БЕЗ .trim(): «байт-в-байт» с
// послаблением по краям — это уже не байт-в-байт, а сериализатор реально добавляет краевые
// переносы (поймано ревью плана).
import { describe, expect, test } from 'vitest';
import {
  ALL_TASKS_BODY,
  DAILY_PLANNING_BODY,
  HORIZON_LIFE_BODY,
  HORIZON_YEAR_BODY,
  UPCOMING_BODY,
} from '../../../../apps/server/src/seed/smart-lists';
import { bodyRefsFromDoc, parseBody, serializeBody } from './convert';

const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';

// Константы ИМПОРТИРУЮТСЯ, а не копируются: рукописная копия сида разъезжается с оригиналом —
// ровно тот дрейф, против которого написан весь этот модуль.
const SEEDS: Array<[string, string]> = [
  ['Daily Planning', DAILY_PLANNING_BODY],
  ['Upcoming', UPCOMING_BODY],
  ['All Tasks', ALL_TASKS_BODY],
  ['Горизонт «Год»', HORIZON_YEAR_BODY],
  ['Горизонт «Жизнь»', HORIZON_LIFE_BODY],
];

describe('round-trip сидированных тел', () => {
  for (const [name, body] of SEEDS) {
    test(`${name} переживает круг буква в букву`, () => {
      expect(serializeBody(parseBody(body))).toBe(body);
    });
    test(`${name} не уехал в raw`, () => {
      // Если сверка round-trip не сошлась, parseBody кладёт всё в rawBlock — тело останется
      // целым, но перестанет быть структурой. Для сидов это провал: смарт-листы обязаны быть
      // живыми виджетами.
      expect(JSON.stringify(parseBody(body).doc)).not.toContain('rawBlock');
    });
  }
});

describe('свои конструкции', () => {
  test('ссылка с подписью и без', () => {
    for (const md of [`См. [[entity:${UUID}|Кроссовки]] сегодня.`, `Связано с [[entity:${UUID}]].`]) {
      expect(JSON.stringify(parseBody(md).doc)).toContain('entityRef');
      expect(serializeBody(parseBody(md))).toBe(md);
    }
  });

  test('незакрытая обёртка остаётся текстом и не режет абзац', () => {
    const md = 'текст {{query: aspect=orbis/task и всё';
    expect(serializeBody(parseBody(md))).toBe(md);
  });

  test('`}}` внутри запроса блоком не считается', () => {
    // Рубеж, который раньше держал replaceQueryBlock: рендерер закроет блок на первом же `}}`,
    // хвост станет текстом заметки, а `{{query:` в этом хвосте сдвинет нумерацию блоков.
    const md = '{{query: tags=a}}b}}';
    const back = serializeBody(parseBody(md));
    expect(back).toBe(md);
  });

  test('чеклист, код, вложенный список и цитата', () => {
    for (const md of [
      '- [ ] не сделано\n- [x] сделано',
      '```ts\nconst x = 1;\n```',
      '- раз\n  - вложенный\n- два',
      '> цитата',
    ]) {
      expect(serializeBody(parseBody(md))).toBe(md);
    }
  });

  test('идемпотентность: второй круг ничего не меняет', () => {
    for (const [, body] of SEEDS) {
      const once = serializeBody(parseBody(body));
      expect(serializeBody(parseBody(once))).toBe(once);
    }
  });
});

describe('защита от тихой потери', () => {
  test('сноска GFM уезжает в raw целиком, а не портится', () => {
    // Без сверки round-trip сериализатор даёт `текст[^1](сноска)` — определение сноски
    // исчезает (проверено на живом парсере). Схема беднее markdown, и список «чего она не
    // знает» неизвестен по построению — потому и сверка, а не перечень исключений.
    const md = 'текст[^1]\n\n[^1]: сноска';
    const doc = parseBody(md);
    expect(JSON.stringify(doc.doc)).toContain('rawBlock');
    expect(serializeBody(doc)).toBe(md);
  });

  test('HTML в тексте уезжает в raw и не экранируется', () => {
    const md = 'текст <div>x</div>';
    expect(serializeBody(parseBody(md))).toBe(md);
  });

  test('обычный текст в raw НЕ уезжает', () => {
    const doc = parseBody('# Заголовок\n\n- раз\n- два');
    expect(JSON.stringify(doc.doc)).not.toContain('rawBlock');
  });
});

describe('bodyRefsFromDoc', () => {
  test('lowercase и без дублей', () => {
    const doc = parseBody(`[[entity:${UUID.toUpperCase()}]] и ещё [[entity:${UUID}]]`);
    expect(bodyRefsFromDoc(doc)).toEqual([UUID]);
  });

  test('ссылка в блоке кода и в inline-коде связью НЕ считается', () => {
    // Отличие от регэкспного extractBodyRefs — нарочное (Р7): что не кликабельно, то не связь.
    expect(bodyRefsFromDoc(parseBody('```\n[[entity:' + UUID + ']]\n```'))).toEqual([]);
    expect(bodyRefsFromDoc(parseBody('`[[entity:' + UUID + ']]`'))).toEqual([]);
  });
});
```

- [ ] **Шаг 3: Убедиться, что тест падает**

```bash
cd packages/shared && bunx vitest run src/doc/convert.test.ts 2>&1 | tail -5
```

Ожидается: FAIL — `Cannot find module './convert'`.

- [ ] **Шаг 4: Типы**

Создать `packages/shared/src/doc/types.ts`:

```ts
import type { JSONContent } from '@tiptap/core';

/**
 * Версия схемы документа. Поднимается при КАЖДОМ изменении состава нод: ProseMirror молча
 * выбрасывает узлы, которых нет в текущей схеме, и без версии откат релиза съел бы содержимое
 * без следа. Правило разрешения — readBodyDoc.
 */
export const DOC_SCHEMA_VERSION = 1;

/** Хранимая форма `entities.body_doc`. Голый документ не хранится — только с версией. */
export type BodyDoc = { v: number; doc: JSONContent };
```

- [ ] **Шаг 5: Ноды**

`nodes/query-block.ts`:

```ts
import { Node } from '@tiptap/core';

/** Закрывающая половина обёртки — отдельной строкой: её длину меряет проверка рубежа ниже. */
export const QUERY_BLOCK_CLOSE = '}}';

/**
 * Смарт-лист `{{query:…}}`. Атрибут `query` хранит содержимое ДОСЛОВНО — с переносами строк и
 * девятипробельными отступами continuation-строк: сидированные тела (§3.3 PRD) сверяются с
 * документом байт-в-байт живым тестом, и тримленный атрибут схлопнул бы их при первом же
 * сохранении.
 */
export const QueryBlock = Node.create({
  name: 'queryBlock',
  group: 'block',
  atom: true,
  addAttributes: () => ({ query: { default: '' } }),
  parseHTML: () => [{ tag: 'div[data-query]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', { 'data-query': HTMLAttributes.query }],
  markdownTokenizer: {
    name: 'queryBlock',
    level: 'block',
    // Индекс ТОЛЬКО у полной обёртки. Поиск подстроки `{{query:` резал бы абзац пополам на
    // первой же опечатке, а хвост записи уезжал в отдельный узел (поймано спайком).
    start: (src: string) => {
      const m = /\{\{query:[\s\S]*?\}\}/.exec(src);
      return m ? m.index : -1;
    },
    tokenize: (src: string) => {
      const m = /^\{\{query:([\s\S]*?)\}\}/.exec(src);
      if (!m) return undefined;
      return { type: 'queryBlock', raw: m[0], query: m[1] ?? '' } as never;
    },
  },
  parseMarkdown: (token: { query?: string }) => ({
    type: 'queryBlock',
    attrs: { query: token.query ?? '' },
  }),
  // БЕЗ хвостовых переносов: разделитель между блоками ставит сериализатор, и свой `\n\n`
  // давал двойной (поймано спайком).
  renderMarkdown: (node: { attrs?: { query?: string } }) => `{{query:${node.attrs?.query ?? ''}}}`,
});
```

`nodes/entity-ref.ts`:

```ts
import { Node } from '@tiptap/core';

/**
 * Форма ссылки — КОПИЯ серверного `BODY_REFS_RE` (executor/normalize.ts): класс символов и
 * регистронезависимость обязаны совпадать, иначе документ и backlinks разъедутся. Разница лишь
 * в том, что здесь это узел дерева, а не находка регэкспа в тексте.
 */
const RE = /^\[\[entity:([0-9a-f-]{36})(?:\|([^\]]*))?\]\]/i;

export const EntityRef = Node.create({
  name: 'entityRef',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes: () => ({ entityId: { default: null }, label: { default: null } }),
  parseHTML: () => [{ tag: 'span[data-entity-id]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'span',
    { 'data-entity-id': HTMLAttributes.entityId, 'data-label': HTMLAttributes.label },
  ],
  markdownTokenizer: {
    name: 'entityRef',
    level: 'inline',
    start: (src: string) => src.indexOf('[[entity:'),
    tokenize: (src: string) => {
      const m = RE.exec(src);
      if (!m) return undefined;
      return { type: 'entityRef', raw: m[0], entityId: m[1], label: m[2] ?? null } as never;
    },
  },
  parseMarkdown: (token: { entityId?: string; label?: string | null }) => ({
    type: 'entityRef',
    attrs: { entityId: token.entityId, label: token.label ?? null },
  }),
  renderMarkdown: (node: { attrs?: { entityId?: string; label?: string | null } }) => {
    const label = node.attrs?.label;
    return `[[entity:${node.attrs?.entityId}${label ? `|${label}` : ''}]]`;
  },
});
```

`nodes/raw.ts`:

```ts
import { Node } from '@tiptap/core';

/**
 * Текст, который схема не смогла разобрать без потерь, — сохраняется ДОСЛОВНО.
 *
 * Своего парсера у ноды нет и быть не может: чтобы поймать «непонятое», надо заранее знать,
 * чего именно мы не знаем. Её создаёт сверка round-trip в parseBody — см. там же.
 */
export const RawBlock = Node.create({
  name: 'rawBlock',
  group: 'block',
  atom: true,
  addAttributes: () => ({ markdown: { default: '' } }),
  parseHTML: () => [{ tag: 'pre[data-raw]' }],
  renderHTML: ({ HTMLAttributes }) => ['pre', { 'data-raw': '' }, HTMLAttributes.markdown],
  renderMarkdown: (node: { attrs?: { markdown?: string } }) => node.attrs?.markdown ?? '',
});
```

- [ ] **Шаг 6: Состав схемы**

`schema.ts`:

```ts
import type { AnyExtension } from '@tiptap/core';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import StarterKit from '@tiptap/starter-kit';
import { EntityRef } from './nodes/entity-ref';
import { QueryBlock } from './nodes/query-block';
import { RawBlock } from './nodes/raw';

/**
 * ЕДИНСТВЕННОЕ описание того, что такое документ Orbis: им пользуются и сервер (парсинг текста
 * модели), и клиент (редактор). Два описания разъехались бы так же, как чуть не разъехались
 * BODY_REFS_RE и ENTITY_REF_RE.
 *
 * TaskList/TaskItem и TableKit — отдельные пакеты: в StarterKit чеклистов и таблиц НЕТ.
 * UniqueID здесь НЕТ намеренно — он живёт только в редакторе (см. «Известные границы» дизайна).
 */
export const DOC_EXTENSIONS: AnyExtension[] = [
  StarterKit,
  TaskList,
  TaskItem,
  TableKit,
  EntityRef,
  QueryBlock,
  RawBlock,
];
```

- [ ] **Шаг 7: Конверсия со сверкой round-trip**

`convert.ts`:

```ts
import type { JSONContent } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import { DOC_EXTENSIONS } from './schema';
import { type BodyDoc, DOC_SCHEMA_VERSION } from './types';

// Менеджер тяжёлый в конструировании и не хранит состояния между вызовами — создаётся один раз.
// Проверено спайком: работает на Bun без DOM.
let manager: MarkdownManager | null = null;
function md(): MarkdownManager {
  manager ??= new MarkdownManager({ extensions: DOC_EXTENSIONS });
  return manager;
}

function docOf(input: BodyDoc | JSONContent): JSONContent {
  return 'doc' in input && 'v' in input ? (input as BodyDoc).doc : (input as JSONContent);
}

export function serializeBody(input: BodyDoc | JSONContent): string {
  return md().serialize(docOf(input));
}

/** Весь текст одним неразобранным блоком — форма отказа, при которой не теряется ни байта. */
function asRaw(markdown: string): BodyDoc {
  return {
    v: DOC_SCHEMA_VERSION,
    doc: { type: 'doc', content: [{ type: 'rawBlock', attrs: { markdown } }] },
  };
}

/**
 * Markdown → документ СО СВЕРКОЙ: результат сериализуется обратно, и если он разошёлся с
 * исходником, весь текст уходит в rawBlock дословно.
 *
 * Почему так, а не перечнем неподдерживаемых конструкций: схема беднее markdown, и список
 * «чего она не знает» неизвестен по построению. Без сверки сноска GFM `текст[^1]` + `[^1]: …`
 * превращается в `текст[^1](сноска)` — определение исчезает молча (проверено). Для
 * приложения-памяти тихая потеря содержимого — худший класс ошибки, и неразобранный блок
 * здесь лучше переписанного текста.
 *
 * Цена: запись с неподдерживаемой конструкцией открывается одним блоком и правится через
 * markdown-тумблер, пока конструкция не будет добавлена в схему.
 */
export function parseBody(markdown: string): BodyDoc {
  let doc: JSONContent;
  try {
    doc = md().parse(markdown);
  } catch {
    return asRaw(markdown); // парсер вообще не справился — тем более сохраняем дословно
  }
  const back = md().serialize(doc);
  if (back !== markdown) return asRaw(markdown);
  return { v: DOC_SCHEMA_VERSION, doc };
}

/**
 * Ссылки — обходом дерева, а не регэкспом по тексту: связью считается настоящая нода entityRef.
 * Отличие от extractBodyRefs нарочное (Р7) — `[[entity:…]]` внутри кода (и блочного, и inline)
 * ссылкой не является, потому что и кликабельным он не является.
 */
export function bodyRefsFromDoc(input: BodyDoc | JSONContent): string[] {
  const refs = new Set<string>();
  const walk = (node: JSONContent | undefined): void => {
    if (!node) return;
    if (node.type === 'entityRef') {
      const id = node.attrs?.entityId;
      if (typeof id === 'string') refs.add(id.toLowerCase());
    }
    for (const child of node.content ?? []) walk(child);
  };
  walk(docOf(input));
  return [...refs];
}

/**
 * Правило разрешения (Р1): что считать документом.
 *  1. форма верна и версия знакома → он;
 *  2. иначе (версия из будущего после отката релиза, битая форма, NULL) → пересборка из `body`.
 * Худший исход — потеря блочных id и части оформления, но НЕ текста.
 */
export function readBodyDoc(stored: unknown, fallbackMarkdown: string): BodyDoc {
  if (
    typeof stored === 'object' &&
    stored !== null &&
    'v' in stored &&
    'doc' in stored &&
    (stored as BodyDoc).v === DOC_SCHEMA_VERSION
  ) {
    return stored as BodyDoc;
  }
  return parseBody(fallbackMarkdown);
}
```

- [ ] **Шаг 8: Публичный подпуть**

`index.ts`:

```ts
// Точка входа `@orbis/shared/doc`. В корневой баррель (src/index.ts) НЕ добавляется: он собран
// из `export *` и импортируется эагерными модулями web, а этот модуль тянет всю схему Tiptap
// (~156 kB gzip) — попав в первый кадр, он обессмыслил бы двухфазное монтирование.
export * from './convert';
export * from './schema';
export * from './types';
export { EntityRef } from './nodes/entity-ref';
export { QUERY_BLOCK_CLOSE, QueryBlock } from './nodes/query-block';
export { RawBlock } from './nodes/raw';
```

- [ ] **Шаг 9: Прогнать тесты**

```bash
cd packages/shared && bunx vitest run src/doc/ 2>&1 | tail -10
```

Все зелёные. Если падает round-trip сидов — проверить два условия из спайка: хвостовые
переносы в `renderMarkdown` и `start` токенизатора. Если сид уехал в `rawBlock` — сверка
поймала расхождение, и чинить надо ноду, а не сверку.

- [ ] **Шаг 10: Проверить работу на Bun без DOM**

```bash
cd /Users/birzhan/projects/orbis && bun -e "
import { parseBody, serializeBody } from './packages/shared/src/doc/index';
console.log('window:', typeof globalThis.window, 'document:', typeof globalThis.document);
console.log(JSON.stringify(serializeBody(parseBody('# Тест\n\nабзац'))));
"
```

Ожидается: `window: undefined document: undefined` и корректный markdown.

- [ ] **Шаг 11: Коммит**

```bash
git add packages/shared
git commit -m "feat(shared): схема документа, конверсия и сверка round-trip против тихой потери"
```

---

## Задача 3: Миграция `body_doc`, индекс заголовка, бэкфилл

**Файлы:**
- Изменить: `apps/server/src/db/schema.ts` (таблица `entities`)
- Создать: `apps/server/src/db/migrations/0007_*.sql` (через `db:generate`)
- Создать: `apps/server/src/db/backfill-body-doc.ts`
- Изменить: `scripts/ops.ts`
- Тест: `apps/server/src/db/backfill-body-doc.test.ts`

**Интерфейсы:**
- Потребляет: `parseBody` из `@orbis/shared/doc`.
- Производит: колонка `entities.body_doc jsonb` (nullable); индекс `entities_title_prefix`;
  `backfillBodyDoc(db: Db): Promise<number>` — число сконвертированных строк.

- [ ] **Шаг 1: Колонка в схеме**

В `apps/server/src/db/schema.ts`, в таблицу `entities` после `bodyRefs`:

```ts
  /**
   * Структурная правда тела: `{ v, doc }` (см. @orbis/shared/doc). NULL означает «ещё не
   * сконвертировано» — тела, созданные до этой работы: сервер конвертирует их лениво при первом
   * чтении. `body` остаётся NOT NULL и служит проекцией И аварийным дублем (ProseMirror молча
   * выбрасывает незнакомые схеме узлы).
   */
  bodyDoc: jsonb('body_doc'),
```

- [ ] **Шаг 2: Сгенерировать миграцию**

```bash
cd apps/server && bun run db:generate
```

`drizzle.config.ts` читает `DATABASE_URL` напрямую — переменная должна быть в `apps/server/.env`
(`bun run` подхватывает его сам). Проверить, что в `0007_*.sql` ровно один
`ALTER TABLE ... ADD COLUMN "body_doc" jsonb;` и никаких `DROP`.

- [ ] **Шаг 3: Дописать индекс заголовка в ту же миграцию**

Двумя миграциями подряд ради одной работы — лишний шаг в прод-процедуре, а откатывать их всё
равно нечем. В конец `0007_*.sql`:

```sql
--> statement-breakpoint
-- Префиксный поиск для slash-меню и пикеров (entity.suggest). Именно btree с text_pattern_ops,
-- а НЕ gin_trgm: запрос имеет вид `lower(title) LIKE 'куп%'`, то есть префиксный, и btree
-- обслуживает его напрямую, тогда как триграммный индекс на запросах короче трёх символов
-- бесполезен. Заодно не требуется CREATE EXTENSION — на Supabase расширения живут в схеме
-- `extensions`, и необкатанный шаг с pg_trgm мог бы упасть прямо на проде (миграции
-- forward-only, откатывать нечем).
CREATE INDEX IF NOT EXISTS entities_title_prefix
  ON entities (lower(title) text_pattern_ops);
```

- [ ] **Шаг 4: Написать падающий тест бэкфилла**

Создать `apps/server/src/db/backfill-body-doc.test.ts` — обвязку взять из соседнего
`apps/server/src/db/aspect-drift.test.ts` (те же `adminDb`, `truncateAll`, `requireEnv`):

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
import { parseBody, serializeBody } from '@orbis/shared/doc';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { backfillBodyDoc } from './backfill-body-doc';

beforeAll(() => requireEnv());
afterAll(() => truncateAll());

describe('бэкфилл body_doc', () => {
  test('конвертирует тела без документа и повторно ничего не делает', async () => {
    await truncateAll();
    const owner = freshUserId();
    const id = newId();
    // Вставка админской ролью: бэкфилл — служебная операция, RLS-скоуп владельца ей не нужен.
    await adminDb().execute(
      sql`INSERT INTO entities (id, owner_id, title, body) VALUES (${id}, ${owner}, 'без документа', '# Заголовок')`,
    );
    expect(await backfillBodyDoc(adminDb())).toBe(1);
    expect(await backfillBodyDoc(adminDb())).toBe(0);
  });

  test('проекция сконвертированного совпадает с исходным body', async () => {
    await truncateAll();
    const owner = freshUserId();
    const id = newId();
    const body = 'текст\n\n{{query: aspect=orbis/task, status=inbox}}';
    await adminDb().execute(
      sql`INSERT INTO entities (id, owner_id, title, body) VALUES (${id}, ${owner}, 'со смарт-листом', ${body})`,
    );
    await backfillBodyDoc(adminDb());
    const rows = await adminDb().execute(sql`SELECT body_doc FROM entities WHERE id = ${id}`);
    expect(serializeBody(rows[0].body_doc as never)).toBe(body);
    expect(rows[0].body_doc).toEqual(parseBody(body) as never);
  });
});
```

- [ ] **Шаг 5: Убедиться, что падает**

```bash
cd /Users/birzhan/projects/orbis && bun run test 2>&1 | grep -A4 "backfill"
```

Ожидается: FAIL — модуль не найден.

- [ ] **Шаг 6: Реализовать бэкфилл**

Создать `apps/server/src/db/backfill-body-doc.ts`:

```ts
// Разовая конверсия существующих тел в структурную форму. Порциями: тел может быть много, а
// один долгий UPDATE держал бы блокировки дольше нужного.
//
// Не «миграция данных внутри SQL-миграции» намеренно: конверсию делает JS-парсер
// (@orbis/shared/doc), внутри postgres его нет. Запускается через `bun scripts/ops.ts` после
// наката 0007; всё, что бэкфилл не догнал, сервер конвертирует лениво при первом чтении —
// колонка nullable ровно ради этого.
import { parseBody } from '@orbis/shared/doc';
import { sql } from 'drizzle-orm';
import type { Db } from './client';

const BATCH = 200;

export async function backfillBodyDoc(db: Db): Promise<number> {
  let done = 0;
  for (;;) {
    const rows = await db.execute(
      sql`SELECT id, body FROM entities WHERE body_doc IS NULL LIMIT ${BATCH}`,
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      const doc = parseBody(String(row.body ?? ''));
      await db.execute(
        sql`UPDATE entities SET body_doc = ${JSON.stringify(doc)}::jsonb WHERE id = ${row.id}`,
      );
      done += 1;
    }
    if (rows.length < BATCH) break;
  }
  return done;
}
```

- [ ] **Шаг 7: Добавить команду в ops-обёртку**

`withDb` в `scripts/ops.ts:60` отдаёт СЫРОЙ `postgres.Sql`, а не drizzle, — поэтому запрос
пишется на нём напрямую, а `parseBody` вызывается тут же:

```ts
/**
 * Разовая конверсия тел в структурную форму. Идемпотентна: берёт только строки с
 * body_doc IS NULL, поэтому повторный запуск безопасен и ничего не делает.
 */
async function backfillBodyDocOp(): Promise<number> {
  await withDb(async (sql) => {
    let done = 0;
    for (;;) {
      const rows = await sql`SELECT id, body FROM entities WHERE body_doc IS NULL LIMIT 200`;
      if (rows.length === 0) break;
      for (const row of rows) {
        const doc = JSON.stringify(parseBody(String(row.body ?? '')));
        await sql`UPDATE entities SET body_doc = ${doc}::jsonb WHERE id = ${row.id}`;
        done += 1;
      }
      if (rows.length < 200) break;
    }
    console.log(`сконвертировано тел: ${done}`);
  });
  return 0;
}
```

и в объект `OPS` (строка 281), после `'seed-aspects'`:

```ts
  'backfill-body-doc': {
    run: backfillBodyDocOp,
    help: 'разовая конверсия тел в структурную форму (идемпотентно, порциями)',
  },
```

- [ ] **Шаг 8: Прогнать тесты**

```bash
cd /Users/birzhan/projects/orbis && bun run test 2>&1 | tail -6
```

- [ ] **Шаг 9: Коммит**

```bash
git add apps/server/src/db scripts/ops.ts
git commit -m "feat(server): колонка body_doc, индекс префикса заголовка, бэкфилл"
```

---

## Задача 4: `bodyDoc` во входе UI, конверсия в executor, `body_refs` по дереву

**Файлы:**
- Изменить: `packages/shared/src/contracts/tools.ts`
- Изменить: `apps/server/src/executor/executor.ts:806,965,1087`
- Изменить: `apps/server/src/wire.ts:26`
- Изменить: `apps/server/src/entity-read.ts:46`
- Изменить: `apps/server/src/routers/entity.ts:125,151`
- Изменить: `packages/shared/src/schemas/entity.ts`
- Тест: `apps/server/src/executor/body-doc.test.ts`

**Интерфейсы:**
- Потребляет: `parseBody`, `serializeBody`, `bodyRefsFromDoc`, `readBodyDoc`, `BodyDoc`.
- Производит: `entityUpdateUiInput`, `entityGetUiInput`, `WireEntity.bodyDoc`.

**ВАЖНО (ПОСЛЕ РЕВЬЮ).** `entityUpdateInput` и `entityGetInput` — схемы тулов модели и MCP; их
парность с рукописными JSON Schema проверяет `tools/registry.test.ts:257-285`, и добавление в
них полей показало бы `bodyDoc` модели. Поэтому обе схемы **не трогаются**, а рядом заводятся
UI-варианты. Побочно это снимает и техническую проблему: `.refine()` превратил бы схему в
`ZodEffects`, у которого нет `.shape`, и тест парности упал бы с TypeError.

- [ ] **Шаг 1: Написать падающие тесты**

Создать `apps/server/src/executor/body-doc.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { entityUpdateUiInput } from '@orbis/shared';
import { parseBody, serializeBody } from '@orbis/shared/doc';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { execute } from './executor';
import type { ExecuteOk, ExecuteRequest, WireEntity } from './types';

beforeAll(() => requireEnv());
afterAll(() => truncateAll());

const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';

/** Та же форма запроса, что в executor.test.ts: execute(db, req, deps) — ТРИ аргумента. */
function req(tool: string, input: unknown, actorUserId: string): ExecuteRequest {
  return { actorUserId, actorKind: 'owner', source: 'ui', operations: [{ tool, input }] };
}

async function rowOf(id: string) {
  const rows = await adminDb().execute(sql`SELECT body, body_doc, body_refs FROM entities WHERE id = ${id}`);
  return rows[0] as { body: string; body_doc: unknown; body_refs: string[] };
}

describe('контракт UI', () => {
  test('bodyDoc принимается UI-схемой', () => {
    const r = entityUpdateUiInput.safeParse({
      id: UUID,
      bodyDoc: { v: 1, doc: { type: 'doc', content: [] } },
      expectedUpdatedAt: '2026-08-13T10:00:00.000Z',
    });
    expect(r.success).toBe(true);
  });

  test('body и bodyDoc одновременно — отказ', () => {
    // Два источника правды в одном запросе: тихий выбор одного из них потерял бы вторую правку.
    const r = entityUpdateUiInput.safeParse({
      id: UUID,
      body: 'текст',
      bodyDoc: { v: 1, doc: { type: 'doc', content: [] } },
      expectedUpdatedAt: '2026-08-13T10:00:00.000Z',
    });
    expect(r.success).toBe(false);
  });
});

describe('конверсия тела в executor', () => {
  test('bodyDoc из UI: в БД ложатся ОБЕ формы, body — проекция документа', async () => {
    await truncateAll();
    const owner = freshUserId();
    const created = (await execute(appDb(), req('entity_create', { title: 'проба', tags: [] }, owner))) as ExecuteOk;
    const entity = created.results[0] as WireEntity;
    const doc = parseBody('текст\n\n{{query: aspect=orbis/task, status=inbox}}');
    await execute(
      appDb(),
      req('entity_update', { id: entity.id, bodyDoc: doc, expectedUpdatedAt: entity.updatedAt }, owner),
    );
    const row = await rowOf(entity.id);
    expect(row.body_doc).toEqual(doc as never);
    expect(row.body).toBe(serializeBody(doc));
  });

  test('строковый body от модели: сервер сам собирает документ', async () => {
    await truncateAll();
    const owner = freshUserId();
    const created = (await execute(
      appDb(),
      req('entity_create', { title: 'от модели', tags: [], body: '# Заголовок' }, owner),
    )) as ExecuteOk;
    const row = await rowOf((created.results[0] as WireEntity).id);
    expect(row.body_doc).toEqual(parseBody('# Заголовок') as never);
  });

  test('body_refs собираются из дерева: ссылка в блоке кода связью не считается', async () => {
    await truncateAll();
    const owner = freshUserId();
    const body = `живая [[entity:${UUID}]]\n\n\`\`\`\n[[entity:11111111-1111-4111-8111-111111111111]]\n\`\`\``;
    const created = (await execute(
      appDb(),
      req('entity_create', { title: 'ссылки', tags: [], body }, owner),
    )) as ExecuteOk;
    const row = await rowOf((created.results[0] as WireEntity).id);
    expect(row.body_refs).toEqual([UUID]);
  });
});
```

- [ ] **Шаг 2: Убедиться, что падают**

```bash
cd /Users/birzhan/projects/orbis && bun run test 2>&1 | grep -B2 -A6 "body-doc"
```

- [ ] **Шаг 3: UI-схемы рядом с тул-контрактами**

В `packages/shared/src/contracts/tools.ts`, ПОСЛЕ `entityUpdateInput` (её саму не менять):

```ts
// Форму документа контракт не разбирает: её знает схема нод (@orbis/shared/doc), а дублирующая
// zod-модель дерева ProseMirror разъехалась бы с ней при первой же новой ноде.
const bodyDocSchema = z.object({ v: z.number().int().positive(), doc: z.record(z.unknown()) });

/**
 * Вход tRPC-роутера: то же, что у тула, плюс структурная форма тела.
 *
 * Почему отдельной схемой, а не расширением entityUpdateInput: та — контракт ТУЛА, её парность
 * с рукописной entityUpdateJsonSchema (tools/registry.ts) проверяет тест, и рост схемы показал
 * бы `bodyDoc` модели — а дизайн держит тул-контракт строковым. Один путь записи (executor),
 * два входа с разными полномочиями.
 */
export const entityUpdateUiInput = entityUpdateInput
  .extend({ bodyDoc: bodyDocSchema.optional() })
  .refine((v) => !(v.body !== undefined && v.bodyDoc !== undefined), {
    message: 'body и bodyDoc одновременно недопустимы',
    path: ['bodyDoc'],
  });
export type EntityUpdateUiInput = z.infer<typeof entityUpdateUiInput>;

/** Симметрично для чтения: UI просит документ, тул-контракт не растёт. */
export const entityGetUiInput = entityGetInput.extend({
  include: z.array(z.enum(['body', 'bodyDoc', 'relations', 'backlinks', 'thread'])).optional(),
});
```

- [ ] **Шаг 4: Роутер принимает UI-схемы**

В `apps/server/src/routers/entity.ts` — только строки `.input(...)`, тела процедур не меняются:

```ts
  // строка 125
  update: ownerOnlyProcedure
    .input(entityUpdateUiInput)

  // строка 151
  get: protectedProcedure
    .input(entityGetUiInput)
```

Импорты в шапке файла — `entityUpdateUiInput`, `entityGetUiInput` вместо прежних (прежние
остаются в `dispatch.ts` и `executor.ts`, там их менять не нужно).

- [ ] **Шаг 5: Executor парсит надмножество**

В `apps/server/src/executor/executor.ts:965` заменить схему разбора:

```ts
  // Надмножество: тулы шлют узкую форму (bodyDoc в ней просто отсутствует), UI — широкую.
  const input = parseEnvelope(entityUpdateUiInput, rawInput, 'entity_update');
```

- [ ] **Шаг 6: Конверсия в ветке update (строка ~1087)**

```ts
  // Тело приходит в ОДНОЙ из двух форм (схема запрещает обе сразу), а в БД всегда ложатся ОБЕ:
  // body_doc — правда, body — проекция и аварийный дубль. Конверсия здесь, перед стадией
  // записи, — единственное место, где формы переводятся друг в друга.
  if (input.bodyDoc !== undefined) {
    const body = serializeBody(input.bodyDoc);
    patch.bodyDoc = input.bodyDoc;
    patch.body = body;
    patch.bodyRefs = bodyRefsFromDoc(input.bodyDoc);
    changed.body = body;
    prior.body = current.body;
  } else if (input.body !== undefined) {
    const doc = parseBody(input.body);
    patch.body = input.body;
    patch.bodyDoc = doc;
    // Ссылки — из дерева и здесь: иначе правка модели и правка из UI считали бы backlinks по
    // разным правилам, и `[[entity:…]]` в блоке кода то появлялся бы в графе, то исчезал.
    patch.bodyRefs = bodyRefsFromDoc(doc);
    changed.body = input.body;
    prior.body = current.body;
  }
```

- [ ] **Шаг 7: То же в ветке create (строка ~806)**

```ts
  const body = input.body ?? '';
  const bodyDoc = parseBody(body);
  const bodyRefs = bodyRefsFromDoc(bodyDoc);
```

и добавить `bodyDoc` в объект вставки рядом с `body`.

- [ ] **Шаг 8: Отдать `bodyDoc` наружу — только по include**

В `packages/shared/src/schemas/entity.ts` рядом с `body`:

```ts
  // Документ едет ТОЛЬКО по явному include: wire-форма несёт body всегда, и второй экземпляр
  // тела в каждом ответе удвоил бы вес любого списка сущностей.
  bodyDoc: z.object({ v: z.number(), doc: z.record(z.unknown()) }).nullable().optional(),
```

В `apps/server/src/wire.ts:26`:

```ts
export function toWireEntity(row: EntityRow, includeBodyDoc = false): WireEntity {
  return {
    // …прежние поля без изменений…
    ...(includeBodyDoc ? { bodyDoc: (row.bodyDoc ?? null) as WireEntity['bodyDoc'] } : {}),
  };
}
```

`toWireEntityFromSql` (`wire.ts:57`) НЕ трогаем: путь `entity.query` документ не отдаёт
намеренно — спискам он не нужен, а вес удвоил бы.

- [ ] **Шаг 9: Ленивая конверсия при чтении**

В `apps/server/src/entity-read.ts`, между получением `row` и созданием `out` (порядок важен —
иначе wire уедет с сырым значением):

```ts
  // Тело, созданное до этой работы, документа ещё не имеет — собираем на лету. Правило
  // разрешения общее с клиентом (readBodyDoc): битую форму или версию из будущего пересобираем
  // из `body`, теряя оформление, но не текст. Обратно в БД здесь НЕ пишем: чтение обязано
  // оставаться чтением, а колонку заполнит бэкфилл или первое же сохранение.
  const wantsDoc = include.has('bodyDoc');
  if (wantsDoc) row.bodyDoc = readBodyDoc(row.bodyDoc, row.body);

  const out: EntityReadResult = { entity: toWireEntity(row, wantsDoc) };
```

- [ ] **Шаг 10: Прогнать тесты и типы**

```bash
cd /Users/birzhan/projects/orbis && bun run test 2>&1 | tail -6
cd apps/server && bun run typecheck && cd ../web && bun run typecheck
```

`tools/registry.test.ts` обязан остаться зелёным без правок — если он покраснел, значит
`bodyDoc` попал в тул-контракт, и это ошибка.

- [ ] **Шаг 11: Коммит**

```bash
git add packages/shared apps/server
git commit -m "feat(server): bodyDoc во входе UI, конверсия в executor, body_refs по дереву"
```

---

## Задача 5: `entity.suggest`, `entity.resolveRefs` и перевод пикеров

**Файлы:**
- Изменить: `apps/server/src/routers/entity.ts` (после `query`, строка ~173)
- Изменить: `packages/shared/src/contracts/tools.ts`
- Изменить: `apps/web/src/features/entity-detail/Blocks.tsx:68,84,254,264`
- Тест: `apps/server/src/routers/entity-suggest.test.ts`

**Интерфейсы:**
- Производит:
  - `entity.suggest({ prefix, limit? })` → `Array<{ id, title, emoji, status, archived }>`
  - `entity.resolveRefs({ ids })` → тот же элемент; ненайденные просто отсутствуют.

- [ ] **Шаг 1: Написать падающие тесты**

Создать `apps/server/src/routers/entity-suggest.test.ts`, обвязку взять из соседнего
`entity.test.ts`:

```ts
describe('entity.suggest', () => {
  test('находит по ПРЕФИКСУ, чего не умеет search=', async () => {
    // plainto_tsquery ищет по целому слову: «куп» не находило «Купить кроссовки», и пикер
    // связей вынужден был извиняться подсказкой. Ради этого процедура и заведена.
    await seedEntity({ title: 'Купить кроссовки' });
    expect((await caller.entity.suggest({ prefix: 'куп' })).map((e) => e.title))
      .toEqual(['Купить кроссовки']);
  });

  test('регистр не важен', async () => {
    await seedEntity({ title: 'Купить кроссовки' });
    expect((await caller.entity.suggest({ prefix: 'КУП' })).length).toBe(1);
  });

  test('архивные не предлагаются', async () => {
    await seedEntity({ title: 'Купить старое', archived: true });
    expect(await caller.entity.suggest({ prefix: 'куп' })).toEqual([]);
  });

  test('статус задачи приезжает плоским полем', async () => {
    await seedEntity({ title: 'Купить хлеб', aspects: { 'orbis/task': { status: 'done' } } });
    expect((await caller.entity.suggest({ prefix: 'куп' }))[0]?.status).toBe('done');
  });
});

describe('entity.resolveRefs', () => {
  test('отдаёт заголовки пачкой', async () => {
    const a = await seedEntity({ title: 'Первая' });
    const b = await seedEntity({ title: 'Вторая' });
    const got = await caller.entity.resolveRefs({ ids: [a.id, b.id] });
    expect(got.map((e) => e.title).sort()).toEqual(['Вторая', 'Первая']);
  });

  test('несуществующий id не роняет запрос и просто отсутствует в ответе', async () => {
    const a = await seedEntity({ title: 'Первая' });
    const got = await caller.entity.resolveRefs({
      ids: [a.id, '11111111-1111-4111-8111-111111111111'],
    });
    expect(got.map((e) => e.id)).toEqual([a.id]);
  });
});
```

`seedEntity` и `caller` — помощники из `entity.test.ts`; если названы иначе, использовать
тамошние.

- [ ] **Шаг 2: Убедиться, что падают**

```bash
cd /Users/birzhan/projects/orbis && bun run test 2>&1 | grep -A5 "entity-suggest"
```

- [ ] **Шаг 3: Контракты**

В `packages/shared/src/contracts/tools.ts`:

```ts
/** Префиксный поиск для `/`-меню и пикеров. Отдельно от грамматики `search=` — см. Р8. */
export const entitySuggestInput = z
  .object({ prefix: z.string().min(1), limit: z.number().int().min(1).max(20).optional() })
  .strict();

/** Заголовки для чипов: пачкой, а не по одному entity.get на каждую ссылку в теле. */
export const entityResolveRefsInput = z
  .object({ ids: z.array(z.string().uuid()).min(1).max(100) })
  .strict();
```

Это входы **только tRPC** — в `tools/registry.ts` они не добавляются, тулами не раздаются.

- [ ] **Шаг 4: Процедуры**

В `apps/server/src/routers/entity.ts` после `query`:

```ts
  /**
   * Префиксный поиск по заголовку (индекс entities_title_prefix). Грамматику `search=` не
   * трогаем: там семантика ЦЕЛОГО слова осмысленна и на неё завязаны сидированные смарт-листы,
   * а `/`-меню без префиксов бесполезно. RLS скоупит выдачу владельцем.
   */
  suggest: protectedProcedure.input(entitySuggestInput).query(async ({ ctx, input }) => {
    const limit = input.limit ?? 10;
    // LIKE по префиксу: экранируем спецсимволы шаблона, иначе `%` из ввода искал бы что угодно.
    const pattern = `${input.prefix.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
    return withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
      const rows = await tx.execute(
        sql`SELECT id, title, emoji, aspects, archived FROM entities
            WHERE archived = false AND lower(title) LIKE ${pattern}
            ORDER BY updated_at DESC LIMIT ${limit}`,
      );
      return rows.map(toSuggestion);
    });
  }),

  /**
   * Заголовки для чипов ссылок ОДНИМ запросом. Per-id entity.get годится для коротких списков
   * связей, но в теле записи ссылок может быть много, и там это шторм запросов. Отдаём ровно
   * то, что рисует чип, а не сущность целиком.
   */
  resolveRefs: protectedProcedure.input(entityResolveRefsInput).query(async ({ ctx, input }) =>
    withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
      const rows = await tx.execute(
        sql`SELECT id, title, emoji, aspects, archived FROM entities
            WHERE id = ANY(${input.ids}::uuid[])`,
      );
      return rows.map(toSuggestion);
    }),
  ),
```

и рядом с хелперами файла:

```ts
/** Форма строки для чипа и пункта меню: только то, что рисуется, — не сущность целиком. */
function toSuggestion(row: Record<string, unknown>) {
  const aspects = (row.aspects ?? {}) as Record<string, Record<string, unknown>>;
  const status = aspects['orbis/task']?.status;
  return {
    id: String(row.id),
    title: String(row.title),
    emoji: row.emoji === null ? null : String(row.emoji),
    status: typeof status === 'string' ? status : null,
    archived: row.archived === true,
  };
}
```

- [ ] **Шаг 5: Перевести пикер связей — и поиск, и резолв заголовков**

В `apps/web/src/features/entity-detail/Blocks.tsx` — поиск (строка 84):

```tsx
  // Был entity.query с `search=`, то есть поиск по ЦЕЛОМУ слову: «Куп» не находило «Купить
  // кроссовки», и пикер честно извинялся подсказкой. С префиксным suggest извиняться не за что.
  const search = trpc.entity.suggest.useQuery(
    { prefix: q, limit: 10 },
    { enabled: adding && q.length >= SEARCH_MIN },
  );
```

Резолв заголовков сторон (строка 68) — тоже пачкой, ради чего `resolveRefs` и заведён:

```tsx
  const sides = trpc.entity.resolveRefs.useQuery({ ids }, { enabled: ids.length > 0 });
  const byId = new Map((sides.data ?? []).map((e) => [e.id, e]));
  const title = (id: string) => byId.get(id)?.title ?? `${id.slice(0, 8)}…`;
  // Пока сущность не доехала — блокер считается живым: спрятать реальную блокировку хуже,
  // чем показать лишнюю строку на время загрузки.
  const alive = (id: string) => {
    const e = byId.get(id);
    return !e || !CLOSED.has(String(e.status ?? ''));
  };
```

Подсказки (строки ~254 и ~264):

```tsx
  ) : q.length < SEARCH_MIN ? (
    <p className={PICKER_NOTE}>Поиск от 2 символов</p>
  ) : found.length === 0 ? (
    <p className={PICKER_NOTE}>Ничего не найдено</p>
```

Фильтр `found` — статус теперь плоский (`e.status`, а не `e.aspects['orbis/task']?.status`).

- [ ] **Шаг 6: Прогнать тесты**

```bash
cd /Users/birzhan/projects/orbis && bun run test 2>&1 | tail -6
```

`Blocks.test.tsx` потребует правки моков — процедуры сменились обе.

- [ ] **Шаг 7: Коммит**

```bash
git add apps/server packages/shared apps/web/src/features/entity-detail
git commit -m "feat(server): entity.suggest по префиксу и entity.resolveRefs пачкой"
```

---

## Задача 6: Базовый редактор, состав расширений, двухфазное монтирование

**Файлы:**
- Создать: `apps/web/src/features/entity-editor/extensions.ts`
- Создать: `apps/web/src/features/entity-editor/BodyEditor.tsx`
- Создать: `apps/web/src/features/entity-editor/EditorShell.tsx`
- Тест: `apps/web/src/features/entity-editor/editor.test.tsx`

**Интерфейсы:**
- Потребляет: `DOC_EXTENSIONS`, `BodyDoc`, `DOC_SCHEMA_VERSION` из `@orbis/shared/doc`.
- Производит:
  - `EDITOR_EXTENSIONS: AnyExtension[]` — состав редактора (схема + UniqueID + безопасность)
  - `BodyEditor({ doc, onChange, onReady? })`
  - `EditorShell({ doc, markdown, onChange })`

- [ ] **Шаг 1: Написать падающие тесты**

```tsx
import { parseBody, serializeBody } from '@orbis/shared/doc';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../test/harness';
import { BodyEditor } from './BodyEditor';
import { EditorShell } from './EditorShell';

// renderWithProviders, а не голый render: после Задачи 8 нода смарт-листа получит NodeView с
// useFieldCatalog и trpc.entity.query — без провайдеров эти тесты упадут позже и непонятно.
test('набор в редакторе отдаёт новый документ через onChange', async () => {
  const onChange = vi.fn();
  renderWithProviders(<BodyEditor doc={parseBody('начало')} onChange={onChange} />, {});
  const area = (await screen.findByTestId('body-editor')).querySelector('[contenteditable]');
  await userEvent.click(area as HTMLElement);
  await userEvent.type(area as HTMLElement, ' и хвост');
  await waitFor(() => expect(onChange).toHaveBeenCalled());
  expect(serializeBody(onChange.mock.calls.at(-1)?.[0])).toContain('и хвост');
});

test('смарт-лист переживает набор рядом с ним и не превращается в текст', async () => {
  // Главное обещание работы: во время правки блок остаётся блоком, а не фигурными скобками.
  const onChange = vi.fn();
  const md = 'привет\n\n{{query: aspect=orbis/task, status=inbox}}';
  renderWithProviders(<BodyEditor doc={parseBody(md)} onChange={onChange} />, {});
  const area = (await screen.findByTestId('body-editor')).querySelector('[contenteditable]');
  await userEvent.type(area as HTMLElement, '!');
  await waitFor(() => expect(onChange).toHaveBeenCalled());
  expect(serializeBody(onChange.mock.calls.at(-1)?.[0])).toContain('{{query: aspect=orbis/task');
});

test('оболочка рисует текст сразу, редактор монтируется следом', async () => {
  renderWithProviders(
    <EditorShell doc={parseBody('видно сразу')} markdown="видно сразу" onChange={vi.fn()} />, {},
  );
  expect(screen.getByText('видно сразу')).toBeTruthy();
  await waitFor(() => expect(screen.getByTestId('body-editor')).toBeTruthy());
});

test('ссылка с опасным протоколом не создаётся', async () => {
  // Разметку в тело приносит ответ модели — вектор не теоретический (тот же довод, что у
  // эшелона обороны в Markdown.tsx).
  const onChange = vi.fn();
  renderWithProviders(<BodyEditor doc={parseBody('текст')} onChange={onChange} />, {});
  const area = (await screen.findByTestId('body-editor')).querySelector('[contenteditable]');
  await userEvent.type(area as HTMLElement, ' javascript:alert(1) ');
  await waitFor(() => expect(onChange).toHaveBeenCalled());
  expect(JSON.stringify(onChange.mock.calls.at(-1)?.[0])).not.toContain('"type":"link"');
});
```

- [ ] **Шаг 2: Убедиться, что падают**

```bash
cd apps/web && bunx vitest run src/features/entity-editor/editor.test.tsx 2>&1 | tail -5
```

Ожидается: FAIL — модуль не существует.

- [ ] **Шаг 3: Состав расширений**

Создать `extensions.ts`:

```ts
import { DOC_EXTENSIONS } from '@orbis/shared/doc';
import type { AnyExtension } from '@tiptap/core';
import UniqueID from '@tiptap/extension-unique-id';

/**
 * Блочные id сегодня не читает никто. Ставятся с первого дня потому, что на них ляжет будущий
 * блочный контракт агента (`body_replace_block(id, md)`): добавить их позже — мигрировать все
 * документы, добавить сейчас — один параметр расширения. В markdown-проекцию id не печатаются.
 *
 * Расширение живёт ТОЛЬКО здесь и не входит в DOC_EXTENSIONS: документы, которые сервер
 * собирает из строкового body модели, приезжают без id — и это нормально, id понадобятся
 * тогда же, когда агент начнёт слать документ вместо строки.
 */
const UNIQUE_ID_TYPES = ['paragraph', 'heading', 'queryBlock', 'rawBlock', 'listItem', 'taskItem'];

/**
 * Белый список протоколов ссылок. `javascript:` и родня ссылкой не становятся — это тот же
 * эшелон обороны, что стоит в просмотре markdown (rehype-sanitize там снимает опасные
 * протоколы), и он обязан быть и здесь: тело пишет в том числе модель.
 */
const SAFE_PROTOCOLS = ['http', 'https', 'mailto'];

export const EDITOR_EXTENSIONS: AnyExtension[] = [
  ...DOC_EXTENSIONS.map((e) =>
    e.name === 'link'
      ? e.configure({ protocols: SAFE_PROTOCOLS, isAllowedUri: (url: string) =>
          SAFE_PROTOCOLS.some((p) => url.startsWith(`${p}:`)) || url.startsWith('/') })
      : e,
  ),
  UniqueID.configure({ types: UNIQUE_ID_TYPES }),
];
```

- [ ] **Шаг 4: Реализовать `BodyEditor`**

```tsx
import { type BodyDoc, DOC_SCHEMA_VERSION } from '@orbis/shared/doc';
import { type Editor, EditorContent, useEditor } from '@tiptap/react';
import { useEffect } from 'react';
import { EDITOR_EXTENSIONS } from './extensions';

export function BodyEditor({
  doc,
  onChange,
  onReady,
}: {
  doc: BodyDoc;
  onChange: (doc: BodyDoc) => void;
  onReady?: (editor: Editor) => void;
}) {
  const editor = useEditor({
    extensions: EDITOR_EXTENSIONS,
    content: doc.doc,
    onCreate: ({ editor: e }) => onReady?.(e),
    onUpdate: ({ editor: e }) => onChange({ v: DOC_SCHEMA_VERSION, doc: e.getJSON() }),
    editorProps: {
      attributes: {
        // Отступы повторяют прежний просмотр: текст не должен прыгать после этой работы.
        class: 'min-h-24 w-full rounded-lg px-2 py-1.5 text-sm leading-relaxed outline-none',
      },
      // Вставка из письма или с сайта проходит тот же путь, что текст модели: разметка
      // снимается, остаётся текст. Иначе через буфер в документ приезжало бы произвольное HTML.
      transformPastedHTML: (html) => html.replace(/<[^>]*>/g, ''),
    },
  });

  // Приезд чужой версии документа. Подменяем ТОЛЬКО когда редактор не в фокусе: иначе чужая
  // правка вырывала бы каретку из-под рук. Полноценное решение — слияние (Р13 дизайна).
  useEffect(() => {
    if (!editor || editor.isFocused) return;
    if (JSON.stringify(editor.getJSON()) !== JSON.stringify(doc.doc)) {
      editor.commands.setContent(doc.doc, { emitUpdate: false });
    }
  }, [editor, doc]);

  return <EditorContent editor={editor} data-testid="body-editor" className="orbis-markdown" />;
}
```

- [ ] **Шаг 5: Реализовать `EditorShell`**

```tsx
import type { BodyDoc } from '@orbis/shared/doc';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Markdown } from '../../lib/markdown/Markdown';
import { openEntity } from '../../state/navigation';

const BodyEditor = lazy(() => import('./BodyEditor').then((m) => ({ default: m.BodyEditor })));

/**
 * Двухфазное монтирование. Редактор теперь И ЕСТЬ просмотр, то есть грузился бы при каждом
 * открытии сущности: замер даёт ~160 kB gzip чанка при 219 kB всей начальной загрузки — ждать
 * его ради первого кадра нельзя. Первый кадр рисует тот же `Markdown`, что и раньше
 * (react-markdown уже в бандле ради чата), редактор встаёт следом и подменяет его.
 *
 * ВАЖНО: `@orbis/shared/doc` не должен импортироваться НИОТКУДА, кроме ленивой части — иначе
 * схема приедет в первый кадр и вся эта конструкция станет бессмысленной.
 */
export function EditorShell({
  doc,
  markdown,
  onChange,
}: {
  doc: BodyDoc;
  markdown: string;
  onChange: (doc: BodyDoc) => void;
}) {
  const [wanted, setWanted] = useState(false);
  useEffect(() => {
    // requestIdleCallback есть не везде (Safari) — таймер как общий знаменатель.
    const id = setTimeout(() => setWanted(true), 0);
    return () => clearTimeout(id);
  }, []);

  const preview = <Markdown source={markdown} onEntityLink={openEntity} />;
  if (!wanted) return preview;
  return (
    <Suspense fallback={preview}>
      <BodyEditor doc={doc} onChange={onChange} />
    </Suspense>
  );
}
```

- [ ] **Шаг 6: Прогнать тесты**

```bash
cd apps/web && bunx vitest run src/features/entity-editor/ >/dev/null 2>&1; echo "код: $?"
```

- [ ] **Шаг 7: Коммит**

```bash
git add apps/web/src/features/entity-editor
git commit -m "feat(web): базовый редактор тела, белый список протоколов, двухфазное монтирование"
```

---

## Задача 7: Чип ссылки с резолвом заголовков одним запросом

**Файлы:**
- Создать: `apps/web/src/features/entity-editor/nodes/RefTitlesContext.tsx`
- Создать: `apps/web/src/features/entity-editor/nodes/EntityChip.tsx`
- Изменить: `apps/web/src/features/entity-editor/{extensions,BodyEditor}.tsx`
- Тест: `apps/web/src/features/entity-editor/nodes/chip.test.tsx`

**Интерфейсы:**
- Потребляет: `entity.resolveRefs` (Задача 5); `EntityRef`, `bodyRefsFromDoc`.
- Производит: `RefTitlesProvider({ ids, children })`, `useRefTitle(id)`, `EntityRefWithView`.

**ПОСЛЕ РЕВЬЮ:** резолв поднят на уровень документа. Хук внутри самого чипа давал бы отдельный
ключ кэша на каждую ссылку — то есть ровно тот шторм запросов, против которого заведён
`resolveRefs`.

- [ ] **Шаг 1: Написать падающие тесты**

```tsx
test('чип показывает АКТУАЛЬНЫЙ заголовок, а не подпись из текста', async () => {
  // Подпись вморожена в текст при вставке; заголовок мог смениться месяц назад.
  const md = `См. [[entity:${UUID}|Старое имя]].`;
  renderWithProviders(<BodyEditor doc={parseBody(md)} onChange={vi.fn()} />, {
    'entity.resolveRefs': () => [{ id: UUID, title: 'Новое имя', emoji: null, status: null, archived: false }],
  });
  expect((await screen.findByTestId('entity-chip')).textContent).toContain('Новое имя');
});

test('весь документ резолвится ОДНИМ запросом', async () => {
  // Ради этого resolveRefs и заведён: per-id ключи давали бы запрос на каждую ссылку.
  const calls: unknown[] = [];
  const md = `[[entity:${UUID}]] и [[entity:${UUID2}]] и снова [[entity:${UUID}]]`;
  renderWithProviders(<BodyEditor doc={parseBody(md)} onChange={vi.fn()} />, {
    'entity.resolveRefs': (input: { ids: string[] }) => { calls.push(input.ids); return []; },
  });
  await waitFor(() => expect(calls.length).toBe(1));
  expect((calls[0] as string[]).sort()).toEqual([UUID, UUID2].sort()); // дубль схлопнут
});

test('закрытая задача — зачёркнутый чип', async () => { /* status: 'done' → класс line-through */ });
test('клик открывает сущность, Ctrl-клик — нет', async () => { /* openEntity зовётся 1 раз */ });
test('неизвестный id не роняет редактор', async () => { /* resolveRefs вернул [] → чип серый */ });
```

- [ ] **Шаг 2: Убедиться, что падают**

```bash
cd apps/web && bunx vitest run src/features/entity-editor/nodes/chip.test.tsx 2>&1 | tail -5
```

- [ ] **Шаг 3: Контекст резолва**

```tsx
import { createContext, useContext, type ReactNode } from 'react';
import { trpc } from '../../../trpc';

type Ref = { id: string; title: string; emoji: string | null; status: string | null; archived: boolean };
const Ctx = createContext<Map<string, Ref>>(new Map());

/**
 * Заголовки для ВСЕХ чипов документа одним запросом. Хук внутри самого чипа завёл бы отдельный
 * ключ кэша на каждую ссылку — в теле с десятком упоминаний это десяток запросов.
 */
export function RefTitlesProvider({ ids, children }: { ids: string[]; children: ReactNode }) {
  const sorted = [...new Set(ids)].sort(); // стабильный ключ кэша: порядок и дубли не важны
  const q = trpc.entity.resolveRefs.useQuery(
    { ids: sorted },
    { enabled: sorted.length > 0, staleTime: 30_000 },
  );
  return <Ctx.Provider value={new Map((q.data ?? []).map((e) => [e.id, e]))}>{children}</Ctx.Provider>;
}

export function useRefTitle(id: string): Ref | undefined {
  return useContext(Ctx).get(id);
}
```

- [ ] **Шаг 4: NodeView чипа**

```tsx
import { buildAppPath } from '@orbis/shared';
import { EntityRef } from '@orbis/shared/doc';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { openEntity } from '../../../state/navigation';
import { useRefTitle } from './RefTitlesContext';

function Chip({ node }: { node: { attrs: { entityId: string; label: string | null } } }) {
  const { entityId, label } = node.attrs;
  const found = useRefTitle(entityId);
  // Пока резолв едет — показываем вмороженную подпись: пустое место мигало бы при каждом
  // открытии записи.
  const text = found?.title ?? label ?? `${entityId.slice(0, 8)}…`;
  const closed = found?.status === 'done' || found?.status === 'cancelled';

  return (
    <NodeViewWrapper as="span" data-testid="entity-chip">
      <a
        href={buildAppPath({ kind: 'entity', id: entityId })}
        contentEditable={false}
        className={`rounded px-1 ${closed ? 'text-text-muted line-through' : found ? 'text-accent' : 'text-text-muted'}`}
        onClick={(e) => {
          // Штатные жесты браузера не перехватываем — то же правило, что в Markdown.tsx:62:
          // ссылка, которая ведёт себя не как ссылка, хуже её отсутствия.
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          openEntity(entityId);
        }}
      >
        {found?.emoji ? `${found.emoji} ` : ''}
        {text}
      </a>
    </NodeViewWrapper>
  );
}

/** Нода из shared + внешний вид: сериализация остаётся общей с сервером, рисование — только тут. */
export const EntityRefWithView = EntityRef.extend({
  addNodeView: () => ReactNodeViewRenderer(Chip),
});
```

- [ ] **Шаг 5: Подменить ноду и обернуть редактор провайдером**

В `extensions.ts` — фильтр и замена:

```ts
// Схема остаётся общей (@orbis/shared/doc), меняется ТОЛЬКО рисование: заменяем ноду её же
// версией с NodeView, а не заводим вторую.
const withViews = DOC_EXTENSIONS.filter((e) => e.name !== 'entityRef').concat(EntityRefWithView);
```

В `BodyEditor.tsx` — обернуть `EditorContent`:

```tsx
import { bodyRefsFromDoc } from '@orbis/shared/doc';
// …
const ids = useMemo(() => bodyRefsFromDoc(doc), [doc]);
return (
  <RefTitlesProvider ids={ids}>
    <EditorContent editor={editor} data-testid="body-editor" className="orbis-markdown" />
  </RefTitlesProvider>
);
```

- [ ] **Шаг 6: Прогнать тесты и коммит**

```bash
cd apps/web && bunx vitest run src/features/entity-editor/ >/dev/null 2>&1; echo "код: $?"
git add apps/web/src/features/entity-editor
git commit -m "feat(web): чип ссылки с актуальным заголовком и резолвом одним запросом"
```

---

## Задача 8: Виджет смарт-листа в документе

**Файлы:**
- Создать: `apps/web/src/features/entity-editor/nodes/QueryWidget.tsx`
- Изменить: `apps/web/src/features/entity-editor/extensions.ts`
- Тест: `apps/web/src/features/entity-editor/nodes/query-widget.test.tsx`

**Интерфейсы:**
- Потребляет: `QueryBlock`, `QUERY_BLOCK_CLOSE` из `@orbis/shared/doc`; существующие
  `QueryBlock` (`lib/query-blocks/QueryBlock.tsx:36`, props `{ query, title?, onConfigure? }`) и
  `QueryBlockEditor` (`features/query-builder/QueryBlockEditor.tsx:19`, props
  `{ initial, onSave, onCancel }`).
- Производит: `QueryBlockWithView`.

- [ ] **Шаг 1: Написать падающие тесты**

```tsx
test('документ с {{query:}} рисует живой виджет, а не текст', async () => { /* … */ });
test('«Настроить» открывает QueryBlockEditor с текстом блока', async () => { /* … */ });
test('сохранение меняет атрибут ноды', async () => {
  // Правка блока стала правкой АТРИБУТА: вместе с этим ушла адресация блока порядковым номером
  // в тексте и её оптимистичная блокировка («Блок изменился в другом месте»).
  // onChange отдаёт документ, чей serializeBody содержит новый запрос и не содержит старый.
});
test('многострочный блок остаётся многострочным после правки соседнего абзаца', async () => { /* … */ });
test('запрос с `}}` не сохраняется', async () => {
  // Рубеж, который держал replaceQueryBlock: `}}` — конец ОБЁРТКИ, и запрос с ним распался бы
  // на блок и текстовый хвост, сдвинув нумерацию блоков (на первом стоит бейдж pinned).
});
```

- [ ] **Шаг 2: Убедиться, что падают**

```bash
cd apps/web && bunx vitest run src/features/entity-editor/nodes/query-widget.test.tsx 2>&1 | tail -5
```

- [ ] **Шаг 3: Реализовать NodeView**

```tsx
import { QUERY_BLOCK_CLOSE, QueryBlock } from '@orbis/shared/doc';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { useState } from 'react';
import { QueryBlock as QueryBlockWidget } from '../../../lib/query-blocks/QueryBlock';
import { useToast } from '../../../ui/toast-store';
import { QueryBlockEditor } from '../../query-builder/QueryBlockEditor';

function Widget({
  node,
  updateAttributes,
}: {
  node: { attrs: { query: string } };
  updateAttributes: (attrs: Record<string, unknown>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const { show } = useToast();

  function save(query: string) {
    // Последний рубеж разметки тела (перенесён из replaceQueryBlock вместе с его причиной):
    // `}}` — не ошибка грамматики, а конец ОБЁРТКИ. Запрос с ним распался бы на блок и
    // текстовый хвост, а `{{query:` в этом хвосте завёл бы лишний блок и сдвинул нумерацию —
    // на первом блоке стоит бейдж pinned-сущности (§3.2).
    if (query.includes(QUERY_BLOCK_CLOSE)) {
      show('В запросе нельзя использовать «}}»', 'danger');
      return;
    }
    updateAttributes({ query });
    setEditing(false);
  }

  return (
    <NodeViewWrapper data-query-widget="" contentEditable={false}>
      <QueryBlockWidget query={node.attrs.query} onConfigure={() => setEditing(true)} />
      {editing && (
        <QueryBlockEditor initial={node.attrs.query} onSave={save} onCancel={() => setEditing(false)} />
      )}
    </NodeViewWrapper>
  );
}

export const QueryBlockWithView = QueryBlock.extend({
  addNodeView: () => ReactNodeViewRenderer(Widget),
});
```

- [ ] **Шаг 4: Подменить ноду в составе**

В `extensions.ts` расширить фильтр (`MoveBlock` здесь ещё НЕТ — он появится в Задаче 10):

```ts
const withViews = DOC_EXTENSIONS
  .filter((e) => e.name !== 'entityRef' && e.name !== 'queryBlock')
  .concat(EntityRefWithView, QueryBlockWithView);
```

- [ ] **Шаг 5: Прогнать тесты и коммит**

```bash
cd apps/web && bunx vitest run src/features/entity-editor/ >/dev/null 2>&1; echo "код: $?"
git commit -am "feat(web): смарт-лист живым виджетом внутри документа"
```

---

## Задача 9: Slash-меню, `@` и создание сущности из текста

**Файлы:**
- Создать: `apps/web/src/features/entity-editor/slash/{items.ts,suggestion.ts,SlashMenu.tsx}`
- Изменить: `apps/web/src/features/entity-editor/BodyEditor.tsx`
- Тест: `apps/web/src/features/entity-editor/slash/slash.test.tsx`

**Интерфейсы:**
- Потребляет: `entity.suggest`, `entity.create`, `QueryBlockEditor`.
- Производит: расширения `SlashCommands` (`/`) и `EntityMention` (`@`).

- [ ] **Шаг 1: Написать падающие тесты**

```tsx
test('«/» открывает меню, «/заг» фильтрует', async () => { /* … */ });
test('выбор «Заголовок 1» превращает абзац в heading', async () => { /* … */ });
test('«/» → «Смарт-лист» вставляет блок в позицию каретки', async () => {
  // Сегодня вставить {{query:…}} из UI нельзя ВОВСЕ — QueryBlockEditor открывается только на
  // существующем блоке. Это новая возможность, а не перенос.
});
test('«@куп» ищет через suggest и вставляет entityRef', async () => { /* … */ });
test('последний пункт создаёт сущность из набранного и вставляет чип', async () => { /* … */ });
test('Esc закрывает меню, «/» остаётся текстом', async () => { /* … */ });
```

- [ ] **Шаг 2: Убедиться, что падают**

```bash
cd apps/web && bunx vitest run src/features/entity-editor/slash/slash.test.tsx 2>&1 | tail -5
```

- [ ] **Шаг 3: Пункты меню**

```ts
import type { Editor } from '@tiptap/react';

export type SlashItem = {
  id: string;
  label: string;
  hint?: string;
  /** Диапазон запроса (`/заг`) удаляет вызывающая сторона — пункт работает по чистому месту. */
  run: (editor: Editor) => void;
};

export function slashItems(openQueryEditor: () => void, openEntityPicker: () => void): SlashItem[] {
  return [
    { id: 'h1', label: 'Заголовок 1', run: (e) => e.chain().focus().setNode('heading', { level: 1 }).run() },
    { id: 'h2', label: 'Заголовок 2', run: (e) => e.chain().focus().setNode('heading', { level: 2 }).run() },
    { id: 'h3', label: 'Заголовок 3', run: (e) => e.chain().focus().setNode('heading', { level: 3 }).run() },
    { id: 'ul', label: 'Список', run: (e) => e.chain().focus().toggleBulletList().run() },
    { id: 'ol', label: 'Нумерованный список', run: (e) => e.chain().focus().toggleOrderedList().run() },
    { id: 'task', label: 'Задача', hint: 'чеклист', run: (e) => e.chain().focus().toggleTaskList().run() },
    { id: 'quote', label: 'Цитата', run: (e) => e.chain().focus().toggleBlockquote().run() },
    { id: 'code', label: 'Код', run: (e) => e.chain().focus().toggleCodeBlock().run() },
    { id: 'table', label: 'Таблица', run: (e) => e.chain().focus().insertTable({ rows: 2, cols: 2 }).run() },
    { id: 'hr', label: 'Разделитель', run: (e) => e.chain().focus().setHorizontalRule().run() },
    // Своё. «Смарт-лист» закрывает дыру: сегодня вставить {{query:…}} из UI нельзя вовсе.
    { id: 'query', label: 'Смарт-лист', hint: 'живой список по запросу', run: () => openQueryEditor() },
    { id: 'ref', label: 'Ссылка на сущность', hint: 'или @', run: () => openEntityPicker() },
  ];
}
```

- [ ] **Шаг 4: Suggestion-плагин**

```ts
import { Extension } from '@tiptap/core';
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion';

/**
 * Общая обёртка для «/» и «@». Позиционирование меню считаем сами по
 * `editor.view.coordsAtPos`: floating-ui в дереве есть (его тянут и radix, и сам suggestion),
 * но выпадашке по известной позиции каретки хватает координат — лишний слой ей ни к чему.
 */
export function makeSuggestionExtension(
  name: string,
  char: string,
  options: Omit<SuggestionOptions, 'editor' | 'char'>,
) {
  return Extension.create({
    name,
    addProseMirrorPlugins() {
      return [Suggestion({ editor: this.editor, char, ...options })];
    },
  });
}
```

- [ ] **Шаг 5: Меню**

```tsx
import { useEffect, useState } from 'react';

export type MenuRow = { id: string; label: string; hint?: string };

/**
 * Список с клавиатурной навигацией. Мышь здесь вспомогательна: меню вызывается набором, значит
 * руки уже на клавиатуре, и путь «набрал → стрелка → Enter» обязан работать целиком.
 */
export function SlashMenu({
  rows,
  onPick,
  onClose,
  coords,
}: {
  rows: MenuRow[];
  onPick: (id: string) => void;
  onClose: () => void;
  coords: { left: number; top: number };
}) {
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [rows]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % Math.max(rows.length, 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + rows.length) % Math.max(rows.length, 1)); }
      else if (e.key === 'Enter') { e.preventDefault(); const row = rows[active]; if (row) onPick(row.id); }
      else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [rows, active, onPick, onClose]);

  if (rows.length === 0) return null;
  return (
    <ul
      role="listbox"
      data-testid="slash-menu"
      style={{ position: 'absolute', left: coords.left, top: coords.top }}
      className="z-50 max-h-72 w-64 overflow-y-auto rounded-control border border-line bg-surface-1 py-1 shadow-lg"
    >
      {rows.map((r, i) => (
        <li key={r.id}>
          <button
            type="button"
            role="option"
            aria-selected={i === active}
            onMouseDown={(e) => { e.preventDefault(); onPick(r.id); }}
            className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm ${i === active ? 'bg-surface-2' : ''}`}
          >
            <span className="truncate">{r.label}</span>
            {r.hint && <span className="truncate text-xs text-text-muted">{r.hint}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}
```

Для `@` и «Ссылки на сущность» строки приезжают из `trpc.entity.suggest`; последней строкой —
«Создать „<набранное>“»:

```ts
// Сущность рождается прямо из набранного слова и тут же встаёт ссылкой: иначе «упомянуть то,
// чего ещё нет» требовало бы уйти с экрана и потерять мысль.
const created = await createEntity.mutateAsync({ title: query, tags: [] });
editor.chain().focus().deleteRange(range)
  .insertContent({ type: 'entityRef', attrs: { entityId: created.id, label: query } })
  .run();
```

- [ ] **Шаг 6: Прогнать тесты и коммит**

```bash
cd apps/web && bunx vitest run src/features/entity-editor/ >/dev/null 2>&1; echo "код: $?"
git commit -am "feat(web): slash-меню, упоминания через @ и создание сущности из текста"
```

---

## Задача 10: Bubble-меню и перемещение блока с клавиатуры

**Файлы:**
- Создать: `apps/web/src/features/entity-editor/BubbleToolbar.tsx`
- Создать: `apps/web/src/features/entity-editor/move-block.ts`
- Изменить: `apps/web/src/features/entity-editor/{extensions,BodyEditor}.tsx`
- Тест: `apps/web/src/features/entity-editor/bubble.test.tsx`

**Интерфейсы:**
- Производит: `BubbleToolbar({ editor })`; расширение `MoveBlock` (`Alt+↑` / `Alt+↓`).

- [ ] **Шаг 1: Написать падающие тесты**

```tsx
test('при схлопнутом выделении панель скрыта, при непустом — видна', async () => {
  // ВАЖНО: @tiptap/react/menus держит элемент в DOM всегда и прячет его стилем
  // (bubbleMenuElement.style.visibility = 'hidden'), поэтому проверять надо visibility,
  // а не присутствие в дереве — queryByTestId найдёт его в обоих случаях.
  const el = await screen.findByTestId('bubble-toolbar');
  expect(el.style.visibility).toBe('hidden');
  // …выделить текст…
  await waitFor(() => expect(el.style.visibility).not.toBe('hidden'));
});

test('«Жирный» оборачивает выделение', async () => { /* serializeBody содержит ** */ });
test('Alt+↓ меняет местами текущий абзац со следующим', async () => { /* порядок в serializeBody */ });
test('Alt+↑ на первом блоке ничего не ломает', async () => { /* документ не изменился */ });
```

- [ ] **Шаг 2: Убедиться, что падают**

```bash
cd apps/web && bunx vitest run src/features/entity-editor/bubble.test.tsx 2>&1 | tail -5
```

- [ ] **Шаг 3: Панель**

```tsx
import type { Editor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { Bold, Code, Italic, Strikethrough, Trash2 } from 'lucide-react';
import { Button } from '../../ui/Button';

/**
 * Действия над блоком живут здесь, а не на drag handle: расширение drag handle тянет
 * extension-collaboration + y-tiptap + yjs (~25 kB gzip из своих 40) — инфраструктуру, которую
 * эта работа сознательно не строит (Р13). Перетаскивание вернётся вместе с соредактированием,
 * когда yjs будет в бандле по любому и handle подешевеет втрое. Порядок блоков сейчас меняют
 * Alt+↑/↓ — команды ProseMirror, вес ~0.
 */
export function BubbleToolbar({ editor }: { editor: Editor | null }) {
  if (!editor) return null;
  return (
    <BubbleMenu editor={editor} data-testid="bubble-toolbar">
      <div className="flex items-center gap-0.5 rounded-control border border-line bg-surface-1 p-1 shadow-lg">
        <Button size="icon" variant="ghost" aria-label="Жирный" onClick={() => editor.chain().focus().toggleBold().run()}>
          <Bold size={14} aria-hidden />
        </Button>
        <Button size="icon" variant="ghost" aria-label="Курсив" onClick={() => editor.chain().focus().toggleItalic().run()}>
          <Italic size={14} aria-hidden />
        </Button>
        <Button size="icon" variant="ghost" aria-label="Зачёркнутый" onClick={() => editor.chain().focus().toggleStrike().run()}>
          <Strikethrough size={14} aria-hidden />
        </Button>
        <Button size="icon" variant="ghost" aria-label="Код" onClick={() => editor.chain().focus().toggleCode().run()}>
          <Code size={14} aria-hidden />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Удалить блок"
          onClick={() => editor.chain().focus().deleteNode(editor.state.selection.$from.parent.type.name).run()}
        >
          <Trash2 size={14} aria-hidden />
        </Button>
      </div>
    </BubbleMenu>
  );
}
```

- [ ] **Шаг 4: Горячие клавиши перемещения блока**

Создать `move-block.ts`:

```ts
import { Extension } from '@tiptap/core';

/**
 * Перемещение блока с клавиатуры — замена перетаскиванию мышью. Жест знаком по редакторам кода,
 * работает с внешней клавиатурой на планшете и ничего не весит.
 */
export const MoveBlock = Extension.create({
  name: 'moveBlock',
  addKeyboardShortcuts() {
    const move = (dir: -1 | 1) => () => {
      const { state, view } = this.editor;
      const { $from } = state.selection;
      const depth = 1; // блок верхнего уровня
      const index = $from.index(depth - 1);
      const parent = $from.node(depth - 1);
      const target = index + dir;
      // Край документа — не ошибка: просто ничего не делаем, чтобы жест не прыгал с конца в начало.
      if (target < 0 || target >= parent.childCount) return true;
      const from = $from.before(depth);
      const node = $from.node(depth);
      const tr = state.tr.delete(from, from + node.nodeSize);
      const insertAt = dir === 1 ? from + parent.child(target).nodeSize : from - parent.child(target).nodeSize;
      tr.insert(insertAt, node);
      view.dispatch(tr.scrollIntoView());
      return true;
    };
    return { 'Alt-ArrowUp': move(-1), 'Alt-ArrowDown': move(1) };
  },
});
```

- [ ] **Шаг 5: Подключить**

В `extensions.ts`:

```ts
export const EDITOR_EXTENSIONS: AnyExtension[] = [
  ...withViews,
  UniqueID.configure({ types: UNIQUE_ID_TYPES }),
  MoveBlock,
];
```

В `BodyEditor.tsx` — панель внутри провайдера, рядом с содержимым:

```tsx
  return (
    <RefTitlesProvider ids={ids}>
      <BubbleToolbar editor={editor} />
      <EditorContent editor={editor} data-testid="body-editor" className="orbis-markdown" />
    </RefTitlesProvider>
  );
```

- [ ] **Шаг 6: Прогнать тесты и коммит**

```bash
cd apps/web && bunx vitest run src/features/entity-editor/ >/dev/null 2>&1; echo "код: $?"
git commit -am "feat(web): bubble-меню выделения и Alt+стрелки для порядка блоков"
```

---

## Задача 11: Markdown-тумблер

**Файлы:**
- Создать: `apps/web/src/features/entity-editor/MarkdownToggle.tsx`
- Тест: `apps/web/src/features/entity-editor/markdown-toggle.test.tsx`

**Интерфейсы:**
- Потребляет: `parseBody`, `serializeBody`.
- Производит: `MarkdownToggle({ doc, onChange, onClose })`.
- Подключение к меню ⋮ — Задача 14 (там же перестраивается экран).

- [ ] **Шаг 1: Написать падающие тесты**

```tsx
test('показывает ровно serializeBody(doc)', async () => { /* … */ });
test('правка и «Применить» отдают документ, чей serializeBody равен тексту', async () => { /* … */ });
test('текст без изменений не отправляет onChange вовсе', async () => { /* без изменений — без записи */ });
test('неразбираемое не сохраняется молча', async () => {
  // parseBody не бросает (сверка round-trip уводит непонятое в raw), но тумблер обязан
  // показать, что текст стал одним неразобранным блоком, — иначе пользователь решит, что
  // разметка принята.
});
```

- [ ] **Шаг 2: Убедиться, что падают**

```bash
cd apps/web && bunx vitest run src/features/entity-editor/markdown-toggle.test.tsx 2>&1 | tail -5
```

- [ ] **Шаг 3: Реализовать**

```tsx
import { type BodyDoc, parseBody, serializeBody } from '@orbis/shared/doc';
import { useState } from 'react';
import { Button } from '../../ui/Button';

/**
 * Правка тела как markdown — для тех, кто пишет разметку руками, и как окно в то, что реально
 * лежит в `body` (а лежит там ровно эта строка: FTS, промпт и MCP читают её же).
 */
export function MarkdownToggle({
  doc,
  onChange,
  onClose,
}: {
  doc: BodyDoc;
  onChange: (doc: BodyDoc) => void;
  onClose: () => void;
}) {
  const initial = serializeBody(doc);
  const [text, setText] = useState(initial);
  const [warning, setWarning] = useState<string | null>(null);

  function apply() {
    // Без изменений — без записи: лишняя мутация подняла бы updated_at ни за что.
    if (text === initial) {
      onClose();
      return;
    }
    const next = parseBody(text);
    // parseBody не бросает: непонятую разметку он уводит в rawBlock целиком, сохраняя текст
    // дословно. Но принять это молча нельзя — иначе человек решит, что его разметку разобрали.
    const isRaw = next.doc.content?.length === 1 && next.doc.content[0]?.type === 'rawBlock';
    if (isRaw) {
      setWarning('Разметка не разобрана целиком — текст сохранится как есть, одним блоком.');
    }
    onChange(next);
    onClose();
  }

  return (
    <div className="flex flex-col gap-2">
      <textarea
        data-testid="markdown-source"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="min-h-64 w-full rounded-lg bg-transparent px-2 py-1.5 font-mono text-sm outline-none"
      />
      {warning !== null && (
        <p role="alert" className="text-sm text-warning">
          {warning}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>Отмена</Button>
        <Button size="sm" onClick={apply}>Применить</Button>
      </div>
    </div>
  );
}
```

- [ ] **Шаг 4: Прогнать тесты и коммит**

```bash
cd apps/web && bunx vitest run src/features/entity-editor/ >/dev/null 2>&1; echo "код: $?"
git commit -am "feat(web): тумблер правки тела как markdown"
```

---

## Задача 12: Сохранение по паузе, индикатор состояния, 409

**Файлы:**
- Создать: `apps/web/src/features/entity-editor/useBodySave.ts`
- Создать: `apps/web/src/features/entity-editor/SaveIndicator.tsx`
- Изменить: `apps/web/src/features/entity-detail/useEntityDetail.ts:12-17,25-40`
- Тест: `apps/web/src/features/entity-editor/save.test.tsx`

**Интерфейсы:**
- Потребляет: `useEntityUpdate` (`useEntityDetail.ts:44`).
- Производит:
  ```ts
  useBodySave(entityId: string, entity: { updatedAt: string }): {
    onDocChange: (doc: BodyDoc) => void;
    flush: () => void;
    state: 'idle' | 'saving' | 'error';
    conflict: boolean;
    /** Черновик из прошлой сессии, разошедшийся с сервером (заполняет Задача 13). */
    pendingDraft: { doc: BodyDoc; savedAt: string } | null;
    applyPendingDraft: () => void;
    discardPendingDraft: () => void;
  }
  ```

- [ ] **Шаг 1: Написать падающие тесты**

```tsx
test('набор не шлёт мутацию сразу; после паузы — ровно одну', async () => {
  vi.useFakeTimers();
  // …три onDocChange подряд…
  vi.advanceTimersByTime(2000);
  expect(mutate).toHaveBeenCalledTimes(1);
});
test('flush() шлёт немедленно', async () => { /* … */ });
test('документ не изменился → мутации нет вовсе', async () => { /* … */ });
test('мутация уходит с bodyDoc и точным expectedUpdatedAt', async () => { /* строка из кэша */ });
test('отказ показывает «Не сохранено» и держит до успеха', async () => { /* … */ });
test('409 поднимает conflict и НЕ подменяет документ', async () => { /* … */ });
```

- [ ] **Шаг 2: Убедиться, что падают**

```bash
cd apps/web && bunx vitest run src/features/entity-editor/save.test.tsx 2>&1 | tail -5
```

- [ ] **Шаг 3: Расширить `DETAIL_INCLUDE` и `applyPatch`**

В `apps/web/src/features/entity-detail/useEntityDetail.ts:12`:

```ts
// bodyDoc — источник документа для редактора. Без него редактор пришлось бы собирать из
// markdown на клиенте, и блочные id (Р5) до него бы не доезжали вовсе.
const DETAIL_INCLUDE: NonNullable<RouterInputs['entity']['get']['include']> = [
  'body',
  'bodyDoc',
  'relations',
  'backlinks',
  'thread',
];
```

В `applyPatch` (строка 25):

```ts
  if (input.bodyDoc !== undefined) {
    next.bodyDoc = input.bodyDoc;
    // `body` НЕ трогаем: markdown-проекцию делает сервер, и только он. Клиентский сериализатор
    // затащил бы всю схему документа (~156 kB gzip) в чанк detail — то есть в первый кадр,
    // ровно мимо двухфазного монтирования; а две реализации проекции ещё и разошлись бы.
    // До ответа сервера просмотр показывает прежний текст — это заметно только при отказе сети.
  }
```

- [ ] **Шаг 4: Реализовать `useBodySave`**

Пауза — 2000 мс:

```ts
// Пауза щедрая намеренно: onSettled мутации зовёт invalidateGraph(utils) — инвалидацию ВСЕГО
// графа (useEntityDetail.ts:75), и сохранение на каждый штрих било бы по кэшу каждые несколько
// нажатий.
const SAVE_DEBOUNCE_MS = 2000;
```

Поля `pendingDraft`, `applyPendingDraft`, `discardPendingDraft` объявляются здесь и в этой
задаче возвращают `null` / no-op — их наполняет Задача 13. Объявлены сразу, чтобы её
исполнителю не пришлось менять сигнатуру чужого хука.

- [ ] **Шаг 5: Индикатор**

```tsx
// Успех не празднуем. Постоянный статус в углу — ровно та панель инструментов над каждой
// заметкой, от которой экран отказывается сознательно (DetailScreen.tsx:373); молчание здесь
// и означает «всё сохранено». «Сохраняем…» показывается только если запрос идёт дольше секунды.
```

- [ ] **Шаг 6: Прогнать тесты и коммит**

```bash
cd apps/web && bunx vitest run src/features/ >/dev/null 2>&1; echo "код: $?"
git commit -am "feat(web): сохранение тела по паузе, индикатор состояния, поведение при 409"
```

---

## Задача 13: Офлайн-черновик

**Файлы:**
- Создать: `apps/web/src/features/entity-editor/draft-storage.ts`
- Изменить: `apps/web/src/features/entity-editor/useBodySave.ts`
- Тест: `apps/web/src/features/entity-editor/draft.test.ts`

**Интерфейсы:**
- Потребляет: `useBodySave` (Задача 12) — поля `pendingDraft`, `applyPendingDraft`,
  `discardPendingDraft` уже объявлены.
- Производит: `saveDraft`, `readDraft`, `clearDraft`;
  `type Draft = { doc: BodyDoc; baseUpdatedAt: string; savedAt: string }`.

- [ ] **Шаг 1: Написать падающие тесты**

```ts
test('неотправленная правка попадает в localStorage', () => { /* … */ });
test('успешное сохранение стирает черновик', () => { /* … */ });
test('черновик читается после перемонтирования', () => { /* … */ });
test('при неизменившемся updatedAt черновик уходит сам', () => { /* … */ });
test('при изменившемся updatedAt автодосыла НЕТ — предлагается выбор', () => { /* … */ });
test('черновик чужой сущности не подставляется', () => { /* ключ включает id */ });
```

- [ ] **Шаг 2: Убедиться, что падают**

```bash
cd apps/web && bunx vitest run src/features/entity-editor/draft.test.ts 2>&1 | tail -5
```

- [ ] **Шаг 3: Хранилище**

```ts
import type { BodyDoc } from '@orbis/shared/doc';

/**
 * Неотправленный черновик тела — на диск браузера. Retry-буфер (state/retry.ts) здесь не
 * помощник: он принимает только entity.create от fast-path, а у update есть expectedUpdatedAt,
 * который протухает — правка, пролежавшая час, приедет с 409, то есть отложенная отправка
 * обещала бы то, чего не может выполнить.
 *
 * Это персистенция содержимого сущности на диск, и она принята владельцем явно: случай
 * отличается от истории чата (её в localStorage не держим) — здесь не архив, а собственный
 * неотправленный черновик, живущий до первого успеха. Для приложения-памяти потеря набранного
 * текста — тот же худший класс ошибки, ради которого заведены raw-нода и key={entity.id}.
 */
export type Draft = { doc: BodyDoc; baseUpdatedAt: string; savedAt: string };

// Ключ включает id: черновик одной записи не должен подставиться в другую.
const key = (entityId: string) => `orbis:body-draft:${entityId}`;

export function saveDraft(entityId: string, doc: BodyDoc, baseUpdatedAt: string, now: string): void {
  try {
    localStorage.setItem(key(entityId), JSON.stringify({ doc, baseUpdatedAt, savedAt: now }));
  } catch {
    // Переполненное или отключённое хранилище не повод ронять набор текста: черновик —
    // страховка, а не главный путь. Молча остаёмся без страховки.
  }
}

export function readDraft(entityId: string): Draft | null {
  try {
    const raw = localStorage.getItem(key(entityId));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Draft;
    return parsed.doc && parsed.baseUpdatedAt ? parsed : null;
  } catch {
    return null; // битую запись игнорируем — она хуже отсутствия
  }
}

export function clearDraft(entityId: string): void {
  try {
    localStorage.removeItem(key(entityId));
  } catch {
    /* см. saveDraft */
  }
}
```

- [ ] **Шаг 4: Логика возврата в `useBodySave`**

```ts
const draft = readDraft(entityId);
if (draft !== null) {
  if (draft.baseUpdatedAt === entity.updatedAt) {
    // Сервер с тех пор не менялся — досылаем тихо: спрашивать не о чем.
    mutation.mutate({ id: entityId, bodyDoc: draft.doc, expectedUpdatedAt: entity.updatedAt });
  } else {
    // Правило нарочно грубое и честное: сравнили updatedAt, спросили пользователя. Именно сюда
    // потом встанет слияние — не переделывая ничего вокруг.
    setPendingDraft(draft);
  }
}
```

`applyPendingDraft` шлёт черновик с ТЕКУЩИМ `updatedAt`; `discardPendingDraft` зовёт
`clearDraft`. Баннер рисует Задача 14 по полю `pendingDraft`.

- [ ] **Шаг 5: Прогнать тесты и коммит**

```bash
cd apps/web && bunx vitest run src/features/entity-editor/ >/dev/null 2>&1; echo "код: $?"
git commit -am "feat(web): офлайн-черновик тела переживает закрытие вкладки"
```

---

## Задача 14: Три таба — Сущность · Детали · Тред

**Файлы:**
- Изменить: `apps/web/src/ui/Tabs.tsx`
- Изменить: `apps/web/src/features/entity-detail/DetailScreen.tsx:95-192`
- Изменить: `apps/web/src/features/entity-detail/AspectCards.tsx` (вынести полосу прогресса)
- Изменить: `apps/web/src/features/entity-detail/detail.test.tsx`

**Интерфейсы:** потребляет `EditorShell`, `MarkdownToggle`, `useBodySave`, `GoalProgress`.

- [ ] **Шаг 1: Написать падающие тесты**

```tsx
test('на «Сущности» — emoji, заголовок, тело; карточек аспектов там НЕТ', async () => { /* … */ });
test('«Детали» показывает аспекты, подзадачи, блокировки, связанное', async () => { /* … */ });
test('полоса прогресса цели осталась на «Сущности»', async () => { /* … */ });
test('переключение табов не роняет несохранённый черновик тела', async () => {
  // Radix Tabs по умолчанию РАЗМОНТИРУЕТ неактивную вкладку: уход на «Детали» уничтожил бы
  // редактор вместе с текстом и историей Ctrl+Z. Лечится forceMount (шаг 3).
});
test('пункт меню «Править как markdown» переключает тело на тумблер', async () => { /* … */ });
```

- [ ] **Шаг 2: Убедиться, что падают**

```bash
cd apps/web && bunx vitest run src/features/entity-detail/detail.test.tsx 2>&1 | tail -5
```

- [ ] **Шаг 3: Сохранять содержимое неактивных вкладок**

В `apps/web/src/ui/Tabs.tsx`:

```tsx
      {tabs.map((t) => (
        // forceMount: Radix по умолчанию размонтирует неактивную вкладку, а на «Сущности»
        // теперь живёт редактор с несохранённым текстом и историей отмены. Уход на «Детали»
        // и обратно уничтожал бы и то, и другое, а заодно гонял двухфазное монтирование заново.
        // hidden по data-state — иначе неактивная вкладка осталась бы видимой.
        <RT.Content
          key={t.value}
          value={t.value}
          forceMount
          className="pt-3 data-[state=inactive]:hidden"
        >
          {t.content}
        </RT.Content>
      ))}
```

- [ ] **Шаг 4: Перестроить экран**

```tsx
// «Сущность» — чистый документ; всё остальное, что известно о записи, уехало в «Детали».
// Полоса прогресса — исключение: у цели прогресс это то, ради чего её открывают, и прятать
// «67%, 8 из 12 кг» во второй таб значило бы ухудшить главный экран целей ради чистоты.
<Tabs
  defaultValue="entity"
  tabs={[
    { value: 'entity', label: 'Сущность', content: entityTab },
    { value: 'details', label: 'Детали', content: detailsTab },
    { value: 'thread', label: 'Тред', content: threadTab },
  ]}
/>
```

В `entityTab` — emoji, `NativeRow`, полоса прогресса цели, баннер `pendingDraft` (Задача 13),
`SaveIndicator` и тело: `asMarkdown ? <MarkdownToggle …/> : <EditorShell …/>`. Документ берётся
из `entity.bodyDoc` (приезжает с сервера по include, Задача 12).

Пункт меню ⋮ (`DetailMenu`): `{ label: 'Править как markdown', icon: <Code size={16} aria-hidden />,
onSelect: () => setAsMarkdown((v) => !v) }`; `Code` — из `lucide-react`.

- [ ] **Шаг 5: Прогнать весь сьют**

```bash
cd /Users/birzhan/projects/orbis && bun run test 2>&1 | tail -6
```

`detail.test.tsx` потребует заметной правки: тесты, искавшие секции на вкладке «Сущность»,
переключаются на «Детали». **Отдельно:** `body-view` в строках 247, 302, 344 и 1008 служит
маркером «экран отрисован» и к телу отношения не имеет — эти четыре места надо ПЕРЕВЕСИТЬ на
другой маркер (например, заголовок), а не удалять вместе с тестами тела.

- [ ] **Шаг 6: Коммит**

```bash
git commit -am "feat(web): три таба detail — Сущность, Детали, Тред"
```

---

## Задача 15: Уборка старого пути и правка PRD

**Файлы:**
- Изменить: `apps/web/src/features/entity-detail/DetailScreen.tsx`
- Изменить: `apps/web/src/features/browser/query.ts`, `query.test.ts`
- Изменить: `docs/prd/02-core-os.md:413-429`

- [ ] **Шаг 1: Убедиться, что удаляемое никем не используется**

```bash
cd /Users/birzhan/projects/orbis
grep -rn "replaceQueryBlock\|BodySection\|body-edit\|body-view" apps/ packages/ scripts/ --include="*.tsx" --include="*.ts"
```

Ожидается: только определения и их собственные тесты.

- [ ] **Шаг 2: Удалить код и его тесты**

| Что | Где | Почему уходит |
|---|---|---|
| `BodySection` | `DetailScreen.tsx:227-408` | режимов больше нет — документ всегда живой |
| `QueryWidgets` | `DetailScreen.tsx:207-217` | виджеты теперь внутри документа |
| `BODY_PLACEHOLDER`, `BODY_BOX_CLASS` | `DetailScreen.tsx:195-200` | их место занял `editorProps.attributes` |
| `replaceQueryBlock` | `browser/query.ts:84-111` | правка блока стала правкой атрибута ноды |
| тесты `replaceQueryBlock` | `browser/query.test.ts` | вместе с функцией |

**НЕ удалять:** `bodySegments`, `queryBlocks`, `firstQueryBlock` — они читают markdown-проекцию
и питают бейджи pinned-сущностей (`PinnedList.tsx:22`).

- [ ] **Шаг 3: Правка §3.5 PRD**

Заменить пункт 3 (строка 417) целиком:

```markdown
3. **Body** — единый WYSIWYG-редактор, режима «просмотр» и «правка» больше нет: `[[entity:…]]`
   рисуются чипами с актуальным заголовком и статусом, `{{query:…}}` — живыми виджетами (§3.4),
   и они остаются собой во время набора. Вставка блоков, ссылок и новых сущностей — через `/`
   (упоминание — ещё и через `@`). Форматирование выделения — всплывающей панелью, порядок
   блоков — `Alt+↑/↓`. Сохранение автоматическое: по паузе в наборе и на уходе фокуса; экран
   молчит, пока всё хорошо, и говорит «Не сохранено», когда нет. Правка, набранная без сети,
   переживает закрытие вкладки и досылается при возврате. Пункт меню ⋮ **«Править как
   markdown»** показывает то, что лежит в `body`, и принимает правку текстом.

   **Правда тела — структура.** `entities.body_doc` хранит документ (`{v, doc}`), `body`
   остаётся markdown-проекцией: её читают FTS, промпт, MCP и бейджи pinned-сущностей. Проекция
   же служит аварийным дублем — документ с незнакомой версией схемы пересобирается из неё, так
   что худший исход отката релиза — потеря оформления, но не текста. Текст, который схема не
   может разобрать без потерь (например, сноски GFM), сохраняется одним неразобранным блоком
   дословно и правится через markdown. Модель и MCP по-прежнему пишут строковый `body`;
   документ из него собирает сервер.
```

Перечисление секций (строка 413) переписать под три таба: «Сущность» — title+emoji, полоса
прогресса цели, body; «Детали» — карточки аспектов, подзадачи, блокировки, связанное; «Тред» —
без изменений. Из «Ещё не реализовано» (строки 424–429) снять то, что работа закрыла; остальные
долги (теги, emoji, «+аспект», чеклист подзадач) оставить.

- [ ] **Шаг 4: Полная проверка**

```bash
cd /Users/birzhan/projects/orbis
bun run test 2>&1 | tail -6
bunx biome check . 2>&1 | tail -3; echo "lint: $?"
cd apps/web && bun run build 2>&1 | grep -E "index-|DetailScreen|BodyEditor"
```

Ожидается: сьюты зелёные ПО КОДУ ВОЗВРАТА, lint 0, чанк `BodyEditor` отдельным файлом.
**Отдельно проверить, что схема документа НЕ уехала во входной чанк:** размер `index-*.js`
не должен вырасти больше чем на несколько kB gzip относительно 161.7 kB базы.

- [ ] **Шаг 5: Коммит**

```bash
git commit -am "refactor(web): снять двухрежимное тело и адресацию блоков по номеру; PRD к факту"
```

---

## Самопроверка плана

**Покрытие дизайна.** Р1 → Задачи 2, 3, 4. Р2 → Задачи 1, 6. Р3 (включая сверку round-trip и
`raw`) → Задача 2. Р4 → Задача 2. Р5 (UniqueID) → Задача 6. Р6 (UI-схемы, единственный путь) →
Задача 4. Р7 → Задачи 2, 4. Р8 (suggest + resolveRefs, оба пикера) → Задачи 5, 7. Р9 → Задача 14.
Р10 (пауза, индикатор, 409, клиент не сериализует) → Задача 12. Р11 → Задача 13.
Р12 (протоколы + вставка + схема) → Задача 6. Р13 — швы, отдельной задачи не требует.
Состав редактора → Задачи 6–11. Уборка → Задача 15.

**Не покрыто намеренно:** мобильный ввод (проверка владельцем на устройстве) и round-trip на
корпусе тел с прода (нужна ops-команда выгрузки — решение владельца).

**Согласованность имён.** `parseBody`/`serializeBody`/`bodyRefsFromDoc`/`readBodyDoc`/`BodyDoc`/
`DOC_SCHEMA_VERSION`/`QUERY_BLOCK_CLOSE` — все из `@orbis/shared/doc` (Задача 2), используются
в 3, 4, 6, 7, 8, 11, 12, 13 под теми же именами. Ноды: `EntityRef` → `EntityRefWithView`,
`QueryBlock` (нода) → `QueryBlockWithView`; компонент-виджет импортируется как
`QueryBlockWidget`. Схемы: `entityUpdateInput`/`entityGetInput` — тулы, `entityUpdateUiInput`/
`entityGetUiInput` — tRPC. Хук `useBodySave` объявляет полный набор полей в Задаче 12, наполняет
их Задача 13.
