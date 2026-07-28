// Task C4b, клиентский флоу импорта CSV (03-budget §3.4): state-машина
// idle → parsing → mapping → reviewing → review_ready → confirming → done, плюс
// ошибка на каждом шаге с возвратом на предыдущее состояние.
//
// Приватность (§3.4 шаг 1) — свойство, а не формулировка: файл читается через
// file.arrayBuffer() и разбирается модулем csv-parse ЗДЕСЬ, в браузере; на сервер
// уходят только канонические строки, sha256 байтов и до пяти строк-образцов для
// распознавания структуры. Ни один путь этого файла не отправляет файл целиком.
//
// Форма маппинга равноправна с AI, а не запасная: отказ import.analyze (в т.ч. 503
// LLM_UNAVAILABLE, §7.9) даёт неблокирующее уведомление и ту же форму с угаданным
// маппингом — флоу проходим целиком без единого ответа модели.
//
// batchId — client-UUIDv7 ОДИН на сессию экрана (урок B4/B6): повтор после ошибки шлёт
// тот же id (идемпотентность §7.8), а CONFLICT значит, что id занят чужой записью —
// это честная ошибка с перегенерацией id, а НЕ успех.
import {
  type CsvMapping,
  type ImportConfirmItem,
  type ImportConfirmResult,
  type ImportReviewRow,
  MAX_IMPORT_ROWS,
  newId,
} from '@orbis/shared';
import { TRPCClientError } from '@trpc/client';
import { useState } from 'react';
import { ScreenHeader } from '../../app/ScreenHeader';
import { openBudgetOverview, useNav } from '../../state/navigation';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Input } from '../../ui/Input';
import { Spinner } from '../../ui/Spinner';
import { CATEGORIES_QUERY, toOption } from '../budget/categories';
import { invalidateBudget } from '../budget/useBudget';
import {
  decodeCsvBytes,
  detectDelimiter,
  fileHashHex,
  parseCsv,
  toCanonicalRows,
} from './csv-parse';
import { csvNamespace } from './namespace';
import { ReviewTable } from './ReviewTable';

type Step = 'idle' | 'parsing' | 'mapping' | 'reviewing' | 'review_ready' | 'confirming' | 'done';

/** Разобранный локально файл: дальше сервер видит только строки, хэш и образцы. */
type ParsedFile = {
  name: string;
  namespace: string;
  fileHash: string;
  records: string[][];
  sampleRows: string[];
  /** Фактический разделитель файла — им же склеивается display-поле raw (не ';'-константой). */
  delimiter: ',' | ';' | '\t';
};

/**
 * Черновик формы маппинга. Индексы всех трёх денежных колонок держатся одновременно,
 * чтобы переключение режима знака не стирало уже выбранное; в CsvMapping уезжают
 * только относящиеся к выбранному режиму (toMapping).
 */
type MappingDraft = {
  date: number;
  counterparty: number;
  direction: CsvMapping['direction'];
  amount: number;
  debit: number;
  credit: number;
  dateFormat: CsvMapping['dateFormat'];
  bankTxnId: number | null;
  headerRows: number;
  /**
   * Пользователь правил поле «строк заголовка» руками. Пока НЕ правил, догадка
   * пересчитывается по актуальному маппингу (runReview): первая догадка считалась по
   * возможно неверному AI-маппингу, и без пересчёта headerless-выписка потеряла бы
   * первую операцию МОЛЧА — она не попала бы даже в блок «не распознано» (§3.4).
   */
  headerRowsTouched: boolean;
};

const DATE_FORMATS: CsvMapping['dateFormat'][] = [
  'DD.MM.YYYY',
  'YYYY-MM-DD',
  'DD/MM/YYYY',
  'MM/DD/YYYY',
];

const FIELD_CLS =
  'rounded-control border border-line bg-surface px-2 py-1.5 text-sm text-text transition focus-visible:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40';

/**
 * Валюты выписки в селекторе шага маппинга. Список короткий и захардкожен намеренно:
 * справочника валют в системе нет (multi-currency — Future, 00-product §10), а ввод
 * произвольного кода руками дал бы опечатку в аспекте каждой строки импорта. Валюта
 * владельца добавляется к списку сама, даже если её здесь нет.
 */
const STATEMENT_CURRENCY_CHOICES = ['RUB', 'USD', 'EUR', 'KZT', 'GEL', 'TRY'] as const;

