# Notion-подобный редактор — скорректированный план (v2)

> **Для агентных исполнителей:** ОБЯЗАТЕЛЬНЫЙ САБ-СКИЛЛ — `superpowers:subagent-driven-development`
> (рекомендуется) либо `superpowers:executing-plans`. Шаги размечены чекбоксами (`- [ ]`).
>
> **Этот план ГЛАВНЕЕ плана `2026-08-13-notion-like-editor.md`.** Читать оба: для задач,
> помеченных «без изменений», исполнять старый план дословно; для остальных здесь дан полный
> код или точечные правки. При любом конфликте побеждает v2.

**Цель:** та же, что в плане 2026-08-13 — единый WYSIWYG вместо двухрежимного тела; ссылки и
смарт-листы остаются живыми во время набора.

**Что изменилось и почему:** второй круг ревью (`docs/superpowers/reviews/2026-08-14-editor-design-plan-review.md`,
принят контроллером целиком — `docs/superpowers/reviews/2026-08-14-editor-review-verdict.md`)
нашёл 9 блокеров. Главное: строгая побайтовая сверка round-trip уводила в `raw` ~половину
живых тел. **Решение контроллера по Б1 — три меры вместе:** (1) канонизация на входе — `body`
хранит `serialize(parse(md))`, а не то, «как написала модель»; (2) канон без лишнего
экранирования — снимается точечно, по доказанным безопасным правилам; (3) «непонятое»
ловится не сравнением строк, а по токенам `marked`, и `raw` возникает поблочно.
Инвариант «байт-в-байт» остаётся только для сидов — **потому что они уже канонические**.

**Стек:** без изменений (Tiptap 3.30.1, React 19, tRPC 11, drizzle, vitest 4 в web,
`bun:test` на сервере И в shared).

**Дизайн:** `docs/superpowers/specs/2026-08-13-notion-like-editor-design.md` — правится
Задачей 17 этого плана; до неё расхождения дизайна с v2 разрешаются в пользу v2.

## Статус исполнения

| Задача старого плана | Статус |
|---|---|
| Задача 1 (полифилы) | **СДЕЛАНА** — коммит `83ac6a2` в ветке `notion-editor`. Принята. Один хвост: нет страховочной ветки `document.createRange` из спайка — закрывается Шагом 1 Задачи 2 v2 |
| Задачи 2–15 | не начаты; исполнять по нумерации v2 ниже |

## Глобальные ограничения (заменяют раздел старого плана)

- **Версии Tiptap — строго `3.30.1`**; `@tiptap/extension-bubble-menu` отдельно не ставить.
- **`@tiptap/extension-drag-handle*` НЕ ставить.**
- **`@orbis/shared/doc` — только из `apps/web/src/features/entity-editor/*`, и все импорты
  из него в эагерно достижимых файлах — только `import type`.** Граф чанков строится по
  модулям: статический импорт `MarkdownToggle` из DetailScreen затащил бы ~156 kB в первый
  кадр, в каком бы файле ни был написан import (Б7). `MarkdownToggle` подключается ТОЛЬКО
  через `lazy()`.
- **Тул-контракт не растёт ради UI** (`*UiInput`-схемы; тест парности `registry.test.ts`
  остаётся зелёным без правок).
- **Тесты `packages/shared` — на `bun:test`**, как весь пакет (`"test": "bun test"`); vitest
  туда не заводить (Б6.1). Тест сидов живёт в `apps/server` — shared не импортирует server (И17).
- **Обвязка серверных тестов — по образцу `executor.test.ts:15,54-60`:**
  `const { db, client } = appDb()` на модульном уровне, `afterAll(() => client.end())`;
  `adminDb()` — один раз, с закрытием. `appDb()`/`adminDb()` возвращают `{ db, client }`,
  НЕ голый `Db` (Б6.2).
- **Моки web-тестов — функцией:** `renderWithProviders(ui, (path, input) => …)`; карта
  `{'entity.proc': fn}` не существует (Б6.3).
- **`StarterKit` конфигурируется ОДИН раз в `DOC_EXTENSIONS`** (`link.isAllowedUri`,
  `trailingNode: false`) — задачи редактора его не пересоздают и не затирают (Б5, И19).
- **`body` в БД — всегда КАНОН** (`serialize(parse(x))`), в обеих ветках executor и в
  бэкфилле. Инвариант «body === serializeBody(body_doc) после любой записи» держится по
  построению, а не проверкой.
- **Гейт §5.2 (`expectedUpdatedAt`/STALE_VERSION) обязан покрывать `bodyDoc`** (Б3).
- **Открытие сущности не пишет в БД**: `trailingNode` выключен, транзакции UniqueID не
  считаются правкой (Б4). На это есть приёмочный тест.
- **Зелёный сьют — по коду возврата.** Голый `bun test` из корня ЗАВИСАЕТ — только
  `bun run test`; линт — `bun run lint` (не `bunx biome check`).
- **Язык кода и комментариев — русский**; комментарий объясняет «почему».
- **Мутации только через `executor`; миграции forward-only; накат — `bun scripts/ops.ts migrate`.**
- **Ветка:** `notion-editor` (worktree `.claude/worktrees/notion-editor`) — продолжать в ней.

---

## Задача 2 (v2): схема документа, канонизация, токен-детекция, поблочный `raw`

Заменяет Задачу 2 старого плана ЦЕЛИКОМ. Прежний механизм — «строгая сверка round-trip,
не сошлось → всё тело в один raw» — НЕ реализовывать: он уводил в raw 47% реальных тел
(ревью Б1, подтверждено пробами и контроллером).

**Файлы:**
- Изменить: `apps/web/tests/prosemirror-polyfill.ts` (хвост Задачи 1)
- Создать: `packages/shared/src/doc/{types,schema,manager,convert,index}.ts`
- Создать: `packages/shared/src/doc/nodes/{entity-ref,query-block,raw}.ts`
- Создать: `packages/shared/src/doc/convert.test.ts` (**bun:test**, синтетика без сидов)
- Создать: `apps/server/src/seed/seed-canon.test.ts` (**bun:test**, сиды)
- Изменить: `packages/shared/package.json` (зависимости, `exports` — `"main"` ОСТАВИТЬ рядом)

**Интерфейсы (производит, из `@orbis/shared/doc`):**
- `DOC_SCHEMA_VERSION: 1`; `type BodyDoc = { v: number; doc: JSONContent }`
- `parseBody(markdown: string): BodyDoc` — токен-детекция, поблочный raw, БЕЗ сверки строк
- `serializeBody(doc: BodyDoc | JSONContent): string` — канон
- `canonicalizeBody(markdown: string): { doc: BodyDoc; body: string }` — то, что пишет сервер
- `bodyRefsFromDoc(doc): string[]` — дерево ∪ регэксп по raw-блокам (Б2)
- `readBodyDoc(stored: unknown, fallbackMarkdown: string): BodyDoc`
- `DOC_EXTENSIONS`, `EntityRef`, `QueryBlock`, `RawBlock`, `QUERY_BLOCK_CLOSE`, `BODY_REF_RE`

- [ ] **Шаг 1: Дозакрыть хвост Задачи 1 — страховка `createRange`**

В конец `installProseMirrorJsdomPolyfills()` в `apps/web/tests/prosemirror-polyfill.ts`
(перенос четвёртой ветки из `apps/web/src/spike/prosemirror-jsdom-polyfill.ts` ветки
`spike-editor`; если спайковый файл недоступен — код ниже самодостаточен):

```ts
  // Отдельные пути ProseMirror создают Range через document.createRange() и тут же меряют его;
  // защищаемся и на этом экземпляре, а не только на прототипе (страховка из спайка).
  const nativeCreateRange = document.createRange.bind(document);
  document.createRange = () => {
    const range = nativeCreateRange();
    if (!range.getClientRects) range.getClientRects = rectList;
    if (!range.getBoundingClientRect) range.getBoundingClientRect = () => ZERO_RECT;
    return range;
  };
```

Прогнать: `cd apps/web && bunx vitest run src/features/entity-editor/ >/dev/null 2>&1; echo $?`
— ожидается `0`. Коммит: `git commit -am "test(web): страховка createRange из спайка — хвост Задачи 1"`.

- [ ] **Шаг 2: Пакеты и подпуть**

```bash
cd packages/shared
bun add @tiptap/core@3.30.1 @tiptap/starter-kit@3.30.1 @tiptap/markdown@3.30.1 \
  @tiptap/extension-list@3.30.1 @tiptap/extension-table@3.30.1
```

В `packages/shared/package.json` — `exports` рядом с СОХРАНЯЕМЫМ `"main"`:

```json
  "main": "src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./doc": "./src/doc/index.ts"
  }
```

Если `bun run typecheck` пакета покраснеет на DOM-типах из `@tiptap/core` — добавить в
`packages/shared/tsconfig.json`: `"lib": ["ES2022", "DOM"]` (ревью M; `skipLibCheck` обычно
поглощает).

- [ ] **Шаг 3: Написать падающие тесты (`bun:test`, БЕЗ импорта сидов)**

Создать `packages/shared/src/doc/convert.test.ts`:

