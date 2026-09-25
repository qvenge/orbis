// Листовые сабпаты, не баррель `@orbis/shared/doc`: рендерер эагерно достижим из экрана записи, а
// баррель тянет схему документа (tiptap, marked) в первый кадр (сторожа `check-lazy-chunks.ts` и
// `save.test.tsx`).
import { PAGE_ASPECT } from '@orbis/shared';
import type { PageNode } from '@orbis/shared/doc/page-grammar';
import {
  aspectOfCardText,
  type BodyKind,
  bodyIssues,
  nodeAt,
  type PlacementIssue,
} from '@orbis/shared/doc/placement';
import type { ParseRegistry } from '@orbis/shared/query';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { Markdown } from '../../lib/markdown/Markdown';
import { BodyKindProvider } from '../../lib/query-blocks/body-kind';
import { useFieldCatalog } from '../../lib/query-blocks/useFieldCatalog';
import { openEntity } from '../../state/navigation';
import { AspectCardFor, RestCards } from '../entity-detail/own-cards';
import { RECORD_BLOCK_COMPONENTS } from '../entity-detail/record-blocks';
import { NO_REGISTRY } from '../entity-editor/EditorShell';
import { BlockPlaque } from './blocks/BlockPlaque';
import { DataBlock } from './blocks/DataBlock';
import { Columns } from './Columns';
import { TabsContainer } from './TabsContainer';

/**
 * Рендерер показа (спека страниц 1а §6.1): тело страницы или шаблона — на показ, без случайной
 * правки. Текст, колонки и вкладки — по-настоящему, блоки данных — с данными, блоки обвязки —
 * примитивами записи `this` из хоста (`RecordHostProvider`).
 *
 * Идёт по дереву ЛИСТОВОГО препрохода (`parsePageText`, РП-6), а не по документу редактора: схема
 * документа — 155 кБ gzip, и тянуть её в первый кадр каждого открытия записи ради показа нельзя.
 * Текст рисует тот же `Markdown`, что первый кадр тела, — показ и первый кадр не расходятся видом.
 *
 * Проблемы тела (`bodyIssues`, §5.5, §5.8) — плашками на месте своего узла: неуместный блок,
 * второй `{{body}}`, сломанный контейнер. Остальное тело рисуется: одна ошибка не гасит страницу.
 */

/**
 * Показывается ли запись СВОИМ телом: страница или шаблон, открытые сами на себе (`PageView`).
 *
 * Контекстом, а не пропом рендерера, — это знание места показа, а не дерева: тот же шаблон
 * рендерер рисует и на чужой записи (экран записи, задача 14), где `{{body}}` — её настоящее
 * тело в редакторе. Умолчание `false`: забытый провайдер покажет редактор тела, как экран записи,
 * а не молча спрячет тело.
 */
const OwnBodyContext = createContext(false);

export function OwnBodyProvider({ children }: { children: ReactNode }) {
  return <OwnBodyContext.Provider value={true}>{children}</OwnBodyContext.Provider>;
}

/** Что рендерер решил о дереве один раз, до обхода: плашки по путям и размещённые карточки. */
interface RenderPlan {
  /** Проблема узла по пути `path.join('.')` — формат пути в докблоке `bodyIssues`. */
  issues: ReadonlyMap<string, PlacementIssue>;
  /** Аспекты, размещённые `{{card: X}}` в этом дереве (и `orbis/page` при показе своим телом). */
  placed: ReadonlySet<string>;
  /** Есть ли в дереве рисуемый `{{cards}}` — тогда дописывать карточки в конец нечего. */
  hasCards: boolean;
  /** Реестр разбора; `null` — ещё едет. */
  reg: ParseRegistry | null;
  ownBody: boolean;
}

const RenderPlanContext = createContext<RenderPlan | null>(null);

function useRenderPlan(): RenderPlan {
  const plan = useContext(RenderPlanContext);
  if (plan === null) throw new Error('Узел страницы вне Renderer');
  return plan;
}

const pathKey = (path: readonly number[]): string => path.join('.');

/** Части контейнера как списки узлов — у колонок это сам массив, у вкладок — `children`. */
function partsOf(node: PageNode): readonly (readonly PageNode[])[] {
  if (node.kind === 'columns') return node.parts;
  if (node.kind === 'tabs') return node.parts.map((t) => t.children);
  return [];
}

