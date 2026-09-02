import { DAILY_PLANNING_BODY } from '@orbis/server/src/seed/smart-lists';
import { parseBody, serializeBody } from '@orbis/shared/doc';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { installCrashTrap, type MockHandler, renderWithProviders } from '../../test/harness';
import { registryReply } from '../../test/registry';
import { BodyEditor } from '../entity-editor/BodyEditor';
import { QueryTextEditor } from './QueryTextEditor';

// Модалка блока живёт в портале, а открывает её колбэк NodeView: брошенное оттуда jsdom гасит,
// ассерты остаются зелёными, а прогон падает кодом 1. Ставится файлом, не глобально: см. harness.
installCrashTrap();

// Реестры настоящие: каталог полей и разбор имён в тесте те же, что в проде, иначе
// «неразбираемый блок» в тесте оказался бы разбираемым в продукте (и наоборот).

/**
 * Хозяин виджетов — РЕДАКТОР, а не detail-экран.
 *
 * До Задачи 15 эти тесты ходили через `DetailScreen`, потому что кнопку «Настроить» рисовал его
 * собственный просмотр тела, а правка блока была заменой ПОДСТРОКИ в `body` и уезжала мутацией
 * `entity.update` со строковым телом. Ни того, ни другого больше нет: «Настроить» есть только у
 * NodeView внутри редактора, а правка блока стала правкой АТРИБУТА ноды. Экран между
 * пользователем и блоком теперь не стоит вовсе — и держать его в тесте значило бы проверять
 * лишнее (табы, шапку, автосохранение по паузе) ради того же самого утверждения.
 *
 * Что делает сам экран с редактором — проверяет detail.test.tsx; что делает виджет с атрибутом —
 * nodes/query-widget.test.tsx. Здесь остался КОНСТРУКТОР ЗАПРОСА: какой редактор открывается,
 * что он показывает, что отдаёт наружу и куда возвращается фокус.
 */
const handler: MockHandler = (path) => {
  const reg = registryReply(path);
  if (reg !== undefined) return reg;
  if (path === 'entity.query') return [];
  return {};
};

/** Тело в редакторе + спай на изменения документа: правка блока наблюдается по документу. */
function mountBody(md: string) {
  const onChange = vi.fn();
  const r = renderWithProviders(<BodyEditor doc={parseBody(md)} onChange={onChange} />, handler);
  return { ...r, onChange, saved: () => serializeBody(onChange.mock.calls.at(-1)?.[0]) };
}

const TWO_BLOCKS =
  'Утренний обзор\n\n{{query: tags=work, title=Работа}}\n\nмежду\n\n{{query: tags=home, title=Дом}}\n\nхвост';

// Те же два блока, но НЕразбираемые (`orbis/task_status=` — пустое значение). Строковый
// редактор — это редактор именно битого блока (§3.4): у валидного «Настроить» открывает
// форму, поэтому тесты текстового пути обязаны идти по битому, иначе они проверяли бы не
// тот редактор.
const TWO_BLOCKS_BROKEN = TWO_BLOCKS.replaceAll('tags=', 'orbis/task_status=, tags=');

/** Открывает редактор N-го блока кнопкой «Настроить» на его виджете. */
async function openBlockEditor(index = 0): Promise<HTMLElement> {
  await waitFor(() => expect(screen.getAllByTestId('qb-configure').length).toBeGreaterThan(index));
  const button = screen.getAllByTestId('qb-configure')[index];
  if (button === undefined) throw new Error(`нет виджета №${index}`);
  fireEvent.click(button);
  return await screen.findByRole('dialog');
}

function editorField(dialog: HTMLElement): HTMLTextAreaElement {
  return within(dialog).getByTestId('query-text-edit') as HTMLTextAreaElement;
}

