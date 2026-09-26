// Контрол свойства по ТИПУ из реестра (§А2-2/§А9-2) и по флагам записи (§А2-5).
//
// Проба идёт по НАСТОЯЩИМ строкам встроенного реестра, а не по выдуманным: тип, подпись и
// флаги здесь ровно те, что увидит владелец, — иначе «select показывает подпись варианта»
// доказывалось бы вариантом, которого в проде нет.
import { BUILTIN_PROPERTY_META, type PropertyDefinition } from '@orbis/shared';
import { fireEvent, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../test/harness';
import { registryReply } from '../../test/registry';
import { controlKindOf, parseControlValue, writeModeOf } from './controls';
import { displayText } from './format';
import { PropertyControl } from './PropertyControl';

function def(id: string): PropertyDefinition {
  const found = BUILTIN_PROPERTY_META.find((p) => p.id === id);
  if (found === undefined) throw new Error(`нет свойства ${id} во встроенном реестре`);
  return found;
}

test('контрол выбирается по kind, а не по значению: select, чекбокс, дата, число, текст', () => {
  // Значения у всех пяти НЕТ вовсе — прежняя форма (по `typeof value`) не смогла бы
  // отличить их друг от друга ни в одном из пяти случаев.
  expect(controlKindOf(def('orbis/task_status'))).toBe('select');
  expect(controlKindOf(def('orbis/all_day'))).toBe('boolean');
  expect(controlKindOf(def('orbis/due_date'))).toBe('date');
  expect(controlKindOf(def('orbis/effort_min'))).toBe('number');
  expect(controlKindOf(def('orbis/amount'))).toBe('decimal');
  expect(controlKindOf(def('orbis/routine_at'))).toBe('time');
  expect(controlKindOf(def('orbis/waiting_for'))).toBe('text');
  // `select` с `cardinality: many` — чипы, а не один выбор.
  expect(controlKindOf(def('orbis/routine_days'))).toBe('select-many');
  // Список СВОБОДНОГО текста однострочной формы не имеет — только показ.
  expect(controlKindOf(def('orbis/aliases'))).toBe('readonly');
  expect(controlKindOf(def('orbis/progress_source'))).toBe('readonly');
});

test('два флага — два разных режима, и в один они не сводятся', () => {
  // `system_writable`: значение приходит извне (импорт, правило, глагол исполнителя).
  expect(writeModeOf(def('orbis/bank_txn_id'))).toBe('system');
  // `model_writable: false`: это КЭШ вычисления, и строка обязана сказать об этом словом.
  expect(writeModeOf(def('orbis/current_value'))).toBe('computed');
  expect(writeModeOf(def('orbis/due_date'))).toBe('editable');
});

test('boolean — чекбокс, а не слово «true» в инпуте', () => {
  const onChange = vi.fn();
  renderWithProviders(
    <PropertyControl def={def('orbis/all_day')} value={true} onChange={onChange} />,
  );
  const box = screen.getByLabelText('Весь день');
  expect(box).toBeChecked();
  expect(box).toHaveAttribute('type', 'checkbox');
  // Снятие галочки пишет `false`, а не снимает свойство: у булева «пусто» не состояние,
  // и снятие как `unset` означало бы, что записать «нет» формой нельзя вовсе.
  fireEvent.click(box);
  expect(onChange).toHaveBeenCalledWith(false);
});

test('select показывает ПОДПИСЬ варианта, а не его ключ, и умеет снять значение', () => {
  const onChange = vi.fn();
  renderWithProviders(
    <PropertyControl def={def('orbis/task_status')} value="inbox" onChange={onChange} />,
  );
  const select = screen.getByLabelText('Состояние задачи');
  expect(select).toHaveDisplayValue('Входящие');
  // Ключ варианта на экране не печатается — его читает только сервер.
  expect(screen.queryByText('inbox')).toBeNull();

  fireEvent.change(select, { target: { value: 'done' } });
  expect(onChange).toHaveBeenLastCalledWith('done');
  // Пустой вариант — единственный способ СНЯТЬ значение из формы, и он даёт `undefined`,
  // а не пустую строку: `unset` и «записать пусто» — разные операции (§А1-1).
  fireEvent.change(select, { target: { value: '' } });
  expect(onChange).toHaveBeenLastCalledWith(undefined);
});

test('вариант, которого нет в словаре, остаётся выбранным (значение есть в данных, §А10-3)', () => {
  // Строку реестра могли снять, а значение на записи осталось. Без своей опции `select`
  // показал бы пустоту и первым же изменением молча переставил бы значение.
  renderWithProviders(
    <PropertyControl def={def('orbis/task_status')} value="ветхий" onChange={vi.fn()} />,
  );
  expect(screen.getByLabelText('Состояние задачи')).toHaveDisplayValue('ветхий');
});

test('select many — чипы, и порядок уезжает РЕЕСТРОВЫЙ, а не порядок нажатий', () => {
  const onChange = vi.fn();
  renderWithProviders(
    <PropertyControl def={def('orbis/routine_days')} value={['we']} onChange={onChange} />,
  );
  const group = screen.getByLabelText('Дни недели');
  expect(group.tagName).toBe('FIELDSET');
  expect(screen.getByRole('checkbox', { name: 'Ср' })).toBeChecked();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Пн' }));
  // Не ['we','mo']: расписание сверяется вхождением, и «Ср, Пн» читалось бы как расписание,
  // которого нет.
  expect(onChange).toHaveBeenLastCalledWith(['mo', 'we']);
});

test('select many: снятие последнего чипа СНИМАЕТ свойство, а не пишет пустой список', () => {
  // Разница видна на чтении: `has(свойство)` у пустого массива истинно, и рутина с
  // `allowed_tools: []` читалась бы как рутина со списком прав — пустым, но объявленным.
  const onChange = vi.fn();
  renderWithProviders(
    <PropertyControl def={def('orbis/routine_days')} value={['we']} onChange={onChange} />,
  );
  fireEvent.click(screen.getByRole('checkbox', { name: 'Ср' }));
  expect(onChange).toHaveBeenLastCalledWith(undefined);
});

test('текстовый контрол: пусто = СНЯТЬ свойство, а не «записать пусто»', () => {
  const onChange = vi.fn();
  renderWithProviders(
    <PropertyControl def={def('orbis/effort_min')} value={30} onChange={onChange} />,
  );
  const input = screen.getByLabelText('Трудоёмкость, мин');
  fireEvent.change(input, { target: { value: '' } });
  fireEvent.blur(input);
  expect(onChange).toHaveBeenLastCalledWith(undefined);
});

test('нечитаемое значение не уезжает и НЕ стирает поле', () => {
  // `undefined` уже занят снятием, и вернуть его на промахе по клавише значило бы стереть
  // поле у того, кто просто опечатался (`ControlParse`).
  //
  // Проба идёт по `decimal`, а НЕ по `number`: у числа контрол — `<input type="number">`, и
  // браузер (как и jsdom) чужой символ в него просто не пускает, обнуляя значение. Деньги
  // же набираются текстом (они строка на всём пути, Global Constraints), и нечитаемое сюда
  // доезжает по-настоящему.
  const onChange = vi.fn();
  renderWithProviders(
    <PropertyControl def={def('orbis/amount')} value="340.00" onChange={onChange} />,
  );
  const input = screen.getByLabelText('Сумма');
  fireEvent.change(input, { target: { value: '340,50 руб' } });
  fireEvent.blur(input);
  expect(onChange).not.toHaveBeenCalled();
  // Черновик остаётся на экране: владелец видит, что именно он набрал.
  expect(input).toHaveValue('340,50 руб');
});

test('разбор ввода: пусто → снять, число → число, decimal → СТРОКА с точкой', () => {
  expect(parseControlValue(def('orbis/waiting_for'), '   ')).toEqual({ kind: 'unset' });
  expect(parseControlValue(def('orbis/effort_min'), '45')).toEqual({ kind: 'value', value: 45 });
  expect(parseControlValue(def('orbis/effort_min'), '45х')).toEqual({ kind: 'invalid' });
  // Деньги не проходят через float ни на одном шаге: значение остаётся строкой.
  expect(parseControlValue(def('orbis/amount'), '340,50')).toEqual({
    kind: 'value',
    value: '340.50',
  });
  expect(parseControlValue(def('orbis/amount'), '340,50 руб')).toEqual({ kind: 'invalid' });
  // Ведущий «+» отвергается ЗДЕСЬ, а не сервером: паттерн контрола совпадает с
  // `DECIMAL_PATTERN` схемы значения, иначе «+500» уезжал бы на сервер и возвращался
  // `VALIDATION` — поле выглядело бы «не сохранилось».
  expect(parseControlValue(def('orbis/amount'), '+500')).toEqual({ kind: 'invalid' });
  // Минус законен (перерасход/возврат) — сужение не должно было задеть знак вообще.
  expect(parseControlValue(def('orbis/amount'), '-500')).toEqual({ kind: 'value', value: '-500' });
});

test('свойство, которое пишет только сервер, контрола не получает — и пометки «вычисляется» тоже', () => {
  renderWithProviders(
    <PropertyControl def={def('orbis/bank_txn_id')} value="tx-1" onChange={vi.fn()} />,
  );
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByTestId('prop-orbis/bank_txn_id')).toHaveTextContent('tx-1');
  // «вычисляется» о поле, которое пишет импорт, было бы неправдой: два флага — два разных
  // ответа владельцу на вопрос «почему я не могу это поправить».
  expect(screen.queryByText('вычисляется')).toBeNull();
});

