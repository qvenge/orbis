import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { hasCacheDependency } from '../apps/web/src/lib/freshness/dependencies';

type Family = { kind: 'trpc' | 'custom'; name: string; line: number };

const trpcMethods = new Set([
  'useQuery',
  'useSuspenseQuery',
  'useInfiniteQuery',
  'useSuspenseInfiniteQuery',
  'queryOptions',
  'infiniteQueryOptions',
  'fetch',
  'prefetch',
  'ensureData',
  'fetchInfinite',
  'prefetchInfinite',
  'ensureInfiniteData',
  'getData',
  'setData',
  'getInfiniteData',
  'setInfiniteData',
  'invalidate',
  'cancel',
  'reset',
  'query',
]);
const rawKeyMethods = new Set([
  'setQueryData',
  'getQueryData',
  'getQueryState',
  'fetchQuery',
  'prefetchQuery',
  'ensureQueryData',
  'fetchInfiniteQuery',
  'prefetchInfiniteQuery',
  'ensureInfiniteQueryData',
  'setQueryDefaults',
  'getQueryDefaults',
]);

function segments(
  node: ts.Expression,
  aliasOf: (id: ts.Identifier, descend: (expr: ts.Expression) => string[]) => string[] | undefined,
  depth = 0,
): string[] {
  if (depth > 12) return ['<unresolved>'];
  const descend = (expr: ts.Expression) => segments(expr, aliasOf, depth + 1);
  if (ts.isPropertyAccessExpression(node)) return [...descend(node.expression), node.name.text];
  if (ts.isElementAccessExpression(node)) {
    return [
      ...descend(node.expression),
      ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : '<computed>',
    ];
  }
  if (!ts.isIdentifier(node)) return ['<receiver>'];
  return aliasOf(node, descend) ?? [node.text];
}

