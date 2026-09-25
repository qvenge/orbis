import type { ComponentType } from 'react';
import { useNav } from '../../state/navigation';
import { PlannedToFactCard } from '../budget/PlannedToFactCard';
import { AspectSection, AspectSections } from './AspectSection';
import { AssignmentCard } from './AssignmentCard';
import { GoalProgress } from './GoalProgress';
import { ROUTINE_ASPECT, RoutineStatusBlock } from './RoutineStatusBlock';
import { RunFeed } from './RunFeed';
import { RunsList } from './RunsList';
import { useRecordHost } from './record-host';
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
 * Назначение: карточка исполнителя, а у тикета (задача с назначением) — ещё ожидание человека и
 * история прогонов. Условие тикета то же, что у экрана записи: у назначения без задачи
 * прогонов не бывает, и платить за них запросом не за что.
 */
function AssignmentOwnCard() {
  const { entity } = useRecordHost();
  const push = useNav((s) => s.push);
  const navTab = useNav((s) => s.activeTab);
  const isTicket = entity.aspects.includes(TASK);
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

/** Объявление «аспект → своя карточка» (§7.3). Аспект вне списка показывает общая секция. */
export const OWN_ASPECT_CARDS: Readonly<Record<string, ComponentType>> = {
  [GOAL]: GoalCard,
  [ASSIGNMENT]: AssignmentOwnCard,
  [ROUTINE_ASPECT]: RoutineCard,
  [RUN_ASPECT]: AgentRunCard,
  [FINANCIAL]: FinancialCard,
};

/**
 * Карточка аспекта `{{card: X}}`: своя из объявления или общая секция. Ничего — если аспекта на
 * записи нет (§5.3): шаблон пишется на набор аспектов, а запись вправе нести не все.
 */
export function AspectCardFor({ aspectId }: { aspectId: string }) {
  const { entity } = useRecordHost();
  if (!entity.aspects.includes(aspectId)) return null;
  const Own = OWN_ASPECT_CARDS[aspectId];
  if (Own !== undefined) return <Own />;
  return <AspectSection entity={entity} aspectId={aspectId} />;
}

/**
 * `{{cards}}` — общие секции аспектов записи, не размещённых шаблоном (`placed`), и секция
 * «Свойства».
 *
 * Аспекты со своей карточкой без общей секции (`SECTION_REPLACED`) сюда не входят никогда: их
 * вид — только своя карточка, и она ставится через `card:` или дописыванием хоста (§8.3). У
 * цели, рутины и финансов здесь — их секция полей, как на «Деталях» сегодня.
 */
export function RestCards({ placed }: { placed: ReadonlySet<string> }) {
  const { entity } = useRecordHost();
  const exclude = new Set([...SECTION_REPLACED, ...placed]);
  return <AspectSections entity={entity} exclude={exclude} />;
}
