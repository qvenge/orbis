// Quick-add бар Budget (Task B4, 03-budget §3.6): быстрый структурированный ввод
// транзакции без чата и без парсера — переключатель [−расход][+доход], сумма,
// пилюли 4–5 недавних категорий (из последних 20 транзакций), полный выбор
// раскрытием (native select — по образцу EnvelopeCreateSheet), title опционален
// (пусто → «<категория> <сумма>»). [Записать] → entity.create(source:'quick_capture')
// с client-UUIDv7, который генерируется ОДИН РАЗ на открытие формы (урок бэклога:
// повтор после ошибки шлёт тот же id — идемпотентность §5.3). Авто-привязку к
// конверту делает сервер (§2.3/A4) тем же action — Undo по actionId откатывает всё.
//
// Экранная клавиатура из мокапа §3.6 сознательно упрощена до <input inputmode="decimal">:
// на узких экранах inputmode вызывает системную цифровую клавиатуру, запятая
// нормализуется в точку, наружу уходит только decimal-строка ("340.00") — без float.
import { newId } from '@orbis/shared';
import { TRPCClientError } from '@trpc/client';
import { type FormEvent, useState } from 'react';
import { formatAmount } from '../../lib/format';
import { type RouterOutputs, trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Input } from '../../ui/Input';
import { Spinner } from '../../ui/Spinner';
import { CATEGORIES_QUERY, type CategoryOption, toOption } from './categories';
import { envelopeView } from './EnvelopeCard';
import { invalidateBudget, todayISO } from './useBudget';

const RECENT_QUERY = 'aspect=orbis/financial, sortBy=occurred_on:desc, limit=20';
const MAX_PILLS = 5;
// Сумма: целые/десятичные до 2 знаков, запятая = точка (§3.6); строгая граница —
// «12.345» невалиден, а не молча обрезается до «12.34» (тихая потеря копеек запрещена).
const AMOUNT_RE = /^\d+([.,]\d{1,2})?$/;

/** "340" → "340.00", "12,5" → "12.50" — decimal-строка с двумя знаками (как fast-path §7.5). */
function toDecimal2(raw: string): string {
  const [i, f = ''] = raw.replace(',', '.').split('.');
  return `${i}.${`${f}00`.slice(0, 2)}`;
}

const FIELD_CLS =
  'rounded-control border border-line bg-surface px-3 py-2 text-sm text-text transition focus-visible:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40';

/** Успешная запись: данные карточки-результата (остаток конверта + Undo, §3.6). */
type QuickAddResult = {
  title: string; // из ОТВЕТА сервера: при replay это записанная сущность, не стейт формы
  remainingText: string | null; // «8 400 ₽»; null — конверта на категорию нет (Unbudgeted)
  actionId: string | null; // null — идемпотентный replay: журнал не писался, Undo недоступен
  undone: boolean;
};

