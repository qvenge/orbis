import { DAILY_PLANNING_BODY } from '@orbis/server/src/seed/smart-lists';
import { aspectJsonSchema, BUILTIN_ASPECT_IDS } from '@orbis/shared';
import { type BodyDoc, parseBody, serializeBody } from '@orbis/shared/doc';
import { onlineManager } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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
import { useChatThread } from '../chat/useChatThread';
import { resetEnsuredThreads } from '../chat/useEnsuredThread';
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
  // Заведённые треды помнит МОДУЛЬ (useEnsuredThread), а модуль живёт дольше теста: без сброса
  // первый же тест, открывший «Тред» записи e1, оставлял бы следующему нулевое число вызовов
  // ensureThread — и проверка «завели ровно один раз» краснела бы от соседа, а не от кода.
  resetEnsuredThreads();
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

/**
 * Ждёт, что в теле есть ВСЕ перечисленные куски. Порядок между ними НЕ проверяется — и это не
 * послабление, а снятие зависимости от того, чего тест не контролирует.
 *
 * Куда попадёт набранное, в jsdom решает НЕ приложение. Замерено: `caretRangeFromPoint` и
 * `caretPositionFromPoint` там отсутствуют (`undefined`), а все прямоугольники нулевые, поэтому
 * `posAtCoords` ProseMirror позицию по клику разрешить не может НИКОГДА — состояние редактора о
 * клике не узнаёт. Каретку в этих тестах держит связка jsdom + userEvent, а Tiptap отложенным
 * кадром (`focus` → requestAnimationFrame → `view.focus()` → `selectionToDOM`) вправе переписать
 * её из состояния PM, то есть в НАЧАЛО документа. Под нагрузкой кадр запаздывает, окно
 * открывается — и набранное встаёт перед прежним текстом.
 *
 * Именно так и упал CI: ждали «тело и хвост», получили «и хвосттело» (нормализация пробелов в
 * `toHaveTextContent` съедает ведущий пробел от « и хвост», вставленного в позицию 0). Проверяемое
 * свойство при этом — «набранное не потеряно», а вовсе не «набранное встало в конец»: в браузере
 * позиция каретки принадлежит человеку, приложение её после монтирования не трогает ни разу.
 */
async function expectEditorHas(...fragments: string[]): Promise<void> {
  await waitFor(() => {
    const box = screen.getByTestId('body-editor');
    for (const fragment of fragments) expect(box).toHaveTextContent(fragment);
  }, EDITOR_READY);
}

/** То же для поля разметки: сверяем наличие кусков, а не их порядок (см. expectEditorHas). */
function expectMarkdownHas(area: HTMLElement, ...fragments: string[]): void {
  for (const fragment of fragments) expect((area as HTMLTextAreaElement).value).toContain(fragment);
}

/**
 * Ожидание ОТРИЦАТЕЛЬНОГО ответа «редактор не встал».
 *
 * Раньше здесь стояли голые 50 мс, и это несоразмерно: положительному монтированию тот же файл
 * даёт десять секунд с оговоркой про голодание по CPU в полном прогоне (EDITOR_READY). Регрессия,
 * не успевшая за 50 мс под нагрузкой, оставляла тесты зелёными (ревью раунда 3).
 *
 * Что здесь на самом деле проверяется и почему этого достаточно. Решение «поднимать ли редактор»
 * СИНХРОННО: `EditorShell.wantEditor` ставит `mount` прямо в обработчике клика. Всё, что остаётся
 * после решения, — доехать ленивому чанку, а он к этим тестам давно загружен (его поднимали
 * тесты выше в этом же файле), то есть измеряется не время, а несколько тиков очереди. Отсюда и
 * порядок: сперва вычерпываем очередь задач, и только потом — запас по часам.
 *
 * Слабость остаётся и записана честно: «не встал» отличается от «ещё не встал» только временем,
 * причинного барьера у отрицательного ответа нет. Поэтому каждый такой тест обязан кончаться
 * ПОЛОЖИТЕЛЬНЫМ контролем — жестом, от которого редактор встать ДОЛЖЕН: без него молчание выше
 * означало бы лишь, что редактор в этом тесте не встаёт ни от чего.
 */
const NO_EDITOR_GRACE_MS = 500;

async function expectNoEditorYet(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, NO_EDITOR_GRACE_MS));
  expect(screen.queryByTestId('body-editor')).toBeNull();
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
  // Заголовок меняется ВМЕСТЕ с телом, и это не декорация: он — причинный барьер (см. ниже).
  const outside = {
    ...entity,
    title: 'Изменено извне',
    body: 'извне',
    bodyDoc: parseBody('извне'),
    updatedAt: 'B',
  };
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
  // «Не затёрло» обязано значить «не затрёт», а не «не дождались», — и ждём мы здесь не по
  // часам, а ПРИЧИННО. Заголовок и документ приезжают одним и тем же ответом и рисуются одним
  // и тем же коммитом: увидев чужой заголовок, мы знаем, что чужой `doc` уже доехал до
  // `BodyEditor` и его эффект подмены отработал (эффекты вычерпаны до разрешения findBy).
  await screen.findByRole('heading', { name: 'Изменено извне' });
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

// Живой смоук ADE-среза 1: заготовка тела проекта (С10) держала три блока `children_of=this`,
// и все три отвечали структурной ошибкой «this вне контекста сущности» — виджет звал
// entity.query БЕЗ thisEntityId, хотя ручка его принимает (routers/entity.ts). Секции «В
// работе», «Ждут меня», «Бэклог» на экране проекта показывали ноль при живых тикетах.
test('query-блок с `this` на detail получает контекст открытой сущности', async () => {
  const body = '{{query: children_of=this, aspect=orbis/task, display=list, title=Подзадачи}}';
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get')
      return {
        entity: { ...entity, body, bodyDoc: parseBody(body), aspects: {} },
        relations: [],
        thread: null,
      };
    if (path === 'aspect.list') return realAspects;
    if (path === 'entity.query') return [found('Тикет')];
    return {};
  });
  await waitFor(() => expect(screen.getByTestId('qb-count')).toBeInTheDocument());
  expect(screen.queryByTestId('qb-error')).not.toBeInTheDocument();
  // Контекст — id ОТКРЫТОЙ записи: без него сервер бросает QueryCompileError, и секция пуста.
  expect(calls.find((c) => c.path === 'entity.query')?.input).toEqual({
    query: 'children_of=this, aspect=orbis/task, display=list, title=Подзадачи',
    thisEntityId: 'e1',
  });

  // Второй кадр — редактор: тот же виджет живёт уже NodeView'ем внутри ProseMirror
  // (QueryBlockWithView). Дерево React у него то же (ReactNodeViewRenderer рисует порталом из
  // компонента редактора), но проверяем это, а не рассуждение: контекст, потерянный здесь,
  // означал бы «блок работает до первого касания тела».
  await openEditor();
  await waitFor(() => expect(screen.getByTestId('qb-count')).toBeInTheDocument());
  for (const c of calls.filter((c) => c.path === 'entity.query')) {
    expect(c.input).toHaveProperty('thisEntityId', 'e1');
  }
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
  await expectNoEditorYet();
  expect(screen.getByTestId('editor-preview')).toBeInTheDocument();

  // Положительный контроль (см. expectNoEditorYet): по телу — МИМО ссылки — редактор встаёт.
  // Без него молчание выше значило бы лишь, что в этом тесте он не встаёт ни от чего.
  fireEvent.click(screen.getByTestId('editor-preview'));
  await screen.findByTestId('body-editor', undefined, EDITOR_READY);
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
    await expectNoEditorYet();
  } finally {
    selection.mockRestore();
  }

  // Положительный контроль (см. expectNoEditorYet): снятое выделение — и тот же клик по тому же
  // месту редактор поднимает.
  fireEvent.click(view);
  await screen.findByTestId('body-editor', undefined, EDITOR_READY);
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
  await expectNoEditorYet();

  // Положительный контроль (см. expectNoEditorYet): клик по ТЕКСТУ рядом с виджетом редактор
  // поднимает — значит молчание выше про виджет, а не про мёртвый путь монтирования.
  fireEvent.click(screen.getByText('Утренний обзор'));
  await screen.findByTestId('body-editor', undefined, EDITOR_READY);
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
    if (path === 'chat.ensureThread') return { threadId: 'th1' };
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

// --- тред сущности заводится ДО первого сообщения (дефект живого смоука) --------------------
//
// Тред сущности ленив (§4.5): `entity.get` считает его id формулой, НЕ создавая строки, — и
// первое сообщение в неоткрытый тред отбивалось предпроверкой ai.sendMessage («тред не найден»,
// NOT_FOUND) уже ПОСЛЕ того, как человек его набрал. Дефект предсуществующий; лечится тем же
// приёмом, что в глобальном чате (ChatScreen), — ensureThread на монтировании.

/** Тред detail-экрана: id из entity.get и id, который вернул ensure, НАМЕРЕННО разные. */
const threadHandler: MockHandler = (path) => {
  if (path === 'entity.get')
    // `th-formula` — то, что detail знает БЕЗ создания строки. Ровно этот id и уходил в
    // ai.sendMessage до починки; в ассертах ниже он служит отрицательным контролем.
    return { entity, relations: [], thread: { threadId: 'th-formula', messages: [] } };
  if (path === 'chat.ensureThread') return { threadId: 'th-ensured' };
  if (path === 'chat.listMessages') return [];
  if (path === 'aspect.list') return [];
  return {};
};

test('открытие «Треда» заводит тред сущности — ровно один раз, и под StrictMode тоже', async () => {
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, threadHandler, {
    strict: true,
  });
  await screen.findByRole('tab', { name: 'Тред' });
  const ensureCalls = () => calls.filter((c) => c.path === 'chat.ensureThread');
  // Вкладку не открывали — тред не заводим: записи, куда не заходили, лишней мутации не платят.
  expect(ensureCalls()).toEqual([]);

  fireEvent.click(screen.getByRole('tab', { name: 'Тред' }));
  await screen.findByLabelText('Сообщение');
  // Один вызов, а не два: StrictMode прогоняет эффекты монтирования дважды, и без гварда на
  // ref каждое открытие вкладки стоило бы двух мутаций.
  expect(ensureCalls()).toEqual([{ path: 'chat.ensureThread', input: { entityId: 'e1' } }]);
});

test('сообщение из «Треда» уходит в ЗАВЕДЁННЫЙ тред, а не в посчитанный формулой', async () => {
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, threadHandler);
  await screen.findByRole('tab', { name: 'Тред' });
  fireEvent.click(screen.getByRole('tab', { name: 'Тред' }));

  const field = await screen.findByLabelText('Сообщение');
  await userEvent.type(field, 'привет');
  fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));

  await waitFor(() => expect(calls.some((c) => c.path === 'ai.sendMessage')).toBe(true));
  const sent = calls.find((c) => c.path === 'ai.sendMessage');
  expect(sent?.input).toMatchObject({ threadId: 'th-ensured', content: 'привет' });
});

test('тред завести не вышло — вкладка говорит об этом, а не показывает вечный скелетон', async () => {
  renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'chat.ensureThread') throw trpcError('INTERNAL_SERVER_ERROR', 'база недоступна');
    return threadHandler(path, undefined);
  });
  await screen.findByRole('tab', { name: 'Тред' });
  fireEvent.click(screen.getByRole('tab', { name: 'Тред' }));

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Не удалось открыть тред');
  expect(alert).toHaveTextContent('база недоступна');
  // И поля ввода нет: предлагать набрать текст, которому некуда уехать, — обман.
  expect(screen.queryByLabelText('Сообщение')).toBeNull();
});

// Вкладка «Тред» живой не держится (у неё нет keepMounted), поэтому её ПОВТОРНОЕ открытие
// монтировало компонент заново — и снова звало ensureThread, мигая скелетоном поверх уже
// закешированных сообщений. Мутация идемпотентна, но платить ею за каждое переключение вкладок
// незачем: заведённый тред записи помнит модуль (useEnsuredThread).
test('повторное открытие «Треда» той же записи тред НЕ заводит и скелетоном не мигает', async () => {
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'chat.listMessages')
      return [
        {
          id: 'm1',
          threadId: 'th-ensured',
          role: 'user',
          content: 'первое',
          metadata: {},
          createdAt: '2026-07-05T10:00:00.000Z',
        },
      ];
    return threadHandler(path, undefined);
  });
  await screen.findByRole('tab', { name: 'Тред' });
  const ensureCalls = () => calls.filter((c) => c.path === 'chat.ensureThread');

  fireEvent.click(screen.getByRole('tab', { name: 'Тред' }));
  await screen.findByText('первое');
  expect(ensureCalls()).toHaveLength(1);

  // Уход на соседнюю вкладку размонтирует СОДЕРЖИМОЕ «Треда» — с этого и начинался дефект.
  // Ассерт ниже это НЕ доказывает и на большее не претендует: сам `div[role=tabpanel]` Radix
  // оставляет в DOM с атрибутом `hidden` (размонтирует он детей), и `queryByRole` не видит его
  // именно из-за `hidden`, то есть говорит о недоступности, а не о размонтировании. Стоит он
  // ради того, что вкладку и правда переключили. Доказательство памяти — дальше: синхронные
  // ассерты после повторного открытия и единственный вызов ensure.
  fireEvent.click(screen.getByRole('tab', { name: 'Сущность' }));
  expect(screen.queryByRole('tabpanel', { name: 'Тред' })).toBeNull();

  fireEvent.click(screen.getByRole('tab', { name: 'Тред' }));
  // СИНХРОННО, без единого ожидания: лента уже на экране, скелетона нет ни кадра.
  const panel = tabPanel('Тред');
  expect(within(panel).getByTestId('message-list')).toBeInTheDocument();
  expect(within(panel).getByText('первое')).toBeInTheDocument();
  expect(within(panel).queryByLabelText('Загрузка')).toBeNull();
  expect(ensureCalls()).toHaveLength(1);
});

test('тред завести не вышло — «Повторить» пробует заново и поднимает ленту', async () => {
  let attempt = 0;
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'chat.ensureThread') {
      attempt += 1;
      if (attempt === 1) throw trpcError('INTERNAL_SERVER_ERROR', 'база недоступна');
      return { threadId: 'th-ensured' };
    }
    return threadHandler(path, undefined);
  });
  await screen.findByRole('tab', { name: 'Тред' });
  fireEvent.click(screen.getByRole('tab', { name: 'Тред' }));

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('база недоступна');

  fireEvent.click(within(alert).getByRole('button', { name: 'Повторить' }));

  await screen.findByLabelText('Сообщение');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(calls.filter((c) => c.path === 'chat.ensureThread')).toHaveLength(2);
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
  expectMarkdownHas(area, 'тело', 'и хвост');
});

