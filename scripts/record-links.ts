import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { parseAddress } from '../packages/shared/src/nav/address';

type Site = { file: string; functionName: string; target: string };
type Violation = Site & { line: number };
const root = join(import.meta.dir, '..');
const webConfig = join(root, 'apps/web/tsconfig.json');
const navigation = 'apps/web/src/state/navigation.ts';
const navMembers = new Set([
  'openRecord',
  'openPendingCreate',
  'confirmPendingCreate',
  'openAddress',
  'openSection',
  'replacePlace',
  'setNavState',
]);
const recordAdapters = new Map([
  ['apps/web/src/app/useOpenRecord.ts', 'useOpenRecord'],
  ['apps/web/src/lib/entity-ref/record-link-controller.ts', 'useRecordLinkController'],
]);
const browserMethods = new Set(['open', 'assign', 'replace', 'pushState', 'replaceState']);
const sampleId = '018cd857-511b-7f25-870e-377777ceca00';

function fileOf(node: ts.Node): string {
  return relative(root, node.getSourceFile().fileName);
}

function propertyName(node: ts.Node | undefined): string | undefined {
  return node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) ? node.text : undefined;
}

function accessName(node: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
    return node.argumentExpression.text;
  return ts.isIdentifier(node) ? node.text : undefined;
}

function functionOf(node: ts.Node): string {
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    const own = propertyName(current.name);
    if (own) return own;
    if (ts.isVariableDeclaration(current.parent)) return propertyName(current.parent.name) ?? '';
  }
  return '';
}

function sourceProgram(paths: readonly string[], overlays: Readonly<Record<string, string>>) {
  const parseHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic: ts.Diagnostic) {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  };
  const config = ts.getParsedCommandLineOfConfigFile(webConfig, {}, parseHost);
  if (!config || config.errors.length)
    throw new Error('Cannot read web tsconfig for record-link guard');
  const overlay = new Map(
    Object.entries(overlays).map(([path, source]) => [resolve(root, path), source]),
  );
  const host = ts.createCompilerHost(config.options, true);
  const getSourceFile = host.getSourceFile.bind(host);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = (file) => overlay.get(file) ?? readFile(file);
  host.fileExists = (file) => overlay.has(file) || fileExists(file);
  host.getSourceFile = (file, languageVersion, onError, fresh) => {
    const source = overlay.get(file);
    return source === undefined
      ? getSourceFile(file, languageVersion, onError, fresh)
      : ts.createSourceFile(file, source, languageVersion, true);
  };
  return ts.createProgram({
    rootNames: [...new Set([...paths.map((path) => resolve(root, path)), join(root, navigation)])],
    options: config.options,
    host,
  });
}