```ts
// bun:test, как ВЕСЬ пакет shared: у него "test": "bun test", и файл на vitest уронил бы
// корневой прогон (ревью Б6.1). Сиды здесь НЕ импортируются — shared не зависит от server
// (И17); round-trip сидов проверяет apps/server/src/seed/seed-canon.test.ts.
import { describe, expect, test } from 'bun:test';
import { bodyRefsFromDoc, canonicalizeBody, parseBody, readBodyDoc, serializeBody } from './convert';

const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const raws = (md: string) =>
  (parseBody(md).doc.content ?? []).filter((n) => n.type === 'rawBlock');

describe('канонизация вместо строгой сверки (решение по Б1)', () => {
  test('бытовой текст с _ и & НЕ уезжает в raw и не обрастает экранированием', () => {
    // Ровно тела из проб ревью: при строгой сверке все три уходили в raw целиком.
    for (const md of [
      'поле due_date и updated_at в тексте',
      'условие a&b и c & d',
      'скрипт backfill_body_doc.ts готов',
    ]) {
      expect(raws(md)).toEqual([]);
      expect(canonicalizeBody(md).body).toBe(md); // канон этих строк — они сами
    }
  });

  test('ненормализованная разметка канонизируется, а не отвергается', () => {
    // Модель пишет как умеет; body — производная от документа, эталон — канон (вердикт Б1).
    const cases: Array<[string, string]> = [
      ['* раз\n* два', '- раз\n- два'],
      ['1) первый', '1. первый'],
      ['это __жирный__ текст', 'это **жирный** текст'],
    ];
    for (const [input, canon] of cases) {
      expect(raws(input)).toEqual([]);
      expect(canonicalizeBody(input).body).toBe(canon);
    }
  });

  test('канонизация идемпотентна', () => {
    for (const md of ['поле due_date', '* раз', '1) первый', '2 * 3 = 6', 'а < б > в']) {
      const once = canonicalizeBody(md).body;
      expect(canonicalizeBody(once).body).toBe(once);
    }
  });

  test('канон не меняет смысла при повторном парсе: _текст_ набранный буквально', () => {
    // Снятие экранирования ТОЧЕЧНОЕ: intraword `_` безопасен (CommonMark), а `_слово_`
    // целиком — нет: без экранирования повторный парс сделал бы из текста курсив.
    const md = canonicalizeBody('это _курсив_ такой').body;
    const again = parseBody(md);
    expect(JSON.stringify(again.doc)).toBe(JSON.stringify(parseBody(md).doc));
  });
});

describe('поблочный raw по токенам (решение по Б1, мера 3)', () => {
  test('HTML-блок уезжает в raw ОДИН, соседний смарт-лист остаётся виджетом', () => {
    const md = '<div>x</div>\n\n{{query: aspect=orbis/task, status=inbox}}';
    const doc = parseBody(md);
    const types = (doc.doc.content ?? []).map((n) => n.type);
    expect(types).toContain('rawBlock');
    expect(types).toContain('queryBlock');
    expect(serializeBody(doc)).toBe(md); // raw отдаёт дословно, канон остального совпал
  });

  test('картинка (нет в схеме) уводит СВОЙ блок в raw, а не всё тело', () => {
    const md = 'абзац\n\n![схема](https://example.com/a.png)\n\nещё абзац';
    const doc = parseBody(md);
    expect(raws(md).length).toBe(1);
    expect(serializeBody(doc)).toContain('![схема]');
    expect(serializeBody(doc)).toContain('ещё абзац');
  });

  test('reference-определения — консервативно всё тело в raw', () => {
    // marked вырезает link reference definitions из потока токенов и кладёт в lexer.links —
    // их позицию не восстановить, поэтому единственный честный вариант — весь текст дословно.
    // Сноска GFM из спайка (`текст[^1](сноска)` — определение исчезало) ловится именно здесь.
    const md = 'текст[^1]\n\n[^1]: сноска';
    const doc = parseBody(md);
    expect(doc.doc.content?.length).toBe(1);
    expect(doc.doc.content?.[0]?.type).toBe('rawBlock');
    expect(serializeBody(doc)).toBe(md);
  });

  test('обычный текст в raw НЕ уезжает — включая проблемные символы', () => {
    expect(raws('# Заголовок\n\n- раз\n- два')).toEqual([]);
    expect(raws('поле due_date, условие a&b, 2 * 3')).toEqual([]);
  });
});

describe('свои конструкции', () => {
  test('ссылка с подписью и без; регистр id приводится к lower (И7)', () => {
    const doc = parseBody(`См. [[entity:${UUID.toUpperCase()}|Кроссовки]].`);
    const json = JSON.stringify(doc.doc);
    expect(json).toContain('entityRef');
    expect(json).toContain(UUID); // lowercase в атрибуте
    expect(serializeBody(doc)).toBe(`См. [[entity:${UUID}|Кроссовки]].`);
  });

  test('многострочный query дословен; }} внутри запроса блоком не считается', () => {
    const multi = '{{query: aspect=orbis/task,\n         status=inbox}}';
    expect(serializeBody(parseBody(multi))).toBe(multi);
    expect(raws(multi)).toEqual([]);
    // Хвост после `}}` — обычный текст, блок закрылся на первом `}}`; в raw ничто не уезжает.
    const tail = parseBody('{{query: tags=a}}b}}');
    expect((tail.doc.content ?? []).map((n) => n.type)).toEqual(['queryBlock', 'paragraph']);
  });

  test('незакрытая обёртка остаётся текстом и не режет абзац', () => {
    const md = 'текст {{query: aspect=orbis/task и всё';
    expect(canonicalizeBody(md).body).toBe(md);
    expect(raws(md)).toEqual([]);
  });

  test('чеклист, код, вложенный список, цитата — канон равен входу', () => {
    for (const md of [
      '- [ ] не сделано\n- [x] сделано',
      '```ts\nconst x = 1;\n```',
      '- раз\n  - вложенный\n- два',
      '> цитата',
    ]) {
      expect(canonicalizeBody(md).body).toBe(md);
    }
  });
});

describe('bodyRefsFromDoc: дерево ∪ raw (Б2)', () => {
  test('lowercase и без дублей', () => {
    expect(bodyRefsFromDoc(parseBody(`[[entity:${UUID.toUpperCase()}]] и [[entity:${UUID}]]`)))
      .toEqual([UUID]);
  });

  test('ссылка в блоке кода и inline-коде — НЕ связь (Р7 сохраняется)', () => {
    expect(bodyRefsFromDoc(parseBody('```\n[[entity:' + UUID + ']]\n```'))).toEqual([]);
    expect(bodyRefsFromDoc(parseBody('`[[entity:' + UUID + ']]`'))).toEqual([]);
  });

  test('ссылка внутри raw-блока связью ОСТАЁТСЯ — backlinks не зависят от разбираемости', () => {
    // Регресс из ревью Б2: сегодня регэксп находит такие ссылки, терять их нельзя.
    const md = `<div>html</div>\n\nсм. [[entity:${UUID}]]`; // ссылка в обычном абзаце
    expect(bodyRefsFromDoc(parseBody(md))).toEqual([UUID]);
    const allRaw = `текст[^1] и [[entity:${UUID}]]\n\n[^1]: сноска`; // всё тело в raw
    expect(bodyRefsFromDoc(parseBody(allRaw))).toEqual([UUID]);
  });
});

describe('readBodyDoc (приёмка 11 — теперь с тестом, ревью M)', () => {
  test('знакомая версия — как есть; будущая/битая/NULL — пересборка из body', () => {
    const good = parseBody('текст');
    expect(readBodyDoc(good, 'другое')).toEqual(good);
    for (const bad of [null, 42, { v: 999, doc: { type: 'doc' } }, { doc: {} }]) {
      const rebuilt = readBodyDoc(bad, '# Заголовок');
      expect(JSON.stringify(rebuilt.doc)).toContain('heading');
    }
  });
});
```

- [ ] **Шаг 4: Убедиться, что падают**

```bash
cd packages/shared && bun test src/doc/ 2>&1 | tail -5
```

Ожидается: FAIL — `Cannot find module './convert'`.

- [ ] **Шаг 5: Типы и ноды**

`types.ts` — как в старом плане (Задача 2 Шаг 4), без изменений.

`nodes/query-block.ts` — как в старом плане (Шаг 5), без изменений: дословный атрибут,
`start` по полной обёртке, `renderMarkdown` без хвостовых переносов.

`nodes/entity-ref.ts` — как в старом плане, с ДВУМЯ правками:

```ts
// 1) Экспортируем регэксп: им же пользуется bodyRefsFromDoc для raw-блоков (Б2).
//    Форма повторяет клиентский ENTITY_REF_RE (Markdown.tsx:16) — с захватом подписи;
//    серверный BODY_REFS_RE держит подпись в незахватывающей группе (уточнение атрибуции — ревью M).
export const BODY_REF_RE = /\[\[entity:([0-9a-f-]{36})(?:\|([^\]]*))?\]\]/gi;

// 2) parseMarkdown приводит id к lowercase (И7): дерево, resolveRefs и БД говорят на одном
//    регистре, иначе чип с [[entity:0F8FAD…]] навсегда промахивался бы мимо Map заголовков.
  parseMarkdown: (token: { entityId?: string; label?: string | null }) => ({
    type: 'entityRef',
    attrs: { entityId: token.entityId?.toLowerCase(), label: token.label ?? null },
  }),
```

`nodes/raw.ts` — как в старом плане, с одной правкой (`parseHTML` не обещает то, чего не
делает — ревью M):

```ts
  // HTML-путь содержимое не восстанавливает — этот блок живёт только в JSON-документе.
  parseHTML: () => [],
```

- [ ] **Шаг 6: Состав схемы — StarterKit настраивается ЗДЕСЬ и только здесь**

`schema.ts`:

```ts
import type { AnyExtension } from '@tiptap/core';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import StarterKit from '@tiptap/starter-kit';
import { EntityRef } from './nodes/entity-ref';
import { QueryBlock } from './nodes/query-block';
import { RawBlock } from './nodes/raw';

/** Белый список протоколов. Сужает ссылки isAllowedUri — опция `protocols` у Tiptap
 *  РАСШИРЯЕТ базовый список, а не сужает (проверено ревью), поэтому её здесь нет. */
const SAFE_URI = (url: string) =>
  /^(https?|mailto):/i.test(url) || url.startsWith('/');

/**
 * ЕДИНСТВЕННОЕ описание документа Orbis — для сервера и клиента разом.
 *
 * StarterKit конфигурируется ЗДЕСЬ ОДИН РАЗ (ревью Б5, И19):
 * - link.isAllowedUri: `javascript:` и родня ссылкой не становятся. Настраивать надо ИМЕННО
 *   StarterKit — Link живёт внутри него, элемента с name === 'link' в этом массиве нет,
 *   и map по имени молча не нашёл бы никого (так умер белый список в плане v1);
 * - trailingNode: false — иначе StarterKit 3.30.1 дописывает пустой абзац в конец любого
 *   документа, не кончающегося абзацем: все пять сидов «менялись» при простом открытии,
 *   и автосейв слал фантомный entity_update (ревью Б4).
 */
export const DOC_EXTENSIONS: AnyExtension[] = [
  StarterKit.configure({
    trailingNode: false,
    link: { isAllowedUri: SAFE_URI },
  }),
  TaskList,
  TaskItem,
  TableKit,
  EntityRef,
  QueryBlock,
  RawBlock,
];
```

- [ ] **Шаг 7: Канонизирующий менеджер**

Создать `manager.ts`:

```ts
import { MarkdownManager } from '@tiptap/markdown';

/**
 * Канон без ЛИШНЕГО экранирования (вердикт по Б1, мера 2). Штатный сериализатор экранирует
 * `\ ` * _ [ ] ~` и кодирует HTML-энтити в приватных методах — из-за этого `due_date`
 * превращался в `due\_date`, и строгая сверка v1 уводила такие тела в raw.
 *
 * Снимаем экранирование ТОЧЕЧНО, по правилам, каждое из которых доказуемо безопасно
 * (пара тестов: канон чист + повторный парс не меняет структуру):
 *  - `_` между словными символами НЕ экранируется: intraword underscore не образует
 *    emphasis по CommonMark/GFM (`due_date` — текст, не курсив);
 *  - одиночный `&` НЕ кодируется, если не начинает валидную сущность (`&amp;`, `&#39;`);
 *  - `<` кодируется ТОЛЬКО перед [a-zA-Z/!?] — потенциальный тег; голое `a < b` остаётся;
 *  - всё прочее (`*`, `` ` ``, `[`, `]`, `~`, `\`, `_` на границе слова) экранируется
 *    штатно: снятие сломало бы повторный парс (текст `_курсив_` стал бы курсивом).
 *
 * ВНИМАНИЕ ИСПОЛНИТЕЛЮ (требование вердикта): имена и сигнатуры переопределяемых методов
 * сверить с `node_modules/@tiptap/markdown/dist` ПЕРЕД реализацией. По пробам ревью текст
 * идёт через `encodeTextForMarkdown` → `escapeMarkdownSyntax`; методы private только в
 * типах. Наивный путь `Text.extend({ renderMarkdown })` НЕ работает (факт спайка).
 */
export class OrbisMarkdownManager extends MarkdownManager {
  // @ts-expect-error — private в .d.ts, обычный метод в рантайме
  protected encodeTextForMarkdown(text: string): string {
    return (
      text
        // временно прячем intraword `_` (буквы/цифры латиницы и кириллицы с обеих сторон)
        .replace(/(?<=[\p{L}\p{N}])_(?=[\p{L}\p{N}])/gu, ' ')
        .replace(/([\\`*_[\]~])/g, '\\$1')
        .replace(/ /g, '_')
        // & кодируем только когда он начинает сущность; < — только перед началом тега
        .replace(/&(?=[a-zA-Z]+;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;')
        .replace(/<(?=[a-zA-Z/!?])/g, '&lt;')
    );
  }
}
```

- [ ] **Шаг 8: Конверсия — токен-детекция и поблочный raw**

`convert.ts`:

```ts
import type { JSONContent } from '@tiptap/core';
import { marked } from 'marked';
import { DOC_EXTENSIONS } from './schema';
import { OrbisMarkdownManager } from './manager';
import { BODY_REF_RE } from './nodes/entity-ref';
import { type BodyDoc, DOC_SCHEMA_VERSION } from './types';

let manager: OrbisMarkdownManager | null = null;
function md(): OrbisMarkdownManager {
  manager ??= new OrbisMarkdownManager({ extensions: DOC_EXTENSIONS });
  return manager;
}

function docOf(input: BodyDoc | JSONContent): JSONContent {
  return 'doc' in input && 'v' in input ? (input as BodyDoc).doc : (input as JSONContent);
}

export function serializeBody(input: BodyDoc | JSONContent): string {
  return md().serialize(docOf(input));
}

/**
 * «Непонятое» определяется НЕ сравнением строк, а по токенам marked (вердикт Б1, мера 3):
 * блочный или инлайн-токен, для которого в схеме нет обработчика, уводит В RAW ТОЛЬКО СВОЙ
 * БЛОК. Сравнение строк на этой роли проверяло каноничность, выдавая себя за проверку
 * целостности, — и валило в raw 47% живых тел (ревью Б1).
 */
const KNOWN_BLOCK = new Set([
  'paragraph', 'heading', 'list', 'blockquote', 'code', 'table', 'hr', 'space', 'text',
]);
const KNOWN_INLINE = new Set([
  'text', 'em', 'strong', 'del', 'codespan', 'link', 'br', 'escape',
]);

type Tok = { type: string; raw: string; tokens?: Tok[]; items?: Tok[] };

function blockIsKnown(token: Tok): boolean {
  if (!KNOWN_BLOCK.has(token.type)) return false;
  const walk = (toks: Tok[] | undefined): boolean =>
    (toks ?? []).every((t) => {
      if (t.items) return walk(t.items); // list → items → вложенные блоки
      if (t.tokens) return (KNOWN_BLOCK.has(t.type) || KNOWN_INLINE.has(t.type)) && walk(t.tokens);
      return KNOWN_INLINE.has(t.type) || KNOWN_BLOCK.has(t.type);
    });
  return walk(token.tokens ?? token.items);
}

function rawNode(markdown: string): JSONContent {
  return { type: 'rawBlock', attrs: { markdown } };
}

/** Полная обёртка смарт-листа. Сегменты вырезаются ДО прогона marked: лексер не знает нашу
 *  грамматику и порезал бы многострочный блок по своим правилам. Тот же принцип «start только
 *  по полному совпадению», что спас спайк от разрезанных абзацев. */
const QUERY_SEGMENT_RE = /\{\{query:[\s\S]*?\}\}/g;

export function parseBody(markdown: string): BodyDoc {
  if (markdown.trim() === '') {
    return { v: DOC_SCHEMA_VERSION, doc: { type: 'doc', content: [] } };
  }
  try {
    const content: JSONContent[] = [];
    // 1. Разрезаем на чередование [markdown-кусок | {{query:…}}-сегмент].
    const segments: Array<{ kind: 'md' | 'query'; text: string }> = [];
    let last = 0;
    for (const m of markdown.matchAll(QUERY_SEGMENT_RE)) {
      if (m.index > last) segments.push({ kind: 'md', text: markdown.slice(last, m.index) });
      segments.push({ kind: 'query', text: m[0] });
      last = m.index + m[0].length;
    }
    if (last < markdown.length) segments.push({ kind: 'md', text: markdown.slice(last) });

    for (const seg of segments) {
      if (seg.kind === 'query') {
        // Дословный атрибут (Р4): содержимое между обёрткой, байт-в-байт.
        content.push({
          type: 'queryBlock',
          attrs: { query: seg.text.slice('{{query:'.length, -'}}'.length) },
        });
        continue;
      }
      const trimmed = seg.text.replace(/^\n+|\n+$/g, '');
      if (trimmed === '') continue;
      // 2. Внутри markdown-куска — поблочно по токенам собственного лексера.
      const lexer = new marked.Lexer({ gfm: true });
      const tokens = lexer.lex(trimmed) as unknown as Tok[];
      if (Object.keys(lexer.tokens.links ?? {}).length > 0) {
        // Reference-определения marked вырезает из потока и их позицию не восстановить —
        // консервативно ВЕСЬ исходник дословно (ловит и сноски GFM из спайка).
        return { v: DOC_SCHEMA_VERSION, doc: { type: 'doc', content: [rawNode(markdown)] } };
      }
      for (const token of tokens) {
        if (token.type === 'space') continue;
        if (blockIsKnown(token)) {
          const parsed = md().parse(token.raw.replace(/\n+$/, ''));
          content.push(...(parsed.content ?? []));
        } else {
          content.push(rawNode(token.raw.replace(/\n+$/, '')));
        }
      }
    }
    return { v: DOC_SCHEMA_VERSION, doc: { type: 'doc', content } };
  } catch {
    // Парсер не справился вовсе — сохраняем дословно, не теряя ни байта.
    return { v: DOC_SCHEMA_VERSION, doc: { type: 'doc', content: [rawNode(markdown)] } };
  }
}

