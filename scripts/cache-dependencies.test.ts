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
  'setQueryDefaults',
  'getQueryDefaults',
]);
const rawOptionsMethods = new Set([
  'fetchQuery',
  'prefetchQuery',
  'ensureQueryData',
  'fetchInfiniteQuery',
  'prefetchInfiniteQuery',
  'ensureInfiniteQueryData',
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

  const inspectedKeys = new Set<ts.Node>();
  function inspectKey(expr: ts.Expression | undefined, at: ts.Node) {
    if (inspectedKeys.has(at)) return;
    inspectedKeys.add(at);
    const key = resolve(expr);
    if (key && ts.isCallExpression(key) && key.expression.getText() === 'getQueryKey') {
      const route = key.arguments[0] && segments(key.arguments[0], aliasOf);
      add('trpc', route && route.length >= 2 ? route.slice(1).join('.') : '<unresolved>', at);
      return;
    }
    const first = key && ts.isArrayLiteralExpression(key) ? resolve(key.elements[0]) : undefined;
    add('custom', first && ts.isStringLiteralLike(first) ? first.text : '<unresolved>', at);
  }

  function constantLocal(decl: ts.Declaration | undefined): decl is ts.VariableDeclaration {
    return (
      decl !== undefined &&
      ts.isVariableDeclaration(decl) &&
      ts.isIdentifier(decl.name) &&
      ts.isVariableDeclarationList(decl.parent) &&
      (decl.parent.flags & ts.NodeFlags.Const) !== 0 &&
      decl.getSourceFile() === source &&
      (!ts.isVariableStatement(decl.parent.parent) ||
        !decl.parent.parent.modifiers?.some((node) => node.kind === ts.SyntaxKind.ExportKeyword))
    );
  }

  function transparentExpression(
    node: ts.Node,
  ): node is
    | ts.AsExpression
    | ts.SatisfiesExpression
    | ts.ParenthesizedExpression
    | ts.NonNullExpression
    | ts.TypeAssertion {
    return (
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isTypeAssertionExpression(node)
    );
  }

  const valueDeclarationOf = (id: ts.Identifier) =>
    ts.isShorthandPropertyAssignment(id.parent)
      ? checker?.getShorthandAssignmentValueSymbol(id.parent)?.valueDeclaration
      : declarationOf(id);

  type TrackedBinding = ts.VariableDeclaration | ts.ParameterDeclaration;
  let valueReferences: Map<TrackedBinding, ts.Identifier[]> | undefined;
  function referencesTo(declaration: TrackedBinding) {
    if (!valueReferences) {
      const refs = new Map<TrackedBinding, ts.Identifier[]>();
      const visit = (node: ts.Node) => {
        if (ts.isIdentifier(node)) {
          const decl = valueDeclarationOf(node);
          if ((constantLocal(decl) || (decl && ts.isParameter(decl))) && decl.name !== node) {
            const entries = refs.get(decl) ?? [];
            entries.push(node);
            refs.set(decl, entries);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      valueReferences = refs;
    }
    return valueReferences.get(declaration) ?? [];
  }

  function signatureFile(call: ts.CallExpression) {
    return checker?.getResolvedSignature(call)?.declaration?.getSourceFile().fileName;
  }

  function localFunction(callee: ts.Expression) {
    if (!ts.isIdentifier(callee)) return;
    const decl = declarationOf(callee);
    if (!decl || decl.getSourceFile() !== source) return;
    if (ts.isFunctionDeclaration(decl) && decl.body) return decl;
    if (constantLocal(decl) && decl.initializer && ts.isArrowFunction(decl.initializer))
      return decl.initializer;
  }

  type ValueKind = 'options' | 'key';
  function stableBinding(decl: TrackedBinding, kind: ValueKind, depth: number): boolean {
    return (
      !!checker && depth <= 16 && referencesTo(decl).every((id) => stableUse(id, kind, depth + 1))
    );
  }

  function stableUse(node: ts.Expression, kind: ValueKind, depth: number): boolean {
    let use = node;
    while (transparentExpression(use.parent) && use.parent.expression === use) use = use.parent;
    const parent = use.parent;
    if (ts.isVariableDeclaration(parent) && parent.initializer === use)
      return constantLocal(parent) && stableBinding(parent, kind, depth);
    if (
      kind === 'key' &&
      ((ts.isPropertyAssignment(parent) && parent.initializer === use) ||
        (ts.isShorthandPropertyAssignment(parent) && parent.name === use)) &&
      (ts.isIdentifier(parent.name) || ts.isStringLiteralLike(parent.name)) &&
      parent.name.text === 'queryKey' &&
      ts.isObjectLiteralExpression(parent.parent)
    )
      return stableUse(parent.parent, 'options', depth + 1);
    // Member accesses, stores and opaque calls can mutate or escape an alias.
    if (!ts.isCallExpression(parent)) return false;
    const index = parent.arguments.indexOf(use);
    if (index < 0) return false;
    if (index === 0 && signatureFile(parent)?.includes('/@tanstack/')) {
      const method = segments(parent.expression, aliasOf).at(-1) ?? '';
      if (kind === 'options') return rawOptionsMethods.has(method) || method === 'find';
      if (method === 'hashKey' || method === 'getQueryDefaults') return true;
    }
    // A preceding spread can move the key to a different parameter.
    if (parent.arguments.slice(0, index).some(ts.isSpreadElement)) return false;
    const helper = kind === 'key' ? localFunction(parent.expression) : undefined;
    // Arrows have no own arguments object that could alias a parameter.
    const parameter = helper && ts.isArrowFunction(helper) ? helper.parameters[index] : undefined;
    return (
      parameter !== undefined &&
      ts.isIdentifier(parameter.name) &&
      parameter.dotDotDotToken === undefined &&
      stableBinding(parameter, kind, depth)
    );
  }

  function resolveOptions(
    expr: ts.Expression | undefined,
    depth = 0,
  ): ts.ObjectLiteralExpression | undefined {
    if (!expr || depth > 12) return undefined;
    if (transparentExpression(expr)) return resolveOptions(expr.expression, depth + 1);
    if (ts.isObjectLiteralExpression(expr)) return expr;
    if (!ts.isIdentifier(expr)) return undefined;
    const decl = declarationOf(expr);
    if (constantLocal(decl) && stableBinding(decl, 'options', depth))
      return resolveOptions(decl.initializer, depth + 1);
  }

  function fixedFamily(expr: ts.Expression | undefined, depth: number): boolean {
    if (!expr || depth > 16) return false;
    if (transparentExpression(expr)) return fixedFamily(expr.expression, depth + 1);
    if (ts.isStringLiteralLike(expr)) return true;
    const decl = ts.isIdentifier(expr) ? valueDeclarationOf(expr) : undefined;
    return constantLocal(decl) && fixedFamily(decl.initializer, depth + 1);
  }

  function fixedProcedure(expr: ts.Expression | undefined, depth: number): boolean {
    if (!expr || depth > 16) return false;
    if (ts.isPropertyAccessExpression(expr)) return fixedProcedure(expr.expression, depth + 1);
    if (ts.isElementAccessExpression(expr) && ts.isStringLiteralLike(expr.argumentExpression))
      return fixedProcedure(expr.expression, depth + 1);
    if (!ts.isIdentifier(expr)) return false;
    const decl = valueDeclarationOf(expr);
    if (!decl || !ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name)) return false;
    if (
      decl.name.text === 'trpc' &&
      decl.getSourceFile().fileName.endsWith('/apps/web/src/trpc.ts')
    )
      return true;
    return constantLocal(decl) && fixedProcedure(decl.initializer, depth + 1);
  }

  function fixedOptionsKey(expr: ts.Expression | undefined, depth = 0, fresh = false): boolean {
    if (!expr || depth > 16) return false;
    if (transparentExpression(expr)) return fixedOptionsKey(expr.expression, depth + 1, fresh);
    if (ts.isArrayLiteralExpression(expr)) return fixedFamily(expr.elements[0], depth + 1);
    if (ts.isIdentifier(expr) && !fresh) {
      const decl = valueDeclarationOf(expr);
      return (
        constantLocal(decl) &&
        stableBinding(decl, 'key', depth) &&
        fixedOptionsKey(decl.initializer, depth + 1)
      );
    }
    if (!ts.isCallExpression(expr)) return false;
    if (expr.expression.getText() === 'getQueryKey' && signatureFile(expr)?.includes('/@trpc/'))
      return fixedProcedure(expr.arguments[0], depth + 1);
    const body = localFunction(expr.expression)?.body;
    // A factory must allocate a new key. Returning an existing binding exposes
    // aliases outside this call, even when the factory itself is constant.
    if (!body) return false;
    if (!ts.isBlock(body)) return fixedOptionsKey(body, depth + 1, true);
    const [returned] = body.statements;
    return (
      body.statements.length === 1 &&
      returned !== undefined &&
      ts.isReturnStatement(returned) &&
      fixedOptionsKey(returned.expression, depth + 1, true)
    );
  }

  function inspectOptions(expr: ts.Expression | undefined, call: ts.CallExpression) {
    const options = resolveOptions(expr);
    if (options) {
      // The last explicit key wins. An unknown later spread or computed property
      // could replace it, so we cannot accept the earlier declaration.
      for (const member of [...options.properties].reverse()) {
        if (
          ts.isSpreadAssignment(member) ||
          (member.name && ts.isComputedPropertyName(member.name))
        )
          break;
        if (
          member.name &&
          (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name)) &&
          member.name.text === 'queryKey'
        ) {
          const key = ts.isPropertyAssignment(member)
            ? member.initializer
            : ts.isShorthandPropertyAssignment(member)
              ? member.name
              : undefined;
          if (fixedOptionsKey(key)) inspectKey(key, member);
          else if (inspectedKeys.has(member)) add('custom', '<unresolved>', call);
          else inspectKey(undefined, member);
          return;
        }
      }
    }
    inspectKey(undefined, call);
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
      if (method && rawOptionsMethods.has(method)) inspectOptions(n.arguments[0], n);
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
    import { makeVanillaClient, trpc } from './trpc';
    import { type FetchQueryOptions, hashKey, QueryClient } from '@tanstack/react-query';
    import { getQueryKey } from '@trpc/react-query';
    const vanilla = makeVanillaClient(() => null);
    const { registry: { dependants: { query: readDependants } } } = vanilla;
    readDependants({ property: 'orbis/title' });
    vanilla.ping.query();
    const { setQueryData: put } = new QueryClient();
    put(['unregistered-mutant'], 'data');

    const client = new QueryClient();
    const options = { queryKey: ['chatThread', 'thread'], queryFn: async () => [] };
    const { fetchQuery: fetch } = client;
    const fixedAlias = options;
    void fetch(fixedAlias);
    void client.prefetchQuery({ queryKey: ['registry'], queryFn: async () => [] });
    void client.ensureInfiniteQueryData({
      queryKey: ['chatThread', 'thread'],
      queryFn: async () => [],
      initialPageParam: undefined,
      getNextPageParam: () => undefined,
    });

    declare const unknown: FetchQueryOptions<string>;
    void client.fetchQuery(unknown);
    let currentOptions: FetchQueryOptions<string> = { queryKey: ['registry'] };
    currentOptions = unknown;
    void client.fetchQuery(currentOptions);
    const reassigned = currentOptions;
    void client.ensureQueryData(reassigned);
    const mutableOptions: FetchQueryOptions<string> = { queryKey: ['registry'] };
    const mutableAlias = mutableOptions;
    mutableAlias.queryKey = unknown.queryKey;
    void client.fetchQuery(mutableOptions);
    const escaped: FetchQueryOptions<string> = { queryKey: ['registry'] };
    declare function changeOptions(value: FetchQueryOptions<string>): void;
    changeOptions(escaped);
    void client.prefetchQuery(escaped);
    void client.fetchQuery({ ...unknown, queryKey: ['registry'] });
    declare const maybeOverride: Partial<FetchQueryOptions<string>>;
    void client.prefetchQuery({
      queryKey: ['registry'],
      ...maybeOverride,
    });
    void client.ensureQueryData({ queryKey: ['unknown-options-family'], queryFn: async () => [] });

    declare const runtimeFamily: string;
    const mutableKey = ['registry'];
    const stableOptions = { queryKey: mutableKey, queryFn: async () => [] };
    const keyAlias = mutableKey;
    keyAlias[0] = runtimeFamily;
    void client.fetchQuery(stableOptions);

    const escapedKey = ['registry'];
    declare function takeKey(key: string[]): void;
    takeKey(escapedKey);
    void client.prefetchQuery({ queryKey: escapedKey });

    const helperKey = ['registry'];
    const rewriteKey = (value: string[]) => { value[0] = runtimeFamily; };
    rewriteKey(helperKey);
    void client.fetchQuery({ queryKey: helperKey });

    const argumentsKey = ['registry'];
    function rewriteArguments(_key: string[]) { arguments[0][0] = runtimeFamily; }
    rewriteArguments(argumentsKey);
    void client.fetchQuery({ queryKey: argumentsKey });

    let mutableFamily = 'registry';
    mutableFamily = runtimeFamily;
    void client.ensureQueryData({ queryKey: [mutableFamily] });

    const sharedKey = ['registry'];
    const returnSharedKey = () => sharedKey;
    sharedKey[0] = runtimeFamily;
    void client.prefetchQuery({ queryKey: returnSharedKey() });

    const routeKey = getQueryKey(trpc.entity.get, undefined, 'query');
    const namespaceAlias = routeKey[0] as string[];
    namespaceAlias[0] = runtimeFamily;
    void client.fetchQuery({ queryKey: routeKey });

    const fixedFamily = 'registry';
    const fixedKey = [fixedFamily] as const;
    const keyCopy = fixedKey;
    const knownOptions = { queryKey: keyCopy };
    void client.fetchQuery(knownOptions);
    const readOnlyKey = (key: readonly string[]) => hashKey(key);
    readOnlyKey(fixedKey);
    const freshKey = () => ['registry'] as const;
    void client.fetchQuery({ ...unknown, queryKey: freshKey() });
    void client.fetchQuery({ queryKey: getQueryKey(trpc.entity.get, undefined, 'query') });

    const spreadAlias = ['registry'];
    const mutateWithPrefix = (_first: number, _second: number, key: string[]) => {
      key[0] = runtimeFamily;
    };
    mutateWithPrefix(...[1, 2] as const, spreadAlias);
    void client.fetchQuery({ queryKey: spreadAlias });

    const trailingSpreadKey = ['registry'] as const;
    const readWithSuffix = (key: readonly string[], _first: number, _second: number) => hashKey(key);
    readWithSuffix(trailingSpreadKey, ...[1, 2] as const);
    void client.fetchQuery({ queryKey: trailingSpreadKey });
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
  const uncovered = cacheFamilies(source, program.getTypeChecker()).filter(
    ({ name, kind }) => !hasCacheDependency(name, kind),
  );
  const lines = mutants.split('\n');
  const optionsKeyProbe =
    lines.findIndex((line) => line.includes('declare const runtimeFamily')) + 1;
  expect(
    uncovered.filter(({ line }) => line < optionsKeyProbe).map(({ name, kind }) => [kind, name]),
  ).toEqual([
    ['trpc', 'registry.dependants'],
    ['trpc', 'ping'],
    ['custom', 'unregistered-mutant'],
    ['custom', '<unresolved>'],
    ['custom', '<unresolved>'],
    ['custom', '<unresolved>'],
    ['custom', '<unresolved>'],
    ['custom', '<unresolved>'],
    ['custom', '<unresolved>'],
    ['custom', 'unknown-options-family'],
  ]);
  expect(
    uncovered
      .filter(({ line }) => line > optionsKeyProbe)
      .map(({ name, line }) => [lines[line - 1]?.trim(), name]),
  ).toEqual([
    ['void client.fetchQuery(stableOptions);', '<unresolved>'],
    ['void client.prefetchQuery({ queryKey: escapedKey });', '<unresolved>'],
    ['void client.fetchQuery({ queryKey: helperKey });', '<unresolved>'],
    ['void client.fetchQuery({ queryKey: argumentsKey });', '<unresolved>'],
    ['void client.ensureQueryData({ queryKey: [mutableFamily] });', '<unresolved>'],
    ['void client.prefetchQuery({ queryKey: returnSharedKey() });', '<unresolved>'],
    ['void client.fetchQuery({ queryKey: routeKey });', '<unresolved>'],
    ['void client.fetchQuery({ queryKey: spreadAlias });', '<unresolved>'],
  ]);
}, 60_000);
