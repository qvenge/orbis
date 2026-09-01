import { DAILY_PLANNING_BODY, UPCOMING_BODY } from '@orbis/server/src/seed/smart-lists';
import { parseQueryAst, printQueryAst } from '@orbis/shared/query';
import { FIXTURE_PARSE_REGISTRY as REG } from '@orbis/shared/query/fixtures';
import { fireEvent, screen, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { type MockHandler, renderWithProviders } from '../../test/harness';
import { registryReply } from '../../test/registry';
import { queryBlocks } from '../browser/query';
import { QueryBuilderForm } from './QueryBuilderForm';

// Реестры настоящие: каталог полей формы обязан совпадать с каталогом прода — иначе форма
// предлагала бы свойства, которых сервер не знает, и прятала бы те, что есть.
const aspectsHandler: MockHandler = (path) => registryReply(path) ?? {};

/** Монтирует форму и ждёт реестр (он приезжает tRPC, как у виджета). */
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
  // Ждём именно КОНТРОЛ формы: кнопки футера нарисованы и в состоянии загрузки реестра,
  // и ожидание по ним пропускало бы тест вперёд, к пустой форме.
  await screen.findByLabelText('Лимит выдачи');
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
    'aspect=orbis/task, orbis/task_status=inbox, sortBy=orbis/created_at:desc, display=list, title=Inbox';
  const { onSave } = await openForm(initial);
  save();
  expect(onSave).toHaveBeenCalledWith(initial);
});

// Правило Р3 после перевода сидов в key-форму: сид печатью уже НЕ отличается, и на нём
// правило стало тождеством. Живым оно остаётся там, где текст блока писал ЧЕЛОВЕК: пробелы
// и кавычки печать нормализует, и «открыл форму, ничего не поменял, нажал Сохранить» без Р3
// молча переписало бы чужой текст. Поэтому образец здесь — рукописный блок, отличающийся от
// собственной печати ровно оформлением.
test('рукописный блок, отличный от печати оформлением, переживает форму байт-в-байт', async () => {
  const initial = 'aspect=orbis/task,   orbis/task_status=inbox,  limit=30';
  // Страховка: печать этот текст И ПРАВДА меняет — иначе сверка ниже была бы тождеством.
  const parsed = parseQueryAst(initial, REG);
  expect(parsed.ok).toBe(true);
  if (parsed.ok) expect(printQueryAst(parsed.ast, REG, 'key')).not.toBe(initial);
  const { onSave } = await openForm(initial);
  save();
  expect(saved(onSave)).toBe(initial);
});

// Тот же Р3 на СИДЕ — теперь тождество, и это тоже утверждение: тело сида написано печатью
// (`seed-canon.test.ts`), значит форма его не двигает ни с правилом, ни без него.
test('блок сидированного smart list переживает форму байт-в-байт', async () => {
  const initial = queryBlocks(DAILY_PLANNING_BODY)[1] as string;
  const parsed = parseQueryAst(initial, REG);
  expect(parsed.ok).toBe(true);
  if (parsed.ok) expect(printQueryAst(parsed.ast, REG, 'key')).toBe(initial);
  const { onSave } = await openForm(initial);
  save();
  expect(saved(onSave)).toBe(initial);
});

// `limit` — единственный параметр, который форма держит отдельной строкой ввода, а не
// числом в AST: у него свой путь обратно, и байт-в-байт по нему стоит проверить отдельно.
// («Многострочным» этот блок был до Задачи 21b; многострочности в сидах больше нет, и
// обещать её именем теста значило бы обещать проверку, которой в нём не осталось.)
test('блок сида с limit= переживает форму байт-в-байт', async () => {
  const initial = queryBlocks(UPCOMING_BODY)[1] as string;
  expect(initial).toContain('limit=30');
  const { onSave } = await openForm(initial);
  save();
  expect(saved(onSave)).toBe(initial);
});

