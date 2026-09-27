// Листовые сабпаты, не баррель `@orbis/shared/doc`: экран записи тянет этот модуль эагерно
// (сторожа `check-lazy-chunks.ts` и `save.test.tsx`).
import { type BrokenTemplate, chooseTemplate, type TemplateCandidate } from '@orbis/shared';
import { type PageNode, parsePageText } from '@orbis/shared/doc/page-grammar';
import { templateBrokenReason } from '@orbis/shared/doc/placement';
import type { ParseRegistry } from '@orbis/shared/query';
import { HOST_TEMPLATE_KEY } from '@orbis/shared/supply';
import { Component, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { ThisEntityProvider } from '../../lib/query-blocks/this-entity';
import { useFieldCatalog } from '../../lib/query-blocks/useFieldCatalog';
import type { RouterOutputs } from '../../trpc';
import { Skeleton } from '../../ui/Skeleton';
import { usePlanToFactPrompt } from '../budget/usePlanToFactPrompt';
import { RecordHostProvider, recordHostValue, type WireEntity } from '../entity-detail/record-host';
import { BaseRecordView } from './BaseRecordView';
import { BlockPlaque } from './blocks/BlockPlaque';
import { HOST_TEMPLATE_NODES, HOST_TEMPLATE_TEXT } from './host-template';
import { Renderer } from './Renderer';
import { renderIssues } from './render-plan';
import { TabMemoryScope } from './TabsContainer';
import {
  BrokenTemplatePlaque,
  DisputePlaque,
  HostTemplateBrokenPlaque,
  RegistryErrorPlaque,
  TemplatesErrorPlaque,
} from './TemplatePlaques';
import { usePageTemplates } from './usePageTemplates';
import { useSupplyRecords } from './useSupplyRecords';

type EntityGetReply = RouterOutputs['entity']['get'];

/** Причина исключения шаблона, упавшего при рендере (§4.2 шаг 7: «не разобран: <причина>»). */
export const RENDER_CRASH_REASON = 'ошибка отрисовки';

/** Текст шаблона на показ: id (пространство памяти вкладок, граница ошибок) и тело. */
type TemplateText = Pick<WireEntity, 'id' | 'body'>;

/**
 * Чем показать запись: шаблон хоста, шаблон владельца, заданный шаблон предпросмотра (§9.3) или —
 * пока выбор не решён — заглушкой.
 */
type Shown =
  | { kind: 'host' }
  | { kind: 'own'; row: WireEntity }
  | { kind: 'preview'; template: TemplateText }
  | { kind: 'wait' };

interface Decision {
  shown: Shown;
  dispute: readonly string[] | null;
  broken: readonly BrokenTemplate[];
  listFailed: boolean;
  /** Реестр не приехал, а без него свой шаблон не проверить — показан хост (§6.5, §4.2 шаг 8). */
  registryFailed: boolean;
}

const HOST: Decision = {
  shown: { kind: 'host' },
  dispute: null,
  broken: [],
  listFailed: false,
  registryFailed: false,
};

const fits = (t: TemplateCandidate, aspects: readonly string[]) =>
  t.forAspects.every((a) => aspects.includes(a));

/**
 * Выбор показа (§4.2) поверх чистой функции `chooseTemplate`: здесь только то, чего она знать не
 * может, — состояние списка, реестра и разовый выбор «открыть через X».
 *
 * - Список ещё едет — шаблон хоста, без ожидания (§6.5): у записи без своих шаблонов экран обязан
 *   рисоваться сразу. В проде список и запись приходят одним HTTP (`httpBatchLink`), так что
 *   смена «хост → свой шаблон» на приезде списка практически не случается.
 * - Список не приехал — шаблон хоста и плашка (РП-14).
 * - Подходящие шаблоны есть, а реестра ещё нет — ждать: без реестра не проверить, разобран ли
 *   шаблон (§4.2 шаг 7 смотрит и блоки запросов), а показать шаблон хоста и тут же сменить его
 *   своим — перемонтировать тело на глазах. Ожидание платит только владелец со своими шаблонами.
 * - Реестр отказал — ждать нечего: шаблон хоста и плашка. Вечный скелет без слова о причине был бы
 *   той самой пустотой вместо ошибки (§6.5).
 */
function decide(
  aspects: readonly string[],
  list: ReturnType<typeof usePageTemplates>,
  reg: ParseRegistry | null,
  registryFailed: boolean,
  crashed: ReadonlyMap<string, string>,
  override: { templateId: string | 'host' } | undefined,
): Decision {
  if (list.status === 'loading') return HOST;
  if (list.status === 'error') return { ...HOST, listFailed: true };
  if (override?.templateId === 'host') return HOST;
  const { templates, rows } = list;
  if (!templates.some((t) => fits(t, aspects))) return HOST;
  if (reg === null) {
    return registryFailed
      ? { ...HOST, registryFailed: true }
      : { ...HOST, shown: { kind: 'wait' } };
  }
  const isBroken = brokenCheck(rows, reg, crashed);
  // «Открыть через X» (§8.4) — разово и только исправным подходящим шаблоном; иначе — обычный выбор.
  const forcedId = templates.find((t) => t.id === override?.templateId && fits(t, aspects))?.id;
  const forced = rows.find((r) => r.id === forcedId);
  if (forced !== undefined && isBroken(forced.id) === null) {
    return { ...HOST, shown: { kind: 'own', row: forced } };
  }
  const choice = chooseTemplate({ aspects }, templates, isBroken);
  if (choice.kind !== 'template') {
    // `own-body` сюда не доходит: запись-страницу экран показывает своим телом (`PageView`).
    return { ...HOST, broken: choice.kind === 'host' ? choice.broken : [] };
  }
  const row = rows.find((r) => r.id === choice.id);
  if (row === undefined) return { ...HOST, broken: choice.broken };
  return { ...HOST, shown: { kind: 'own', row }, dispute: choice.dispute, broken: choice.broken };
}

/** §4.2 шаг 7: причина «не разобран» (или «ошибка отрисовки» на этой записи) — `null`, если исправен. */
const brokenCheck =
  (rows: readonly WireEntity[], reg: ParseRegistry, crashed: ReadonlyMap<string, string>) =>
  (id: string): string | null =>
    crashed.get(id) ?? templateBrokenReason(rows.find((r) => r.id === id)?.body ?? '', reg);

/**
 * Подходящие исправные шаблоны записи — те, которыми её можно «Открыть через „X“» (§8.4). Выбор
 * (`chooseTemplate`) проверяет исправность только тех, до кого дошёл, и сломанный шаблон, которому
 * очередь не пришла, в его `broken` не попадает; пункт, после которого на экране то же самое (выбор
 * отверг бы сломанный), был бы обманом. Реестра нет — проверить нечем: пусто.
 */
function openableOf(
  aspects: readonly string[],
  list: ReturnType<typeof usePageTemplates>,
  reg: ParseRegistry | null,
  crashed: ReadonlyMap<string, string>,
): readonly string[] {
  if (reg === null || list.status !== 'ok') return [];
  const isBroken = brokenCheck(list.rows, reg, crashed);
  return list.templates.filter((t) => fits(t, aspects) && isBroken(t.id) === null).map((t) => t.id);
}

const NO_CRASHES: ReadonlyMap<string, string> = new Map();

/**
 * Чем рисуется шаблон хоста (срез 1б §9.2): телом записи поставки «Шаблон хоста», если она есть, не
 * в архиве и не сломана, — иначе эталоном из кода. Правка этой записи владельцем (настройкой,
 * агентом) и есть правка вида всех записей без своего шаблона.
 */
interface HostSource {
  /** Дерево, которым рисуется шаблон хоста. */
  nodes: readonly PageNode[];
  /** Его текст — «Изменить вид только этой записи» копирует показанное, а не эталон. */
  text: string;
  /** Живая запись «Шаблон хоста» (её настраивает «⋯»); `null` — записи нет или она в архиве. */
  recordId: string | null;
  /** Почему запись не взята — показан эталон кода с плашкой; `null` — взята или её нет. */
  broken: string | null;
}

const ETALON_SOURCE: HostSource = {
  nodes: HOST_TEMPLATE_NODES,
  text: HOST_TEMPLATE_TEXT,
  recordId: null,
  broken: null,
};

/**
 * Сломана ли запись шаблона хоста — тем же правилом, что шаблон владельца (1а §4.2 шаг 7: любая
 * проблема тела исключает шаблон целиком). Без реестра проверимо всё, кроме блоков данных (их
 * разбору нужен реестр): запись рисуется, а блок данных, если он сломан, скажет о себе сам — до
 * приезда реестра, который решит окончательно.
 */
function hostBrokenReason(body: string, reg: ParseRegistry | null): string | null {
  if (reg !== null) return templateBrokenReason(body, reg);
  const [first] = renderIssues(parsePageText(body), 'template').values();
  return first?.message ?? null;
}

function hostSourceOf(record: WireEntity | undefined, reg: ParseRegistry | null): HostSource {
  if (record === undefined) return ETALON_SOURCE;
  const broken = hostBrokenReason(record.body, reg);
  if (broken !== null) return { ...ETALON_SOURCE, recordId: record.id, broken };
  return { nodes: parsePageText(record.body), text: record.body, recordId: record.id, broken };
}

/**
 * Чем запись показана сейчас — для меню ⋮ (спека §8.4): «Открыть через шаблон хоста» только при
 * своём шаблоне, «Открыть через „X“» — прочими исправными, «Изменить вид только этой» — текстом
 * показанного, «Сменить выбор» — спорящими БЕЗ сломанных (те же `brokenIds`, что у выбора, —
 * иначе меню и плашка разошлись бы).
 *
 * Отсюда, а не второй копией выбора в экране: исключения за падение при рендере знает только
 * этот компонент. `templateId: null` — выбор ещё ждёт реестр.
 */
export interface RecordShown {
  entityId: string;
  templateId: string | 'host' | null;
  brokenIds: readonly string[];
  /** Подходящие исправные шаблоны, в том числе показанный (`openableOf`). */
  openable: readonly string[];
  /** Запись «Шаблон хоста» (срез 1б §9.2) — «⋯ → Настроить шаблон хоста»; `null` — её нет. */
  hostRecordId: string | null;
  /**
   * Текст шаблона хоста, которым запись показана бы через хост (тело записи поставки или эталон);
   * `null` — записи поставки ещё едут, и какой текст настоящий, не известно.
   */
  hostText: string | null;
}

/** «Сменить выбор шаблона для таких записей» (§4.3): плашка спора по требованию, `n` — номер просьбы. */
export interface DisputeRequest {
  contenders: readonly string[];
  n: number;
}

/**
 * Запись (не страница) — через шаблон (спека страниц 1а §4.2): свой шаблон владельца по функции
 * выбора или шаблон хоста — тело записи поставки «Шаблон хоста» (срез 1б §9.2; `HostSource`). Плашки
 * спора, сломанных шаблонов, сломанного шаблона хоста и не приехавшего списка — над рендером.
 *
 * Данные обвязки — `reply`, ответ `entity.get` экрана (`DETAIL_INCLUDE`, ключ `detailGetInput`):
 * второго запроса записи нет (РП-13), оптимистичные правки `{{title}}` видны сразу. `this` —
 * показываемая запись (§6.4).
 *
 * Гарантии (§8.3, §4.2 шаги 7–8): шаблон владельца, упавший при рендере, считается сломанным с
 * причиной «ошибка отрисовки», и выбор повторяется без него; запись шаблона хоста сломана, в архиве
 * или упала — эталон кода (1б §9.2); упал и он — базовый вид.
 * Карточки аспектов, не размещённые шаблоном, дописываются в конец (`appendUnplacedCards`).
 */
export function RecordView({
  reply,
  override,
  readOnly = false,
  onShown,
  disputeRequest,
  onConfigureTemplate,
  preview,
}: {
  reply: EntityGetReply;
  /** «Открыть через X» / «через шаблон хоста» (§8.4) — разовый выбор экрана, не запоминается. */
  override?: { templateId: string | 'host' };
  /** Предпросмотр шаблона на чужой записи (§9.3): запись только для чтения целиком (`RecordHostValue.readOnly`). */
  readOnly?: boolean;
  /** Извещение экрана о показанном (меню ⋮); зовётся на смене, а не на каждом кадре. */
  onShown?: (shown: RecordShown) => void;
  /** Плашка спора по требованию меню — и тогда, когда выбор запомнен (§4.3). */
  disputeRequest?: DisputeRequest;
  /** Настройка шаблона по плашке «не разобран» (§4.2 шаг 7, §9.1); не задан — плашка без кнопки. */
  onConfigureTemplate?: (templateId: string) => void;
  /**
   * Предпросмотр (§9.3): запись показана ЭТИМ шаблоном, мимо выбора — черновик шаблона выбору
   * вообще не виден (у него нет «Шаблон для»), а у готового шаблона выбор мог бы предпочесть
   * другой. Плашек выбора при этом нет: выбора не было.
   */
  preview?: TemplateText;
}) {
  const { entity } = reply;
  const list = usePageTemplates();
  const supply = useSupplyRecords();
  const { registry, failed } = useFieldCatalog();
  /**
   * Отказ реестра — ЛИПКИЙ, пока реестра нет. Шаблон хоста, показанный после отказа, монтирует
   * новых читателей реестра, а React Query на монтировании перезапрашивает упавший запрос и на это
   * время сбрасывает его в «ещё едет» (`retryOnMount`). Без памяти экран качался бы: отказ → хост →
   * «едет» → ожидание (хост размонтирован) → отказ → … Приехал реестр — признак не читается вовсе.
   */
  const [registryFailed, setRegistryFailed] = useState(false);
  if (failed && !registryFailed) setRegistryFailed(true);
  const reg = registry?.parse ?? null;
  // «План → факт» — состояние хоста (Ф-1а-18): поднимает его чекбокс `{{title}}`, показывает
  // карточка `orbis/financial`, где бы шаблон их ни поставил.
  const planToFact = usePlanToFactPrompt();
  /**
   * Шаблоны, упавшие при рендере НА ЭТОЙ записи. Поломка отрисовки зависит от данных записи, и на
   * соседней записи тот же шаблон вправе отрисоваться: память привязана к id и на переходе (экран
   * монтируется без key) просто перестаёт действовать.
   */
  const [crashes, setCrashes] = useState<{ of: string; ids: ReadonlyMap<string, string> }>({
    of: entity.id,
    ids: NO_CRASHES,
  });
  const crashed = crashes.of === entity.id ? crashes.ids : NO_CRASHES;
  const markCrashed = useCallback(
    (templateId: string) =>
      setCrashes((prev) => ({
        of: entity.id,
        ids: new Map(prev.of === entity.id ? prev.ids : NO_CRASHES).set(
          templateId,
          RENDER_CRASH_REASON,
        ),
      })),
    [entity.id],
  );

  const decision = useMemo(
    () =>
      preview !== undefined
        ? { ...HOST, shown: { kind: 'preview' as const, template: preview } }
        : decide(entity.aspects, list, reg, registryFailed, crashed, override),
    [entity.aspects, list, reg, registryFailed, crashed, override, preview],
  );
  const hostRecord = supply.byKey.get(HOST_TEMPLATE_KEY);
  /**
   * Запись шаблона хоста, упавшая при рендере НА ЭТОЙ записи, — ключом «запись экрана + запись шаблона +
   * её тело»: правка тела или переход на соседнюю запись снимают признак сами. Падение — та же поломка,
   * что неразобранное (§9.2): показ идёт эталоном, и ВСЁ, что говорит о показанном (плашка, текст для
   * «Изменить вид» в меню), говорит об эталоне, а не о теле, которое не отрисовалось.
   */
  const [hostCrash, setHostCrash] = useState<string | null>(null);
  const hostCrashKey =
    hostRecord === undefined ? null : `${entity.id}\n${hostRecord.id}\n${hostRecord.body}`;
  const hostSource = useMemo(() => {
    const source = hostSourceOf(hostRecord, reg);
    return hostCrashKey !== null && hostCrash === hostCrashKey && source.broken === null
      ? { ...ETALON_SOURCE, recordId: source.recordId, broken: RENDER_CRASH_REASON }
      : source;
  }, [hostRecord, reg, hostCrash, hostCrashKey]);
  const markHostCrashed = useCallback(() => setHostCrash(hostCrashKey), [hostCrashKey]);
  const host = recordHostValue(reply, { planToFact, activeTab: 'record', readOnly });
  const titleOf = (id: string) => list.rows.find((r) => r.id === id)?.title ?? id;

  const shownId =
    decision.shown.kind === 'own'
      ? decision.shown.row.id
      : decision.shown.kind === 'host'
        ? 'host'
        : decision.shown.kind === 'preview'
          ? decision.shown.template.id
          : null;
  // Строками — чтобы новые массивы с теми же id не будили экран лишним кадром.
  const brokenKey = decision.broken.map((b) => b.id).join(',');
  const openableKey = useMemo(
    () => openableOf(entity.aspects, list, reg, crashed).join(','),
    [entity.aspects, list, reg, crashed],
  );
  const hostText = supply.status === 'loading' ? null : hostSource.text;
  useEffect(() => {
    const ids = (key: string) => (key === '' ? [] : key.split(','));
    onShown?.({
      entityId: entity.id,
      templateId: shownId,
      brokenIds: ids(brokenKey),
      openable: ids(openableKey),
      hostRecordId: hostSource.recordId,
      hostText,
    });
  }, [onShown, entity.id, shownId, brokenKey, openableKey, hostSource.recordId, hostText]);
  const configureHost =
    onConfigureTemplate !== undefined && hostSource.recordId !== null
      ? () => onConfigureTemplate(hostSource.recordId as string)
      : undefined;

  // Спор, найденный выбором, — сам по себе; просьба меню показывает плашку и при запомненном
  // выборе. Своё «закрыто» у плашки — про ЭТОТ спор на ЭТОЙ записи, а у просьбы — ещё и про её
  // номер: повторная просьба после выбора обязана показать плашку снова.
  const dispute =
    decision.dispute !== null
      ? { contenders: decision.dispute, key: 'auto' }
      : disputeRequest !== undefined
        ? { contenders: disputeRequest.contenders, key: `asked-${disputeRequest.n}` }
        : null;

  return (
    <RecordHostProvider value={host}>
      <ThisEntityProvider id={entity.id}>
        <div data-testid="record-view" className="flex flex-col gap-6 px-4 pb-10 pt-5 md:px-6">
          {decision.listFailed && <TemplatesErrorPlaque />}
          {decision.registryFailed && <RegistryErrorPlaque />}
          {decision.broken.map((b) => (
            <BrokenTemplatePlaque
              key={b.id}
              broken={b}
              title={titleOf(b.id)}
              {...(onConfigureTemplate !== undefined && {
                onConfigure: () => onConfigureTemplate(b.id),
              })}
            />
          ))}
          {/* О шаблоне хоста — только когда запись им и показана: у записи со своим шаблоном
              поломка запасного шаблона ничего на экране не меняет. */}
          {decision.shown.kind === 'host' && hostSource.broken !== null && (
            <HostTemplateBrokenPlaque
              reason={hostSource.broken}
              {...(configureHost !== undefined && { onConfigure: configureHost })}
            />
          )}
          {dispute !== null && (
            <DisputePlaque
              key={`${entity.id}:${dispute.contenders.join(',')}:${dispute.key}`}
              contenders={dispute.contenders}
              rows={list.rows}
            />
          )}
          <ShownTemplate
            shown={decision.shown}
            host={hostSource}
            entityId={entity.id}
            onOwnCrash={markCrashed}
            onHostCrash={markHostCrashed}
          />
        </div>
      </ThisEntityProvider>
    </RecordHostProvider>
  );
}

function ShownTemplate({
  shown,
  host,
  entityId,
  onOwnCrash,
  onHostCrash,
}: {
  shown: Shown;
  host: HostSource;
  entityId: string;
  onOwnCrash: (templateId: string) => void;
  onHostCrash: () => void;
}) {
  if (shown.kind === 'wait') {
    return (
      <div data-testid="record-view-wait" className="flex flex-col gap-4">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-24" />
      </div>
    );
  }
  if (shown.kind === 'host') {
    // Одна граница и одно дерево на обе формы шаблона хоста: смена «эталон ↔ запись» (записи
    // поставки приехали, запись починили или сломали) не перемонтирует вкладки и тело.
    // Упала запись — ничего не рисуем сами: о падении узнаёт экран (`onCatch`), и следующим кадром
    // здесь эталон, а над ним плашка. Упал эталон — последняя ступень, базовый вид (1а §4.2 шаг 8).
    const record = host.nodes !== HOST_TEMPLATE_NODES;
    return (
      <RenderBoundary
        resetKey={record ? `${entityId}:host-record:${host.text}` : `${entityId}:host`}
        fallback={record ? null : <BaseRecordView />}
        {...(record && { onCatch: onHostCrash })}
      >
        <TemplateTree scope="template:host" nodes={host.nodes} />
      </RenderBoundary>
    );
  }
  if (shown.kind === 'preview') {
    const { template } = shown;
    // Выбирать следующий некого — предпросмотр показывает ровно этот шаблон; упал — так и сказано.
    return (
      <RenderBoundary
        key={template.id}
        resetKey={`${entityId}:${template.id}:${template.body}`}
        fallback={
          <BlockPlaque message={`Шаблон не отрисовался на этой записи: ${RENDER_CRASH_REASON}.`} />
        }
      >
        <OwnTemplateTree row={template} />
      </RenderBoundary>
    );
  }
  const { row } = shown;
  return (
    // Упавший шаблон владельца ничего не рисует сам: о падении узнаёт выбор (`onCatch`), и на
    // следующем кадре на этом месте уже следующий кандидат или шаблон хоста с плашкой.
    <RenderBoundary
      key={row.id}
      resetKey={`${entityId}:${row.id}`}
      fallback={null}
      onCatch={() => onOwnCrash(row.id)}
    >
      <OwnTemplateTree row={row} />
    </RenderBoundary>
  );
}

function OwnTemplateTree({ row }: { row: TemplateText }) {
  const nodes = useMemo(() => parsePageText(row.body), [row.body]);
  return <TemplateTree scope={`template:${row.id}`} nodes={nodes} />;
}

/**
 * Дерево шаблона на показ. key по шаблону: другой шаблон — другое дерево, и вкладки, открытые в
 * одном, не должны переехать в другой. Память вкладок экрана — в пространстве шаблона
 * (`template:<id>`): одна на все записи этого шаблона — листая записи с «Деталей», человек на
 * «Деталях» и остаётся. У страницы своим телом пространство своё, по странице (`DetailScreen`).
 */
function TemplateTree({ scope, nodes }: { scope: string; nodes: readonly PageNode[] }) {
  return (
    <TabMemoryScope key={scope} scope={scope}>
      <Renderer nodes={nodes} kind="template" appendUnplacedCards />
    </TabMemoryScope>
  );
}

interface BoundaryProps {
  /** Смена значения снимает прошлый провал (приём `ChunkErrorBoundary`). */
  resetKey: string;
  fallback: ReactNode;
  onCatch?: () => void;
  children: ReactNode;
}
interface BoundaryState {
  failed: boolean;
  shownFor: string | undefined;
}

/**
 * Граница ошибок шаблона: упавший рендер шаблона не уносит экран записи целиком (шапка, меню,
 * слой предложения живут над ней), а превращается в выбор следующего (§4.2 шаги 7–8).
 */
class RenderBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false, shownFor: undefined };

  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: BoundaryProps,
    state: BoundaryState,
  ): BoundaryState | null {
    if (props.resetKey === state.shownFor) return null;
    return { failed: false, shownFor: props.resetKey };
  }

  componentDidCatch() {
    this.props.onCatch?.();
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