/** Список выбора с гарантированным присутствием текущего значения (валюты владельца). */
function currencyChoices(current: string): string[] {
  return STATEMENT_CURRENCY_CHOICES.includes(current as (typeof STATEMENT_CURRENCY_CHOICES)[number])
    ? [...STATEMENT_CURRENCY_CHOICES]
    : [current, ...STATEMENT_CURRENCY_CHOICES];
}

/** Образцов в analyze (план C4). Серверный потолок MAX_ANALYZE_SAMPLE_ROWS выше (10) —
 *  пяти строк хватает на распознавание структуры, а в промпт уходит меньше выписки. */
const MAX_SAMPLE_ROWS = 5;

/** Образцы для analyze — первые непустые строки файла как есть (§3.4 шаг 1). */
function sampleLines(text: string): string[] {
  return text
    .split(/\r\n|\r|\n/)
    .filter((line) => line.trim() !== '')
    .slice(0, MAX_SAMPLE_ROWS);
}

function columnCount(records: string[][]): number {
  return records.slice(0, MAX_SAMPLE_ROWS).reduce((max, row) => Math.max(max, row.length), 0);
}

function toMapping(draft: Omit<MappingDraft, 'headerRows' | 'headerRowsTouched'>): CsvMapping {
  const base = {
    date: draft.date,
    counterparty: draft.counterparty,
    dateFormat: draft.dateFormat,
    ...(draft.bankTxnId === null ? {} : { bankTxnId: draft.bankTxnId }),
  };
  return draft.direction === 'sign'
    ? { ...base, direction: 'sign', amount: draft.amount }
    : { ...base, direction: 'separate_columns', debit: draft.debit, credit: draft.credit };
}

/**
 * Число строк заголовка: первая строка, которая не разбирается как данные, и есть
 * заголовок (§3.4 шаг 2 — по умолчанию 1). Проверка идёт тем же toCanonicalRows, что
 * и весь импорт: второго разборщика дат/сумм в проекте нет и заводить его нельзя.
 */
function guessHeaderRows(records: string[][], mapping: CsvMapping): number {
  const first = records[0];
  if (first === undefined) return 0;
  return toCanonicalRows([first], mapping).rows.length === 0 ? 1 : 0;
}

/** Черновик из ответа AI или, когда его нет, из типовой раскладки выписки. */
function draftFrom(
  mapping: CsvMapping | null,
  columns: number,
): Omit<MappingDraft, 'headerRows' | 'headerRowsTouched'> {
  const last = Math.max(columns - 1, 0);
  const clamp = (index: number): number => Math.min(index, last);
  return {
    date: clamp(mapping?.date ?? 0),
    counterparty: clamp(mapping?.counterparty ?? 1),
    direction: mapping?.direction ?? 'sign',
    amount: clamp(mapping?.amount ?? 2),
    debit: clamp(mapping?.debit ?? 2),
    credit: clamp(mapping?.credit ?? 3),
    dateFormat: mapping?.dateFormat ?? 'DD.MM.YYYY',
    bankTxnId: mapping?.bankTxnId ?? null,
  };
}

/**
 * Человеческий текст ошибки по КОДУ (§6 брифа): сырой err.message в интерфейс не
 * выводится — он писан для разработчика и на проде утекал бы внутренностями.
 */
function errorText(err: unknown, fallback: string): string {
  const code = err instanceof TRPCClientError ? (err.data?.code as string | undefined) : undefined;
  if (code === 'SERVICE_UNAVAILABLE') return 'AI недоступен — укажите колонки вручную';
  if (code === 'TOO_MANY_REQUESTS') return 'Импорт CSV недоступен на текущем плане';
  if (code === 'BAD_REQUEST' || code === 'UNPROCESSABLE_CONTENT') {
    return 'Сервер отклонил строки импорта — проверьте колонки и формат даты';
  }
  if (code === 'NOT_FOUND') return 'Совпавшая запись больше не существует — обновите ревью';
  return fallback;
}