// Оборотная сторона Р3: НАСТОЯЩАЯ правка печатает блок ЦЕЛИКОМ, а не правит подстроку.
// Оформление рукописного текста при этом теряется — и это правильный размен: половина
// строки в одном виде и половина в другом не разобралась бы ничем.
test('правка рукописного блока печатает его целиком, а не правит подстроку', async () => {
  const initial = 'aspect=orbis/task,   orbis/task_status=inbox,  limit=30';
  const { onSave } = await openForm(initial);
  fireEvent.change(screen.getByLabelText('Лимит выдачи'), { target: { value: '5' } });
  save();
  const text = saved(onSave);
  expect(text).toBe('aspect=orbis/task, orbis/task_status=inbox, limit=5');
});

test('смена лимита меняет напечатанную строку', async () => {
  const { onSave } = await openForm('aspect=orbis/task, limit=30');
  fireEvent.change(screen.getByLabelText('Лимит выдачи'), { target: { value: '50' } });
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task, limit=50');
});

// limit=0 и дробный грамматика не выражает: сохранение гасится, а в сообщении стоит то, что
// набрал человек, — не служебное значение, которым форма объясняется сама с собой.
test('нецелый лимит блокирует сохранение, а не печатает битую строку', async () => {
  const { onSave } = await openForm('aspect=orbis/task, limit=30');
  const limit = screen.getByLabelText('Лимит выдачи');

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
  fireEvent.change(screen.getByLabelText('Лимит выдачи'), { target: { value: '' } });
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeEnabled();
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task');
});

// Главное свойство архитектуры «строка на УЗЕЛ, а не на свойство»: два сравнения по одному
// свойству и две AND-группы тегов — законные конструкции, и правка чего-то третьего обязана
// оставить их на месте. Заодно — что доступные имена их различают: два одинаковых имени на
// экране означают, что до второго узла не добраться ни клавиатурой, ни скринридером.
test('два узла по одному свойству и две группы тегов переживают правку лимита', async () => {
  const initial = 'tags=a|b, tags=c, orbis/amount>100, orbis/amount<500';
  const { onSave } = await openForm(initial);

  expect(screen.getByLabelText('Сумма #1: значение')).toHaveValue('100');
  expect(screen.getByLabelText('Сумма #2: значение')).toHaveValue('500');
  expect(screen.getByLabelText('Тег 1')).toHaveValue('a');
  expect(screen.getByLabelText('Тег 2')).toHaveValue('b');
  expect(screen.getByLabelText('Тег 3')).toHaveValue('c');

  fireEvent.change(screen.getByLabelText('Лимит выдачи'), { target: { value: '7' } });
  save();
  expect(saved(onSave)).toBe(`${initial}, limit=7`);
});

// Тот же случай для узлов со списками значений: два узла-варианта по одному свойству дают ДВА
// набора галочек, и без номера строки они звались бы одинаково.
test('два списочных узла по одному свойству различимы по имени и правятся раздельно', async () => {
  const initial = 'aspect=orbis/task, orbis/task_status=inbox, orbis/task_status=!done';
  const { onSave } = await openForm(initial);
  expect(screen.getByLabelText('Состояние задачи #1: Входящие')).toBeChecked();
  expect(screen.getByLabelText('Состояние задачи #2: Сделана')).toBeChecked();
  expect(screen.getByLabelText('Состояние задачи #1: Сделана')).not.toBeChecked();

  fireEvent.click(screen.getByLabelText('Состояние задачи #2: Отменена'));
  save();
  expect(saved(onSave)).toBe(
    'aspect=orbis/task, orbis/task_status=inbox, orbis/task_status=!done&!cancelled',
  );
});

// Доступное имя контрола — ПОДПИСЬ свойства (§А2-1), а машинный ключ стоит рядом и
// aria-hidden: прежний рулинг «имя контрола = имя поля грамматики» снят вместе с тем, что
// в тексте стояло человеческое слово. Скринридер обязан называть «Состояние задачи».
test('доступное имя строки — подпись свойства, а ключ — видимая подсказка рядом', async () => {
  await openForm('aspect=orbis/task');
  expect(screen.getByLabelText('Состояние задачи')).toBeInTheDocument();
  expect(screen.queryByLabelText('orbis/task_status')).toBeNull();
  expect(screen.getByText('orbis/task_status')).toHaveAttribute('aria-hidden', 'true');
});

