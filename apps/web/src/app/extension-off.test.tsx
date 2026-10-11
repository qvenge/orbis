/**
 * Выключенное расширение в web (срез 1б §8.3, §8.4; С1б-4 — web-часть, С1б-15).
 *
 * Маска — ответ `user.getSettings` (`disabledModules`): web впервые её читает. Экран записи
 * открывается так, как его откроет человек (`DetailScreen`), реестр — НАСТОЯЩИЙ (`registryReply`:
 * строки shared после задачи 5 несут `module` аспектов и свойств), поэтому «только чтение» решает
 * ровно та колонка, по которой отказывает сервер (задача 7).
 *
 * Семь точек §8.4 — каждая своим сюжетом: карточка и её поля (а), бейдж категории (б), остаток
 * конверта (в), быстрый ввод (г), «план → факт» (д), правила памяти (е), агрегаты бюджета (ж); и
 * «включение возвращает всё» (з), блок-плашка вместо пустоты (и), устаревшая маска в кеше (к),
 * предпросмотр шаблона — плашка без «Включить» (л), маска в секции «Свойства» (м).
 */
import {
  type EntityCreateInput,
  EXTENSION_IDS,
  EXTENSION_MANIFESTS,
  type ExtensionId,
  PAGE_ASPECT,
  TEMPLATE_FOR_PROPERTY,
} from '@orbis/shared';
import { parseBody } from '@orbis/shared/doc';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EntityCard } from '../features/chat/cards/EntityCard';
import { MemoryRuleCard } from '../features/chat/cards/MemoryRuleCard';
import type { EntityCardData, MemoryRuleSuggestionData } from '../features/chat/cards/types';
import type { ChatMessage } from '../features/chat/useChatThread';
import { chatThreadKey } from '../features/chat/useChatThread';
import { CATEGORY_QUERY, createUnderMask, useFastPath } from '../features/chat/useFastPath';
import { AspectSection } from '../features/entity-detail/AspectSection';
import { resetDetailMenuModuleForTests } from '../features/entity-detail/DetailMenuSlot';
import { DetailScreen } from '../features/entity-detail/DetailScreen';
import { NativeRow } from '../features/entity-detail/NativeRow';
import { RecordHostProvider, recordHostValue } from '../features/entity-detail/record-host';
import { PAGE_TEMPLATES_QUERY } from '../features/page/usePageTemplates';
import { invalidateBudget } from '../lib/invalidate';
import { noteRegistryVersion, resetRegistryVersionForTests } from '../lib/registry/useRegistry';
import { useRetryBuffer } from '../state/retry';
import {
  installCrashTrap,
  type MockHandler,
  mockEntityUpdateResult,
  mockLink,
  renderWithProviders,
  trpcError,
  type WireEntityFixture,
  wireEntity,
} from '../test/harness';
import { navAt } from '../test/nav';
import { BUILTIN_REGISTRY, registryReply } from '../test/registry';
import { queryClient, trpc } from '../trpc';
import { useExtensionRecordHooks } from './extension-registry';

// Агрегаты бюджета гасятся помощником `lib/invalidate` (§8.4 п. 7 — «безвредно, остаётся»): шпион
// поверх настоящего, прочие экспорты (`invalidateGraph`) — как есть.
vi.mock('../lib/invalidate', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../lib/invalidate')>();
  return { ...orig, invalidateBudget: vi.fn(orig.invalidateBudget) };
});

installCrashTrap();

