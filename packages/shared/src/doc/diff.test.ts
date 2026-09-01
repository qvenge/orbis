// bun:test, как ВЕСЬ пакет shared: у него "test": "bun test", и файл на vitest уронил бы
// корневой прогон. Тела здесь строятся ДЕРЕВОМ, а не markdown'ом: `diff.ts` листовой и разбора
// не знает — импорт `parseBody` сюда протащил бы схему Tiptap в тест листового модуля.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { JSONContent } from '@tiptap/core';
import {
  type BodyDiffResult,
  blockText,
  DIFF_LIMITS_DEFAULT,
  type DiffUnit,
  diffBodyDocs,
  flattenBlocks,
} from './diff';

const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content });
const p = (text: string): JSONContent => ({
  type: 'paragraph',
  ...(text === '' ? {} : { content: [{ type: 'text', text }] }),
});
const heading = (level: number, text: string): JSONContent => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
});
const code = (language: string, text: string): JSONContent => ({
  type: 'codeBlock',
  attrs: { language },
  content: [{ type: 'text', text }],
});
const taskItem = (checked: boolean, text: string): JSONContent => ({
  type: 'taskItem',
  attrs: { checked },
  content: [p(text)],
});
const taskList = (...items: JSONContent[]): JSONContent => ({ type: 'taskList', content: items });
const listItem = (text: string, ...rest: JSONContent[]): JSONContent => ({
  type: 'listItem',
  content: [p(text), ...rest],
});
const bulletList = (...items: JSONContent[]): JSONContent => ({
  type: 'bulletList',
  content: items,
});

/** Наполнитель: бюджет Myers считается от (N + M), и коротким телам правки его не хватает. */
const filler = (n: number): JSONContent[] =>
  Array.from({ length: n }, (_, i) => p(`строка наполнителя номер ${i + 1}`));

const unitsOf = (result: BodyDiffResult): DiffUnit[] => {
  if ('skipped' in result) throw new Error(`ожидались единицы, а дифф пропущен: ${result.skipped}`);
  return result.units;
};
const kinds = (result: BodyDiffResult): string[] => unitsOf(result).map((u) => u.kind);
const at = (units: DiffUnit[], i: number): DiffUnit => {
  const u = units[i];
  if (u === undefined) throw new Error(`нет единицы ${i} из ${units.length}`);
  return u;
};

describe('flattenBlocks — правило развёртки', () => {
  test('контейнеры прозрачны, их дети — единицы; вложенный подсписок даёт свои единицы', () => {
    const flat = flattenBlocks(
      doc(
        heading(2, 'Расписание'),
        taskList(taskItem(false, 'Первое'), taskItem(true, 'Второе')),
        bulletList(listItem('Пункт', bulletList(listItem('Вложенный')))),
        { type: 'blockquote', content: [p('Цитата')] },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [p('Ячейка')] },
                { type: 'tableHeader', content: [p('Заголовок')] },
              ],
            },
          ],
        },
      ),
    );
    expect(flat.map((b) => b.kind)).toEqual([
      'heading',
      'taskItem',
      'taskItem',
      'listItem',
      'listItem',
      'paragraph',
      'tableRow',
    ]);
    expect(flat.map((b) => b.text)).toEqual([
      'Расписание',
      'Первое',
      'Второе',
      'Пункт',
      'Вложенный',
      'Цитата',
      'Ячейка Заголовок',
    ]);
  });

  test('пустые единицы, horizontalRule, queryBlock и rawBlock не теряются', () => {
    const flat = flattenBlocks(
      doc(
        p(''),
        { type: 'horizontalRule' },
        { type: 'queryBlock', attrs: { ast: null, text: 'status:open' } },
        { type: 'rawBlock', attrs: { markdown: '| a | b |' } },
        p(''),
      ),
    );
    expect(flat.map((b) => b.kind)).toEqual([
      'paragraph',
      'horizontalRule',
      'queryBlock',
      'rawBlock',
      'paragraph',
    ]);
    expect(flat.map((b) => b.text)).toEqual(['', '', 'status:open', '| a | b |', '']);
  });

  test('ключ несёт тип и значимые атрибуты, а текст нормализуется', () => {
    const one = (node: JSONContent) => {
      const flat = flattenBlocks(doc(node));
      const first = flat[0];
      if (first === undefined) throw new Error('развёртка потеряла единственный блок');
      return first;
    };
    expect(one(heading(2, '  Расписание   дня \n')).text).toBe('Расписание дня');
    expect(one(heading(2, '  Расписание   дня \n')).key).toBe(
      one(heading(2, 'Расписание дня')).key,
    );
    expect(one(heading(3, 'Расписание дня')).key).not.toBe(one(heading(2, 'Расписание дня')).key);
    expect(one(p('Расписание дня')).key).not.toBe(one(heading(2, 'Расписание дня')).key);
  });
});

