// Листовые сабпаты, не баррель `@orbis/shared/doc`: рендерер эагерно достижим из экрана записи, а
// баррель тянет схему документа (tiptap, marked) в первый кадр (сторожа `check-lazy-chunks.ts` и
// `save.test.tsx`).
import { PAGE_ASPECT } from '@orbis/shared';
import type { PageNode, RecordBlockName } from '@orbis/shared/doc/page-grammar';
import {
  aspectOfCardText,
  type BodyKind,
  type PlacementIssue,
  secondCardMessage,
} from '@orbis/shared/doc/placement';
import type { ParseRegistry } from '@orbis/shared/query';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { Markdown } from '../../lib/markdown/Markdown';
import { BodyKindProvider } from '../../lib/query-blocks/body-kind';
import { useFieldCatalog } from '../../lib/query-blocks/useFieldCatalog';
import { openEntity } from '../../state/navigation';
import { AspectCardFor, OWN_ASPECT_CARDS, RestCards } from '../entity-detail/own-cards';
import { RECORD_BLOCK_COMPONENTS } from '../entity-detail/record-blocks';
import { recordStubLabel, tabShowLabel } from '../entity-editor/layout-parts';
import { BlockPlaque, issueTone, REGISTRY_FAILED_MESSAGE } from './blocks/BlockPlaque';
import { DataBlock } from './blocks/DataBlock';
import { Columns } from './Columns';
import { forEachRendered, isCardsBlock, partsOf, pathKey, renderIssues } from './render-plan';
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
 * второй `{{body}}`, второй блок карточек, сломанный контейнер. Остальное тело рисуется: одна ошибка не гасит страницу.
 *
 * Известное расхождение с настройкой (как у первого кадра, `page-grammar.ts`): блок с отступом в
 * пункте списка препроход не видит, и на показе он — текстом, а в редакторе настройки — виджетом.
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
  /** Реестр разбора; `null` — ещё едет (или не приедет — `regFailed`). */
  reg: ParseRegistry | null;
  /** Запрос реестра отказал, снимка нет: ждать бесполезно — плашка вместо пустого места (§6.5). */
  regFailed: boolean;
  ownBody: boolean;
}

const RenderPlanContext = createContext<RenderPlan | null>(null);

function useRenderPlan(): RenderPlan {
  const plan = useContext(RenderPlanContext);
  if (plan === null) throw new Error('Узел страницы вне Renderer');
  return plan;
}

