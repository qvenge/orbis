import { useState } from 'react';
import { aspectLabel, fieldLabel, type RegistryLookup } from '../../lib/registry/labels';
import { useRegistry } from '../../lib/registry/useRegistry';
import { type RouterOutputs, trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { CATEGORIES_QUERY, toOption } from '../budget/categories';
import { invalidateBudget } from '../budget/useBudget';
import { useEntityUpdate } from './useEntityDetail';

type Entity = RouterOutputs['entity']['get']['entity'];

const FINANCIAL = 'orbis/financial';
const CATEGORY_REF = 'category_ref';

/**
 * Аспекты, у которых на экране ЕСТЬ СВОЯ карточка (ADE-срез 1): назначение исполнителя
 * (AssignmentCard) и прогон агента (RunsList на тикете, лента шагов на самом прогоне).
 *
 * Дело не в дублировании вида, а в правке. Общая карточка предлагает инпут на каждое скалярное
 * поле, и правка `executor` в обход инварианта исполнителя (executor=agent ⇔ живой grant_id,
 * invariants.ts:295-326) отдавала бы VALIDATION на каждом втором нажатии; поля прогона и вовсе
 * пишет только агент — вручную их править нечем и незачем.
 */
const HIDDEN_ASPECT_CARDS = new Set(['orbis/assignment', 'orbis/agent-run']);

// Тихий инпут-в-строке-свойства: тот же вид у текстового поля и у пикера категории.
// Экспортом — слою предложения на записи (Ш1.3): строка правки предложения обязана
// выглядеть ровно как строка свойства, иначе владелец читал бы их как разные вещи.
export const FIELD_CLASS =
  'w-full rounded-md bg-transparent px-2 py-1 text-sm text-text outline-none transition hover:bg-surface-2 focus-visible:bg-surface-2/70 focus-visible:ring-2 focus-visible:ring-accent/40';

// Восстановление типа поля из исходного значения (правка идёт как строка из Input).
// Нескалярное сюда не доходит вовсе — такие поля не редактируются (см. isScalar).
export function coerce(original: unknown, raw: string): unknown {
  if (typeof original === 'number') return Number(raw);
  if (typeof original === 'boolean') return raw === 'true';
  return raw;
}

/**
 * Правится ли значение строкой в инпуте. Инпут отдаёт СТРОКУ, и обратно в объект или
 * массив она не превращается ничем: до этой проверки объектный `progress_source` цели
 * рисовался как `[object Object]` (String(value)), а blur слал эту строку и получал
 * жёсткий VALIDATION от ajv — поле выглядело сломанным на КАЖДОЙ цели (обязательное
 * поле аспекта). То же касалось `orbis/schedule.recurrence` и `orbis/category.aliases`,
 * поэтому чинится общий случай, а не цель: редактируемо ровно то, что скаляр.
 */
export function isScalar(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean'
  );
}

/**
 * Показ нескалярного значения. Прятать поле нельзя: «поправьте в источнике query»
 * (GoalProgress) — пустой совет, если самого query на экране нет. Список скаляров
 * читается через запятую, всё прочее — компактным JSON: это и есть та форма, в которой
 * значение уедет обратно на сервер, и по ней видно опечатку в запросе.
 */
export function readOnlyText(value: unknown): string {
  // Пустой список — прочерк, а не пустое место: `aliases: ` без значения читается как
  // сломанная строка, а не как «алиасов нет».
  if (Array.isArray(value) && value.length === 0) return '—';
  if (Array.isArray(value) && value.every(isScalar))
    return value.map((v) => String(v ?? '')).join(', ');
  return JSON.stringify(value) ?? String(value);
}