test('свойства аспекта появляются после выбора аспекта', async () => {
  await openForm('aspect=orbis/financial');
  expect(screen.getByLabelText('Сумма')).toBeInTheDocument();
});

test('снятие аспекта убирает его свойства, установка — возвращает', async () => {
  const { onSave } = await openForm('aspect=orbis/task');
  expect(screen.queryByLabelText('Сумма')).toBeNull();
  fireEvent.click(screen.getByLabelText('Финансовая операция'));
  expect(screen.getByLabelText('Сумма')).toBeInTheDocument();
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task, aspect=orbis/financial');
});

// БЫЛО НАОБОРОТ до реформы: свойство конверта `limit` в грамматике §6.1 было невыразимо —
// ключ `limit=` занят параметром выдачи, и форма его прятала. Namespaced key (§А5-3а) снял
// затенение по построению: `orbis/limit>1000` однозначен по слэшу, и строка обязана быть.
test('свойство orbis/limit больше не затенено словом грамматики', async () => {
  const { onSave } = await openForm('aspect=orbis/budget');
  expect(screen.getByLabelText('Перенос остатка')).toBeInTheDocument();
  const row = screen.getByLabelText('Лимит');
  fireEvent.change(row, { target: { value: 'gt' } });
  fireEvent.change(screen.getByLabelText('Лимит: значение'), { target: { value: '1000' } });
  save();
  expect(saved(onSave)).toBe('aspect=orbis/budget, orbis/limit>1000');
});

// orbis/recurrence — вложенный объект: фильтра, выразимого грамматикой, для него нет, и
// разбор отказывает с позицией. Предложи его форма — человек набрал бы значение, а
// сохранение упёрлось бы в отказ: выбор, который гарантированно не собирается.
test('нефильтруемое свойство-объект не предлагается', async () => {
  await openForm('aspect=orbis/schedule');
  expect(screen.getByLabelText('Место')).toBeInTheDocument();
  expect(screen.queryByLabelText('Повторение')).toBeNull();
});

// Тот же отказ у orbis/progress_source — причина другая, ветка одна.
test('нефильтруемое свойство-union не предлагается', async () => {
  await openForm('aspect=orbis/goal');
  expect(screen.getByLabelText('Целевое значение')).toBeInTheDocument();
  expect(screen.queryByLabelText('Источник прогресса')).toBeNull();
});

// Граница отказа: список скаляров (orbis/aliases) фильтруется вхождением элемента —
// обычным равенством, тем же контролом, что строка. Отсеки форма и его заодно с объектами,
// и резолв категории по синониму («такси» → «Транспорт») остался бы недоступен из UI.
test('списочное свойство предлагается и печатает обычное равенство', async () => {
  const { onSave } = await openForm('aspect=orbis/category');
  fireEvent.change(screen.getByLabelText('Синонимы: значение 1'), { target: { value: 'такси' } });
  save();
  expect(saved(onSave)).toBe('aspect=orbis/category, orbis/aliases=такси');
});

// Варианты `select` показываются ПОДПИСЬЮ, а хранится ключ: в тексте блока обязан оказаться
// `inbox`, а человек обязан прочитать «Входящие».
test('свойство-вариант правится галочками: подпись видна, ключ уезжает в текст', async () => {
  const { onSave } = await openForm('aspect=orbis/task, orbis/task_status=inbox');
  fireEvent.click(screen.getByLabelText('Состояние задачи: Входящие'));
  fireEvent.click(screen.getByLabelText('Состояние задачи: Сделана'));
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task, orbis/task_status=done');
});

// Пустой список значений канон не выражает (`min(1)` у `or`): снятие последней галочки
// обязано убирать саму конструкцию, а не печатать `orbis/task_status=`.
test('снятие последнего значения убирает конструкцию целиком', async () => {
  const { onSave } = await openForm('aspect=orbis/task, orbis/task_status=inbox');
  fireEvent.click(screen.getByLabelText('Состояние задачи: Входящие'));
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task');
});