test('«Настроить» у невалидного блока открывает редактор с текстом блока и позицией ошибки', async () => {
  mountBody('{{query: aspect=orbis/task, orbis/task_status=}}');
  // §6.4: битый блок — плашка, а не пустой список; настроить его надо уметь именно оттуда,
  // иначе единственный путь починки — редактировать весь текст руками.
  await screen.findByTestId('qb-error');

  const dialog = await openBlockEditor();
  expect(editorField(dialog)).toHaveValue(' aspect=orbis/task, orbis/task_status=');
  expect(within(dialog).getByTestId('query-text-error')).toHaveTextContent(/позиция \d+/);
});

test('сохранение изменённого текста заменяет только этот блок', async () => {
  const s = mountBody(TWO_BLOCKS_BROKEN);
  const dialog = await openBlockEditor(1);
  fireEvent.change(editorField(dialog), { target: { value: 'tags=home, limit=5, title=Дом' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

  await waitFor(() => expect(s.onChange).toHaveBeenCalled());
  // Соседний блок цел ДОСЛОВНО, вместе с текстом вокруг: «правка блока» обязана остаться
  // правкой одного блока, а не пересборкой тела.
  expect(s.saved()).toBe(
    'Утренний обзор\n\n{{query: orbis/task_status=, tags=work, title=Работа}}\n\nмежду\n\n{{query:tags=home, limit=5, title=Дом}}\n\nхвост',
  );
});

// Р3, сквозная проверка: «открыл форму валидного блока и нажал Сохранить» не обязано
// давать правку документа. Сид написан печатью (`seed-canon.test.ts`), поэтому схлопывать
// здесь уже нечего — но правило сторожит не только сид: любая пересборка блока из формы
// пометила бы запись изменённой и подняла бы фантомное автосохранение.
test('сохранение формы без изменений документ не трогает', async () => {
  const s = mountBody(DAILY_PLANNING_BODY);
  const dialog = await openBlockEditor(1);
  // Открылась именно форма: у валидного блока строкового редактора быть не должно.
  expect(await within(dialog).findByLabelText('Заголовок')).toHaveValue('Сегодня');
  expect(within(dialog).queryByTestId('query-text-edit')).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  // Правка, не меняющая смысла, до сохранения не доезжает вовсе (сравнение по смыслу в
  // BodyEditor): пересоберись блок иначе, чем он записан, — тут была бы правка.
  expect(s.onChange).not.toHaveBeenCalled();
});

test('правка формы заменяет только этот блок', async () => {
  const s = mountBody(TWO_BLOCKS);
  const dialog = await openBlockEditor(1);
  fireEvent.change(await within(dialog).findByLabelText('Лимит выдачи'), {
    target: { value: '5' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

  await waitFor(() => expect(s.onChange).toHaveBeenCalled());
  expect(s.saved()).toBe(
    'Утренний обзор\n\n{{query: tags=work, title=Работа}}\n\nмежду\n\n{{query:tags=home, limit=5, title=Дом}}\n\nхвост',
  );
});

// §3.4: «редактировать как текст» — тот же строковый редактор с ТЕКУЩЕЙ сериализацией,
// иначе набранное в форме терялось бы на переходе.
test('из формы «Редактировать как текст» открывает строковый редактор с правками формы', async () => {
  mountBody(TWO_BLOCKS);
  const form = await openBlockEditor(0);
  fireEvent.change(await within(form).findByLabelText('Заголовок'), { target: { value: 'Дела' } });
  fireEvent.click(within(form).getByRole('button', { name: 'Редактировать как текст' }));

  const text = await screen.findByRole('dialog');
  expect(editorField(text)).toHaveValue('tags=work, title=Дела');
});

test('«Отмена» закрывает редактор и ничего не пишет', async () => {
  const s = mountBody(TWO_BLOCKS_BROKEN);
  const dialog = await openBlockEditor(0);
  fireEvent.change(editorField(dialog), { target: { value: 'tags=work, limit=1' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(s.onChange).not.toHaveBeenCalled();
});

// Канон §6.4: невалидный блок — это состояние продукта (красная плашка), а не запрет на
// запись. Кнопка «Сохранить» без парсера: иначе из битого блока не выйти правкой по шагам.
test('невалидную строку сохранить можно', async () => {
  const s = mountBody(TWO_BLOCKS_BROKEN);
  const dialog = await openBlockEditor(0);
  fireEvent.change(editorField(dialog), { target: { value: 'tags=' } });
  const save = within(dialog).getByRole('button', { name: 'Сохранить' });
  expect(save).toBeEnabled();
  fireEvent.click(save);

  await waitFor(() => expect(s.onChange).toHaveBeenCalled());
  expect(s.saved()).toContain('{{query:tags=}}');
});

/*
 * ЧЕТЫРЕ теста прежнего пути отсюда УШЛИ вместе с самим путём (три причины на четыре теста —
 * у первой их два), и не «за ненадобностью»:
 *
 *  - «клик по „Настроить“ не открывает редактор тела» и «клик внутри модалки не открывает
 *    редактор тела под ней» — отдельного «редактора тела», который можно открыть кликом, на
 *    экране больше нет: тело И ЕСТЬ редактор. Ту же беду (React-события из портала всплывают
 *    по дереву React) сторожат nodes/query-widget.test.tsx — «клик внутри модалки блока не
 *    уходит в редактор» и «модалка блока не подменяет собой первый кадр EditorShell».
 *  - «в режиме правки тела кнопки „Настроить“ нет» — режима правки тела не существует, а
 *    вместе с ним и повода прятать кнопку: вторая запись подряд с протухшим expectedUpdatedAt
 *    теперь невозможна по устройству (сохранение одно, по паузе, с учётом полёта).
 *  - «body сменился под открытой модалкой — правка в чужой блок не уезжает» — оптимистичная
 *    блокировка блока («Блок изменился в другом месте») удалена ВМЕСТЕ с адресацией по
 *    порядковому номеру: адрес правки — сама нода, промахнуться мимо неё нечем
 *    (QueryWidget.tsx). Что происходит с открытой модалкой при приезде чужой версии
 *    документа — замерено и записано там же.
 */

// Radix в модальном режиме гасит восстановление фокуса FocusScope и фокусирует ТРИГГЕР, а
// ui/Dialog его не рендерит (модалку монтируют условно) — фокус уходил на <body>, и до
// следующей кнопки «Настроить» надо было таббать с начала страницы. На сидированном Daily
// Planning блоков три, и цена этого — три прохода табом за одну правку.
test('после закрытия модалки фокус возвращается на кнопку, которой её открыли', async () => {
  mountBody(TWO_BLOCKS);
  await waitFor(() => expect(screen.getAllByTestId('qb-configure')).toHaveLength(2));
  const button = screen.getAllByTestId('qb-configure')[1] as HTMLElement;
  button.focus();

  fireEvent.click(button);
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }));
  await waitFor(() => expect(button).toHaveFocus());

  // Esc и крестик — тот же выход, и фокусу положено вернуться так же.
  fireEvent.click(button);
  const again = await screen.findByRole('dialog');
  fireEvent.keyDown(again, { key: 'Escape' });
  await waitFor(() => expect(button).toHaveFocus());
});

// «Редактировать как текст» — эстафета между модалками: форма уходит, строковый редактор
// приходит, и к его первому рендеру фокус стоит внутри УМИРАЮЩЕЙ модалки. Опорой такой
// элемент быть не может (через миг его не будет в документе), и опора наследуется от
// предыдущей модалки — кнопкой «Настроить» открыли обе.
test('после перехода «в текст» фокус возвращается на ту же «Настроить»', async () => {
  mountBody(TWO_BLOCKS);
  await waitFor(() => expect(screen.getAllByTestId('qb-configure')).toHaveLength(2));
  const button = screen.getAllByTestId('qb-configure')[0] as HTMLElement;
  button.focus();

  fireEvent.click(button);
  const form = await screen.findByRole('dialog');
  fireEvent.click(await within(form).findByRole('button', { name: 'Редактировать как текст' }));
  const text = await screen.findByRole('dialog');
  fireEvent.click(within(text).getByRole('button', { name: 'Отмена' }));

  await waitFor(() => expect(button).toHaveFocus());
});

test('кнопка «Настроить» — настоящая кнопка с доступным именем', async () => {
  mountBody(TWO_BLOCKS);
  const buttons = await screen.findAllByRole('button', { name: 'Настроить' });
  expect(buttons).toHaveLength(2);
  expect(buttons[0]?.tagName).toBe('BUTTON');
});

// --- сам редактор ----------------------------------------------------------------------

const editorHandler: MockHandler = (path) => registryReply(path) ?? {};

// Radix сам проставляет content'у aria-describedby на свой Description; примитив ui/Dialog
// его не рендерит, поэтому ссылка вела в никуда — скринридер объявлял бы модалку с
// описанием, которого нет. Первым потребителем примитива стал этот редактор.
test('у модалки нет ссылки на несуществующее описание', async () => {
  renderWithProviders(
    <QueryTextEditor initial="tags=work" onSave={() => {}} onCancel={() => {}} />,
    editorHandler,
  );
  const dialog = await screen.findByRole('dialog');
  const described = dialog.getAttribute('aria-describedby');
  if (described !== null) expect(document.getElementById(described)).not.toBeNull();
  expect(described).toBeNull();
});

test('поле редактора имеет доступное имя и фокус при открытии', async () => {
  renderWithProviders(
    <QueryTextEditor initial="tags=work" onSave={() => {}} onCancel={() => {}} />,
    editorHandler,
  );
  const field = await screen.findByLabelText('Текст запроса');
  expect(field.tagName).toBe('TEXTAREA');
  await waitFor(() => expect(field).toHaveFocus());
});

// Ошибка описывает ТЕКУЩИЙ текст: замри она на исходном, и починенный запрос продолжал бы
// показывать красную плашку — «почини то, чего уже нет».
test('сообщение об ошибке пересчитывается по мере правки', async () => {
  renderWithProviders(
    <QueryTextEditor
      initial="tags=work, orbis/task_status="
      onSave={() => {}}
      onCancel={() => {}}
    />,
    editorHandler,
  );
  const field = await screen.findByLabelText('Текст запроса');
  await screen.findByTestId('query-text-error');

  fireEvent.change(field, { target: { value: 'tags=work, orbis/task_status=inbox' } });
  await waitFor(() => expect(screen.queryByTestId('query-text-error')).toBeNull());
});

// В поле — ВНУТРЕННОСТЬ блока: обёртку экран приставит сам. Разбирай редактор текст с
// поблажкой на обёртку (её делает parseBlock для виджета), вставленный целиком блок
// показал бы «ошибок нет», а сохранение вложило бы {{query: внутрь {{query: и порвало
// разметку тела — ошибку пользователь увидел бы уже постфактум, на плашке виджета.
test('вставленный целиком {{query:…}} — ошибка, а не молчаливое согласие', async () => {
  renderWithProviders(
    <QueryTextEditor initial="{{query: tags=work}}" onSave={() => {}} onCancel={() => {}} />,
    editorHandler,
  );
  expect(await screen.findByTestId('query-text-error')).toBeInTheDocument();
});

// Единственный запрет на сохранение — и ровно про РАЗМЕТКУ тела, а не про грамматику.
// `}}` парсер принимает молча (`tags=a}}b` разбирается без ошибки, красной плашки нет), но
// рендерер блоков закроет обёртку на первом же вхождении: хвост запроса станет текстом
// заметки, а `{{query:` в нём заведёт лишний блок и сдвинет нумерацию, на которой стоит
// бейдж pinned-сущности (§3.2). §6.4 оставляет «Сохранить» доступным у НЕразбираемой
// строки — испортить обёртку она права не даёт.
test('`}}` в тексте гасит сохранение с объяснением причины', async () => {
  const onSave = vi.fn();
  renderWithProviders(
    <QueryTextEditor initial="tags=work" onSave={onSave} onCancel={() => {}} />,
    editorHandler,
  );
  const field = await screen.findByLabelText('Текст запроса');

  fireEvent.change(field, { target: { value: 'tags=a}}b' } });
  // Разбор молчит — сообщение обязано быть своё, отдельное от плашки парсера.
  expect(screen.queryByTestId('query-text-error')).toBeNull();
  const blocked = screen.getByTestId('query-text-wrapper');
  expect(blocked).toHaveTextContent('}}');
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  expect(onSave).not.toHaveBeenCalled();

  // Вставленный целиком блок — тот же пролом (плюс своя ошибка разбора).
  fireEvent.change(field, { target: { value: '{{query: tags=work}}' } });
  expect(screen.getByTestId('query-text-wrapper')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();

  // Убрал маркер — запрет снят: запрет ровно на порчу обёртки, а не на «непонятную строку».
  fireEvent.change(field, { target: { value: 'tags=ab' } });
  expect(screen.queryByTestId('query-text-wrapper')).toBeNull();
  const save = screen.getByRole('button', { name: 'Сохранить' });
  expect(save).toBeEnabled();
  fireEvent.click(save);
  expect(onSave).toHaveBeenCalledWith('tags=ab');
});

test('onSave получает текст поля, onCancel — по Esc', async () => {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  renderWithProviders(
    <QueryTextEditor initial="tags=work" onSave={onSave} onCancel={onCancel} />,
    editorHandler,
  );
  const field = await screen.findByLabelText('Текст запроса');
  fireEvent.change(field, { target: { value: 'tags=home' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  expect(onSave).toHaveBeenCalledWith('tags=home');

  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  await waitFor(() => expect(onCancel).toHaveBeenCalled());
});

// ---------------------------------------------------------------------------
// Р-21-8, ВХОД-ДЕРЕВА: блок, оставшийся без условий, — «не настроен», а не весь корпус
// ---------------------------------------------------------------------------

test('очистка текста блока даёт ПУСТОЙ блок, а не «все сущности владельца» (Р-21-8)', async () => {
  // Гард Р-21-8 смотрел только на текст, и вход-дерева его обходил: своя сборка пары в
  // `QueryWidget.save` клала `{ast:{filter:null}, text:''}`, виджет рисовал «Совпадений: N»,
  // а `body_doc` хранил безусловное дерево навсегда.
  const s = mountBody('{{query: aspect=orbis/task, orbis/task_status=}}');
  const dialog = await openBlockEditor();
  fireEvent.change(editorField(dialog), { target: { value: '' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

  await waitFor(() => expect(s.onChange).toHaveBeenCalled());
  expect(s.saved()).toBe('{{query:}}');
  const attrs = JSON.stringify(s.onChange.mock.calls.at(-1)?.[0]);
  expect(attrs).toContain('"ast":null');
  // И виджет говорит то же самое: плашка вместо счётчика.
  await waitFor(() => expect(screen.getByTestId('qb-error')).toHaveTextContent(/пустой запрос/i));
});

test('снятие последнего аспекта в форме даёт ПУСТОЙ блок, а не «все сущности» (Р-21-8)', async () => {
  // Второй вход в то же состояние, и он — обычный жест в два клика: у блока было одно
  // условие, владелец снял галочку.
  const s = mountBody('{{query:aspect=orbis/task}}');
  const dialog = await openBlockEditor();
  fireEvent.click(await within(dialog).findByLabelText('Задача'));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

  await waitFor(() => expect(s.onChange).toHaveBeenCalled());
  expect(s.saved()).toBe('{{query:}}');
  expect(JSON.stringify(s.onChange.mock.calls.at(-1)?.[0])).toContain('"ast":null');
  await waitFor(() => expect(screen.getByTestId('qb-error')).toHaveTextContent(/пустой запрос/i));
});