describe('blockText — писаный текст блока', () => {
  test('берёт текст узлов, markdown raw-блока и запрос смарт-листа; подпись ссылки — нет', () => {
    expect(blockText(p('Привет'))).toBe('Привет');
    expect(blockText({ type: 'rawBlock', attrs: { markdown: '| a |' } })).toBe('| a |');
    expect(blockText({ type: 'queryBlock', attrs: { ast: null, text: 'status:open' } })).toBe(
      'status:open',
    );
    expect(
      blockText({
        type: 'paragraph',
        content: [
          { type: 'text', text: 'см. ' },
          { type: 'entityRef', attrs: { entityId: 'x', label: 'Задача' } },
        ],
      }),
    ).toBe('см. ');
  });
});

describe('diffBodyDocs — блочный дифф', () => {
  const plan = (third: string): JSONContent =>
    doc(
      taskList(
        taskItem(false, '07:30 — подъём, зарядка 15 минут'),
        taskItem(false, '08:00 — завтрак и почта'),
        taskItem(false, third),
        taskItem(false, '13:00 — обед'),
        taskItem(false, '15:00 — разбор входящих'),
        taskItem(false, '18:00 — спорт'),
      ),
    );

  test('перенос «10:00 → 14:00» в пункте: changed с parts [removed, added, same хвост]', () => {
    const result = diffBodyDocs(
      plan('10:00 — созвон с командой'),
      plan('14:00 — созвон с командой'),
    );
    expect(kinds(result)).toEqual(['same', 'same', 'changed', 'same', 'same', 'same']);
    const changed = at(unitsOf(result), 2);
    expect(changed.before).toBe('10:00 — созвон с командой');
    expect(changed.after).toBe('14:00 — созвон с командой');
    expect(changed.parts).toEqual([
      { kind: 'removed', text: '10:00' },
      { kind: 'added', text: '14:00' },
      { kind: 'same', text: '— созвон с командой' },
    ]);
  });

  test('стороны parts, склеенные пробелом, дают ровно before и after', () => {
    const changed = at(
      unitsOf(diffBodyDocs(plan('10:00 — созвон с командой'), plan('14:00 — созвон с Аней'))),
      2,
    );
    const side = (skip: string) =>
      (changed.parts ?? [])
        .filter((part) => part.kind !== skip)
        .map((part) => part.text)
        .join(' ');
    const { before, after } = changed;
    if (before === undefined || after === undefined) throw new Error('у changed нет обеих сторон');
    expect(side('added')).toBe(before);
    expect(side('removed')).toBe(after);
  });

  test('вставка пункта НАД изменённым: окно спаривания находит пару, вставка — added', () => {
    const before = doc(
      taskList(
        taskItem(false, '08:00 — завтрак и почта'),
        taskItem(false, '09:00 — блок глубокой работы: дифф предложения, разведка кода'),
        taskItem(false, '13:00 — обед'),
        taskItem(false, '15:00 — разбор входящих'),
        taskItem(false, '18:00 — спорт'),
      ),
    );
    const after = doc(
      taskList(
        taskItem(false, '08:00 — завтрак и почта'),
        taskItem(false, '10:00 — короткий синк с Аней по дизайну'),
        taskItem(false, '11:00 — блок глубокой работы: дифф предложения, разведка кода'),
        taskItem(false, '13:00 — обед'),
        taskItem(false, '15:00 — разбор входящих'),
        taskItem(false, '18:00 — спорт'),
      ),
    );
    const result = diffBodyDocs(before, after);
    expect(kinds(result)).toEqual(['same', 'added', 'changed', 'same', 'same', 'same']);
    const units = unitsOf(result);
    expect(at(units, 1).after).toBe('10:00 — короткий синк с Аней по дизайну');
    expect(at(units, 1).before).toBeUndefined();
    expect(at(units, 2).before).toBe(
      '09:00 — блок глубокой работы: дифф предложения, разведка кода',
    );
    expect(at(units, 2).after).toBe(
      '11:00 — блок глубокой работы: дифф предложения, разведка кода',
    );
  });

  test('перестановка блоков → removed + added (известная граница спеки)', () => {
    const a = p('Первый абзац про сроки');
    const b = p('Второй абзац про бюджет');
    const c = p('Третий абзац про риски');
    const rest = filler(3);
    const result = diffBodyDocs(doc(a, b, c, ...rest), doc(a, c, b, ...rest));
    expect(kinds(result)).toEqual(['same', 'removed', 'same', 'added', 'same', 'same', 'same']);
    const units = unitsOf(result);
    expect(at(units, 1).before).toBe('Второй абзац про бюджет');
    expect(at(units, 3).after).toBe('Второй абзац про бюджет');
  });

  test('щелчок чекбоксом, уровень заголовка и язык кодового блока — changed, а не same', () => {
    const body = (checked: boolean, level: number, language: string): JSONContent =>
      doc(
        heading(level, 'Расписание дня'),
        taskList(taskItem(checked, 'Позвонить в клинику'), taskItem(false, 'Оплатить счёт')),
        code(language, 'const a = 1;'),
        ...filler(8),
      );
    const result = diffBodyDocs(body(false, 2, 'ts'), body(true, 3, 'js'));
    expect(kinds(result).filter((k) => k !== 'same')).toEqual(['changed', 'changed', 'changed']);
    const changed = unitsOf(result).filter((u) => u.kind === 'changed');
    expect(changed.map((u) => u.before)).toEqual([
      'Расписание дня',
      'Позвонить в клинику',
      'const a = 1;',
    ]);
    expect(changed.map((u) => u.after)).toEqual(changed.map((u) => u.before));
  });

  test('дописанный хвост к короткому блоку: вложение 1.0 спаривает', () => {
    const body = (sport: string): JSONContent => doc(p('Заметки недели'), p(sport), ...filler(4));
    const result = diffBodyDocs(
      body('Спорт'),
      body('Спорт — заменить на бассейн, абонемент до пятницы'),
    );
    expect(kinds(result)).toEqual(['same', 'changed', 'same', 'same', 'same', 'same']);
    const changed = at(unitsOf(result), 1);
    expect(changed.parts).toEqual([
      { kind: 'same', text: 'Спорт' },
      { kind: 'added', text: '— заменить на бассейн, абонемент до пятницы' },
    ]);
  });

  test('чеклист переписан маркированным списком → замена (типы не спариваются)', () => {
    const before = doc(
      taskList(taskItem(false, 'Позвонить в клинику'), taskItem(false, 'Оплатить счёт')),
      ...filler(8),
    );
    const after = doc(
      bulletList(listItem('Позвонить в клинику'), listItem('Оплатить счёт')),
      ...filler(8),
    );
    const result = diffBodyDocs(before, after);
    expect(kinds(result).filter((k) => k !== 'same')).toEqual([
      'removed',
      'removed',
      'added',
      'added',
    ]);
    expect(unitsOf(result).some((u) => u.kind === 'changed')).toBe(false);
  });

  test('СКРЕЩЕНИЕ пар не ломает порядок after-стороны (находка гейт-ревью)', () => {
    // Точная форма из ревью: r0 «alpha beta» ближе к a2 (Дайс 0.8), чем к a0 (0.571), а r1
    // ближе всего к a0 — жадный отбор без запрета скрещения выдавал after-сторону
    // [a1, a2, a0] вместо [a0, a1, a2]. Инвариант порядка — контракт для Задач 7 и 11.
    const before = doc(p('alpha beta'), p('alpha beta gamma delta'), ...filler(8));
    const after = doc(
      p('alpha beta gamma delta epsilon'),
      p('мимо кассы совсем'),
      p('alpha beta zeta'),
      ...filler(8),
    );
    const result = diffBodyDocs(before, after);
    const units = unitsOf(result);
    expect(units.filter((u) => u.kind !== 'removed').map((u) => u.after)).toEqual([
      'alpha beta gamma delta epsilon',
      'мимо кассы совсем',
      'alpha beta zeta',
      ...filler(8).map((node) => flattenBlocks(doc(node))[0]?.text),
    ]);
    expect(units.filter((u) => u.kind !== 'added').map((u) => u.before)).toEqual([
      'alpha beta',
      'alpha beta gamma delta',
      ...filler(8).map((node) => flattenBlocks(doc(node))[0]?.text),
    ]);
    // Скрещённая пара не спаривается вовсе — блок честно показывается заменой, а не
    // изменением не на своём месте.
    expect(units.slice(0, 4).map((u) => u.kind)).toEqual(['added', 'added', 'changed', 'removed']);
  });

  test('мягкий перенос разводит слова единицы, а blockText по-прежнему клеит впритык', () => {
    // Shift+Enter в редакторе: клиентский пересчёт диффа берёт editor.getJSON(), так что
    // случай боевой. Без разведения владелец увидел бы «Позвонить АнеКупить хлеб», а мера
    // похожести получила бы слово «анекупить» (находка гейт-ревью).
    const paragraph: JSONContent = {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Позвонить Ане' },
        { type: 'hardBreak' },
        { type: 'text', text: 'Купить хлеб' },
      ],
    };
    expect(flattenBlocks(doc(paragraph))[0]?.text).toBe('Позвонить Ане Купить хлеб');
    // Вторая половина контракта: правило конверсии не тронуто — там склейка впритык, и
    // разводить обязана развёртка, а не общий с convert.ts blockText.
    expect(blockText(paragraph)).toBe('Позвонить АнеКупить хлеб');
  });

  test('щелчок чекбоксом на ПУСТОЙ задаче — changed, а не removed + added', () => {
    // Дух правила, а не буква: слов нет, Дайс молчит, но ключи разошлись атрибутом, а типы
    // совпали — это изменение (находка гейт-ревью).
    const body = (checked: boolean) =>
      doc(taskList(taskItem(checked, ''), taskItem(false, 'Оплатить счёт')), ...filler(6));
    const units = unitsOf(diffBodyDocs(body(false), body(true)));
    expect(units.map((u) => u.kind)).toEqual([
      'changed',
      'same',
      'same',
      'same',
      'same',
      'same',
      'same',
      'same',
    ]);
    expect(at(units, 0).before).toBe('');
    expect(at(units, 0).after).toBe('');
  });

  test('одинаковые тела → все единицы same, before и after заполнены обе', () => {
    const body = doc(heading(2, 'План'), ...filler(3), { type: 'horizontalRule' });
    const result = diffBodyDocs(body, body);
    expect(kinds(result)).toEqual(['same', 'same', 'same', 'same', 'same']);
    for (const unit of unitsOf(result)) expect(unit.before).toBe(unit.after ?? '');
    expect(unitsOf(result).every((u) => u.parts === undefined)).toBe(true);
  });

  test('пустые тела дают пустой список единиц', () => {
    expect(unitsOf(diffBodyDocs(doc(), doc()))).toEqual([]);
  });
});