beforeEach(() => {
  localStorage.clear();
  resetDetailMenuModuleForTests();
  // Редактор, вставший сам по таймеру простоя, менял бы дерево посреди проверки.
  vi.stubGlobal('requestIdleCallback', () => 1);
  resetRegistryVersionForTests();
  noteRegistryVersion(BUILTIN_REGISTRY.version);
  useRetryBuffer.setState({ size: 0, pending: [] });
  vi.mocked(invalidateBudget).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const nameOf = (ext: ExtensionId) => EXTENSION_MANIFESTS[ext].name.ru;
const plaqueText = (ext: ExtensionId) => `Расширение «${nameOf(ext)}» выключено`;
const enableLabel = (ext: ExtensionId) => `Включить расширение «${nameOf(ext)}»`;

const CAT = 'cat-taxi';
const taxi = wireEntity({
  id: CAT,
  title: 'Такси',
  props: { 'orbis/aliases': ['такси'], 'orbis/spend_class': 'variable' },
  aspects: ['orbis/category'],
});

/** Запись с аспектом расширения и свойство, которое при включённом правится контролом. */
interface ExtCase {
  entity: WireEntityFixture;
  aspect: string;
  editable: string;
}

const CASES: Record<ExtensionId, ExtCase> = {
  finance: {
    entity: wireEntity({
      id: 'rec-finance',
      title: 'Такси до вокзала',
      bodyDoc: parseBody(''),
      aspects: ['orbis/financial'],
      props: {
        'orbis/amount': '500.00',
        'orbis/direction': 'expense',
        'orbis/finance_category': CAT,
        'orbis/occurred_on': '2026-09-01',
        'orbis/counterparty': 'Таксопарк',
      },
    }),
    aspect: 'orbis/financial',
    editable: 'orbis/counterparty',
  },
  goals: {
    entity: wireEntity({
      id: 'rec-goals',
      title: 'Сбросить вес',
      bodyDoc: parseBody(''),
      aspects: ['orbis/goal'],
      props: { 'orbis/target_value': '80', 'orbis/unit': 'кг' },
    }),
    aspect: 'orbis/goal',
    editable: 'orbis/target_value',
  },
  projects: {
    entity: wireEntity({
      id: 'rec-projects',
      title: 'Ремонт',
      bodyDoc: parseBody(''),
      aspects: ['orbis/project'],
      props: {},
    }),
    aspect: 'orbis/project',
    editable: 'orbis/project_stage',
  },
  dev: {
    entity: wireEntity({
      id: 'rec-dev',
      title: 'orbis',
      bodyDoc: parseBody(''),
      aspects: ['orbis/repo'],
      props: { 'orbis/repo_url': 'https://example.com/orbis.git' },
    }),
    aspect: 'orbis/repo',
    editable: 'orbis/repo_url',
  },
};

/** Свойства аспекта, принадлежащие расширению (`module === ext`) — по настоящему реестру. */
function extProps(aspect: string, ext: ExtensionId): string[] {
  const def = BUILTIN_REGISTRY.aspects.find((a) => a.id === aspect);
  if (def === undefined) throw new Error(`нет аспекта ${aspect}`);
  return def.properties
    .map((p) => p.propertyId)
    .filter((id) => BUILTIN_REGISTRY.properties.find((p) => p.id === id)?.module === ext);
}

/** Маска графа — изменяемая: «включение» и «перечитывание» её меняют посреди сюжета. */
interface World {
  mask: string[];
  entity: WireEntityFixture;
  templates?: WireEntityFixture[];
  /** Ответ `entity.update`: по умолчанию — успех. */
  onUpdate?: (input: unknown) => Partial<import('../trpc').RouterOutputs['entity']['update']>;
}

function screenHandler(world: World): MockHandler {
  return (path, input) => {
    const reg = registryReply(path);
    if (reg !== undefined) return reg;
    const q = (input as { query?: unknown } | undefined)?.query;
    switch (path) {
      case 'user.getSettings':
        return { defaultCurrency: 'RUB', disabledModules: world.mask };
      case 'entity.get':
        return {
          entity: world.entity,
          relations: [],
          backlinks: [],
          thread: null,
          ...(world.entity.aspects.includes('orbis/goal')
            ? { goalProgress: { current: '90', target: '80' } }
            : {}),
        };
      case 'entity.query':
        if (q === PAGE_TEMPLATES_QUERY) return world.templates ?? [];
        return [taxi];
      case 'entity.update':
        return mockEntityUpdateResult(world.onUpdate?.(input) ?? world.entity);
      case 'user.setModuleEnabled': {
        const { module, enabled } = input as { module: string; enabled: boolean };
        world.mask = enabled ? world.mask.filter((m) => m !== module) : [...world.mask, module];
        return { actionId: 'act-toggle' };
      }
      case 'budget.envelopeForCategory':
        return envStatus;
      default:
        return {};
    }
  };
}

function openRecord(world: World, extra?: ReactNode) {
  navAt(world.entity.id);
  return renderWithProviders(
    <>
      <DetailScreen entityId={world.entity.id} />
      {extra}
    </>,
    screenHandler(world),
    { queries: queryClient.getDefaultOptions().queries },
  );
}

const updates = (calls: { path: string; input: unknown }[]) =>
  calls.filter((c) => c.path === 'entity.update').map((c) => c.input as Record<string, unknown>);

/** Лист, который монтируется, когда маска уже в кеше (как в живом приложении после старта). */
function AfterSettings({ children }: { children: ReactNode }) {
  const settings = trpc.user.getSettings.useQuery();
  return settings.data === undefined ? null : children;
}

// --- (а) карточка аспекта выключенного расширения ---------------------------------------------

describe.each(
  EXTENSION_IDS,
)('(а) %s выключено: поля только чтение, плашка, аспект не снимается', (ext) => {
  const c = CASES[ext];

  test('плашка «Расширение «…» выключено» с «Включить», без «Снять аспект», поля расширения — текстом', async () => {
    const { calls } = openRecord({ mask: [ext], entity: c.entity });
    const section = await screen.findByTestId(`aspect-${c.aspect}`);
    const plaque = await within(section).findByText(plaqueText(ext));
    expect(plaque.closest('[role="status"]')).not.toBeNull();
    expect(within(section).getByRole('button', { name: enableLabel(ext) })).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: /^Снять аспект/ })).toBeNull();
    const own = extProps(c.aspect, ext);
    expect(own.length).toBeGreaterThan(0);
    for (const id of own) {
      // Путь `readOnly` строки: значение текстом, контрола нет — ввести в него нечего.
      expect([id, within(section).getByTestId(`prop-${id}`).tagName]).toEqual([id, 'SPAN']);
    }
    expect(updates(calls)).toEqual([]);
    // Прочие поля записи правятся: заголовок — обычная правка.
    const title = screen.getByTestId('title-edit');
    fireEvent.change(title, { target: { value: `${c.entity.title}!` } });
    fireEvent.blur(title);
    await waitFor(() => expect(updates(calls).some((u) => u.title !== undefined)).toBe(true));
  });

  test('контроль — маска пуста: плашки нет, контрол правится, «Снять аспект» есть', async () => {
    openRecord({ mask: [], entity: c.entity });
    const section = await screen.findByTestId(`aspect-${c.aspect}`);
    await waitFor(() =>
      expect(within(section).getByTestId(`prop-${c.editable}`).tagName).not.toBe('SPAN'),
    );
    expect(within(section).getByRole('button', { name: /^Снять аспект/ })).toBeInTheDocument();
    expect(screen.queryByText(plaqueText(ext))).toBeNull();
  });
});