// Карточки установленных аспектов: типизированная inline-правка полей (§5.2 — та же
// optimistic + expectedUpdatedAt, что и body; правка подлежит Undo журнала сервера) и
// снятие аспекта целиком (aspects:{id:null}).
//
// Полосы прогресса цели здесь БОЛЬШЕ НЕТ: карточки уехали на вкладку «Детали», а прогресс
// остался на «Сущности» — у цели он и есть то, ради чего её открывают, и прятать «50%,
// 150 000 из 300 000» во вторую вкладку значило бы ухудшить главный экран целей ради
// чистоты раскладки (Задача 15). Рисует его теперь DetailScreen, доставая `unit` из
// `entity.aspectsMap['orbis/goal']` напрямую.
export function AspectCards({ entity }: { entity: Entity }) {
  const { mutation, conflict } = useEntityUpdate(entity.id);
  const utils = trpc.useUtils();
  // Подписи секций и строк — из реестра (§А9-2), ОДНИМ снимком на все карточки: он же
  // уходит пропом в строки, чтобы каждая из них не подписывалась на снимок отдельно.
  const registry = useRegistry();
  const aspects = entity.aspectsMap as Record<string, Record<string, unknown>>;

  // Смена категории (sign-off владельца K6) — обычный entity.update: перепривязку
  // транзакции к конверту делает серверный хук (фаза A), клиент ничего не связывает.
  // Бюджетные агрегаты после этого протухли — инвалидируем их тем же приёмом, что
  // экраны Budget (invalidateBudget); entity.get/entity.query обновит useEntityUpdate.
  function setCategory(categoryId: string) {
    mutation.mutate(
      {
        id: entity.id,
        expectedUpdatedAt: entity.updatedAt,
        aspects: { [FINANCIAL]: { [CATEGORY_REF]: categoryId } },
      },
      { onSuccess: () => void invalidateBudget(utils) },
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {conflict && (
        <p role="alert" className="text-sm text-danger">
          Аспект изменён в другом месте — обновите.
        </p>
      )}
      {/* Notion-style свойства: секция без карточной рамки, значения — тихие инпуты
          без бордера (hover подсказывает редактируемость). */}
      {/* Фильтр по ПАРАМ, а не правка `aspects`: объект приехал из кэша React Query, и удаление
          ключа из него испортило бы данные всем, кто читает тот же ключ. */}
      {Object.entries(aspects)
        .filter(([aspectId]) => !HIDDEN_ASPECT_CARDS.has(aspectId))
        .map(([aspectId, fields]) => (
          <section
            key={aspectId}
            data-testid={`aspect-${aspectId}`}
            className="flex flex-col gap-1"
          >
            <div className="flex items-center justify-between">
              <p className="text-2xs font-medium uppercase tracking-wide text-text-muted">
                {aspectLabel(registry, aspectId)}
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-text-muted"
                aria-label={`Снять ${aspectId}`}
                onClick={() => mutation.mutate({ id: entity.id, aspects: { [aspectId]: null } })}
              >
                Снять аспект
              </Button>
            </div>
            <dl className="grid grid-cols-[minmax(7rem,max-content)_1fr] items-center gap-x-3 gap-y-0.5 text-sm">
              {Object.entries(fields).map(([field, value]) =>
                // Единственное поле с собственным контролом: категория финансовой записи
                // выбирается из списка, а не вписывается UUID'ом руками (K6). Прочие
                // поля аспектов не трогаем — правка только пути category_ref.
                aspectId === FINANCIAL && field === CATEGORY_REF ? (
                  <CategoryField
                    key={field}
                    registry={registry}
                    value={typeof value === 'string' ? value : ''}
                    onSelect={setCategory}
                  />
                ) : !isScalar(value) ? (
                  <ReadOnlyField
                    key={field}
                    registry={registry}
                    aspectId={aspectId}
                    field={field}
                    value={value}
                  />
                ) : (
                  <AspectField
                    key={field}
                    registry={registry}
                    aspectId={aspectId}
                    field={field}
                    value={value}
                    onSave={(raw) =>
                      mutation.mutate({
                        id: entity.id,
                        expectedUpdatedAt: entity.updatedAt,
                        aspects: { [aspectId]: { [field]: coerce(value, raw) } },
                      })
                    }
                  />
                ),
              )}
            </dl>
          </section>
        ))}
    </div>
  );
}

/**
 * Пикер категории для orbis/financial.category_ref (K6): показывает НАЗВАНИЯ категорий,
 * а не идентификатор. Список — тот же запрос и тот же кэш, что у экранов Budget.
 * Смонтирован только на financial-сущностях, поэтому запрос категорий не уходит с
 * каждого detail-экрана.
 */
function CategoryField({
  registry,
  value,
  onSelect,
}: {
  registry: RegistryLookup;
  value: string;
  onSelect: (id: string) => void;
}) {
  const q = trpc.entity.query.useQuery({ query: CATEGORIES_QUERY });
  // Array.isArray — та же защита, что в TransactionsScreen: карточка живёт на общем
  // detail-экране, и неожиданная форма ответа не должна ронять всю страницу.
  const categories = (Array.isArray(q.data) ? q.data : []).map(toOption);
  const known = categories.some((c) => c.id === value);

  return (
    <>
      <dt className="text-text-muted">{fieldLabel(registry, CATEGORY_REF, FINANCIAL)}</dt>
      <dd>
        <select
          aria-label={`${FINANCIAL} ${CATEGORY_REF}`}
          value={value}
          onChange={(e) => {
            if (e.target.value !== value) onSelect(e.target.value);
          }}
          className={FIELD_CLASS}
        >
          {/* Своя опция под текущее значение, пока список грузится или ссылка ведёт
              в архивную/удалённую категорию: иначе select показал бы пустоту и первым
              же изменением молча переставил категорию.
              Порядок веток (D5d п.5):
              1) пустой category_ref — свойство САМОЙ транзакции, а не беда со списком:
                 «Без категории» обязано пережить и отказ, и загрузку;
              2) отказ показываем, только если данных нет вовсе: v5 сохраняет data при
                 ошибке рефетча, и на известном списке правда — «ссылка ведёт в никуда»
                 (приём RolloverScreen: isError отдельно от пустоты);
              3) isPending, а не isLoading: офлайн-пауза (fetchStatus:'paused') даёт
                 isLoading===false, и подпись срывалась в «не найдена» на целой записи. */}
          {!known && (
            <option value={value}>
              {value === ''
                ? 'Без категории'
                : q.isError && categories.length === 0
                  ? 'Не удалось загрузить категории'
                  : q.isPending
                    ? 'Загрузка…'
                    : 'Категория не найдена'}
            </option>
          )}
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.icon ? `${c.icon} ` : ''}
              {c.title}
            </option>
          ))}
        </select>
      </dd>
    </>
  );
}