function planRender(
  nodes: readonly PageNode[],
  kind: BodyKind,
  reg: ParseRegistry | null,
  regFailed: boolean,
  ownBody: boolean,
): RenderPlan {
  // Плашки и обход рисуемых узлов — одна копия с «Изменить вид» (`render-plan.ts`).
  const renderIssuesMap = renderIssues(nodes, kind);
  // Вторая карточка одного аспекта РАЗНЫМИ написаниями (ключ и подпись): `bodyIssues` идёт без
  // реестра и видит только одинаковый текст. Иначе у записи две копии карточки со своим
  // состоянием — два поля ответа исполнителю, две «Прогнать сейчас» (1а новое-11). Счёт — своим
  // множеством, а не `placed`: тот у страницы своим телом заранее несёт `orbis/page`, и её
  // единственная `{{card: orbis/page}}` читалась бы второй.
  const extra = new Map<string, PlacementIssue>();
  if (reg !== null) {
    const seen = new Set<string>();
    forEachRendered(nodes, renderIssuesMap, (node, path) => {
      if (node.kind !== 'card') return;
      const aspect = aspectOfCardText(node.aspect, reg);
      if (aspect === undefined) return;
      if (seen.has(aspect.id)) {
        extra.set(pathKey(path), {
          code: 'SECOND_BLOCK',
          message: secondCardMessage(node.raw),
          path: [...path],
        });
      } else {
        seen.add(aspect.id);
      }
    });
  }
  const issues: ReadonlyMap<string, PlacementIssue> = new Map([...renderIssuesMap, ...extra]);

  const placed = new Set<string>();
  // РП-25: страница, показанная своим телом, не рисует карточку «Страница» ни в `{{cards}}`, ни
  // в дописывании. Иначе «Изменить вид только этой записи» не давал бы «как раньше» (С1а-8):
  // запись-страница несла бы лишнюю карточку. Через шаблон хоста («Открыть как запись») она
  // видна, как все.
  if (ownBody) placed.add(PAGE_ASPECT);
  let hasCards = false;
  // Только РИСУЕМЫЕ узлы (`forEachRendered`): карточка в неуместном или сломанном месте не
  // показана, и считать её размещённой значило бы потерять её совсем — ни на месте, ни в конце.
  forEachRendered(nodes, issues, (node) => {
    if (node.kind === 'card' && reg !== null) {
      const aspect = aspectOfCardText(node.aspect, reg);
      if (aspect !== undefined) placed.add(aspect.id);
    } else if (isCardsBlock(node)) {
      hasCards = true;
    }
  });
  return { issues, placed, hasCards, reg, regFailed, ownBody };
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
  const { registry, failed } = useFieldCatalog();
  const reg = registry?.parse ?? null;
  const regFailed = reg === null && failed;
  const ownBody = useContext(OwnBodyContext);
  const plan = useMemo(
    () => planRender(nodes, kind, reg, regFailed, ownBody),
    [nodes, kind, reg, regFailed, ownBody],
  );
  return (
    // Род тела — у всех блоков данных дерева: абсолютная дата законна в заметке и ошибка на
    // странице и в шаблоне (§5.6). Ставит его рендерер, а не вызывающий: род дерева и есть `kind`.
    <BodyKindProvider kind={kind}>
      <RenderPlanContext.Provider value={plan}>
        <div data-testid="page-render" className="flex flex-col gap-6">
          <NodeList nodes={nodes} prefix={[]} />
          {/* Пока реестр едет, размещённые карточки неизвестны: дописанная сейчас карточка
              через мгновение переехала бы на своё место `{{card: X}}`. */}
          {appendUnplacedCards &&
            !plan.hasCards &&
            (reg !== null ? (
              <RestCards placed={plan.placed} />
            ) : (
              regFailed && <BlockPlaque message={REGISTRY_FAILED_MESSAGE} />
            ))}
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
    // Тон — одним правилом с первым кадром тела (`issueTone`).
    return (
      <BlockPlaque
        tone={issueTone(issue)}
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
          memoryKey={pathKey(path)}
          tabs={node.parts.map((tab, p) => ({
            label: tabShowLabel(tab.label, p),
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

function RecordNode({ name }: { name: RecordBlockName }) {
  const plan = useRenderPlan();
  if (name === 'body' && plan.ownBody) {
    // Шаблон, показанный сам на себе (§6.4: `this` — сама страница): его тело — разметка
    // шаблона, и редактор заметки поверх неё правил бы шаблон под видом тела записи.
    return (
      <div
        data-testid="body-stub"
        className="rounded-control border border-line border-dashed px-3 py-2 text-sm text-text-muted"
      >
        {recordStubLabel('body')}
      </div>
    );
  }
  if (name === 'cards') {
    // Только здесь — у примитивов записи `{{cards}}` нет: карточки, стоящие в этом дереве через
    // `{{card: X}}`, показались бы дважды — на месте и в общей куче.
    if (plan.reg === null) {
      return plan.regFailed ? <BlockPlaque message={REGISTRY_FAILED_MESSAGE} /> : null;
    }
    return <RestCards placed={plan.placed} />;
  }
  const Block = RECORD_BLOCK_COMPONENTS[name];
  return <Block />;
}

function CardNode({ text, raw }: { text: string; raw: string }) {
  const { reg } = useRenderPlan();
  if (reg === null) {
    // Реестр ещё едет. Своя карточка встроенного аспекта, названного КЛЮЧОМ (у встроенных ключ =
    // id), узнаётся и без него — и рисуется сразу, с ответом `entity.get`, как до шаблона хоста:
    // прогресс цели, ожидание тикета, состояние рутины, лента прогона, «план → факт» не должны
    // ждать лишний круг сети за реестром (С1а-6). Кому карточка положена, решает её `showWhen`.
    // Подпись в кавычках и чужие аспекты без реестра не узнать — они ждут его.
    const key = text.trim();
    return Object.hasOwn(OWN_ASPECT_CARDS, key) ? <AspectCardFor aspectId={key} /> : null;
  }
  const aspect = aspectOfCardText(text, reg);
  if (aspect === undefined) {
    // Аспект не узнан: опечатка, аспекта нет в реестре владельца или подпись в кавычках есть у
    // нескольких аспектов (`aspectOfCardText` не угадывает). Какой из случаев — функция не
    // говорит, поэтому текст один и честный на все, с выходом для неоднозначной подписи. Пустое
    // место скрыло бы ошибку автора шаблона навсегда (§6.5 — пустоты вместо ошибки не бывает).
    return (
      <BlockPlaque
        tone="unresolved"
        message={`Блок ${raw.trim()}: аспект не узнан.`}
        hint="Аспекта с таким ключом или подписью нет — либо эта подпись есть у нескольких аспектов: тогда укажите ключ аспекта."
      />
    );
  }
  return <AspectCardFor aspectId={aspect.id} />;
}
