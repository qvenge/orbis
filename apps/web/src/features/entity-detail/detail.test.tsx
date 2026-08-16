import { DAILY_PLANNING_BODY } from '@orbis/server/src/seed/smart-lists';
import { aspectJsonSchema, BUILTIN_ASPECT_IDS } from '@orbis/shared';
import { type BodyDoc, parseBody, serializeBody } from '@orbis/shared/doc';
import { onlineManager } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useNav } from '../../state/navigation';
import {
  installCrashTrap,
  type MockHandler,
  renderWithProviders,
  trpcError,
} from '../../test/harness';
import { trpc } from '../../trpc';
import { Toaster } from '../../ui/Toast';
import { queryBlocks } from '../browser/query';
import { AspectCards } from './AspectCards';
import { DetailScreen } from './DetailScreen';
import { detailGetInput } from './useEntityDetail';

// Экран монтирует редактор, NodeView'ы виджетов и меню в портале — обработчики событий, из
// которых брошенное jsdom гасит: ассерты остаются зелёными, а прогон падает кодом 1.
installCrashTrap();

/**
 * Пробник читает ТУ ЖЕ entity.get-запись из кэша (общий ключ detailGetInput) и рисует её без
 * локального стейта — то есть честно отражает финальное состояние кэша (React коалесцирует
 * optimistic+rollback в один коммит).
 *
 * Рисует ДОКУМЕНТ, а не markdown: оптимистичный патч кладёт в кэш `bodyDoc` и намеренно НЕ
 * трогает `body` — проекцию делает сервер, и только он (useEntityDetail.applyPatch). Пробник по
 * `body` остался бы зелёным при любом откате, потому что `body` не менялся никогда.
 */
function BodyProbe() {
  const q = trpc.entity.get.useQuery(detailGetInput('e1'));
  return <span data-testid="body-probe">{JSON.stringify(q.data?.entity.bodyDoc ?? null)}</span>;
}

/**
 * Неотправленный черновик прошлой сессии на диске: ключ — договор, поэтому выписан строкой.
 * Владелец в ключе — тот же, что у записи ниже: черновики скоупятся по нему (draft-storage).
 */
const DRAFT_KEY = 'orbis:body-draft:u:e1';

/**
 * `savedAt` — СЕГОДНЯШНИЙ, и это не украшение: у черновика есть срок жизни (30 дней), а прогон
 * идёт на настоящих часах. Фиксированная дата из прошлого делала бы эти тесты зелёными ровно до
 * того дня, когда она уйдёт за срок, — и дальше красными без единой правки кода.
 */
function seedDraft(doc: BodyDoc, baseUpdatedAt: string, rejected = false): void {
  localStorage.setItem(
    DRAFT_KEY,
    JSON.stringify({ doc, baseUpdatedAt, savedAt: new Date().toISOString(), rejected }),
  );
}

const entity = {
  id: 'e1',
  ownerId: 'u',
  title: 'Задача',
  emoji: null,
  body: 'тело',
  // `bodyDoc` — часть контракта detail: include просит его всегда, а сервер собирает документ
  // даже для записей без колонки (readBodyDoc). Без него экран не поднял бы редактор НИКОГДА —
  // и половина файла была бы зелена по причине, которой в проде не существует.
  bodyDoc: parseBody('тело'),
  bodyRefs: [],
  tags: ['work'],
  meta: {},
  aspects: { 'orbis/task': { status: 'inbox', priority: 'high' } },
  createdAt: '2026-07-05T00:00:00.000Z',
  updatedAt: '2026-07-05T10:00:00.000Z',
  archived: false,
};

beforeEach(() => {
  localStorage.clear();
  // requestIdleCallback, которого никто не дёрнет: редактор обязан вставать по ЖЕСТУ теста, а
  // не сам собой по запасному таймеру простоя (1500 мс) посреди чужого ожидания. jsdom своей
  // реализации не имеет, поэтому подмена именно ДОБАВЛЯЕТ ветку простоя — и она молчит
  // (приём editor.test.tsx). Тесты, которым редактор нужен, зовут openEditor().
  vi.stubGlobal('requestIdleCallback', () => 1);
  useNav.setState({
    activeTab: 'browser',
    stacks: { chat: [], browser: [{ kind: 'entity', id: 'e1' }], agenda: [], budget: [] },
  });
});

/**
 * Ожидания вокруг редактора — щедрее дефолтной секунды, и не «на всякий случай».
 *
 * Монтирование стоит ленивого чанка (~28 кБ gzip) и ПЕРВОЙ сборки схемы ProseMirror, а в полном
 * корневом прогоне web-файлы идут четырьмя воркерами параллельно с серверным сьютом против
 * локальной БД: ядра заняты, и дефолтная секунда означает уже не «дерево не готово», а
 * голодание по CPU. Замерено: под нагрузкой эти ожидания срывались. Точечный прогон от щедрого
 * порога не медленнее — ожидание завершается по факту, а не по таймеру (тот же приём, что
 * SIDES_LOADED в Blocks.test.tsx).
 */
const EDITOR_READY = { timeout: 10_000 };

/** Поднимает редактор касанием тела: ленивый чанк + первая сборка схемы ProseMirror. */
async function openEditor(): Promise<void> {
  fireEvent.click(await screen.findByTestId('editor-preview'));
  await screen.findByTestId('body-editor', undefined, EDITOR_READY);
}

/**
 * Ждёт текст В РЕДАКТОРЕ — и спрашивает коробку ЗАНОВО на каждой попытке.
 *
 * Держать найденный узел нельзя: `EditorContent` перемонтируется, когда `useEditor` отдаёт
 * экземпляр (у него key, завязанный на editor), и узел, найденный до этого, к моменту проверки
 * уже оторван от документа — ожидание на нём висит до самого таймаута и падает «текста нет».
 * Ловилось это не рассуждением: тест плавал ровно на этом (тот же урок в editor.test.tsx).
 */
async function expectEditorText(text: string): Promise<void> {
  await waitFor(
    () => expect(screen.getByTestId('body-editor')).toHaveTextContent(text),
    EDITOR_READY,
  );
}

/** Поле ввода редактора — тоже заново: см. expectEditorText. */
async function editorField(): Promise<HTMLElement> {
  await openEditor();
  const field = () => screen.getByTestId('body-editor').querySelector('[contenteditable]');
  await waitFor(() => expect(field()).not.toBeNull(), EDITOR_READY);
  return field() as HTMLElement;
}

/** Панель вкладки по её названию (Radix связывает панель с триггером через aria-labelledby). */
const tabPanel = (name: string): HTMLElement => screen.getByRole('tabpanel', { name });

test('чекбокс task → entity.update status=done + completed_at', async () => {
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get')
      return { entity, relations: [], thread: { threadId: 'th1', messages: [] } };
    if (path === 'entity.update')
      return { ...entity, aspects: { 'orbis/task': { status: 'done', completed_at: 'now' } } };
    if (path === 'aspect.list') return [];
    return {};
  });
  // Этап 3: title теперь и в ScreenHeader (h1), и в NativeRow — целимся в шапку.
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Задача' })).toBeInTheDocument());
  fireEvent.click(screen.getByRole('checkbox', { name: /готово/i }));
  await waitFor(() => {
    const c = calls.find((x) => x.path === 'entity.update');
    const input = c?.input as {
      id: string;
      aspects: { 'orbis/task': { status: string; completed_at?: unknown } };
    };
    expect(input.id).toBe('e1');
    expect(input.aspects['orbis/task'].status).toBe('done');
    expect(input.aspects['orbis/task'].completed_at).toBeTruthy();
  });
});

/*
 * Прежняя проверка «inline body-правка шлёт expectedUpdatedAt = точная строка updatedAt» ушла
 * вместе с самим путём: тело больше не сохраняется по blur из textarea, а уезжает
 * автосохранением по паузе — и `expectedUpdatedAt` там сложнее, чем «строка из кэша» (из двух
 * известных берётся поздняя). Проверяет это save.test.tsx («мутация уходит с bodyDoc и точным
 * expectedUpdatedAt из кэша» и «второе сохранение подряд берёт updatedAt из ответа сервера»).
 */

// Чужая правка, приехавшая под НЕтронутый редактор, обязана попасть на экран: иначе человек
// правил бы текст, которого в базе давно нет. Единственная проверка этого пути во всём сьюте —
// сам BodyEditor подменяет содержимое по приезду нового doc, и до Задачи 15 его никто не
// монтировал экраном.
test('нетронутый редактор подхватывает правку тела, приехавшую с сервера', async () => {
  let getCalls = 0;
  const outside = { ...entity, body: 'извне', bodyDoc: parseBody('извне'), updatedAt: 'B' };
  renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get') {
      getCalls += 1;
      return {
        entity: getCalls === 1 ? entity : outside,
        relations: [],
        thread: { threadId: 'th1', messages: [] },
      };
    }
    if (path === 'entity.update') return entity;
    if (path === 'aspect.list') return [];
    return {};
  });
  await openEditor();
  await expectEditorText('тело');

  // Чекбокс задачи → мутация → invalidate → рефетч с чужим телом; в редакторе не печатали.
  fireEvent.click(screen.getByRole('checkbox', { name: /готово/i }));
  await waitFor(() => expect(getCalls).toBeGreaterThan(1));
  await waitFor(
    () => expect(screen.getByTestId('body-editor')).toHaveTextContent('извне'),
    EDITOR_READY,
  );
});

