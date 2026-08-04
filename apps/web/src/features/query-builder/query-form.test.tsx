import { DAILY_PLANNING_BODY, UPCOMING_BODY } from '@orbis/server/src/seed/smart-lists';
import { aspectJsonSchema, BUILTIN_ASPECT_IDS } from '@orbis/shared';
import { fireEvent, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { type MockHandler, renderWithProviders } from '../../test/harness';
import { queryBlocks } from '../browser/query';
import { QueryBuilderForm } from './QueryBuilderForm';

// Реестр настоящий: каталог полей формы обязан совпадать с каталогом прода — иначе форма
// предлагала бы поля, которых сервер не знает, и прятала бы те, что есть.
const realAspects = BUILTIN_ASPECT_IDS.map((id) => ({ id, schema: aspectJsonSchema(id) }));
const aspectsHandler: MockHandler = (path) => (path === 'aspect.list' ? realAspects : {});

/** Монтирует форму и ждёт каталог (он приезжает tRPC, как у виджета). */
async function openForm(initial: string): Promise<{
  onSave: ReturnType<typeof vi.fn>;
  onCancel: ReturnType<typeof vi.fn>;
  onEditAsText: ReturnType<typeof vi.fn>;
}> {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  const onEditAsText = vi.fn();
  renderWithProviders(
    <QueryBuilderForm
      initial={initial}
      onSave={onSave}
      onCancel={onCancel}
      onEditAsText={onEditAsText}
    />,
    aspectsHandler,
  );
  // Ждём именно КОНТРОЛ формы: кнопки футера нарисованы и в состоянии загрузки каталога,
  // и ожидание по ним пропускало бы тест вперёд, к пустой форме.
  await screen.findByLabelText('Лимит');
  return { onSave, onCancel, onEditAsText };
}

function save(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
}

/** Единственный аргумент последнего вызова onSave. */
function saved(onSave: ReturnType<typeof vi.fn>): string {
  expect(onSave).toHaveBeenCalledTimes(1);
  return onSave.mock.calls[0]?.[0] as string;
}

test('форма открывается разобранным запросом и сохраняет его без изменений байт-в-байт', async () => {
  const initial =
    'aspect=orbis/task, status=inbox, sortBy=created_at:desc, display=list, title=Inbox';
  const { onSave } = await openForm(initial);
  save();
  expect(onSave).toHaveBeenCalledWith(initial);
});

// Приёмочный пункт фазы (Р3): все шесть сидированных smart lists многострочные, с
// 9-пробельными отступами continuation-строк. Сериализатор по построению даёт ОДНУ строку,
// поэтому «открыл форму и ничего не менял» обязано отдавать исходную строку дословно.
test('многострочный блок сидированного smart list переживает форму байт-в-байт', async () => {
  const initial = queryBlocks(DAILY_PLANNING_BODY)[1] as string;
  expect(initial).toContain('\n'); // страховка: блок и правда многострочный
  const { onSave } = await openForm(initial);
  save();
  expect(saved(onSave)).toBe(initial);
});

// `limit` — единственный параметр, который форма держит отдельной строкой ввода, а не
// числом в AST: у него свой путь обратно, и байт-в-байт по нему стоит проверить отдельно.
test('многострочный блок с limit= переживает форму байт-в-байт', async () => {
  const initial = queryBlocks(UPCOMING_BODY)[1] as string;
  expect(initial).toContain('limit=30');
  const { onSave } = await openForm(initial);
  save();
  expect(saved(onSave)).toBe(initial);
});

test('смена лимита меняет сериализованную строку', async () => {
  const { onSave } = await openForm('aspect=orbis/task, limit=30');
  fireEvent.change(screen.getByLabelText('Лимит'), { target: { value: '50' } });
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task, limit=50');
});

// limit=0 и дробный грамматика не выражает: сохранение гасится, а в сообщении стоит то, что
// набрал человек, — не служебное значение, которым форма объясняется сама с собой.
test('нецелый лимит блокирует сохранение, а не печатает битую строку', async () => {
  const { onSave } = await openForm('aspect=orbis/task, limit=30');
  const limit = screen.getByLabelText('Лимит');

  fireEvent.change(limit, { target: { value: '0' } });
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  expect(screen.getByTestId('qb-form-error')).toHaveTextContent("'0'");

  // Дробное значение поле type=number пропускает, а грамматика — нет. В сообщении обязано
  // стоять набранное, а не служебное значение, которым форма объясняется сама с собой.
  fireEvent.change(limit, { target: { value: '1.5' } });
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  const error = screen.getByTestId('qb-form-error');
  expect(error).toHaveTextContent("'1.5'");
  expect(error).not.toHaveTextContent(/NaN/);

  save();
  expect(onSave).not.toHaveBeenCalled();
});

// Пустое поле лимита — это «лимита нет», а не «лимит непечатаем»: конструкция уходит из AST,
// и сохранение остаётся доступным.
test('очистка лимита убирает конструкцию, а не гасит сохранение', async () => {
  const { onSave } = await openForm('aspect=orbis/task, limit=30');
  fireEvent.change(screen.getByLabelText('Лимит'), { target: { value: '' } });
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeEnabled();
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task');
});

// Главное свойство архитектуры «строка на УЗЕЛ, а не на поле»: два сравнения по одному полю
// и две AND-группы тегов — законные конструкции (парсер их не запрещает), и правка чего-то
// третьего обязана оставить их на месте. Заодно — что доступные имена их различают: два
// одинаковых имени на экране означают, что до второго узла не добраться ни клавиатурой, ни
// скринридером.
test('два узла по одному полю и две группы тегов переживают правку лимита', async () => {
  const initial = 'tags=a|b, tags=c, amount>100, amount<500';
  const { onSave } = await openForm(initial);

  expect(screen.getByLabelText('amount #1: значение')).toHaveValue('100');
  expect(screen.getByLabelText('amount #2: значение')).toHaveValue('500');
  expect(screen.getByLabelText('Тег 1')).toHaveValue('a');
  expect(screen.getByLabelText('Тег 2')).toHaveValue('b');
  expect(screen.getByLabelText('Тег 3')).toHaveValue('c');

  fireEvent.change(screen.getByLabelText('Лимит'), { target: { value: '7' } });
  save();
  expect(saved(onSave)).toBe(`${initial}, limit=7`);
});

// Тот же случай для узлов со списками значений: два enum-узла по одному полю дают ДВА набора
// галочек, и без номера строки они звались бы одинаково.
test('два списочных узла по одному полю различимы по имени и правятся раздельно', async () => {
  const initial = 'aspect=orbis/task, status=inbox, status=!done';
  const { onSave } = await openForm(initial);
  expect(screen.getByLabelText('status #1: inbox')).toBeChecked();
  expect(screen.getByLabelText('status #2: done')).toBeChecked();
  expect(screen.getByLabelText('status #1: done')).not.toBeChecked();

  fireEvent.click(screen.getByLabelText('status #2: cancelled'));
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task, status=inbox, status=!done&!cancelled');
});

test('поля аспекта появляются после выбора аспекта', async () => {
  await openForm('aspect=orbis/financial');
  expect(screen.getByLabelText('amount')).toBeInTheDocument();
});

test('снятие аспекта убирает его поля, установка — возвращает', async () => {
  const { onSave } = await openForm('aspect=orbis/task');
  expect(screen.queryByLabelText('amount')).toBeNull();
  fireEvent.click(screen.getByLabelText('Финансы'));
  expect(screen.getByLabelText('amount')).toBeInTheDocument();
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task, aspect=orbis/financial');
});

// Поле orbis/budget.limit в каталоге есть, но в грамматике невыразимо: ключ limit= занят
// параметром выдачи (PRD 01 §6.1). Предложи его форма — фильтр молча исчез бы при печати.
test('затенённое ключом грамматики поле limit не предлагается', async () => {
  await openForm('aspect=orbis/budget');
  expect(screen.getByLabelText('carryover')).toBeInTheDocument();
  expect(screen.queryByLabelText('limit')).toBeNull();
});

test('enum-поле правится галочками значений', async () => {
  const { onSave } = await openForm('aspect=orbis/task, status=inbox');
  fireEvent.click(screen.getByLabelText('status: inbox'));
  fireEvent.click(screen.getByLabelText('status: done'));
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task, status=done');
});

// Пустой список значений — исключение сериализатора: снятие последней галочки обязано
// убирать саму конструкцию, а не печатать `status=`.
test('снятие последнего значения убирает конструкцию целиком', async () => {
  const { onSave } = await openForm('aspect=orbis/task, status=inbox');
  fireEvent.click(screen.getByLabelText('status: inbox'));
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task');
});

test('отрицание сохраняется &-формой', async () => {
  const { onSave } = await openForm('aspect=orbis/task, status=!done&!cancelled');
  fireEvent.click(screen.getByLabelText('status: cancelled'));
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task, status=!done');
});

test('переключение «любое из» → «ни одно из» меняет форму значения', async () => {
  const { onSave } = await openForm('aspect=orbis/task, status=inbox');
  fireEvent.change(screen.getByLabelText('status'), { target: { value: 'noneOf' } });
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task, status=!inbox');
});

test('date-поле правится относительными токенами', async () => {
  const { onSave } = await openForm('aspect=orbis/task, due_date=today|overdue');
  fireEvent.change(screen.getByLabelText('due_date: значение 2'), { target: { value: 'next_7d' } });
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task, due_date=today|next_7d');
});

test('date-поле принимает точную дату вместо токена', async () => {
  const { onSave } = await openForm('aspect=orbis/task, due_date=today');
  fireEvent.change(screen.getByLabelText('due_date: значение 1'), { target: { value: 'exact' } });
  fireEvent.change(screen.getByLabelText('due_date: дата 1'), { target: { value: '2026-08-04' } });
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task, due_date=2026-08-04');
});

test('числовое поле правится сравнением', async () => {
  const { onSave } = await openForm('aspect=orbis/financial, amount>1000');
  fireEvent.change(screen.getByLabelText('amount: значение'), { target: { value: '2000' } });
  save();
  expect(saved(onSave)).toBe('aspect=orbis/financial, amount>2000');
});

test('числовое поле правится диапазоном', async () => {
  const { onSave } = await openForm('aspect=orbis/financial, amount=500..2000');
  fireEvent.change(screen.getByLabelText('amount: до'), { target: { value: '3000' } });
  save();
  expect(saved(onSave)).toBe('aspect=orbis/financial, amount=500..3000');
});

test('сортировка переставляется кнопками', async () => {
  const { onSave } = await openForm('aspect=orbis/task, sortBy=priority:desc|due_date:asc');
  fireEvent.click(screen.getByRole('button', { name: 'Переместить ниже: строка 1' }));
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task, sortBy=due_date:asc|priority:desc');
});

// Одно поле дважды в sortBy парсер разрешает; имя кнопки по полю сделало бы обе строки
// неразличимыми, поэтому имена строит номер строки — он в этом списке и есть смысл.
test('повтор поля в сортировке не делает кнопки одноимёнными', async () => {
  const { onSave } = await openForm('aspect=orbis/task, sortBy=priority:desc|priority:asc');
  expect(screen.getByRole('button', { name: 'Переместить выше: строка 2' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Убрать из сортировки: строка 1' }));
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task, sortBy=priority:asc');
});

test('удаление последнего поля сортировки убирает параметр', async () => {
  const { onSave } = await openForm('aspect=orbis/task, sortBy=priority:desc');
  fireEvent.click(screen.getByRole('button', { name: 'Убрать из сортировки: строка 1' }));
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task');
});

test('в сортировку добавляется core-поле title, недоступное фильтру', async () => {
  const { onSave } = await openForm('aspect=orbis/task');
  fireEvent.change(screen.getByLabelText('Добавить поле сортировки'), {
    target: { value: 'title' },
  });
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task, sortBy=title:asc');
});

test('теги и исключения тегов правятся списками', async () => {
  const { onSave } = await openForm('tags=work');
  fireEvent.change(screen.getByLabelText('Тег 1'), { target: { value: 'дом' } });
  fireEvent.click(screen.getByRole('button', { name: 'Добавить исключённый тег' }));
  fireEvent.change(screen.getByLabelText('Исключённый тег 1'), { target: { value: 'архив' } });
  save();
  expect(saved(onSave)).toBe('tags=дом, excludeTags=архив');
});

// Симметрия с enum-путём (снял последнюю галочку — узла нет): стёртое до пустоты
// единственное значение убирает конструкцию, а не печатает разбирающийся, сохраняемый и
// бессмысленный `tags=""`. Поле при этом остаётся под курсором — строка-заготовка занимает
// то же место, и <input> не пересоздаётся.
test('стёртый единственный тег убирает конструкцию и не отнимает фокус', async () => {
  const { onSave } = await openForm('aspect=orbis/task, tags=work');
  const input = screen.getByLabelText('Тег 1');
  input.focus();
  fireEvent.change(input, { target: { value: '' } });
  expect(screen.getByLabelText('Тег 1')).toHaveFocus();
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task');
});

test('стёртое единственное строковое значение убирает конструкцию и не отнимает фокус', async () => {
  const { onSave } = await openForm('aspect=orbis/financial, counterparty=Магнит');
  const input = screen.getByLabelText('counterparty: значение 1');
  input.focus();
  fireEvent.change(input, { target: { value: '' } });
  expect(screen.getByLabelText('counterparty: значение 1')).toHaveFocus();
  save();
  expect(saved(onSave)).toBe('aspect=orbis/financial');
});

// Значение строкового поля набирается прямо в строке-заготовке: фильтра ещё нет, узел
// заводит первый же символ.
test('строка-заготовка заводит фильтр с первого символа', async () => {
  const { onSave } = await openForm('aspect=orbis/financial');
  fireEvent.change(screen.getByLabelText('counterparty: значение 1'), {
    target: { value: 'Магнит' },
  });
  save();
  expect(saved(onSave)).toBe('aspect=orbis/financial, counterparty=Магнит');
});

// Minor 7: переход «заготовка → узел» не должен пересоздавать строку — иначе выбор оператора
// с клавиатуры выбрасывал бы фокус в body, то есть терял место в форме.
test('выбор оператора не отнимает фокус у строки поля', async () => {
  await openForm('aspect=orbis/task');
  const select = screen.getByLabelText('effort_min');
  select.focus();
  fireEvent.change(select, { target: { value: '>' } });
  expect(screen.getByLabelText('effort_min')).toHaveFocus();
  expect(screen.getByLabelText('effort_min: значение')).toBeInTheDocument();
});

test('excludeBlocked и archived правятся своими контролами', async () => {
  const { onSave } = await openForm('aspect=orbis/task');
  fireEvent.click(screen.getByLabelText('Скрыть заблокированные'));
  fireEvent.change(screen.getByLabelText('Архивные'), { target: { value: 'any' } });
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task, excludeBlocked=true, archived=any');
});

test('relation-фильтр выражается как this', async () => {
  const { onSave } = await openForm('aspect=orbis/task');
  fireEvent.change(screen.getByLabelText('Дети сущности'), { target: { value: 'this' } });
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task, children_of=this');
});

test('relation-фильтр выражается конкретным id', async () => {
  const id = '11111111-2222-4333-8444-555555555555';
  const { onSave } = await openForm('aspect=orbis/task');
  fireEvent.change(screen.getByLabelText('Родители сущности'), { target: { value: 'id' } });
  fireEvent.change(screen.getByLabelText('Id сущности (родители)'), { target: { value: id } });
  save();
  expect(saved(onSave)).toBe(`aspect=orbis/task, parents_of=${id}`);
});

test('заголовок с запятой печатается в кавычках', async () => {
  const { onSave } = await openForm('aspect=orbis/task, title=Дом');
  fireEvent.change(screen.getByLabelText('Заголовок'), { target: { value: 'Дом, милый дом' } });
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task, title="Дом, милый дом"');
});

test('режим отображения и поиск сохраняются', async () => {
  const { onSave } = await openForm('aspect=orbis/task');
  fireEvent.change(screen.getByLabelText('Режим отображения'), { target: { value: 'compact' } });
  fireEvent.change(screen.getByLabelText('Поиск по тексту'), { target: { value: 'отчёт' } });
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task, search=отчёт, display=compact');
});

// Неоднозначное имя (`currency` живёт в orbis/financial и orbis/budget) резолвится по
// aspect= в том же запросе: убери аспект — и строка перестанет разбираться. Форма обязана
// сказать об этом до записи, а не отдать битый блок в body.
test('снятие аспекта у неоднозначного поля блокирует сохранение с объяснением', async () => {
  const { onSave } = await openForm('aspect=orbis/financial, currency=KZT');
  fireEvent.click(screen.getByLabelText('Финансы'));
  expect(screen.getByTestId('qb-form-error')).toHaveTextContent(/неоднозначное поле 'currency'/);
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  save();
  expect(onSave).not.toHaveBeenCalled();
});

// `}}` закрыл бы обёртку {{query: … }} раньше времени, и рендерер body разрезал бы блок на
// части. Сериализатор на таком AST бросает — форма обязана показать отказ, а не упасть.
test('«}}» в значении блокирует сохранение, а не рвёт обёртку блока', async () => {
  const { onSave } = await openForm('aspect=orbis/task, title=Дом');
  fireEvent.change(screen.getByLabelText('Заголовок'), { target: { value: 'Дом}}хвост' } });
  expect(screen.getByTestId('qb-form-error')).toHaveTextContent('}}');
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  save();
  expect(onSave).not.toHaveBeenCalled();
});

test('«Редактировать как текст» отдаёт ТЕКУЩУЮ сериализацию, а не исходную строку', async () => {
  const { onEditAsText } = await openForm('aspect=orbis/task, limit=30');
  fireEvent.change(screen.getByLabelText('Лимит'), { target: { value: '7' } });
  fireEvent.click(screen.getByRole('button', { name: 'Редактировать как текст' }));
  expect(onEditAsText).toHaveBeenCalledWith('aspect=orbis/task, limit=7');
});

// Форму монтируют только для разбираемого блока (это делает QueryBlockEditor), но врать
// «Загрузка…» на неразбираемом нельзя: состояние выглядело бы вечной загрузкой реестра.
test('неразбираемый блок форма называет своим именем, а не «Загрузка…»', async () => {
  const onSave = vi.fn();
  renderWithProviders(
    <QueryBuilderForm
      initial="status="
      onSave={onSave}
      onCancel={vi.fn()}
      onEditAsText={vi.fn()}
    />,
    aspectsHandler,
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(/как текст/);
  expect(screen.queryByText('Загрузка…')).toBeNull();
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
});

test('«Отмена» и Esc отдают отказ вызывающему', async () => {
  const { onCancel } = await openForm('aspect=orbis/task');
  fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
  expect(onCancel).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(onCancel).toHaveBeenCalledTimes(2);
});

// Доступность: ревью фаз B и C ловило именно её. Каждый контрол обязан иметь связанную
// подпись — проверяем на выборке из всех типов контролов формы.
test('у контролов формы есть связанные подписи', async () => {
  await openForm('aspect=orbis/task, status=inbox, due_date=today, sortBy=priority:desc');
  for (const label of [
    'Задача',
    'Лимит',
    'Заголовок',
    'Поиск по тексту',
    'Режим отображения',
    'Архивные',
    'Скрыть заблокированные',
    'Дети сущности',
    'status',
    'status: inbox',
    'due_date: значение 1',
    'Поле сортировки 1',
    'Направление 1',
    'Тег 1',
  ]) {
    expect(screen.getByLabelText(label)).toBeInTheDocument();
  }
});
