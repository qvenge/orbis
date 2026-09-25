/**
 * Примитивы обвязки записи (спека страниц 1а §7.3, задача 12): каждый рисуется под хостом записи
 * и берёт данные из запроса записи `this` (`RecordHostProvider`), а не пропами от экрана.
 *
 * Фикстуры — те же, что у структурного снимка задачи 2 (`STRUCTURE_FIXTURES`): id формы uuid, и
 * обработчик отвечает правдоподобно каждому пути, который части экрана спрашивают.
 */
import { PAGE_ASPECT, TEMPLATE_FOR_PROPERTY } from '@orbis/shared';
import { parseBody } from '@orbis/shared/doc';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { BodyKindProvider } from '../../lib/query-blocks/body-kind';
import { noteRegistryVersion, resetRegistryVersionForTests } from '../../lib/registry/useRegistry';
import { useNav } from '../../state/navigation';
import { installCrashTrap, type MockHandler, renderWithProviders } from '../../test/harness';
import { BUILTIN_REGISTRY } from '../../test/registry';
import { queryClient } from '../../trpc';
import { usePlanToFactPrompt } from '../budget/usePlanToFactPrompt';
import { BodyScreenProvider, type BodyScreenValue } from './EntityBody';
import { AspectCardFor, RestCards } from './own-cards';
import { RECORD_BLOCK_COMPONENTS, TitleBlock, VersionsBlock } from './record-blocks';
import { RecordHostProvider, recordHostValue, TabPartHost } from './record-host';
import { STRUCTURE_FIXTURES, type StructureFixture, structureHandler } from './structure-fixtures';
import { TagsBlock } from './TagsBlock';
import { useEntityDetail } from './useEntityDetail';

installCrashTrap();