test('ВНУТРИ ПАУЗЫ «Применить» без единой правки в поле ничего не теряет', async () => {
  // Имя сужено намеренно, и вот граница: отсечка «без изменений» сравнивает поле с
  // сериализацией ПОКАЗАННОГО документа, а поле — снимок на момент открытия. Сдвинься
  // показанный документ, пока тумблер открыт (доехала своя мутация, приехала чужая правка), —
  // снимок разойдётся с ним, и «Применить» уедет поверх приехавшего. Гарантии на этот случай
  // здесь НЕТ, и тест её не даёт; он про окно паузы, где расходиться нечему, потому что
  // тумблер открывается ровно тем, что показывает тело (см. shownDocRef в DetailScreen).
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
  // Премиса: поле открылось НАБРАННЫМ текстом — иначе «без изменений» ниже значило бы другое.
  expectMarkdownHas(area, 'тело', 'и хвост');
  fireEvent.click(screen.getByRole('button', { name: 'Применить' }));

  await waitFor(() => expect(screen.queryByTestId('markdown-source')).toBeNull());
  // Набранное на месте: тумблер закрылся, ничего не переписав.
  await openEditor();
  await expectEditorHas('тело', 'и хвост');
});

test('набранное, которое редактор НЕ отдал откату, остаётся и в режиме разметки', async () => {
  // Сюжет БЕЗ второго устройства, все действия штатные (ре-ревью раунда 3, блокер):
  //  1. печатаю — через паузу отправка ушла, оптимистичный патч положил набранное в кэш;
  //  2. пока запрос в полёте (медленная сеть), дописываю ещё;
  //  3. запрос отказывает → кэш откатывается к исходному телу. Редактор в фокусе и печатали —
  //     подмену он ОТКЛОНЯЕТ, на экране по-прежнему всё набранное;
  //  4. открываю режим разметки, не нажав ни одной клавиши.
  //
  // Пока экран УГАДЫВАЛ по кэшу, показан ли приехавший документ, он видел здесь «кэш ушёл
  // вперёд» (снимок успел перебазироваться на оптимистичный) и отдавал тумблеру откатанное
  // тело — то есть текст без обеих правок. Дальше довольно «Отмены», чтобы набранное исчезло с
  // экрана по кнопке, обещающей не менять ничего. Теперь о подмене сообщает тот, кто её делает.
  const gates: { fail: (e: unknown) => void }[] = [];
  renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get')
      return { entity: { ...entity, body: 'тело', bodyDoc: parseBody('тело') }, relations: [] };
    if (path === 'entity.update')
      return new Promise((_settle, fail) => {
        gates.push({ fail });
      });
    if (path === 'aspect.list') return [];
    return {};
  });
  const field = await editorField();
  await userEvent.click(field);
  await userEvent.type(field, ' и хвост');
  await expectEditorText('и хвост');
  // Премиса: пауза истекла, отправка ушла — значит оптимистичный патч уже в кэше.
  await waitFor(() => expect(gates).toHaveLength(1), EDITOR_READY);

  // Дописываем, ПОКА запрос в полёте: показанное перебазируется на оптимистичное тело.
  await userEvent.type(
    screen.getByTestId('body-editor').querySelector('[contenteditable]') as HTMLElement,
    ' ещё',
  );
  await expectEditorText('ещё');

  // Отказ → откат кэша к «тело». Фокус с редактора НЕ уводим: человек продолжает печатать.
  await act(async () => {
    gates[0]?.fail(trpcError('INTERNAL_SERVER_ERROR'));
  });
  await expectEditorHas('тело', 'и хвост', 'ещё'); // премиса: подмену редактор отклонил

  await openDetailMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Править как markdown' }));
  expectMarkdownHas(await screen.findByTestId('markdown-source'), 'тело', 'и хвост', 'ещё');
}, 30_000);

test('«Отмена» в тумблере не возвращает текст, который на экране уже заменён приехавшим', async () => {
  // Заплата «уход из тумблера сажает показанное обратно» нужна (без неё уход возвращал текст
  // СТАРШЕ набранного), но сажать показанное можно только пока серверный документ не ушёл
  // вперёд. Иначе получается экранный путь той же природы, что находка 1: человек нажал
  // «Обновить», увидел чужое тело — и «Отмена», которая обещает не менять НИЧЕГО, молча
  // возвращает его набранное поверх чужого (ре-ревью раунда 2, пункт 2).
  const outside = {
    ...entity,
    title: 'Изменено извне',
    body: 'извне',
    bodyDoc: parseBody('извне'),
    updatedAt: 'B',
  };
  // Флаг поднимается ПОСЛЕ того, как конфликт завёл своё перечитывание, — то есть чужое тело
  // приезжает именно с ответом на «Обновить», а не раньше. Так и задумано, и вот почему это
  // важно: react-query держит структурное разделение данных, и повторный ответ с тем же
  // содержимым отдаёт ТОТ ЖЕ объект — проп `doc` не меняется, эффект подмены в `BodyEditor` не
  // прогоняется вовсе. Приедь чужое тело первым, доехавшим само собой перечитыванием, второго
  // шанса подменить содержимое уже не было бы.
  const serve = { outside: false };
  renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get')
      return { entity: serve.outside ? outside : entity, relations: [], thread: null };
    if (path === 'entity.update') throw trpcError('CONFLICT');
    if (path === 'aspect.list') return [];
    return {};
  });
  const field = await editorField();
  await userEvent.click(field);
  await userEvent.type(field, ' и хвост');
  await expectEditorText('и хвост');

  // Автосохранение по паузе ловит 409 — и на экране плашка с «Обновить».
  const refresh = await screen.findByRole('button', { name: 'Обновить' }, EDITOR_READY);
  serve.outside = true;
  // Фокус уводится ЯВНО, СОБЫТИЕМ. В браузере это делает само нажатие кнопки; в jsdom клик
  // фокус не переносит, а `editor.isFocused` в Tiptap 3 — не живой геттер, а поле, которое
  // ставят обработчики focus/blur (замерено по исходнику пакета). Без этой строки редактор
  // остаётся «в фокусе», подмена содержимого запрещена (`isFocused && typed`), и премиса ниже
  // недостижима по причине, к находке отношения не имеющей.
  const blurEditor = () =>
    fireEvent.blur(screen.getByTestId('body-editor').querySelector('[contenteditable]') as Element);
  blurEditor();
  fireEvent.click(refresh);
  await expectEditorText('извне'); // премиса: чужое тело ДОЕХАЛО до редактора

  await openDetailMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Править как markdown' }));
  // И само поле открывается тем, что НА ЭКРАНЕ, а не прошлым набранным: показанный документ
  // годен, только пока серверное тело не ушло вперёд него.
  expect(await screen.findByTestId('markdown-source')).toHaveValue('извне');
  fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
  await waitFor(() => expect(screen.queryByTestId('markdown-source')).toBeNull());

  await openEditor();
  await expectEditorText('извне');
  expect(screen.getByTestId('body-editor')).not.toHaveTextContent('и хвост');
  // Свой предел: тест ЖДЁТ настоящую паузу набора (2 с) — 409 иначе неоткуда взять, а подменять
  // здесь таймеры значило бы поднимать ProseMirror под поддельными часами.
}, 30_000);

// --- в режиме разметки редактора НЕТ, а плашки над вкладками нажимаются (ре-ревью раунда 4) ---
//
// Три сюжета ниже об одном: `onAccept` — канал ОТ РЕДАКТОРА, а плашки черновика и конфликта
// живут над вкладками и доступны, когда редактор размонтирован. Значит на время открытой
// разметки канал молчит, и всё, что меняет тело оттуда, обязано учитываться иначе.

test('«Оставить моё» из режима разметки не откатывается «Отменой»', async () => {
  // Пока о показанном сообщал только редактор, посадка черновика из разметки не двигала
  // запомненное — и «Отмена» сажала обратно набранное ДО черновика: на сервере черновик, на
  // экране текст до него, местная копия заслоняет базу, а первое нажатие уезжает поверх
  // черновика. Кнопка обещала заменить текст записи, «Отмена» обещала не менять ничего —
  // и вместе они сделали третье (ре-ревью раунда 4, Д1).
  seedDraft(parseBody('черновик прошлой сессии'), 'СТАРАЯ-МЕТКА');
  renderWithProviders(<DetailScreen entityId="e1" />, bodyHandler('тело'));
  const field = await editorField();
  await userEvent.click(field);
  await userEvent.type(field, 'X');
  await expectEditorText('X');

  await openDetailMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Править как markdown' }));
  await screen.findByTestId('markdown-source');
  // Баннер черновика живёт ВНЕ вкладок (находка 4) — то есть нажимается и отсюда.
  fireEvent.click(screen.getByRole('button', { name: 'Оставить моё' }));
  fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
  await waitFor(() => expect(screen.queryByTestId('markdown-source')).toBeNull());

  await openEditor();
  await expectEditorText('черновик прошлой сессии');
}, 30_000);

test('«Обновить» из режима разметки не заслоняется «Отменой»', async () => {
  // Тот же разрыв с другой стороны: конфликт → разметка → «Обновить» приносит чужое тело, а
  // извещать о подмене некому (редактора нет). Снятая проверка свежести открывала ровно ту
  // находку, ради которой писалась (ре-ревью раунда 4, Д2).
  const outside = {
    ...entity,
    title: 'Изменено извне',
    body: 'извне',
    bodyDoc: parseBody('извне'),
    updatedAt: 'B',
  };
  const serve = { outside: false };
  renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get')
      return { entity: serve.outside ? outside : entity, relations: [], thread: null };
    if (path === 'entity.update') throw trpcError('CONFLICT');
    if (path === 'aspect.list') return [];
    return {};
  });
  const field = await editorField();
  await userEvent.click(field);
  await userEvent.type(field, ' и хвост');
  await expectEditorText('и хвост');
  const refresh = await screen.findByRole('button', { name: 'Обновить' }, EDITOR_READY);

  // Разметка открывается ДО «Обновить» — в этом вся разница с тестом раунда 3: там чужое тело
  // приезжало при живом редакторе, здесь редактора нет вовсе.
  await openDetailMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Править как markdown' }));
  await screen.findByTestId('markdown-source');

  serve.outside = true;
  fireEvent.click(refresh);
  await waitFor(() =>
    expect(screen.getByRole('heading', { name: 'Изменено извне' })).toBeInTheDocument(),
  );

  fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
  await waitFor(() => expect(screen.queryByTestId('markdown-source')).toBeNull());
  await openEditor();
  await expectEditorText('извне');
}, 30_000);

test('ничего не трогали: приехавшее тело не заслоняется выходом из разметки', async () => {
  // Человек ничего не менял — и приехавшее чужое тело обязано остаться на экране после выхода
  // из разметки. Держит это НЕ пустота запомненного (редактор извещает о показанном и на
  // монтировании — иначе протухшее переживало бы отказанную посадку, ре-ревью раунда 5, Б-1), а
  // страж выхода: серверное тело сдвинулось с момента открытия — показанное не сажаем.
  //
  // Тест был ЛОЖНО-ЗЕЛЁНЫМ, пока извещение уходило только из ветки подмены: запомненное в этом
  // сюжете оставалось пустым, ветка посадки была недостижима, и он не различал ни мутанта, ни
  // снятие стража (ре-ревью раунда 5). Теперь различает — мутант «сажать без снимка на момент
  // открытия» его красит.
  const outside = {
    ...entity,
    title: 'Изменено извне',
    body: 'извне',
    bodyDoc: parseBody('извне'),
    updatedAt: 'B',
  };
  const serve = { outside: false };
  renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get')
      return { entity: serve.outside ? outside : entity, relations: [], thread: null };
    if (path === 'entity.update') return entity;
    if (path === 'aspect.list') return [];
    return {};
  });
  await openEditor(); // редактор поднят, но НИ ОДНОГО нажатия в нём не было
  await expectEditorText('тело');

  await openDetailMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Править как markdown' }));
  await screen.findByTestId('markdown-source');

  // Чужое тело приезжает, пока разметка открыта: чекбокс двигает запись, инвалидация
  // перечитывает её.
  serve.outside = true;
  fireEvent.click(screen.getByRole('checkbox', { name: /готово/i }));
  await waitFor(() =>
    expect(screen.getByRole('heading', { name: 'Изменено извне' })).toBeInTheDocument(),
  );

  fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
  await waitFor(() => expect(screen.queryByTestId('markdown-source')).toBeNull());
  await openEditor();
  await expectEditorText('извне');
}, 30_000);

test('выход из разметки ТЕМ ЖЕ пунктом меню не теряет набранное', async () => {
  // Дверей наружу четыре: «Отмена», Escape, «Применить» и тот же пункт меню ⋮. Последняя идёт
  // МИМО `onClose` тумблера, и заплата, повешенная на него, прикрывала бы три двери из четырёх
  // (ре-ревью раунда 4). Поэтому посадка показанного висит на СМЕНЕ ФЛАГА, а флаг меняется ровно
  // один раз на дверь, каким бы путём его ни повернули.
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
  await screen.findByTestId('markdown-source');
  // Выход ТЕМ ЖЕ пунктом — он просто переключает флаг.
  await openDetailMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Править как markdown' }));
  await waitFor(() => expect(screen.queryByTestId('markdown-source')).toBeNull());

  await openEditor();
  await expectEditorHas('тело', 'и хвост');
}, 30_000);

test('ВТОРОЙ заход в разметку после отказанной посадки не воскрешает протухшее', async () => {
  // Продолжение теста «„Обновить“ из режима разметки»: выход отказался сажать показанное (кэш
  // сдвинулся), но САМО показанное осталось протухшим — и следующий заход в разметку сажает его
  // поверх приехавшего. Шаг 5 — возврат блокера раунда 3, шаг 6 — блокера раунда 4, через один
  // лишний клик (ре-ревью раунда 5, Б-1).
  const outside = {
    ...entity,
    title: 'Изменено извне',
    body: 'извне',
    bodyDoc: parseBody('извне'),
    updatedAt: 'B',
  };
  const serve = { outside: false };
  renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get')
      return { entity: serve.outside ? outside : entity, relations: [], thread: null };
    if (path === 'entity.update') throw trpcError('CONFLICT');
    if (path === 'aspect.list') return [];
    return {};
  });
  const field = await editorField();
  await userEvent.click(field);
  await userEvent.type(field, ' и хвост');
  await expectEditorText('и хвост');
  const refresh = await screen.findByRole('button', { name: 'Обновить' }, EDITOR_READY);

  await openDetailMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Править как markdown' }));
  await screen.findByTestId('markdown-source');
  serve.outside = true;
  fireEvent.click(refresh);
  await waitFor(() =>
    expect(screen.getByRole('heading', { name: 'Изменено извне' })).toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
  await waitFor(() => expect(screen.queryByTestId('markdown-source')).toBeNull());
  await openEditor();
  await expectEditorText('извне'); // премиса: до сюда всё как в тесте раунда 4

  // ВТОРОЙ заход. Редактор к этому моменту снова живой и показывает чужое тело — значит
  // запомненное обязано быть чужим телом, а не тем, что человек печатал до «Обновить».
  await openDetailMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Править как markdown' }));
  expect(await screen.findByTestId('markdown-source')).toHaveValue('извне');

  fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
  await waitFor(() => expect(screen.queryByTestId('markdown-source')).toBeNull());
  await openEditor();
  await expectEditorText('извне');
}, 30_000);