test('(а) Финансы выключены: сумма — стандартное свойство ядра — правится, правка уходит', async () => {
  const c = CASES.finance;
  const { calls } = openRecord({ mask: ['finance'], entity: c.entity });
  const section = await screen.findByTestId('aspect-orbis/financial');
  await within(section).findByText(plaqueText('finance'));
  const amount = within(section).getByTestId('prop-orbis/amount');
  expect(amount.tagName).toBe('INPUT');
  fireEvent.change(amount, { target: { value: '600' } });
  fireEvent.blur(amount);
  await waitFor(() =>
    expect(updates(calls).some((u) => (u.props as object | undefined) !== undefined)).toBe(true),
  );
  expect(updates(calls).find((u) => u.props !== undefined)?.props).toHaveProperty('orbis/amount');
});

// --- (б) бейдж категории в строке записи -------------------------------------------------------

describe('(б) бейдж категории', () => {
  const row = CASES.finance.entity;
  const render = (mask: string[]) =>
    renderWithProviders(
      <AfterSettings>
        <NativeRow entity={row} onToggleTask={() => {}} />
      </AfterSettings>,
      screenHandler({ mask, entity: row }),
    );

  test('Финансы выключены: бейджа «Такси» нет и запроса категорий нет', async () => {
    const { calls } = render(['finance']);
    await screen.findByTestId('native-row');
    // Реестр доехал (сумма из привязок M14 — признак), дальше ждать нечего.
    await screen.findByTestId('native-amount');
    expect(screen.queryByText('Такси')).toBeNull();
    expect(calls.filter((c) => c.path === 'entity.query')).toEqual([]);
  });

  test('контроль — маска пуста: бейдж есть', async () => {
    render([]);
    expect(await screen.findByText('Такси')).toBeInTheDocument();
  });
});

// --- (в) остаток конверта в карточке чата --------------------------------------------------------