test('кэш вычисления — только чтение И пометка словом', () => {
  renderWithProviders(
    <PropertyControl def={def('orbis/current_value')} value="150000.00" onChange={vi.fn()} />,
  );
  const row = screen.getByTestId('prop-orbis/current_value');
  expect(row).toHaveTextContent('150000.00');
  expect(row).toHaveTextContent('вычисляется');
  expect(screen.queryByRole('textbox')).toBeNull();
});

test('показ значения идёт по ТИПУ: подпись варианта, «да»/«нет», список через запятую', () => {
  expect(displayText(def('orbis/task_status'), 'in_progress')).toBe('В работе');
  expect(displayText(def('orbis/all_day'), true)).toBe('да');
  expect(displayText(def('orbis/all_day'), false)).toBe('нет');
  expect(displayText(def('orbis/aliases'), ['кофе', 'чай'])).toBe('кофе, чай');
  expect(displayText(def('orbis/aliases'), [])).toBe('—');
  // Свойства нет в снимке — показ по значению: о типе здесь не известно ничего.
  expect(displayText(undefined, ['a', 'b'])).toBe('a, b');
});

// ---------------------------------------------------------------------------
// Срез 1а §3.2: списки ссылок — «Шаблон для» (аспекты) и «Главнее, чем» (записи)
// ---------------------------------------------------------------------------