test('выход из разметки сажает набранное ПОСЛЕ завершившегося круга сохранения', async () => {
  // Снимок серверного тела берётся на ВХОДЕ в разметку, а не замирает на монтировании. Разница
  // видна без всяких часов — по причинному факту «круг сохранения завершился»: после него
  // тело в кэше уже другое, чем было при монтировании (ре-ревью раунда 5).
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, bodyHandler('тело'));
  const field = await editorField();
  await userEvent.click(field);
  await userEvent.type(field, ' раз');
  // Круг: отправка ушла И запись перечитана. Дальше кэш заведомо не тот, что на монтировании.
  await waitFor(
    () => expect(calls.some((c) => c.path === 'entity.update')).toBe(true),
    EDITOR_READY,
  );
  await waitFor(
    () => expect(calls.filter((c) => c.path === 'entity.get').length).toBeGreaterThan(1),
    EDITOR_READY,
  );

  // Этого сервер ещё не видел — и оно обязано пережить заход в разметку и обратно.
  await userEvent.type(
    screen.getByTestId('body-editor').querySelector('[contenteditable]') as HTMLElement,
    ' два',
  );
  await expectEditorHas('тело', 'раз', 'два');

  await openDetailMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Править как markdown' }));
  await screen.findByTestId('markdown-source');
  fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
  await waitFor(() => expect(screen.queryByTestId('markdown-source')).toBeNull());

  await openEditor();
  await expectEditorHas('тело', 'раз', 'два');
}, 30_000);

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

test('когда сказать нечего, полоса плашек ПУСТА — а не занимает место молча', async () => {
  // `empty:hidden` прячет полосу только по-настоящему пустую (`:empty` — ни одного узла внутри).
  // Пока индикатор жил в обёртке, та была ребёнком полосы ВСЕГДА, и над вкладками висел
  // постоянный отступ там, где сказать нечего (ре-ревью раунда 3, пункт 5). Стилей в jsdom нет,
  // поэтому спрашиваем то, от чего правило зависит: есть ли внутри узлы.
  renderWithProviders(<DetailScreen entityId="e1" />, bodyHandler('тело'));
  const strip = await screen.findByTestId('body-notices');
  expect(strip).toBeEmptyDOMElement();

  // Положительный контроль: появись чему быть — полоса перестаёт быть пустой, и правило её
  // показывает. Без него проверка была бы зелена и у полосы, в которую ничего не попадает.
  seedDraft(parseBody('черновик прошлой сессии'), 'СТАРАЯ-МЕТКА');
  renderWithProviders(<DetailScreen entityId="e1" />, bodyHandler('тело'));
  await waitFor(() =>
    expect(screen.getAllByTestId('body-notices').some((n) => !n.matches(':empty'))).toBe(true),
  );
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

// ─── ADE-срез 1: экран тикета (Задача 14) ────────────────────────────────────────────────
//
// Тикет — задача С НАЗНАЧЕНИЕМ: чекпойнт-блок и список прогонов показываются только у неё.
// Карточка назначения — у ЛЮБОЙ задачи: исполнителя ставит владелец, и до него тикета ещё нет.

const GRANT_ID = '9b1c1d2e-3f40-4a51-8b62-7c8d9e0f1a2b';

/** Полная wire-форма гранта (oauth.listGrants): `scope` в ней есть с Задачи 8. */
const GRANT = {
  id: GRANT_ID,
  kind: 'oauth',
  label: 'worker-1',
  connected: true,
  createdAt: '2026-08-16T09:00:00.000Z',
  lastUsedAt: '2026-08-17T09:00:00.000Z',
  revokedAt: null,
  scope: 'worker',
};

/** Прогон приезжает из entity.query — без bodyDoc и связей: запрос списка их не просит. */
const RUN = {
  id: 'r1',
  ownerId: 'u',
  title: 'Прогон: Починить парсер',
  emoji: null,
  body: '',
  bodyRefs: [],
  tags: [],
  meta: {},
  aspects: {
    'orbis/agent-run': {
      grant_id: GRANT_ID,
      outcome: 'checkpoint',
      started_at: '2026-08-17T10:00:00.000Z',
      last_step_at: '2026-08-17T10:05:00.000Z',
      step_count: 3,
      steps: [],
      checkpoint: { question: 'Какую БД брать?', asked_at: '2026-08-17T10:05:00.000Z' },
    },
  },
  createdAt: '2026-08-17T10:00:00.000Z',
  updatedAt: '2026-08-17T10:05:00.000Z',
  archived: false,
};

/** `may_close` в аспекте НЕТ — отсутствие и есть false (С8): это и проверяет чекбокс. */
const TICKET = {
  ...entity,
  id: 't1',
  title: 'Починить парсер',
  aspects: {
    'orbis/task': { status: 'waiting', waiting_for: 'Какую БД брать?' },
    'orbis/assignment': { executor: 'agent', grant_id: GRANT_ID },
  },
};

function adeHandler(opts: { entity?: unknown; runs?: unknown[] } = {}): MockHandler {
  const target = opts.entity ?? TICKET;
  return (path) => {
    if (path === 'entity.get') return { entity: target, relations: [], thread: null };
    if (path === 'entity.query') return opts.runs ?? [RUN];
    if (path === 'oauth.listGrants') return [GRANT];
    if (path === 'aspect.list') return [];
    if (path === 'agentRun.sweep') return { swept: 0 };
    if (path === 'agentRun.answerCheckpoint') return { ticket: target, run: RUN };
    if (path === 'entity.update') return target;
    return {};
  };
}

/**
 * Тикет, смонтированный НА ТЁПЛЫЙ КЭШ: запись уже прочитана, и экран получает её ПЕРВЫМ же
 * рендером. Обычный сюжет — возврат на тикет, который только что открывали.
 *
 * Обёртка нужна ровно ради двойного прогона эффектов. Смонтируй `DetailScreen` на холодную —
 * и первый (двойной) прогон придётся на экран БЕЗ данных, где подметать нечего: тикет ещё
 * неизвестен. Эффект уйдёт один раз просто потому, что второй раз ему нечего было делать, — то
 * есть проверка была бы зелена и у экрана вовсе без гварда. Замерено мутацией: снятый гвард
 * при холодном монтировании тест переживает.
 */
function TicketOnWarmCache() {
  const q = trpc.entity.get.useQuery(detailGetInput('t1'));
  return q.data ? <DetailScreen entityId="t1" /> : null;
}

/** Второй тикет — тот же экран, другой проп: переход внутри вкладки монтирования не меняет. */
const TICKET_B = {
  ...TICKET,
  id: 't2',
  title: 'Собрать релиз',
  aspects: {
    'orbis/task': { status: 'waiting', waiting_for: 'Тегать ли rc?' },
    'orbis/assignment': { executor: 'agent', grant_id: GRANT_ID },
  },
};

function TwoTickets() {
  const [id, setId] = useState('t1');
  return (
    <>
      <button type="button" data-testid="go-t2" onClick={() => setId('t2')}>
        на t2
      </button>
      {/* Возврат нужен, чтобы прогреть кэш соседнего тикета: только на ТЁПЛОМ кэше видно, что
          блок ожидания живёт между записями, — на холодном его снимает сам `isTicket`, пока
          запись едет (см. тест про черновик ответа). */}
      <button type="button" data-testid="go-t1" onClick={() => setId('t1')}>
        на t1
      </button>
      <DetailScreen entityId={id} />
    </>
  );
}

describe('ADE: тикет', () => {
  test('таб «Сущность»: виден вопрос чекпойнта и кнопка; ввод ответа → agentRun.answerCheckpoint с ticketId/runId/answer (приёмка 7–8)', async () => {
    const { calls } = renderWithProviders(<DetailScreen entityId="t1" />, adeHandler());
    const panel = await screen.findByRole('tabpanel', { name: 'Сущность' });
    expect(await within(panel).findByText('Какую БД брать?')).toBeInTheDocument();
    // Заголовок — по исходу последнего прогона: у checkpoint это вопрос, а не итог.
    expect(within(panel).getByText('Вопрос исполнителя')).toBeInTheDocument();
    // …и закрывать тут нечего: «Закрыть тикет» есть только у сделанной работы (см. ниже).
    expect(within(panel).queryByRole('button', { name: 'Закрыть тикет' })).toBeNull();

    // Считаем чтения ДО жеста: тикет уже перечитывался (подметание при открытии зовёт
    // invalidateGraph), и без отсечки проверка инвалидации ниже была бы зелена сама собой.
    const readsBefore = calls.filter((c) => c.path === 'entity.get').length;
    await userEvent.type(screen.getByLabelText('Ответ'), 'Postgres');
    await userEvent.click(screen.getByRole('button', { name: 'Ответить и вернуть в работу' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === 'agentRun.answerCheckpoint')?.input).toEqual({
        ticketId: 't1',
        runId: 'r1',
        answer: 'Postgres',
      }),
    );
    // Ответ двигает и тикет (waiting → planned), и прогон: граф перечитывается целиком.
    await waitFor(() =>
      expect(calls.filter((c) => c.path === 'entity.get').length).toBeGreaterThan(readsBefore),
    );
  });

  test('таб «Детали»: карточка назначения показывает грант «worker-1» и may_close; смена may_close → entity.update с aspects.orbis/assignment', async () => {
    const { calls } = renderWithProviders(<DetailScreen entityId="t1" />, adeHandler());
    const details = await screen.findByRole('tabpanel', { name: 'Детали' });
    const card = within(details).getByTestId('assignment-card');
    // Грант показан ПОДПИСЬЮ, а не идентификатором: отзывать и переназначать владелец
    // будет по ней (та же конвенция, что в «Агентах» настроек).
    expect(await within(card).findByText('worker-1')).toBeInTheDocument();

    const mayClose = within(card).getByRole('checkbox', { name: 'Может закрывать сам' });
    expect(mayClose).not.toBeChecked(); // поля в аспекте нет — значит false (С8)
    await userEvent.click(mayClose);
    await userEvent.click(within(card).getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => {
      const input = calls.find((c) => c.path === 'entity.update')?.input as {
        id: string;
        aspects: Record<string, Record<string, unknown>>;
      };
      expect(input.id).toBe('t1');
      expect(input.aspects['orbis/assignment']).toEqual({
        executor: 'agent',
        grant_id: GRANT_ID,
        may_close: true,
      });
    });

    // Второй карточки того же аспекта в общем списке свойств НЕТ: у назначения свой контрол,
    // и сырой инпут рядом правил бы то же поле мимо инварианта исполнителя.
    expect(within(details).queryByTestId('aspect-orbis/assignment')).toBeNull();
  });

  test('переключение агент → человек уходит с grant_id:null; «Снять назначение» снимает аспект целиком', async () => {
    const { calls } = renderWithProviders(<DetailScreen entityId="t1" />, adeHandler());
    const card = within(await screen.findByRole('tabpanel', { name: 'Детали' })).getByTestId(
      'assignment-card',
    );
    // Выбранный доступ подставлен из аспекта: сохранение без касания списка обязано оставить
    // тикет у того же агента.
    expect(within(card).getByLabelText('Доступ агента')).toHaveValue(GRANT_ID);

    await userEvent.click(within(card).getByRole('radio', { name: 'Человек' }));
    await userEvent.click(within(card).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => {
      const input = calls.find((c) => c.path === 'entity.update')?.input as {
        aspects: Record<string, Record<string, unknown> | null>;
      };
      // grant_id:null ОБЯЗАТЕЛЕН: пару (human, grant_id) сервер считает рассогласованием и
      // отвечает VALIDATION, а патч мержится по полям — без null прежний грант пережил бы
      // переключение.
      expect(input.aspects['orbis/assignment']).toEqual({
        executor: 'human',
        grant_id: null,
        may_close: null,
      });
    });

    await userEvent.click(within(card).getByRole('button', { name: 'Снять назначение' }));
    await waitFor(() => {
      const last = calls.filter((c) => c.path === 'entity.update').at(-1)?.input as {
        aspects: Record<string, unknown>;
      };
      expect(last.aspects['orbis/assignment']).toBeNull();
    });
  });

  test('прогон завершён: заголовок «Готово, проверьте» и вторая кнопка — «Закрыть тикет»', async () => {
    const finished = {
      ...RUN,
      aspects: {
        'orbis/agent-run': {
          ...RUN.aspects['orbis/agent-run'],
          outcome: 'finished',
          checkpoint: undefined,
          finished_at: '2026-08-17T10:30:00.000Z',
          report: 'Парсер починен, тесты зелёные.',
        },
      },
    };
    const { calls } = renderWithProviders(
      <DetailScreen entityId="t1" />,
      adeHandler({ runs: [finished] }),
    );
    const panel = await screen.findByRole('tabpanel', { name: 'Сущность' });
    expect(await within(panel).findByText('Готово, проверьте')).toBeInTheDocument();
    // Ответить можно и на итог (агент прочтёт его следующим захватом) — но у сделанной работы
    // есть второй исход, которого нет у вопроса: закрыть тикет.
    expect(
      within(panel).getByRole('button', { name: 'Ответить и вернуть в работу' }),
    ).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Закрыть тикет' }));
    await waitFor(() => {
      const input = calls.find((c) => c.path === 'entity.update')?.input as {
        id: string;
        aspects: Record<string, Record<string, unknown>>;
      };
      expect(input.id).toBe('t1');
      // waiting_for снимается вместе с уходом из waiting — конвенция среза: вопрос рядом с
      // закрытым тикетом читался бы как открытый (так же поступает сервер на своих выходах).
      expect(input.aspects['orbis/task']).toEqual({ status: 'done', waiting_for: null });
    });
  });

  test('таб «Детали»: список прогонов с исходом и числом шагов; клик открывает прогон', async () => {
    renderWithProviders(<DetailScreen entityId="t1" />, adeHandler());
    const details = await screen.findByRole('tabpanel', { name: 'Детали' });
    const row = await within(details).findByTestId('run-r1');
    expect(row).toHaveTextContent('вопрос');
    expect(row).toHaveTextContent('3 шага');
    expect(row).toHaveTextContent('worker-1');

    fireEvent.click(row);
    // Открытие прогона — тем же жестом, что и подзадачи: push поверх стека АКТИВНОЙ вкладки.
    const nav = useNav.getState();
    expect(nav.activeTab).toBe('browser');
    expect(nav.stacks.browser.at(-1)).toEqual({ kind: 'entity', id: 'r1' });
  });

  test('тикет не в waiting → чекпойнт-блока нет; заметка без orbis/task → назначения и прогонов нет', async () => {
    const working = {
      ...TICKET,
      aspects: {
        'orbis/task': { status: 'in_progress' },
        'orbis/assignment': { executor: 'agent', grant_id: GRANT_ID },
      },
    };
    const first = renderWithProviders(
      <DetailScreen entityId="t1" />,
      adeHandler({ entity: working }),
    );
    await screen.findByRole('tabpanel', { name: 'Сущность' });
    expect(screen.queryByTestId('ticket-waiting')).toBeNull();
    // И это НЕ «экран потерял всё»: назначение и прогоны идущего тикета на месте.
    expect(screen.getByTestId('assignment-card')).toBeInTheDocument();
    expect(await screen.findByTestId('run-r1')).toBeInTheDocument();
    first.unmount();

    const note = { ...entity, id: 'n1', aspects: { 'orbis/note': {} } };
    const { calls } = renderWithProviders(
      <DetailScreen entityId="n1" />,
      adeHandler({ entity: note }),
    );
    await screen.findByRole('tabpanel', { name: 'Детали' });
    expect(screen.queryByTestId('ticket-waiting')).toBeNull();
    expect(screen.queryByTestId('assignment-card')).toBeNull();
    expect(screen.queryByTestId('runs-list')).toBeNull();
    // Прогоны заметки не спрашиваются вовсе — ни запроса списка, ни подметания.
    expect(calls.some((c) => c.path === 'entity.query')).toBe(false);
    expect(calls.some((c) => c.path === 'agentRun.sweep')).toBe(false);
  });

  test('открытие тикета зовёт agentRun.sweep один раз (С6: подметание с экранов)', async () => {
    // strict: <StrictMode> прогоняет эффекты монтирования ДВАЖДЫ — ровно как приложение в
    // разработке (main.tsx). Без гварда подметание уходило бы двумя запросами на открытие.
    const { calls } = renderWithProviders(<TicketOnWarmCache />, adeHandler(), { strict: true });
    await screen.findAllByRole('tabpanel', { name: 'Сущность' });
    await waitFor(() =>
      expect(calls.filter((c) => c.path === 'agentRun.sweep').length).toBeGreaterThan(0),
    );
    expect(calls.filter((c) => c.path === 'agentRun.sweep')).toHaveLength(1);
  });

  test('подметание вхолостую (swept=0) граф не перечитывает; swept>0 — перечитывает', async () => {
    // Экран тикета открывают часто, а брошенный прогон — событие редкое: инвалидация на
    // каждом открытии стоила бы второго entity.get с телом и bodyDoc (самый тяжёлый запрос
    // экрана) ради ответа «ничего не подмели».
    const idle = renderWithProviders(<DetailScreen entityId="t1" />, adeHandler());
    await screen.findByRole('tabpanel', { name: 'Сущность' });
    await waitFor(() =>
      expect(idle.calls.filter((c) => c.path === 'agentRun.sweep')).toHaveLength(1),
    );
    // Ответ подметания уже разобран (инвалидация ушла бы этим же тиком) — дочитываний нет
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(idle.calls.filter((c) => c.path === 'entity.get')).toHaveLength(1);
    idle.unmount();

    // …и это не «экран разучился перечитывать»: подмели хоть один прогон — граф протух
    const swept = renderWithProviders(<DetailScreen entityId="t1" />, (path, input) => {
      if (path === 'agentRun.sweep') return { swept: 1 };
      return adeHandler()(path, input);
    });
    await screen.findByRole('tabpanel', { name: 'Сущность' });
    await waitFor(() =>
      expect(swept.calls.filter((c) => c.path === 'entity.get').length).toBeGreaterThan(1),
    );
  });

  test('orbis/assignment без orbis/task: карточка назначения видна (иначе назначение не снять)', async () => {
    // Сервер назначения на не-задаче не запрещает (invariants.ts), а прячь мы карточку —
    // владелец видел бы запись, которую агент считает своей, и не мог бы это отменить.
    const assignedNote = {
      ...entity,
      id: 'n2',
      aspects: { 'orbis/assignment': { executor: 'agent', grant_id: GRANT_ID } },
    };
    renderWithProviders(<DetailScreen entityId="n2" />, adeHandler({ entity: assignedNote }));
    await screen.findByRole('tabpanel', { name: 'Детали' });
    const card = await screen.findByTestId('assignment-card');
    expect(within(card).getByRole('button', { name: 'Снять назначение' })).toBeEnabled();
  });

  test('назначенный грант отозван: карточка говорит об этом и «Сохранить» заблокирована', async () => {
    // Отозванный грант в списке живых не появляется, а черновик держит его id: без этой
    // ветки select показывал бы плейсхолдер «— выберите доступ —», а «Сохранить» бодро
    // слала бы отозванный id обратно — и сервер отвечал бы NOT_FOUND без объяснения.
    const revoked = { ...GRANT, revokedAt: '2026-08-17T10:00:00.000Z' };
    renderWithProviders(<DetailScreen entityId="t1" />, (path, input) => {
      if (path === 'oauth.listGrants') return [revoked];
      return adeHandler()(path, input);
    });
    const card = await screen.findByTestId('assignment-card');
    expect(await within(card).findByText(/грант отозван/i)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  });

  test('переход тикет→тикет не показывает прогоны прежнего тикета', async () => {
    // Экран монтируется БЕЗ key: смена записи меняет только проп, то есть КЛЮЧ запроса прогонов.
    // Оставленные под новым ключом прежние данные — это не «чуть устаревший список»: заголовок
    // блока брался бы из чужого исхода, а ответ владельца уехал бы с чужим runId.
    const { calls } = renderWithProviders(<TwoTickets />, (path, input) => {
      if (path === 'entity.get') {
        const { id } = input as { id: string };
        return {
          entity: id === 't2' ? TICKET_B : TICKET,
          relations: [],
          thread: null,
        };
      }
      // У второго тикета прогонов ещё нет вовсе — самый строгий случай для placeholder'а.
      if (path === 'entity.query')
        return (input as { query: string }).query.includes('t2') ? [] : [RUN];
      if (path === 'oauth.listGrants') return [GRANT];
      if (path === 'aspect.list') return [];
      if (path === 'agentRun.sweep') return { swept: 0 };
      return {};
    });
    // Премиса: у первого тикета прогон ЕСТЬ и виден — иначе проверка ниже зелена сама собой.
    expect(await screen.findByTestId('run-r1')).toBeInTheDocument();
    expect(await screen.findByText('Вопрос исполнителя')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('go-t2'));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Собрать релиз' })).toBeInTheDocument(),
    );
    // Ни строки прежнего прогона, ни блока ожидания, собранного по нему.
    await waitFor(() => expect(screen.queryByTestId('run-r1')).toBeNull());
    expect(screen.queryByTestId('runs-list')).toBeNull();
    expect(screen.queryByTestId('ticket-waiting')).toBeNull();
    // И список прогонов второго тикета спрошен своим ключом.
    expect(
      calls.some(
        (c) => c.path === 'entity.query' && (c.input as { query: string }).query.includes('t2'),
      ),
    ).toBe(true);
  });

  test('набранный ответ не переезжает на соседний тикет', async () => {
    // Экран монтируется БЕЗ key, и блок ожидания без своего key пережил бы смену записи вместе
    // с набранным текстом: владелец отправил бы соседнему исполнителю ответ, написанный не ему.
    const runB = { ...RUN, id: 'r2' };
    renderWithProviders(<TwoTickets />, (path, input) => {
      if (path === 'entity.get') {
        const { id } = input as { id: string };
        return { entity: id === 't2' ? TICKET_B : TICKET, relations: [], thread: null };
      }
      if (path === 'entity.query')
        return (input as { query: string }).query.includes('t2') ? [runB] : [RUN];
      if (path === 'oauth.listGrants') return [GRANT];
      if (path === 'aspect.list') return [];
      if (path === 'agentRun.sweep') return { swept: 0 };
      return {};
    });
    // Прогрев: сходить на t2 и вернуться. Без него переход идёт через кадр, где записи ещё нет,
    // а `isTicket` ложен, — блок снимается сам собой, и проверка была бы зелена и без key.
    fireEvent.click(screen.getByTestId('go-t2'));
    expect(await screen.findByTestId('run-r2')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('go-t1'));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Починить парсер' })).toBeInTheDocument(),
    );

    await userEvent.type(await screen.findByLabelText('Ответ'), 'Postgres');
    fireEvent.click(screen.getByTestId('go-t2'));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Собрать релиз' })).toBeInTheDocument(),
    );
    // Блок у второго тикета свой — и пустой, хотя кэш тёплый и промежуточного кадра не было.
    expect(screen.getByLabelText('Ответ')).toHaveValue('');
  });

  test('прогон не стоит строкой в «Подзадачах» — там только настоящие подзадачи', async () => {
    // Прогон — такой же ребёнок тикета по связи parent (verbs.ts), и без отсева служебных
    // аспектов он показывался бы дважды: строкой подзадачи и строкой своей секции.
    const relation = (targetId: string) => ({
      id: `rel-${targetId}`,
      sourceId: 't1',
      targetId,
      relationType: 'parent',
      meta: {},
      createdAt: '2026-08-17T10:00:00.000Z',
      updatedAt: '2026-08-17T10:00:00.000Z',
    });
    const subtask = {
      ...entity,
      id: 's1',
      title: 'Написать тест',
      aspects: { 'orbis/task': { status: 'inbox' } },
    };
    renderWithProviders(<DetailScreen entityId="t1" />, (path, input) => {
      if (path === 'entity.get') {
        const { id } = input as { id: string };
        if (id === 's1') return { entity: subtask, relations: [], thread: null };
        if (id === 'r1') return { entity: RUN, relations: [], thread: null };
        return { entity: TICKET, relations: [relation('s1'), relation('r1')], thread: null };
      }
      if (path === 'entity.query') return [RUN];
      if (path === 'oauth.listGrants') return [GRANT];
      if (path === 'aspect.list') return [];
      if (path === 'agentRun.sweep') return { swept: 0 };
      return {};
    });
    const details = await screen.findByRole('tabpanel', { name: 'Детали' });
    // Прогон уезжает из подзадач, как только приехала его запись: до этого он неотличим от
    // обычного ребёнка, и прятать его заранее было бы гаданием.
    await waitFor(() => expect(within(details).getAllByTestId('subtask')).toHaveLength(1));
    expect(within(details).getByTestId('subtask')).toHaveTextContent('Написать тест');
    expect(within(details).getByText('Подзадачи (1)')).toBeInTheDocument();
    // …и при этом он на месте в своей секции — отсев не «потерял прогон».
    expect(within(details).getByTestId('run-r1')).toBeInTheDocument();
  });
});