const finCard = {
  kind: 'entity_card',
  entityId: 'e1',
  title: 'Такси 340',
  aspects: ['orbis/financial'],
  keyFields: {
    'orbis/amount': '340.00',
    'orbis/direction': 'expense',
    'orbis/finance_category': CAT,
    'orbis/occurred_on': '2026-09-13',
  },
  undoActionId: 'act1',
} as EntityCardData;

const envStatus = {
  envelope: wireEntity({
    id: 'env1',
    title: 'Конверт Такси',
    props: {
      'orbis/finance_category': CAT,
      'orbis/limit': '10000.00',
      'orbis/period_start': '2026-09-01',
      'orbis/period_end': '2026-09-30',
    },
    aspects: ['orbis/budget'],
  }),
  category: { id: CAT, title: 'Такси', icon: null, color: null },
  spent: '1940.00',
  effectiveLimit: '10000.00',
  remaining: '8060.00',
  dailyPace: null,
  phase: 'active',
};

describe('(в) остаток конверта', () => {
  const render = (mask: string[]) =>
    renderWithProviders(
      <AfterSettings>
        <EntityCard card={finCard} />
      </AfterSettings>,
      screenHandler({ mask, entity: CASES.finance.entity }),
    );

  test('Финансы выключены: строки остатка нет, `budget.envelopeForCategory` не зовётся', async () => {
    const { calls } = render(['finance']);
    await screen.findByTestId('entity-card');
    // Категория в сетке полей — показ значения (§8.3 «записи видны»): название приехало.
    await screen.findByText('Такси');
    expect(screen.queryByTestId('envelope-remaining')).toBeNull();
    expect(calls.filter((c) => c.path === 'budget.envelopeForCategory')).toEqual([]);
  });

  test('контроль — маска пуста: строка остатка есть', async () => {
    render([]);
    expect(await screen.findByTestId('envelope-remaining')).toHaveTextContent('осталось');
  });
});

// --- (г) быстрый ввод расхода ---------------------------------------------------------------------

describe('(г) быстрый ввод', () => {
  const RULES_QUERY = 'aspect=orbis/memory, orbis/memory_kind=rule';

  function fastPath(mask: string[], onCreate?: (state: { mask: string[] }) => unknown) {
    const state = { mask };
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const calls: { path: string; input: unknown }[] = [];
    const client = trpc.createClient({
      links: [
        mockLink((path, input) => {
          calls.push({ path, input });
          if (path === 'user.getSettings')
            return { defaultCurrency: 'RUB', disabledModules: state.mask };
          if (path === 'entity.query') {
            const q = (input as { query?: string } | undefined)?.query;
            return q === RULES_QUERY ? [] : [taxi];
          }
          if (path === 'chat.listMessages') return [];
          if (path === 'entity.create')
            return onCreate?.(state) ?? { id: 'created', title: 'такси 500' };
          return {};
        }),
      ],
    });
    const Wrap = ({ children }: { children: ReactNode }) => (
      <trpc.Provider client={client} queryClient={qc}>
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      </trpc.Provider>
    );
    const { result } = renderHook(() => useFastPath('t1'), { wrapper: Wrap });
    const cardAspects = () => {
      const data = qc.getQueryData(chatThreadKey('t1')) as { pages: ChatMessage[][] } | undefined;
      const msg = (data?.pages ?? []).flat()[0];
      return (msg?.metadata as { cards?: { aspects?: string[] }[] } | undefined)?.cards?.[0]
        ?.aspects;
    };
    return { result, calls, cardAspects };
  }

  const creates = (calls: { path: string; input: unknown }[]) =>
    calls
      .filter((c) => c.path === 'entity.create')
      .map((c) => c.input as { input: EntityCreateInput; source: string });

  test('Финансы выключены: «такси 500» — обычная запись с текстом ввода, без финансового аспекта', async () => {
    const { result, calls, cardAspects } = fastPath(['finance']);
    await act(async () => {
      await result.current.submit('такси 500');
    });
    await waitFor(() => expect(creates(calls)).toHaveLength(1));
    const [created] = creates(calls);
    expect(created?.source).toBe('fast_path');
    expect(created?.input.aspects ?? []).not.toContain('orbis/financial');
    expect(created?.input.props ?? {}).not.toHaveProperty('orbis/amount');
    expect(created?.input.title).toBe('такси 500');
    expect(cardAspects() ?? []).not.toContain('orbis/financial');
  });

  test('контроль — маска пуста: финансовое создание', async () => {
    const { result, calls, cardAspects } = fastPath([]);
    await act(async () => {
      await result.current.submit('такси 500');
    });
    await waitFor(() => expect(creates(calls)).toHaveLength(1));
    expect(creates(calls)[0]?.input.aspects).toContain('orbis/financial');
    expect(creates(calls)[0]?.input.props).toHaveProperty('orbis/amount');
    expect(cardAspects()).toEqual(['orbis/financial']);
  });

  test('createUnderMask — чистая: маска решает форму создания, id сохраняется', () => {
    const create: EntityCreateInput = {
      id: '01900000-0000-7000-8000-000000000001',
      title: 'такси',
      tags: [],
      aspects: ['orbis/financial'],
      props: { 'orbis/amount': '500.00', 'orbis/finance_category': CAT },
    };
    expect(createUnderMask(create, 'такси 500', ['finance'])).toEqual({
      id: create.id,
      title: 'такси 500',
      tags: [],
    });
    expect(createUnderMask(create, 'такси 500', [])).toBe(create);
    expect(createUnderMask(create, 'такси 500', ['goals'])).toBe(create);
  });

  test('устаревшая маска: отказ `FORBIDDEN` перечитывает настройки, следующий ввод — под новой маской', async () => {
    let first = true;
    const { result, calls } = fastPath([], (state) => {
      if (!first) return undefined;
      first = false;
      // Финансы выключили в другом месте: сервер уже отказывает, в кэше чата — прежняя маска.
      state.mask = ['finance'];
      throw trpcError('FORBIDDEN', 'расширение «Финансы» выключено');
    });
    const settingsCalls = () => calls.filter((c) => c.path === 'user.getSettings').length;
    await act(async () => {
      await result.current.submit('такси 500');
    });
    await waitFor(() => expect(settingsCalls()).toBe(2));
    await act(async () => {
      await result.current.submit('такси 500');
    });
    await waitFor(() => expect(creates(calls)).toHaveLength(2));
    expect(creates(calls)[0]?.input.aspects).toContain('orbis/financial');
    expect(creates(calls)[1]?.input.aspects ?? []).not.toContain('orbis/financial');
  });

  test('CATEGORY_QUERY — тот же текст, что ищет категории (охрана фикстуры)', () => {
    expect(CATEGORY_QUERY.query).toBe('aspect=orbis/category');
  });
});