function scanner(checker: ts.TypeChecker) {
  function symbol(node: ts.Node): ts.Symbol | undefined {
    let result = ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node);
    if (result && (result.flags & ts.SymbolFlags.Alias) !== 0)
      result = checker.getAliasedSymbol(result);
    return result;
  }

  function member(node: ts.Expression): ts.Symbol | undefined {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const key = ts.isElementAccessExpression(node)
        ? checker.getTypeAtLocation(node.argumentExpression)
        : undefined;
      const name = accessName(node) ?? (key?.isStringLiteral() ? key.value : undefined);
      return name
        ? checker.getPropertyOfType(checker.getTypeAtLocation(node.expression), name)
        : undefined;
    }
    return symbol(node);
  }

  function declaredIn(binding: ts.Symbol | undefined, file: string, name?: string): boolean {
    return (
      binding?.declarations?.some(
        (declaration) => fileOf(declaration) === file && (!name || binding.name === name),
      ) ?? false
    );
  }

  function isBrowser(binding: ts.Symbol | undefined): boolean {
    return (
      binding?.declarations?.some((declaration) =>
        declaration.getSourceFile().fileName.endsWith('/lib.dom.d.ts'),
      ) ?? false
    );
  }

  function resolved(node: ts.Expression, seen = new Set<ts.Symbol>()): ts.Expression {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node)
    )
      return resolved(node.expression, seen);
    if (ts.isIdentifier(node)) {
      const binding = symbol(node);
      const declaration = binding?.valueDeclaration;
      if (
        binding &&
        !seen.has(binding) &&
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        ts.isVariableDeclarationList(declaration.parent) &&
        (declaration.parent.flags & ts.NodeFlags.Const) !== 0
      ) {
        seen.add(binding);
        return resolved(declaration.initializer, seen);
      }
    }
    return node;
  }

  function field(node: ts.Expression, name: string): ts.Expression | undefined {
    const object = resolved(node);
    if (!ts.isObjectLiteralExpression(object)) return undefined;
    for (const prop of object.properties) {
      if (ts.isPropertyAssignment(prop) && propertyName(prop.name) === name)
        return prop.initializer;
      if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === name) return prop.name;
    }
  }

  function discriminant(node: ts.Expression, name: string): string | undefined {
    const value = field(node, name);
    if (value) {
      const expression = resolved(value);
      if (ts.isStringLiteralLike(expression)) return expression.text;
    }
    const objectType = checker.getTypeAtLocation(node);
    const property = checker.getPropertyOfType(objectType, name);
    const type = property && checker.getTypeOfSymbolAtLocation(property, node);
    return type?.isStringLiteral() ? type.value : undefined;
  }

  function recordAddress(node: ts.Expression | undefined): boolean {
    // A generic Address can hold a record. Require it to be explicitly narrowed.
    if (!node) return false;
    const kind = discriminant(node, 'kind');
    if (kind !== undefined) return kind === 'record';
    const type = checker.getTypeAtLocation(node);
    return (type.isUnion() ? type.types : [type]).some((part) => {
      const kind = checker.getPropertyOfType(part, 'kind');
      const value = kind && checker.getTypeOfSymbolAtLocation(kind, node);
      return value?.isStringLiteral() && value.value === 'record';
    });
  }

  const browserOrigin = 'https://record-link.invalid';
  function constructedURL(node: ts.Expression, depth: number): URL | undefined {
    const expression = resolved(node);
    if (!ts.isNewExpression(expression)) return;
    const urlType = member(resolved(expression.expression));
    if (urlType?.name !== 'URL' || !isBrowser(urlType)) return;
    const [target, base] = expression.arguments ?? [];
    if (!target) return;
    const text = routeText(target, depth + 1);
    const root = base && routeText(base, depth + 1);
    if (text === undefined || (base && root === undefined)) return;
    try {
      return new URL(text, root || browserOrigin);
    } catch {
      return undefined;
    }
  }

  function routeText(node: ts.Expression, depth = 0): string | undefined {
    if (depth > 12) return undefined;
    const expression = resolved(node);
    if (ts.isStringLiteralLike(expression)) return expression.text;
    if (ts.isNewExpression(expression)) return constructedURL(expression, depth)?.href;
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const property = member(expression);
      if (isBrowser(property) && (property?.name === 'href' || property?.name === 'pathname')) {
        const url = constructedURL(expression.expression, depth);
        if (url) return property.name === 'href' ? url.href : url.pathname;
      }
      const receiver = member(resolved(expression.expression));
      if (
        property?.name === 'baseURI' &&
        isBrowser(property) &&
        receiver?.name === 'document' &&
        isBrowser(receiver)
      )
        return `${browserOrigin}/`;
      const location = member(expression.expression);
      if (
        property?.name === 'origin' &&
        location?.name === 'location' &&
        isBrowser(property) &&
        isBrowser(location)
      )
        return '';
    }
    if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
      const method = member(expression.expression);
      if (isBrowser(method) && (method?.name === 'toString' || method?.name === 'toJSON'))
        return constructedURL(expression.expression.expression, depth)?.href;
    }
    if (ts.isTemplateExpression(expression))
      return (
        expression.head.text +
        expression.templateSpans
          .map(
            ({ expression: part, literal }) =>
              (routeText(part, depth + 1) ?? sampleId) + literal.text,
          )
          .join('')
      );
    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = routeText(expression.left, depth + 1);
      return left === undefined
        ? undefined
        : left + (routeText(expression.right, depth + 1) ?? sampleId);
    }
  }

  function recordHref(node: ts.Expression | undefined): boolean {
    if (!node) return false;
    const expression = resolved(node);
    if (
      ts.isCallExpression(expression) &&
      declaredIn(
        member(resolved(expression.expression)),
        'packages/shared/src/nav/address.ts',
        'buildAddress',
      )
    )
      return recordAddress(expression.arguments[0]);
    const text = routeText(expression);
    if (text === undefined) return false;
    try {
      const url = new URL(text, browserOrigin);
      return (
        url.origin === browserOrigin && parseAddress(url.pathname + url.search)?.kind === 'record'
      );
    } catch {
      return false;
    }
  }

  function navTarget(binding: ts.Symbol | undefined, call?: ts.CallExpression): string | undefined {
    if (!binding || !navMembers.has(binding.name) || !declaredIn(binding, navigation)) return;
    if (
      (binding.name === 'openAddress' || binding.name === 'replacePlace') &&
      call &&
      !recordAddress(call.arguments[0])
    )
      return;
    return binding.name;
  }

  function reference(node: ts.Expression): string | undefined {
    const binding = member(node);
    const parent = node.parent;
    const call = ts.isCallExpression(parent) && parent.expression === node ? parent : undefined;
    const target = navTarget(binding, call);
    if (target) return target;
    for (const [file, name] of recordAdapters) {
      if (declaredIn(binding, file, name)) return name;
    }
    if (!call) return;
    const expression = resolved(node);
    const callee = member(expression);
    if (declaredIn(callee, navigation, 'setNavState')) return 'setNavState';
    if (accessName(expression) === 'setState' && ts.isPropertyAccessExpression(expression)) {
      const store = checker.getTypeAtLocation(expression.expression);
      const get = checker.getPropertyOfType(store, 'getState');
      const state =
        get &&
        checker.getTypeOfSymbolAtLocation(get, expression).getCallSignatures()[0]?.getReturnType();
      if (
        state &&
        navTarget(checker.getPropertyOfType(state, 'openRecord')) &&
        call.arguments[0] &&
        field(call.arguments[0], 'model')
      )
        return 'setState';
    }
    if (callee?.name === 'setAttribute' && isBrowser(callee)) {
      const [attribute, value] = call.arguments;
      if (attribute && routeText(attribute) === 'href' && recordHref(value)) return 'href';
    }
    if (declaredIn(callee, 'packages/shared/src/nav/history-model.ts', 'navReduce')) {
      const action = call.arguments[1];
      const address = action && field(action, 'address');
      if (recordAddress(address)) return 'navReduce';
    }
    if (callee && browserMethods.has(callee.name) && isBrowser(callee)) {
      const url = callee.name.endsWith('State') ? call.arguments[2] : call.arguments[0];
      if (recordHref(url)) return callee.name;
    }
    if (
      callee?.name === 'createElement' &&
      callee.declarations?.some((declaration) =>
        declaration.getSourceFile().fileName.endsWith('/@types/react/index.d.ts'),
      )
    ) {
      const [tag, props] = call.arguments;
      if (
        tag &&
        ts.isStringLiteralLike(tag) &&
        tag.text === 'a' &&
        props &&
        recordHref(field(props, 'href'))
      )
        return 'href';
    }
  }

  function match(node: ts.Node): string | undefined {
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const declaration = node.parent.parent;
      const name = propertyName(node.propertyName ?? node.name);
      const receiver = ts.isVariableDeclaration(declaration)
        ? declaration.initializer
        : node.parent;
      const binding =
        name && receiver
          ? checker.getPropertyOfType(checker.getTypeAtLocation(receiver), name)
          : undefined;
      return navTarget(binding);
    }
    if (ts.isJsxAttribute(node) || ts.isJsxSpreadAttribute(node)) {
      const tag = node.parent.parent;
      if (propertyName(tag.tagName) !== 'a') return;
      if (ts.isJsxSpreadAttribute(node))
        return recordHref(field(node.expression, 'href')) ? 'href' : undefined;
      const value = node.initializer;
      if (
        propertyName(node.name) === 'href' &&
        value &&
        recordHref(ts.isJsxExpression(value) ? value.expression : (value as ts.Expression))
      )
        return 'href';
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const binding = member(node.left);
      if (
        (binding?.name === 'href' || binding?.name === 'location') &&
        isBrowser(binding) &&
        recordHref(node.right)
      )
        return binding.name;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      return reference(node);
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      if (
        (ts.isCallExpression(parent) && parent.expression === node) ||
        (ts.isVariableDeclaration(parent) && parent.initializer === node)
      )
        return reference(node);
    }
  }

  return match;
}