/** Единственная форма, которой сервер пишет тело: body = КАНОН, не «как написала модель». */
export function canonicalizeBody(markdown: string): { doc: BodyDoc; body: string } {
  const doc = parseBody(markdown);
  return { doc, body: serializeBody(doc) };
}

/** Дерево ∪ регэксп по raw-блокам: backlinks не зависят от разбираемости тела (Б2).
 *  Код-блоки и inline-код — по-прежнему НЕ связь (Р7): они не raw, а честные ноды схемы. */
export function bodyRefsFromDoc(input: BodyDoc | JSONContent): string[] {
  const refs = new Set<string>();
  const walk = (node: JSONContent | undefined): void => {
    if (!node) return;
    if (node.type === 'entityRef' && typeof node.attrs?.entityId === 'string') {
      refs.add(node.attrs.entityId.toLowerCase());
    }
    if (node.type === 'rawBlock' && typeof node.attrs?.markdown === 'string') {
      for (const m of node.attrs.markdown.matchAll(BODY_REF_RE)) refs.add(m[1].toLowerCase());
    }
    for (const child of node.content ?? []) walk(child);
  };
  walk(docOf(input));
  return [...refs];
}

export function readBodyDoc(stored: unknown, fallbackMarkdown: string): BodyDoc {
  if (
    typeof stored === 'object' && stored !== null &&
    'v' in stored && 'doc' in stored &&
    (stored as BodyDoc).v === DOC_SCHEMA_VERSION
  ) {
    return stored as BodyDoc;
  }
  return parseBody(fallbackMarkdown);
}
```

`index.ts` — как в старом плане Шаг 8, плюс `export { canonicalizeBody }` и
`export { BODY_REF_RE } from './nodes/entity-ref'`, `export { OrbisMarkdownManager } from './manager'`.

- [ ] **Шаг 9: Прогнать тесты shared; проба Bun без DOM**

```bash
cd packages/shared && bun test src/doc/ 2>&1 | tail -8
cd /Users/birzhan/projects/orbis && bun -e "
import { canonicalizeBody } from './packages/shared/src/doc/index';
console.log('window:', typeof globalThis.window);
console.log(JSON.stringify(canonicalizeBody('поле due_date\n\n* раз').body));
"
```

Ожидается: тесты зелёные; `window: undefined`; канон `"поле due_date\n\n- раз"` — без `\_`.
Если канон содержит `due\_date` — переопределение метода не попало (сверить имя с dist,
см. комментарий в `manager.ts`); чинить менеджер, НЕ ослаблять тест.

- [ ] **Шаг 10: Тест сидов — в apps/server**

Создать `apps/server/src/seed/seed-canon.test.ts`:

```ts
// Сиды живут здесь, а не в shared: тест сидов — единственная точка, где нужны оба мира,
// и импортировать server из shared было бы инверсией слоёв (ревью И17).
import { describe, expect, test } from 'bun:test';
import { canonicalizeBody, parseBody } from '@orbis/shared/doc';
import {
  ALL_TASKS_BODY, DAILY_PLANNING_BODY, HORIZON_LIFE_BODY, HORIZON_YEAR_BODY, UPCOMING_BODY,
} from './smart-lists';

const SEEDS: Array<[string, string]> = [
  ['Daily Planning', DAILY_PLANNING_BODY],
  ['Upcoming', UPCOMING_BODY],
  ['All Tasks', ALL_TASKS_BODY],
  ['Горизонт «Год»', HORIZON_YEAR_BODY],
  ['Горизонт «Жизнь»', HORIZON_LIFE_BODY],
];

describe('сиды — канонические', () => {
  for (const [name, body] of SEEDS) {
    test(`${name}: канон равен телу байт-в-байт, raw нет`, () => {
      // «Байт-в-байт» остаётся приёмкой ДЛЯ СИДОВ — потому что они уже канон (вердикт Б1),
      // а не потому что конвертер обязан сохранять любую форму. Инвариант §3.3 PRD цел.
      expect(canonicalizeBody(body).body).toBe(body);
      expect(JSON.stringify(parseBody(body).doc)).not.toContain('rawBlock');
    });
  }
});
```

Запуск: `cd apps/server && bun test src/seed/seed-canon.test.ts` (БД не нужна — чистые
константы). Если хоть один сид разошёлся с каноном — чинить сериализатор/ноды, а не тест:
сиды защищены `onboarding.test.ts` и PRD §3.3.

- [ ] **Шаг 11: Коммит**

```bash
git add packages/shared apps/server/src/seed/seed-canon.test.ts apps/web/tests
git commit -m "feat(shared): канонизация, токен-детекция и поблочный raw вместо строгой сверки (Б1)"
```

---

## Задача 3 (v2, НОВАЯ): аудит корпуса прода — до миграции и бэкфилла

Требование ревью (И10) и вердикта: замер — до бэкфилла, его числа калибруют решение по Б1.
Read-only: команда печатает ТОЛЬКО агрегаты, ни одного тела наружу.

**Файлы:** изменить `scripts/ops.ts`.

**Интерфейсы:** потребляет `canonicalizeBody`, `parseBody` из `@orbis/shared/doc`;
производит ops-команду `audit-bodies`.

- [ ] **Шаг 1: Команда**

По образцу соседних ops-команд (`withDb` — строка 60, сырой `postgres.Sql`):

```ts
/**
 * Read-only аудит тел перед конверсией (ревью И10, вердикт): сколько тел изменит
 * канонизация, сколько получат raw-блоки, сколько ссылок сидит в raw. Тела НЕ печатаются.
 */
async function auditBodiesOp(): Promise<number> {
  await withDb(async (sql) => {
    const rows = await sql`SELECT id, body FROM entities`;
    let changed = 0, withRaw = 0, refsInRaw = 0, failed = 0;
    for (const row of rows) {
      try {
        const body = String(row.body ?? '');
        const { doc, body: canon } = canonicalizeBody(body);
        if (canon !== body) changed += 1;
        const hasRaw = JSON.stringify(doc.doc).includes('"rawBlock"');
        if (hasRaw) {
          withRaw += 1;
          const treeOnly = bodyRefsFromDoc({ ...doc, doc: stripRaw(doc.doc) }).length;
          if (bodyRefsFromDoc(doc).length > treeOnly) refsInRaw += 1;
        }
      } catch { failed += 1; }
    }
    console.log(`тел всего: ${rows.length}`);
    console.log(`канон изменит body: ${changed}`);
    console.log(`получат raw-блоки: ${withRaw}`);
    console.log(`ссылки внутри raw: ${refsInRaw}`);
    console.log(`упали на парсе: ${failed}`);
  });
  return 0;
}

function stripRaw(doc: JSONContent): JSONContent {
  return { ...doc, content: (doc.content ?? []).filter((n) => n.type !== 'rawBlock') };
}
```

В `OPS` (строка 281): `'audit-bodies': { run: auditBodiesOp, help: 'read-only аудит тел перед конверсией: агрегаты, ничего не пишет' }`.
Импорты `canonicalizeBody`/`bodyRefsFromDoc` — из `@orbis/shared/doc` (резолвится: workspaces + exports).

- [ ] **Шаг 2: Прогнать на локальном стенде, зафиксировать числа**

```bash
bun scripts/ops.ts audit-bodies
```

Числа с ПРОДА снимает владелец тем же вызовом (ops-обёртка, секрет в Ключнице).

**ГЕЙТ:** если на проде `получат raw-блоки` окажется больше ~5% тел или `ссылки внутри raw`
ненулевые в заметном количестве — СТОП, результаты владельцу до Задачи 4: возможно, белые
списки токенов надо расширять (это правка `KNOWN_*` в Задаче 2, не архитектуры).

- [ ] **Шаг 3: Коммит**

```bash
git add scripts/ops.ts
git commit -m "feat(ops): audit-bodies — read-only замер корпуса перед конверсией"
```

---

## Задача 4 (v2): миграция `body_doc`, индекс, бэкфилл — теперь канонизирующий

По старому плану (Задача 3) с ЧЕТЫРЬМЯ правками. Шаги 1–3 старого плана (колонка в схеме,
`db:generate`, индекс `entities_title_prefix` в ту же миграцию) — без изменений.

**Правка 1 — бэкфилл пишет ОБЕ колонки.** `body` тоже становится каноном, иначе инвариант
«body = сериализация body_doc» ломается на самом первом шаге. В `backfill-body-doc.ts`:

```ts
    for (const row of rows) {
      const { doc, body } = canonicalizeBody(String(row.body ?? ''));
      // body тоже выравнивается до канона: FTS не страдает (проверено спайком на живой БД),
      // сиды не меняются (они канон — seed-canon.test.ts), а инвариант пары держится
      // с первого дня, а не «после первого пересохранения».
      await db.execute(
        sql`UPDATE entities SET body_doc = ${JSON.stringify(doc)}::jsonb, body = ${body}
            WHERE id = ${row.id}`,
      );
      done += 1;
    }
```

То же в копии внутри `scripts/ops.ts` (`backfill-body-doc`), и в help дописать:
«выравнивает body до канона». Запускать на проде — ТОЛЬКО после `audit-bodies` (Задача 3).

**Правка 2 — обвязка теста по образцу `executor.test.ts` (Б6.2).** Тест
`apps/server/src/db/backfill-body-doc.test.ts` начинается так (НЕ как в старом плане):

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
import { canonicalizeBody, serializeBody } from '@orbis/shared/doc';
import { sql } from 'drizzle-orm';
import { adminDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { backfillBodyDoc } from './backfill-body-doc';

requireEnv(); // на модульном уровне, как в aspect-drift.test.ts

// adminDb() возвращает { db, client } и открывает пул НА КАЖДЫЙ вызов — берём один раз
// и закрываем сами, иначе прогон повисает на незакрытых соединениях (ревью Б6.2).
const { db: admin, client: adminClient } = adminDb();
afterAll(async () => {
  await truncateAll();
  await adminClient.end();
});
```