function planRender(
  nodes: readonly PageNode[],
  kind: BodyKind,
  reg: ParseRegistry | null,
  ownBody: boolean,
): RenderPlan {
  // Проблемы узлов-запросов отброшены: о себе говорит сам `DataBlock` (разбор, абсолютная дата,
  // отказ сервера) — той же формулировкой, с кнопкой «Настроить». Вторая плашка на том же месте
  // повторила бы первую. Поэтому и реестр здесь пустой: он нужен `bodyIssues` только запросам.
  const issues = new Map<string, PlacementIssue>();
  for (const issue of bodyIssues(nodes, kind, NO_REGISTRY)) {
    if (nodeAt(nodes, issue.path).kind === 'query') continue;
    issues.set(pathKey(issue.path), issue);
  }

  const placed = new Set<string>();
  // РП-25: страница, показанная своим телом, не рисует карточку «Страница» ни в `{{cards}}`, ни
  // в дописывании. Иначе «Изменить вид только этой записи» не давал бы «как раньше» (С1а-8):
  // запись-страница несла бы лишнюю карточку. Через шаблон хоста («Открыть как запись») она
  // видна, как все.
  if (ownBody) placed.add(PAGE_ASPECT);
  let hasCards = false;
  // Только РИСУЕМЫЕ узлы: карточка в неуместном или сломанном месте не показана, и считать её
  // размещённой значило бы потерять её совсем — ни на месте, ни в конце.
  const visit = (list: readonly PageNode[], prefix: readonly number[]) => {
    list.forEach((node, i) => {
      const path = [...prefix, i];
      if (issues.has(pathKey(path))) return;
      if (node.kind === 'card' && reg !== null) {
        const aspect = aspectOfCardText(node.aspect, reg);
        if (aspect !== undefined) placed.add(aspect.id);
      } else if (node.kind === 'record' && node.name === 'cards') {
        hasCards = true;
      }
      for (const [p, part] of partsOf(node).entries()) visit(part, [...path, p]);
    });
  };
  visit(nodes, []);
  return { issues, placed, hasCards, reg, ownBody };
}

export function Renderer({
  nodes,
  kind,
  appendUnplacedCards,
}: {
  nodes: readonly PageNode[];
  kind: BodyKind;
  /** Гарантия хоста §8.3: карточки аспектов записи, не размещённые ни card:, ни cards, — в конец. Только шаблонам. */
  appendUnplacedCards: boolean;
}) {
  const { registry } = useFieldCatalog();
  const reg = registry?.parse ?? null;
  const ownBody = useContext(OwnBodyContext);
  const plan = useMemo(() => planRender(nodes, kind, reg, ownBody), [nodes, kind, reg, ownBody]);
  return (
    // Род тела — у всех блоков данных дерева: абсолютная дата законна в заметке и ошибка на
    // странице и в шаблоне (§5.6). Ставит его рендерер, а не вызывающий: род дерева и есть `kind`.
    <BodyKindProvider kind={kind}>
      <RenderPlanContext.Provider value={plan}>
        <div data-testid="page-render" className="flex flex-col gap-6">
          <NodeList nodes={nodes} prefix={[]} />
          {/* Пока реестр едет, размещённые карточки неизвестны: дописанная сейчас карточка
              через мгновение переехала бы на своё место `{{card: X}}`. */}
          {appendUnplacedCards && !plan.hasCards && reg !== null && (
            <RestCards placed={plan.placed} />
          )}
        </div>
      </RenderPlanContext.Provider>
    </BodyKindProvider>
  );
}

/**
 * Держит ли часть вкладок тред — на любой глубине.
 *
 * Такая вкладка НЕ живёт смонтированной, остальные — живут. Смонтированная неактивная вкладка
 * отдаёт свои запросы на открытии страницы: блоки данных уходят одной пачкой со всеми (§6.3), а
 * тело в редакторе не теряет набранное при уходе на соседнюю вкладку. Но тред на монтировании
 * заводит `chat.listMessages` — платить им за вкладку, которую не открывали, незачем; ровно так
 * живёт сегодняшний экран записи (вкладка «Тред» без keepMounted, `ui/Tabs.tsx`).
 */
function holdsThread(nodes: readonly PageNode[]): boolean {
  return nodes.some(
    (n) => (n.kind === 'record' && n.name === 'thread') || partsOf(n).some(holdsThread),
  );
}