function cacheFamilies(source: ts.SourceFile, checker?: ts.TypeChecker): Family[] {
  const families: Family[] = [];
  const localDeclarations = new Map<string, ts.Declaration>();
  const collect = (n: ts.Node) => {
    if (
      (ts.isVariableDeclaration(n) || ts.isFunctionDeclaration(n)) &&
      n.name &&
      ts.isIdentifier(n.name)
    ) {
      localDeclarations.set(n.name.text, n);
    }
    ts.forEachChild(n, collect);
  };
  if (!checker) collect(source);

  const declarationOf = (id: ts.Identifier) => {
    let symbol = checker?.getSymbolAtLocation(id);
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      symbol = checker?.getAliasedSymbol(symbol);
    }
    return symbol?.valueDeclaration ?? localDeclarations.get(id.text);
  };

  function bindingSegments(
    binding: ts.BindingElement,
    descend: (expr: ts.Expression) => string[],
  ): string[] {
    const { parent, propertyName, name } = binding;
    if (!ts.isObjectBindingPattern(parent) || binding.dotDotDotToken) return ['<computed>'];
    const owner = parent.parent;
    const receiver = ts.isBindingElement(owner)
      ? bindingSegments(owner, descend)
      : owner.initializer
        ? descend(owner.initializer)
        : [];
    const key = propertyName ?? name;
    return [
      ...receiver,
      ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : '<computed>',
    ];
  }

  const aliasOf = (id: ts.Identifier, descend: (expr: ts.Expression) => string[]) => {
    const declaration = declarationOf(id);
    if (declaration && ts.isBindingElement(declaration)) {
      return bindingSegments(declaration, descend);
    }
    const value =
      declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
    return value &&
      (ts.isIdentifier(value) ||
        ts.isPropertyAccessExpression(value) ||
        ts.isElementAccessExpression(value))
      ? descend(value)
      : undefined;
  };

  function resolve(expr: ts.Expression | undefined, depth = 0): ts.Expression | undefined {
    if (!expr || depth > 12) return undefined;
    const next = (value: ts.Expression | undefined) => resolve(value, depth + 1);
    if (
      ts.isAsExpression(expr) ||
      ts.isSatisfiesExpression(expr) ||
      ts.isParenthesizedExpression(expr)
    ) {
      return next(expr.expression);
    }
    if (ts.isIdentifier(expr)) {
      const decl = ts.isShorthandPropertyAssignment(expr.parent)
        ? (checker?.getShorthandAssignmentValueSymbol(expr.parent)?.valueDeclaration ??
          localDeclarations.get(expr.text))
        : declarationOf(expr);
      if (decl && ts.isVariableDeclaration(decl)) return next(decl.initializer);
    }
    if (
      ts.isCallExpression(expr) &&
      ts.isIdentifier(expr.expression) &&
      expr.expression.text !== 'getQueryKey'
    ) {
      const decl = declarationOf(expr.expression);
      const fn = decl && ts.isVariableDeclaration(decl) ? decl.initializer : decl;
      if (
        fn &&
        (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn))
      ) {
        const body = fn.body;
        if (body && ts.isBlock(body)) {
          const returns = body.statements.filter(ts.isReturnStatement);
          return returns.length === 1 ? next(returns[0]?.expression) : undefined;
        }
        return next(body);
      }
    }
    return expr;
  }

  function add(kind: Family['kind'], name: string, at: ts.Node) {
    families.push({
      kind,
      name,
      line: source.getLineAndCharacterOfPosition(at.getStart(source)).line + 1,
    });
  }

  function inspectKey(expr: ts.Expression | undefined, at: ts.Node) {
    const key = resolve(expr);
    if (key && ts.isCallExpression(key) && key.expression.getText() === 'getQueryKey') {
      const route = key.arguments[0] && segments(key.arguments[0], aliasOf);
      add('trpc', route && route.length >= 2 ? route.slice(1).join('.') : '<unresolved>', at);
      return;
    }
    const first = key && ts.isArrayLiteralExpression(key) ? resolve(key.elements[0]) : undefined;
    add('custom', first && ts.isStringLiteralLike(first) ? first.text : '<unresolved>', at);
  }

  function walk(n: ts.Node, factoryRoot?: string) {
    if (
      ts.isPropertyAssignment(n) &&
      (ts.isIdentifier(n.name) || ts.isStringLiteralLike(n.name)) &&
      n.name.text === 'queryKey'
    ) {
      inspectKey(n.initializer, n);
    } else if (ts.isShorthandPropertyAssignment(n) && n.name.text === 'queryKey') {
      inspectKey(n.name, n);
    }
    if (ts.isCallExpression(n)) {
      const route = segments(n.expression, aliasOf);
      const root = route[0];
      const method = route.at(-1);
      if (method && rawKeyMethods.has(method)) inspectKey(n.arguments[0], n);
      if (method === 'getQueryKey') inspectKey(n, n);
      if ((method === 'useQueries' || method === 'useSuspenseQueries') && root === 'trpc') {
        const factory = n.arguments[0];
        if (factory && (ts.isArrowFunction(factory) || ts.isFunctionExpression(factory))) {
          const parameter = factory.parameters[0]?.name;
          if (parameter && ts.isIdentifier(parameter)) walk(factory.body, parameter.text);
          else add('trpc', '<unresolved factory>', n);
        } else {
          add('trpc', '<unresolved factory>', n);
        }
        return;
      }
      if (factoryRoot && root === factoryRoot) {
        add('trpc', route.length >= 2 ? route.slice(1).join('.') : '<unresolved factory>', n);
      } else if (method && (trpcMethods.has(method) || method === 'mutate')) {
        const knownRoot = root === 'trpc' || root === 'utils';
        const signature = knownRoot
          ? undefined
          : checker?.getResolvedSignature(n)?.declaration?.getSourceFile().fileName;
        const isTrpc = knownRoot || !!signature?.includes('/@trpc/');
        const namespaceStart = route[1] === 'client' || route[1] === 'current' ? 2 : 1;
        const path = route.slice(namespaceStart, -1).join('.');
        // Namespace-wide cache filters do not create a query key.
        const namespaceFilter =
          route.length - namespaceStart <= 2 &&
          (method === 'invalidate' || method === 'cancel' || method === 'reset');
        if (isTrpc && !namespaceFilter && (method !== 'mutate' || path === 'entity.blocks')) {
          add('trpc', path || '<unresolved>', n);
        }
      }
    }
    ts.forEachChild(n, (child) => walk(child, factoryRoot));
  }
  walk(source);
  return families;
}