/** A compiler-backed scan of explicit production paths. Overlays run the same scanner for mutations. */
export function scanRecordLinks(
  paths: readonly string[],
  overlays: Readonly<Record<string, string>> = {},
  adapters: readonly Site[] = [],
): Violation[] {
  if (!paths.length) throw new Error('Record-link guard has no source files');
  const program = sourceProgram(paths, overlays);
  const checker = program.getTypeChecker();
  const match = scanner(checker);
  const violations: Violation[] = [];
  for (const file of paths) {
    const source = program.getSourceFile(resolve(root, file));
    if (!source) throw new Error(`Record-link guard could not load ${file}`);
    const errors = [
      ...program.getSyntacticDiagnostics(source),
      ...(Object.hasOwn(overlays, file) ? program.getSemanticDiagnostics(source) : []),
    ];
    const [error] = errors;
    if (error)
      throw new Error(`${file}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`);
    const visit = (node: ts.Node): void => {
      const target = match(node);
      if (target) {
        const functionName = functionOf(node);
        if (
          !adapters.some(
            (site) =>
              site.file === file && site.functionName === functionName && site.target === target,
          )
        ) {
          violations.push({
            file,
            functionName,
            target,
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return violations;
}

export function productionRecordLinkSources(): string[] {
  return Array.from(
    new Bun.Glob('**/*.{ts,tsx}').scanSync({
      cwd: join(root, 'apps/web/src'),
      onlyFiles: true,
    }),
  )
    .filter(
      (file) =>
        !file.startsWith('test/') &&
        file !== 'features/entity-detail/structure-fixtures.ts' &&
        !/\.(test|spec|d)\.[^.]+$/.test(file),
    )
    .map((file) => `apps/web/src/${file}`)
    .sort();
}

function webSite(file: string, functionName: string, target: string): Site {
  return { file: `apps/web/src/${file}`, functionName, target };
}

/** Imperative consumers that cannot render an anchor and the underlying navigation machinery. */
export const recordLinkAdapters = [
  ...(
    [
      ['app/useOpenRecord.ts', 'useOpenRecord'],
      ['features/apps/OpenPlaqueList.tsx', 'OpenPlaqueList'],
      ['features/entity-detail/DetailMenu.tsx', 'RecordMenu'],
      ['features/entity-detail/DetailScreen.tsx', 'DetailScreen'],
      ['features/entity-detail/RoutineStatusBlock.tsx', 'RoutineStatusBlock'],
      ['features/entity-detail/RunDecisionsBlock.tsx', 'RunBatch'],
      ['features/entity-editor/BodyEditor.tsx', 'BodyEditorInstance'],
      ['features/search/SearchPanel.tsx', 'SearchPanel'],
      ['features/search/SearchPanel.tsx', 'SearchResults'],
      ['lib/entity-ref/RecordLink.tsx', 'RecordLink'],
    ] as const
  ).map(([file, name]) => webSite(file, name, 'useRecordLinkController')),
  webSite('lib/entity-ref/record-link-controller.ts', 'useRecordLinkController', 'openRecord'),
  webSite(
    'lib/entity-ref/record-link-controller.ts',
    'useRecordLinkController',
    'openPendingCreate',
  ),
  webSite('app/router.tsx', 'ActiveScreen', 'confirmPendingCreate'),
  // Explicit section commands, browser history, and corrections of an already-open place.
  webSite('app/NotFoundScreen.tsx', 'NotFoundScreen', 'openSection'),
  webSite('app/frame/SectionList.tsx', 'selectSection', 'openSection'),
  webSite('app/history.ts', 'startNavigation', 'setNavState'),
  webSite('app/history.ts', 'settleOverlay', 'setNavState'),
  webSite('app/history.ts', 'onPopSite', 'setNavState'),
  webSite('app/history.ts', 'onPopApp', 'setNavState'),
  webSite('state/navigation.ts', 'run', 'setState'),
  webSite('state/navigation.ts', 'setNavState', 'setState'),
  webSite('state/navigation.ts', 'resetNavigation', 'setState'),
  webSite('app/history.ts', 'enterAddress', 'navReduce'),
  webSite('app/router.tsx', 'HomeScreen', 'replacePlace'),
  webSite('features/apps/OpenPlaqueList.tsx', 'goTo', 'replacePlace'),
  webSite('features/apps/useOpening.ts', 'useOpening', 'replacePlace'),
];

if (import.meta.main) {
  const paths = productionRecordLinkSources();
  const hits = scanRecordLinks(paths, {}, recordLinkAdapters);
  for (const hit of hits) {
    console.error(
      `${hit.file}:${hit.line} ${hit.functionName} bypasses RecordLink (${hit.target})`,
    );
  }
  if (hits.length) process.exitCode = 1;
  else console.log(`Record links checked in ${paths.length} web source files`);
}