export function ImportFlow() {
  const [step, setStep] = useState<Step>('idle');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [draft, setDraft] = useState<MappingDraft | null>(null);
  const [reviewRows, setReviewRows] = useState<ImportReviewRow[]>([]);
  const [parseErrors, setParseErrors] = useState<Array<{ rowIndex: number; reason: string }>>([]);
  const [result, setResult] = useState<ImportConfirmResult | null>(null);
  // Один UUIDv7 на сессию экрана; новый — только после CONFLICT (§7.8)
  const [batchId, setBatchId] = useState(newId);
  // Валюта ВЫПИСКИ (уборочная фаза, решение 6) — свойство файла, не строки: у выписки
  // одна валюта, и владелец подтверждает её на шаге маппинга. null — пользователь ещё
  // не выбирал: тогда действует валюта владельца из настроек (и она же — дефолт селектора).
  const [currency, setCurrency] = useState<string | null>(null);
  const settings = trpc.user.getSettings.useQuery();
  const ownCurrency = settings.data?.defaultCurrency ?? 'RUB';

  const utils = trpc.useUtils();
  const analyze = trpc.import.analyze.useMutation();
  const review = trpc.import.review.useMutation();
  const confirm = trpc.import.confirm.useMutation();

  async function onPickFile(file: File): Promise<void> {
    setStep('parsing');
    setError(null);
    setNotice(null);
    setParsed(null);
    setReviewRows([]);
    setParseErrors([]);

    let parsedFile: ParsedFile;
    try {
      const bytes = await file.arrayBuffer();
      const { text } = decodeCsvBytes(bytes);
      const delimiter = detectDelimiter(text);
      const records = parseCsv(text, delimiter);
      if (records.length === 0) {
        setError('Файл пуст или не похож на CSV');
        setStep('idle');
        return;
      }
      // Потолок считает строки ДАННЫХ (граница сервера — число строк import.review):
      // заголовок исключается той же догадкой guessHeaderRows, что и форма шага 2, —
      // ровно MAX_IMPORT_ROWS операций плюс заголовок проходят, как прошли бы и на
      // сервере (число берётся из константы, а не дублируется здесь). Проверка идёт
      // ДО единственного запроса шага 2 — файл сверх лимита не порождает вообще
      // никакого трафика; точная граница по фактическому headerRows — в runReview.
      const headerGuess = guessHeaderRows(
        records,
        toMapping(draftFrom(null, columnCount(records))),
      );
      const dataRowCount = records.length - headerGuess;
      if (dataRowCount > MAX_IMPORT_ROWS) {
        setError(
          `В файле ${dataRowCount} строк данных — за один импорт принимается не более ${MAX_IMPORT_ROWS}. Разбейте выписку на части.`,
        );
        setStep('idle');
        return;
      }
      parsedFile = {
        name: file.name,
        namespace: csvNamespace(file.name),
        fileHash: await fileHashHex(bytes),
        records,
        sampleRows: sampleLines(text),
        delimiter,
      };
    } catch {
      setError('Не удалось прочитать файл — выберите CSV-выписку');
      setStep('idle');
      return;
    }

    // Шаг 2: единственный LLM-вызов флоу. Его отказ — не тупик: та же форма открывается
    // с угаданным маппингом (§7.9), поэтому ошибка идёт в notice, а не в error.
    let mapping: CsvMapping | null = null;
    try {
      mapping = (await analyze.mutateAsync({ sampleRows: parsedFile.sampleRows })).mapping;
    } catch (err) {
      setNotice(errorText(err, 'AI не разобрал структуру файла — проверьте колонки сами'));
    }
    const base = draftFrom(mapping, columnCount(parsedFile.records));
    setParsed(parsedFile);
    setDraft({
      ...base,
      headerRows: guessHeaderRows(parsedFile.records, toMapping(base)),
      headerRowsTouched: false,
    });
    setStep('mapping');
  }

  async function runReview(): Promise<void> {
    if (parsed === null || draft === null) return;
    const mapping = toMapping(draft);
    // Догадка о заголовке пересчитывается по АКТУАЛЬНОМУ маппингу — иначе правка колонок
    // не отменяла бы догадку, сделанную по неверному стартовому маппингу, и первая
    // операция headerless-выписки была бы съедена как заголовок молча (§3.4: ни одна
    // строка не теряется без следа). Ручной ввод пользователя не трогаем.
    const headerRows = draft.headerRowsTouched
      ? draft.headerRows
      : guessHeaderRows(parsed.records, mapping);
    if (headerRows !== draft.headerRows) setDraft({ ...draft, headerRows });
    const { rows, errors } = toCanonicalRows(
      parsed.records.slice(headerRows),
      mapping,
      parsed.delimiter,
    );
    setParseErrors(errors);
    if (rows.length === 0) {
      setError(
        'Ни одна строка не разобрана — проверьте колонки, формат даты и число строк заголовка',
      );
      return;
    }
    // Точная граница сервера — число строк в import.review: здесь headerRows уже
    // фактический (ранняя проверка шла по догадке), сверхлимитный запрос не уходит вовсе.
    if (rows.length > MAX_IMPORT_ROWS) {
      setError(
        `Строк данных ${rows.length} — за один импорт принимается не более ${MAX_IMPORT_ROWS}. Разбейте выписку на части.`,
      );
      return;
    }
    setStep('reviewing');
    setError(null);
    try {
      const r = await review.mutateAsync({
        rows,
        fileHash: parsed.fileHash,
        namespace: parsed.namespace,
      });
      setReviewRows(r.rows);
      setStep('review_ready');
    } catch (err) {
      setError(errorText(err, 'Не удалось сверить строки — попробуйте ещё раз'));
      setStep('mapping'); // возврат на предыдущее состояние: маппинг правится и повторяется
    }
  }

  async function runConfirm(items: ImportConfirmItem[]): Promise<void> {
    if (parsed === null || items.length === 0) return;
    setStep('confirming');
    setError(null);
    let confirmed: ImportConfirmResult;
    try {
      confirmed = await confirm.mutateAsync({
        batchId,
        namespace: parsed.namespace,
        fileHash: parsed.fileHash,
        items,
        currency: currency ?? ownCurrency,
      });
    } catch (err) {
      if (err instanceof TRPCClientError && err.data?.code === 'CONFLICT') {
        // id занят чужой записью: успех не фабрикуем, следующая попытка — со свежим id
        setBatchId(newId());
        setError('Не удалось подтвердить импорт — попробуйте ещё раз');
      } else {
        // Транспорт/валидация: batchId сохранён — повтор идёт тем же id (§7.8)
        setError(errorText(err, 'Не удалось подтвердить импорт — попробуйте ещё раз'));
      }
      setStep('review_ready');
      return;
    }
    await invalidateBudget(utils);
    void utils.entity.query.invalidate();
    setResult(confirmed);
    setStep('done');
  }

  // Заголовок макета §3.4: «Импорт · выписка_май.csv · 47 строк» — строк ДАННЫХ,
  // без заголовочных (их число выбирается на шаге маппинга).
  const dataRows = parsed === null ? 0 : parsed.records.length - (draft?.headerRows ?? 0);
  const title = parsed === null ? 'Импорт CSV' : `Импорт · ${parsed.name} · ${dataRows} строк`;

  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title={title} />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
        {step === 'idle' && <FilePicker onPick={(f) => void onPickFile(f)} />}
        {step === 'parsing' && <Waiting label="Разбираем файл" />}
        {(step === 'mapping' || step === 'reviewing') && draft !== null && parsed !== null && (
          <MappingForm
            draft={draft}
            currency={currency ?? ownCurrency}
            onCurrencyChange={setCurrency}
            notice={notice}
            columns={columnCount(parsed.records)}
            header={parsed.records[0] ?? []}
            pending={step === 'reviewing'}
            onChange={setDraft}
            onSubmit={() => void runReview()}
          />
        )}
        {(step === 'review_ready' || step === 'confirming') && (
          <>
            <ParseErrors errors={parseErrors} headerRows={draft?.headerRows ?? 0} />
            <ReviewTable
              rows={reviewRows}
              pending={step === 'confirming'}
              onConfirm={(items) => void runConfirm(items)}
            />
          </>
        )}
        {step === 'done' && result !== null && (
          <ResultCard result={result} alreadyImported={countAlready(reviewRows)} />
        )}
        {error !== null && (
          <p data-testid="import-error" className="text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function countAlready(rows: ImportReviewRow[]): number {
  return rows.filter((r) => r.status === 'already_imported').length;
}

// --- шаг 1: выбор файла ------------------------------------------------------------------

function FilePicker({ onPick }: { onPick: (file: File) => void }) {
  return (
    <Card className="flex flex-col gap-3">
      <Input
        type="file"
        accept=".csv,text/csv"
        aria-label="Файл выписки"
        data-testid="import-file"
        className="text-sm"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onPick(file);
        }}
      />
      <p data-testid="privacy-note" className="text-xs text-text-secondary">
        Файл разбирается локально, прямо в браузере, и целиком никуда не отправляется. В AI уходят
        только несколько строк-образцов — чтобы распознать колонки.
      </p>
    </Card>
  );
}

