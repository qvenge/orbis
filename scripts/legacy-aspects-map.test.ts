// scripts/legacy-aspects-map.test.ts
// СТРАЖ Задачи 23a: старой карты аспектов `aspects: {<id>: {<поле>: <значение>}}` в тестовых
// файлах репозитория больше нет.
//
// Зачем отдельный страж, а не «переписали и хорошо». Союз легаси-входа исполнителя
// (`fromLegacyInput`, `contracts/tools.ts`) ЖИВ до Задачи 23b: старая карта сегодня
// принимается и работает. Значит вернувшаяся фикстура старой формы зелёная — её не поймает
// ни один сьют, и к 23b, где союз сносится, их снова окажется полсотни. Страж — это то
// единственное место, где «форма» проверяется как форма, а не как поведение.
//
// Пятно охвата — ТЕСТОВЫЕ файлы (`*.test.ts(x)`, всё под `test/`, фикстуры): боевой код
// старой карты не пишет вовсе, а миграции и `legacy-form.ts`/`legacy-field-map.ts` описывают
// её по своему назначению и умирают вместе с ней (23b).
//
// Аллоулист — ПОИМЁННО и с ТОЧНЫМ числом: файлы, где старая карта стоит НАМЕРЕННО, потому
// что тест утверждает про неё саму (отказ тул-контракта, приём exec-надмножеством,
// невыразимый в плоской модели конфликт В1). Число точное, а не «не больше»: с порогом
// «≤ N» в такой файл можно было бы молча дописать ещё одну фикстуру старой формы.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const ROOTS = ['apps', 'packages', 'scripts'];
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  'coverage',
  'migrations',
  '__snapshots__',
]);

/** Сам страж: образцы старой формы в нём — предмет проверки, а не нарушение. */
const SELF = relative(ROOT, import.meta.path)
  .split(sep)
  .join('/');

/**
 * Старая карта: за `aspects:` открывается объект, и первый его ключ — СТРОКОВЫЙ литерал
 * (id аспекта). Новая форма так выглядеть не может: у создания это список
 * (`aspects: ['orbis/task']`), у правки — объект с ключами-идентификаторами
 * (`aspects: { attach: […] }`), и оба под этот образец не подходят.
 */
const LEGACY_MAP = /aspects:\s*\{\s*(['"])[^'"\n]+\1\s*:/g;

/** Файлы, где старая карта стоит НАМЕРЕННО: путь → [сколько, почему]. */
const ALLOWLIST: Record<string, { readonly count: number; readonly reason: string }> = {
  'packages/shared/src/contracts/tools.test.ts': {
    count: 3,
    reason:
      'тесты ОТКАЗА старой карты: «старую карту аспектов и `meta` не принимают НИ тул, НИ ' +
      'роутер владельца», «старую карту не принимают НИ тул, НИ роутер — только исполнитель», ' +
      '«exec-схема принимает обе формы; тул-контракт модели не принимает ни одной». ' +
      'Карта здесь — ВХОД проверки; после 23b те же три станут отказом и для исполнителя',
  },
  'apps/server/src/executor/props.test.ts': {
    count: 4,
    reason:
      'тесты про саму старую форму: «entity_create со СТАРЫМ патчем aspects → props/aspects[]», ' +
      'легаси-половина пары «старая форма ≡ новая», «financial+budget с разной category_ref в ' +
      'одном create → VALIDATION (В1)» (конфликт слитого свойства выразим ТОЛЬКО картой) и ' +
      'строка «Старая карта и attach-тулы — как было» в предикате замка бюджет-контура',
  },
  'apps/server/src/tools/dispatch.test.ts': {
    count: 2,
    reason:
      'тест «meta и старая карта аспектов в LLM-туле → VALIDATION; UI-роутер старую карту ' +
      'ПРИНИМАЕТ»: обе половины утверждают про саму карту — отказ тул-контрактом и приём ' +
      'exec-надмножеством до 23b',
  },
};

/** Тестовый файл: сьют, обвязка под `test/` либо фикстура. */
function isTestFile(rel: string): boolean {
  return (
    /\.test\.tsx?$/.test(rel) ||
    rel.includes('/test/') ||
    rel.includes('/perf/') ||
    /fixtures?\.tsx?$/.test(rel)
  );
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(name)) continue;
    const rel = relative(ROOT, full).split(sep).join('/');
    if (rel === SELF) continue;
    if (isTestFile(rel)) out.push(rel);
  }
}

const files: string[] = [];
for (const r of ROOTS) walk(join(ROOT, r), files);

/** `путь → номера строк со старой картой`. */
function hits(): Map<string, number[]> {
  const found = new Map<string, number[]>();
  for (const rel of files) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    const lines: number[] = [];
    LEGACY_MAP.lastIndex = 0;
    const text = src.split('\n');
    for (const m of src.matchAll(LEGACY_MAP)) {
      const line = src.slice(0, m.index).split('\n').length;
      // Строка комментария — не фикстура: докблоки называют старую форму по имени именно
      // затем, чтобы объяснить, чем она была и когда умрёт.
      const trimmed = (text[line - 1] ?? '').trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      lines.push(line);
    }
    if (lines.length > 0) found.set(rel, lines);
  }
  return found;
}

describe('старой карты аспектов в тестовых фикстурах нет (Задача 23a, подготовка сноса)', () => {
  test('обход не выродился: тестовых файлов найдено больше сотни', () => {
    // Положительный контроль охвата: сломайся `walk` или `isTestFile` — страж молча
    // проверял бы пустой список и зеленел бы на любом дереве.
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('apps/server/src/executor/props.test.ts');
    expect(files).toContain('apps/web/src/test/harness.tsx');
  });

  test('вне аллоулиста старой карты нет ни одной строки', () => {
    const offenders = [...hits().entries()]
      .filter(([rel]) => ALLOWLIST[rel] === undefined)
      .map(([rel, lines]) => `${rel}: ${lines.join(', ')}`);
    expect(offenders).toEqual([]);
  });

  test('в аллоулисте — ТОЧНО столько строк, сколько объявлено, и ни одной лишней', () => {
    const found = hits();
    const actual: Record<string, number> = {};
    for (const rel of Object.keys(ALLOWLIST)) actual[rel] = found.get(rel)?.length ?? 0;
    const expected: Record<string, number> = {};
    for (const [rel, entry] of Object.entries(ALLOWLIST)) expected[rel] = entry.count;
    expect(actual).toEqual(expected);
  });

  test('у каждой записи аллоулиста есть причина, и она называет тесты', () => {
    for (const [rel, entry] of Object.entries(ALLOWLIST)) {
      expect(`${rel}: ${entry.reason.length > 60}`).toBe(`${rel}: true`);
    }
  });
});
