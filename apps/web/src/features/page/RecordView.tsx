// Листовые сабпаты, не баррель `@orbis/shared/doc`: экран записи тянет этот модуль эагерно
// (сторожа `check-lazy-chunks.ts` и `save.test.tsx`).
import { type BrokenTemplate, chooseTemplate, type TemplateCandidate } from '@orbis/shared';
import { type PageNode, parsePageText } from '@orbis/shared/doc/page-grammar';
import { templateBrokenReason } from '@orbis/shared/doc/placement';
import type { ParseRegistry } from '@orbis/shared/query';
import { Component, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { ThisEntityProvider } from '../../lib/query-blocks/this-entity';
import { useFieldCatalog } from '../../lib/query-blocks/useFieldCatalog';
import type { RouterOutputs } from '../../trpc';
import { Skeleton } from '../../ui/Skeleton';
import { usePlanToFactPrompt } from '../budget/usePlanToFactPrompt';
import { RecordHostProvider, recordHostValue, type WireEntity } from '../entity-detail/record-host';
import { BaseRecordView } from './BaseRecordView';
import { HOST_TEMPLATE_NODES } from './host-template';
import { Renderer } from './Renderer';
import { TabMemoryScope } from './TabsContainer';
import {
  BrokenTemplatePlaque,
  DisputePlaque,
  RegistryErrorPlaque,
  TemplatesErrorPlaque,
} from './TemplatePlaques';
import { usePageTemplates } from './usePageTemplates';

type EntityGetReply = RouterOutputs['entity']['get'];

/** Причина исключения шаблона, упавшего при рендере (§4.2 шаг 7: «не разобран: <причина>»). */
export const RENDER_CRASH_REASON = 'ошибка отрисовки';

/** Чем показать запись: шаблон хоста, шаблон владельца или — пока выбор не решён — заглушкой. */
type Shown = { kind: 'host' } | { kind: 'own'; row: WireEntity } | { kind: 'wait' };

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
}

/** «Сменить выбор шаблона для таких записей» (§4.3): плашка спора по требованию, `n` — номер просьбы. */
export interface DisputeRequest {
  contenders: readonly string[];
  n: number;
}

/**
 * Запись (не страница) — через шаблон (спека страниц 1а §4.2): свой шаблон владельца по функции
 * выбора или шаблон хоста (§8.1). Плашки спора, сломанных шаблонов и не приехавшего списка — над
 * рендером.
 *
 * Данные обвязки — `reply`, ответ `entity.get` экрана (`DETAIL_INCLUDE`, ключ `detailGetInput`):
 * второго запроса записи нет (РП-13), оптимистичные правки `{{title}}` видны сразу. `this` —
 * показываемая запись (§6.4).
 *
 * Гарантии (§8.3, §4.2 шаги 7–8): шаблон владельца, упавший при рендере, считается сломанным с
 * причиной «ошибка отрисовки», и выбор повторяется без него; упал шаблон хоста — базовый вид.
 * Карточки аспектов, не размещённые шаблоном, дописываются в конец (`appendUnplacedCards`).
 */
export function RecordView({
  reply,
  override,
  readOnlyBody = false,
  onShown,
  disputeRequest,
}: {
  reply: EntityGetReply;
  /** «Открыть через X» / «через шаблон хоста» (§8.4) — разовый выбор экрана, не запоминается. */
  override?: { templateId: string | 'host' };
  /** Предпросмотр шаблона на чужой записи (§9.3): тело только для чтения. */
  readOnlyBody?: boolean;
  /** Извещение экрана о показанном (меню ⋮); зовётся на смене, а не на каждом кадре. */
  onShown?: (shown: RecordShown) => void;
  /** Плашка спора по требованию меню — и тогда, когда выбор запомнен (§4.3). */
  disputeRequest?: DisputeRequest;
}) {
  const { entity } = reply;
  const list = usePageTemplates();
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
    () => decide(entity.aspects, list, reg, registryFailed, crashed, override),
    [entity.aspects, list, reg, registryFailed, crashed, override],
  );
  const host = recordHostValue(reply, { planToFact, activeTab: 'record', readOnlyBody });
  const titleOf = (id: string) => list.rows.find((r) => r.id === id)?.title ?? id;

  const shownId =
    decision.shown.kind === 'own'
      ? decision.shown.row.id
      : decision.shown.kind === 'host'
        ? 'host'
        : null;
  // Строками — чтобы новые массивы с теми же id не будили экран лишним кадром.
  const brokenKey = decision.broken.map((b) => b.id).join(',');
  const openableKey = useMemo(
    () => openableOf(entity.aspects, list, reg, crashed).join(','),
    [entity.aspects, list, reg, crashed],
  );
  useEffect(() => {
    const ids = (key: string) => (key === '' ? [] : key.split(','));
    onShown?.({
      entityId: entity.id,
      templateId: shownId,
      brokenIds: ids(brokenKey),
      openable: ids(openableKey),
    });
  }, [onShown, entity.id, shownId, brokenKey, openableKey]);

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
            <BrokenTemplatePlaque key={b.id} broken={b} title={titleOf(b.id)} />
          ))}
          {dispute !== null && (
            <DisputePlaque
              key={`${entity.id}:${dispute.contenders.join(',')}:${dispute.key}`}
              contenders={dispute.contenders}
              rows={list.rows}
            />
          )}
          <ShownTemplate shown={decision.shown} entityId={entity.id} onOwnCrash={markCrashed} />
        </div>
      </ThisEntityProvider>
    </RecordHostProvider>
  );
}

function ShownTemplate({
  shown,
  entityId,
  onOwnCrash,
}: {
  shown: Shown;
  entityId: string;
  onOwnCrash: (templateId: string) => void;
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
    return (
      <RenderBoundary resetKey={`${entityId}:host`} fallback={<BaseRecordView />}>
        <TemplateTree scope="template:host" nodes={HOST_TEMPLATE_NODES} />
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

function OwnTemplateTree({ row }: { row: WireEntity }) {
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