// --- (д) «план → факт» ------------------------------------------------------------------------------

describe('(д) «план → факт» на чекбоксе заголовка', () => {
  const planned = wireEntity({
    id: 'rec-planned',
    title: 'Купить велосипед',
    bodyDoc: parseBody(''),
    aspects: ['orbis/task', 'orbis/financial'],
    props: {
      'orbis/task_status': 'inbox',
      'orbis/planned': true,
      'orbis/amount': '30000.00',
      'orbis/direction': 'expense',
      'orbis/finance_category': CAT,
    },
  });

  async function tick(mask: string[]) {
    const r = openRecord({ mask, entity: planned });
    await screen.findByTestId('aspect-orbis/financial');
    // Маска доехала: у выключенных Финансов — плашка, у включённых — контрол категории.
    if (mask.includes('finance')) await screen.findByText(plaqueText('finance'));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Готово' }));
    return r.calls;
  }

  test('Финансы выключены: карточки «план → факт» нет', async () => {
    const calls = await tick(['finance']);
    // Задача закрыта (правка ушла) — карточка поднялась бы синхронно с кликом, до ответа сервера.
    await waitFor(() => expect(updates(calls).some((u) => u.props !== undefined)).toBe(true));
    expect(screen.queryByTestId('plan-to-fact-card')).toBeNull();
  });

  test('контроль — маска пуста: карточка есть', async () => {
    await tick([]);
    expect(await screen.findByTestId('plan-to-fact-card')).toBeInTheDocument();
  });
});

// --- (е) правила памяти про деньги — язык живёт -------------------------------------------------

