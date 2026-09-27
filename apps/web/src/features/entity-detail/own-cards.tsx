import { ownCardOrder } from '@orbis/shared';
import { EXTENSION_CARDS, type OwnCard } from '../../app/extension-registry';
import { useNav } from '../../state/navigation';
import { AspectSection, AspectSections } from './AspectSection';
import { AssignmentCard } from './AssignmentCard';
import { ROUTINE_ASPECT, RoutineStatusBlock } from './RoutineStatusBlock';
import { RunFeed } from './RunFeed';
import { RunsList } from './RunsList';
import { useRecordHost, type WireEntity } from './record-host';
import { TicketWaitingBlock } from './TicketWaitingBlock';
import { RUN_ASPECT, useTicketRuns } from './useTicketRuns';

/**
 * Свои карточки аспектов — объявлением «аспект → карточка» (спека страниц 1а §7.3), а не
 * ветками `if` экрана записи. С 1б (§4.1, §8.5) карточки — двух родов: карточки ЯДРА (исполнитель,
 * рутина, прогон) живут здесь, карточки РАСШИРЕНИЙ (цель, финансы) — в каталогах расширений, и ядро
 * берёт их только через реестр карточек (`app/extension-registry.tsx`, РП-23). Порядок и ранги
 * объявляет shared (`ownCardOrder()`: хост и манифесты).
 *
 * Карточка собирается из частей, которые экран записи до среза 1а разносил по вкладкам: прогресс
 * цели наверху «Сущности», её поля — в «Деталях»; ожидание тикета наверху, назначение — в
 * «Деталях». Шаблон ставит карточку одним куском (спека 1а §8.2 (3)). Данные у всех частей — из
 * хоста записи (`record-host.tsx`), своих пропов у карточки нет.
 */

const TASK = 'orbis/task';
const ASSIGNMENT = 'orbis/assignment';

const CARD_CLASS = 'flex flex-col gap-6';

/**
 * Назначение: карточка исполнителя, а у тикета (задача С назначением) — ещё ожидание человека и
 * история прогонов. Карточка стоит и у простой задачи без назначения (см. `showWhen` в
 * объявлении), поэтому тикет — это задача И назначение, как у экрана записи: у назначения без
 * задачи и у задачи без назначения прогонов не бывает, и платить за них запросом не за что.
 *
 * История прогонов — одна на запись (остаток 1а №29): у тикета, который сам рутина, она — часть
 * карточки рутины, как моделирует `ownCardParts(isRoutine)` (`intended-1a.ts`). Шаблон, не
 * поставивший карточку рутины, получит её дописыванием хоста или `{{cards}}` (§8.3 1а). Запрос
 * прогонов остаётся: последний прогон нужен ожиданию тикета.
 */
function AssignmentOwnCard() {
  const { entity } = useRecordHost();
  const push = useNav((s) => s.push);
  const navTab = useNav((s) => s.activeTab);
  const isTicket = entity.aspects.includes(TASK) && entity.aspects.includes(ASSIGNMENT);
  const isRoutine = entity.aspects.includes(ROUTINE_ASPECT);
  const { runs, lastRun } = useTicketRuns(entity.id, isTicket);
  return (
    <div className={CARD_CLASS}>
      <AssignmentCard entity={entity} />
      {/* key по id — экран монтируется БЕЗ key (router.tsx): набранный, но не отправленный
          ответ переехал бы на соседний тикет. */}
      {isTicket && (
        <TicketWaitingBlock key={`waiting-${entity.id}`} entity={entity} lastRun={lastRun} />
      )}
      {isTicket && !isRoutine && (
        <RunsList
          parentId={entity.id}
          runs={runs}
          onOpen={(id) => push(navTab, { kind: 'entity', id })}
        />
      )}
    </div>
  );
}

function RoutineCard() {
  const { entity } = useRecordHost();
  const push = useNav((s) => s.push);
  const navTab = useNav((s) => s.activeTab);
  const { runs, lastRun } = useTicketRuns(entity.id, true);
  return (
    <div className={CARD_CLASS}>
      <AspectSection entity={entity} aspectId={ROUTINE_ASPECT} />
      {/* key — у блока своё состояние (отказ «прогон уже идёт»), и переезжать на соседнюю
          рутину оно не должно. */}
      <RoutineStatusBlock key={`routine-${entity.id}`} entity={entity} lastRun={lastRun} />
      {/* У рутины исполнитель внутренний и всегда один — колонка гранта ей не положена (Р-8). */}
      <RunsList
        parentId={entity.id}
        runs={runs}
        showGrant={false}
        onOpen={(id) => push(navTab, { kind: 'entity', id })}
      />
    </div>
  );
}

function AgentRunCard() {
  const { entity } = useRecordHost();
  // key — лента держит своё состояние (открытое подтверждение отката), и переезжать на
  // соседний прогон оно не должно.
  return <RunFeed key={`run-${entity.id}`} entity={entity} />;
}

const hasAspect =
  (aspectId: string) =>
  (entity: Pick<WireEntity, 'aspects'>): boolean =>
    entity.aspects.includes(aspectId);