/** Реестр — встроенный (`registryReply`); чипы ссылок `entity.get` не роутятся — им хватает id. */
const withRegistry = (path: string) => registryReply(path) ?? {};

test('контрол списков ссылок: registry_ref аспектов many — чипы аспектов, ref many — только чтение', () => {
  expect(controlKindOf(def('orbis/template_for'))).toBe('aspects-many');
  // «Главнее, чем» правится только плашкой спора шаблонов (задача 14): одиночный пикер `RefField`
  // затёр бы список первым же выбором.
  expect(controlKindOf(def('orbis/template_wins_over'))).toBe('readonly');
  // Одиночный `ref` — по-прежнему пикер, одиночный `registry_ref` — по-прежнему показ.
  expect(controlKindOf(def('orbis/finance_category'))).toBe('ref');
  expect(controlKindOf(def('orbis/rule_scope'))).toBe('readonly');
});

test('«Шаблон для»: выбор второго аспекта шлёт МАССИВ id в порядке реестра', async () => {
  const onChange = vi.fn();
  renderWithProviders(
    <PropertyControl def={def('orbis/template_for')} value={['orbis/task']} onChange={onChange} />,
    withRegistry,
  );
  const group = await screen.findByLabelText('Шаблон для');
  expect(group).toHaveAttribute('data-kind', 'aspects-many');
  // Подпись аспекта, а не его id: владелец видит «Задача», а не «orbis/task».
  expect(await screen.findByRole('checkbox', { name: 'Задача' })).toBeChecked();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Расписание' }));
  // `orbis/schedule` — rank 1, `orbis/task` — rank 2: порядок реестра, а не нажатий.
  expect(onChange).toHaveBeenLastCalledWith(['orbis/schedule', 'orbis/task']);
});