test('(е) Финансы выключены: «Запомнить» правило с областью «движение денег» создаёт запись', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-13T12:00:01.000Z'));
  try {
    const suggestion = {
      kind: 'memory_rule_suggestion',
      ruleText: 'такси → Такси',
      pattern: 'Яндекс Го',
      fromCategoryId: 'cat-other',
      toCategoryId: CAT,
      categoryTitle: 'Такси',
    } as MemoryRuleSuggestionData;
    const { calls } = renderWithProviders(
      <AfterSettings>
        <MemoryRuleCard card={suggestion} messageId="m1" createdAt="2026-09-13T12:00:00.000Z" />
      </AfterSettings>,
      (path, input) =>
        path === 'entity.create'
          ? wireEntity({ id: 'mem1', title: 'такси → Такси', aspects: ['orbis/memory'] })
          : screenHandler({ mask: ['finance'], entity: CASES.finance.entity })(path, input),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Запомнить' }));
    await waitFor(() => expect(calls.some((c) => c.path === 'entity.create')).toBe(true));
    const input = calls.find((c) => c.path === 'entity.create')?.input as {
      input: { props: Record<string, unknown> };
    };
    expect(input.input.props['orbis/rule_scope']).toBe('orbis/money-movement');
  } finally {
    vi.restoreAllMocks();
  }
});

// --- (ж) агрегаты бюджета после правки финансовой записи --------------------------------------

test('(ж) Финансы выключены: правка суммы проходит и гасит `budget.*` — безвредно, остаётся', async () => {
  const { calls } = openRecord({ mask: ['finance'], entity: CASES.finance.entity });
  const section = await screen.findByTestId('aspect-orbis/financial');
  await within(section).findByText(plaqueText('finance'));
  const amount = within(section).getByTestId('prop-orbis/amount');
  fireEvent.change(amount, { target: { value: '700' } });
  fireEvent.blur(amount);
  await waitFor(() => expect(updates(calls).length).toBeGreaterThan(0));
  await waitFor(() => expect(vi.mocked(invalidateBudget)).toHaveBeenCalled());
});

// --- (з) включение возвращает всё --------------------------------------------------------------

describe('(з) «Включить» на плашке возвращает всё', () => {
  test('Цели: «Включить» → `user.setModuleEnabled` → плашки нет, поля правятся, «Снять аспект «Цель»»', async () => {
    const world: World = { mask: ['goals'], entity: CASES.goals.entity };
    const { calls } = openRecord(world);
    const section = await screen.findByTestId('aspect-orbis/goal');
    fireEvent.click(await within(section).findByRole('button', { name: enableLabel('goals') }));
    await waitFor(() =>
      expect(calls.filter((c) => c.path === 'user.setModuleEnabled').map((c) => c.input)).toEqual([
        { module: 'goals', enabled: true },
      ]),
    );
    await waitFor(() => expect(screen.queryByText(plaqueText('goals'))).toBeNull());
    const back = screen.getByTestId('aspect-orbis/goal');
    await waitFor(() =>
      expect(within(back).getByTestId('prop-orbis/target_value').tagName).toBe('INPUT'),
    );
    expect(within(back).getByRole('button', { name: 'Снять аспект «Цель»' })).toBeInTheDocument();
  });

  test('Финансы: поля, бейдж категории и строка остатка конверта вернулись', async () => {
    const world: World = { mask: ['finance'], entity: CASES.finance.entity };
    const { calls } = openRecord(world, <EntityCard card={finCard} />);
    const section = await screen.findByTestId('aspect-orbis/financial');
    await within(section).findByText(plaqueText('finance'));
    expect(within(screen.getByTestId('native-row')).queryByText('Такси')).toBeNull();
    fireEvent.click(within(section).getByRole('button', { name: enableLabel('finance') }));
    await waitFor(() => expect(calls.some((c) => c.path === 'user.setModuleEnabled')).toBe(true));
    await waitFor(() => expect(screen.queryByText(plaqueText('finance'))).toBeNull());
    expect(await within(screen.getByTestId('native-row')).findByText('Такси')).toBeInTheDocument();
    expect(await screen.findByTestId('envelope-remaining')).toBeInTheDocument();
    const back = screen.getByTestId('aspect-orbis/financial');
    await waitFor(() =>
      expect(within(back).getByTestId('prop-orbis/counterparty').tagName).toBe('INPUT'),
    );
  });
});

// --- (и) блок — плашка, не пустота ---------------------------------------------------------------

