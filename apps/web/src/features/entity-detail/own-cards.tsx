import type { ComponentType } from 'react';
import { useNav } from '../../state/navigation';
import { PlannedToFactCard } from '../budget/PlannedToFactCard';
import { AspectSection, AspectSections } from './AspectSection';
import { AssignmentCard } from './AssignmentCard';
import { GoalProgress } from './GoalProgress';
import { ROUTINE_ASPECT, RoutineStatusBlock } from './RoutineStatusBlock';
import { RunFeed } from './RunFeed';
import { RunsList } from './RunsList';
import { useRecordHost, type WireEntity } from './record-host';
import { TicketWaitingBlock } from './TicketWaitingBlock';
import { RUN_ASPECT, useTicketRuns } from './useTicketRuns';

/**
 * Свои карточки аспектов — объявлением «аспект → карточка» (спека страниц 1а §7.3), а не
 * ветками `if` экрана записи.
 *
 * Карточка собирается из частей, которые экран записи сегодня разносит по вкладкам: прогресс
 * цели наверху «Сущности», её поля — в «Деталях»; ожидание тикета наверху, назначение — в
 * «Деталях». Шаблон ставит карточку одним куском туда, где написан `{{card: X}}`. Данные у всех
 * частей — из хоста записи (`record-host.tsx`), своих пропов у карточки нет.
 */

const GOAL = 'orbis/goal';
const TASK = 'orbis/task';
const ASSIGNMENT = 'orbis/assignment';
const FINANCIAL = 'orbis/financial';
/** Единица прогресса цели — СВОЙСТВО (§А1-1), а не поле аспекта `orbis/goal`. */
const GOAL_UNIT = 'orbis/unit';

/**
 * Аспекты, у которых общей секции свойств на экране НЕТ вовсе — её заменяет своя карточка:
 * назначение исполнителя (AssignmentCard) и прогон агента (RunFeed на самом прогоне, RunsList на
 * тикете). Прежде — `HIDDEN_ASPECT_CARDS` в AspectCards.
 *
 * Дело не в дублировании вида, а в правке. Общая карточка предлагает контрол на каждое правимое
 * свойство, и правка `orbis/executor` в обход согласованности исполнителя (executor=agent ⇔ есть
 * грант, строки каталога `assignment_grant_required`/`_forbidden`, `builtin-rules.ts`) отдавала
 * бы отказ `INVARIANT` на каждом втором нажатии: пару меняет только карточка назначения, одним
 * патчем. Свойства прогона от этого не зависят — они `system_writable` и без того только для
 * чтения, — но лента шагов рассказывает о прогоне несравнимо больше, чем девятнадцать строк.
 *
 * У остальных своих карточек (цель, рутина, финансы) общая секция есть — она их часть.
 */
export const SECTION_REPLACED: ReadonlySet<string> = new Set([ASSIGNMENT, RUN_ASPECT]);

/** Полоса прогресса цели — если сервер её посчитал (`goalProgress` есть только у цели, E2). */
export function GoalProgressSlot() {
  const { entity, goalProgress } = useRecordHost();
  if (goalProgress === undefined) return null;
  const unit = entity.props[GOAL_UNIT];
  return (
    <GoalProgress progress={goalProgress} unit={typeof unit === 'string' ? unit : undefined} />
  );
}

/**
 * Карточка «план → факт» (§2.7) — по состоянию ХОСТА: поднимает его чекбокс `{{title}}`, где бы
 * тот ни стоял (Ф-1а-18).
 */
export function PlanToFactSlot() {
  const { planToFact } = useRecordHost();
  if (planToFact.prompt === null) return null;
  return <PlannedToFactCard prompt={planToFact.prompt} onClose={planToFact.dismiss} />;
}

const CARD_CLASS = 'flex flex-col gap-6';

function GoalCard() {
  const { entity } = useRecordHost();
  return (
    <div className={CARD_CLASS}>
      <AspectSection entity={entity} aspectId={GOAL} />
      <GoalProgressSlot />
    </div>
  );
}

/**
 * Назначение: карточка исполнителя, а у тикета (задача С назначением) — ещё ожидание человека и
 * история прогонов. Карточка стоит и у простой задачи без назначения (см. `showWhen` в
 * объявлении), поэтому тикет — это задача И назначение, как у экрана записи: у назначения без
 * задачи и у задачи без назначения прогонов не бывает, и платить за них запросом не за что.
 */
function AssignmentOwnCard() {
  const { entity } = useRecordHost();
  const push = useNav((s) => s.push);
  const navTab = useNav((s) => s.activeTab);
  const isTicket = entity.aspects.includes(TASK) && entity.aspects.includes(ASSIGNMENT);
  const { runs, lastRun } = useTicketRuns(entity.id, isTicket);
  return (
    <div className={CARD_CLASS}>
      <AssignmentCard entity={entity} />
      {/* key по id — экран монтируется БЕЗ key (router.tsx): набранный, но не отправленный
          ответ переехал бы на соседний тикет. */}
      {isTicket && (
        <TicketWaitingBlock key={`waiting-${entity.id}`} entity={entity} lastRun={lastRun} />
      )}
      {isTicket && (
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

function FinancialCard() {
  const { entity } = useRecordHost();
  return (
    <div className={CARD_CLASS}>
      <AspectSection entity={entity} aspectId={FINANCIAL} />
      <PlanToFactSlot />
    </div>
  );
}

/** Своя карточка аспекта: что рисовать и у какой записи. */
export interface OwnAspectCard {
  Card: ComponentType;
  /**
   * Показывать ли карточку у этой записи. Обычно — «аспект навешен», но не всегда: карточка
   * назначения стоит у ЛЮБОЙ задачи, потому что исполнителя ставит владелец, и именно этим жестом
   * задача становится тикетом. Спроси мы наличие аспекта — у простой задачи единственный путь
   * назначить исполнителя пропал бы (ревью задачи 12, I-2).
   */
  showWhen: (entity: Pick<WireEntity, 'aspects'>) => boolean;
}

const hasAspect =
  (aspectId: string) =>
  (entity: Pick<WireEntity, 'aspects'>): boolean =>
    entity.aspects.includes(aspectId);

/** Объявление «аспект → своя карточка» (§7.3). Аспект вне списка показывает общая секция. */
export const OWN_ASPECT_CARDS: Readonly<Record<string, OwnAspectCard>> = {
  [GOAL]: { Card: GoalCard, showWhen: hasAspect(GOAL) },
  [ASSIGNMENT]: {
    Card: AssignmentOwnCard,
    showWhen: (entity) => entity.aspects.includes(TASK) || entity.aspects.includes(ASSIGNMENT),
  },
  [ROUTINE_ASPECT]: { Card: RoutineCard, showWhen: hasAspect(ROUTINE_ASPECT) },
  [RUN_ASPECT]: { Card: AgentRunCard, showWhen: hasAspect(RUN_ASPECT) },
  [FINANCIAL]: { Card: FinancialCard, showWhen: hasAspect(FINANCIAL) },
};

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
 * повторяется — она часть карточки (или заменена ею, `SECTION_REPLACED`).
 *
 * Сегодняшние «Детали» экрана записи этим НЕ рисуются: там поля стоят в «Деталях», а прогресс и
 * прочие части — на «Сущности»; раскладку держит прежний `AspectCards` (снимок задачи 2).
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