describe('diffBodyDocs — потолки', () => {
  test('умолчания — числа Развилки 6', () => {
    expect(DIFF_LIMITS_DEFAULT).toEqual({
      maxBlocks: 1000,
      maxBlockWords: 400,
      maxEditRatio: 0.3,
      minEditBudget: 8,
    });
  });

  test('полная перезапись: D сверх бюджета → skipped rewritten', () => {
    const before = doc(...Array.from({ length: 10 }, (_, i) => p(`было: строка номер ${i + 1}`)));
    const after = doc(
      ...Array.from({ length: 10 }, (_, i) => p(`совершенно другое содержимое ${i + 1}`)),
    );
    expect(diffBodyDocs(before, after)).toEqual({ skipped: 'rewritten' });
  });

  test('блоков сверх maxBlocks → skipped too_large (проверяется каждая сторона)', () => {
    const small = doc(...filler(2));
    const big = doc(...filler(5));
    expect(diffBodyDocs(small, big, { maxBlocks: 3 })).toEqual({ skipped: 'too_large' });
    expect(diffBodyDocs(big, small, { maxBlocks: 3 })).toEqual({ skipped: 'too_large' });
    expect('units' in diffBodyDocs(small, small, { maxBlocks: 3 })).toBe(true);
  });

  test('блок длиннее maxBlockWords — changed целиком, без parts', () => {
    const long = (tail: string) =>
      `${Array.from({ length: 30 }, (_, i) => `слово${i}`).join(' ')} ${tail}`;
    const body = (tail: string) => doc(p(long(tail)), ...filler(5));
    const wide = diffBodyDocs(body('конец'), body('финал'), { maxBlockWords: 10 });
    const narrow = diffBodyDocs(body('конец'), body('финал'));
    expect(at(unitsOf(wide), 0).kind).toBe('changed');
    expect(at(unitsOf(wide), 0).parts).toBeUndefined();
    expect(at(unitsOf(narrow), 0).parts).not.toBeUndefined();
  });

  test('СТУПЕНЬКА бюджета: тело сида в 3 единицы правится, а не «переписывается целиком»', () => {
    // Форма взята прямо у UPCOMING_BODY (apps/server/src/seed/smart-lists.ts:20): абзац и два
    // смарт-листа, всего три единицы. Такое тело получает КАЖДЫЙ новый пользователь, и без
    // нижней ступеньки бюджета правка одной строки отвечала бы «тело переписано целиком» —
    // ложь владельцу (замер при исполнении Задачи 6, план поправлен коммитом 2aba4fa).
    const upcoming = (intro: string) =>
      doc(
        p(intro),
        {
          type: 'queryBlock',
          attrs: { ast: null, text: 'aspect=orbis/task, due_date=next_7d, title=Ближайшие 7 дней' },
        },
        {
          type: 'queryBlock',
          attrs: { ast: null, text: 'aspect=orbis/task, due_date=after_7d, title=Позже' },
        },
      );
    const result = diffBodyDocs(
      upcoming('Горизонт планирования: неделя и дальше.'),
      upcoming('Горизонт планирования: две недели и дальше.'),
    );
    expect(kinds(result)).toEqual(['changed', 'same', 'same']);
    expect(at(unitsOf(result), 0).parts).toEqual([
      { kind: 'same', text: 'Горизонт планирования:' },
      { kind: 'removed', text: 'неделя' },
      { kind: 'added', text: 'две недели' },
      { kind: 'same', text: 'и дальше.' },
    ]);
    // Ступенька — именно то, что это чинит: обнули её, и вернётся прежняя ложь.
    expect(
      diffBodyDocs(
        upcoming('Горизонт планирования: неделя и дальше.'),
        upcoming('Горизонт планирования: две недели и дальше.'),
        { minEditBudget: 0 },
      ),
    ).toEqual({ skipped: 'rewritten' });
  });

  test('ступенька НЕ отключает отсечку: большое тело с полной перезаписью по-прежнему пропускается', () => {
    const before = doc(...Array.from({ length: 40 }, (_, i) => p(`было: строка номер ${i + 1}`)));
    const after = doc(
      ...Array.from({ length: 40 }, (_, i) => p(`совершенно другое содержимое ${i + 1}`)),
    );
    // D = 80 против бюджета max(8, 0.3·80) = 24 — ступенька в этом теле не участвует вовсе.
    expect(diffBodyDocs(before, after)).toEqual({ skipped: 'rewritten' });
    expect(kinds(diffBodyDocs(before, after, { maxEditRatio: 1 }))).toHaveLength(80);
  });
});

