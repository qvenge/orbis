import { BLOCK_ROWS_CAP, type BlockResult } from '@orbis/shared';
import { bodyIssues, EMPTY_QUERY_MESSAGE } from '@orbis/shared/doc/placement';
import { absoluteDateIn, type QueryAst } from '@orbis/shared/query';
import { type ReactNode, useMemo, useState } from 'react';
import { BlockDataError, useBlockData } from '../../../lib/query-blocks/batch';
import { useBodyKind } from '../../../lib/query-blocks/body-kind';
import { parseBlock } from '../../../lib/query-blocks/parse';
import { useThisEntityId } from '../../../lib/query-blocks/this-entity';
import { useFieldCatalog } from '../../../lib/query-blocks/useFieldCatalog';
import { Card } from '../../../ui/Card';
import { BlockPlaque, ConfigureButton, REGISTRY_FAILED_MESSAGE } from './BlockPlaque';
import { CompactForm } from './CompactForm';
import { ListForm } from './ListForm';
import { MoreRows } from './MoreRows';
import { TableForm } from './TableForm';
import { TileForm } from './TileForm';

/** Загрузка реестра: блок ещё не разобран, настраивать нечего. */
function Loading() {
  return (
    <Card>
      <span role="status">Загрузка…</span>
    </Card>
  );
}

/**
 * Карточка списочного блока — ОДНА на загрузку и на строки. Шапка с «Настроить» стоит на том же
 * месте дерева в обоих состояниях: кнопка — тот же DOM-узел, и фокус, возвращаемый ей модалкой
 * блока, не теряется на приезде данных; медленный блок можно настроить, не дожидаясь ответа.
 */
function BlockFrame({
  heading,
  count,
  onConfigure,
  children,
}: {
  heading: string | undefined;
  /** Число совпадений; `undefined` — ещё грузится. */
  count: number | undefined;
  onConfigure?: () => void;
  children: ReactNode;
}) {
  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        {heading && <p className="font-medium">{heading}</p>}
        {/* Счётчик и «Настроить» — одной группой: без заголовка счётчик обязан остаться на
            прежнем месте, а не улететь от кнопки к другому краю карточки. Число — ВСЕ
            совпадения, включая не показанные «ещё N». */}
        <div className="flex items-center gap-1">
          {count !== undefined && (
            <span data-testid="qb-count" className="text-text-secondary text-xs">
              {heading ? count : `Совпадений: ${count}`}
            </span>
          )}
          {onConfigure && <ConfigureButton onClick={onConfigure} />}
        </div>
      </div>
      {children}
    </Card>
  );
}

/**
 * «Честно пусто» для `hide_empty` (§5.4): пустая выборка строк, плитка по нулю записей, `latest`
 * без значения. Ошибка сюда не доходит никогда — её показывает плашка раньше.
 */
function isEmptyResult(r: BlockResult): boolean {
  if (!r.ok) return false;
  switch (r.kind) {
    case 'rows':
      return r.rows.length === 0 && r.more === 0;
    case 'count':
      return r.count === 0;
    case 'sum':
      return r.count === 0;
    case 'latest':
      return r.value === null;
  }
}

/**
 * Блок, прошедший разбор, — с данными. Отдельный компонент, а не ветка `DataBlock`: хук данных
 * зовётся только у разобранного блока (битый в сеть не уходит, §6.4), а правило хуков не
 * позволяет звать его условно.
 */
function LoadedBlock({
  text,
  ast,
  heading,
  onConfigure,
}: {
  text: string;
  ast: QueryAst;
  heading: string | undefined;
  onConfigure?: () => void;
}) {
  // «ещё N» поднимает `limit` ЭТОГО блока — новый ключ, просьба пачкой из одного.
  const [limit, setLimit] = useState<number | undefined>(undefined);
  const data = useBlockData(text, { limit });

  // §6.5: ошибка блока — плашка с причиной; пустоты вместо ошибки не бывает.
  if (data.isError) {
    const position = data.error instanceof BlockDataError ? data.error.position : undefined;
    return (
      <BlockPlaque
        message={`Ошибка запроса: ${data.error.message}`}
        {...(position !== undefined && { position })}
        {...(onConfigure && { onConfigure })}
      />
    );
  }
  const configure = onConfigure ? { onConfigure } : {};
  const result = data.data;
  if (result === undefined) {
    return (
      <BlockFrame heading={heading} count={undefined} {...configure}>
        <span role="status" className="text-sm text-text-secondary">
          Загрузка…
        </span>
      </BlockFrame>
    );
  }
  // Отказ блока приходит ошибкой запроса (batch.tsx); `ok:false` в данных — ответ мимо собирателя,
  // и пустоты вместо него быть не должно (§6.5).
  if (!result.ok) {
    return <BlockPlaque message={`Ошибка запроса: ${result.error.message}`} {...configure} />;
  }
  if (ast.hideEmpty && isEmptyResult(result)) return null;
  switch (result.kind) {
    case 'count':
    case 'sum':
    case 'latest':
      return (
        <TileForm result={result} aggregate={ast.aggregate} heading={heading} {...configure} />
      );
    case 'rows':
      // Карточка — та же `BlockFrame`, что у загрузки, прямо здесь, а не во вложенном
      // компоненте: иной тип элемента на этом месте дерева пересоздал бы карточку, и
      // «Настроить» потеряла бы фокус на приезде данных.
      return (
        <BlockFrame heading={heading} count={result.rows.length + result.more} {...configure}>
          <RowsBody result={result} ast={ast} pending={data.isPlaceholderData} onMore={setLimit} />
        </BlockFrame>
      );
    default:
      // Вид ответа, которого этот клиент не знает (сервер новее) — плашка, а не пустая карточка:
      // §6.5, пустоты вместо ошибки не бывает.
      return <BlockPlaque message={UNKNOWN_KIND_MESSAGE} {...configure} />;
  }
}

