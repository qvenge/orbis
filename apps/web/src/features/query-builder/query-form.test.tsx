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

// limit=0 и дробный парсер отвергает, а serializeQuery на таком AST бросает: форма обязана
// не дать его собрать, а не ловить исключение постфактум.
test('нецелый лимит блокирует сохранение, а не печатает битую строку', async () => {
  const { onSave } = await openForm('aspect=orbis/task, limit=30');
  fireEvent.change(screen.getByLabelText('Лимит'), { target: { value: '0' } });
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  expect(screen.getByTestId('qb-form-error')).toHaveTextContent(/limit/i);
  save();
  expect(onSave).not.toHaveBeenCalled();
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
  fireEvent.click(screen.getByRole('button', { name: 'Ниже: priority' }));
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task, sortBy=due_date:asc|priority:desc');
});

test('удаление последнего поля сортировки убирает параметр', async () => {
  const { onSave } = await openForm('aspect=orbis/task, sortBy=priority:desc');
  fireEvent.click(screen.getByRole('button', { name: 'Убрать из сортировки: priority' }));
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