describe('сплошной пробой сопоставления', () => {
  /** Свой генератор, а не Math.random: падение обязано воспроизводиться той же командой. */
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  test('единицы восстанавливают обе стороны дословно и в порядке документа (200 случаев)', () => {
    const random = rng(20260820);
    const seen = { same: 0, added: 0, removed: 0, changed: 0, crossable: 0 };
    for (let round = 0; round < 200; round += 1) {
      const source = Array.from({ length: 2 + Math.floor(random() * 24) }, (_, i) => `блок ${i}`);
      const edited: string[] = [];
      for (let i = 0; i < source.length; i += 1) {
        const line = source[i] ?? '';
        const next = source[i + 1];
        const roll = random();
        // СКРЕЩЕНИЕ: две соседние похожие строки правятся ОБЕ и меняются местами. Ровно та
        // форма, на которой гейт-ревью поймало нарушение порядка after-стороны: «блок i» ближе
        // к «блок i с правкой» (Дайс 0.667), а он стоит ВТОРЫМ, — жадный отбор без запрета
        // скрещения выдал бы пары (r0→a1, r1→a0) и порядок [a1, a0]. Без этой ветки генератор
        // класс не порождает вовсе, и дефект уехал бы в следующую правку незамеченным.
        if (roll < 0.15 && next !== undefined) {
          edited.push(`${next} с правкой`, `${line} с правкой`);
          seen.crossable += 1;
          i += 1;
          continue;
        }
        if (roll < 0.3) continue; // удаление
        if (roll < 0.45) edited.push(`${line} с правкой`);
        else edited.push(line);
        if (random() < 0.15) edited.push(`вставка ${Math.floor(random() * 1000)}`);
      }
      const result = diffBodyDocs(doc(...source.map(p)), doc(...edited.map(p)), {
        maxEditRatio: 1,
      });
      const units = unitsOf(result);
      const left = units.filter((u) => u.kind !== 'added').map((u) => u.before);
      const right = units.filter((u) => u.kind !== 'removed').map((u) => u.after);
      expect(left, `раунд ${round}`).toEqual(source);
      expect(right, `раунд ${round}`).toEqual(edited);
      for (const unit of units) seen[unit.kind] += 1;
    }
    // Страж от вакуумности: пробой обязан пройти через все четыре исхода И через класс
    // скрещения, иначе он проверяет только тождественные тела и мимо дефекта ревью.
    for (const kind of ['same', 'added', 'removed', 'changed', 'crossable'] as const) {
      expect(seen[kind], kind).toBeGreaterThan(50);
    }
  });
});

