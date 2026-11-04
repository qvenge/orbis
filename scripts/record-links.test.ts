import { beforeAll, expect, test } from 'bun:test';
import { productionRecordLinkSources, recordLinkAdapters, scanRecordLinks } from './record-links';

const mutant = 'apps/web/src/record-link-guard-mutant.tsx';
const controls = 'apps/web/src/record-link-guard-controls.tsx';
const exception = 'apps/web/src/record-link-guard-exception.tsx';
const id = '018cd857-511b-7f25-870e-377777ceca00';
const imports = `
  import { buildAddress, navReduce } from '@orbis/shared/nav';
  import { useOpenRecord as oldOpen } from './app/useOpenRecord';
  import { setNavState, useNav } from './state/navigation';
  import { useRecordLinkController as controller } from './lib/entity-ref/record-link-controller';
  const id = '${id}';
  const nav = useNav.getState();
  const address = { kind: 'record', id, app: { kind: 'host' } } as const;
`;

const sources = {
  [mutant]:
    imports +
    `
    export function Mutant() {
      const { openRecord: jump } = nav;
      const jumpAgain = nav['openRecord'];
      const navigate = oldOpen();
      const makeController = controller;
      const { open } = makeController();
      const method = 'openRecord';
      const browserOpen = window.open;
      const makeUrl = buildAddress;
      const url = makeUrl(address);
      const setStore = useNav.setState;
      const browserUrl = new URL('/r/' + id, window.location.origin);
      const documentUrl = new URL('/r/' + id, document.baseURI);
      const literal = '/entity/${id}';
      const constructed = '/r/' + id;
      return <>
        <button onClick={() => useNav.getState().openRecord(id)}>Direct</button>
        <button onClick={() => nav.openPendingCreate(id)}>Pending route</button>
        <button onClick={() => nav.confirmPendingCreate(id)}>Promote pending route</button>
        <button onClick={() => setNavState({model: nav.model, overlay: null})}>Router adapter</button>
        <button onClick={() => setStore({model: nav.model})}>Aliased store writer</button>
        <button onClick={() => jump(id)}>Destructured</button>
        <button onClick={() => jumpAgain(id)}>Bracket alias</button>
        <button onClick={() => nav[method](id)}>Computed literal method</button>
        <button onClick={() => navigate(id)}>Legacy hook</button>
        <button onClick={() => open(id)}>Imperative hook</button>
        <button onClick={() => nav.openAddress(address)}>Generic address</button>
        <button onClick={() => navReduce(nav.model, { type: 'open', address, app: 'host', from: 'content' }, 'site')}>Reducer</button>
        <a href={url}>Raw built URL</a>
        <a href={browserUrl.href}>Raw browser URL</a>
        <a href={documentUrl.href}>Raw document URL</a>
        <a href={literal}>Raw legacy URL</a>
        <a {...{ href: url }}>Spread raw href</a>
        <a href={\`/a/\${id}/r/\${id}\`}>Raw template URL</a>
        <a href={\`\${window.location.origin}/r/\${id}\`}>Raw same-origin URL</a>
        <button onClick={() => window.open(constructed)}>Browser</button>
        <button onClick={() => browserOpen(constructed)}>Aliased browser</button>
        <button onClick={() => window.open(documentUrl)}>DOM URL object</button>
        <button onClick={() => window.location.assign(browserUrl)}>Location URL object</button>
        <button onClick={() => { const a = document.createElement('a'); a.href = url; a.click(); }}>DOM anchor</button>
        <button onClick={() => { const a = document.createElement('a'); a.setAttribute('href', url); a.click(); }}>DOM attribute</button>
      </>;
    }
  `,
  [controls]:
    imports +
    `
    export function Controls() {
      const { openRecord } = { openRecord: () => {} };
      const url = buildAddress(address);
      const foreign = new URL('/r/' + id, 'https://elsewhere.test');
      // useNav.getState().openRecord(id)
      return <>
        <button onClick={openRecord}>Unrelated callback</button>
        <button onClick={() => navigator.clipboard.writeText(url)}>Copy record link</button>
        <button onClick={() => nav.openAddress({kind:'host-screen',screen:'chat'})}>Chat</button>
        <button onClick={() => nav.switchApp(id)}>App</button>
        <a href='/settings'>Settings</a>
        <a href='https://elsewhere.test/r/${id}'>External</a>
        <a href={foreign.href}>External constructed</a>
        <button onClick={() => window.open(foreign)}>External DOM URL object</button>
        <button onClick={() => window.location.assign(foreign)}>External Location URL object</button>
      </>;
    }
  `,
  [exception]:
    imports +
    `
    function allowed() { nav.openRecord(id); nav.openAddress(address); }
    function unrelated() { nav.openRecord(id); }
    export { allowed, unrelated };
  `,
};

const production = productionRecordLinkSources();
let violations: ReturnType<typeof scanRecordLinks>;
beforeAll(() => {
  violations = scanRecordLinks([...production, ...Object.keys(sources)], sources, [
    ...recordLinkAdapters,
    { file: exception, functionName: 'allowed', target: 'openRecord' },
  ]);
}, 60_000);

test('the compiler-backed guard rejects type-valid links that bypass the controller', () => {
  const hits = violations.filter((hit) => hit.file === mutant);
  expect(hits.map(({ target }) => target)).toEqual([
    'openRecord',
    'openRecord',
    'useOpenRecord',
    'useRecordLinkController',
    'openRecord',
    'openPendingCreate',
    'confirmPendingCreate',
    'setNavState',
    'setState',
    'openRecord',
    'openAddress',
    'navReduce',
    'href',
    'href',
    'href',
    'href',
    'href',
    'href',
    'href',
    'open',
    'open',
    'open',
    'assign',
    'href',
    'href',
  ]);
});

test('ordinary UI callbacks, host routes, external anchors and clipboard URLs pass', () => {
  expect(violations.filter((hit) => hit.file === controls)).toEqual([]);
});

test('an exception applies to its named function and sink only', () => {
  const hits = violations.filter((hit) => hit.file === exception);
  expect(hits.map(({ functionName, target }) => [functionName, target])).toEqual([
    ['allowed', 'openAddress'],
    ['unrelated', 'openRecord'],
  ]);
});

test('production web routes use RecordLink or a named adapter', () => {
  expect(production).toContain('apps/web/src/lib/entity-ref/RecordLink.tsx');
  expect(production).toContain('apps/web/src/app/router.tsx');
  expect(violations.filter(({ file }) => !Object.hasOwn(sources, file))).toEqual([]);
});