test('набранное в редакторе переживает чужую правку, приехавшую под курсором', async () => {
  // Другая сторона той же границы: подмена содержимого идёт ТОЛЬКО когда редактор не в фокусе,
  // иначе чужая правка вырывала бы каретку и текст из-под рук (полноценное лечение — слияние,
  // Р13 дизайна). Без этого теста «подхватывает чужое» было бы зелено и у редактора, который
  // затирает набранное.
  let getCalls = 0;
  const outside = { ...entity, body: 'извне', bodyDoc: parseBody('извне'), updatedAt: 'B' };
  renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get') {
      getCalls += 1;
      return {
        entity: getCalls === 1 ? entity : outside,
        relations: [],
        thread: { threadId: 'th1', messages: [] },
      };
    }
    if (path === 'entity.update') return entity;
    if (path === 'aspect.list') return [];
    return {};
  });
  const field = await editorField();
  await userEvent.click(field);
  await userEvent.type(field, ' и хвост');
  await waitFor(
    () => expect(screen.getByTestId('body-editor')).toHaveTextContent('и хвост'),
    EDITOR_READY,
  );

  fireEvent.click(screen.getByRole('checkbox', { name: /готово/i }));
  await waitFor(() => expect(getCalls).toBeGreaterThan(1));
  // Даём подмене шанс случиться: «не затёрло» обязано значить «не затрёт», а не «не дождались».
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.getByTestId('body-editor')).toHaveTextContent('и хвост');
});

test('409 правки тела: откат кэша к прежнему body + alert «обновите»', async () => {
  // Правку тела в базу теперь отправляет «оставить моё» у баннера черновика — это единственный
  // путь, который шлёт мутацию НЕМЕДЛЕННО, без паузы набора, и потому годится для проверки
  // общей обвязки (откат оптимистичного патча + плашка конфликта) без подмены таймеров.
  seedDraft(parseBody('конфликтное'), 'СТАРАЯ-МЕТКА');
  let getCalls = 0;
  renderWithProviders(
    <>
      <DetailScreen entityId="e1" />
      <BodyProbe />
    </>,
    async (path) => {
      if (path === 'entity.get') {
        getCalls += 1;
        if (getCalls === 1)
          return { entity, relations: [], thread: { threadId: 'th1', messages: [] } };
        // 2-й get (рефетч после invalidate в onSettled) намеренно «зависает»: он НЕ даёт
        // независимого источника прежнего body, поэтому 'тело' в кэше — заслуга onError-отката
        // setData(ctx.prev), а не рефетча. Уберёшь откат — здесь останется 'конфликтное'.
        return new Promise(() => {});
      }
      if (path === 'entity.update') throw trpcError('CONFLICT');
      if (path === 'aspect.list') return [];
      return {};
    },
  );
  await screen.findByTestId('draft-banner');
  const probe = () => screen.getByTestId('body-probe').textContent ?? '';
  expect(probe()).toContain('тело');

  fireEvent.click(screen.getByRole('button', { name: 'Оставить моё' }));

  // (б) сообщение конфликта показано — и приходит оно из useBodySave, у которого своя обвязка
  // useEntityUpdate: до Задачи 15 баннер экрана слушал только правки заголовка и молчал бы.
  expect(await screen.findByText(/Изменено в другом месте — обновите/)).toBeInTheDocument();
  // (а) кэш откатился к прежнему документу: оптимистичный патч снят (снимок восстановлен).
  await waitFor(() => expect(probe()).not.toContain('конфликтное'));
  expect(probe()).toContain('тело');
});

// --- подзадачи читают связи из entity.get (D5d п.3) -------------------------------------
// Раньше секция дублировала чтение графа своим relation.listFor: та же выборка, второй
// сетевой запрос на каждое открытие detail. Инвалидация после создания переехала на тот
// же ключ entity.get — иначе созданная подзадача не появлялась бы в списке.

test('подзадачи: список из entity.get; после создания — рефетч того же ключа, без relation.listFor', async () => {
  let childId: string | null = null;
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, (path, input) => {
    if (path === 'entity.get') {
      const { id } = input as { id: string };
      // Титул подзадачи дочитывает EntityRef отдельным entity.get без include.
      if (id !== 'e1') return { entity: { ...entity, id, title: 'Купить молоко' } };
      return {
        entity,
        relations:
          childId === null
            ? []
            : [
                {
                  id: 'r1',
                  sourceId: 'e1',
                  targetId: childId,
                  relationType: 'parent',
                  meta: {},
                  createdAt: '2026-07-05T00:00:00.000Z',
                  updatedAt: '2026-07-05T00:00:00.000Z',
                },
              ],
        thread: { threadId: 'th1', messages: [] },
      };
    }
    if (path === 'entity.create') {
      const { input: created } = input as { input: { id: string; title: string } };
      return { ...entity, id: created.id, title: created.title };
    }
    if (path === 'relation.create') {
      childId = (input as { target_id: string }).target_id;
      return {
        id: 'r1',
        sourceId: 'e1',
        targetId: childId,
        relationType: 'parent',
        meta: {},
        createdAt: '2026-07-05T00:00:00.000Z',
        updatedAt: '2026-07-05T00:00:00.000Z',
      };
    }
    if (path === 'aspect.list') return [];
    return {};
  });
  await screen.findByRole('heading', { name: 'Задача' }); // экран отрисован; тело здесь ни при чём
  expect(screen.queryByTestId('subtask')).toBeNull();

  const field = screen.getByLabelText('Новая подзадача');
  fireEvent.change(field, { target: { value: 'Купить молоко' } });
  fireEvent.keyDown(field, { key: 'Enter' });

  expect(await screen.findByTestId('subtask')).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: 'Купить молоко' })).toBeInTheDocument();
  // Второе чтение той же выборки ушло: секция живёт на relations из entity.get.
  expect(calls.some((c) => c.path === 'relation.listFor')).toBe(false);
});

// DF п.5: секция не инвалидировала entity.query вовсе (долг D5d). С Повесткой
// (staleTime ≥ 60 с, K16) новая подзадача до минуты не видна ни в Browser, ни в Повестке.
const SUBTASK_PROBE = { query: 'aspect=orbis/task, status=!done, limit=10' };

function ListProbe() {
  const q = trpc.entity.query.useQuery(SUBTASK_PROBE);
  return <span data-testid="list-probe">{(q.data ?? []).length}</span>;
}

test('создание подзадачи инвалидирует entity.query (списки перечитываются)', async () => {
  const { calls } = renderWithProviders(
    <>
      <DetailScreen entityId="e1" />
      <ListProbe />
    </>,
    (path, input) => {
      if (path === 'entity.get') {
        const { id } = input as { id: string };
        if (id !== 'e1') return { entity: { ...entity, id, title: 'Купить молоко' } };
        return { entity, relations: [], thread: { threadId: 'th1', messages: [] } };
      }
      if (path === 'entity.create') {
        const { input: created } = input as { input: { id: string; title: string } };
        return { ...entity, id: created.id, title: created.title };
      }
      if (path === 'relation.create') {
        const { target_id } = input as { target_id: string };
        return {
          id: 'r1',
          sourceId: 'e1',
          targetId: target_id,
          relationType: 'parent',
          meta: {},
          createdAt: '2026-07-05T00:00:00.000Z',
          updatedAt: '2026-07-05T00:00:00.000Z',
        };
      }
      if (path === 'entity.query') return [];
      if (path === 'aspect.list') return [];
      return {};
    },
  );
  await screen.findByRole('heading', { name: 'Задача' }); // экран отрисован; тело здесь ни при чём
  const probes = () =>
    calls.filter(
      (c) =>
        c.path === 'entity.query' && (c.input as { query: string }).query === SUBTASK_PROBE.query,
    );
  await waitFor(() => expect(probes()).toHaveLength(1));

  const field = screen.getByLabelText('Новая подзадача');
  fireEvent.change(field, { target: { value: 'Купить молоко' } });
  fireEvent.keyDown(field, { key: 'Enter' });

  await waitFor(() => expect(probes().length).toBeGreaterThan(1));
});

// Частичный отказ: entity.create прошёл, relation.create упал. Задача СОЗДАНА, и списки
// обязаны её увидеть — иначе она не видна до истечения staleTime (60 с у Повестки), а
// тост «Не удалось сохранить» уверяет владельца, что ничего не создалось, и он жмёт ещё
// раз, плодя сироту (бэклог фазы D, ревью фикс-волны).
test('подзадача создана, а связь упала: списки инвалидируются, тост говорит правду', async () => {
  const { calls } = renderWithProviders(
    <>
      <DetailScreen entityId="e1" />
      <ListProbe />
      <Toaster />
    </>,
    (path, input) => {
      if (path === 'entity.get') {
        const { id } = input as { id: string };
        if (id !== 'e1') return { entity: { ...entity, id, title: 'Купить молоко' } };
        return { entity, relations: [], thread: { threadId: 'th1', messages: [] } };
      }
      if (path === 'entity.create') {
        const { input: created } = input as { input: { id: string; title: string } };
        return { ...entity, id: created.id, title: created.title };
      }
      if (path === 'relation.create') throw trpcError('INTERNAL_SERVER_ERROR');
      if (path === 'entity.query') return [];
      if (path === 'aspect.list') return [];
      return {};
    },
  );
  await screen.findByRole('heading', { name: 'Задача' }); // экран отрисован; тело здесь ни при чём
  const probes = () =>
    calls.filter(
      (c) =>
        c.path === 'entity.query' && (c.input as { query: string }).query === SUBTASK_PROBE.query,
    );
  await waitFor(() => expect(probes()).toHaveLength(1));

  const field = screen.getByLabelText('Новая подзадача');
  fireEvent.change(field, { target: { value: 'Купить молоко' } });
  fireEvent.keyDown(field, { key: 'Enter' });

  // Списки перечитываются: сущность в графе есть, и её обязано быть видно сразу.
  await waitFor(() => expect(probes().length).toBeGreaterThan(1));
  // Текст тоста не врёт про потерю записи: создана, но не привязана.
  expect(
    await screen.findByText(/создана, но не привязана — найдёте её в списке задач/i),
  ).toBeInTheDocument();
});

// --- inline-правка заголовка (DF п.3) --------------------------------------------------
// 02-core-os §2.7: «правка памяти = правка обычной сущности (title, поля аспекта, body)»,
// а вся машиночитаемая часть memory-правила живёт именно в title (K19.4) — до этого
// правки title в web не было ни в одной точке, и экран «Память AI» обещал невозможное.
// Контракт тот же, что у body и полей аспектов: optimistic + expectedUpdatedAt, внешнее
// значение подхватывается только на нетронутом черновике.