// «Заменить, что именно исключаем» — бытовой путь: снял старое значение, поставил новое.
// Снятие последнего убирает узел, и без памяти строки повторный ввод заводил его заново
// жёстким «любое из»: `!done` превращался в `cancelled` — отбор значил бы ровно обратное.
test('перезаведение значения сохраняет «ни одно из» (свойство-вариант)', async () => {
  const { onSave } = await openForm('aspect=orbis/task, orbis/task_status=!done');
  fireEvent.click(screen.getByLabelText('Состояние задачи: Сделана'));
  fireEvent.click(screen.getByLabelText('Состояние задачи: Отменена'));
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task, orbis/task_status=!cancelled');
});

// Тот же механизм у текстового свойства: там узел исчезает от стирания текста, а
// возвращается первым же символом — селект операторов при этом даже не трогают.
test('перезаведение значения сохраняет «ни одно из» (текстовое свойство)', async () => {
  const { onSave } = await openForm('aspect=orbis/task, orbis/waiting_for=!Иван');
  const value = screen.getByLabelText('Ждём: значение 1');
  fireEvent.change(value, { target: { value: '' } });
  fireEvent.change(screen.getByLabelText('Ждём: значение 1'), { target: { value: 'Пётр' } });
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task, orbis/waiting_for=!Пётр');
});

// Граница памяти: «нет фильтра» в селекте — ЯВНЫЙ отказ от конструкции, а не побочный
// эффект стирания значения. После него строка начинается с чистого листа — «любое из».
test('явное «нет фильтра» сбрасывает запомненный оператор строки', async () => {
  const { onSave } = await openForm('aspect=orbis/task, orbis/task_status=!done');
  fireEvent.change(screen.getByLabelText('Состояние задачи'), { target: { value: '' } });
  fireEvent.click(screen.getByLabelText('Состояние задачи: Отменена'));
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task, orbis/task_status=cancelled');
});

test('отрицание сохраняется &-формой', async () => {
  const { onSave } = await openForm('aspect=orbis/task, orbis/task_status=!done&!cancelled');
  fireEvent.click(screen.getByLabelText('Состояние задачи: Отменена'));
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task, orbis/task_status=!done');
});

test('переключение «любое из» → «ни одно из» меняет форму значения', async () => {
  const { onSave } = await openForm('aspect=orbis/task, orbis/task_status=inbox');
  fireEvent.change(screen.getByLabelText('Состояние задачи'), { target: { value: 'noneOf' } });
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task, orbis/task_status=!inbox');
});

test('date-свойство правится относительными токенами', async () => {
  const { onSave } = await openForm('aspect=orbis/task, orbis/due_date=today|overdue');
  fireEvent.change(screen.getByLabelText('Срок: значение 2'), { target: { value: 'next_7d' } });
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task, orbis/due_date=today|next_7d');
});

test('date-свойство принимает точную дату вместо токена', async () => {
  const { onSave } = await openForm('aspect=orbis/task, orbis/due_date=today');
  fireEvent.change(screen.getByLabelText('Срок: значение 1'), { target: { value: 'exact' } });
  fireEvent.change(screen.getByLabelText('Срок: дата 1'), { target: { value: '2026-08-04' } });
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task, orbis/due_date=2026-08-04');
});

test('числовое свойство правится сравнением', async () => {
  const { onSave } = await openForm('aspect=orbis/financial, orbis/amount>1000');
  fireEvent.change(screen.getByLabelText('Сумма: значение'), { target: { value: '2000' } });
  save();
  expect(saved(onSave)).toBe('aspect=orbis/financial, orbis/amount>2000');
});

test('числовое свойство правится диапазоном', async () => {
  const { onSave } = await openForm('aspect=orbis/financial, orbis/amount=500..2000');
  fireEvent.change(screen.getByLabelText('Сумма: до'), { target: { value: '3000' } });
  save();
  expect(saved(onSave)).toBe('aspect=orbis/financial, orbis/amount=500..3000');
});