// ─── ADE-срез 1: экран прогона (Задача 15) ───────────────────────────────────────────────
//
// Прогон — НЕ тикет: аспекта `orbis/task` у него нет, поэтому ни блока ожидания, ни истории
// прогонов, ни подметания на нём быть не должно. Всё, ради чего его открывают, рисует ОДНА
// лента: общая карточка свойств аспект прогона прячет (AspectCards), а править его поля
// владельцу нечем — их пишет исполнитель.

/**
 * Шаги приезжают из аспекта КАК ЕСТЬ, и порядок в массиве здесь нарочно перепутан: лента
 * обязана строиться по `seq`, а не по тому, в каком порядке шаги легли в jsonb.
 */
const RUN_STEPS = [
  { seq: 1, at: '2026-08-17T10:01:00.000Z', summary: 'Прочитал тикет и план', external: false },
  { seq: 3, at: '2026-08-17T10:03:00.000Z', summary: 'Прогнал тесты', external: false },
  { seq: 2, at: '2026-08-17T10:02:00.000Z', summary: 'Завёл ветку fix/parser', external: true },
];

const RUN_ASPECT_FINISHED = {
  grant_id: GRANT_ID,
  outcome: 'finished',
  started_at: '2026-08-17T10:00:00.000Z',
  finished_at: '2026-08-17T10:04:00.000Z',
  last_step_at: '2026-08-17T10:03:00.000Z',
  step_count: 3,
  steps: RUN_STEPS,
  report: 'Парсер починен, тесты зелёные.',
  usage: { input_tokens: 12000, output_tokens: 3400, cost_usd: 0.42 },
  session_url: 'https://agent.example/session/r1',
};

/** Сам прогон в объёме detail (entity.get): с телом и bodyDoc, как любая запись графа. */
const RUN_ENTITY = {
  ...entity,
  id: 'r1',
  title: 'Прогон: Починить парсер',
  aspects: { 'orbis/agent-run': RUN_ASPECT_FINISHED },
};

/**
 * Записка успешного отката приходит С СЕРВЕРА (agent-loop/rollback.ts ROLLBACK_NOTE) — здесь
 * она НАРОЧНО другая. Повтори экран боевую фразу хардкодом, и проверка «текст про репозиторий
 * виден» была бы зелена, не доказав ничего: граница «Orbis откатили, git не трогали» — слово
 * сервера, и экран обязан печатать именно его.
 */
const ROLLBACK_NOTE = 'Откачено в Orbis; ветку и коммиты откатывайте git-ом (текст сервера).';

function runHandler(opts: { run?: unknown; rollback?: unknown } = {}): MockHandler {
  const target = opts.run ?? RUN_ENTITY;
  return (path, input) => {
    if (path === 'entity.get') {
      const { id } = input as { id: string };
      // Конфликтная строка дочитывает заголовок задетой сущности своим entity.get (EntityRef).
      return id === 'r1' ? { entity: target, relations: [], thread: null } : { entity: TICKET };
    }
    if (path === 'oauth.listGrants') return [GRANT];
    if (path === 'aspect.list') return [];
    if (path === 'agentRun.rollback')
      return opts.rollback ?? { ok: true, undone: ['a1', 'a2'], note: ROLLBACK_NOTE };
    return {};
  };
}

