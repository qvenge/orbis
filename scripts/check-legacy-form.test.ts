// Тест греп-гейта старой формы данных (scripts/check-legacy-form.ts, §А12-2).
//
// Гейт проверяется НА СИНТЕТИЧЕСКОМ дереве, а не на рабочем: цифры рабочего дерева меняет
// каждая задача среза, и тест, привязанный к ним, начал бы падать по чужой причине. Здесь
// на каждый инвариант заводится крошечный временный git-репозиторий с ровно теми файлами,
// которые инвариант описывает.
//
// Почему временный репозиторий, а не подкаталог: источник совпадений — `git grep`, а он
// ищет по файлам, ЗАРЕГИСТРИРОВАННЫМ в индексе, и pathspec'ы гейта отсчитываются от корня
// репозитория.
//
// Прогоняется корневым `bun run test`: `bun run --filter '*' test` берёт только пакеты
// workspace (корневой пакет под `*` НЕ попадает — проверено), поэтому в корневой скрипт
// `test` добавлен хвост `&& bun test scripts/`. Без него этот файл не запускал бы никто —
// ни локально, ни в CI.
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ALLOWLIST, LEGACY_MARKERS, type MarkerReport, scan } from './check-legacy-form.ts';

const SCRIPT = join(import.meta.dir, 'check-legacy-form.ts');
const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Временный git-репозиторий с заданными файлами; файлы добавлены в индекс (без коммита). */
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'orbis-legacy-form-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  for (const cmd of [
    ['git', 'init', '-q'],
    ['git', 'add', '-A'],
  ]) {
    const p = Bun.spawnSync(cmd, { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
    if (p.exitCode !== 0) {
      throw new Error(`${cmd.join(' ')} упал: ${new TextDecoder().decode(p.stderr)}`);
    }
  }
  return dir;
}

function byId(reports: MarkerReport[], id: string): MarkerReport {
  const r = reports.find((x) => x.id === id);
  if (r === undefined) throw new Error(`маркера ${id} нет в отчёте`);
  return r;
}

/** Запуск гейта как CLI — ради кода возврата, ради которого он и существует. */
function cli(dir: string, ...args: string[]): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(['bun', SCRIPT, ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  const dec = new TextDecoder();
  return { code: p.exitCode, out: dec.decode(p.stdout), err: dec.decode(p.stderr) };
}

test('файл с NUL-байтом сопоставляется — и когда байт в начале, и когда в середине', () => {
  // Это ЕДИНСТВЕННАЯ причина, по которой гейт написан скриптом, а не строкой `grep -r` в CI.
  // `grep -r` на обоих файлах ниже даёт ноль строк и молчит; `git grep` без `-a` даёт по
  // первому «Binary file … matches» без номера строки, а с `-I` — тоже ноль.
  const dir = repo({
    // NUL в первых байтах — сюда `-I` бы не заглянул вовсе
    'apps/server/src/nul-early.ts': '\u0000\u0000 header\nconst q = "aspects->x";\n',
    // NUL после совпадения — так выглядел budget/aggregates.ts (ключи сортировки)
    'apps/server/src/nul-late.ts':
      'const q = "select aspects->\'orbis/task\' from e";\nconst k = `a\u0000b`;\n',
  });
  const r = byId(scan(dir), 'aspects-path');
  expect(r.hits.map((h) => `${h.path}:${h.line}`).sort()).toEqual([
    'apps/server/src/nul-early.ts:2',
    'apps/server/src/nul-late.ts:1',
  ]);
});

test('entity-meta ловит формы колонки сущности', () => {
  // Позитивный контроль к следующему тесту: без него «ничего не нашлось» нельзя отличить
  // от «маркер сломан и не находит ничего никогда».
  const dir = repo({
    'apps/server/src/a.ts': 'const v = entities.meta;\n',
    'apps/server/src/b.ts': 'const p = { meta: input.meta };\n',
    'apps/server/src/c.ts': 'const q = "entity_meta_gin";\n',
    'apps/server/src/d.ts': 'const e = { meta: {} };\n',
  });
  const r = byId(scan(dir), 'entity-meta');
  expect(r.files.slice().sort()).toEqual([
    'apps/server/src/a.ts',
    'apps/server/src/b.ts',
    'apps/server/src/c.ts',
    'apps/server/src/d.ts',
  ]);
});

test('entity-meta не считает import.meta, relations.meta и metadata', () => {
  const dir = repo({
    'apps/web/src/legit.ts': [
      'const here = import.meta.dir;',
      'const also = import.meta.main;',
      'const m = relations.meta;',
      'const one = relation.meta;',
      'const md = metadata;',
      '',
    ].join('\n'),
  });
  const r = byId(scan(dir), 'entity-meta');
  expect(r.hits).toEqual([]);
});

test('exclude вырезает форму, а не всю строку: соседнее нарушение остаётся видимым', () => {
  // Правило «строка со словом import.meta целиком не считается» ослепило бы гейт ровно там,
  // где законная и незаконная формы стоят рядом.
  const dir = repo({
    'apps/server/src/mixed.ts': 'const x = import.meta.dir + String(entities.meta);\n',
  });
  const r = byId(scan(dir), 'entity-meta');
  expect(r.hits.map((h) => h.line)).toEqual([1]);
});

test('aspect= сам по себе законен, неквалифицированное имя поля после него — нет', () => {
  const dir = repo({
    'apps/web/src/ok.ts': "const q = 'aspect=orbis/task';\n",
    'apps/web/src/bad.ts': 'const q = "{{query: aspect=orbis/task status=open}}";\n',
  });
  const r = byId(scan(dir), 'bare-field');
  expect(r.files).toEqual(['apps/web/src/bad.ts']);
});

test('pathspec отсекает миграции, снапшоты и файлы вне зоны поиска', () => {
  const dir = repo({
    'apps/server/src/db/migrations/0001_x.sql': "select aspects->'a';\n",
    'apps/web/src/x.snap': 'aspects->x\n',
    'docs/notes.md': 'aspects->x\n',
    'apps/server/src/real.ts': 'const q = "aspects->x";\n',
  });
  const r = byId(scan(dir), 'aspects-path');
  expect(r.files).toEqual(['apps/server/src/real.ts']);
});

test('allowlist снимает файл и печатает, сколько строк снял и почему', () => {
  const dir = repo({
    'scripts/check-legacy-form.ts': 'const q = "aspects->x";\nconst r = relation_type;\n',
    'apps/server/src/real.ts': 'const q = "aspects->x";\n',
  });
  const reports = scan(dir);
  expect(byId(reports, 'aspects-path').files).toEqual(['apps/server/src/real.ts']);
  expect(byId(reports, 'aspects-path').allowed.get('scripts/check-legacy-form.ts')).toBe(1);
  expect(byId(reports, 'relation-type').hits).toEqual([]);

  // В отчёте у записи стоит суммарное по маркерам число снятых строк: aspects-path + relation-type.
  const { out } = cli(dir);
  expect(out).toContain('scripts/check-legacy-form.ts — снято строк: 2 — сам гейт');
});

test('--gate: код 1 при совпадении вне allowlist', () => {
  const dir = repo({ 'apps/server/src/real.ts': 'const q = "aspects->x";\n' });
  expect(cli(dir).code).toBe(0); // режим отчёта не падает никогда
  const gate = cli(dir, '--gate');
  expect(gate.code).toBe(1);
  expect(gate.err).toContain('apps/server/src/real.ts:1');
});

test('--gate: код 0 на дереве без старой формы', () => {
  const dir = repo({ 'apps/server/src/ok.ts': 'export const ok = 1;\n' });
  const gate = cli(dir, '--gate');
  expect(gate.code).toBe(0);
  expect(gate.out).toContain('ok — совпадений старой формы нет');
});

test('неизвестный аргумент — код 2, а не молчаливый ноль', () => {
  const dir = repo({ 'apps/server/src/ok.ts': 'export const ok = 1;\n' });
  const r = cli(dir, '--fix');
  expect(r.code).toBe(2);
  expect(r.err).toContain('--fix');
});

test('имена маркеров — договор: на них ссылаются брифы задач среза', () => {
  expect(LEGACY_MARKERS.map((m) => m.id)).toEqual([
    'aspects-path',
    'aspects-legacy',
    'relation-type',
    'entity-meta',
    'due-alias',
    'bare-field',
    'rule-parser',
    'pseudo-aspect',
    'service-const',
    'prop-type-heur',
  ]);
});

test('у каждой записи allowlist есть непустая причина', () => {
  for (const e of ALLOWLIST) {
    expect(e.reason.trim().length).toBeGreaterThan(0);
  }
});