// ДОЛГ ГЕЙТА ЗАДАЧИ 8, закрытый здесь: тип свойства форма берёт из РЕЕСТРА (`kind`), а не из
// обеднённого словаря старого каталога, где `time` приезжал строкой. Возьми она `type` —
// сравнения по времени пропали бы из селекта, хотя разбор их принимает (§А5-7: у `time` есть
// линейный порядок). `orbis/routine_at` — единственное свойство типа `time` в реестре.
test('свойство типа time сравнимо: оператор берётся по kind реестра', async () => {
  const { onSave } = await openForm('aspect=orbis/routine');
  fireEvent.change(screen.getByLabelText('Время запуска'), { target: { value: 'gt' } });
  fireEvent.change(screen.getByLabelText('Время запуска: значение'), {
    target: { value: '09:30' },
  });
  save();
  expect(saved(onSave)).toBe('aspect=orbis/routine, orbis/routine_at>09:30');
});

test('сортировка переставляется кнопками', async () => {
  const { onSave } = await openForm(
    'aspect=orbis/task, sortBy=orbis/priority:desc|orbis/due_date:asc',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Переместить ниже: строка 1' }));
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task, sortBy=orbis/due_date:asc|orbis/priority:desc');
});

// Одно свойство дважды в sortBy разбор разрешает; имя кнопки по свойству сделало бы обе
// строки неразличимыми, поэтому имена строит номер строки — он в этом списке и есть смысл.
test('повтор свойства в сортировке не делает кнопки одноимёнными', async () => {
  const { onSave } = await openForm(
    'aspect=orbis/task, sortBy=orbis/priority:desc|orbis/priority:asc',
  );
  expect(screen.getByRole('button', { name: 'Переместить выше: строка 2' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Убрать из сортировки: строка 1' }));
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task, sortBy=orbis/priority:asc');
});

test('удаление последнего свойства сортировки убирает параметр', async () => {
  const { onSave } = await openForm('aspect=orbis/task, sortBy=orbis/priority:desc');
  fireEvent.click(screen.getByRole('button', { name: 'Убрать из сортировки: строка 1' }));
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task');
});

// Сортировка уже фильтров по типу: линейного порядка нет ни у списка, ни у объекта, и разбор
// отказывает по обоим («по свойству … сортировать нельзя»).
//
// Все три аспекта названы в запросе НАМЕРЕННО, хотя селект и так берёт имена из всего
// реестра независимо от `aspect=`. На одном `aspect=orbis/category` отсутствие «Повторения» и
// «Источника прогресса» доказывало бы ровно это свойство селекта, а не отказ по типу: почини
// кто-нибудь сужение сортировки до выбранных аспектов — и две трети теста выродились бы в
// тавтологию, продолжая зеленеть. Соседние свойства тех же аспектов стоят положительным
// контролем: раз «Класс траты», «Место» и «Целевое значение» в селекте есть, значит реестр
// доехал и отсеян именно тип.
test('в сортировку не предлагаются ни список, ни объект, ни union', async () => {
  await openForm('aspect=orbis/category, aspect=orbis/schedule, aspect=orbis/goal');
  const add = screen.getByLabelText('Добавить поле сортировки');
  for (const name of ['Класс траты', 'Место', 'Целевое значение']) {
    expect(within(add).getByRole('option', { name })).toBeInTheDocument();
  }
  for (const name of ['Синонимы', 'Повторение', 'Источник прогресса']) {
    expect(within(add).queryByRole('option', { name })).toBeNull();
  }
});

// `orbis/title` доступен сортировке, но строки фильтра не получает (см. `CORE_FIELD_IDS`):
// отбор по заголовку продукт делает через `search=`. «Заголовок» на экране ровно один — поле
// параметра выдачи, а не селект операторов.
test('в сортировку добавляется core-свойство «Заголовок», недоступное фильтру', async () => {
  const { onSave } = await openForm('aspect=orbis/task');
  expect(screen.getByLabelText('Заголовок').tagName).toBe('INPUT');
  fireEvent.change(screen.getByLabelText('Добавить поле сортировки'), {
    target: { value: 'orbis/title' },
  });
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task, sortBy=orbis/title:asc');
});

// Печать канона выражает исключение тега общим отрицанием (`!tags=`), а не сахаром
// `excludeTags=`: оба текста разбираются в ОДНО дерево, и второй формы у печати нет.
test('теги и исключения тегов правятся списками', async () => {
  const { onSave } = await openForm('tags=work');
  fireEvent.change(screen.getByLabelText('Тег 1'), { target: { value: 'дом' } });
  fireEvent.click(screen.getByRole('button', { name: 'Добавить исключённый тег' }));
  fireEvent.change(screen.getByLabelText('Исключённый тег 1'), { target: { value: 'архив' } });
  save();
  expect(saved(onSave)).toBe('tags=дом, !tags=архив');
});

// Симметрия с путём вариантов (снял последнюю галочку — узла нет): стёртое до пустоты
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

test('стёртое единственное текстовое значение убирает конструкцию и не отнимает фокус', async () => {
  const { onSave } = await openForm('aspect=orbis/financial, orbis/counterparty=Магнит');
  const input = screen.getByLabelText('Контрагент: значение 1');
  input.focus();
  fireEvent.change(input, { target: { value: '' } });
  expect(screen.getByLabelText('Контрагент: значение 1')).toHaveFocus();
  save();
  expect(saved(onSave)).toBe('aspect=orbis/financial');
});

// Значение текстового свойства набирается прямо в строке-заготовке: фильтра ещё нет, узел
// заводит первый же символ.
test('строка-заготовка заводит фильтр с первого символа', async () => {
  const { onSave } = await openForm('aspect=orbis/financial');
  fireEvent.change(screen.getByLabelText('Контрагент: значение 1'), {
    target: { value: 'Магнит' },
  });
  save();
  expect(saved(onSave)).toBe('aspect=orbis/financial, orbis/counterparty=Магнит');
});

// Minor 7: переход «заготовка → узел» не должен пересоздавать строку — иначе выбор оператора
// с клавиатуры выбрасывал бы фокус в body, то есть терял место в форме.
test('выбор оператора не отнимает фокус у строки поля', async () => {
  await openForm('aspect=orbis/task');
  const select = screen.getByLabelText('Трудоёмкость, мин');
  select.focus();
  fireEvent.change(select, { target: { value: 'gt' } });
  expect(screen.getByLabelText('Трудоёмкость, мин')).toHaveFocus();
  expect(screen.getByLabelText('Трудоёмкость, мин: значение')).toBeInTheDocument();
});

// OR между РАЗНЫМИ свойствами канон выражает, а плоский текст грамматики v1 — нет (§А5-3д), и
// блок до Задачи 21 хранит текст. Кнопка обязана быть видна и погашена: спрятать её значило
// бы скрыть, что возможность существует, а дать нажать — собрать запрос, который не
// сохранится.
test('кнопка «ИЛИ между полями» видна, погашена и объясняет причину', async () => {
  await openForm('aspect=orbis/task');
  const button = screen.getByRole('button', { name: 'ИЛИ между полями' });
  expect(button).toBeDisabled();
  const hintId = button.getAttribute('aria-describedby') as string;
  expect(document.getElementById(hintId)).toHaveTextContent('после перехода блока на AST');
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

// Значение с ПРОБЕЛОМ — отдельный класс отказа канона (§А5-3: пробел разделяет конструкции).
// Форма обязана закавычить его сама: иначе сохранённый ею же блок перестал бы разбираться.
test('заголовок с пробелом печатается в кавычках', async () => {
  const { onSave } = await openForm('aspect=orbis/task');
  fireEvent.change(screen.getByLabelText('Заголовок'), { target: { value: 'Мои задачи' } });
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task, title="Мои задачи"');
});

test('режим отображения и поиск сохраняются', async () => {
  const { onSave } = await openForm('aspect=orbis/task');
  fireEvent.change(screen.getByLabelText('Режим отображения'), { target: { value: 'compact' } });
  fireEvent.change(screen.getByLabelText('Поиск по тексту'), { target: { value: 'отчёт' } });
  save();
  expect(saved(onSave)).toBe('aspect=orbis/task, search=отчёт, display=compact');
});

// БЫЛО НАОБОРОТ до реформы: `currency` живёт в orbis/financial и orbis/budget, и снятие
// аспекта делало имя неоднозначным — форма гасила сохранение с объяснением. С §А5-3а в
// дереве лежит id свойства, а печатается его namespaced key: неоднозначности нет по
// построению, и снятие аспекта запрос больше не ломает.
test('снятие аспекта у прежде неоднозначного свойства сохранение не блокирует', async () => {
  const { onSave } = await openForm('aspect=orbis/financial, orbis/currency=KZT');
  fireEvent.click(screen.getByLabelText('Финансовая операция'));
  expect(screen.queryByTestId('qb-form-error')).toBeNull();
  save();
  expect(saved(onSave)).toBe('orbis/currency=KZT');
});

// `}}` закрыл бы обёртку {{query: … }} раньше времени, и рендерер body разрезал бы блок на
// части. Форма больше НЕ запрещает такое значение — печать разводит `}` бэкслешем
// (`quoteQueryValue`), а разбор снимает экран тем же правилом (Р-21-3). Проверяется ровно
// это: значение доезжает целым, а `}}` в напечатанной строке не появляется.
test('«}}» в значении печатается экранированным, а обёртку блока не рвёт', async () => {
  const { onSave } = await openForm('aspect=orbis/task, title=Дом');
  fireEvent.change(screen.getByLabelText('Заголовок'), { target: { value: 'Дом}}хвост' } });
  expect(screen.queryByTestId('qb-form-error')).toBeNull();
  save();
  const text = saved(onSave);
  // Строка блока `}}` не содержит — иначе она закрыла бы обёртку в markdown-проекции…
  expect(text).not.toContain('}}');
  // …а значение при этом цело: обратный разбор той же строки возвращает исходный заголовок.
  const parsed = parseQueryAst(text, REG);
  expect(parsed.ok && parsed.ast.title).toBe('Дом}}хвост');
});

// Пустая граница сравнения печатается, но обратно не разбирается: отказ обязан быть виден ДО
// записи, а не красной плашкой виджета после неё.
test('пустая граница сравнения блокирует сохранение отказом разбора', async () => {
  const { onSave } = await openForm('aspect=orbis/financial, orbis/amount>1000');
  fireEvent.change(screen.getByLabelText('Сумма: значение'), { target: { value: '' } });
  expect(screen.getByTestId('qb-form-error')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  save();
  expect(onSave).not.toHaveBeenCalled();
});

test('«Редактировать как текст» отдаёт ТЕКУЩУЮ печать, а не исходную строку', async () => {
  const { onEditAsText } = await openForm('aspect=orbis/task, limit=30');
  fireEvent.change(screen.getByLabelText('Лимит выдачи'), { target: { value: '7' } });
  fireEvent.click(screen.getByRole('button', { name: 'Редактировать как текст' }));
  expect(onEditAsText).toHaveBeenCalledWith('aspect=orbis/task, limit=7');
});

// Форму монтируют только для разбираемого блока (это делает QueryBlockEditor), но врать
// «Загрузка…» на неразбираемом нельзя: состояние выглядело бы вечной загрузкой реестра.
test('неразбираемый блок форма называет своим именем, а не «Загрузка…»', async () => {
  const onSave = vi.fn();
  renderWithProviders(
    <QueryBuilderForm
      initial="orbis/task_status="
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
  await openForm(
    'aspect=orbis/task, orbis/task_status=inbox, orbis/due_date=today, sortBy=orbis/priority:desc',
  );
  for (const label of [
    'Задача',
    'Лимит выдачи',
    'Заголовок',
    'Поиск по тексту',
    'Режим отображения',
    'Архивные',
    'Скрыть заблокированные',
    'Дети сущности',
    'Состояние задачи',
    'Состояние задачи: Входящие',
    'Срок: значение 1',
    'Поле сортировки 1',
    'Направление 1',
    'Тег 1',
  ]) {
    expect(screen.getByLabelText(label)).toBeInTheDocument();
  }
});
