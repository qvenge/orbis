// Task C4b (03-budget §3.4): клиентский флоу импорта — выбор файла → маппинг →
// ревью → подтверждение → итог. Проверяется поведение, за которое отвечает экран:
// ни одна строка не теряется молча (⟳ не уходит в payload, ✓ без категории блокирует
// кнопку, нераспознанные строки видны), идемпотентность batchId (§7.8) и проходимость
// пути «AI недоступен» (§7.9).
import {
  type CsvMapping,
  type ImportConfirmItem,
  type ImportConfirmResult,
  type ImportReviewInput,
  type ImportReviewRow,
  MAX_IMPORT_ROWS,
} from '@orbis/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { useNav } from '../../state/navigation';
import { type MockHandler, renderWithProviders, trpcError } from '../../test/harness';
import { BudgetScreen } from '../budget/BudgetScreen';
import { ImportFlow } from './ImportFlow';

const C_FOOD = '00000000-0000-4000-8000-00000000c001';
const C_TAXI = '00000000-0000-4000-8000-00000000c002';
const E_DUP = '00000000-0000-4000-8000-00000000e009';

const FILE_NAME = 'выписка_май_01.05.2026.csv';
const NAMESPACE = 'csv:выписка-май';

const CSV = [
  'Дата;Контрагент;Сумма',
  '03.05.2026;ПЯТЁРОЧКА;-1890,00',
  '04.05.2026;YANDEX.TAXI;-420,00',
  '05.05.2026;ОБЕД;-340,00',
  '06.05.2026;NETFLIX;-599,00',
].join('\n');

const MAPPING: CsvMapping = {
  date: 0,
  counterparty: 1,
  direction: 'sign',
  amount: 2,
  dateFormat: 'DD.MM.YYYY',
};

// Статусы фикстуры ревью по индексу строки данных: ✓ с предложенной категорией,
// ✓ без категории, ⊘ дубль (с duplicateOf) и ⟳ уже импортированная.
const STATUSES: ImportReviewRow['status'][] = [
  'new',
  'new',
  'probable_duplicate',
  'already_imported',
];
const SUGGESTED: Array<string | undefined> = [C_FOOD, undefined, C_TAXI, undefined];

/** Ответ import.review — ЭХО присланных клиентом строк со статусами фикстуры. */
function reviewRows(input: unknown): ImportReviewRow[] {
  return (input as ImportReviewInput).rows.map((row, i) => ({
    ...row,
    externalId: `x${i}`,
    status: STATUSES[i] ?? 'new',
    ...(STATUSES[i] === 'probable_duplicate' && { duplicateOf: E_DUP }),
    ...(SUGGESTED[i] !== undefined && { suggestedCategoryRef: SUGGESTED[i] }),
  }));
}

const CONFIRM_RESULT: ImportConfirmResult = {
  actionId: '00000000-0000-4000-8000-00000000a001',
  idempotentReplay: false,
  created: 2,
  adopted: 1,
  skipped: 0,
  entityIds: ['00000000-0000-4000-8000-00000000f001', '00000000-0000-4000-8000-00000000f002'],
  unbudgeted: [{ categoryRef: C_FOOD, count: 2 }],
};

const category = (id: string, title: string, icon: string) => ({
  id,
  ownerId: 'u',
  title,
  emoji: null,
  body: '',
  bodyRefs: [],
  tags: [],
  meta: {},
  aspects: { 'orbis/category': { icon } },
  createdAt: 'x',
  updatedAt: 'y',
  archived: false,
});

const settings = {
  timezone: 'Europe/Moscow',
  defaultCurrency: 'RUB',
  weekStartDay: 1,
  installedViews: ['orbis-budget'],
  pinnedEntities: [],
};