test('inline правка заголовка уходит в entity.update с новым title', async () => {
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get')
      return { entity, relations: [], thread: { threadId: 'th1', messages: [] } };
    if (path === 'entity.update') return { ...entity, title: 'кофе → Транспорт' };
    if (path === 'aspect.list') return [];
    return {};
  });
  const field = await screen.findByLabelText('Заголовок');
  fireEvent.change(field, { target: { value: 'кофе → Транспорт' } });
  fireEvent.blur(field);

  await waitFor(() => {
    const c = calls.find(
      (x) => x.path === 'entity.update' && (x.input as { title?: string }).title !== undefined,
    );
    expect(c?.input).toEqual({
      id: 'e1',
      title: 'кофе → Транспорт',
      expectedUpdatedAt: '2026-07-05T10:00:00.000Z',
    });
  });
});

/** Обработчик, у которого entity.get после первого чтения отдаёт ЧУЖОЙ заголовок. */
function externalTitleChange(): { handler: MockHandler; getCalls: () => number } {
  let getCalls = 0;
  const renamed = {
    ...entity,
    title: 'Переименована извне',
    updatedAt: '2026-07-05T11:00:00.000Z',
  };
  return {
    getCalls: () => getCalls,
    handler: (path) => {
      if (path === 'entity.get') {
        getCalls += 1;
        return {
          entity: getCalls === 1 ? entity : renamed,
          relations: [],
          thread: { threadId: 'th1', messages: [] },
        };
      }
      if (path === 'entity.update') return renamed;
      if (path === 'aspect.list') return [];
      return {};
    },
  };
}

test('незакоммиченный ввод в заголовок переживает внешнее изменение', async () => {
  const { handler, getCalls } = externalTitleChange();
  renderWithProviders(<DetailScreen entityId="e1" />, handler);
  const field = await screen.findByLabelText('Заголовок');
  // Печатаем, но НЕ сохраняем (blur не было)
  fireEvent.change(field, { target: { value: 'кофе → Тра' } });

  fireEvent.click(screen.getByRole('checkbox', { name: /готово/i }));
  await waitFor(() => expect(getCalls()).toBeGreaterThan(1)); // рефетч с чужим title пришёл
  expect(screen.getByLabelText('Заголовок')).toHaveValue('кофе → Тра');
});

test('нетронутый заголовок подхватывает переименование с сервера', async () => {
  const { handler } = externalTitleChange();
  renderWithProviders(<DetailScreen entityId="e1" />, handler);
  expect(await screen.findByLabelText('Заголовок')).toHaveValue('Задача');

  fireEvent.click(screen.getByRole('checkbox', { name: /готово/i }));
  await waitFor(() =>
    expect(screen.getByLabelText('Заголовок')).toHaveValue('Переименована извне'),
  );
});

// --- поле аспекта и внешние изменения значения (D6c п.3) -------------------------------
// Смоук D6b: после перевода задачи в «Готово» чекбоксом поле «статус» продолжало
// показывать inbox — AspectField держал значение в useState(initial) без синхронизации.
// Политика — та же, что у BodyEditor: внешнее значение подхватывается, пока черновик
// не трогали; набранный текст наивным useEffect'ом не затирается.

/** Обработчик, у которого entity.get после первого чтения отдаёт `done`. */
function externalStatusChange(): { handler: MockHandler; getCalls: () => number } {
  let getCalls = 0;
  const done = {
    ...entity,
    aspects: { 'orbis/task': { status: 'done', priority: 'high' } },
    updatedAt: '2026-07-05T11:00:00.000Z',
  };
  return {
    getCalls: () => getCalls,
    handler: (path) => {
      if (path === 'entity.get') {
        getCalls += 1;
        return {
          entity: getCalls === 1 ? entity : done,
          relations: [],
          thread: { threadId: 'th1', messages: [] },
        };
      }
      if (path === 'entity.update') return done;
      if (path === 'aspect.list') return [];
      return {};
    },
  };
}

test('поле аспекта подхватывает внешнее изменение значения (статус после чекбокса)', async () => {
  const { handler } = externalStatusChange();
  renderWithProviders(<DetailScreen entityId="e1" />, handler);
  const field = await screen.findByLabelText('orbis/task status');
  expect(field).toHaveValue('inbox');

  fireEvent.click(screen.getByRole('checkbox', { name: /готово/i }));
  await waitFor(() => expect(screen.getByLabelText('orbis/task status')).toHaveValue('done'));
});

test('незакоммиченный ввод в поле аспекта переживает внешнее изменение', async () => {
  const { handler, getCalls } = externalStatusChange();
  renderWithProviders(<DetailScreen entityId="e1" />, handler);
  const field = await screen.findByLabelText('orbis/task status');
  // Печатаем, но НЕ сохраняем (blur не было) — правка пользователя ещё жива
  fireEvent.change(field, { target: { value: 'in_progress' } });

  fireEvent.click(screen.getByRole('checkbox', { name: /готово/i }));
  await waitFor(() => expect(getCalls()).toBeGreaterThan(1)); // рефетч с чужим статусом пришёл
  expect(screen.getByLabelText('orbis/task status')).toHaveValue('in_progress');
});

// --- пикер категории для financial-сущности (sign-off владельца K6, D3b) ---------------
// До D3b единственным способом сменить категорию на detail был свободный ввод UUID.

const CAT_FOOD = 'a3d6d4b2-7f3a-4a1f-9c1e-2d5b8f0a1c77';
const CAT_FUN = 'b8e1c9a4-2d5e-4c3b-8f7a-1e9d0c2b3a55';

const finEntity = {
  ...entity,
  title: 'Кофе Хауз',
  aspects: {
    'orbis/financial': {
      amount: '340.00',
      currency: 'RUB',
      direction: 'expense',
      occurred_on: '2026-07-20',
      category_ref: CAT_FOOD,
    },
  },
};

const category = (id: string, title: string) => ({
  id,
  ownerId: 'u',
  title,
  emoji: null,
  body: '',
  bodyRefs: [],
  tags: [],
  meta: {},
  aspects: { 'orbis/category': {} },
  createdAt: 'x',
  updatedAt: 'y',
  archived: false,
});

const finHandler = (path: string) => {
  if (path === 'entity.get')
    return { entity: finEntity, relations: [], thread: { threadId: 'th1', messages: [] } };
  if (path === 'entity.query') return [category(CAT_FOOD, 'Еда'), category(CAT_FUN, 'Развлечения')];
  if (path === 'entity.update') return finEntity;
  if (path === 'aspect.list') return [];
  return {};
};

test('financial: category_ref — выбор из категорий с названиями, а не UUID в инпуте', async () => {
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, finHandler);
  const select = await screen.findByLabelText('orbis/financial category_ref');
  expect(select.tagName).toBe('SELECT');
  await screen.findByRole('option', { name: 'Развлечения' });
  // Показано НАЗВАНИЕ выбранной категории (displayValue у select — текст выбранной опции)
  expect(select).toHaveDisplayValue('Еда');
  // Список категорий берётся тем же запросом, что и экраны Budget (один кэш)
  expect(calls.find((c) => c.path === 'entity.query')?.input).toEqual({
    query: 'aspect=orbis/category, sortBy=title:asc, limit=200',
  });
});

test('financial: выбор категории шлёт entity.update с новым category_ref', async () => {
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, finHandler);
  const select = await screen.findByLabelText('orbis/financial category_ref');
  await screen.findByRole('option', { name: 'Развлечения' }); // список категорий доехал
  fireEvent.change(select, { target: { value: CAT_FUN } });
  await waitFor(() => {
    const c = calls.find((x) => x.path === 'entity.update');
    expect(c?.input).toEqual({
      id: 'e1',
      expectedUpdatedAt: '2026-07-05T10:00:00.000Z',
      aspects: { 'orbis/financial': { category_ref: CAT_FUN } },
    });
  });
});

// D5c п.4: упавший запрос списка и живая ссылка на исчезнувшую категорию — РАЗНЫЕ беды.
// Общий текст «Категория не найдена» на отказе сети врал бы про целую транзакцию, что
// связь с категорией потеряна (приём RolloverScreen: ветка isError отдельно от пустоты).
test('financial: запрос категорий упал → «Не удалось загрузить категории», а не «не найдена»', async () => {
  renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get')
      return { entity: finEntity, relations: [], thread: { threadId: 'th1', messages: [] } };
    if (path === 'entity.query') throw trpcError('INTERNAL_SERVER_ERROR');
    if (path === 'aspect.list') return [];
    return {};
  });
  const select = await screen.findByLabelText('orbis/financial category_ref');
  await waitFor(() => expect(select).toHaveDisplayValue('Не удалось загрузить категории'));
  expect(select).not.toHaveDisplayValue('Категория не найдена');
});

test('financial: список пришёл, а ссылка ведёт мимо него → «Категория не найдена»', async () => {
  const orphan = {
    ...finEntity,
    aspects: {
      'orbis/financial': { ...finEntity.aspects['orbis/financial'], category_ref: 'gone' },
    },
  };
  renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get')
      return { entity: orphan, relations: [], thread: { threadId: 'th1', messages: [] } };
    if (path === 'entity.query')
      return [category(CAT_FOOD, 'Еда'), category(CAT_FUN, 'Развлечения')];
    if (path === 'aspect.list') return [];
    return {};
  });
  const select = await screen.findByLabelText('orbis/financial category_ref');
  await screen.findByRole('option', { name: 'Развлечения' }); // список доехал целым
  expect(select).toHaveDisplayValue('Категория не найдена');
});

// D5d п.5: три дефекта одной цепочки подписи «своей» опции пикера.