/** Список узлов одного уровня; `prefix` — путь части, в которой они лежат. */
function NodeList({ nodes, prefix }: { nodes: readonly PageNode[]; prefix: readonly number[] }) {
  // Ключ — порядок узла: дерево пересобирается из текста целиком, узлы не переставляются.
  return (
    <>
      {nodes.map((node, i) => (
        <PageNodeView key={pathKey([...prefix, i])} node={node} path={[...prefix, i]} />
      ))}
    </>
  );
}

/** Узел — место в тексте: плашка, если он здесь не работает, иначе свой вид. */
function PageNodeView({ node, path }: { node: PageNode; path: readonly number[] }) {
  const plan = useRenderPlan();
  const issue = plan.issues.get(pathKey(path));
  if (issue !== undefined) {
    // Неуместный блок и лишний `{{body}}` — не поломка, а подсказка: спокойная рамка, как в первом
    // кадре тела. Сломанная разметка контейнера — ошибка, её чинят.
    const calm = issue.code === 'BLOCK_MISPLACED' || issue.code === 'SECOND_BODY';
    return (
      <BlockPlaque
        tone={calm ? 'misplaced' : 'error'}
        message={issue.message}
        {...(issue.hint !== undefined && { hint: issue.hint })}
      />
    );
  }
  switch (node.kind) {
    case 'text': {
      // Пустые края сняты, как в первом кадре: пустой абзац между блоками — дыра в раскладке.
      const text = node.text.trim();
      if (text === '') return null;
      return (
        <div data-testid="page-text">
          <Markdown source={text} onEntityLink={openEntity} />
        </div>
      );
    }
    case 'query':
      return <DataBlock text={node.text} />;
    case 'record':
      return <RecordNode name={node.name} />;
    case 'card':
      return <CardNode text={node.aspect} raw={node.raw} />;
    case 'columns':
      return (
        <Columns>
          {node.parts.map((part, p) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: колонки не переставляются — порядок и есть их имя
            <NodeList key={p} nodes={part} prefix={[...path, p]} />
          ))}
        </Columns>
      );
    case 'tabs':
      return (
        <TabsContainer
          tabs={node.parts.map((tab, p) => ({
            label: tab.label,
            content: <NodeList nodes={tab.children} prefix={[...path, p]} />,
            keepMounted: !holdsThread(tab.children),
          }))}
        />
      );
    case 'broken':
      // `broken` всегда несёт проблему (`bodyIssues`), и сюда он не доходит; ветка — ради
      // полноты разбора: пустоты вместо ошибки не бывает (§6.5).
      return <BlockPlaque message={node.message} />;
  }
}

function RecordNode({ name }: { name: keyof typeof RECORD_BLOCK_COMPONENTS }) {
  const plan = useRenderPlan();
  if (name === 'body' && plan.ownBody) {
    // Шаблон, показанный сам на себе (§6.4: `this` — сама страница): его тело — разметка
    // шаблона, и редактор заметки поверх неё правил бы шаблон под видом тела записи.
    return (
      <div
        data-testid="body-stub"
        className="rounded-control border border-line border-dashed px-3 py-2 text-sm text-text-muted"
      >
        [Тело записи]
      </div>
    );
  }
  if (name === 'cards') {
    // Не `RECORD_BLOCK_COMPONENTS.cards` (там размещённых нет): карточки, стоящие в этом дереве
    // через `{{card: X}}`, показались бы дважды — на месте и в общей куче.
    if (plan.reg === null) return null;
    return <RestCards placed={plan.placed} />;
  }
  const Block = RECORD_BLOCK_COMPONENTS[name];
  return <Block />;
}

function CardNode({ text, raw }: { text: string; raw: string }) {
  const { reg } = useRenderPlan();
  if (reg === null) return null;
  const aspect = aspectOfCardText(text, reg);
  if (aspect === undefined) {
    // Опечатка в имени или аспект, которого нет в реестре владельца: пустое место скрыло бы
    // ошибку автора шаблона навсегда (§6.5 — пустоты вместо ошибки не бывает).
    return (
      <BlockPlaque tone="misplaced" message={`Блок ${raw.trim()}: такого аспекта нет в реестре.`} />
    );
  }
  return <AspectCardFor aspectId={aspect.id} />;
}