test('(и) шаблон владельца с {{card: orbis/goal}} и {{cards: own}}: при выключенных Целях карточка цели одна, с плашкой', async () => {
  const body = 'Вид цели\n\n{{title}}\n\n{{card: orbis/goal}}\n\n{{cards: own}}\n\n{{body}}\n';
  const template = wireEntity({
    id: '00000000-0000-4000-8000-000000002301',
    title: 'Цели',
    body,
    bodyDoc: parseBody(body),
    aspects: [PAGE_ASPECT],
    createdAt: '2026-09-01T00:00:00.000Z',
    props: { [TEMPLATE_FOR_PROPERTY]: ['orbis/goal'] },
  });
  const { container } = openRecord({
    mask: ['goals'],
    entity: CASES.goals.entity,
    templates: [template],
  });
  await waitFor(() =>
    expect(screen.queryAllByTestId('page-text').map((n) => n.textContent)).toContain('Вид цели'),
  );
  await screen.findByText(plaqueText('goals'));
  expect(container.querySelectorAll('[data-testid="aspect-orbis/goal"]')).toHaveLength(1);
  expect(screen.getAllByText(plaqueText('goals'))).toHaveLength(1);
});

// --- (к) устаревшая маска в кеше -------------------------------------------------------------------

test('(к) отказ сервера «расширение выключено» на правке при устаревшей маске → маска перечитана, плашка', async () => {
  const world: World = { mask: [], entity: CASES.goals.entity };
  // Расширение выключили в другом месте: сервер уже отказывает, а в кеше экрана — прежняя маска.
  world.onUpdate = () => {
    world.mask = ['goals'];
    throw trpcError('FORBIDDEN', 'Расширение «Цели» выключено: его свойства только читаются');
  };
  const { calls } = openRecord(world);
  const section = await screen.findByTestId('aspect-orbis/goal');
  const target = await within(section).findByTestId('prop-orbis/target_value');
  await waitFor(() => expect(target.tagName).toBe('INPUT'));
  const settingsBefore = calls.filter((c) => c.path === 'user.getSettings').length;
  fireEvent.change(target, { target: { value: '75' } });
  fireEvent.blur(target);
  await waitFor(() =>
    expect(calls.filter((c) => c.path === 'user.getSettings').length).toBeGreaterThan(
      settingsBefore,
    ),
  );
  expect(await screen.findByText(plaqueText('goals'))).toBeInTheDocument();
});

// --- (л) предпросмотр шаблона: плашка объясняет, но не включает ---------------------------------

test('(л) хост только для чтения (предпросмотр шаблона): текст плашки есть, «Включить» — нет', async () => {
  const c = CASES.goals;
  function PreviewHost() {
    const extensionHooks = useExtensionRecordHooks();
    const reply = { entity: c.entity, relations: [], backlinks: [], thread: null } as never;
    return (
      <RecordHostProvider
        value={recordHostValue(reply, { extensionHooks, openTab: 'record', readOnly: true })}
      >
        <AspectSection entity={c.entity as never} aspectId={c.aspect} />
      </RecordHostProvider>
    );
  }
  const { calls } = renderWithProviders(
    <PreviewHost />,
    screenHandler({ mask: ['goals'], entity: c.entity }),
  );
  const section = await screen.findByTestId('aspect-orbis/goal');
  expect(await within(section).findByText(plaqueText('goals'))).toBeInTheDocument();
  expect(within(section).queryByRole('button')).toBeNull();
  expect(calls.some((x) => x.path === 'user.setModuleEnabled')).toBe(false);
});

// --- (м) секция «Свойства»: значение, пережившее снятие аспекта ---------------------------------

describe('(м) маска в секции «Свойства» — то же правило по `module` свойства', () => {
  // Аспект «Цель» снят, значение `orbis/target_value` осталось (Р9) и живёт в «Свойствах».
  const orphan = wireEntity({
    id: 'rec-orphan',
    title: 'Бывшая цель',
    bodyDoc: parseBody(''),
    aspects: [],
    props: { 'orbis/target_value': '80' },
  });

  test('Цели выключены: значение Целей в «Свойствах» — текстом', async () => {
    openRecord({ mask: ['goals'], entity: orphan });
    const free = await screen.findByTestId('aspect-free');
    await waitFor(() =>
      expect(within(free).getByTestId('prop-orbis/target_value').tagName).toBe('SPAN'),
    );
  });

  test('контроль — маска пуста: значение правится', async () => {
    openRecord({ mask: [], entity: orphan });
    const free = await screen.findByTestId('aspect-free');
    await waitFor(() =>
      expect(within(free).getByTestId('prop-orbis/target_value').tagName).toBe('INPUT'),
    );
  });
});