// (а) пустой category_ref — не «беда со списком»: подпись «Без категории» обязана
// пережить упавший запрос, иначе транзакция без категории выглядит как сломанная связь.
test('financial: без категории при упавшем запросе — «Без категории», а не отказ', async () => {
  const noCategory = {
    ...finEntity,
    aspects: { 'orbis/financial': { ...finEntity.aspects['orbis/financial'], category_ref: '' } },
  };
  renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get')
      return { entity: noCategory, relations: [], thread: { threadId: 'th1', messages: [] } };
    if (path === 'entity.query') throw trpcError('INTERNAL_SERVER_ERROR');
    if (path === 'aspect.list') return [];
    return {};
  });
  const select = await screen.findByLabelText('orbis/financial category_ref');
  await waitFor(() => expect(select).toHaveDisplayValue('Без категории'));
});

// (б) v5 сохраняет data при ошибке РЕФЕТЧА: список категорий известен целиком, и
// «Не удалось загрузить категории» врало бы — ссылка действительно ведёт в никуда.
test('financial: рефетч списка упал, но список уже есть → «Категория не найдена»', async () => {
  let queries = 0;
  const orphan = {
    ...finEntity,
    aspects: {
      'orbis/financial': { ...finEntity.aspects['orbis/financial'], category_ref: 'gone' },
    },
  };
  renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get')
      return { entity: orphan, relations: [], thread: { threadId: 'th1', messages: [] } };
    if (path === 'entity.query') {
      queries += 1;
      if (queries === 1) return [category(CAT_FOOD, 'Еда'), category(CAT_FUN, 'Развлечения')];
      throw trpcError('INTERNAL_SERVER_ERROR');
    }
    if (path === 'entity.update') return orphan;
    if (path === 'aspect.list') return [];
    return {};
  });
  const select = await screen.findByLabelText('orbis/financial category_ref');
  await screen.findByRole('option', { name: 'Развлечения' }); // список доехал целым
  // Любая правка сущности инвалидирует entity.query (useEntityUpdate.onSettled) — рефетч
  // падает, но data остаётся: state = error + непустой список. Правка берётся самая дешёвая из
  // доступных у финансовой записи (чекбокса задачи у неё нет): переименование идёт той же
  // обвязкой useEntityUpdate и точно так же инвалидирует списки.
  const title = screen.getByLabelText('Заголовок');
  fireEvent.change(title, { target: { value: 'Кофе Хауз 2' } });
  fireEvent.blur(title);

  await waitFor(() => expect(queries).toBeGreaterThan(1));
  expect(select).toHaveDisplayValue('Категория не найдена');
});

// (в) офлайн-пауза: fetchStatus='paused' даёт isLoading===false при status='pending' —
// по isLoading подпись срывалась в «Категория не найдена» на целой транзакции.
test('financial: офлайн-пауза списка категорий — «Загрузка…», а не «Категория не найдена»', async () => {
  onlineManager.setOnline(false);
  try {
    renderWithProviders(<AspectCards entity={finEntity} />, finHandler);
    const select = await screen.findByLabelText('orbis/financial category_ref');
    expect(select).toHaveDisplayValue('Загрузка…');
  } finally {
    onlineManager.setOnline(true);
  }
});

test('нефинансовая сущность: поля прежние (инпут), список категорий не запрашивается', async () => {
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get')
      return { entity, relations: [], thread: { threadId: 'th1', messages: [] } };
    if (path === 'entity.update') return entity;
    if (path === 'aspect.list') return [];
    return {};
  });
  const field = await screen.findByLabelText('orbis/task status');
  expect(field.tagName).toBe('INPUT');
  expect(calls.some((c) => c.path === 'entity.query')).toBe(false);
});

// --- query-блоки body (02-core-os §3.4) ------------------------------------------------
// Реестр аспектов — настоящий (schema из @orbis/shared), поэтому каталог полей грамматики
// в тесте тот же, что в проде: битая клауза упала бы плашкой qb-error, а не молча.
const realAspects = BUILTIN_ASPECT_IDS.map((id) => ({ id, schema: aspectJsonSchema(id) }));
const found = (title: string) => ({
  id: title,
  ownerId: 'u',
  title,
  emoji: null,
  body: '',
  bodyRefs: [],
  tags: [],
  meta: {},
  aspects: {},
  createdAt: 'x',
  updatedAt: 'y',
  archived: false,
});

// §3.4 нормирует: «Каждый {{query:...}}-блок в body рендерится виджетом». Это же условие —
// продуктовая половина приёмки 02-core-os §8.4 («задача видна в Daily Planning»): список
// «Сегодня» — ВТОРОЙ блок сида, и при рендере только первого он недостижим в UI.
// Body берётся из самого сида (@orbis/server/src/seed/smart-lists) — дрейф невозможен.
test('detail рендерит КАЖДЫЙ query-блок body: у Daily Planning — три секции, включая «Сегодня»', async () => {
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, (path, input) => {
    if (path === 'entity.get')
      return {
        entity: { ...entity, title: 'Daily Planning', body: DAILY_PLANNING_BODY, aspects: {} },
        relations: [],
        thread: null,
      };
    if (path === 'aspect.list') return realAspects;
    if (path === 'entity.query') {
      // Задача из приёмки §8.4: срок сегодня, статус in_progress — попадает ровно в «Сегодня».
      const q = (input as { query: string }).query;
      return q.includes('due_date=today|overdue') ? [found('Разобрать Inbox')] : [];
    }
    return {};
  });

  // Три виджета — по одному на блок, каждый со своим заголовком из title= (§3.4).
  await waitFor(() => expect(screen.getAllByTestId('qb-count')).toHaveLength(3));
  expect(screen.queryByTestId('qb-error')).not.toBeInTheDocument();
  for (const section of ['Inbox', 'Сегодня', 'Ожидание']) {
    expect(screen.getByText(section)).toBeInTheDocument();
  }

  // В entity.query ушли ВСЕ три блока дословно (inner каждого блока body).
  const sent = calls
    .filter((c) => c.path === 'entity.query')
    .map((c) => (c.input as { query: string }).query);
  expect([...sent].sort()).toEqual([...queryBlocks(DAILY_PLANNING_BODY)].sort());

  // …и результат «Сегодня» виден на экране — та самая половина §8.4, которой при рендере
  // одного лишь первого блока (Inbox) в продукте не существовало.
  await waitFor(() => expect(screen.getByTestId('qb-item')).toHaveTextContent('Разобрать Inbox'));
});

// --- меню ⋮ на detail: закрепить / архивировать / скопировать ссылку (§3.5) ------------
// До слайса 3 «меню ⋮» из §3.5 было двумя icon-кнопками в шапке, а обещанного пункта
// «Скопировать ссылку» не существовало вовсе. Теперь это настоящее меню, и оба прежних
// действия живут внутри него. Форму пути даёт buildAppPath (B1) — руками её не собирают
// ни здесь, ни в экране, иначе ссылка разъедется с роутером при первом же изменении.

// Radix позиционирует меню через floating-ui, а тот следит за размерами якоря
// ResizeObserver'ом — в jsdom его нет вовсе, и без заглушки открытие меню падает на
// конструкторе. Заглушка молчит намеренно: раскладку в jsdom всё равно не проверить,
// проверяется только то, что содержимое меню смонтировалось.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

const LINK_E1 = `${window.location.origin}/entity/e1`;

/** jsdom не реализует Clipboard API: свойства navigator.clipboard нет вовсе. */
function stubClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

afterEach(() => {
  // Возвращаем окружение к исходному «Clipboard API нет» — иначе подмена течёт в тесты,
  // которые как раз проверяют отсутствие буфера.
  delete (navigator as unknown as { clipboard?: unknown }).clipboard;
});

/**
 * Открывает меню ⋮ с клавиатуры, а не кликом: Radix открывает меню по pointerdown, а
 * jsdom не реализует PointerEvent, поэтому fireEvent.click по триггеру не открыл бы
 * ничего. Заодно это проверка того, что меню достижимо без мыши.
 */
async function openDetailMenu(): Promise<void> {
  fireEvent.keyDown(await screen.findByTestId('detail-menu'), { key: 'Enter' });
  await screen.findByRole('menu');
}

const menuHandler: MockHandler = (path) => {
  if (path === 'entity.get')
    return { entity, relations: [], thread: { threadId: 'th1', messages: [] } };
  if (path === 'entity.update') return entity;
  if (path === 'aspect.list') return [];
  return {};
};

test('меню ⋮: «Скопировать ссылку» кладёт абсолютный адрес сущности в буфер', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  stubClipboard(writeText);
  renderWithProviders(
    <>
      <DetailScreen entityId="e1" />
      <Toaster />
    </>,
    menuHandler,
  );
  await openDetailMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Скопировать ссылку' }));

  await waitFor(() => expect(writeText).toHaveBeenCalledWith(LINK_E1));
  // Успех не молчит: без подтверждения непонятно, легло ли что-нибудь в буфер.
  expect(await screen.findByText('Ссылка скопирована')).toBeInTheDocument();
});

test('меню ⋮: отказ буфера показывает ссылку текстом, а не молчит', async () => {
  stubClipboard(() => Promise.reject(new Error('NotAllowedError')));
  renderWithProviders(
    <>
      <DetailScreen entityId="e1" />
      <Toaster />
    </>,
    menuHandler,
  );
  await openDetailMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Скопировать ссылку' }));

  // Ссылка доступна целиком и её можно выделить — иначе отказ равносилен молчанию.
  const field = await screen.findByLabelText('Ссылка на сущность');
  expect(field).toHaveValue(LINK_E1);
});

test('меню ⋮: Clipboard API нет вовсе (небезопасный контекст) — та же ссылка текстом', async () => {
  // navigator.clipboard в jsdom отсутствует; НИЧЕГО не подменяем — это и есть проверка.
  expect(navigator.clipboard).toBeUndefined();
  renderWithProviders(<DetailScreen entityId="e1" />, menuHandler);
  await openDetailMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Скопировать ссылку' }));

  expect(await screen.findByLabelText('Ссылка на сущность')).toHaveValue(LINK_E1);
});