Дальше ассерты старого плана, с заменами `adminDb()` → `admin` и добавкой проверки канона:

```ts
  test('бэкфилл выравнивает body до канона', async () => {
    await truncateAll();
    const id = newId();
    await admin.execute(
      sql`INSERT INTO entities (id, owner_id, title, body) VALUES (${id}, ${freshUserId()}, 'некан', ${'* раз\n* два'})`,
    );
    await backfillBodyDoc(admin);
    const rows = await admin.execute(sql`SELECT body, body_doc FROM entities WHERE id = ${id}`);
    expect(rows[0].body).toBe('- раз\n- два');
    expect(serializeBody(rows[0].body_doc as never)).toBe(rows[0].body as string);
  });
```

**Правка 3 —** если сигнатура `backfillBodyDoc(db: Db)` не совпадёт с типом `admin`
(это drizzle `Db` из `makeDb` — совпадает), сверить с `db/client.ts:9-19` перед реализацией.

**Правка 4 —** имя файла миграции будет `0007_<случайное>.sql` от `db:generate` — это норма,
переименовывать не надо (ревью M).

Остальные шаги (падающий тест → реализация → `bun run test` → коммит) — по старому плану.

---

## Задача 5 (v2): executor — канон, гейт §5.2, UI-схемы, типы

Заменяет Задачу 4 старого плана. Шаги 3 (UI-схемы в `contracts/tools.ts`) и 4 (роутер) —
без изменений, исполнять по старому плану. Остальное — ниже.

**Файлы (полный список — шире старого, ревью Б9):**
- Изменить: `packages/shared/src/contracts/tools.ts`, `packages/shared/src/schemas/entity.ts`
- Изменить: `apps/server/src/executor/executor.ts` (строки ~806, ~965, ~1076, ~1087)
- Изменить: `apps/server/src/executor/types.ts` (**WireEntity — рукописный интерфейс, строка 36**)
- Изменить: `apps/server/src/wire.ts:26`, `apps/server/src/entity-read.ts:38-54`,
  `apps/server/src/export.ts:80`, `apps/server/src/routers/entity.ts:125,151`
- Тест: `apps/server/src/executor/body-doc.test.ts`

- [ ] **Шаг 1: Падающие тесты — обвязка по образцу `executor.test.ts`**

`body-doc.test.ts`, шапка:

```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { entityUpdateUiInput } from '@orbis/shared';
import { canonicalizeBody, parseBody, serializeBody } from '@orbis/shared/doc';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { execute } from './executor';
import type { ExecuteOk, ExecuteRequest } from './types';
import type { WireEntity } from './types';

requireEnv();
const { db, client } = appDb();
const { db: admin, client: adminClient } = adminDb();
afterAll(async () => {
  await truncateAll();
  await client.end();
  await adminClient.end();
});

function req(tool: string, input: unknown, actorUserId: string): ExecuteRequest {
  // Форму сверить с executor.test.ts перед реализацией — там локальный образец req().
  return { actorUserId, actorKind: 'owner', source: 'ui', operations: [{ tool, input }] } as ExecuteRequest;
}
```

Тесты — из старого плана (контракт UI, «обе формы в БД», «сервер сам собирает документ»)
с заменой `appDb()`→`db`, `adminDb()`→`admin`, ПЛЮС четыре новых:

```ts
describe('канон и гейт §5.2', () => {
  test('строковый body от модели ложится КАНОНОМ, а не как написан', async () => {
    await truncateAll();
    const owner = freshUserId();
    const created = (await execute(db, req('entity_create',
      { title: 'некан', tags: [], body: '* раз\n* два' }, owner))) as ExecuteOk;
    const row = await rowOf((created.results[0] as WireEntity).id);
    expect(row.body).toBe('- раз\n- два'); // body — производная от документа (вердикт Б1)
  });

  test('bodyDoc без expectedUpdatedAt — отказ VALIDATION', async () => {
    // Гейт §5.2 обязан покрывать оба поля тела: сохранения редактора едут ТОЛЬКО bodyDoc,
    // и без этой правки 409 не наступал никогда (ревью Б3).
    const { entity, owner } = await createOne();
    const r = await execute(db, req('entity_update',
      { id: entity.id, bodyDoc: parseBody('текст') }, owner));
    expect((r as { error?: { code?: string } }).error?.code).toBe('VALIDATION');
  });

  test('устаревший expectedUpdatedAt при bodyDoc — STALE_VERSION', async () => {
    const { entity, owner } = await createOne();
    const r = await execute(db, req('entity_update',
      { id: entity.id, bodyDoc: parseBody('текст'),
        expectedUpdatedAt: '2020-01-01T00:00:00.000Z' }, owner));
    expect((r as { error?: { code?: string } }).error?.code).toBe('STALE_VERSION');
  });

  test('тело в raw не теряет body_refs (Б2)', async () => {
    await truncateAll();
    const owner = freshUserId();
    const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const body = `текст[^1] и [[entity:${UUID}]]\n\n[^1]: сноска`; // уходит в raw целиком
    const created = (await execute(db, req('entity_create',
      { title: 'raw-ссылки', tags: [], body }, owner))) as ExecuteOk;
    const row = await rowOf((created.results[0] as WireEntity).id);
    expect(row.body_refs).toEqual([UUID]);
  });
});
```

(`rowOf`/`createOne` — локальные хелперы на `admin`, по образцу старого плана.)

- [ ] **Шаг 2: Убедиться, что падают** — `bun run test 2>&1 | grep -A6 body-doc`.

- [ ] **Шаг 3: Гейт §5.2** — в `executor.ts` (~строка 1076, точную найти по
  `expectedUpdatedAt`):

```ts
  // Оба поля тела под одним гейтом: сохранения редактора едут bodyDoc, и без этого
  // условия конкурентная правка затиралась бы молча (ревью Б3 — 409 не наступал никогда).
  if ((input.body !== undefined || input.bodyDoc !== undefined) && ctx.internalUndo === undefined) {
```

- [ ] **Шаг 4: Ветки конверсии — канон в обе стороны.** Update (~1087):

```ts
  if (input.bodyDoc !== undefined) {
    const body = serializeBody(input.bodyDoc);
    patch.bodyDoc = input.bodyDoc;
    patch.body = body;
    patch.bodyRefs = bodyRefsFromDoc(input.bodyDoc);
    changed.body = body;
    prior.body = current.body;
  } else if (input.body !== undefined) {
    // КАНОН, а не input.body: body — производная от документа; эталон — canonical,
    // сравнивать «как написала модель» бессмысленно (вердикт Б1). FTS не страдает
    // (проверено спайком), сиды каноничны (seed-canon.test.ts).
    const { doc, body } = canonicalizeBody(input.body);
    patch.body = body;
    patch.bodyDoc = doc;
    patch.bodyRefs = bodyRefsFromDoc(doc); // дерево ∪ raw — backlinks не теряются (Б2)
    changed.body = body;
    prior.body = current.body;
  }
```

Create (~806): `const { doc: bodyDoc, body } = canonicalizeBody(input.body ?? '');`
и в объект вставки — `body`, `bodyDoc`, `bodyRefs: bodyRefsFromDoc(bodyDoc)`.
Схема разбора (~965): `parseEnvelope(entityUpdateUiInput, rawInput, 'entity_update')`.

- [ ] **Шаг 5: Типы и wire (Б9).** В `executor/types.ts:36` в интерфейс `WireEntity`:

```ts
  /** Едет только по include('bodyDoc') — см. Р6 дизайна. */
  bodyDoc?: { v: number; doc: Record<string, unknown> } | null;
```

`wire.ts:26` — второй параметр `toWireEntity(row, includeBodyDoc = false)` как в старом
плане. **`export.ts:80`** — единственный вызов, который ломается вторым параметром
(проверено компилятором в ревью): `entities: entityRows.map((r) => toWireEntity(r)),`.

`entity-read.ts` — сигнатуру расширить: `input: EntityGetInput | EntityGetUiInput`
(тип экспортировать из shared в Шаге 3 старого плана), врезка между `row` (48) и `out` (54)
как в старом плане. `schemas/entity.ts` — поле `bodyDoc` как в старом плане.

- [ ] **Шаг 6: Тесты, typecheck, коммит**

```bash
bun run test 2>&1 | tail -6
cd apps/server && bun run typecheck && cd ../web && bun run typecheck
git add packages/shared apps/server
git commit -m "feat(server): канон в обеих ветках, гейт §5.2 на bodyDoc, refs из дерева и raw"
```

`tools/registry.test.ts` обязан остаться зелёным без правок.

---

## Задача 6 (v2): `entity.suggest` / `entity.resolveRefs`

По старому плану (Задача 5) с правками:

1. **Обвязка теста** `entity-suggest.test.ts`: в `routers/entity.test.ts` НЕТ экспортов и НЕТ
   `seedEntity` — завести локально по образцу `entity.test.ts:16-22`:

