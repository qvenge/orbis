import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { LAB_SELECTORS } from './scenario';

const root = resolve(import.meta.dir, '../..');
const scenario = ts.createSourceFile(
  'scenario.ts',
  readFileSync(resolve(root, 'scripts/lab/scenario.ts'), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);

/** Покрытие берётся из AST сценария, без комментариев и самого манифеста: новый селектор требует новой строки. */
function usedSignatures(): string[] {
  const found = new Set<string>();
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(scenario) === 'LAB_SELECTORS') return;
    if (ts.isStringLiteralLike(node) && /\[(?:data-testid|aria-label|role)=/.test(node.text))
      found.add(node.text);
    if (
      ts.isTemplateExpression(node) &&
      /\[(?:data-testid|aria-label|role)=/.test(node.head.text)
    ) {
      found.add(node.head.text + node.templateSpans.map((s) => '${*}' + s.literal.text).join(''));
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'getByRole'
    ) {
      const [role, options] = node.arguments;
      if (
        !role ||
        !ts.isStringLiteralLike(role) ||
        !options ||
        !ts.isObjectLiteralExpression(options)
      )
        throw new Error('Новая форма getByRole требует явного учёта');
      const name = options.properties.find(
        (p) => ts.isPropertyAssignment(p) && p.name.getText(scenario) === 'name',
      );
      if (!name || !ts.isPropertyAssignment(name) || !ts.isStringLiteralLike(name.initializer))
        throw new Error('Доступное имя лаборатории должно быть учтено');
      found.add(`role:${role.text};name:${name.initializer.text}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(scenario);
  return [...found].sort();
}

/** Не считаем комментарий, фикстуру или строку теста доказательством существования селектора. */
function productionSource(path: string): string {
  expect(path).not.toMatch(/(?:test|spec|fixture|golden|snapshot)/i);
  const src = readFileSync(resolve(root, path), 'utf8');
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.JSX, src);
  const removed: Array<[number, number]> = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    )
      removed.push([scanner.getTokenPos(), scanner.getTextPos()]);
  }
  let out = src;
  for (const [start, end] of removed.reverse())
    out = out.slice(0, start) + ' '.repeat(end - start) + out.slice(end);
  return out;
}

test('каждый селектор и доступное имя actual scenario учтены ровно один раз', () => {
  const listed: string[] = LAB_SELECTORS.map(([selector]) => selector);
  expect(new Set(listed).size).toBe(listed.length);
  expect([...listed].sort()).toEqual(usedSignatures());
});

for (const [selector, ...sources] of LAB_SELECTORS) {
  test(`лаборатория: ${selector} существует в производителе web`, () => {
    for (const [relative, ...needles] of sources) {
      const path = `apps/web/src/${relative}`;
      const src = productionSource(path);
      for (const needle of needles) {
        // Бриф требует git grep -F; точный файл производителя исключает чужие строки, а AST-лексер — комментарии.
        execFileSync('git', ['grep', '-F', '--', needle, path], { cwd: root, stdio: 'pipe' });
        expect(src, `${selector}: ${path} не производит ${needle}`).toContain(needle);
      }
    }
    if (selector === 'role:tab;name:Детали') {
      expect(productionSource('packages/shared/src/supply/etalons.ts')).toContain(
        "'{{tab: Детали}}'",
      );
    }
  });
}