/**
 * Как роутер: `<DetailScreen entityId={top.id} />` монтируется БЕЗ key (router.tsx),
 * поэтому переход entity→entity внутри таба (бэклинк, подзадача, блокировка) меняет
 * только проп — инстанс тот же, состояние экрана переживает переход.
 */
function DetailHost() {
  const [id, setId] = useState('e1');
  return (
    <>
      <button type="button" data-testid="go-e2" onClick={() => setId('e2')}>
        на e2
      </button>
      <DetailScreen entityId={id} />
    </>
  );
}

const twoEntitiesHandler: MockHandler = (path, input) => {
  if (path === 'entity.get') {
    const { id } = input as { id: string };
    return {
      entity: { ...entity, id, title: id === 'e1' ? 'Задача' : 'Другая' },
      relations: [],
      thread: null,
    };
  }
  if (path === 'entity.update') return entity;
  if (path === 'aspect.list') return [];
  return {};
};

test('меню ⋮: плашка с ручной ссылкой не переезжает на другую сущность', async () => {
  stubClipboard(() => Promise.reject(new Error('NotAllowedError')));
  renderWithProviders(<DetailHost />, twoEntitiesHandler);
  await openDetailMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Скопировать ссылку' }));
  expect(await screen.findByLabelText('Ссылка на сущность')).toHaveValue(LINK_E1);

  // Переход по бэклинку/подзадаче внутри таба: перемонтирования нет, меняется проп.
  fireEvent.click(screen.getByTestId('go-e2'));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Другая' })).toBeInTheDocument());

  // Ссылка на СОСЕДНЮЮ сущность под заголовком этой — молча неверные данные ровно там,
  // где заведён честный запасной путь. Плашки быть не должно вовсе.
  expect(screen.queryByLabelText('Ссылка на сущность')).toBeNull();
});

test('меню ⋮: плашка с ручной ссылкой уходит по «Скрыть»', async () => {
  stubClipboard(() => Promise.reject(new Error('NotAllowedError')));
  renderWithProviders(<DetailScreen entityId="e1" />, menuHandler);
  await openDetailMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Скопировать ссылку' }));
  await screen.findByLabelText('Ссылка на сущность');

  fireEvent.click(screen.getByRole('button', { name: 'Скрыть' }));
  expect(screen.queryByLabelText('Ссылка на сущность')).toBeNull();
});

test('меню ⋮: удавшееся копирование убирает плашку прошлого отказа', async () => {
  // Разрешение сперва не дали, потом дали: плашка не должна остаться висеть рядом
  // с тостом «Ссылка скопирована» — она утверждала бы, что буфер по-прежнему не работает.
  const writeText = vi
    .fn()
    .mockRejectedValueOnce(new Error('NotAllowedError'))
    .mockResolvedValue(undefined);
  stubClipboard(writeText);
  renderWithProviders(
    <>
      <DetailScreen entityId="e1" />
      <Toaster />
    </>,
    menuHandler,
  );
  await openDetailMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Скопировать ссылку' }));
  await screen.findByLabelText('Ссылка на сущность');

  await openDetailMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Скопировать ссылку' }));

  expect(await screen.findByText('Ссылка скопирована')).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByLabelText('Ссылка на сущность')).toBeNull());
});

test('меню ⋮: «Закрепить» шлёт user.updateSettings с этой сущностью', async () => {
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, menuHandler);
  await openDetailMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Закрепить' }));

  await waitFor(() => {
    const c = calls.find((x) => x.path === 'user.updateSettings');
    expect(c?.input).toEqual({ pinnedEntities: [{ id: 'e1', order: 0 }] });
  });
});

test('меню ⋮: «Архивировать» шлёт entity.update archived=true', async () => {
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, menuHandler);
  await openDetailMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Архивировать' }));

  await waitFor(() => {
    const c = calls.find((x) => x.path === 'entity.update');
    expect(c?.input).toEqual({ id: 'e1', archived: true });
  });
});

test('меню ⋮: у архивной сущности пункт зовётся «Разархивировать» и снимает архив', async () => {
  const archived = { ...entity, archived: true };
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get') return { entity: archived, relations: [], thread: null };
    if (path === 'entity.update') return archived;
    if (path === 'aspect.list') return [];
    return {};
  });
  await openDetailMenu();
  expect(screen.queryByRole('menuitem', { name: 'Архивировать' })).toBeNull();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Разархивировать' }));

  await waitFor(() => {
    const c = calls.find((x) => x.path === 'entity.update');
    expect(c?.input).toEqual({ id: 'e1', archived: false });
  });
});

test('conflict-баннер: клик «Обновить» → refetch entity.get + баннер скрыт', async () => {
  // Конфликт поднимает правка ТЕЛА — единственная, чью версию сервер вообще сверяет (гейт §5.2
  // стоит под `body !== undefined || bodyDoc !== undefined`, executor.ts). У тела своя обвязка
  // внутри useBodySave, и баннер экрана обязан слушать оба источника: иначе он не зажигался бы
  // никогда, а «Обновить» гасило бы чужую тревогу.
  seedDraft(parseBody('конфликтное'), 'СТАРАЯ-МЕТКА');
  const calls: string[] = [];
  renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    calls.push(path);
    if (path === 'entity.get')
      return { entity, relations: [], thread: { threadId: 'th1', messages: [] } };
    if (path === 'entity.update') throw trpcError('CONFLICT');
    if (path === 'aspect.list') return [];
    return {};
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Оставить моё' }));
  await screen.findByText(/Изменено в другом месте — обновите/);

  const getsBefore = calls.filter((p) => p === 'entity.get').length;
  fireEvent.click(screen.getByRole('button', { name: 'Обновить' }));

  // Баннер снят немедленно (обе dismissConflict), рефетч ушёл на сервер.
  await waitFor(() =>
    expect(screen.queryByText(/Изменено в другом месте — обновите/)).not.toBeInTheDocument(),
  );
  await waitFor(() =>
    expect(calls.filter((p) => p === 'entity.get').length).toBeGreaterThan(getsBefore),
  );
});

// --- body: первый кадр и редактор по касанию (C4b + двухфазность Задачи 11) -------------
// 02-core-os §3.5 п.4 и мокап §3.5 описывают тело единым редактором, а `body` — его
// markdown-проекцией; ею тесты ниже и кормят экран. С Задачи 15 первый кадр рисует
// EditorShell, а редактор встаёт по касанию тела или по простою; сырого textarea на экране
// нет вовсе.

const BODY_LINK_ID = '019e4466-1111-7000-8000-0123456789ab';

/** Обработчик detail с заданным телом; документ собирается из того же markdown. */
const bodyHandler =
  (body: string): MockHandler =>
  (path) => {
    if (path === 'entity.get')
      return { entity: { ...entity, body, bodyDoc: parseBody(body) }, relations: [], thread: null };
    if (path === 'entity.update') return { ...entity, updatedAt: '2026-07-05T11:00:00.000Z' };
    if (path === 'aspect.list') return realAspects;
    if (path === 'entity.query') return [found('Разобрать Inbox')];
    return {};
  };

test('body показан разметкой, а не сырым текстом: правка не навязана', async () => {
  renderWithProviders(<DetailScreen entityId="e1" />, bodyHandler('## Итоги\n\n- раз\n- два'));
  await screen.findByTestId('editor-preview');
  expect(screen.getByRole('heading', { level: 2, name: 'Итоги' })).toBeInTheDocument();
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  // Сырого markdown на экране нет, и редактор не смонтирован, пока его не позвали.
  expect(screen.queryByText('## Итоги')).toBeNull();
  expect(screen.queryByTestId('body-editor')).toBeNull();
});

test('клик по телу поднимает редактор поверх первого кадра — с тем же текстом', async () => {
  // Первое монтирование редактора ЭКРАНОМ: до Задачи 15 ни один экран его не монтировал вовсе,
  // и вся двухфазность проверялась только на самом EditorShell.
  renderWithProviders(<DetailScreen entityId="e1" />, bodyHandler('тело записи'));
  await openEditor();
  await expectEditorText('тело записи');
  expect(screen.queryByTestId('editor-preview')).toBeNull();
});

test('[[entity:…]] в body — живая ссылка: клик открывает запись в АКТИВНОЙ вкладке', async () => {
  renderWithProviders(
    <DetailScreen entityId="e1" />,
    bodyHandler(`см. [[entity:${BODY_LINK_ID}]]`),
  );
  const link = await screen.findByRole('link');
  expect(link).toHaveAttribute('href', `/entity/${BODY_LINK_ID}`);

  fireEvent.click(link);

  // push поверх стека текущей вкладки (openEntity), а не openDeepLink: стек Browser цел.
  const nav = useNav.getState();
  expect(nav.activeTab).toBe('browser');
  expect(nav.stacks.browser).toEqual([
    { kind: 'entity', id: 'e1' },
    { kind: 'entity', id: BODY_LINK_ID },
  ]);
});

test('клик по ссылке в теле редактор НЕ поднимает', async () => {
  renderWithProviders(
    <DetailScreen entityId="e1" />,
    bodyHandler(`см. [[entity:${BODY_LINK_ID}]]`),
  );
  fireEvent.click(await screen.findByRole('link'));
  // Два жеста на одном месте: ссылка обязана срабатывать ссылкой, а не подменять поддерево
  // редактором — тогда click до самой ссылки не доехал бы.
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByTestId('body-editor')).toBeNull();
  expect(screen.getByTestId('editor-preview')).toBeInTheDocument();
});

test('пустой body — приглашение «Заметки…», по клику встаёт редактор', async () => {
  renderWithProviders(<DetailScreen entityId="e1" />, bodyHandler(''));
  const view = await screen.findByTestId('editor-preview');
  expect(view).toHaveTextContent('Заметки…');

  fireEvent.click(view);
  await screen.findByTestId('body-editor');
});