describe('ADE: прогон', () => {
  test('лента шагов по возрастанию seq; «внешнее» только у своего шага; исход, отчёт, грант, расход и ссылка на сессию', async () => {
    const { calls } = renderWithProviders(<DetailScreen entityId="r1" />, runHandler());
    const feed = await screen.findByTestId('run-feed');

    const steps = within(within(feed).getByTestId('run-steps')).getAllByRole('listitem');
    expect(steps.map((li) => li.textContent)).toEqual([
      expect.stringContaining('Прочитал тикет и план'),
      expect.stringContaining('Завёл ветку fix/parser'),
      expect.stringContaining('Прогнал тесты'),
    ]);
    // Метка «внешнее» — у шага, тронувшего мир ВНЕ Orbis (С5). По ней человек читает, чего
    // откат ему не вернёт, поэтому лишняя метка тут так же вредна, как пропущенная.
    expect(steps[1]).toHaveTextContent('внешнее');
    expect(steps[0]).not.toHaveTextContent('внешнее');
    expect(steps[2]).not.toHaveTextContent('внешнее');

    expect(within(feed).getByText('готово')).toBeInTheDocument();
    expect(within(feed).getByText('Парсер починен, тесты зелёные.')).toBeInTheDocument();
    // Грант — подписью, как в истории прогонов: сырой uuid не отвечает, кто это делал.
    expect(await within(feed).findByText('worker-1')).toBeInTheDocument();
    expect(feed).toHaveTextContent('12000');
    expect(feed).toHaveTextContent('$0.42');

    const link = within(feed).getByRole('link', { name: /сесси/i });
    expect(link).toHaveAttribute('href', 'https://agent.example/session/r1');
    expect(link).toHaveAttribute('target', '_blank');
    // rel обязателен: ссылка ведёт наружу, во владения исполнителя.
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));

    // Прогон — не тикет: подметать на нём нечего, блоков тикета на экране нет.
    expect(screen.queryByTestId('ticket-waiting')).toBeNull();
    expect(screen.queryByTestId('runs-list')).toBeNull();
    expect(calls.some((c) => c.path === 'agentRun.sweep')).toBe(false);
    // …и второй копии тех же полей общей карточкой свойств тоже нет.
    expect(screen.queryByTestId('aspect-orbis/agent-run')).toBeNull();
  });

  test('вопрос, ответ владельца и записка обрыва — отдельными блоками', async () => {
    const abandoned = {
      ...RUN_ENTITY,
      aspects: {
        'orbis/agent-run': {
          ...RUN_ASPECT_FINISHED,
          outcome: 'abandoned',
          report: undefined,
          checkpoint: { question: 'Какую БД брать?', asked_at: '2026-08-17T10:02:30.000Z' },
          reply: { text: 'Postgres', at: '2026-08-17T10:02:50.000Z' },
          abandon_note: 'Исполнитель молчал 30 минут — прогон подмели.',
        },
      },
    };
    renderWithProviders(<DetailScreen entityId="r1" />, runHandler({ run: abandoned }));
    const feed = await screen.findByTestId('run-feed');
    expect(within(feed).getByText('оборван')).toBeInTheDocument();
    expect(within(feed).getByText('Какую БД брать?')).toBeInTheDocument();
    expect(within(feed).getByText('Postgres')).toBeInTheDocument();
    expect(
      within(feed).getByText('Исполнитель молчал 30 минут — прогон подмели.'),
    ).toBeInTheDocument();
  });

  test('откат: подтверждение → agentRun.rollback({runId}); на экране записка сервера и число откаченных', async () => {
    const { calls } = renderWithProviders(<DetailScreen entityId="r1" />, runHandler());
    const feed = await screen.findByTestId('run-feed');
    await userEvent.click(within(feed).getByRole('button', { name: 'Откатить прогон в Orbis' }));
    // Подтверждение — модалкой из ui/, а не window.confirm: жест необратим, и спрашивать о
    // нём надо тем же языком, что и всё остальное на экране.
    const dialog = await screen.findByRole('dialog');

    // Считаем чтения ДО жеста: экран уже читал запись, и проверка инвалидации ниже без
    // отсечки была бы зелена сама собой.
    const readsBefore = calls.filter((c) => c.path === 'entity.get').length;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Откатить' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === 'agentRun.rollback')?.input).toEqual({ runId: 'r1' }),
    );

    const result = await screen.findByTestId('rollback-result');
    expect(result).toHaveTextContent(ROLLBACK_NOTE);
    expect(result).toHaveTextContent('2');
    // Откат ДВИГАЕТ граф (тикет вернулся в очередь, прогон архивирован) — граф перечитывается.
    await waitFor(() =>
      expect(calls.filter((c) => c.path === 'entity.get').length).toBeGreaterThan(readsBefore),
    );
  });

  test('конфликт: список чужих правок и «Ничего не откачено»', async () => {
    const { calls } = renderWithProviders(
      <DetailScreen entityId="r1" />,
      runHandler({
        rollback: {
          ok: false,
          reason: 'conflict',
          conflicts: [
            {
              entityId: 't1',
              actionId: 'a9',
              at: '2026-08-17T11:00:00.000Z',
              source: 'ui',
            },
          ],
        },
      }),
    );
    const feed = await screen.findByTestId('run-feed');
    await userEvent.click(within(feed).getByRole('button', { name: 'Откатить прогон в Orbis' }));
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Откатить' }),
    );

    const result = await screen.findByTestId('rollback-result');
    // Инвариант 7: конфликт значит, что граф НЕ тронут вовсе, — и сказать это надо словами.
    expect(result).toHaveTextContent('Ничего не откачено');
    // Задетая запись названа ЗАГОЛОВКОМ: по uuid человек не решит, чем он готов пожертвовать.
    expect(await within(result).findByText('Починить парсер')).toBeInTheDocument();
    // Источник правки — по-русски: «ui» не отвечает владельцу, своей это было рукой или чужой.
    expect(result).toHaveTextContent('с экрана');
    // Ничего не откачено — и перечитывать граф незачем: он не менялся. Считаем чтения САМОГО
    // прогона: строка конфликта дочитывает заголовок задетой записи своим entity.get.
    expect(
      calls.filter((c) => c.path === 'entity.get' && (c.input as { id: string }).id === 'r1'),
    ).toHaveLength(1);
  });

  test('частичный откат: сколько успели и на чём встали', async () => {
    renderWithProviders(
      <DetailScreen entityId="r1" />,
      runHandler({
        rollback: {
          ok: false,
          reason: 'partial',
          undone: ['a1'],
          failed: { actionId: 'a2', error: { code: 'VALIDATION', message: 'запись изменена' } },
        },
      }),
    );
    const feed = await screen.findByTestId('run-feed');
    await userEvent.click(within(feed).getByRole('button', { name: 'Откатить прогон в Orbis' }));
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Откатить' }),
    );
    const result = await screen.findByTestId('rollback-result');
    // Часть отката уже в графе — молчать об этом нельзя: состояние графа теперь смешанное.
    expect(result).toHaveTextContent('1');
    expect(result).toHaveTextContent('запись изменена');
  });

  test('идущий прогон: откат недоступен', async () => {
    const running = {
      ...RUN_ENTITY,
      aspects: {
        'orbis/agent-run': {
          ...RUN_ASPECT_FINISHED,
          outcome: 'running',
          finished_at: undefined,
          report: undefined,
        },
      },
    };
    renderWithProviders(<DetailScreen entityId="r1" />, runHandler({ run: running }));
    const feed = await screen.findByTestId('run-feed');
    expect(within(feed).getByText('идёт')).toBeInTheDocument();
    // Откатывать живой прогон бессмысленно: исполнитель допишет поверх отката (см. RunFeed).
    expect(within(feed).getByRole('button', { name: 'Откатить прогон в Orbis' })).toBeDisabled();
  });

  test('архивированный прогон: бейдж архива, откат недоступен', async () => {
    // Серия отмен возвращает аспект прогона к состоянию создания (`running`, шагов нет) и
    // архивирует запись. Без признака архива экран показывал бы такой прогон вечно идущим
    // с подсказкой «откатывать нечего» — то есть врал бы про уже сделанный откат.
    // Но и бейдж, и подсказка говорят про АРХИВ, а не про откат: в архив прогон кладёт и
    // «Архивировать» из меню ⋮, и такой прогон приходит сюда с целым аспектом и всеми шагами.
    const rolledBack = {
      ...RUN_ENTITY,
      archived: true,
      aspects: {
        'orbis/agent-run': {
          ...RUN_ASPECT_FINISHED,
          outcome: 'running',
          finished_at: undefined,
          report: undefined,
          step_count: 0,
          steps: [],
        },
      },
    };
    renderWithProviders(<DetailScreen entityId="r1" />, runHandler({ run: rolledBack }));
    const feed = await screen.findByTestId('run-feed');
    expect(within(feed).getByText('в архиве')).toBeInTheDocument();
    expect(within(feed).getByRole('button', { name: 'Откатить прогон в Orbis' })).toBeDisabled();
    expect(feed).toHaveTextContent('Прогон в архиве — откат недоступен');
  });

  test('session_url чужой схемы — текстом, а не ссылкой', async () => {
    // Адрес сессии пишет ИСПОЛНИТЕЛЬ своим глаголом, то есть это чужой ввод в href.
    // `javascript:` в href — исполнение чужого кода по клику владельца; показать такую
    // строку текстом можно (иногда это опечатка), сделать кликабельной — нельзя.
    const evil = {
      ...RUN_ENTITY,
      aspects: {
        'orbis/agent-run': { ...RUN_ASPECT_FINISHED, session_url: 'javascript:alert(1)' },
      },
    };
    renderWithProviders(<DetailScreen entityId="r1" />, runHandler({ run: evil }));
    const feed = await screen.findByTestId('run-feed');
    expect(within(feed).queryByRole('link', { name: /сесси/i })).toBeNull();
    expect(feed).toHaveTextContent('javascript:alert(1)');
  });
});

// ─── ADE-срез 1: закреплённые версии тела (Задача 16) ────────────────────────────────────
//
// Закрепление — страховка ВЛАДЕЛЬЦА перед тем, как отдать запись агенту: «сохрани как есть,
// чтобы было куда вернуться». Отсюда и два жеста в разных местах экрана: закрепляют из меню ⋮
// (оно одно на все вкладки), а восстанавливают из списка версий на «Деталях».

/** Wire-форма version.list: тела в ней нет вовсе — вместо документа едет признак `hasDoc`. */
const VERSIONS = [
  {
    id: 'v1',
    entityId: 'e1',
    label: 'до правки агентом',
    hasDoc: true,
    actorKind: 'owner',
    createdAt: '2026-08-17T09:00:00.000Z',
  },
  {
    id: 'v2',
    entityId: 'e1',
    label: 'после переноса корпуса',
    hasDoc: false,
    actorKind: 'owner',
    createdAt: '2026-08-16T09:00:00.000Z',
  },
];

function versionsHandler(
  opts: { versions?: unknown[]; restore?: () => unknown } = {},
): MockHandler {
  return (path, input) => {
    if (path === 'entity.get') return { entity, relations: [], thread: null };
    if (path === 'aspect.list') return [];
    if (path === 'version.list') return opts.versions ?? VERSIONS;
    if (path === 'version.pin')
      return {
        id: 'v3',
        entityId: 'e1',
        label: (input as { label: string }).label,
        hasDoc: true,
        actorKind: 'owner',
        createdAt: '2026-08-17T12:00:00.000Z',
      };
    if (path === 'version.restore') return (opts.restore ?? (() => entity))();
    return {};
  };
}

/** Открывает «Детали»: вкладка живая (keepMounted), но версии читаются по её АКТИВНОСТИ. */
async function openDetails(): Promise<void> {
  fireEvent.click(await screen.findByRole('tab', { name: 'Детали' }));
}

/** Версия соседней записи — своя: по ней видно, чей список приехал после перехода. */
const VERSION_E2 = {
  id: 'v9',
  entityId: 'e2',
  label: 'версия второй',
  hasDoc: true,
  actorKind: 'owner',
  createdAt: '2026-08-17T08:00:00.000Z',
};

const twoEntitiesVersionsHandler: MockHandler = (path, input) => {
  if (path === 'entity.get') {
    const { id } = input as { id: string };
    return {
      entity: { ...entity, id, title: id === 'e1' ? 'Задача' : 'Другая' },
      relations: [],
      thread: null,
    };
  }
  if (path === 'aspect.list') return [];
  if (path === 'version.list')
    return (input as { entityId: string }).entityId === 'e1' ? VERSIONS : [VERSION_E2];
  return {};
};