```ts
requireEnv();
const { db, client } = appDb();
afterAll(async () => { await truncateAll(); await client.end(); });

const callerFactory = createCallerFactory(appRouter); // импорты — как в entity.test.ts
function callerFor(userId: string) { /* скопировать тело из entity.test.ts:20 */ }

async function seedEntity(caller: Caller, over: { title: string; archived?: boolean }) {
  const created = await caller.entity.create({ input: { title: over.title, tags: [] }, source: 'fast_path' });
  // У entityCreateInput НЕТ поля archived (ревью И3) — архивность вторым шагом:
  if (over.archived) {
    await caller.entity.update({ id: created.entity.id, archived: true,
      expectedUpdatedAt: created.entity.updatedAt });
  }
  return created.entity;
}
```

   (Точные формы `create`/`update`-вызовов сверить с `entity.test.ts` — использовать тамошние.)
2. **Импорт `sql`** из `drizzle-orm` добавить в шапку `routers/entity.ts` (ревью M — его там нет).
3. **`entityResolveRefsInput`: `.max(200)`** вместо 100, и тест «101 id не роняет запрос»
   (ревью И14: тело со 101 ссылкой валило весь резолв и все чипы разом).
4. **Закрытые задачи в `suggest` остаются в выдаче** — решение фиксируется комментарием:

```ts
    // Закрытые задачи НЕ фильтруются намеренно: упомянуть сделанное — валидный сценарий
    // ссылки, а чип сам зачёркивает done/cancelled. Архивные — отфильтрованы: их прячет
    // весь UI. Решение зафиксировано при v2 (ревью И14 требовало явности).
```

Остальное (процедуры, `toSuggestion`, перевод `Blocks.tsx`, место «между `query` (173-180)
и `count` (182)») — по старому плану.

---

## Задача 7 (v2): базовый редактор — сборка расширений, гашение фантомов, двухфазность

Заменяет Задачу 6 старого плана ЦЕЛИКОМ (в ней жили Б4, Б5-след, И4, И6, И11, Б6.3).

**Файлы:** как в старом плане + без изменений список.

- [ ] **Шаг 1: Падающие тесты** — из старого плана, с правками:
- моки — ФУНКЦИЕЙ: `renderWithProviders(<BodyEditor …/>, () => ({}))`; где нужен ответ —
  `(path) => path === 'entity.resolveRefs' ? [] : {}`;
- тест протоколов — через команду, а не набор текста (старый проходил и без конфига — Б5):

```tsx
test('setLink с javascript: отвергается, https: проходит', async () => {
  let editor: Editor | null = null;
  renderWithProviders(<BodyEditor doc={parseBody('текст')} onChange={vi.fn()} onReady={(e) => (editor = e)} />, () => ({}));
  await waitFor(() => expect(editor).not.toBeNull());
  editor!.commands.selectAll();
  expect(editor!.commands.setLink({ href: 'javascript:alert(1)' })).toBe(false);
  expect(editor!.commands.setLink({ href: 'https://example.com' })).toBe(true);
});
```

- НОВЫЙ обязательный тест (приёмка Б4):

```tsx
test('монтирование документа с сервера НЕ зовёт onChange — открытие не пишет в БД', async () => {
  // Два фантома, пойманные ревью: trailingNode дописывал пустой абзац (выключен в схеме),
  // UniqueID проставляет id транзакцией после монтирования (гасится stripIds-сравнением).
  const onChange = vi.fn();
  const md = 'текст\n\n{{query: aspect=orbis/task, status=inbox}}'; // кончается блоком — худший случай
  renderWithProviders(<BodyEditor doc={parseBody(md)} onChange={onChange} />, () => ({}));
  await screen.findByTestId('body-editor');
  await new Promise((r) => setTimeout(r, 50)); // даём UniqueID диспатчнуть свою транзакцию
  expect(onChange).not.toHaveBeenCalled();
});
```

- тест двухфазности: первый кадр — С ЖИВЫМИ ВИДЖЕТАМИ (И4), см. Шаг 4.

- [ ] **Шаг 2: `extensions.ts` — ФИНАЛЬНОЕ состояние сразу** (задачи 8/9/10/11 только
  добавляют элементы в отмеченные места, ничего не пересобирая — И19):

```ts
import { DOC_EXTENSIONS } from '@orbis/shared/doc';
import type { AnyExtension } from '@tiptap/core';
import UniqueID from '@tiptap/extension-unique-id';

// Link и trailingNode настроены в САМОЙ схеме (@orbis/shared/doc, Задача 2 v2) — здесь их
// не трогать: пересборка StarterKit тут затёрла бы конфиг схемы (ровно так умер белый
// список протоколов в v1 — ревью Б5, И19).
const UNIQUE_ID_TYPES = ['paragraph', 'heading', 'queryBlock', 'rawBlock', 'listItem', 'taskItem'];

/** Задача 8 заменяет EntityRef → EntityRefWithView, Задача 9 — QueryBlock → QueryBlockWithView,
 *  ЗДЕСЬ, в этом массиве. Задача 11 добавляет MoveBlock в конец. Больше этот файл не меняется. */
export const EDITOR_EXTENSIONS: AnyExtension[] = [
  ...DOC_EXTENSIONS,
  UniqueID.configure({ types: UNIQUE_ID_TYPES }),
];
```

- [ ] **Шаг 3: `BodyEditor` — гашение не-пользовательских транзакций**

```tsx
import { type BodyDoc, DOC_SCHEMA_VERSION } from '@orbis/shared/doc';
import { type Editor, EditorContent, useEditor } from '@tiptap/react';
import type { JSONContent } from '@tiptap/core';
import { useEffect, useRef } from 'react';
import { EDITOR_EXTENSIONS } from './extensions';

/** Сравнение «по смыслу»: UniqueID кладёт attrs.id (и null-заготовки) во все блоки —
 *  по строковому равенству документ «менялся» всегда (ревью Б4, M1). */
function stripIds(node: JSONContent): JSONContent {
  const { attrs, content, ...rest } = node;
  const cleaned = attrs ? Object.fromEntries(Object.entries(attrs).filter(([k]) => k !== 'id')) : undefined;
  return { ...rest, ...(cleaned && Object.keys(cleaned).length ? { attrs: cleaned } : {}),
    ...(content ? { content: content.map(stripIds) } : {}) };
}
const sameDoc = (a: JSONContent, b: JSONContent) =>
  JSON.stringify(stripIds(a)) === JSON.stringify(stripIds(b));

export function BodyEditor({ doc, onChange, onReady }: {
  doc: BodyDoc;
  onChange: (doc: BodyDoc) => void;
  onReady?: (editor: Editor) => void;
}) {
  // Последнее ПРИНЯТОЕ содержимое: транзакции, не менявшие смысла (простановка id),
  // правкой не считаются — иначе каждое открытие сущности писало бы в БД (Б4).
  const lastAccepted = useRef<JSONContent>(doc.doc);

  const editor = useEditor({
    extensions: EDITOR_EXTENSIONS,
    content: doc.doc,
    onCreate: ({ editor: e }) => onReady?.(e),
    onUpdate: ({ editor: e }) => {
      const next = e.getJSON();
      if (sameDoc(next, lastAccepted.current)) return;
      lastAccepted.current = next;
      onChange({ v: DOC_SCHEMA_VERSION, doc: next });
    },
    editorProps: {
      attributes: {
        class: 'min-h-24 w-full rounded-lg px-2 py-1.5 text-sm leading-relaxed outline-none',
      },
      // Вставка HTML: сохраняем ГРАНИЦЫ блоков, снимая разметку. Голый regex склеивал
      // абзацы в одну строку и тащил содержимое <style> (ревью И11).
      transformPastedHTML: (html) => {
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        for (const bad of parsed.querySelectorAll('style,script,head')) bad.remove();
        for (const block of parsed.querySelectorAll('p,div,li,h1,h2,h3,h4,h5,h6,tr,br'))
          block.insertAdjacentText('beforeend', '\n');
        const text = parsed.body.textContent ?? '';
        return text.split('\n').map((line) =>
          `<p>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`).join('');
      },
    },
  });

  // Приезд чужой версии — только вне фокуса; сравнение тоже по смыслу, не по строке.
  useEffect(() => {
    if (!editor || editor.isFocused) return;
    if (!sameDoc(editor.getJSON(), doc.doc)) {
      lastAccepted.current = doc.doc;
      editor.commands.setContent(doc.doc, { emitUpdate: false });
    }
  }, [editor, doc]);

  return <EditorContent editor={editor} data-testid="body-editor" className="orbis-markdown" />;
}
```

- [ ] **Шаг 4: `EditorShell` — первый кадр как сегодня, монтирование по касанию или idle**

```tsx
import type { BodyDoc } from '@orbis/shared/doc'; // ТОЛЬКО type — файл в эагерном чанке
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { bodySegments } from '../browser/query';
import { Markdown } from '../../lib/markdown/Markdown';
import { QueryBlock } from '../../lib/query-blocks/QueryBlock';
import { openEntity } from '../../state/navigation';

const BodyEditor = lazy(() => import('./BodyEditor').then((m) => ({ default: m.BodyEditor })));

/**
 * Первый кадр — ТО ЖЕ, что рисует сегодняшний просмотр: текст вперемежку с живыми
 * виджетами через bodySegments. Голый <Markdown> показывал бы {{query:…}} строкой и
 * прыгал на виджет (ревью И4 — у сида All Tasks тело и есть один блок).
 * Редактор монтируется по первому касанию тела ИЛИ по idle — не по setTimeout(0):
 * иначе чанк ~160 kB тянулся бы при каждом чисто читательском открытии (ревью И5/И6).
 */
export function EditorShell({ doc, markdown, onChange }: {
  doc: BodyDoc; markdown: string; onChange: (doc: BodyDoc) => void;
}) {
  const [wanted, setWanted] = useState(false);
  const idleRef = useRef<number | null>(null);
  useEffect(() => {
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
    if (w.requestIdleCallback) idleRef.current = w.requestIdleCallback(() => setWanted(true));
    else idleRef.current = window.setTimeout(() => setWanted(true), 1500) as unknown as number;
    return () => {
      if (idleRef.current === null) return;
      (w.cancelIdleCallback ?? clearTimeout)(idleRef.current);
    };
  }, []);

  const preview = (
    <div onPointerDown={() => setWanted(true)} onFocus={() => setWanted(true)}>
      {bodySegments(markdown).map((seg, i) =>
        seg.kind === 'query'
          ? <QueryBlock key={i} query={seg.query} />
          : <Markdown key={i} source={seg.text} onEntityLink={openEntity} />,
      )}
    </div>
  );
  if (!wanted) return preview;
  return <Suspense fallback={preview}><BodyEditor doc={doc} onChange={onChange} /></Suspense>;
}
```