test('тело из одного {{query:…}} — «Заметки…» над живым списком не печатается', async () => {
  // Так устроен сидированный All Tasks: текста в body нет, но смотреть есть на что. Пустым
  // тело при этом не является, и приглашение к вводу над списком задач — просто мусор,
  // который видно каждый день.
  renderWithProviders(
    <DetailScreen entityId="e1" />,
    bodyHandler('{{query: aspect=orbis/task, status=inbox, title=Inbox}}'),
  );
  await screen.findByTestId('qb-count');
  expect(screen.getByTestId('editor-preview')).not.toHaveTextContent('Заметки…');
  expect(screen.getByText('Inbox')).toBeInTheDocument();
});

/*
 * «В правку можно войти с клавиатуры: кнопка „Редактировать“» — теста больше нет вместе с самой
 * кнопкой. Клавиатурный путь у нового тела ДРУГОЙ и шире: редактор встаёт сам по простою
 * (requestIdleCallback, EditorShell), то есть до него доходят табом как до обычного поля ввода,
 * не нажимая ничего. Кнопка над каждой заметкой была ценой прежнего режима «просмотр/правка»,
 * которого не осталось. Сам механизм простоя проверяет editor.test.tsx («простой монтирует
 * редактор без всякого касания» и «без requestIdleCallback редактор встаёт по запасному
 * таймеру»); здесь он намеренно выключен заглушкой, чтобы дерево не менялось само.
 */

test('клик по выделенному тексту тела редактор не поднимает', async () => {
  renderWithProviders(<DetailScreen entityId="e1" />, bodyHandler('тело записи'));
  const view = await screen.findByTestId('editor-preview');
  const selection = vi
    .spyOn(window, 'getSelection')
    .mockReturnValue({ isCollapsed: false } as Selection);
  try {
    fireEvent.click(view);
    // Текст выделяют, чтобы скопировать; подмена первого кадра редактором меняет корень
    // поддерева, и выделение теряется вместе с ним.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('body-editor')).toBeNull();
  } finally {
    selection.mockRestore();
  }
});

const BODY_WITH_BLOCK = 'Утренний обзор\n\n{{query: aspect=orbis/task, status=inbox, title=Inbox}}';
const BODY_TEXT_BLOCK_TEXT = `${BODY_WITH_BLOCK}\n\nи хвост после блока`;

/** b стоит в документе ПОСЛЕ a. */
function follows(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

// Главное видимое свойство ПЕРВОГО КАДРА: виджет стоит МЕЖДУ своими абзацами, как он стоит в
// body. Раскладка «весь текст, потом все виджеты» была бы возвратом к тому, от чего работа и
// уходила, — и юнит-тест сегментации этого не поймал бы: порядок сегментов он видит, а порядок
// узлов НА ЭКРАНЕ — нет.
test('порядок сегментов сохраняется: текст → виджет → текст', async () => {
  renderWithProviders(<DetailScreen entityId="e1" />, bodyHandler(BODY_TEXT_BLOCK_TEXT));
  await screen.findByTestId('qb-count');
  const intro = screen.getByText('Утренний обзор');
  const widget = screen.getByText('Inbox'); // заголовок виджета из title=
  const tail = screen.getByText('и хвост после блока');

  expect(follows(intro, widget)).toBe(true);
  expect(follows(widget, tail)).toBe(true);
});

test('{{query:…}} в первый кадр текстом не течёт: текст — разметкой, блок — виджетом', async () => {
  renderWithProviders(<DetailScreen entityId="e1" />, bodyHandler(BODY_WITH_BLOCK));
  await screen.findByTestId('qb-count');
  expect(screen.getByText('Утренний обзор')).toBeInTheDocument();
  expect(screen.getByText('Inbox')).toBeInTheDocument();
  expect(screen.queryByText(/\{\{query:/)).toBeNull();
  expect(screen.queryByTestId('qb-error')).toBeNull();
});

test('клик по виджету query-блока редактор не поднимает', async () => {
  renderWithProviders(<DetailScreen entityId="e1" />, bodyHandler(BODY_WITH_BLOCK));
  fireEvent.click(await screen.findByTestId('qb-item'));
  // Виджет — живой список, а не текст записи: подменять его редактором по клику значит
  // ронять экран смарт-листа (у All Tasks весь body — один блок).
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByTestId('body-editor')).toBeNull();
});

// --- две живые правки одной записи (ревью Задачи 14, Н-2 и Н-3) -----------------------------
//
// Прежде обе проверки жили на `useEntityDetail.saveBody` — методе, которого не звал НИКТО,
// кроме них самих (ревью раунда 3): тело уехало на автосохранение ещё в Задаче 13, а `saveBody`
// остался и держал два теста зелёными на пути, которого в проде нет. Метод удалён, а сами
// сюжеты переписаны на достижимые: правку тела шлёт «Оставить моё» у баннера черновика —
// единственный путь, отправляющий её НЕМЕДЛЕННО, без паузы набора.
//
// Сюжеты от этого стали ТОЧНЕЕ, а не слабее. 409 приносит только правка тела (сервер сверяет
// версию под гейтом `body !== undefined || bodyDoc !== undefined`, executor.ts), и у неё своя
// обвязка `useEntityUpdate` — внутри `useBodySave`, отдельная от той, через которую идут
// заголовок, чекбокс и архивация. Проверяется теперь ровно то, что видит человек: зажжённая
// плашка не гаснет от чужого успеха, чем бы тот ни был.

/** Обработчик: правку ТЕЛА отвергает по версии, всё остальное принимает. */
function bodyConflictHandler(seen: unknown[]): MockHandler {
  return (path, input) => {
    if (path === 'entity.get')
      return { entity, relations: [], thread: { threadId: 'th1', messages: [] } };
    if (path === 'entity.update') {
      seen.push(input);
      if ((input as { bodyDoc?: unknown }).bodyDoc !== undefined) throw trpcError('CONFLICT');
      return entity;
    }
    if (path === 'aspect.list') return [];
    return {};
  };
}

test('409 правки тела не гаснет от успеха чекбокса, ушедшего следом', async () => {
  // Чекбокс 409 не получит никогда — сервер его версию не сверяет. Погаси его успех плашку,
  // человек не узнал бы о расхождении вовсе: единственное сообщение о нём ушло бы с экрана
  // само, а расхождение осталось бы.
  seedDraft(parseBody('правка тела'), 'СТАРАЯ-МЕТКА');
  const seen: unknown[] = [];
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, bodyConflictHandler(seen));

  fireEvent.click(await screen.findByRole('button', { name: 'Оставить моё' }));
  await screen.findByText(/Изменено в другом месте — обновите/);

  const getsBefore = calls.filter((c) => c.path === 'entity.get').length;
  fireEvent.click(screen.getByRole('checkbox', { name: /готово/i }));
  // Ждём не саму отправку, а ПЕРЕЧИТЫВАНИЕ после неё: инвалидация идёт в onSettled, то есть
  // строго после onSuccess. Раньше него проверять «не погасло» значило бы не дождаться.
  await waitFor(() =>
    expect(calls.filter((c) => c.path === 'entity.get').length).toBeGreaterThan(getsBefore),
  );
  expect(seen).toHaveLength(2);

  expect(screen.getByText(/Изменено в другом месте — обновите/)).toBeInTheDocument();
});

test('409 правки тела не гаснет от переименования с ТОЙ ЖЕ меткой (Н-3)', async () => {
  // Самый коварный случай: `saveTitle` метку ШЛЁТ, и она совпадает с меткой правки тела —
  // кэшный updatedAt за время полёта не двигается (applyPatch его не трогает, перечитывание
  // идёт только в onSettled). Совпадение меток не значит ничего: у правки без тела сервер
  // версию не сверяет, и 409 она не принесёт — а значит и промолчать за неё нельзя.
  seedDraft(parseBody('правка тела'), 'СТАРАЯ-МЕТКА');
  const seen: unknown[] = [];
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, bodyConflictHandler(seen));

  fireEvent.click(await screen.findByRole('button', { name: 'Оставить моё' }));
  await screen.findByText(/Изменено в другом месте — обновите/);

  const getsBefore = calls.filter((c) => c.path === 'entity.get').length;
  const field = screen.getByLabelText('Заголовок');
  fireEvent.change(field, { target: { value: 'новое имя' } });
  fireEvent.blur(field);
  await waitFor(() =>
    expect(calls.filter((c) => c.path === 'entity.get').length).toBeGreaterThan(getsBefore),
  );

  // Страж вакуумности: метки у обеих правок ДЕЙСТВИТЕЛЬНО одинаковы — иначе тест проверял бы
  // расхождение меток, а не признак «сверяет ли сервер версию у этой правки».
  const metka = (i: number) => (seen[i] as { expectedUpdatedAt?: string }).expectedUpdatedAt;
  expect(metka(0)).toBe(entity.updatedAt);
  expect(metka(1)).toBe(entity.updatedAt);

  expect(screen.getByText(/Изменено в другом месте — обновите/)).toBeInTheDocument();
});

// --- три таба: Сущность · Детали · Тред (Задача 15) ----------------------------------------

const GOAL_ENTITY = {
  ...entity,
  id: 'e1',
  title: 'Накопить на отпуск',
  emoji: '🎯',
  aspects: {
    'orbis/goal': {
      progress_source: { query: 'aspect=orbis/financial', aggregate: 'sum', field: 'amount' },
      target_value: '300000.00',
      unit: '₽',
    },
  },
};

/** Полный экран: аспекты, подзадача, блокировка и backlink — чтобы было чему разъезжаться. */
const richHandler: MockHandler = (path, input) => {
  if (path === 'entity.get') {
    const { id } = input as { id: string };
    if (id !== 'e1') return { entity: { ...entity, id, title: `сосед ${id}` } };
    return {
      entity,
      relations: [
        {
          id: 'r1',
          sourceId: 'e1',
          targetId: 'kid',
          relationType: 'parent',
          meta: {},
          createdAt: 'x',
          updatedAt: 'y',
        },
      ],
      backlinks: [{ entity: { ...entity, id: 'src', title: 'Кто ссылается' }, via: 'mention' }],
      thread: { threadId: 'th1', messages: [] },
    };
  }
  if (path === 'entity.resolveRefs') return [];
  if (path === 'entity.update') return entity;
  if (path === 'aspect.list') return [];
  return {};
};