beforeEach(() => {
  localStorage.clear();
  // Редактор, вставший сам по таймеру простоя, менял бы дерево посреди проверки (приём
  // structure.test.tsx): тело здесь — первый кадр.
  vi.stubGlobal('requestIdleCallback', () => 1);
  resetRegistryVersionForTests();
  noteRegistryVersion(BUILTIN_REGISTRY.version);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const fixture = (name: string): StructureFixture => {
  const f = STRUCTURE_FIXTURES.find((x) => x.name === name);
  if (f === undefined) throw new Error(`нет фикстуры ${name}`);
  return f;
};

const SCREEN: BodyScreenValue = {
  asMarkdown: false,
  onCloseMarkdown: () => {},
  screenConflict: false,
  noticeHost: null,
  onRefresh: () => {},
};

/**
 * Хост так же, как его ставит экран записи: данные — из `entity.get` записи (тот же ключ, под
 * который ложится оптимистичный патч), «план → факт» — состояние ХОСТА.
 */
function Host({ id, children }: { id: string; children: ReactNode }) {
  const { get } = useEntityDetail(id);
  const planToFact = usePlanToFactPrompt();
  if (get.data === undefined) return null;
  return (
    <RecordHostProvider
      value={recordHostValue(get.data, { planToFact, activeTab: 'record', readOnlyBody: false })}
    >
      <BodyScreenProvider value={SCREEN}>{children}</BodyScreenProvider>
    </RecordHostProvider>
  );
}

function renderUnder(
  f: StructureFixture,
  ui: ReactNode,
  handler: MockHandler = structureHandler(f),
) {
  useNav.setState({
    activeTab: 'browser',
    stacks: { chat: [], browser: [{ kind: 'entity', id: f.entity.id }], agenda: [], budget: [] },
  });
  return renderWithProviders(<Host id={f.entity.id}>{ui}</Host>, handler, {
    queries: queryClient.getDefaultOptions().queries,
  });
}

/** Ориентиры секций аспектов в порядке документа (без «Свойств»). */
const aspectSections = (root: HTMLElement): string[] =>
  [...root.querySelectorAll('[data-testid^="aspect-orbis/"]')].map(
    (el) => el.getAttribute('data-testid') ?? '',
  );

describe('каждый примитив показывает свой ориентир из данных хоста', () => {
  const REL = 'with-relations';
  const cases: [keyof typeof RECORD_BLOCK_COMPONENTS, string, string][] = [
    ['title', REL, 'native-row'],
    ['tags', REL, 'tags-block'],
    ['body', REL, 'editor-preview'],
    ['cards', REL, 'aspect-orbis/task'],
    ['subtasks', REL, 'subtask'],
    ['blockers', REL, 'block-row'],
    ['backlinks', REL, 'backlink'],
    ['versions', REL, 'versions-card'],
    ['thread', REL, 'message-list'],
  ];
  for (const [name, fx, landmark] of cases) {
    test(`${name} → ${landmark}`, async () => {
      const Block = RECORD_BLOCK_COMPONENTS[name];
      renderUnder(fixture(fx), <Block />);
      expect(await screen.findByTestId(landmark, {}, { timeout: 5000 })).toBeInTheDocument();
    });
  }

  test('blockers — секция с полем добавления (ориентир снимка `block-add`)', async () => {
    const Block = RECORD_BLOCK_COMPONENTS.blockers;
    renderUnder(fixture('note-plain'), <Block />);
    expect(await screen.findByRole('button', { name: 'Добавить блокировку' })).toBeInTheDocument();
  });
});

test('versions: на скрытой вкладке список версий в сеть не идёт, на открытой — идёт', async () => {
  const f = fixture('note-plain');
  const hidden = renderUnder(
    f,
    <TabPartHost value="details" open={false}>
      <VersionsBlock />
    </TabPartHost>,
  );
  await screen.findByTestId('versions-card');
  expect(hidden.calls.some((c) => c.path === 'version.list')).toBe(false);
  hidden.unmount();

  const shown = renderUnder(
    f,
    <TabPartHost value="details" open>
      <VersionsBlock />
    </TabPartHost>,
  );
  await waitFor(() => expect(shown.calls.some((c) => c.path === 'version.list')).toBe(true));
});

test('AspectCardFor(orbis/goal) — секция полей И полоса прогресса одной карточкой', async () => {
  renderUnder(fixture('goal'), <AspectCardFor aspectId="orbis/goal" />);
  expect(await screen.findByTestId('aspect-orbis/goal')).toBeInTheDocument();
  expect(screen.getByTestId('goal-progress')).toBeInTheDocument();
});

test('AspectCardFor: аспекта на записи нет — ничего', async () => {
  renderUnder(
    fixture('note-plain'),
    <div data-testid="slot">
      <AspectCardFor aspectId="orbis/goal" />
    </div>,
  );
  // Слот встаёт вместе с данными хоста — то есть проверка идёт уже по записи, а не по пустоте
  // до ответа.
  expect(await screen.findByTestId('slot')).toBeEmptyDOMElement();
});

test('RestCards({placed: {orbis/goal}}) на цели с расписанием — только секция расписания', async () => {
  const { container } = renderUnder(
    fixture('goal-schedule'),
    <RestCards placed={new Set(['orbis/goal'])} />,
  );
  await screen.findByTestId('aspect-orbis/schedule');
  expect(aspectSections(container)).toEqual(['aspect-orbis/schedule']);
});

describe('TagsBlock', () => {
  const base = fixture('task');
  const tagged: StructureFixture = { ...base, entity: { ...base.entity, tags: ['дом'] } };
  const updates = (calls: { path: string; input: unknown }[]) =>
    calls.filter((c) => c.path === 'entity.update').map((c) => c.input);

  test('Enter добавляет тег — entity.update полной заменой списка', async () => {
    const { calls } = renderUnder(tagged, <TagsBlock />);
    const input = await screen.findByRole('textbox', { name: 'Добавить тег' });
    fireEvent.change(input, { target: { value: '  Работа ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(updates(calls)).toEqual([{ id: tagged.entity.id, tags: ['дом', 'работа'] }]),
    );
    expect(input).toHaveValue('');
  });

  test('крестик снимает тег', async () => {
    const { calls } = renderUnder(tagged, <TagsBlock />);
    const chip = (await screen.findByText('дом')).closest('span') as HTMLElement;
    fireEvent.click(within(chip).getByRole('button', { name: 'Удалить' }));
    await waitFor(() => expect(updates(calls)).toEqual([{ id: tagged.entity.id, tags: [] }]));
  });

  test('дубликат (в любом регистре) — без вызова', async () => {
    const { calls } = renderUnder(tagged, <TagsBlock />);
    const input = await screen.findByRole('textbox', { name: 'Добавить тег' });
    fireEvent.change(input, { target: { value: 'Дом' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('');
    await new Promise((r) => setTimeout(r, 50));
    expect(updates(calls)).toEqual([]);
  });

  test('Enter подтверждения IME тег не добавляет', async () => {
    const { calls } = renderUnder(tagged, <TagsBlock />);
    const input = await screen.findByRole('textbox', { name: 'Добавить тег' });
    fireEvent.change(input, { target: { value: 'работа' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(input).toHaveValue('работа');
    await new Promise((r) => setTimeout(r, 50));
    expect(updates(calls)).toEqual([]);
  });

  test('оптимистичный патч знает теги: новый тег виден до ответа сервера', async () => {
    const f = tagged;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const inner = structureHandler(f);
    const handler: MockHandler = async (path, input) => {
      if (path === 'entity.update') await gate;
      return inner(path, input);
    };
    renderUnder(f, <TagsBlock />, handler);
    const input = await screen.findByRole('textbox', { name: 'Добавить тег' });
    fireEvent.change(input, { target: { value: 'работа' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('работа')).toBeInTheDocument();
    release();
  });
});

test('«план → факт»: чекбокс заголовка поднимает карточку, стоящую в ДРУГОМ месте дерева (Ф-1а-18)', async () => {
  renderUnder(
    fixture('financial-task'),
    <>
      <div data-testid="head">
        <TitleBlock />
      </div>
      <div data-testid="elsewhere">
        <AspectCardFor aspectId="orbis/financial" />
      </div>
    </>,
  );
  const checkbox = await screen.findByRole('checkbox', { name: /готово/i });
  await screen.findByTestId('aspect-orbis/financial');
  expect(screen.queryByTestId('plan-to-fact-card')).toBeNull();
  fireEvent.click(checkbox);
  const elsewhere = screen.getByTestId('elsewhere');
  expect(await within(elsewhere).findByTestId('plan-to-fact-card')).toBeInTheDocument();
  expect(within(screen.getByTestId('head')).queryByTestId('plan-to-fact-card')).toBeNull();
});

describe('тело — род по САМОЙ записи, а не по месту показа', () => {
  /** Запись с телом `body` и аспектами/свойствами поверх заметки-фикстуры (id формы uuid). */
  const withBody = (body: string, aspects: string[], props: Record<string, unknown> = {}) => {
    const base = fixture('note-plain');
    return {
      ...base,
      entity: { ...base.entity, body, bodyDoc: parseBody(body), aspects, props },
    } as StructureFixture;
  };
  const Body = RECORD_BLOCK_COMPONENTS.body;

  test('заметка внутри шаблона остаётся заметкой: блок обвязки в её теле — плашка', async () => {
    renderUnder(
      withBody('{{title}}', []),
      <BodyKindProvider kind="template">
        <Body />
      </BodyKindProvider>,
    );
    expect(await screen.findByTestId('block-misplaced')).toBeInTheDocument();
  });

  test('страница: блок обвязки в теле законен — плашки нет', async () => {
    renderUnder(withBody('{{title}}', [PAGE_ASPECT]), <Body />);
    await screen.findByTestId('editor-preview');
    expect(screen.queryByTestId('block-misplaced')).toBeNull();
  });

  test('`{{body}}`: у шаблона законен, у страницы без «Шаблон для» — плашка', async () => {
    const tpl = renderUnder(
      withBody('{{body}}', [PAGE_ASPECT], { [TEMPLATE_FOR_PROPERTY]: ['orbis/task'] }),
      <Body />,
    );
    await screen.findByTestId('editor-preview');
    expect(screen.queryByTestId('block-misplaced')).toBeNull();
    tpl.unmount();

    renderUnder(withBody('{{body}}', [PAGE_ASPECT]), <Body />);
    expect(await screen.findByTestId('block-misplaced')).toBeInTheDocument();
  });
});