describe('query-блок в диффе: текст из `text`, ключ по `ast`', () => {
  const qb = (ast: unknown, text: string): JSONContent => ({
    type: 'queryBlock',
    attrs: { ast, text },
  });
  const status = (op: string) => ({
    filter: { prop: 'orbis/task_status', op, value: 'inbox' },
  });

  test('правка запроса видна: старое имя атрибута дифф больше не читает', () => {
    // Держатель имени, ломавшийся МОЛЧА: пока `collectText` смотрел на `attrs.query`, правка
    // запроса приезжала бы как `same` — самая вероятная правка стала бы невидимой.
    const before = doc(qb(status('eq'), 'orbis/task_status=inbox'));
    const after = doc(qb(status('eq'), 'orbis/task_status=planned'));
    expect(kinds(diffBodyDocs(before, after))).toEqual(['changed']);
  });

  test('РАЗНЫЕ деревья с ОДНОЙ печатью различаются ключом (eq против contains)', () => {
    // Плоская грамматика печатает `p=v` и для `eq`, и для `contains` — без `ast` в ключе эта
    // правка приехала бы как `same` (класс назван в докблоке `AstFixture.keyText`).
    const text = 'orbis/task_status=inbox';
    expect(
      kinds(diffBodyDocs(doc(qb(status('eq'), text)), doc(qb(status('contains'), text)))),
    ).toEqual(['changed']);
  });

  test('порядок ключей дерева блок НЕ меняет (сторона из jsonb против стороны от клиента)', () => {
    // PostgreSQL порядок ключей jsonb не сохраняет; голая сериализация объявляла бы такой блок
    // изменённым при каждом показе предложения.
    const a = doc(qb({ filter: { op: 'eq', value: 'inbox', prop: 'orbis/task_status' } }, 'x'));
    const b = doc(qb({ filter: { prop: 'orbis/task_status', op: 'eq', value: 'inbox' } }, 'x'));
    expect(kinds(diffBodyDocs(a, b))).toEqual(['same']);
  });

  test('переименование подписи свойства блок НЕ трогает: в key-форме лежат ключи', () => {
    // Дифф Ш1 меряет key-печатью (§А5-2): подпись в неё не входит вовсе, поэтому переименование
    // свойства в реестре не может показаться владельцу правкой его тела.
    const same = doc(qb(status('eq'), 'orbis/task_status=inbox'));
    expect(kinds(diffBodyDocs(same, doc(qb(status('eq'), 'orbis/task_status=inbox'))))).toEqual([
      'same',
    ]);
  });
});