test('на «Сущности» — emoji, заголовок и тело; карточек аспектов там НЕТ', async () => {
  renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get')
      return { entity: { ...entity, emoji: '🎯' }, relations: [], thread: null };
    if (path === 'aspect.list') return [];
    return {};
  });
  const panel = await screen.findByRole('tabpanel', { name: 'Сущность' });
  expect(within(panel).getByText('🎯')).toBeInTheDocument();
  expect(within(panel).getByLabelText('Заголовок')).toHaveValue('Задача');
  expect(within(panel).getByTestId('editor-preview')).toHaveTextContent('тело');

  // Свойства уехали в «Детали» — на «Сущности» их нет…
  expect(within(panel).queryByTestId('aspect-orbis/task')).toBeNull();
  // …и это НЕ «карточки пропали совсем»: на соседней вкладке они есть. Без этой строки
  // проверка выше была бы зелена и у экрана, потерявшего аспекты вовсе.
  expect(within(tabPanel('Детали')).getByTestId('aspect-orbis/task')).toBeInTheDocument();
});

test('«Детали» показывает аспекты, подзадачи, блокировки и связанное', async () => {
  renderWithProviders(<DetailScreen entityId="e1" />, richHandler);
  const details = await screen.findByRole('tabpanel', { name: 'Детали' });
  expect(within(details).getByTestId('aspect-orbis/task')).toBeInTheDocument();
  expect(within(details).getByLabelText('Новая подзадача')).toBeInTheDocument();
  expect(within(details).getByRole('button', { name: 'Добавить блокировку' })).toBeInTheDocument();
  expect(within(details).getByText(/Связанное/)).toBeInTheDocument();

  // И ничего из этого не осталось на «Сущности»: вкладка — чистый документ.
  const panel = tabPanel('Сущность');
  expect(within(panel).queryByLabelText('Новая подзадача')).toBeNull();
  expect(within(panel).queryByRole('button', { name: 'Добавить блокировку' })).toBeNull();
  expect(within(panel).queryByText(/Связанное/)).toBeNull();
});

test('полоса прогресса цели осталась на «Сущности», с единицей из аспекта', async () => {
  // У цели прогресс — то, ради чего её открывают: спрятать «50%, 150 000 из 300 000» во вторую
  // вкладку значило бы ухудшить главный экран целей ради чистоты раскладки.
  renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get')
      return {
        entity: GOAL_ENTITY,
        relations: [],
        thread: null,
        goalProgress: { current: '150000.00', target: '300000.00' },
      };
    if (path === 'aspect.list') return [];
    return {};
  });
  const panel = await screen.findByRole('tabpanel', { name: 'Сущность' });
  const bar = within(panel).getByTestId('goal-progress');
  expect(within(bar).getByText('150 000 / 300 000')).toBeInTheDocument();
  // Единица достаётся из entity.aspects заново: в AspectCards она бралась из тела цикла по
  // аспектам, а цикла на «Сущности» нет — потеряться ей проще простого.
  expect(within(bar).getByText('₽')).toBeInTheDocument();
  // Второй полосы в «Деталях» нет: два ответа на вопрос «как оно идёт» — это уже вопрос,
  // которому верить.
  expect(within(tabPanel('Детали')).queryByTestId('goal-progress')).toBeNull();
});

test('переключение табов не роняет несохранённый черновик тела', async () => {
  // Radix по умолчанию РАЗМОНТИРУЕТ неактивную вкладку: уход на «Детали» уничтожил бы редактор
  // вместе с набранным текстом и всей историей Ctrl+Z, а на возврате гонял бы двухфазное
  // монтирование заново.
  renderWithProviders(<DetailScreen entityId="e1" />, bodyHandler('тело'));
  const field = await editorField();
  await userEvent.click(field);
  await userEvent.type(field, ' и хвост');
  await expectEditorText('и хвост');
  // Узел берётся ПОСЛЕ того, как набранное доехало: до этого EditorContent ещё мог
  // перемонтироваться (см. expectEditorText), и сравнивать было бы не с чем.
  const before = screen.getByTestId('body-editor');

  fireEvent.click(screen.getByRole('tab', { name: 'Детали' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Сущность' }));

  // Тот же САМЫЙ узел, а не просто такой же текст: пережившее переключение дерево — это и есть
  // пережившая его история отмены. Пересоздайся редактор — узел был бы другим.
  expect(screen.getByTestId('body-editor')).toBe(before);
  expect(before).toHaveTextContent('и хвост');
});

test('вкладка «Тред» живой не держится: её запрос не уходит, пока её не открыли', async () => {
  // Обратная сторона того же флага. ChatThread на монтировании заводит chat.listMessages, и
  // безусловный keepMounted платил бы этим запросом за КАЖДОЕ открытие записи.
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get')
      return { entity, relations: [], thread: { threadId: 'th1', messages: [] } };
    if (path === 'chat.listMessages') return [];
    if (path === 'aspect.list') return [];
    return {};
  });
  await screen.findByRole('tab', { name: 'Тред' });
  const threadCalls = () => calls.filter((c) => c.path === 'chat.listMessages');
  expect(threadCalls()).toEqual([]);

  // Положительный контроль В ТОМ ЖЕ ТЕСТЕ: открытая вкладка свой запрос ШЛЁТ — иначе молчание
  // выше означало бы лишь, что тред не спрашивает ничего и никогда.
  fireEvent.click(screen.getByRole('tab', { name: 'Тред' }));
  await waitFor(() => expect(threadCalls().length).toBeGreaterThan(0));
});

test('меню ⋮: «Править как markdown» показывает тело исходным текстом', async () => {
  renderWithProviders(<DetailScreen entityId="e1" />, bodyHandler('# Заголовок\n\nтекст'));
  await openDetailMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Править как markdown' }));

  // Тумблер приезжает ленивым чанком — отсюда findBy, а не getBy.
  const area = await screen.findByTestId('markdown-source');
  expect(area).toHaveValue('# Заголовок\n\nтекст');
});

test('без документа пункта «Править как markdown» в меню нет вовсе', async () => {
  // Пункт, который молча ничего не делает, хуже отсутствующего: нажав его, человек поднял бы
  // флаг режима — и приехавший следующим рефетчем документ открыл бы тумблер сам, без жеста.
  renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get')
      return { entity: { ...entity, bodyDoc: null }, relations: [], thread: null };
    if (path === 'aspect.list') return [];
    return {};
  });
  await openDetailMenu();
  expect(screen.queryByRole('menuitem', { name: 'Править как markdown' })).toBeNull();
  // Страж вакуумности: меню открыто и живо — остальные пункты на месте.
  expect(screen.getByRole('menuitem', { name: 'Скопировать ссылку' })).toBeInTheDocument();
  // И тело записи при этом не пропало: первый кадр рисуется из markdown.
  expect(screen.getByTestId('editor-preview')).toHaveTextContent('тело');
});

test('тумблер markdown открывается с тем, что НАБРАНО, а не с тем, что успело доехать', async () => {
  // Второй потребитель показанного документа — тумблер, и он берёт текст ОДИН раз, при
  // открытии. Пока экран на правку из редактора отвечал «местной копии больше нет», между
  // набором и приездом документа в кэш зияла дыра длиной в паузу набора (2 с, а на плохой связи
  // дольше): всё это время `doc` — документ БЕЗ последних символов, и тумблер открывался именно
  // им. Дальше достаточно нажать «Применить» — и набранное исчезает и с экрана, и из базы.
  //
  // Сервер отказывает НАМЕРЕННО: откат снимает оптимистичный патч, и кэш остаётся с прежним
  // телом до конца теста. Иначе проверка зависела бы от того, успела ли пауза истечь, —
  // то есть краснела бы через раз и по часам, а не по дефекту.
  renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get')
      return { entity: { ...entity, body: 'тело', bodyDoc: parseBody('тело') }, relations: [] };
    if (path === 'entity.update') throw trpcError('INTERNAL_SERVER_ERROR');
    if (path === 'aspect.list') return [];
    return {};
  });
  const field = await editorField();
  await userEvent.click(field);
  await userEvent.type(field, ' и хвост');
  await expectEditorText('и хвост');

  await openDetailMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Править как markdown' }));

  const area = await screen.findByTestId('markdown-source');
  expect(area).toHaveValue('тело и хвост');
});

test('правка из тумблера садится в редактор, а не остаётся в тумблере', async () => {
  // Иначе экран и база разъезжаются до первого нажатия клавиши: правка уехала бы
  // автосохранением, а редактор показывал бы прежний текст и вернул бы его поверх.
  renderWithProviders(<DetailScreen entityId="e1" />, bodyHandler('тело'));
  await openDetailMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Править как markdown' }));
  const area = await screen.findByTestId('markdown-source');
  fireEvent.change(area, { target: { value: 'совсем другое тело' } });
  fireEvent.click(screen.getByRole('button', { name: 'Применить' }));

  // Тумблер закрылся, тело снова рисует редактор — и уже с новым текстом.
  await waitFor(() => expect(screen.queryByTestId('markdown-source')).toBeNull());
  await openEditor();
  await expectEditorText('совсем другое тело');
});