export function QuickAddBar({
  preset,
}: {
  /** Экран категории (§3.2): category_ref зафиксирован, пилюли и выбор скрыты. */
  preset?: { id: string; title: string };
}) {
  const utils = trpc.useUtils();
  const settings = trpc.user.getSettings.useQuery();
  // Пилюли недавних категорий + полный список — только без preset
  const recentQ = trpc.entity.query.useQuery(
    { query: RECENT_QUERY },
    { enabled: preset === undefined },
  );
  const categoriesQ = trpc.entity.query.useQuery(
    { query: CATEGORIES_QUERY },
    { enabled: preset === undefined },
  );
  const create = trpc.entity.create.useMutation();
  const undo = trpc.ai.undo.useMutation();

  const [direction, setDirection] = useState<'expense' | 'income'>('expense');
  const [amount, setAmount] = useState('');
  const [title, setTitle] = useState('');
  const [categoryId, setCategoryId] = useState(preset?.id ?? '');
  const [showAll, setShowAll] = useState(false);
  // Client-UUIDv7 — ОДИН РАЗ на открытие формы (mount), не на сабмит: повтор после
  // ошибки шлёт тот же id (идемпотентность §5.3); новый id — только после успеха.
  const [entityId, setEntityId] = useState(newId);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<QuickAddResult | null>(null);

  const categories: CategoryOption[] = (
    Array.isArray(categoriesQ.data) ? categoriesQ.data : []
  ).map(toOption);
  const byId = new Map(categories.map((c) => [c.id, c]));

  // Пилюли (§3.6): уникальные category_ref последних 20 транзакций по порядку, максимум 5.
  const recentRefs: string[] = [];
  for (const e of Array.isArray(recentQ.data) ? recentQ.data : []) {
    const ref = (e.aspects as Record<string, { category_ref?: unknown } | undefined>)[
      'orbis/financial'
    ]?.category_ref;
    if (typeof ref === 'string' && !recentRefs.includes(ref)) recentRefs.push(ref);
  }
  const pills = recentRefs
    .map((id) => byId.get(id))
    .filter((c): c is CategoryOption => c !== undefined)
    .slice(0, MAX_PILLS);

  const categoryTitle = preset?.title ?? byId.get(categoryId)?.title ?? '';
  const valid = AMOUNT_RE.test(amount.trim()) && categoryId !== '';

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid || create.isPending) return;
    setError(null);
    const dec = toDecimal2(amount.trim());
    const finalTitle = title.trim() !== '' ? title.trim() : `${categoryTitle} ${formatAmount(dec)}`;
    const date = todayISO(settings.data?.timezone); // occurred_on = сегодня локально (§2.3)
    let created: RouterOutputs['entity']['create'];
    try {
      created = await create.mutateAsync({
        input: {
          id: entityId,
          title: finalTitle,
          tags: [],
          aspects: {
            'orbis/financial': {
              amount: dec,
              direction,
              currency: settings.data?.defaultCurrency ?? 'RUB',
              occurred_on: date,
              category_ref: categoryId,
            },
          },
        },
        source: 'quick_capture',
      });
    } catch (err) {
      // Семантика executor'а (§5.3): честный повтор владельцем того же id — replay-УСПЕХ
      // (не исключение), а CONFLICT кидается только когда id непригоден (занят чужой /
      // RLS-невидимой строкой) — запись НЕ создана. Успех здесь не фабрикуем: ошибка
      // пользователю + свежий UUID, иначе следующая попытка упрётся в тот же конфликт.
      if (err instanceof TRPCClientError && err.data?.code === 'CONFLICT') {
        setEntityId(newId());
        setError('Не удалось записать — попробуйте ещё раз');
      } else {
        setError(err instanceof Error ? err.message : 'Не удалось записать');
        // Транспортный/прочий сбой: entityId сохранён — повтор шлёт тот же id
      }
      return;
    }

    // Всё для карточки — из ОТВЕТА: при replay (повтор после сбоя с отредактированной
    // формой) сервер вернул ранее записанную сущность, стейт формы ей не обязан совпадать.
    const fin = ((created.aspects ?? {}) as Record<string, Record<string, unknown> | undefined>)[
      'orbis/financial'
    ];
    const createdRef = typeof fin?.category_ref === 'string' ? fin.category_ref : categoryId;
    const createdOn = typeof fin?.occurred_on === 'string' ? fin.occurred_on : date;

    await invalidateBudget(utils);
    void utils.entity.query.invalidate(); // списки транзакций (§5.1)
    // Остаток конверта для карточки-результата (§3.6); ошибки чтения не роняют успех
    const env = await utils.budget.envelopeForCategory
      .fetch({ categoryId: createdRef, date: createdOn })
      .catch(() => null);
    // Валютный символ — общий envelopeView (EnvelopeCard), не дублируем маппинг
    const remainingText = env ? `${formatAmount(env.remaining)} ${envelopeView(env).sym}` : null;
    setResult({
      title: created.title,
      remainingText,
      actionId: created.actionId ?? null,
      undone: false,
    });
    // Перезапуск формы: новый client-UUID, суммы/title чистые; категория и направление остаются
    setAmount('');
    setTitle('');
    setEntityId(newId());
  }

  function onUndo(actionId: string) {
    undo.mutate(
      { actionId },
      {
        onSuccess: () => {
          setResult((r) => (r ? { ...r, undone: true } : r));
          void invalidateBudget(utils);
          void utils.entity.query.invalidate();
        },
        onError: () => setError('Не удалось отменить'),
      },
    );
  }

  return (
    <div data-testid="quickadd-bar" className="flex flex-col gap-2">
      <Card className="flex flex-col gap-2 p-3">
        <form onSubmit={submit} className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            {/* Переключатель direction (§3.6): [−расход] [+доход] */}
            <fieldset className="flex shrink-0 gap-1 border-0 p-0" aria-label="Тип записи">
              {(
                [
                  ['expense', '−расход'],
                  ['income', '+доход'],
                ] as const
              ).map(([dir, label]) => (
                <Button
                  key={dir}
                  size="sm"
                  variant={direction === dir ? 'primary' : 'outline'}
                  aria-pressed={direction === dir}
                  onClick={() => setDirection(dir)}
                >
                  {label}
                </Button>
              ))}
            </fieldset>
            <Input
              aria-label="Сумма"
              inputMode="decimal"
              placeholder="Сумма"
              value={amount}
              onChange={(e) => setAmount(e.target.value.trim())}
              className="w-full min-w-0 flex-1 text-sm tabular-nums"
            />
          </div>

          {preset === undefined && (
            <div className="flex flex-wrap items-center gap-1.5">
              {pills.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  data-testid="category-pill"
                  aria-pressed={categoryId === c.id}
                  onClick={() => setCategoryId(c.id)}
                  className={`cursor-pointer rounded-control border px-2 py-0.5 text-xs transition ${
                    categoryId === c.id
                      ? 'border-accent bg-accent/10 text-text'
                      : 'border-line bg-surface-2 text-text-secondary hover:text-text'
                  }`}
                >
                  {c.icon ? `${c.icon} ` : ''}
                  {c.title}
                </button>
              ))}
              {/* Полный выбор — раскрытием (§3.6): native select по образцу EnvelopeCreateSheet */}
              {!showAll ? (
                <Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>
                  Все категории
                </Button>
              ) : (
                <select
                  aria-label="Категория"
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                  className={FIELD_CLS}
                >
                  <option value="" disabled>
                    {categoriesQ.isLoading ? 'Загрузка…' : 'Выберите категорию'}
                  </option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.icon ? `${c.icon} ` : ''}
                      {c.title}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            <Input
              aria-label="Комментарий"
              placeholder="title (опц.)…"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full min-w-0 flex-1 text-sm"
            />
            <Button type="submit" size="sm" disabled={!valid || create.isPending}>
              {create.isPending ? <Spinner size={14} aria-label="Запись" /> : 'Записать'}
            </Button>
          </div>
        </form>

        {error !== null && (
          <p data-testid="quickadd-error" className="text-xs text-danger">
            {error}
          </p>
        )}
      </Card>

      {/* Карточка-результат (§3.6): остаток конверта после записи + Undo по actionId */}
      {result !== null && (
        <Card
          data-testid="quickadd-result"
          data-undone={String(result.undone)}
          className={`flex items-center gap-2 p-3 text-sm ${result.undone ? 'opacity-50' : ''}`}
        >
          <span className="min-w-0 flex-1 truncate tabular-nums">
            {result.title}
            {result.remainingText !== null
              ? ` → осталось ${result.remainingText}`
              : ' → без конверта'}
          </span>
          {result.undone ? (
            <span className="shrink-0 text-xs text-text-muted">Отменено</span>
          ) : (
            result.actionId !== null && (
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0"
                disabled={undo.isPending}
                onClick={() => {
                  if (result.actionId !== null) onUndo(result.actionId);
                }}
              >
                Отменить
              </Button>
            )
          )}
        </Card>
      )}
    </div>
  );
}