function scan(source: string) {
  return cacheFamilies(ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true)).map(
    ({ kind, name }) => [kind, name],
  );
}

test('reports a new tRPC cache family from imperative fetch and a hook factory', () => {
  expect(
    scan(`
    const download = utils.user.exportData.fetch;
    download();
    trpc.useQueries((api) => [api.newFeature.read({})]);
  `),
  ).toEqual([
    ['trpc', 'user.exportData'],
    ['trpc', 'newFeature.read'],
  ]);
  expect(hasCacheDependency('user.exportData', 'trpc')).toBe(true);
  expect(hasCacheDependency('newFeature.read', 'trpc')).toBe(false);
});

test('finds custom key constants, factories and imperative writes', () => {
  expect(
    scan(`
    const PREFIX = 'chatThread';
    const makeKey = (id: string) => [PREFIX, id] as const;
    const key = makeKey(id);
    queryClient.setQueryData(key, data);
    const queryKey = ['new-prefix', id];
    useQuery({ queryKey, queryFn });
  `),
  ).toEqual([
    ['custom', 'chatThread'],
    ['custom', 'new-prefix'],
  ]);
  expect(hasCacheDependency('chatThread', 'custom')).toBe(true);
  expect(hasCacheDependency('new-prefix', 'custom')).toBe(false);
});

test('all production query cache keys have a dependency declaration', () => {
  const root = join(import.meta.dir, '..');
  const files = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', 'apps/web/src'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  )
    .split('\0')
    .filter(
      (file) =>
        /\.tsx?$/.test(file) && !/(?:\.test\.|\.spec\.|-fixtures\.|\/test\/|\.d\.ts$)/.test(file),
    )
    .map((file) => join(root, file))
    .filter(existsSync);
  const configPath = join(root, 'apps/web/tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const options = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    join(root, 'apps/web'),
  ).options;
  const program = ts.createProgram(files, options);
  const checker = program.getTypeChecker();
  const uncovered = files.flatMap((file) => {
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`No TypeScript source for ${file}`);
    return cacheFamilies(source, checker)
      .filter(({ kind, name }) => !hasCacheDependency(name, kind))
      .map(({ kind, name, line }) => `${relative(root, file)}:${line} ${kind} ${name}`);
  });
  expect(uncovered).toEqual([]);
}, 60_000);

test('typed destructuring and top-level procedure calls cannot hide undeclared families', () => {
  const root = join(import.meta.dir, '..');
  const file = join(root, 'apps/web/src/__cache_guard_mutants.ts');
  const mutants = `
    import { makeVanillaClient } from './trpc';
    import { QueryClient } from '@tanstack/react-query';
    const vanilla = makeVanillaClient(() => null);
    const { registry: { dependants: { query: readDependants } } } = vanilla;
    readDependants({ property: 'orbis/title' });
    vanilla.ping.query();
    const { setQueryData: put } = new QueryClient();
    put(['unregistered-mutant'], 'data');
  `;
  const config = ts.readConfigFile(join(root, 'apps/web/tsconfig.json'), ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    join(root, 'apps/web'),
  ).options;
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...args) =>
    name === file
      ? ts.createSourceFile(name, mutants, ts.ScriptTarget.Latest, true)
      : getSourceFile(name, ...args);
  const program = ts.createProgram([file], options, host);
  const source = program.getSourceFile(file);
  if (!source) throw new Error('TypeScript did not load the virtual mutants');
  expect(program.getSemanticDiagnostics(source)).toEqual([]);
  expect(
    cacheFamilies(source, program.getTypeChecker())
      .filter(({ name, kind }) => !hasCacheDependency(name, kind))
      .map(({ name, kind }) => [kind, name]),
  ).toEqual([
    ['trpc', 'registry.dependants'],
    ['trpc', 'ping'],
    ['custom', 'unregistered-mutant'],
  ]);
}, 60_000);