/** Как роутер: `<DetailScreen entityId={top.id} />` монтируется БЕЗ key (router.tsx). */
function VersionsHost() {
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

/**
 * Прогрев соседней записи ТЕМ ЖЕ ключом кэша, что читает экран: переход на неё пойдёт без
 * скелетона, то есть БЕЗ размонтирования вкладок. Без прогрева тот же переход идёт холодным
 * путём — и это два разных пути, на которых прежняя схема («состояние внутри Tabs + извещение
 * наружу») вела себя по-разному.
 */
function WarmCache({ id }: { id: string }) {
  trpc.entity.get.useQuery(detailGetInput(id));
  return null;
}

/** Сколько раз спрашивали версии ИМЕННО этой записи. */
const versionReads = (calls: { path: string; input: unknown }[], entityId: string): number =>
  calls.filter(
    (c) => c.path === 'version.list' && (c.input as { entityId: string }).entityId === entityId,
  ).length;

describe('ADE: версии', () => {
  test('меню ⋮ → «Закрепить версию»: диалог с подписью → version.pin({entityId,label}), список версий протухает', async () => {
    const { calls } = renderWithProviders(
      <>
        <DetailScreen entityId="e1" />
        <Toaster />
      </>,
      versionsHandler(),
    );
    // Список открыт ЗАРАНЕЕ: только у прочитанного списка видно, протух ли он после закрепления.
    await openDetails();
    await waitFor(() => expect(calls.filter((c) => c.path === 'version.list')).toHaveLength(1));

    await openDetailMenu();
    // Пункт НОВЫЙ и отдельный: соседнее «Закрепить» — про сайдбар (закреплённые записи), и
    // путать их нельзя.
    fireEvent.click(screen.getByRole('menuitem', { name: 'Закрепить версию' }));

    const dialog = await screen.findByRole('dialog');
    // Подпись обязательна: снимок без неё в списке не отличить от соседнего по дате.
    expect(within(dialog).getByRole('button', { name: 'Закрепить' })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Подпись'), 'до правки агентом');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Закрепить' }));

    await waitFor(() =>
      expect(calls.find((c) => c.path === 'version.pin')?.input).toEqual({
        entityId: 'e1',
        label: 'до правки агентом',
      }),
    );
    // Успех не молчит и не оставляет модалку открытой.
    expect(await screen.findByText('Версия закреплена')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // …и список перечитан: закреплённой версии в нём иначе не было бы до перезагрузки экрана.
    await waitFor(() =>
      expect(calls.filter((c) => c.path === 'version.list').length).toBeGreaterThan(1),
    );
  });

  test('таб «Детали»: версии читаются ТОЛЬКО при открытии вкладки; в строке — подпись, дата и «есть документ»', async () => {
    const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, versionsHandler());
    await screen.findByRole('tabpanel', { name: 'Детали' });
    // Вкладка живая с монтирования (keepMounted ради секций, которые читают уже приехавшее),
    // а версии — свой запрос: платить им за каждое открытие записи, которую никто не листал
    // по вкладкам, не за что.
    expect(calls.filter((c) => c.path === 'version.list')).toEqual([]);

    await openDetails();
    const card = await screen.findByTestId('versions-card');
    await waitFor(() => expect(within(card).getAllByRole('listitem')).toHaveLength(2));
    const rows = within(card).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('до правки агентом');
    // Дата — машиночитаемым `time`: текст её собирает Intl в зоне владельца, и сверять его
    // строкой значило бы проверять часовой пояс машины, а не экран.
    expect(rows[0]?.querySelector('time')).toHaveAttribute('datetime', '2026-08-17T09:00:00.000Z');
    expect(rows[0]?.querySelector('time')?.textContent).not.toBe('');
    // Признак документа: снимок «до бэкфилла» хранит только markdown, и восстановится он
    // текстом — сказать об этом надо до нажатия, а не после.
    expect(rows[0]).toHaveTextContent('есть документ');
    expect(rows[1]).toHaveTextContent('только текст');
    expect(calls.filter((c) => c.path === 'version.list')).toHaveLength(1);
  });

  test('«Восстановить» → подтверждение → version.restore({versionId, expectedUpdatedAt}) и перечитывание графа', async () => {
    const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, versionsHandler());
    await openDetails();
    const card = await screen.findByTestId('versions-card');
    await waitFor(() => expect(within(card).getAllByRole('listitem')).toHaveLength(2));
    const row = within(card).getAllByRole('listitem')[0] as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Восстановить' }));

    // Подтверждение — модалкой из ui/, а не window.confirm: жест переписывает тело записи.
    const dialog = await screen.findByRole('dialog');
    // Фокус — на «Отмена»: необратимый жест не должен стоять под Enter'ом сразу по открытии.
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Отмена' })).toHaveFocus(),
    );

    const readsBefore = calls.filter((c) => c.path === 'entity.get').length;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Восстановить' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === 'version.restore')?.input).toEqual({
        versionId: 'v1',
        // Метка версии — из ОТКРЫТОЙ записи: сервер сверит её и откажет, если тело правили,
        // пока экран смотрел на список.
        expectedUpdatedAt: entity.updatedAt,
      }),
    );
    // Тело записи изменилось — граф перечитывается целиком (Р17).
    await waitFor(() =>
      expect(calls.filter((c) => c.path === 'entity.get').length).toBeGreaterThan(readsBefore),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  test('409 при восстановлении: инлайн «Документ изменился в другом месте» и «Обновить»', async () => {
    const { calls } = renderWithProviders(
      <DetailScreen entityId="e1" />,
      versionsHandler({
        restore: () => {
          throw trpcError('CONFLICT');
        },
      }),
    );
    await openDetails();
    const card = await screen.findByTestId('versions-card');
    await waitFor(() => expect(within(card).getAllByRole('listitem')).toHaveLength(2));
    const row = within(card).getAllByRole('listitem')[0] as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Восстановить' }));
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Восстановить' }),
    );

    // Плашка тела (screenConflict) сюда не зажигается — она питается только entity.update:
    // о своём отказе секция версий обязана сказать сама.
    const notice = await within(await screen.findByTestId('versions-card')).findByRole('alert');
    expect(notice).toHaveTextContent('Документ изменился в другом месте — обновите экран');

    const readsBefore = calls.filter((c) => c.path === 'entity.get').length;
    await userEvent.click(within(notice).getByRole('button', { name: 'Обновить' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.path === 'entity.get').length).toBeGreaterThan(readsBefore),
    );
    // Обновили — тревога уходит: висеть ей поверх перечитанной записи не о чем.
    await waitFor(() =>
      expect(within(screen.getByTestId('versions-card')).queryByRole('alert')).toBeNull(),
    );
  });

  test('версий нет: «Версий нет» и подсказка, откуда их берут', async () => {
    renderWithProviders(<DetailScreen entityId="e1" />, versionsHandler({ versions: [] }));
    await openDetails();
    const card = await screen.findByTestId('versions-card');
    expect(await within(card).findByText(/Версий нет/)).toBeInTheDocument();
    // Пустая секция обязана сказать, чем её наполнить: пункт меню найти неоткуда.
    expect(card).toHaveTextContent('Закрепить версию');
    expect(within(card).queryByRole('button', { name: 'Восстановить' })).toBeNull();
  });

  test('переход на НЕкэшированную запись с открытых «Деталей»: вкладка та же, версии соседа читаются один раз', async () => {
    const { calls } = renderWithProviders(<VersionsHost />, twoEntitiesVersionsHandler);
    await openDetails();
    expect(await screen.findByText('до правки агентом')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('go-e2'));
    // Холодный путь: соседнюю запись ещё не читали, экран показывает скелетон — вкладок в
    // дереве нет вовсе, и `Tabs` встанет заново.
    expect(screen.queryByRole('tab', { name: 'Детали' })).toBeNull();

    await screen.findByRole('heading', { name: 'Другая' });
    // Вкладка — та, на которой смотрели: правда о ней ОДНА и живёт у экрана, поэтому ремоунт
    // `Tabs` её не сбрасывает. Прежде экран показывал «Сущность», а секция версий считала себя
    // открытой и шла в сеть (ревью Задачи 16).
    expect(screen.getByRole('tab', { name: 'Детали' })).toHaveAttribute('data-state', 'active');
    expect(await screen.findByText('версия второй')).toBeInTheDocument();
    expect(versionReads(calls, 'e2')).toBe(1);
  });

  test('переход на КЭШИРОВАННУЮ запись: тот же исход без скелетона и без лишних чтений', async () => {
    const { calls } = renderWithProviders(
      <>
        <WarmCache id="e2" />
        <VersionsHost />
      </>,
      twoEntitiesVersionsHandler,
    );
    await openDetails();
    expect(await screen.findByText('до правки агентом')).toBeInTheDocument();
    expect(versionReads(calls, 'e2')).toBe(0); // на соседа не смотрели — и не спрашивали

    fireEvent.click(screen.getByTestId('go-e2'));
    // Тёплый кэш: скелетона нет, вкладки те же — и вкладка всё равно «Детали».
    expect(screen.getByRole('heading', { name: 'Другая' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Детали' })).toHaveAttribute('data-state', 'active');
    expect(await screen.findByText('версия второй')).toBeInTheDocument();
    expect(versionReads(calls, 'e2')).toBe(1);
  });
});

/**
 * Рутина в объёме detail (entity.get): «что делать» лежит в ТЕЛЕ, в аспекте — только
 * расписание и права (V1.1). `days` непуст — иначе не проверить, что дни вообще печатаются.
 */
const ROUTINE = {
  ...entity,
  id: 'rt1',
  title: 'Утренний разбор',
  aspects: {
    'orbis/routine': {
      stage: 'active',
      at: '07:00',
      days: ['mo', 'we', 'fr'],
      mode: 'propose',
    },
  },
};

/** Рутина-фикстура: поля аспекта разные от теста к тесту, форма записи — одна. */
type RoutineFixture = Omit<typeof entity, 'aspects'> & {
  aspects: { 'orbis/routine': Record<string, unknown> };
};

/** Момент следующего срабатывания — из routine.overview, часы там серверные (V1.14). */
const NEXT_BUCKET_AT = '2026-08-19T04:00:00.000Z';

/**
 * Прогоны рутины приезжают ТЕМ ЖЕ `entity.query`, что и прогоны тикета (Р-8), — и отличаются
 * от них ровно тем, что гранта у них нет вовсе: работу делал внутренний исполнитель.
 * Порядок — как у сервера (`sortBy=created_at:desc`): последний прогон стоит первым.
 */
const ROUTINE_RUN_DONE = {
  ...RUN,
  id: 'rr2',
  title: 'Прогон: Утренний разбор',
  aspects: {
    'orbis/agent-run': {
      routine_id: 'rt1',
      bucket: '2026-08-18T07:00',
      attempt: 1,
      outcome: 'finished',
      started_at: '2026-08-18T04:00:00.000Z',
      finished_at: '2026-08-18T04:02:00.000Z',
      step_count: 2,
      steps: [],
    },
  },
};

const ROUTINE_RUN_FAILED = {
  ...RUN,
  id: 'rr1',
  title: 'Прогон: Утренний разбор',
  aspects: {
    'orbis/agent-run': {
      routine_id: 'rt1',
      bucket: '2026-08-17T07:00',
      attempt: 3,
      outcome: 'failed',
      fail_note: 'провайдер не ответил',
      started_at: '2026-08-17T04:00:00.000Z',
      finished_at: '2026-08-17T04:01:00.000Z',
      step_count: 1,
      steps: [],
    },
  },
};

/**
 * Обработчик экрана рутины. `stage` держится ПЕРЕМЕННОЙ, а не константой: пауза — это
 * entity.update, после которого экран перечитывает запись, и неизменный ответ вернул бы
 * «активна» поверх только что нажатой паузы — тест был бы зелен при любой реализации кнопки.
 */
function routineHandler(
  opts: { entity?: RoutineFixture; runs?: unknown[]; overview?: unknown } = {},
): MockHandler {
  const base = opts.entity ?? ROUTINE;
  let stage = (base.aspects['orbis/routine'] as { stage: string }).stage;
  const current = () => ({
    ...base,
    aspects: { 'orbis/routine': { ...base.aspects['orbis/routine'], stage } },
  });
  return (path, input) => {
    if (path === 'entity.get') return { entity: current(), relations: [], thread: null };
    if (path === 'entity.query') return opts.runs ?? [ROUTINE_RUN_DONE, ROUTINE_RUN_FAILED];
    if (path === 'routine.overview')
      return (
        opts.overview ?? {
          nextBucketAt: stage === 'paused' ? null : NEXT_BUCKET_AT,
          lastRun: null,
          waiting: 0,
          openProposal: false,
        }
      );
    if (path === 'routine.runNow') return { runId: 'rr9' };
    if (path === 'entity.update') {
      const patch = (input as { aspects?: Record<string, { stage?: string }> }).aspects?.[
        'orbis/routine'
      ];
      if (patch?.stage !== undefined) stage = patch.stage;
      return current();
    }
    // Часовой пояс владельца — тот же шов, что у ленты прогона и истории: без него время
    // печаталось бы в зоне машины, и проверка даты зависела бы от того, где идёт прогон.
    if (path === 'user.getSettings') return { timezone: 'UTC' };
    if (path === 'aspect.list') return [];
    if (path === 'oauth.listGrants') return [GRANT];
    if (path === 'agentRun.sweep') return { swept: 0 };
    return {};
  };
}

/** Рутина на ТЁПЛОМ кэше — ради двойного прогона эффектов (см. TicketOnWarmCache). */
function RoutineOnWarmCache() {
  const q = trpc.entity.get.useQuery(detailGetInput('rt1'));
  return q.data ? <DetailScreen entityId="rt1" /> : null;
}

describe('V1: рутина', () => {
  test('блок состояния: режим, время, дни и следующее срабатывание; прогоны без колонки исполнителя; блоков тикета нет (V1.14, приёмка 2)', async () => {
    const { calls } = renderWithProviders(<DetailScreen entityId="rt1" />, routineHandler());
    const panel = await screen.findByRole('tabpanel', { name: 'Сущность' });
    const status = await within(panel).findByTestId('routine-status');

    // Режим — словом, а не сырым enum: владелец решает по нему, спросят ли его перед правкой.
    expect(status).toHaveTextContent('предлагает');
    expect(status).toHaveTextContent('07:00');
    expect(status).toHaveTextContent('пн, ср, пт');
    // Следующее срабатывание приезжает ОДНИМ снимком с сервера (routine.overview) и печатается
    // в зоне владельца — тем же форматтером, что и все значения времени на экране.
    await waitFor(() => expect(status).toHaveTextContent('19 авг.'));
    expect(status).toHaveTextContent('04:00');
    // Итог последнего прогона — здесь же: ради него экран и открывают.
    expect(status).toHaveTextContent('готово');

    // Прогоны рутины читаются ТЕМ ЖЕ запросом, что и прогоны тикета (Р-8), — по детям рутины.
    expect(
      calls.some(
        (c) => c.path === 'entity.query' && (c.input as { query: string }).query.includes('rt1'),
      ),
    ).toBe(true);
    const details = await screen.findByRole('tabpanel', { name: 'Детали' });
    const list = within(details).getByTestId('runs-list');
    expect(within(list).getByTestId('run-rr1')).toHaveTextContent('сбой');
    expect(within(list).getByTestId('run-rr2')).toHaveTextContent('готово');
    // Исполнителя у рутинного прогона нет вовсе: колонки нет, и список доступов не спрашивается.
    expect(list).not.toHaveTextContent('worker-1');
    expect(calls.some((c) => c.path === 'oauth.listGrants')).toBe(false);

    // Тикетные блоки рутине не положены: у неё нет ни статуса waiting, ни назначения.
    expect(screen.queryByTestId('ticket-waiting')).toBeNull();
    expect(screen.queryByTestId('assignment-card')).toBeNull();
  });

  test('режим act печатает разрешённые инструменты; рутина на паузе — «на паузе» вместо времени', async () => {
    const acting = {
      ...ROUTINE,
      aspects: {
        'orbis/routine': {
          stage: 'paused',
          at: '21:30',
          mode: 'act',
          allowed_tools: ['entity_update', 'thread_post'],
        },
      },
    };
    renderWithProviders(<DetailScreen entityId="rt1" />, routineHandler({ entity: acting }));
    const status = await screen.findByTestId('routine-status');
    // «действует» без списка инструментов — это «действует как угодно»: право владелец читает
    // целиком или не читает вовсе.
    expect(status).toHaveTextContent('действует: entity_update, thread_post');
    // Дней нет — расписание ежедневное (поля нет = каждый день, схема аспекта).
    expect(status).toHaveTextContent('каждый день');
    // Паузе времени срабатывания не обещают: рутина на паузе не сработает вовсе (V1.14).
    await waitFor(() => expect(status).toHaveTextContent('на паузе'));
    expect(await screen.findByRole('button', { name: 'Возобновить' })).toBeInTheDocument();
  });

  test('«Прогнать сейчас» зовёт routine.runNow и открывает прогон; «Пауза» шлёт stage paused и превращается в «Возобновить» (приёмка 10)', async () => {
    const { calls } = renderWithProviders(<DetailScreen entityId="rt1" />, routineHandler());
    const status = await screen.findByTestId('routine-status');

    await userEvent.click(within(status).getByRole('button', { name: 'Прогнать сейчас' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === 'routine.runNow')?.input).toEqual({ routineId: 'rt1' }),
    );
    // Ответ приходит ДО модели (V1.3) — экран ведёт на сам прогон, поверх стека активной вкладки.
    await waitFor(() =>
      expect(useNav.getState().stacks.browser.at(-1)).toEqual({
        kind: 'entity',
        id: 'rr9',
      }),
    );

    await userEvent.click(within(status).getByRole('button', { name: 'Пауза' }));
    await waitFor(() => {
      const input = calls.find((c) => c.path === 'entity.update')?.input as {
        id: string;
        aspects: Record<string, Record<string, unknown>>;
      };
      expect(input.id).toBe('rt1');
      // Патч мержится по полям: расписание и права пауза не трогает.
      expect(input.aspects['orbis/routine']).toEqual({ stage: 'paused' });
    });
    expect(await screen.findByRole('button', { name: 'Возобновить' })).toBeInTheDocument();
  });

  test('идёт прогон — «Прогнать сейчас» заблокирована; отказ сервера показан текстом', async () => {
    const running = {
      ...ROUTINE_RUN_DONE,
      id: 'rr3',
      aspects: {
        'orbis/agent-run': {
          ...ROUTINE_RUN_DONE.aspects['orbis/agent-run'],
          outcome: 'running',
          finished_at: undefined,
        },
      },
    };
    const busy = renderWithProviders(
      <DetailScreen entityId="rt1" />,
      routineHandler({ runs: [running] }),
    );
    const status = await screen.findByTestId('routine-status');
    // Кнопка, которая гарантированно отказывает, хуже её отсутствия (та же логика, что у
    // блока ожидания тикета) — но исчезать ей нельзя: владелец должен видеть, ПОЧЕМУ нельзя.
    expect(within(status).getByRole('button', { name: 'Прогнать сейчас' })).toBeDisabled();
    expect(status).toHaveTextContent('идёт прогон');
    busy.unmount();

    // …и отказ сервера (прогон успели начать в другой вкладке, исчерпан дневной лимит)
    // владелец читает словами, а не молчанием кнопки.
    renderWithProviders(<DetailScreen entityId="rt1" />, (path, input) => {
      if (path === 'routine.runNow') throw trpcError('CONFLICT', 'прогон уже идёт');
      return routineHandler()(path, input);
    });
    const second = await screen.findByTestId('routine-status');
    await userEvent.click(within(second).getByRole('button', { name: 'Прогнать сейчас' }));
    expect(await within(second).findByRole('alert')).toHaveTextContent('прогон уже идёт');
  });

  test('открытие рутины зовёт agentRun.sweep один раз (сорванный прогон закрывается с экрана)', async () => {
    // Плановый прогон срывается вместе с процессом (деплой, падение) и остаётся running
    // навсегда: владелец, открывший рутину, чинит это сам, ничего об этом не зная.
    const { calls } = renderWithProviders(<RoutineOnWarmCache />, routineHandler(), {
      strict: true,
    });
    await screen.findAllByRole('tabpanel', { name: 'Сущность' });
    await waitFor(() =>
      expect(calls.filter((c) => c.path === 'agentRun.sweep').length).toBeGreaterThan(0),
    );
    expect(calls.filter((c) => c.path === 'agentRun.sweep')).toHaveLength(1);
  });
});

// --- Экран прогона РУТИНЫ (V1.9, V1.14; приёмка 3–6, 11) -------------------------------
//
// Та же лента, что у прогона внешнего исполнителя (`ADE: прогон`), и различия ровно там, где
// различается работа: исполнитель внутренний (гранта нет — есть рутина-родитель, слот и
// попытка), вопрос владельцу задаётся ПРЯМО ЗДЕСЬ (тикета, куда его положить, у рутины нет),
// а результат режима «предлагает» — карточка предложения с самими правками.

/** Прогон рутины в объёме detail. Аспект от теста к тесту разный, форма записи — одна. */
const routineRunEntity = (aspect: Record<string, unknown>, archived = false) => ({
  ...entity,
  id: 'rr1',
  title: 'Прогон: Утренний разбор',
  archived,
  aspects: { 'orbis/agent-run': aspect },
});

const ROUTINE_RUN_CHECKPOINT = {
  routine_id: 'rt1',
  bucket: '2026-08-18T07:00',
  attempt: 1,
  outcome: 'checkpoint',
  started_at: '2026-08-18T04:00:00.000Z',
  step_count: 1,
  steps: [
    { seq: 1, at: '2026-08-18T04:00:30.000Z', summary: 'Прочитал инструкцию', external: false },
  ],
  checkpoint: { question: 'Переносить ли встречу с врачом?', asked_at: '2026-08-18T04:01:00.000Z' },
};

/** Предложение в форме `routine.proposal` (ProposalView): строки — по ПОЛЮ, а не по операции. */
const PROPOSAL_VIEW = {
  pendingId: 'p1',
  runId: 'rr1',
  routineId: 'rt1',
  status: 'pending',
  explanation: 'Два дела просрочены — предлагаю перенести срок на сегодня.',
  operations: [
    {
      index: 0,
      tool: 'entity_update',
      entity: { id: 'e2', title: 'Купить билеты' },
      aspect: 'orbis/task',
      field: 'due_date',
      before: '2026-08-10',
      after: '2026-08-19',
      summary: '«Купить билеты»: orbis/task.due_date',
    },
    {
      index: 1,
      tool: 'entity_create',
      summary: 'Создать: Позвонить врачу (orbis/task)',
    },
  ],
};

function routineRunHandler(
  opts: {
    aspect?: Record<string, unknown>;
    proposal?: unknown;
    decide?: unknown;
    archived?: boolean;
  } = {},
): MockHandler {
  const run = routineRunEntity(opts.aspect ?? ROUTINE_RUN_CHECKPOINT, opts.archived ?? false);
  return (path, input) => {
    if (path === 'entity.get') {
      const { id } = input as { id: string };
      if (id === 'rr1') return { entity: run, relations: [], thread: null };
      // Рутина-родитель и цели предложения дочитываются заголовками (EntityRef).
      if (id === 'rt1') return { entity: ROUTINE, relations: [], thread: null };
      const target = PROPOSAL_VIEW.operations.find((op) => op.entity?.id === id);
      return {
        entity: { ...entity, id, title: target?.entity?.title ?? `T-${id}` },
        relations: [],
        thread: null,
      };
    }
    if (path === 'user.getSettings') return { timezone: 'UTC' };
    if (path === 'aspect.list') return [];
    if (path === 'routine.proposal') return opts.proposal ?? null;
    if (path === 'routine.decideProposal')
      return opts.decide ?? { status: 'applied', actionId: 'a1' };
    if (path === 'routine.answerCheckpoint') return { runId: 'rr1' };
    if (path === 'agentRun.rollback') return { ok: true, undone: ['a1'], note: ROLLBACK_NOTE };
    return {};
  };
}

describe('V1: прогон рутины', () => {
  test('прогон с routine_id и outcome checkpoint: блок вопроса с полем ответа; «Ответить» зовёт routine.answerCheckpoint; шапка — рутина и слот, исполнителя нет (приёмка 5)', async () => {
    const { calls } = renderWithProviders(<DetailScreen entityId="rr1" />, routineRunHandler());
    const feed = await screen.findByTestId('run-feed');

    expect(within(feed).getByText('вопрос')).toBeInTheDocument();
    // Кто это делал — РУТИНА, и названа она заголовком: гранта у внутреннего исполнителя нет
    // вовсе, и список доступов ради него не спрашивают.
    expect(await within(feed).findByText('Утренний разбор')).toBeInTheDocument();
    expect(feed).toHaveTextContent('2026-08-18 07:00');
    // Первая попытка — обычный ход дел; «попытка 1» на каждом прогоне была бы шумом.
    expect(feed).not.toHaveTextContent('попытка');
    expect(calls.some((c) => c.path === 'oauth.listGrants')).toBe(false);

    // Вопрос рутины владелец читает и отвечает ПРЯМО ЗДЕСЬ: тикета, куда сервер кладёт
    // вопрос внешнего исполнителя (waiting_for), у рутины нет.
    const block = within(feed).getByTestId('routine-question');
    expect(block).toHaveTextContent('Переносить ли встречу с врачом?');
    await userEvent.type(within(block).getByRole('textbox'), 'Перенеси на пятницу');
    await userEvent.click(within(block).getByRole('button', { name: 'Ответить' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === 'routine.answerCheckpoint')?.input).toEqual({
        runId: 'rr1',
        answer: 'Перенеси на пятницу',
      }),
    );
  });

  test('прогон finished с предложением pending: карточка перечисляет сами операции, «Принять» → decideProposal approve; ответ stale → список расхождений (приёмка 3–4, 6)', async () => {
    const { calls } = renderWithProviders(
      <DetailScreen entityId="rr1" />,
      routineRunHandler({
        aspect: {
          ...ROUTINE_RUN_CHECKPOINT,
          outcome: 'finished',
          checkpoint: undefined,
          finished_at: '2026-08-18T04:02:00.000Z',
          proposal: { pending_id: 'p1', status: 'pending' },
          // `orbis_propose` кладёт объяснение и в отчёт прогона, и в карточку (propose.ts) —
          // фикстура повторяет это дословно, иначе не поймать дубль на экране.
          report: PROPOSAL_VIEW.explanation,
        },
        proposal: PROPOSAL_VIEW,
        decide: {
          status: 'stale',
          mismatches: [
            { aspect: 'orbis/task', field: 'status', expected: ['inbox'], actual: 'done' },
          ],
        },
      }),
    );
    const card = await screen.findByTestId('proposal-card');

    // Владелец принимает СПИСОК ПРАВОК, а не пересказ модели (V1.14): поле, «было» и «станет».
    expect(card).toHaveTextContent('срок');
    expect(card).toHaveTextContent('2026-08-10');
    expect(card).toHaveTextContent('2026-08-19');
    expect(await within(card).findByText('Купить билеты')).toBeInTheDocument();
    // Создание записи — своей строкой: у него нет ни «было», ни поля аспекта.
    expect(card).toHaveTextContent('Создать: Позвонить врачу');
    expect(card).not.toHaveTextContent('2 операции');
    // Отчёт прогона-предложения — ТА ЖЕ проза, что и в карточке: печатать её вторым блоком
    // значило бы показать владельцу два объяснения одного предложения.
    const feed = screen.getByTestId('run-feed');
    expect(within(feed).getAllByText(PROPOSAL_VIEW.explanation)).toHaveLength(1);
    expect(within(feed).queryByText('Отчёт')).toBeNull();

    await userEvent.click(within(card).getByRole('button', { name: 'Принять' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === 'routine.decideProposal')?.input).toEqual({
        runId: 'rr1',
        pendingId: 'p1',
        decision: 'approve',
      }),
    );

    // `stale` — ЗНАЧЕНИЕ ответа, а не сбой: граф разошёлся с предложением, и владельцу
    // показывают, чем именно, а не плашку ошибки.
    const stale = await within(card).findByTestId('proposal-stale');
    expect(stale).toHaveTextContent('состояние изменилось');
    expect(stale).toHaveTextContent('статус');
    expect(stale).toHaveTextContent('inbox');
    expect(stale).toHaveTextContent('done');
  });

  test('исходы V1: failed с причиной (откат доступен), answered с ответом, stale со словами «снят новым прогоном» (приёмка 11)', async () => {
    const failed = renderWithProviders(
      <DetailScreen entityId="rr1" />,
      routineRunHandler({
        aspect: {
          ...ROUTINE_RUN_CHECKPOINT,
          outcome: 'failed',
          attempt: 3,
          checkpoint: undefined,
          fail_note: 'провайдер не ответил',
          finished_at: '2026-08-18T04:01:00.000Z',
        },
      }),
    );
    let feed = await screen.findByTestId('run-feed');
    expect(within(feed).getByText('сбой')).toBeInTheDocument();
    // Причина сбоя — то, ради чего сорванный прогон открывают.
    expect(feed).toHaveTextContent('провайдер не ответил');
    // Не первая попытка — это новость: рутина уже сбоила и её переспрашивали.
    expect(feed).toHaveTextContent('попытка 3');
    // Сбой терминален, и сделанное до него откатывается как у любого законченного прогона.
    expect(within(feed).getByRole('button', { name: 'Откатить прогон в Orbis' })).toBeEnabled();
    failed.unmount();

    const answered = renderWithProviders(
      <DetailScreen entityId="rr1" />,
      routineRunHandler({
        aspect: {
          ...ROUTINE_RUN_CHECKPOINT,
          outcome: 'answered',
          reply: { text: 'Перенеси на пятницу', at: '2026-08-18T06:00:00.000Z' },
        },
      }),
    );
    feed = await screen.findByTestId('run-feed');
    expect(within(feed).getByText('отвечено')).toBeInTheDocument();
    let block = within(feed).getByTestId('routine-question');
    expect(block).toHaveTextContent('Переносить ли встречу с врачом?');
    expect(block).toHaveTextContent('Перенеси на пятницу');
    // Отвечать второй раз нечем: прогон закрыт ответом.
    expect(within(block).queryByRole('textbox')).toBeNull();
    answered.unmount();

    const stale = renderWithProviders(
      <DetailScreen entityId="rr1" />,
      routineRunHandler({ aspect: { ...ROUTINE_RUN_CHECKPOINT, outcome: 'stale' } }),
    );
    feed = await screen.findByTestId('run-feed');
    expect(within(feed).getByText('снят')).toBeInTheDocument();
    block = within(feed).getByTestId('routine-question');
    // Вопрос остался без ответа не потому, что владелец промолчал, а потому что рутина
    // спросила заново следующим прогоном — и сказать это надо словами.
    expect(block).toHaveTextContent('снят новым прогоном');
    expect(within(block).queryByRole('textbox')).toBeNull();
    stale.unmount();

    // Откат прогона с неотвеченным вопросом (хвост ре-ревью): сервер снимает вопрос (`stale`)
    // и убирает прогон в архив — подпись про архив (нейтрально: в архив ведёт и рука
    // владельца), а не «новый прогон»; поля ответа нет
    const rolledBack = renderWithProviders(
      <DetailScreen entityId="rr1" />,
      routineRunHandler({
        aspect: { ...ROUTINE_RUN_CHECKPOINT, outcome: 'stale' },
        archived: true,
      }),
    );
    feed = await screen.findByTestId('run-feed');
    expect(within(feed).getByText('в архиве')).toBeInTheDocument();
    block = within(feed).getByTestId('routine-question');
    expect(block).toHaveTextContent('Вопрос снят: прогон в архиве');
    expect(block).not.toHaveTextContent('новым прогоном');
    expect(within(block).queryByRole('textbox')).toBeNull();
    rolledBack.unmount();

    // Архивный прогон со всё ещё открытым вопросом (запись до хвоста либо архив рукой):
    // отвечать некуда — сервер под архивом прогон не находит; поля ответа нет, причина названа
    renderWithProviders(<DetailScreen entityId="rr1" />, routineRunHandler({ archived: true }));
    feed = await screen.findByTestId('run-feed');
    block = within(feed).getByTestId('routine-question');
    expect(block).toHaveTextContent('Вопрос снят: прогон в архиве');
    expect(within(block).queryByRole('textbox')).toBeNull();
  });

  test('история прогонов рутины: судьба предложения бейджем, ожидание решения — словами (приёмка 4)', async () => {
    const withProposal = (id: string, proposal: Record<string, unknown>) => ({
      ...ROUTINE_RUN_DONE,
      id,
      aspects: {
        'orbis/agent-run': { ...ROUTINE_RUN_DONE.aspects['orbis/agent-run'], proposal },
      },
    });
    renderWithProviders(
      <DetailScreen entityId="rt1" />,
      routineHandler({
        runs: [
          withProposal('rp1', { pending_id: 'p1', status: 'pending' }),
          withProposal('rp2', { pending_id: 'p2', status: 'approved' }),
          withProposal('rp3', { pending_id: 'p3', status: 'superseded' }),
        ],
      }),
    );
    const details = await screen.findByRole('tabpanel', { name: 'Детали' });
    const list = within(details).getByTestId('runs-list');
    // «готово» у прогона с нерешённым предложением означает лишь «модель отработала» —
    // без второго слова владелец не увидел бы, что от него чего-то ждут.
    expect(within(list).getByTestId('run-rp1')).toHaveTextContent('ждёт решения');
    expect(within(list).getByTestId('run-rp2')).toHaveTextContent('принято');
    expect(within(list).getByTestId('run-rp3')).toHaveTextContent('заменено');
  });
});

// ─── Ш1.3: слой предложения на записи ────────────────────────────────────────────────────
//
// Владелец не обязан узнавать о предложении рутины из ленты чата: открыл запись — увидел
// плашку, развернул — прочитал дифф тела и строки правок, поправил значение и решил, не
// уходя с записи. Слой стоит СНАРУЖИ вкладок (виден с любой) и, развёрнутый, прячет тело
// записи классом: тело живёт под ним смонтированным (keepMounted), и случайный клик в него
// сдвинул бы `updated_at`, сделав предложение stale (Р-18).

/** Рутины, чьи имена стоят в плашках: слой дочитывает их обычным per-id entity.get. */
const PROPOSAL_ROUTINES: Record<string, string> = {
  rt7: 'Утренний разбор',
  rt8: 'Вечерний обход',
};

/** Предложенное тело одной строкой: `toHaveTextContent` схлопывает пробелы, и многострочный
 *  markdown в ассерциях читался бы хуже, чем проверяемое им свойство. */
const PROPOSED_BODY = 'Планы на день, позвонить в клинику';

/** Единицы диффа тела в форме `@orbis/shared/doc/diff` — как их отдаёт сервер (Ш1.1). */
const OVERLAY_DIFF_UNITS = [
  { kind: 'same', before: 'Планы на день', after: 'Планы на день' },
  { kind: 'added', after: 'позвонить в клинику' },
  { kind: 'removed', before: 'забрать посылку' },
];

/** Строка правки поля аспекта — форма ProposalOperationView (lifecycle.ts). */
const statusRow = (over: Record<string, unknown> = {}) => ({
  index: 0,
  tool: 'entity_update',
  entity: { id: 'e1', title: 'Задача' },
  aspect: 'orbis/task',
  field: 'status',
  before: 'inbox',
  after: 'done',
  summary: '«Задача»: orbis/task.status',
  ...over,
});

/** Строка тела: `after` (полный markdown) есть всегда, `bodyDiff` — только у живого. */
const overlayBodyRow = (over: Record<string, unknown> = {}) => ({
  index: 0,
  tool: 'entity_update',
  entity: { id: 'e1', title: 'Задача' },
  field: 'body',
  after: PROPOSED_BODY,
  summary: '«Задача»: тело',
  ...over,
});

const proposalFor = (over: Record<string, unknown> = {}) => ({
  pendingId: 'p1',
  runId: 'run1',
  routineId: 'rt7',
  status: 'pending',
  explanation: 'Два дела просрочены',
  runArchived: false,
  operations: [statusRow(), overlayBodyRow({ bodyDiff: { units: OVERLAY_DIFF_UNITS } })],
  ...over,
});

function overlayHandler(opts: { proposals?: unknown[]; decide?: unknown } = {}): MockHandler {
  return (path, input) => {
    if (path === 'entity.get') {
      const { id } = input as { id: string };
      const routine = PROPOSAL_ROUTINES[id];
      // Заголовок рутины (и заголовки задетых записей) слой дочитывает тем же EntityRef,
      // что и вся остальная разметка, — своим per-id ключом.
      if (routine !== undefined) return { entity: { id, title: routine } };
      return { entity, relations: [], thread: { threadId: 'th1', messages: [] } };
    }
    if (path === 'routine.proposalsForEntity') return opts.proposals ?? [proposalFor()];
    if (path === 'routine.decideProposal')
      return opts.decide ?? { status: 'applied', actionId: 'a1' };
    if (path === 'entity.update') return entity;
    if (path === 'chat.listMessages') return [];
    if (path === 'aspect.list') return [];
    return {};
  };
}

/** Потребитель ленты треда — тот же хук, что и вкладка «Тред» (ключ `chatThreadKey`). */
function ThreadProbe() {
  const { messages } = useChatThread('th1');
  return <span data-testid="thread-count">{messages.length}</span>;
}

/** Разворачивает (или сворачивает) плашку её же заголовком. */
function togglePlate(plate: HTMLElement): void {
  fireEvent.click(within(plate).getByRole('button', { name: /Предложение рутины/ }));
}

describe('слой предложения', () => {
  test('обычное открытие записи с открытым предложением → плашка «Предложение рутины…» (приёмка 3)', async () => {
    const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, overlayHandler());
    const plate = await screen.findByTestId('proposal-plate');
    expect(plate).toHaveTextContent('Предложение рутины');
    // Имя рутины, а не её uuid: плашка отвечает на вопрос «кто это предлагает».
    expect(await within(plate).findByText('Утренний разбор')).toBeInTheDocument();
    // Сколько правок — счётом строк предложения, с русским согласованием числа.
    expect(plate).toHaveTextContent('2 правки');
    // Спрашиваем по ОТКРЫТОЙ ЗАПИСИ, а не по прогону: владелец пришёл на запись, а не из ленты.
    expect(calls.find((c) => c.path === 'routine.proposalsForEntity')?.input).toEqual({
      entityId: 'e1',
    });
    // Свёрнутая плашка ничего не прячет и ничего не решает.
    expect(screen.getByTestId('entity-body')).not.toHaveClass('hidden');
    expect(within(plate).queryByRole('button', { name: 'Принять' })).toBeNull();
    expect(within(plate).queryByTestId('proposal-body-diff')).toBeNull();
  });

  test('разворот: дифф тела блоками, строки полей before→after, кнопки; тело записи скрыто классом; сворачивание возвращает (приёмка 2)', async () => {
    renderWithProviders(<DetailScreen entityId="e1" />, overlayHandler());
    // Редактор поднимаем и печатаем в нём ДО разворота: размонтируй слой тело вместо того,
    // чтобы спрятать его классом, — набранное исчезло бы вместе с ним, а `flush` черновика
    // дёрнулся бы на размонтировании (Р-18).
    const field = await editorField();
    await userEvent.type(field, ' и хвост');
    await expectEditorHas('и хвост');

    const plate = await screen.findByTestId('proposal-plate');
    togglePlate(plate);

    // Полный дифф — со всеми единицами, включая контекстные `same`: это запись, а не лента,
    // и место под различие здесь есть (Развилка 10).
    const diff = await within(plate).findByTestId('proposal-body-diff');
    expect(diff).toHaveTextContent('Планы на день');
    expect(diff).toHaveTextContent('позвонить в клинику');
    expect(diff).toHaveTextContent('забрать посылку');
    // Строка поля: «было» из снятого предусловия и предложенное значение — правимым полем.
    expect(plate).toHaveTextContent('inbox');
    expect(within(plate).getByLabelText('orbis/task status')).toHaveValue('done');
    expect(within(plate).getByRole('button', { name: 'Принять' })).toBeInTheDocument();
    expect(within(plate).getByRole('button', { name: 'Отклонить' })).toBeInTheDocument();

    // Р-18: тело спрятано КЛАССОМ и осталось смонтированным.
    expect(screen.getByTestId('entity-body')).toHaveClass('hidden');
    expect(screen.getByTestId('body-editor')).toBeInTheDocument();

    // Сворачивание возвращает тело — и ровно то же самое: набранное на месте, значит редактор
    // не поднимался заново.
    togglePlate(plate);
    expect(screen.getByTestId('entity-body')).not.toHaveClass('hidden');
    await expectEditorHas('и хвост');
    expect(within(plate).queryByTestId('proposal-body-diff')).toBeNull();
  });

  test('правка значения поля в строке → edits.fields в вызове decideProposal; принятое сворачивает слой и обновляет ленту треда (приёмки 6, 9)', async () => {
    const { calls } = renderWithProviders(
      <>
        <ThreadProbe />
        <DetailScreen entityId="e1" />
      </>,
      overlayHandler(),
    );
    const plate = await screen.findByTestId('proposal-plate');
    togglePlate(plate);
    expect(screen.getByTestId('entity-body')).toHaveClass('hidden');
    const input = await within(plate).findByLabelText('orbis/task status');
    await userEvent.clear(input);
    await userEvent.type(input, 'in_progress');
    fireEvent.blur(input);
    // Р-16: тот же `onSave` на самой записи (AspectCards) шлёт entity.update НЕМЕДЛЕННО.
    // В слое правка обязана лечь в буфер: граф двигает «Принять», а не набор в поле.
    expect(calls.some((c) => c.path === 'entity.update')).toBe(false);

    const reads = () => calls.filter((c) => c.path === 'chat.listMessages').length;
    await waitFor(() => expect(reads()).toBe(1));
    fireEvent.click(within(plate).getByRole('button', { name: 'Принять' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === 'routine.decideProposal')?.input).toEqual({
        runId: 'run1',
        pendingId: 'p1',
        decision: 'approve',
        edits: {
          fields: [{ index: 0, aspect: 'orbis/task', field: 'status', value: 'in_progress' }],
        },
      }),
    );
    // Приёмка 9: правка рождает ВТОРУЮ карточку предложения в ленте рутины, и открытый тред
    // без инвалидации показал бы её только через staleTime. Слой треда не знает — гасит по
    // префиксу ключа.
    await waitFor(() => expect(reads()).toBeGreaterThan(1));
    // Принятое сворачивает слой: решать больше нечего, а тело записи обязано вернуться.
    await waitFor(() => expect(screen.getByTestId('entity-body')).not.toHaveClass('hidden'));
  });

  test('два предложения двух рутин → две плашки, решение по каждому своё (приёмка 18)', async () => {
    const second = proposalFor({
      pendingId: 'p2',
      runId: 'run2',
      routineId: 'rt8',
      explanation: 'Вечерний обход просит своё',
      operations: [statusRow({ after: 'in_progress' })],
    });
    const { calls } = renderWithProviders(
      <DetailScreen entityId="e1" />,
      overlayHandler({ proposals: [proposalFor(), second] }),
    );
    const [morning, evening] = await screen.findAllByTestId('proposal-plate');
    if (morning === undefined || evening === undefined) throw new Error('ожидались две плашки');
    expect(await within(morning).findByText('Утренний разбор')).toBeInTheDocument();
    expect(await within(evening).findByText('Вечерний обход')).toBeInTheDocument();

    // Разворот второй не гасит первую: выбор одного предложения скрыл бы второе.
    togglePlate(evening);
    expect(within(evening).getByRole('button', { name: 'Принять' })).toBeInTheDocument();
    expect(within(morning).queryByRole('button', { name: 'Принять' })).toBeNull();
    expect(screen.getAllByTestId('proposal-plate')).toHaveLength(2);

    // …и решение уходит с адресом ИМЕННО ЭТОГО предложения, а не первого в списке.
    fireEvent.click(within(evening).getByRole('button', { name: 'Отклонить' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === 'routine.decideProposal')?.input).toEqual({
        runId: 'run2',
        pendingId: 'p2',
        decision: 'reject',
      }),
    );
  });

  test('skipped body_changed → пометка «Тело изменилось после составления» вместо диффа (приёмка 12)', async () => {
    renderWithProviders(
      <DetailScreen entityId="e1" />,
      overlayHandler({
        proposals: [
          proposalFor({ operations: [overlayBodyRow({ bodyDiff: { skipped: 'body_changed' } })] }),
        ],
      }),
    );
    const plate = await screen.findByTestId('proposal-plate');
    togglePlate(plate);
    expect(await within(plate).findByText('Тело изменилось после составления')).toBeInTheDocument();
    expect(within(plate).queryByTestId('proposal-body-diff')).toBeNull();
    // Приёмка 16: дифф — способ показа, а не условие. Прежняя форма на месте, кнопки живы.
    expect(plate).toHaveTextContent(PROPOSED_BODY);
    expect(within(plate).getByRole('button', { name: 'Принять' })).toBeInTheDocument();
  });

  test('исходы решения: stale → расхождения списком, replaced → подпись и перечитка списка (приёмки 14, 15)', async () => {
    const stale = renderWithProviders(
      <DetailScreen entityId="e1" />,
      overlayHandler({
        decide: {
          status: 'stale',
          mismatches: [
            { aspect: 'orbis/task', field: 'status', expected: ['inbox'], actual: 'done' },
            { aspect: '', field: 'body', expected: ['A'], actual: 'B' },
          ],
        },
      }),
    );
    let plate = await screen.findByTestId('proposal-plate');
    togglePlate(plate);
    fireEvent.click(within(plate).getByRole('button', { name: 'Принять' }));
    const box = await within(plate).findByTestId('proposal-stale');
    expect(box).toHaveTextContent('ожидали inbox, сейчас done');
    // Расхождение по телу — про версию записи, а не про текст: два timestamp'а владельцу
    // ничего не сообщают.
    expect(box).toHaveTextContent('Тело: запись изменилась после составления предложения');
    // Устаревшее предложение сервер погасил тем же ответом — решать по нему больше нечем, и
    // список НЕ перечитываем: разбор расхождений ушёл бы вместе с плашкой.
    expect(within(plate).queryByRole('button', { name: 'Принять' })).toBeNull();
    expect(stale.calls.filter((c) => c.path === 'routine.proposalsForEntity')).toHaveLength(1);
    stale.unmount();

    // Список ЖИВОЙ: после ответа `replaced` перечитка приносит ДРУГОЕ предложение (правленое,
    // со своим pendingId) — плашка мёртвого исчезает, и подпись обязана это пережить.
    let live: unknown = proposalFor();
    const replaced = renderWithProviders(<DetailScreen entityId="e1" />, (path, input) => {
      if (path === 'routine.proposalsForEntity') return [live];
      if (path === 'routine.decideProposal') {
        live = proposalFor({ pendingId: 'p9', editedFrom: 'p1' });
        return { status: 'replaced', livePendingId: 'p9', liveStatus: 'pending', reason: 'edited' };
      }
      return overlayHandler()(path, input);
    });
    plate = await screen.findByTestId('proposal-plate');
    togglePlate(plate);
    const reads = () =>
      replaced.calls.filter((c) => c.path === 'routine.proposalsForEntity').length;
    const before = reads();
    fireEvent.click(within(plate).getByRole('button', { name: 'Принять' }));
    // Приёмка 15: молча не проигрывает никто — вкладка, открытая до правки, обязана узнать,
    // что её нажатие ушло в уже мёртвое предложение. Подпись живёт НАД плашками: список под
    // ней сейчас перечитается, и внутри плашки она умерла бы вместе с её `pendingId`.
    expect(await screen.findByTestId('proposal-replaced-answer')).toHaveTextContent(
      'Заменено правкой владельца — ниже живое предложение',
    );
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    // …и переживает подмену: плашка мёртвого предложения ушла (развёрнутой она была, новая
    // приезжает свёрнутой), а подпись осталась.
    await waitFor(() =>
      expect(
        within(screen.getByTestId('proposal-plate')).queryByRole('button', { name: 'Принять' }),
      ).toBeNull(),
    );
    expect(screen.getByTestId('proposal-replaced-answer')).toBeInTheDocument();
  });

  test('запись без предложений → ни плашки, ни спрятанного тела, ни второго запроса (приёмка 7 не задета)', async () => {
    const { calls } = renderWithProviders(
      <DetailScreen entityId="e1" />,
      overlayHandler({ proposals: [] }),
    );
    await openEditor();
    expect(screen.queryByTestId('proposal-plate')).toBeNull();
    expect(screen.queryByTestId('proposal-overlay')).toBeNull();
    // Тело поднимается ровно как прежде: слоя нет — и прятать нечего.
    expect(screen.getByTestId('entity-body')).not.toHaveClass('hidden');
    expect(calls.filter((c) => c.path === 'routine.proposalsForEntity')).toHaveLength(1);
  });

  test('предложение, рождённое правкой владельца → подпись и в свёрнутой плашке, и в развороте; без editedFrom — ни слова (инвариант 8)', async () => {
    // Путь достижим `stale`-хвостом лестницы правки: владелец поправил и принял, применение
    // ответило `stale` — P2 остался живым, с `edited_from`. Без подписи владелец открыл бы
    // запись и принял СВОЙ ЖЕ текст как предложение рутины.
    const edited = renderWithProviders(
      <DetailScreen entityId="e1" />,
      overlayHandler({ proposals: [proposalFor({ pendingId: 'p2', editedFrom: 'p1' })] }),
    );
    let plate = await screen.findByTestId('proposal-plate');
    // Видна ДО разворота: свёрнутая плашка — всё, что увидит владелец, решивший не
    // разворачивать, и именно она выдавала бы его текст за план рутины.
    expect(within(plate).getByTestId('proposal-edited')).toHaveTextContent('Правка владельца');
    togglePlate(plate);
    expect(within(plate).getByTestId('proposal-edited')).toHaveTextContent('Правка владельца');
    // «исходное предложение выше» — про ЛЕНТУ: на записи исходного нет вовсе (оно погашено и
    // из списка ушло), и обещать его здесь значило бы послать владельца искать то, чего нет.
    expect(plate).not.toHaveTextContent('выше');
    edited.unmount();

    // Обычное предложение рутины — прежним видом: ни подписи, ни слова о правке.
    renderWithProviders(<DetailScreen entityId="e1" />, overlayHandler());
    plate = await screen.findByTestId('proposal-plate');
    expect(within(plate).queryByTestId('proposal-edited')).toBeNull();
    expect(plate).not.toHaveTextContent('Правка владельца');
    togglePlate(plate);
    expect(within(plate).queryByTestId('proposal-edited')).toBeNull();
    expect(plate).not.toHaveTextContent('Правка владельца');
  });
});