(Форму `bodySegments`-сегментов сверить с сегодняшним использованием в
`DetailScreen.tsx:260` и повторить её; если поля называются иначе — использовать тамошние.)

- [ ] **Шаги 5–6: прогнать, коммит** — как в старом плане.

---

## Задачи 8–9 (v2): чип ссылки и виджет смарт-листа

По старому плану (Задачи 7 и 8) с правками:

- **Все моки — функцией** (Б6.3): `renderWithProviders(ui, (path, input) => { if (path === 'entity.resolveRefs') {…} return {}; })`; тест «один запрос на документ» считает вызовы по `path`.
- Замены нод (`EntityRefWithView`, `QueryBlockWithView`) выполняются В МАССИВЕ
  `EDITOR_EXTENSIONS` из Задачи 7 v2 (фильтр+concat над `DOC_EXTENSIONS` внутри него), НЕ
  пересборкой файла.
- `useRefTitle(id)` в чипе звать с `id` как есть — нода уже хранит lowercase (Задача 2 v2).
- Тест Задачи 9 «запрос с `}}` не сохраняется» остаётся: рубеж живёт в `save()` виджета.
  Тест «`{{query: tags=a}}b}}`» из старого плана НЕ переносить в web — он покрыт Задачей 2 v2
  честной проверкой формы документа (в v1 он проходил эхом raw — ревью M5).
- В тест виджета добавить «клик внутри `QueryBlockEditor` не уходит в редактор» — рядом с
  NodeView известный случай всплытия из портала Radix (`DetailScreen.tsx:388-395`, ревью M).

---

## Задача 10 (v2): slash-меню и `@`

По старому плану (Задача 9) с правками:

1. **Клавиатура — через `Suggestion`, не через window** (ревью И18). `SlashMenu` не вешает
   `window.addEventListener('keydown', …, true)` — вместо этого экспонирует хендлер:

```tsx
export type SlashMenuHandle = { onKeyDown: (e: KeyboardEvent) => boolean };
// SlashMenu держит active-строку в состоянии, а хендлер отдаёт наружу через useImperativeHandle;
// suggestion.render().onKeyDown(props) зовёт handle.onKeyDown(props.event) и возвращает
// его результат — true глушит событие ТОЛЬКО когда меню открыто, а не на всём приложении.
```

   В `suggestion.ts` соответственно: `render: () => ({ onStart, onUpdate, onKeyDown: (p) => handle?.onKeyDown(p.event) ?? false, onExit })`.
2. **Плейсхолдер** (ревью M6): `bun add @tiptap/extension-placeholder@3.30.1` в apps/web,
   в `EDITOR_EXTENSIONS` (Задача 7 v2, место MoveBlock):
   `Placeholder.configure({ placeholder: 'Заметки…' })` — замена удаляемому `BODY_PLACEHOLDER`.
3. Остальное (items, создание сущности из набранного) — по старому плану; моки — функцией.

Мобильная панель «+» над клавиатурой — НЕ в этой задаче: вынесена в Задачу 17 как правка
дизайна (см. там), решение владельца.

---

## Задача 11 (v2): bubble-меню и перемещение блоков

По старому плану (Задача 10) с ЧЕТЫРЬМЯ правками (все — из проб ревью И8–И10):

1. **Тест видимости — под удаление из DOM** (`extension-bubble-menu` делает
   `element.remove()`, а не `visibility` — И8):

```tsx
test('при схлопнутом выделении панели НЕТ в DOM, при непустом — есть', async () => {
  expect(screen.queryByTestId('bubble-toolbar')).toBeNull();
  // …выделить текст программно (editor.commands.setTextSelection({from: 1, to: 4}))…
  await waitFor(() => expect(screen.getByTestId('bubble-toolbar')).toBeTruthy());
});
```

2. **«Удалить блок» — блок верхнего уровня либо выделенный атом** (И10; старый код удалял
   параграф внутри li/цитаты и молчал на NodeSelection):

```tsx
onClick={() => {
  const { state } = editor;
  const sel = state.selection;
  // NodeSelection (клик по смарт-листу/raw): удаляем выделенный узел.
  if (sel instanceof NodeSelection) { editor.chain().focus().deleteSelection().run(); return; }
  // Иначе — блок ВЕРХНЕГО уровня, а не $from.parent (тот внутри li — параграф,
  // и после удаления оставался пустой пункт списка).
  const from = sel.$from.before(1);
  const node = sel.$from.node(1);
  editor.chain().focus().deleteRange({ from, to: from + node.nodeSize }).run();
}}
```

   (`NodeSelection` — импорт из `@tiptap/pm/state`.)
3. **`MoveBlock` — ветка NodeSelection и защита глубины** (И9; старый бросал TypeError на
   выделенном атомном блоке):

```ts
    const move = (dir: -1 | 1) => () => {
      const { state, view } = this.editor;
      const sel = state.selection;
      // NodeSelection на атоме (queryBlock, raw, hr): $from.depth === 0, node(1) — undefined,
      // и v1 падал TypeError прямо в горячей клавише (проба ревью И9).
      let from: number; let node: ProseMirrorNode;
      if (sel instanceof NodeSelection && sel.node.isBlock) {
        from = sel.from; node = sel.node;
      } else if (sel.$from.depth >= 1) {
        from = sel.$from.before(1); node = sel.$from.node(1);
        // Каретка во вложенном списке двигает ВЕСЬ список верхнего уровня — зафиксировано
        // как поведение v2 (двигаем блок документа, не пункт).
      } else return true;
      const parent = state.doc;
      const index = parent.resolve(from).index(0);
      const target = index + dir;
      if (target < 0 || target >= parent.childCount) return true;
      const tr = state.tr.delete(from, from + node.nodeSize);
      const neighbor = parent.child(target);
      const insertAt = dir === 1 ? from + neighbor.nodeSize : from - neighbor.nodeSize;
      tr.insert(insertAt, node);
      view.dispatch(tr.scrollIntoView());
      return true;
    };
```

4. В тесты добавить: «Alt+↓ на выделенном queryBlock не бросает и меняет порядок»,
   «удаление блока внутри списка убирает ПУНКТ целиком, а не оставляет пустой».

Известная граница (в дизайн Задачей 17): на macOS `Alt+↑/↓` конкурирует с системной
навигацией по абзацам — принято, жест работает при фокусе в редакторе.

---

## Задача 12 (v2): markdown-тумблер

По старому плану (Задача 11) с одной правкой (И12 — предупреждение умирало вместе с
компонентом): при уходе текста в raw тумблер НЕ закрывается — предупреждение остаётся, и
сохранение требует второго явного «Применить»:

```tsx
  const [confirmedRaw, setConfirmedRaw] = useState(false);

  function apply() {
    if (text === initial) { onClose(); return; }
    const next = parseBody(text);
    const hasRaw = (next.doc.content ?? []).some((n) => n.type === 'rawBlock');
    if (hasRaw && !confirmedRaw) {
      // Не молчим и НЕ закрываем: warning в закрытом тумблере не увидел бы никто (ревью И12).
      setWarning('Часть разметки не разобрана — эти блоки сохранятся дословно, «как есть». Нажмите «Применить» ещё раз, чтобы подтвердить.');
      setConfirmedRaw(true);
      return;
    }
    onChange(next);
    onClose();
  }
```

Тест «неразбираемое не сохраняется молча» переписать: первый «Применить» → предупреждение
видно, `onChange` НЕ вызван; второй → вызван. Плюс сброс `confirmedRaw` при правке текста
(`onChange={e => { setText(e.target.value); setConfirmedRaw(false); setWarning(null); }}`).

---

## Задачи 13–14 (v2): сохранение и офлайн-черновик

Задача 13 v2 = старая Задача 12, Задача 14 v2 = старая Задача 13. Правки:

- моки тестов — функцией (Б6.3);
- в `useBodySave` сравнение «документ не изменился» — через `stripIds`-нормализацию
  (экспортировать `stripIds` из `BodyEditor.tsx` или вынести в `entity-editor/strip-ids.ts`
  и импортировать в обоих местах), не `JSON.stringify` сырых документов;
- тест Задачи 13 v2 дополнительно: «onDocChange с документом, равным по смыслу (лишь id
  отличаются), мутацию НЕ шлёт».

Остальное (debounce 2000, flush, индикатор, draft-storage, правило возврата) — без изменений.

---

## Задача 15 (v2): три таба, key, flush, ленивый тумблер

Заменяет Задачу 14 старого плана. Отличия:

- [ ] **Шаг A: `keepMounted` — опция, не поведение по умолчанию (Б8).** В `ui/Tabs.tsx`:

```tsx
export function Tabs({ defaultValue, tabs, keepMounted = false }: {
  defaultValue: string;
  tabs: Array<{ value: string; label: string; content: ReactNode }>;
  keepMounted?: boolean; // detail держит вкладки живыми ради редактора; Настройки — нет:
                         // forceMount по умолчанию смонтировал бы все шесть их вкладок
                         // и разослал их запросы разом (ревью Б8)
}) {
  // …в map:
  <RT.Content key={t.value} value={t.value}
    forceMount={keepMounted || undefined}
    className={keepMounted ? 'pt-3 data-[state=inactive]:hidden' : 'pt-3'}>
```

  (Точную сигнатуру компонента сверить с текущим `Tabs.tsx` и сохранить прочие пропсы.)
  Тест: «SettingsScreen не монтирует содержимое неактивных вкладок» — в
  `detail.test.tsx` или соседний сьют настроек.

- [ ] **Шаг B: тумблер — ТОЛЬКО lazy (Б7).** В `DetailScreen.tsx`:

```tsx
// Статический импорт затащил бы @orbis/shared/doc (~156 kB gzip) в чанк DetailScreen —
// в первый кадр каждого открытия сущности (ревью Б7). Только lazy.
const MarkdownToggle = lazy(() =>
  import('../entity-editor/MarkdownToggle').then((m) => ({ default: m.MarkdownToggle })));
```

  и рендер через `<Suspense fallback={null}>`.

- [ ] **Шаг C: `key={entity.id}` и flush (И2).** Обёртка тела на вкладке «Сущность»:

```tsx
// key — то же правило, что нёс BodySection (правка не должна пережить смену сущности);
// без него debounce-таймер со старым entityId дописал бы старый документ в новую запись:
// роутер монтирует DetailScreen БЕЗ key, меняется только проп (ревью И2).
<div key={entity.id}>
  {/* …EditorShell / MarkdownToggle / SaveIndicator / баннер pendingDraft… */}
</div>
```

  В `useBodySave` — flush на размонтировании:

```ts
  useEffect(() => () => { flushRef.current(); }, []); // размонтирование = уход с сущности
```

- [ ] **Шаг D:** пункт меню ⋮ — `DetailMenu` имеет фиксированные пропсы (ревью M): добавить
  проп `onToggleMarkdown?: () => void` и пункт в сам компонент, проводку — из DetailScreen.
- [ ] **Шаг E:** полоса прогресса цели: `unit` доставать из `entity.aspects['orbis/goal']`
  заново (в `AspectCards` он берётся из цикла — ревью M); `GoalProgress` уже отдельный
  компонент с пропсами `{progress, unit?}`.
- [ ] **Шаг F: тестовые файлы.** В «Файлы» этой задачи входят `detail.test.tsx`,
  **`Blocks.test.tsx`** (10 маркеров `body-view` → перевесить на заголовок) и
  **`query-builder.test.tsx`** (4 теста старого пути — переписать под правку атрибута ноды:
  ожидание `entity.update` со строковым `body` больше неверно). Всё это краснеет УЖЕ здесь,
  на Задаче 15 v2, а не при уборке (ревью И15).

Остальное (структура табов, содержимое вкладок, forceMount-тест черновика) — по старому плану.

---

## Задача 16 (v2): уборка, страж чанков, PRD

По старому плану (Задача 15) с правками:

1. Ожидание Шага 1 («только определения и их собственные тесты») уже НЕВЕРНО — маркеры
   сняты Задачей 15 v2; grep должен вернуть только `browser/query.ts` и его тест.
2. При удалении `replaceQueryBlock` удалить и его локальную `QUERY_BLOCK_CLOSE`
   (`browser/query.ts:34`) — иначе останется мёртвый дубль константы shared (ревью M).
3. **Страж чанков:** в `scripts/check-lazy-chunks.ts` добавить `'BodyEditor'` в
   `SHARED_CHUNKS` (НЕ в `LAZY_SCREENS` — тот сверяется с `lazy()`-точками `router.tsx` и
   упадёт на несоответствии; ревью Б7). Проверка Шага 4 дополняется:

```bash
ls apps/web/dist/assets/ | grep -E "BodyEditor|DetailScreen"
# чанк BodyEditor существует отдельно; gzip-размер DetailScreen-чанка сопоставим с прежним
# (вырос на единицы kB, НЕ на ~150) — иначе схема утекла в эагерную часть.
```

4. Линт — `bun run lint` (не `bunx biome check .`).
5. Правка PRD §3.5 — текст из старого плана, но строки: пункт 3 «Body» — строка **418**,
   «Ещё не реализовано» — **425–430** (ревью M).

---

## Задача 17 (v2, НОВАЯ): сквозная сверка документов

Требование вердикта (п.11): после восемнадцати разрозненных правок — один проход на
связность, а не точечные Edit'ы.

- [ ] **Шаг 1: правки дизайна** (`2026-08-13-notion-like-editor-design.md`) — одним заходом:
  - **Р3/Р4**: механизм `raw` — токен-детекция и поблочность вместо «сверка round-trip, не
    сошлось → всё тело в raw»; «байт-в-байт» — приёмка ТОЛЬКО для сидов (они канон);
    судьба тел: `body` = канон, производная от документа;
  - **Р3, подпись ссылки**: обещание «подпись обновляется при сериализации» СНЯТЬ с
    обоснованием: обновление `label` атрибутом воскрешало бы фантомную запись при открытии
    (тот же класс, что Б4); актуальное имя показывает чип, markdown-подпись — на момент
    вставки; вернуться вместе с блочным контрактом агента;
  - **Р6**: убрать «inverse станет хранить прежний body_doc … журнал потяжелеет вдвое» —
    Undo остаётся строковым; записать цену: Undo теряет блочные id (ревью И3);
  - **Р7 / Известные границы**: дописать «ссылки из raw-блоков остаются связями (регэксп);
    ссылки в код-блоках — нет»; убрать ложную страховку «`onboarding.test.ts` уже проверяет
    round-trip» (он сверяет константы с PRD и конвертер не зовёт — И4-ревью); «конвертирует
    лениво при первом чтении» → «при каждом чтении, пока тело не пересохранено или не
    прогнан бэкфилл; бэкфилл — обязательный шаг прод-процедуры» (И13);
  - **Состав редактора**: мобильная панель «+» над клавиатурой — пометить решением
    владельца как отложенную (в v2 не реализуется; вход на мобильном — `/` с клавиатуры) —
    либо, если владелец решит иначе, завести отдельную задачу; `Alt+↑/↓` на macOS —
    известная граница; `resolveRefs` не фильтрует archived — намеренно (чип обязан показать
    архивную; И14);
  - **Приёмка**: п.7 — «пять сидов канонические: `canonicalizeBody(seed).body === seed`»;
    новый пункт — «открытие сущности не отправляет ни одной мутации»; п.12 — «чанк
    BodyEditor отдельный, страж знает его поимённо».
- [ ] **Шаг 2:** перечитать дизайн и оба плана подряд свежим взглядом; каждое числовое или
  файловое утверждение — сверить с фактическим кодом ветки; расхождения чинить в документе.
- [ ] **Шаг 3:** коммит `docs(spec): дизайн к факту v2 — канонизация, поблочный raw, снятые обещания`.

---

## Самопроверка плана v2

**Покрытие блокеров ревью:** Б1 → Задачи 2, 3, 4, 5 (канонизация+токены+поблочность, аудит,
канон в бэкфилле и executor). Б2 → Задачи 2, 5. Б3 → Задача 5. Б4 → Задачи 2 (trailingNode),
7 (stripIds, тест «открытие не пишет»). Б5 → Задачи 2 (конфиг в схеме), 7 (не пересобирать).
Б6 → Задачи 2 (bun:test, сиды в server), 4–5 ({db,client}), 6 (callerFor/seedEntity),
7–14 (моки функцией). Б7 → Задачи 15 (lazy), 16 (страж). Б8 → Задача 15 (keepMounted).
Б9 → Задача 5 (types/readEntity/export). Important: И2→15, И3→17, И4→7, И5/И6→7, И7→2,
И8–И10→11, И11→7, И12→12, И13→17, И14→6, И15→15, И17→2, И18→10, И19→7; Undo-цена → 17.
Minor закрываются в задачах по месту (полифил→2.1, sql-импорт→6, дубль константы→16,
плейсхолдер→10, PRD-строки→16, readBodyDoc-тест→2).

**Порядок вердикта соблюдён:** аудит корпуса (З3) стоит до миграции и бэкфилла (З4) и служит
стоп-краном; сами три меры Б1 реализуются в З2 — решение по ним контроллер уже принял,
аудит калибрует белые списки и масштаб бэкфилла. `trailingNode`/UniqueID — в первой тройке
кода (З2/З7). Сквозная сверка — З17.

**Согласованность имён:** `canonicalizeBody`/`parseBody`/`serializeBody`/`bodyRefsFromDoc`/
`readBodyDoc`/`stripIds`/`BODY_REF_RE`/`OrbisMarkdownManager` — объявлены в З2/З7,
используются в 3, 4, 5, 7, 12, 13 под теми же именами. `EDITOR_EXTENSIONS` собирается один
раз (З7), З8/З9/З10/З11 добавляют элементы в отмеченные места.

**Не покрыто намеренно:** мобильный ввод (проверка владельцем на устройстве — как и было);
мобильная панель «+» (решение владельца, З17); прод-прогон `audit-bodies` (владелец, ops).