function Waiting({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-text-secondary">
      <Spinner size={14} aria-label={label} />
      {label}…
    </div>
  );
}

// --- шаг 2: подтверждение маппинга (работает и без AI) -----------------------------------

function MappingForm({
  draft,
  currency,
  onCurrencyChange,
  notice,
  columns,
  header,
  pending,
  onChange,
  onSubmit,
}: {
  draft: MappingDraft;
  currency: string;
  onCurrencyChange: (currency: string) => void;
  notice: string | null;
  columns: number;
  header: string[];
  pending: boolean;
  onChange: (draft: MappingDraft) => void;
  onSubmit: () => void;
}) {
  const options = Array.from({ length: columns }, (_, i) => {
    const name = (header[i] ?? '').trim();
    return { value: i, label: name === '' ? `Колонка ${i + 1}` : `${i + 1} · ${name}` };
  });

  const columnSelect = (
    label: string,
    value: number | null,
    onSelect: (index: number | null) => void,
    optional = false,
  ) => (
    <label className="flex items-center gap-2 text-sm">
      <span className="w-44 shrink-0 text-text-secondary">{label}</span>
      <select
        aria-label={label}
        value={value === null ? '' : String(value)}
        onChange={(e) => onSelect(e.target.value === '' ? null : Number(e.target.value))}
        className={FIELD_CLS}
      >
        {optional && <option value="">нет</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <>
      {notice !== null && (
        <p data-testid="mapping-notice" className="text-xs text-text-secondary">
          {notice}
        </p>
      )}
      <Card className="flex flex-col gap-2">
        <p className="text-sm text-text-secondary">Проверьте, как разложены колонки выписки.</p>
        {columnSelect('Колонка даты', draft.date, (i) => onChange({ ...draft, date: i ?? 0 }))}
        <label className="flex items-center gap-2 text-sm">
          <span className="w-44 shrink-0 text-text-secondary">Формат даты</span>
          <select
            aria-label="Формат даты"
            value={draft.dateFormat}
            onChange={(e) =>
              onChange({ ...draft, dateFormat: e.target.value as CsvMapping['dateFormat'] })
            }
            className={FIELD_CLS}
          >
            {DATE_FORMATS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        {columnSelect('Колонка контрагента', draft.counterparty, (i) =>
          onChange({ ...draft, counterparty: i ?? 0 }),
        )}
        <label className="flex items-center gap-2 text-sm">
          <span className="w-44 shrink-0 text-text-secondary">Знак суммы</span>
          <select
            aria-label="Знак суммы"
            value={draft.direction}
            onChange={(e) =>
              onChange({ ...draft, direction: e.target.value as CsvMapping['direction'] })
            }
            className={FIELD_CLS}
          >
            <option value="sign">одна колонка со знаком</option>
            <option value="separate_columns">раздельные расход и приход</option>
          </select>
        </label>
        {draft.direction === 'sign' ? (
          columnSelect('Колонка суммы', draft.amount, (i) => onChange({ ...draft, amount: i ?? 0 }))
        ) : (
          <>
            {columnSelect('Колонка расхода', draft.debit, (i) =>
              onChange({ ...draft, debit: i ?? 0 }),
            )}
            {columnSelect('Колонка прихода', draft.credit, (i) =>
              onChange({ ...draft, credit: i ?? 0 }),
            )}
          </>
        )}
        {columnSelect(
          'Колонка ID операции банка',
          draft.bankTxnId,
          (i) => onChange({ ...draft, bankTxnId: i }),
          true,
        )}
        {/* Валюта — свойство ВЫПИСКИ, а не колонки: смешанная выписка вне скоупа
            (multi-currency — Future). Без явного выбора всё ложилось в валюту владельца
            молча, и починить это можно было только руками по каждой строке. */}
        <label className="flex items-center gap-2 text-sm">
          <span className="w-44 shrink-0 text-text-secondary">Валюта выписки</span>
          <select
            aria-label="Валюта выписки"
            value={currency}
            onChange={(e) => onCurrencyChange(e.target.value)}
            className={FIELD_CLS}
          >
            {currencyChoices(currency).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        {/* Подпись — визуальная; доступное имя даёт aria-label самого Input (идиома B6) */}
        <div className="flex items-center gap-2 text-sm">
          <span className="w-44 shrink-0 text-text-secondary">Строк заголовка</span>
          <Input
            aria-label="Строк заголовка"
            type="number"
            min={0}
            value={String(draft.headerRows)}
            onChange={(e) =>
              onChange({
                ...draft,
                headerRows: Math.max(0, Number(e.target.value) || 0),
                // с этого момента догадка молчит: число заголовочных строк — за пользователем
                headerRowsTouched: true,
              })
            }
            className="w-20 px-2 py-1 text-sm tabular-nums"
          />
        </div>
      </Card>
      <Button
        size="sm"
        className="self-end"
        data-testid="mapping-submit"
        disabled={pending}
        onClick={onSubmit}
      >
        {pending ? <Spinner size={14} aria-label="Сверка" /> : 'Разобрать выписку'}
      </Button>
    </>
  );
}

// --- шаг 3: строки, которые парсер не прочитал -------------------------------------------

function ParseErrors({
  errors,
  headerRows,
}: {
  errors: Array<{ rowIndex: number; reason: string }>;
  headerRows: number;
}) {
  if (errors.length === 0) return null;
  return (
    <Card data-testid="parse-errors" className="flex flex-col gap-1 p-3">
      {/* Молча терять такие строки нельзя (§3.4): показываем номер строки В ФАЙЛЕ */}
      <p className="text-sm text-danger">Не распознано: {errors.length}</p>
      {errors.map((e) => (
        <p key={e.rowIndex} className="text-xs text-text-muted">
          строка {e.rowIndex + headerRows + 1}: {e.reason}
        </p>
      ))}
    </Card>
  );
}

// --- шаг 5: итог -------------------------------------------------------------------------

function ResultCard({
  result,
  alreadyImported,
}: {
  result: ImportConfirmResult;
  alreadyImported: number;
}) {
  const categoriesQ = trpc.entity.query.useQuery({ query: CATEGORIES_QUERY });
  const byId = new Map(
    (Array.isArray(categoriesQ.data) ? categoriesQ.data : []).map(toOption).map((c) => [c.id, c]),
  );
  // «пропущено» — усыновлённые дубли + строки ⟳, которые в payload не уходили вовсе
  const skipped = result.adopted + alreadyImported;
  const unbudgetedTotal = result.unbudgeted.reduce((sum, u) => sum + u.count, 0);

  return (
    <>
      <Card data-testid="import-result" className="flex flex-col gap-1">
        <p className="text-sm">
          Импортировано {result.created}, пропущено {skipped} (дублей: {result.adopted}, повторов:{' '}
          {alreadyImported})
        </p>
        {result.idempotentReplay && (
          <p className="text-xs text-text-muted">
            Этот импорт уже был применён — повтор ничего не изменил
          </p>
        )}
      </Card>
      {result.unbudgeted.length > 0 && (
        <Card data-testid="import-unbudgeted" className="flex flex-wrap items-center gap-2 p-3">
          <span className="text-sm">Без конверта: {unbudgetedTotal}</span>
          {result.unbudgeted.map((u) => {
            const category = byId.get(u.categoryRef);
            return (
              <Button
                key={u.categoryRef}
                size="sm"
                variant="outline"
                onClick={() => {
                  const { activeTab, push } = useNav.getState();
                  push(activeTab, { kind: 'budget-category', id: u.categoryRef });
                }}
              >
                {category?.icon ? `${category.icon} ` : ''}
                {category?.title ?? 'Категория'} · {u.count}
              </Button>
            );
          })}
        </Card>
      )}
      <Button
        size="sm"
        variant="outline"
        className="self-end"
        onClick={() => {
          // D6c п.4: экран импорта снимаем со стека, где его открыли (импорт входится и
          // из чата), и открываем именно Overview вкладки Budget — прежний pop возвращал
          // на предыдущий экран того же стека, чем бы он ни был.
          const { activeTab, pop } = useNav.getState();
          pop(activeTab);
          openBudgetOverview();
        }}
      >
        К бюджету
      </Button>
    </>
  );
}