/** Базовый мок-хендлер флоу; `over` подменяет ответы отдельных процедур. */
function handler(over: Partial<Record<string, MockHandler>> = {}): MockHandler {
  return (path, input) => {
    const custom = over[path];
    if (custom) return custom(path, input);
    if (path === 'user.getSettings') return settings;
    if (path === 'entity.query') {
      return [category(C_FOOD, 'Еда', '🍔'), category(C_TAXI, 'Транспорт', '🚕')];
    }
    if (path === 'import.analyze') return { mapping: MAPPING, confidence: 0.9 };
    if (path === 'import.review') return { rows: reviewRows(input) };
    if (path === 'import.confirm') return CONFIRM_RESULT;
    return {};
  };
}

function pickFile(text = CSV, name = FILE_NAME): void {
  const file = new File([text], name, { type: 'text/csv' });
  fireEvent.change(screen.getByTestId('import-file'), { target: { files: [file] } });
}

/**
 * Дойти от idle до таблицы ревью на дефолтном маппинге. Ожидание предложенной
 * категории в первой строке — заодно признак того, что список категорий доехал
 * (до него выпадашки пусты и выбор в них не применился бы).
 */
async function openReview(h: MockHandler = handler()) {
  const rendered = renderWithProviders(<ImportFlow />, h);
  pickFile();
  await waitFor(() => expect(screen.getByTestId('mapping-submit')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('mapping-submit'));
  await waitFor(() => expect(screen.getByTestId('review-counters')).toBeInTheDocument());
  await waitFor(() => expect(screen.getByLabelText('Категория «ПЯТЁРОЧКА»')).toHaveValue(C_FOOD));
  return rendered;
}

/** ✓-строка без предложения сервера — категория выбирается вручную (§3.4 [❓ выбрать]). */
function chooseTaxiCategory(): void {
  fireEvent.change(screen.getByLabelText('Категория «YANDEX.TAXI»'), {
    target: { value: C_TAXI },
  });
}

const confirmInputs = (calls: { path: string; input: unknown }[]) =>
  calls.filter((c) => c.path === 'import.confirm').map((c) => c.input as Record<string, unknown>);

const itemsOf = (input: Record<string, unknown>) => input.items as ImportConfirmItem[];

beforeEach(() => {
  localStorage.clear();
  useNav.setState({
    activeTab: 'chat',
    stacks: { chat: [], browser: [], agenda: [], budget: [] },
  });
});

// --- шаг 1: выбор файла, приватность, локальный разбор ---------------------------------

test('idle: файловый инпут и обещание §3.4 — файл разбирается локально, в AI только образцы', () => {
  renderWithProviders(<ImportFlow />, handler());
  expect(screen.getByTestId('import-file')).toBeInTheDocument();
  expect(screen.getByTestId('privacy-note')).toHaveTextContent(/локально|браузер/i);
  expect(screen.getByTestId('privacy-note')).toHaveTextContent(/образц/i);
});

test('в import.analyze уходят только образцы строк (≤5), не файл целиком', async () => {
  const { calls } = renderWithProviders(<ImportFlow />, handler());
  pickFile();
  await waitFor(() => expect(screen.getByTestId('mapping-submit')).toBeInTheDocument());
  const sample = calls.find((c) => c.path === 'import.analyze')?.input as { sampleRows: string[] };
  expect(sample.sampleRows.length).toBeLessThanOrEqual(5);
  expect(sample.sampleRows[0]).toBe('Дата;Контрагент;Сумма');
});

/** CSV из заголовка и n строк данных — фикстура граничных тестов потолка. */
function csvWithDataRows(n: number): string {
  const rows = ['Дата;Контрагент;Сумма'];
  for (let i = 0; i < n; i += 1) rows.push(`03.05.2026;ROW${i};-10,00`);
  return rows.join('\n');
}

test('потолок считает строки ДАННЫХ: ровно MAX_IMPORT_ROWS операций + заголовок проходят', async () => {
  const { calls } = renderWithProviders(<ImportFlow />, handler());
  pickFile(csvWithDataRows(MAX_IMPORT_ROWS));
  await waitFor(() => expect(screen.getByTestId('mapping-submit')).toBeInTheDocument());
  // граница совпадает с серверной: файл принят, ошибки нет, analyze ушёл
  expect(screen.queryByTestId('import-error')).toBeNull();
  expect(calls.some((c) => c.path === 'import.analyze')).toBe(true);
});

test('MAX_IMPORT_ROWS+1 строк данных → ошибка с их числом, ни одного запроса', async () => {
  const { calls } = renderWithProviders(<ImportFlow />, handler());
  pickFile(csvWithDataRows(MAX_IMPORT_ROWS + 1));
  await waitFor(() => expect(screen.getByTestId('import-error')).toBeInTheDocument());
  expect(screen.getByTestId('import-error')).toHaveTextContent(String(MAX_IMPORT_ROWS + 1));
  expect(screen.getByTestId('import-error')).toHaveTextContent(String(MAX_IMPORT_ROWS));
  expect(calls.filter((c) => c.path.startsWith('import.'))).toHaveLength(0);
});

test('точная граница на шаге сверки: фактический headerRows=0 даёт MAX+1 строку — запрос не уходит', async () => {
  // Колонки переставлены: под дефолтным маппингом первая строка не разбирается, ранняя
  // проверка считает её заголовком ((MAX+1)−1 = MAX) и пропускает файл; AI-маппинг разбирает
  // ВСЕ MAX+1 строку как данные (headerRows=0) — сверхлимитный import.review не отправляется.
  const rows: string[] = [];
  for (let i = 0; i <= MAX_IMPORT_ROWS; i += 1) rows.push(`ROW${i};03.05.2026;-10,00`);
  const { calls } = renderWithProviders(
    <ImportFlow />,
    handler({
      'import.analyze': () => ({
        mapping: { ...MAPPING, date: 1, counterparty: 0 },
        confidence: 0.9,
      }),
    }),
  );
  pickFile(rows.join('\n'));
  await waitFor(() => expect(screen.getByLabelText('Строк заголовка')).toHaveValue(0));
  fireEvent.click(screen.getByTestId('mapping-submit'));
  await waitFor(() => expect(screen.getByTestId('import-error')).toBeInTheDocument());
  expect(screen.getByTestId('import-error')).toHaveTextContent(String(MAX_IMPORT_ROWS + 1));
  expect(calls.some((c) => c.path === 'import.review')).toBe(false);
});

// --- шаг 2: форма маппинга, в том числе без AI (§7.9) ----------------------------------

test('analyze упал (LLM_UNAVAILABLE) → форма маппинга открыта, флоу проходим до конца', async () => {
  const { calls } = renderWithProviders(
    <ImportFlow />,
    handler({
      'import.analyze': () => {
        throw trpcError('SERVICE_UNAVAILABLE');
      },
    }),
  );
  pickFile();
  // Уведомление неблокирующее: та же форма с угаданным маппингом доступна сразу
  await waitFor(() => expect(screen.getByTestId('mapping-notice')).toBeInTheDocument());
  expect(screen.getByTestId('mapping-submit')).toBeInTheDocument();

  fireEvent.click(screen.getByTestId('mapping-submit'));
  await waitFor(() => expect(screen.getByTestId('review-counters')).toBeInTheDocument());
  await waitFor(() => expect(screen.getByLabelText('Категория «ПЯТЁРОЧКА»')).toHaveValue(C_FOOD));
  chooseTaxiCategory();
  fireEvent.click(screen.getByTestId('confirm-import'));
  await waitFor(() => expect(screen.getByTestId('import-result')).toBeInTheDocument());
  expect(confirmInputs(calls)).toHaveLength(1);
});

test('строки, не разобранные парсером, показаны отдельным блоком «не распознано»', async () => {
  const broken = [...CSV.split('\n'), '31.02.2026;БИТАЯ ДАТА;-100,00'].join('\n');
  renderWithProviders(<ImportFlow />, handler());
  pickFile(broken);
  await waitFor(() => expect(screen.getByTestId('mapping-submit')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('mapping-submit'));
  await waitFor(() => expect(screen.getByTestId('parse-errors')).toBeInTheDocument());
  expect(screen.getByTestId('parse-errors')).toHaveTextContent('1');
  expect(screen.getByTestId('parse-errors')).toHaveTextContent(/дат/i);
});

test('маппинг правится вручную: неверные колонки AI исправляются в форме', async () => {
  // AI перепутал местами контрагента и сумму — ни одна строка не разбирается
  const { calls } = renderWithProviders(
    <ImportFlow />,
    handler({
      'import.analyze': () => ({
        mapping: { ...MAPPING, counterparty: 2, amount: 1 },
        confidence: 0.4,
      }),
    }),
  );
  pickFile();
  await waitFor(() => expect(screen.getByTestId('mapping-submit')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('mapping-submit'));
  await waitFor(() => expect(screen.getByTestId('import-error')).toBeInTheDocument());
  expect(calls.some((c) => c.path === 'import.review')).toBe(false);

  fireEvent.change(screen.getByLabelText('Колонка контрагента'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('Колонка суммы'), { target: { value: '2' } });
  fireEvent.click(screen.getByTestId('mapping-submit'));
  await waitFor(() => expect(screen.getByTestId('review-counters')).toBeInTheDocument());
  const rows = (calls.find((c) => c.path === 'import.review')?.input as ImportReviewInput).rows;
  expect(rows[0]).toMatchObject({ counterparty: 'ПЯТЁРОЧКА', amount: '1890.00' });
});

test('файл без заголовка: авто-догадка даёт 0 строк заголовка, первая операция не теряется', async () => {
  const noHeader = CSV.split('\n').slice(1).join('\n');
  const { calls } = renderWithProviders(<ImportFlow />, handler());
  pickFile(noHeader);
  await waitFor(() => expect(screen.getByLabelText('Строк заголовка')).toHaveValue(0));
  fireEvent.click(screen.getByTestId('mapping-submit'));
  await waitFor(() => expect(screen.getByTestId('review-counters')).toBeInTheDocument());
  const rows = (calls.find((c) => c.path === 'import.review')?.input as ImportReviewInput).rows;
  expect(rows).toHaveLength(4);
  expect(rows[0]?.counterparty).toBe('ПЯТЁРОЧКА');
});

test('headerless + неверный AI-маппинг: правка колонок возвращает съеденную строку', async () => {
  // Сценарий молчаливой потери (финальное ревью C, находка A3): выписка БЕЗ заголовка,
  // AI перепутал колонки → строка 0 не разбирается → догадка даёт headerRows=1.
  // Пользователь чинит колонки; если догадку не пересчитать, первая операция уедет
  // в «заголовок» — её нет ни в rows, ни в блоке «не распознано».
  const noHeader = CSV.split('\n').slice(1).join('\n');
  const { calls } = renderWithProviders(
    <ImportFlow />,
    handler({
      'import.analyze': () => ({
        mapping: { ...MAPPING, counterparty: 2, amount: 1 },
        confidence: 0.3,
      }),
    }),
  );
  pickFile(noHeader);
  await waitFor(() => expect(screen.getByLabelText('Строк заголовка')).toHaveValue(1));

  fireEvent.change(screen.getByLabelText('Колонка контрагента'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('Колонка суммы'), { target: { value: '2' } });
  fireEvent.click(screen.getByTestId('mapping-submit'));
  await waitFor(() => expect(screen.getByTestId('review-counters')).toBeInTheDocument());

  const rows = (calls.find((c) => c.path === 'import.review')?.input as ImportReviewInput).rows;
  expect(rows).toHaveLength(4); // ни одна строка не съедена как заголовок
  expect(rows[0]?.counterparty).toBe('ПЯТЁРОЧКА');
  // догадка пересчитана: заголовок в шапке считает строки ДАННЫХ (4 из 4 записей файла)
  expect(screen.getByRole('heading')).toHaveTextContent('· 4 строк');
});

test('ручной ввод «строк заголовка» догадка не перебивает', async () => {
  // Обратная сторона A3: если пользователь сам поставил число, пересчёт молчит —
  // выписка с двухстрочной шапкой не должна «чиниться» обратно на 1.
  // Шапка тоже с разделителями — иначе detectDelimiter (минимум полей по выборке)
  // принял бы файл за одноколоночный и разбор упал бы ещё до маппинга
  const twoLineHeader = ['Выписка по счёту;за май;2026', ...CSV.split('\n')].join('\n');
  const { calls } = renderWithProviders(<ImportFlow />, handler());
  pickFile(twoLineHeader);
  await waitFor(() => expect(screen.getByLabelText('Строк заголовка')).toHaveValue(1));
  fireEvent.change(screen.getByLabelText('Строк заголовка'), { target: { value: '2' } });
  fireEvent.click(screen.getByTestId('mapping-submit'));
  await waitFor(() => expect(screen.getByTestId('review-counters')).toBeInTheDocument());

  const rows = (calls.find((c) => c.path === 'import.review')?.input as ImportReviewInput).rows;
  expect(rows).toHaveLength(4); // ровно данные: обе строки шапки отрезаны, пересчёта не было
  expect(rows[0]?.counterparty).toBe('ПЯТЁРОЧКА');
  // 6 записей файла − 2 строки заголовка: ручное число сохранилось
  expect(screen.getByRole('heading')).toHaveTextContent('· 4 строк');
});

test('raw в строках сверки склеен фактическим разделителем файла («,»), а не «;»', async () => {
  const commaCsv = ['Дата,Контрагент,Сумма', '03.05.2026,ПЯТЁРОЧКА,"-1890,00"'].join('\n');
  const { calls } = renderWithProviders(<ImportFlow />, handler());
  pickFile(commaCsv);
  await waitFor(() => expect(screen.getByTestId('mapping-submit')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('mapping-submit'));
  await waitFor(() => expect(screen.getByTestId('review-counters')).toBeInTheDocument());
  const rows = (calls.find((c) => c.path === 'import.review')?.input as ImportReviewInput).rows;
  expect(rows[0]?.raw).toBe('03.05.2026,ПЯТЁРОЧКА,-1890,00');
});

// --- шаг 3: таблица ревью ---------------------------------------------------------------

test('фикстура со всеми тремя статусами → счётчики и строки отрисованы', async () => {
  const { calls } = await openReview();

  // namespace нормализован клиентом из имени файла, хэш — sha256 байтов
  const reviewInput = calls.find((c) => c.path === 'import.review')?.input as ImportReviewInput;
  expect(reviewInput.namespace).toBe(NAMESPACE);
  expect(reviewInput.fileHash).toMatch(/^[0-9a-f]{64}$/);
  expect(reviewInput.rows).toHaveLength(4); // строка заголовка отрезана

  expect(screen.getByTestId('review-counters')).toHaveTextContent('новых 2');
  expect(screen.getByTestId('review-counters')).toHaveTextContent('дубли 1');
  expect(screen.getByTestId('review-counters')).toHaveTextContent('уже 1');

  const rows = screen.getAllByTestId('review-row');
  expect(rows).toHaveLength(4);
  expect(rows[0]).toHaveTextContent('ПЯТЁРОЧКА');
  expect(rows[0]).toHaveTextContent('−1 890');
  expect(rows[2]).toHaveAttribute('data-status', 'probable_duplicate');
  expect(rows[3]).toHaveAttribute('data-status', 'already_imported');
  expect(rows[3]).toHaveTextContent(/уже импортирован/i);
  // Статус объявлен словами (§3.4 шаг 3), а не только глифом с title: sr-only-текст
  expect(within(rows[0] as HTMLElement).getByText('новая')).toBeInTheDocument();
  expect(within(rows[2] as HTMLElement).getByText('вероятный дубль')).toBeInTheDocument();
  // у ⟳ слова встречаются дважды: sr-only статус + видимая подпись вместо выпадашки
  expect(within(rows[3] as HTMLElement).getAllByText('уже импортирована')).toHaveLength(2);
});

test('[Подтвердить N] шлёт только create/adopt: ⟳-строка в payload не попадает', async () => {
  const { calls } = await openReview();
  // ✓ без предложенной категории — выбираем вручную
  chooseTaxiCategory();

  expect(screen.getByTestId('confirm-import')).toHaveTextContent('Подтвердить 3');
  fireEvent.click(screen.getByTestId('confirm-import'));
  await waitFor(() => expect(confirmInputs(calls)).toHaveLength(1));

  const input = confirmInputs(calls)[0] as Record<string, unknown>;
  expect(input.namespace).toBe(NAMESPACE);
  const items = itemsOf(input);
  expect(items).toHaveLength(3);
  expect(items.map((i) => i.action)).toEqual(['create', 'create', 'adopt']);
  expect(items.map((i) => i.row.rowIndex)).toEqual([0, 1, 2]); // ⟳ (rowIndex 3) не ушла
  expect(items[0]).toMatchObject({ categoryRef: C_FOOD });
  expect(items[1]).toMatchObject({ categoryRef: C_TAXI });
  expect(items[2]).toMatchObject({ adoptEntityId: E_DUP });
  // Каноническая строка идёт без служебных полей ревью (canonicalRowSchema — strict)
  expect(items[0]?.row).not.toHaveProperty('status');
  expect(items[0]?.row).not.toHaveProperty('externalId');
});

test('✓-строка без категории блокирует [Подтвердить] и видна счётчиком ожидания', async () => {
  await openReview();
  expect(screen.getByTestId('confirm-import')).toBeDisabled();
  expect(screen.getByTestId('needs-category')).toHaveTextContent('1');

  chooseTaxiCategory();
  expect(screen.getByTestId('confirm-import')).toBeEnabled();
  expect(screen.queryByTestId('needs-category')).toBeNull();
});

// Подтверждение всегда падает: экран остаётся на ревью, и можно сравнить payload
// нескольких сабмитов подряд (успех закрыл бы таблицу итог-карточкой).
const alwaysFailingConfirm = (): MockHandler =>
  handler({
    'import.confirm': () => {
      throw trpcError('INTERNAL_SERVER_ERROR');
    },
  });

test('⊘ по умолчанию adopt; «создать всё равно» → create; [Снять все дубли] возвращает', async () => {
  const { calls } = await openReview(alwaysFailingConfirm());
  chooseTaxiCategory();

  fireEvent.click(screen.getByRole('button', { name: /создать всё равно/i }));
  expect(screen.getByTestId('confirm-import')).toHaveTextContent('Подтвердить 3');
  fireEvent.click(screen.getByTestId('confirm-import'));
  await waitFor(() => expect(confirmInputs(calls)).toHaveLength(1));
  const toggled = itemsOf(confirmInputs(calls)[0] as Record<string, unknown>);
  expect(toggled.map((i) => i.action)).toEqual(['create', 'create', 'create']);
  expect(toggled[2]).toMatchObject({ categoryRef: C_TAXI }); // предложение сервера

  // [Снять все дубли] возвращает ВСЮ группу ⊘ к дефолту adopt
  fireEvent.click(screen.getByRole('button', { name: /снять все дубли/i }));
  fireEvent.click(screen.getByTestId('confirm-import'));
  await waitFor(() => expect(confirmInputs(calls)).toHaveLength(2));
  const reset = itemsOf(confirmInputs(calls)[1] as Record<string, unknown>);
  expect(reset.map((i) => i.action)).toEqual(['create', 'create', 'adopt']);
});

test('⟳ не попадает в payload ни при каких переключениях соседних строк', async () => {
  const { calls } = await openReview(alwaysFailingConfirm());
  chooseTaxiCategory();
  fireEvent.click(screen.getByRole('button', { name: /создать всё равно/i }));
  fireEvent.click(screen.getByRole('button', { name: /снять все дубли/i }));
  fireEvent.click(screen.getByTestId('confirm-import'));
  await waitFor(() => expect(confirmInputs(calls)).toHaveLength(1));
  const items = itemsOf(confirmInputs(calls)[0] as Record<string, unknown>);
  expect(items.some((i) => i.row.rowIndex === 3)).toBe(false);
});

test('⟳-строка не переключается: у неё нет ни выпадашки категории, ни кнопок', async () => {
  await openReview();
  const already = screen.getAllByTestId('review-row')[3] as HTMLElement;
  expect(within(already).queryByRole('combobox')).toBeNull();
  expect(within(already).queryByRole('button')).toBeNull();
});

// --- шаг 4: идемпотентность подтверждения (§7.8) ----------------------------------------

test('повтор после ошибки — тот же batchId; после CONFLICT — новый', async () => {
  let attempt = 0;
  const { calls } = await openReview(
    handler({
      'import.confirm': () => {
        attempt += 1;
        throw trpcError(attempt === 2 ? 'CONFLICT' : 'INTERNAL_SERVER_ERROR');
      },
    }),
  );
  chooseTaxiCategory();

  fireEvent.click(screen.getByTestId('confirm-import'));
  await waitFor(() => expect(screen.getByTestId('import-error')).toBeInTheDocument());
  // Сырой err.message в интерфейс не выводится — только человеческий текст
  expect(screen.getByTestId('import-error')).not.toHaveTextContent('INTERNAL_SERVER_ERROR');

  fireEvent.click(screen.getByTestId('confirm-import')); // ответ — CONFLICT
  await waitFor(() => expect(confirmInputs(calls)).toHaveLength(2));
  // CONFLICT никогда не выдаётся за успех: итог-карточки нет, ошибка на месте
  expect(screen.queryByTestId('import-result')).toBeNull();
  expect(screen.getByTestId('import-error')).toBeInTheDocument();

  fireEvent.click(screen.getByTestId('confirm-import'));
  await waitFor(() => expect(confirmInputs(calls)).toHaveLength(3));

  const ids = confirmInputs(calls).map((i) => i.batchId as string);
  expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/i); // UUIDv7
  expect(ids[1]).toBe(ids[0]); // честный повтор после сбоя — тот же batch (§7.8)
  expect(ids[2]).not.toBe(ids[0]); // CONFLICT: id непригоден, берём свежий
});

// --- шаг 5: итог-карточка ---------------------------------------------------------------

test('итог: «Импортировано N, пропущено M», блок «Без конверта» со ссылкой на категорию', async () => {
  await openReview();
  chooseTaxiCategory();
  fireEvent.click(screen.getByTestId('confirm-import'));

  await waitFor(() => expect(screen.getByTestId('import-result')).toBeInTheDocument());
  const result = screen.getByTestId('import-result');
  expect(result).toHaveTextContent('Импортировано 2');
  // пропущено = усыновлённые дубли (1) + уже импортированные строки ревью (1)
  expect(result).toHaveTextContent('пропущено 2');
  expect(result).toHaveTextContent('дублей: 1');
  expect(result).toHaveTextContent('повторов: 1');

  expect(screen.getByTestId('import-unbudgeted')).toHaveTextContent('Еда');
  fireEvent.click(screen.getByRole('button', { name: /Еда/ }));
  expect(useNav.getState().stacks.chat.at(-1)).toEqual({
    kind: 'budget-category',
    id: C_FOOD,
  });
});

// D6c п.4 (смоук D6b): кнопка делала pop(activeTab) и возвращала на предыдущий экран
// стека — в смоуке это был detail транзакции, открытый до импорта.
test('«К бюджету» открывает вкладку Budget с Overview, а не предыдущий экран стека', async () => {
  useNav.setState({
    activeTab: 'chat',
    stacks: {
      chat: [{ kind: 'entity', id: 'e-open-before' }, { kind: 'budget-import' }],
      browser: [],
      agenda: [],
      budget: [{ kind: 'budget-transactions' }],
    },
  });
  await openReview();
  chooseTaxiCategory();
  fireEvent.click(screen.getByTestId('confirm-import'));
  await waitFor(() => expect(screen.getByTestId('import-result')).toBeInTheDocument());

  fireEvent.click(screen.getByRole('button', { name: 'К бюджету' }));
  const nav = useNav.getState();
  expect(nav.activeTab).toBe('budget');
  // Overview — корень вкладки: поверх него не должно остаться ни transactions, ни импорта
  expect(nav.stacks.budget).toEqual([]);
  // Экран импорта снят и со стека, откуда его открыли
  expect(nav.stacks.chat).toEqual([{ kind: 'entity', id: 'e-open-before' }]);
});

// --- точка входа с Overview -------------------------------------------------------------

test('иконка-кнопка в шапке Overview пушит экран импорта', async () => {
  useNav.setState({
    activeTab: 'budget',
    stacks: { chat: [], browser: [], agenda: [], budget: [] },
  });
  renderWithProviders(
    <BudgetScreen />,
    handler({
      'budget.overview': () => ({
        period: { start: '2026-07-01', end: '2026-07-31' },
        balance: { income: '0.00', expense: '0.00', balance: '0.00' },
        envelopes: [],
        comingUp: [],
        planned: [],
        unbudgeted: [],
        alertCount: 0,
      }),
      'budget.postDue': () => ({ posted: 0 }),
      'budget.rolloverPreview': () => ({ month: '2026-07', rows: [], needsSetup: false }),
    }),
  );
  await waitFor(() => expect(screen.getByTestId('open-import')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('open-import'));
  expect(useNav.getState().stacks.budget.at(-1)).toEqual({ kind: 'budget-import' });
});

// Валюта выписки (уборочная фаза, E11): свойство ФАЙЛА, а не строки — селектор стоит
// на шаге маппинга, дефолт берётся из настроек владельца, значение уходит в confirm.
// До этого выписка в чужой валюте молча ложилась в валюту владельца.
test('валюта выписки: дефолт — валюта владельца, значение уходит в import.confirm', async () => {
  const { calls } = await openReview();
  chooseTaxiCategory();
  fireEvent.click(screen.getByTestId('confirm-import'));
  await waitFor(() => expect(confirmInputs(calls)).toHaveLength(1));
  expect((confirmInputs(calls)[0] as Record<string, unknown>).currency).toBe('RUB');
});

test('валюта выписки: выбранное значение уходит в import.confirm', async () => {
  const { calls } = renderWithProviders(<ImportFlow />, handler());
  pickFile();
  await waitFor(() => expect(screen.getByTestId('mapping-submit')).toBeInTheDocument());
  expect(screen.getByLabelText('Валюта выписки')).toHaveValue('RUB');
  fireEvent.change(screen.getByLabelText('Валюта выписки'), { target: { value: 'USD' } });

  fireEvent.click(screen.getByTestId('mapping-submit'));
  await waitFor(() => expect(screen.getByTestId('review-counters')).toBeInTheDocument());
  await waitFor(() => expect(screen.getByLabelText('Категория «ПЯТЁРОЧКА»')).toHaveValue(C_FOOD));
  chooseTaxiCategory();
  fireEvent.click(screen.getByTestId('confirm-import'));
  await waitFor(() => expect(confirmInputs(calls)).toHaveLength(1));
  expect((confirmInputs(calls)[0] as Record<string, unknown>).currency).toBe('USD');
});