/**
 * Нескалярное значение — read-only строка вместо инпута (см. isScalar). Отступы те же,
 * что у FIELD_CLASS, чтобы значения свойств стояли на одной вертикали; hover/фокус —
 * нет, и это ровно то, что нужно сказать глазу: здесь не правят.
 */
function ReadOnlyField({
  registry,
  aspectId,
  field,
  value,
}: {
  registry: RegistryLookup;
  aspectId: string;
  field: string;
  value: unknown;
}) {
  return (
    <>
      <dt className="text-text-muted">{fieldLabel(registry, field, aspectId)}</dt>
      <dd
        data-testid={`aspect-value-${aspectId}-${field}`}
        className="break-words px-2 py-1 text-sm text-text-secondary"
      >
        {readOnlyText(value)}
      </dd>
    </>
  );
}

/**
 * Строка «поле → значение» с тихой правкой по blur.
 *
 * Компонент НИЧЕГО не сохраняет сам: `onSave(raw)` отдаёт сырую строку из инпута, а что с
 * ней делать — дело родителя. На самой записи родитель шлёт `entity.update` немедленно
 * (см. AspectCards выше); в слое предложения (Ш1.3) — кладёт в буфер правок, потому что
 * граф там двигает «Принять», а не набор в поле. Ровно ради второго родителя компонент и
 * экспортирован: своя копия строки правки разошлась бы с этой видом и поведением.
 *
 * Правится только СКАЛЯР (см. isScalar): инпут отдаёт строку, а обратно в объект или массив
 * она не превращается ничем.
 */
export function AspectField({
  registry,
  aspectId,
  field,
  value,
  onSave,
}: {
  /**
   * Снимок реестра для подписи поля (§А9-2) — ПРОПОМ, а не своим `useRegistry()` внутри:
   * компонент экспортирован и живёт вторым родителем в слое предложения (Ш1.3), где строк
   * на экране десятки, и свой хук в каждой из них подписал бы на снимок каждую строку.
   */
  registry: RegistryLookup;
  /** Идёт только в aria-label: без него у пяти инпутов подряд одно имя на всех. */
  aspectId: string;
  field: string;
  value: unknown;
  onSave: (raw: string) => void;
}) {
  const initial = String(value ?? '');
  const [draft, setDraft] = useState(initial);
  const [serverValue, setServerValue] = useState(initial);

  // D6c п.3: значение аспекта сменилось извне (наш же save, чекбокс «Готово» в шапке,
  // правка с другого устройства) — подхватываем его, но ТОЛЬКО если черновик не трогали.
  // Иначе текст, который владелец печатает прямо сейчас, был бы затёрт. Приём тот же,
  // что у редактора тела (BodyEditor подменяет содержимое только вне фокуса): сравнение с
  // последним известным серверным значением в рендере, а не useEffect на каждый рендер.
  if (initial !== serverValue) {
    setServerValue(initial);
    if (draft === serverValue) setDraft(initial);
  }

  // dt/dd — прямые дети `<dl>`-грида родителя (grid-cols-[auto_1fr]): все инпуты
  // начинаются с одной вертикали независимо от длины лейбла (лейблы выровнены вправо).
  return (
    <>
      <dt className="text-text-muted">{fieldLabel(registry, field, aspectId)}</dt>
      <dd>
        <input
          aria-label={`${aspectId} ${field}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => draft !== initial && onSave(draft)}
          className={FIELD_CLASS}
        />
      </dd>
    </>
  );
}