/** Ответ сервера вида, которого клиент не знает, — лечится обновлением приложения. */
const UNKNOWN_KIND_MESSAGE = 'неизвестный вид ответа блока — обновите приложение';

/**
 * Строки в форме `display` и «ещё N». «ещё N» раскрывает остаток до потолка сервера; у потолка
 * (`BLOCK_ROWS_CAP` строк уже показано) раскрывать нечем — кнопка была бы мёртвой, вместо неё
 * подпись, что показаны первые N.
 */
function RowsBody({
  result,
  ast,
  pending,
  onMore,
}: {
  result: Extract<BlockResult, { kind: 'rows' }>;
  ast: QueryAst;
  pending: boolean;
  onMore: (limit: number) => void;
}) {
  const total = result.rows.length + result.more;
  const display = ast.display ?? 'compact';
  const atCap = result.rows.length >= BLOCK_ROWS_CAP;
  return (
    <>
      {display === 'list' ? (
        <ListForm rows={result.rows} />
      ) : display === 'table' ? (
        <TableForm rows={result.rows} columns={ast.columns} />
      ) : (
        <CompactForm rows={result.rows} />
      )}
      {result.more > 0 &&
        (atCap ? (
          <p data-testid="qb-cap" className="text-text-muted text-xs">
            показаны первые {BLOCK_ROWS_CAP}
          </p>
        ) : (
          <MoreRows
            more={result.more}
            pending={pending}
            onMore={() => onMore(Math.min(total, BLOCK_ROWS_CAP))}
          />
        ))}
    </>
  );
}

/**
 * Блок данных (спека страниц 1а §5.4, §6.3, §7.2) — ОДИН компонент для всех мест, где рисуется
 * `{{query:…}}`: первый кадр тела, NodeView редактора, страница и шаблон. На вход — ТЕКСТ блока
 * без обёртки: по нему идёт и разбор формы показа, и ключ данных (`useBlockData`).
 *
 * Разбор в браузере — ради формы показа (`display`, `columns`, `aggregate`, `hide_empty`) и ради
 * отказа без сети: битый блок в пачку не уходит (§6.4). Порядок гардов:
 *  1. пустой текст — «блок не настроен», а не «все записи владельца» (Р-21-8); реестр не нужен;
 *  2. реестр не приехал и не приедет (`failed`) — плашка с причиной, а не вечная загрузка (§6.5);
 *     реестр ещё едет — загрузка (по пустому каталогу разбор соврал бы «неизвестным свойством»);
 *  3. отказ разбора — плашка с позицией;
 *  4. вне заметки — абсолютная дата в запросе — плашка с подсказкой токенов (§5.6, С1а-9):
 *     формулировка из `bodyIssues`, одна на плашку тела и плашку блока;
 *  5. иначе — данные.
 *
 * `title` — явный заголовок снаружи (перекрывает `title=` блока); им пользуется обёртка
 * `QueryBlock`, сохранившая прежнюю сигнатуру.
 */
export function DataBlock({
  text,
  title,
  onConfigure,
}: {
  text: string;
  title?: string;
  onConfigure?: () => void;
}) {
  const { registry, failed } = useFieldCatalog();
  const kind = useBodyKind();
  const thisId = useThisEntityId();
  const empty = text.trim() === '';
  const parsed = useMemo(
    () => (empty || registry === null ? null : parseBlock(text, registry.parse)),
    [empty, registry, text],
  );
  const dateIssue = useMemo(() => {
    if (kind === 'note' || registry === null || parsed === null || !parsed.ok) return null;
    if (absoluteDateIn(parsed.ast, registry.parse) === null) return null;
    return (
      bodyIssues([{ kind: 'query', text, raw: text }], kind, registry.parse).find(
        (i) => i.code === 'ABSOLUTE_DATE',
      ) ?? null
    );
  }, [kind, registry, parsed, text]);
  const configure = onConfigure ? { onConfigure } : {};

  if (empty)
    return <BlockPlaque message={`Ошибка запроса: ${EMPTY_QUERY_MESSAGE}`} {...configure} />;
  if (registry === null && failed) {
    return <BlockPlaque message={REGISTRY_FAILED_MESSAGE} {...configure} />;
  }
  if (parsed === null) return <Loading />;
  if (!parsed.ok) {
    return (
      <BlockPlaque
        message={`Ошибка запроса: ${parsed.error.message}`}
        {...(parsed.error.position !== undefined && { position: parsed.error.position })}
        {...configure}
      />
    );
  }
  if (dateIssue !== null) {
    return (
      <BlockPlaque
        message={dateIssue.message}
        {...(dateIssue.hint !== undefined && { hint: dateIssue.hint })}
        {...configure}
      />
    );
  }
  return (
    // key по тексту И записи `this`: другой запрос — другой блок, и раскрытое «ещё N» старого к нему
    // не относится; тот же шаблон на соседней записи (экран монтируется без key) — тоже другой блок.
    <LoadedBlock
      key={`${text.trim()}:${thisId ?? ''}`}
      text={text}
      ast={parsed.ast}
      heading={title ?? parsed.ast.title}
      {...configure}
    />
  );
}