test('плашки и индикатор тела живут ВНЕ вкладок — иначе с «Деталей» их не видно', async () => {
  // «Сущность» держится живой через `display:none` (keepMounted, Tabs.tsx), и всё, что лежит
  // внутри неё, с соседней вкладки не видно вовсе. А единственный канал обратной связи о
  // сохранении — эти три плашки: человек печатает, уходит на «Детали» посмотреть подзадачи,
  // автосохранение падает 409 или сетью — и на экране ни слова. Он уходит с записи в
  // уверенности, что сохранено (ревью раунда 3, находка 4).
  //
  // Проверяем ПОЛОЖЕНИЕ В ДЕРЕВЕ, а не видимость: класс `data-[state=inactive]:hidden` в jsdom
  // ничего не прячет (стилей нет), и `toBeVisible()` был бы зелен при любой раскладке. Ровно
  // тот же приём, что у `ManualLinkNotice`, вынесенной из вкладок раньше и по той же причине.
  seedDraft(parseBody('черновик прошлой сессии'), 'СТАРАЯ-МЕТКА');
  renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get')
      return { entity, relations: [], thread: { threadId: 'th1', messages: [] } };
    if (path === 'entity.update') throw trpcError('CONFLICT');
    if (path === 'aspect.list') return [];
    return {};
  });

  // Баннер черновика — первым: он появляется сам, без единого жеста человека.
  const draftBanner = await screen.findByTestId('draft-banner');
  expect(draftBanner.closest('[role="tabpanel"]')).toBeNull();

  // «Оставить моё» шлёт правку тела немедленно — единственный путь, дающий и плашку конфликта,
  // и «Не сохранено» без подмены таймеров.
  fireEvent.click(within(draftBanner).getByRole('button', { name: 'Оставить моё' }));
  const conflict = await screen.findByText(/Изменено в другом месте — обновите/);
  expect(conflict.closest('[role="tabpanel"]')).toBeNull();
  const indicator = await screen.findByTestId('save-indicator');
  expect(indicator).toHaveTextContent('Не сохранено');
  expect(indicator.closest('[role="tabpanel"]')).toBeNull();

  // И с соседней вкладки они никуда не делись.
  fireEvent.click(screen.getByRole('tab', { name: 'Детали' }));
  // Страж вакуумности: вкладка ДЕЙСТВИТЕЛЬНО переключилась — иначе проверки ниже ни о чём.
  expect(screen.getByRole('tab', { name: 'Детали' })).toHaveAttribute('data-state', 'active');
  expect(screen.getByText(/Изменено в другом месте — обновите/)).toBeInTheDocument();
  expect(screen.getByTestId('save-indicator')).toHaveTextContent('Не сохранено');
  // …а тело при этом осталось на своей вкладке: вынесены ПЛАШКИ, а не редактор.
  expect(within(tabPanel('Сущность')).getByTestId('editor-preview')).toBeInTheDocument();
});

// --- баннер черновика ----------------------------------------------------------------------

test('баннер черновика говорит, что «оставить моё» ЗАМЕНИТ текущий текст', async () => {
  // Кнопка, которая молча заменяет текст записи, обязана сказать об этом до нажатия: человек,
  // не знающий этого, жмёт её как безобидную («ну посмотрю, что там было»).
  seedDraft(parseBody('черновик прошлой сессии'), 'СТАРАЯ-МЕТКА');
  renderWithProviders(<DetailScreen entityId="e1" />, bodyHandler('тело'));

  const banner = await screen.findByTestId('draft-banner');
  expect(banner).toHaveTextContent(/заменит текущий текст/i);
  expect(within(banner).getByRole('button', { name: 'Оставить моё' })).toBeInTheDocument();
  expect(within(banner).getByRole('button', { name: 'Отбросить' })).toBeInTheDocument();
});

test('«оставить моё» сажает предложенный документ в редактор И отправляет его', async () => {
  // Диск держит ОДИН черновик на запись, и после отправки предложенный текст живёт только в
  // памяти хука — последней копией. Не покажи его редактор, первое же нажатие клавиши вернуло
  // бы в базу то, что на экране, то есть прежний текст.
  seedDraft(parseBody('черновик прошлой сессии'), 'СТАРАЯ-МЕТКА');
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, bodyHandler('тело'));
  await openEditor();
  await expectEditorText('тело');

  fireEvent.click(await screen.findByRole('button', { name: 'Оставить моё' }));

  // (б) документ в редакторе — предложенный.
  await waitFor(
    () => expect(screen.getByTestId('body-editor')).toHaveTextContent('черновик прошлой сессии'),
    EDITOR_READY,
  );
  // (а) и он же уехал в базу.
  await waitFor(() => {
    const c = calls.find((x) => x.path === 'entity.update');
    expect(serializeBody((c?.input as { bodyDoc: BodyDoc }).bodyDoc)).toBe(
      'черновик прошлой сессии',
    );
  });
  // Баннер отработал и ушёл: висящее предложение над уже применённым текстом — ложь.
  expect(screen.queryByTestId('draft-banner')).toBeNull();
});

test('«отбросить» стирает черновик и НЕ трогает текст записи', async () => {
  seedDraft(parseBody('черновик прошлой сессии'), 'СТАРАЯ-МЕТКА');
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, bodyHandler('тело'));
  fireEvent.click(await screen.findByRole('button', { name: 'Отбросить' }));

  expect(screen.queryByTestId('draft-banner')).toBeNull();
  expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  await openEditor();
  await expectEditorText('тело');
  expect(screen.getByTestId('body-editor')).not.toHaveTextContent('черновик');
  expect(calls.some((c) => c.path === 'entity.update')).toBe(false);
});

// --- смена записи: размонтирование по key + досыл (И2) --------------------------------------

/** Роутер монтирует DetailScreen БЕЗ key: переход entity→entity меняет только проп. */
function TwoEntities() {
  const [id, setId] = useState('e1');
  return (
    <>
      <button type="button" data-testid="go-e2" onClick={() => setId('e2')}>
        на e2
      </button>
      <DetailScreen entityId={id} />
    </>
  );
}

test('режим «править как markdown» не переезжает на соседнюю запись', async () => {
  // Экран монтируется БЕЗ key, и режим, переживший переход, открывал бы соседнюю запись сырым
  // текстом без единого жеста человека — тот же класс беды, что и плашка с чужой ссылкой.
  renderWithProviders(<TwoEntities />, (path, input) => {
    if (path === 'entity.get') {
      const { id } = input as { id: string };
      return {
        entity: { ...entity, id, title: id === 'e1' ? 'Задача' : 'Другая' },
        relations: [],
        thread: null,
      };
    }
    if (path === 'aspect.list') return [];
    return {};
  });
  await openDetailMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Править как markdown' }));
  await screen.findByTestId('markdown-source');

  fireEvent.click(screen.getByTestId('go-e2'));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Другая' })).toBeInTheDocument());
  expect(screen.queryByTestId('markdown-source')).toBeNull();
  expect(screen.getByTestId('editor-preview')).toBeInTheDocument();
});

/**
 * Держит запись `e2` в кэше — тем же ключом, что и detail.
 *
 * Без этого переход e1→e2 всегда проходит через СКЕЛЕТОН (`get.data` пуст, пока летит запрос),
 * а скелетон и сам размонтирует тело — то есть досыл случался бы и БЕЗ `key`, и тест ничего бы
 * не сторожил. Замерено: мутант, снимающий `key`, при холодном кэше выживает через раз.
 * Сюжет с тёплым кэшем — самый обычный: возврат на запись, которую только что открывали.
 */
function CachedE2() {
  trpc.entity.get.useQuery(detailGetInput('e2'));
  return null;
}

test('смена записи размонтирует тело и досылает отложенное — под ПРЕЖНИМ id', async () => {
  // Без key экран менял бы только проп: `useBodySave` при смене `entityId` теряет отложенное
  // МОЛЧА, а доживший таймер паузы дописал бы старый документ в новую запись.
  const bodies: Record<string, string> = { e1: 'тело первой', e2: 'тело второй' };
  const { calls } = renderWithProviders(
    <>
      <CachedE2 />
      <TwoEntities />
    </>,
    (path, input) => {
      if (path === 'entity.get') {
        const { id } = input as { id: string };
        const body = bodies[id] ?? '';
        return {
          entity: {
            ...entity,
            id,
            title: id === 'e1' ? 'Задача' : 'Другая',
            body,
            bodyDoc: parseBody(body),
          },
          relations: [],
          thread: null,
        };
      }
      if (path === 'entity.update') return { ...entity, updatedAt: '2026-07-05T11:00:00.000Z' };
      if (path === 'aspect.list') return [];
      return {};
    },
  );
  // Премиса: соседняя запись УЖЕ в кэше, то есть переход пройдёт без скелетона (см. CachedE2).
  await waitFor(() =>
    expect(calls.filter((c) => c.path === 'entity.get').length).toBeGreaterThan(1),
  );
  // Правку кладём тумблером: он отдаёт документ синхронно, без подмены таймеров и без
  // клавиатурного ввода в ProseMirror.
  await openDetailMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Править как markdown' }));
  const area = await screen.findByTestId('markdown-source');
  fireEvent.change(area, { target: { value: 'правка первой' } });
  fireEvent.click(screen.getByRole('button', { name: 'Применить' }));
  // Страж: пауза набора ещё идёт, в сеть не ходили — иначе проверка ниже была бы зелена и без
  // всякого досыла.
  expect(calls.filter((c) => c.path === 'entity.update')).toEqual([]);

  fireEvent.click(screen.getByTestId('go-e2'));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Другая' })).toBeInTheDocument());
  // Скелетона не было — тело второй записи на экране сразу, без промежуточного «…».
  expect(screen.getByTestId('editor-preview')).toHaveTextContent('тело второй');

  const updates = calls.filter((c) => c.path === 'entity.update');
  expect(updates).toHaveLength(1);
  const sent = updates[0]?.input as { id: string; bodyDoc: BodyDoc };
  expect(sent.id).toBe('e1'); // ПРЕЖНЯЯ запись, а не та, что открыта сейчас
  expect(serializeBody(sent.bodyDoc)).toBe('правка первой');

  // И новая запись показывает СВОЁ тело в редакторе, а не унаследованное.
  await openEditor();
  await expectEditorText('тело второй');
});