test('выбранный аспект виден не только обводкой (Л-4): data-state и галочка у выбранного чипа', async () => {
  const onChange = vi.fn();
  renderWithProviders(
    <PropertyControl def={def('orbis/template_for')} value={['orbis/task']} onChange={onChange} />,
    withRegistry,
  );
  await screen.findByRole('checkbox', { name: 'Задача' });
  const on = screen.getByText('Задача').closest('label');
  const off = screen.getByText('Проект').closest('label');
  if (on === null || off === null) throw new Error('чип аспекта — не метка');
  expect(on).toHaveAttribute('data-state', 'on');
  expect(on.querySelector('[data-testid="chip-check"]')).not.toBeNull();
  expect(off).toHaveAttribute('data-state', 'off');
  expect(off.querySelector('[data-testid="chip-check"]')).toBeNull();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Проект' }));
  // `orbis/task` — rank 2, `orbis/project` — rank 9: порядок реестра.
  expect(onChange).toHaveBeenLastCalledWith(['orbis/task', 'orbis/project']);
});

test('«Шаблон для» при minItems: 1 — последний аспект снять нельзя, есть подсказка (РП-27)', async () => {
  const onChange = vi.fn();
  renderWithProviders(
    <PropertyControl def={def('orbis/template_for')} value={['orbis/task']} onChange={onChange} />,
    withRegistry,
  );
  const last = await screen.findByRole('checkbox', { name: 'Задача' });
  expect(last).toBeDisabled();
  fireEvent.click(last);
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByTestId('prop-orbis/template_for')).toHaveTextContent(
    'сделать черновиком: ⋯ → «Сделать шаблоном для…» → снять все',
  );
});

test('«Шаблон для» без значения — подсказки о пороге нет: свойства нет, первый чип его заводит', async () => {
  const onChange = vi.fn();
  renderWithProviders(
    <PropertyControl def={def('orbis/template_for')} value={undefined} onChange={onChange} />,
    withRegistry,
  );
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Проект' }));
  expect(onChange).toHaveBeenLastCalledWith(['orbis/project']);
  expect(screen.getByTestId('prop-orbis/template_for')).not.toHaveTextContent('черновиком');
});

test('список аспектов без minItems: снятие последнего СНИМАЕТ свойство (undefined), а не пишет []', async () => {
  const base = def('orbis/template_for');
  if (base.type.kind !== 'registry_ref') throw new Error('ожидался registry_ref');
  const { minItems: _drop, ...type } = base.type;
  const loose: PropertyDefinition = { ...base, type };
  const onChange = vi.fn();
  renderWithProviders(
    <PropertyControl def={loose} value={['orbis/task']} onChange={onChange} />,
    withRegistry,
  );
  const last = await screen.findByRole('checkbox', { name: 'Задача' });
  expect(last).not.toBeDisabled();
  fireEvent.click(last);
  expect(onChange).toHaveBeenLastCalledWith(undefined);
});

test('«Главнее, чем» рисуется только чтением: без пикера, по чипу на ссылку', () => {
  const a = '019d48ea-4188-765d-8e96-93a0ad9c262a';
  const b = '019d48ea-4188-765d-8e96-93a0ad9c262b';
  renderWithProviders(
    <PropertyControl def={def('orbis/template_wins_over')} value={[a, b]} onChange={vi.fn()} />,
    withRegistry,
  );
  const row = screen.getByTestId('prop-orbis/template_wins_over');
  expect(row).toHaveAttribute('data-kind', 'readonly');
  expect(screen.queryByRole('combobox')).toBeNull();
  // Ни одной строки JSON: каждая ссылка — свой чип `EntityRef` (пока грузится — скелет).
  expect(row).not.toHaveTextContent('[');
  expect(row.children.length).toBeGreaterThanOrEqual(2);
});

test('показ registry_ref аспектов — подписями, если читатель реестра дан; без него — id', () => {
  const labels: Record<string, string> = { 'orbis/project': 'Проект', 'orbis/task': 'Задача' };
  const lookup = { label: (id: string) => labels[id] ?? id };
  expect(displayText(def('orbis/template_for'), ['orbis/project', 'orbis/task'], lookup)).toBe(
    'Проект, Задача',
  );
  expect(displayText(def('orbis/template_for'), ['orbis/project'])).toBe('orbis/project');
});
