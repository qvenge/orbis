import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { LabSample } from './summary';

type PageFunction = (arg?: unknown) => unknown;

const source = readFileSync(new URL('./scenario.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('scenario.ts', source, ts.ScriptTarget.Latest, true);
const functions = new Set(['capture', 'clickAt', 'createdIdOf', 'responseEnd']);
const parts = ast.statements.filter(
  (n) =>
    (ts.isFunctionDeclaration(n) && n.name && functions.has(n.name.text)) ||
    (ts.isVariableStatement(n) &&
      n.declarationList.declarations.some((d) => d.name.getText(ast) === 'mark')),
);
if (parts.length !== 5) throw new Error('Не найдены actual capture и его зависимости');
const compiled = ts.transpileModule(parts.map((n) => n.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const capture = new Function(`${compiled}\nreturn capture;`)() as (
  page: unknown,
  title: string,
  repeat: number,
  samples: LabSample[],
  kind: 'create' | 'subtask',
  register: (id: string) => void,
) => Promise<string>;

// Реальные capture/clickAt/responseEnd/mark; подменена только граница браузера.
// Серверный контракт QuickCapture: один entity.create, link входит в тот же запрос.
async function fixture(kind: 'create' | 'subtask', resourceAvailable = true) {
  const id = '01a15fd5-a821-7279-b433-7e9c33c4af26';
  const input = { value: '' };
  let now = 100;
  let sent: (() => void) | undefined;
  const request = {
    url: () => 'https://example.test/trpc/entity.create?batch=1',
    postDataJSON: () => ({
      '0': {
        input: { id, title: 'Лаб-запись' },
        source: 'quick_capture',
        ...(kind === 'subtask' ? { link: { parentId: 'parent', role: 'subitem' } } : {}),
      },
    }),
  };
  const document = {
    querySelector: (selector: string) =>
      selector.includes('button')
        ? {
            click: () => {
              input.value = '';
              now = 366;
              sent?.();
            },
          }
        : input,
  };
  const performance = {
    now: () => now,
    getEntriesByType: () =>
      resourceAvailable ? [{ name: request.url(), startTime: 110, responseEnd: 350 }] : [],
  };
  // Playwright сериализует функцию в страницу: выполняем её в отдельном DOM/clock-контексте.
  const evaluate = (fn: PageFunction, arg?: unknown) =>
    new Function('document', 'performance', 'arg', `return (${fn.toString()})(arg);`)(
      document,
      performance,
      arg,
    );
  const page = {
    click: async () => {},
    fill: async (_: string, text: string) => {
      input.value = text;
    },
    waitForRequest: (matches: (req: typeof request) => boolean) =>
      new Promise((resolve) => {
        sent = () => {
          if (matches(request)) resolve(request);
        };
      }),
    evaluate,
    waitForFunction: async (fn: PageFunction, arg?: unknown) => {
      const value = evaluate(fn, arg);
      if (!value) throw new Error('Условие не наступило: fixture timeout');
      return { jsonValue: async () => value };
    },
  };
  const samples: LabSample[] = [];
  const registered: string[] = [];
  const result = await capture(page, 'Лаб-запись', 1, samples, kind, (v) => registered.push(v));
  return { result, registered, samples };
}

describe('actual лаборатория: подтверждение атомарного создания', () => {
  for (const kind of ['create', 'subtask'] as const) {
    test(`${kind}: считает конец entity.create, отдельного relation.create нет`, async () => {
      const r = await fixture(kind);
      expect(r.result).toBe('01a15fd5-a821-7279-b433-7e9c33c4af26');
      expect(r.registered).toEqual([r.result]);
      expect(r.samples).toEqual([
        { metric: 'action_confirmed', kind, durMs: 250, repeat: 1 },
        { metric: 'action_visible', kind, durMs: 266, repeat: 1 },
      ]);
    });
  }
  test('нет Resource Timing — не выдумывает нулевое подтверждение', async () => {
    const r = await fixture('subtask', false);
    expect(Number.isNaN(r.samples[0]?.durMs)).toBe(true);
    expect(r.samples[1]?.durMs).toBe(266);
  });
});
