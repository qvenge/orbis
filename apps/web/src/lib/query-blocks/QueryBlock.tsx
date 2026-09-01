import type { QueryAst } from '@orbis/shared/query';
import { SlidersHorizontal } from 'lucide-react';
import { useMemo } from 'react';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { parseBlock } from './parse';
import { useThisEntityId } from './this-entity';
import { useFieldCatalog } from './useFieldCatalog';

/**
 * Кнопка «Настроить» — вход в редактор ЭТОГО блока. Рисуется только когда вызывающий дал
 * onConfigure: виджет монтируют и там, где править нечего (правка body, где текст блока
 * уже открыт в textarea), и кнопка «в никуда» была бы там третьим способом сделать одно и
 * то же. Иконка с aria-label, а не подпись: шапка виджета — одна строка с заголовком
 * секции и счётчиком, и слово «Настроить» вытеснило бы из неё сам заголовок.
 */
function ConfigureButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      size="icon"
      variant="ghost"
      aria-label="Настроить"
      title="Настроить"
      data-testid="qb-configure"
      onClick={onClick}
    >
      <SlidersHorizontal size={16} aria-hidden />
    </Button>
  );
}

/**
 * Откуда виджет берёт запрос — ДВА пути.
 *
 *  - СТРОКА: первый кадр записи (`EditorShell`) и бейдж закреплённой сущности живут на
 *    `entity.body`, документа у них нет вовсе.
 *  - БЛОК ДОКУМЕНТА: `{ast, text}` из `body_doc`.
 *
 * `ast !== null` значит «дерево уже собрано по реестру владельца» (`bindQueryBlocks` на
 * сервере) — тогда оно и уходит на сервер, а разбирать текст заново было бы второй правдой о
 * том, какой запрос верен. `ast === null` НЕ приговор: так выглядит и неразобранный блок, и
 * любой блок, построенный разбором markdown в браузере (`MarkdownToggle`, где реестра нет
 * структурно). Поэтому виджет в этом случае разбирает `text` сам — ровно тем же правилом, что
 * и строковый путь.
 */
export type QueryBlockSource = string | { ast: QueryAst | null; text: string };

/** Пустой блок НЕ значит «все сущности владельца» (Р-21-8) — он значит «блок не настроен». */
const EMPTY_MESSAGE = 'пустой запрос: блок ничего не выбирает — настройте его';

// Виджет ОДНОГО query-блока (02-core-os §3.4). На вход идёт inner блока — уже без обёртки
// {{query:...}}; разбивку body на блоки делает queryBlocks (features/browser/query.ts).
// Раньше проп назывался body и компонент сам брал ПЕРВОЕ совпадение регэкспа: из-за этого
// detail-экран сидированного Daily Planning показывал только Inbox, а секции «Сегодня»
// и «Ожидание» (§3.3) не рендерились вовсе.
export function QueryBlock({
  query,
  title,
  onConfigure,
}: {
  query: QueryBlockSource;
  title?: string;
  onConfigure?: () => void;
}) {
  const { registry } = useFieldCatalog();
  const text = typeof query === 'string' ? query : query.text;
  const boundAst = typeof query === 'string' ? null : query.ast;
  // Разбор в браузере — ТОЛЬКО когда дерева нет. Есть дерево — реестр виджету не нужен вовсе:
  // заголовок берётся из дерева, дерево уходит на сервер как есть, и разобранный блок
  // рисуется ПЕРВЫМ кадром, не дожидаясь реестра по tRPC.
  // Пустой текст не разбирается намеренно (Р-21-8): грамматика принимает его законным
  // `{filter: null}`, то есть виджет молча показал бы ВСЕ сущности владельца.
  const parsed = useMemo(
    () =>
      boundAst !== null || !registry || text.trim() === ''
        ? null
        : parseBlock(text, registry.parse),
    [boundAst, registry, text],
  );
  const ok = boundAst !== null || parsed?.ok === true;
  /**
   * Чем разрешается `this` в клаузах `children_of=`/`parents_of=` (§6.1). Ставит контекст тот,
   * кто рисует тело сущности (DetailScreen → ThisEntityProvider); вне сущности его нет.
   *
   * Поле уходит на сервер ТОЛЬКО когда контекст есть, а не `thisEntityId: null`: у ручки вход
   * `.strict()` с `z.string().uuid().optional()` (routers/entity.ts), и null развалил бы разбор
   * входа у КАЖДОГО блока — включая те, где `this` не встречается вовсе.
   */
  const thisEntityId = useThisEntityId();

  // entity.query только при валидном блоке; §6.4 — при ошибке НИКОГДА не пустой список, а плашка.
  // Привязанный блок уходит ДЕРЕВОМ: печатать его в текст, чтобы сервер разобрал обратно,
  // значило бы прогонять запрос через форму, в которую он не обязан помещаться (§А5-3д).
  const signature = boundAst !== null ? { ast: boundAst } : { query: text };
  const list = trpc.entity.query.useQuery(
    thisEntityId ? { ...signature, thisEntityId } : signature,
    { enabled: ok },
  );

  // Что показать вместо списка: §6.4 — при ошибке НИКОГДА не пустой список, а плашка.
  const failure = ((): { message: string; position?: number } | null => {
    if (boundAst !== null) return null;
    if (text.trim() === '') return { message: EMPTY_MESSAGE };
    return parsed !== null && !parsed.ok ? parsed.error : null;
  })();

  if (failure === null && !ok) {
    return (
      <Card>
        <span role="status">Загрузка…</span>
      </Card>
    );
  }

  if (failure !== null) {
    return (
      // Кнопка есть и здесь: битый блок — ровно тот случай, когда «настроить» нужнее
      // всего, а без неё чинить его пришлось бы правкой всего body руками.
      <Card role="alert" data-testid="qb-error" className="border-danger">
        <p className="text-danger text-sm">Ошибка запроса: {failure.message}</p>
        {/* Позиция необязательна по типу отказа канона: печатать «позиция undefined» —
            хуже, чем не печатать её вовсе. Сегодня текстовый разбор ставит её всегда. */}
        {failure.position !== undefined && (
          <p className="text-text-muted text-xs">позиция {failure.position}</p>
        )}
        {onConfigure && (
          <div className="mt-2 flex justify-end">
            <ConfigureButton onClick={onConfigure} />
          </div>
        )}
      </Card>
    );
  }

  // §3.4: «заголовок (из title=; нет параметра — без заголовка)». Явный проп перекрывает
  // блок — им пользуются вызывающие, у которых заголовок задан снаружи виджета.
  const fromTree = boundAst !== null ? boundAst.title : undefined;
  const heading = title ?? fromTree ?? (parsed?.ok === true ? parsed.ast.title : undefined);
  const entities = list.data ?? [];
  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        {heading && <p className="font-medium">{heading}</p>}
        {/* Счётчик и «Настроить» — одной группой: без заголовка (у detail так и есть)
            счётчик обязан остаться на прежнем месте, а не улететь от кнопки к другому краю
            карточки, как его развёл бы justify-between. */}
        <div className="flex items-center gap-1">
          <span data-testid="qb-count" className="text-text-secondary text-xs">
            {heading ? entities.length : `Совпадений: ${entities.length}`}
          </span>
          {onConfigure && <ConfigureButton onClick={onConfigure} />}
        </div>
      </div>
      <ul className="flex flex-col divide-y divide-line">
        {entities.map((e) => (
          <li key={e.id} data-testid="qb-item" className="py-1 text-sm">
            {e.title}
          </li>
        ))}
      </ul>
    </Card>
  );
}