/**
 * Свои карточки ЯДРА (спека 1б §4.1) — у хоста; ранги у них в `HOST_OWN_CARDS` (shared).
 *
 * Назначение и прогон — карточки БЕЗ общей секции свойств: её заменяет своя карточка (прежде —
 * `HIDDEN_ASPECT_CARDS`, затем `SECTION_REPLACED`). Дело не в дублировании вида, а в правке.
 * Общая секция предлагает контрол на каждое правимое свойство, и правка `orbis/executor` в обход
 * согласованности исполнителя (executor=agent ⇔ есть грант, строки каталога
 * `assignment_grant_required`/`_forbidden`, `builtin-rules.ts`) отдавала бы отказ `INVARIANT` на
 * каждом втором нажатии: пару меняет только карточка назначения, одним патчем. Свойства прогона
 * от этого не зависят — они `system_writable` и без того только для чтения, — но лента шагов
 * рассказывает о прогоне несравнимо больше, чем девятнадцать строк. У остальных своих карточек
 * (цель, рутина, финансы) общая секция есть — она их часть.
 */
const CORE_CARDS: Readonly<Record<string, OwnCard>> = {
  // Карточка стоит у ЛЮБОЙ задачи: исполнителя ставит владелец, и этим жестом задача становится
  // тикетом. Спроси мы наличие аспекта — у простой задачи путь назначить исполнителя пропал бы.
  [ASSIGNMENT]: {
    Card: AssignmentOwnCard,
    showWhen: (entity) => entity.aspects.includes(TASK) || entity.aspects.includes(ASSIGNMENT),
    extension: null,
  },
  [ROUTINE_ASPECT]: { Card: RoutineCard, showWhen: hasAspect(ROUTINE_ASPECT), extension: null },
  [RUN_ASPECT]: { Card: AgentRunCard, showWhen: hasAspect(RUN_ASPECT), extension: null },
};

/** Своя карточка с местом в `{{cards: own}}`: аспект и ранг — из объявления shared. */
export type RankedOwnCard = OwnCard & { aspect: string; rank: number };

/**
 * Карточки ядра и расширений В ПОРЯДКЕ РАНГОВ (`ownCardOrder()`, §8.5): ранг принадлежит
 * карточке, а не аспекту, — карточка исполнителя стоит своим рангом, по какому бы аспекту она ни
 * показывалась. Считается один раз: объявления — код поставки, во время работы они не меняются.
 *
 * Объявление без компонента — не «ничего»: карточка молча пропала бы с экрана. Такого в поставке
 * нет (сверка — `extension-registry.test.tsx`), и сборка, где оно случилось, падает здесь.
 */
const RANKED: readonly RankedOwnCard[] = ownCardOrder().map((decl) => {
  const card = CORE_CARDS[decl.aspect] ?? EXTENSION_CARDS[decl.aspect];
  if (card === undefined) throw new Error(`у своей карточки ${decl.aspect} нет компонента`);
  return { ...card, aspect: decl.aspect, rank: decl.rank };
});

export function ownCardComponents(): readonly RankedOwnCard[] {
  return RANKED;
}

/** Объявление «аспект → своя карточка» (§7.3) в порядке рангов. Аспект вне него — общая секция. */
export const OWN_ASPECT_CARDS: Readonly<Record<string, OwnCard>> = Object.fromEntries(
  RANKED.map((c) => [c.aspect, c]),
);

/**
 * Карточка аспекта `{{card: X}}`: своя из объявления (по её `showWhen`) или общая секция.
 * Ничего — если записи карточка не положена (§5.3): шаблон пишется на набор аспектов, а запись
 * вправе нести не все.
 */
export function AspectCardFor({ aspectId }: { aspectId: string }) {
  const { entity } = useRecordHost();
  const own = OWN_ASPECT_CARDS[aspectId];
  if (own !== undefined) return own.showWhen(entity) ? <own.Card /> : null;
  if (!entity.aspects.includes(aspectId)) return null;
  return <AspectSection entity={entity} aspectId={aspectId} />;
}

/**
 * `{{cards}}` и дописывание хоста (§5.3, §8.3) — карточки всех аспектов записи, не размещённых
 * шаблоном (`placed`): СВОИ карточки тех, кому они положены (`showWhen`), затем общие секции
 * остальных и секция «Свойства».
 *
 * Своя карточка стоит целиком, а не одной секцией полей: у шаблона владельца без `card:` иначе
 * пропало бы всё, чего в общей секции нет, — назначение и лента прогона целиком, прогресс цели,
 * состояние рутины (ревью задачи 12, I-3). Секция полей аспекта со своей карточкой здесь не
 * повторяется — она часть карточки (или заменена ею — у назначения и прогона, см. объявление).
 *
 * Вкладка «Детали» шаблона хоста — это `{{cards}}` в дереве с `{{cards: own}}`: все свои карточки
 * размещены им (рендерер кладёт их в `placed`, спека 1б §8.5), и остаются общие секции прочих
 * аспектов и секция «Свойства».
 */
export function RestCards({ placed }: { placed: ReadonlySet<string> }) {
  const { entity } = useRecordHost();
  const own = Object.entries(OWN_ASPECT_CARDS).filter(
    ([aspectId, card]) => !placed.has(aspectId) && card.showWhen(entity),
  );
  const exclude = new Set([...Object.keys(OWN_ASPECT_CARDS), ...placed]);
  return (
    <div className="flex flex-col gap-6">
      {own.map(([aspectId, { Card }]) => (
        <Card key={aspectId} />
      ))}
      <AspectSections entity={entity} exclude={exclude} />
    </div>
  );
}