describe('листовость модуля', () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
  /** Разбор — приём `apps/web/src/features/entity-editor/save.test.tsx:1388`: рантайм-импорт
   *  отличается от типового отсутствием `type` сразу за `import`. */
  const runtimeImports = (src: string) =>
    [...src.matchAll(/^import\b(?!\s+type\b)(?!\s*[.(])[^'"`]*?(['"`])([^'"`]*)\1/gm)].flatMap(
      (m) => (m[2] === undefined ? [] : [m[2]]),
    );
  const blankComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  test('исходник diff.ts не содержит рантайм-импортов', () => {
    expect(runtimeImports(read('./diff.ts'))).toEqual([]);
    // Положительный контроль: тот же разбор на тяжёлом соседе обязан сработать, иначе пустой
    // список выше означал бы лишь сломанный разбор.
    expect(runtimeImports(read('./convert.ts'))).toContain('@tiptap/core');
  });

  test('исходник diff.ts не упоминает ./convert и ./schema даже реэкспортом', () => {
    expect(blankComments(read('./diff.ts'))).not.toMatch(/\.\/(convert|schema)/);
  });

  test('convert.ts берёт blockText из diff — писаный текст один на всех', () => {
    const src = read('./convert.ts');
    expect(runtimeImports(src)).toContain('./diff');
    expect(src).not.toMatch(/function writtenText/);
  });
});
