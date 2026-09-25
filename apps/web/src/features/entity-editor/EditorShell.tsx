import type { BodyDoc } from '@orbis/shared/doc'; // ТОЛЬКО type — файл в эагерном чанке
// Листовые сабпаты, не баррель: препроход и матрица мест без tiptap и marked (вес первого кадра).
import { type PageNode, parsePageText } from '@orbis/shared/doc/page-grammar';
import { type BodyKind, bodyIssues, type PlacementIssue } from '@orbis/shared/doc/placement';
import { OWNER_LOCALE, type ParseRegistry } from '@orbis/shared/query';
import { lazy, type MouseEvent, type ReactNode, Suspense, useEffect, useState } from 'react';
import { Markdown } from '../../lib/markdown/Markdown';
import { useBodyKind } from '../../lib/query-blocks/body-kind';
import { QueryBlock } from '../../lib/query-blocks/QueryBlock';
import { useFieldCatalog } from '../../lib/query-blocks/useFieldCatalog';
import { openEntity } from '../../state/navigation';
import { BlockPlaque } from '../page/blocks/BlockPlaque';
import { BODY_BOX_CLASS, BODY_PLACEHOLDER } from './body-box';
import {
  cardAspectTitle,
  cardStubLabel,
  columnFrameLabel,
  LayoutFrameBox,
  LayoutStack,
  recordStubLabel,
  StubBox,
  tabFrameLabel,
} from './layout-parts';

const BodyEditor = lazy(() => import('./BodyEditor').then((m) => ({ default: m.BodyEditor })));

/** Запасной путь без requestIdleCallback (Safari, jsdom). Заметная задержка, а не ноль: смысл
 *  двухфазности в том, чтобы чисто читательское открытие чанк редактора не тянуло вовсе. */
const IDLE_FALLBACK_MS = 1500;

/** Приведение к этому типу — через `unknown` намеренно: lib.dom объявляет requestIdleCallback
 *  ОБЯЗАТЕЛЬНЫМ членом Window, хотя в jsdom и в Safari его может не быть вовсе. Пересечение с
 *  Window вернуло бы обязательность, и запасную ветку TS счёл бы мёртвой (TS2774). */
type IdleApi = {
  requestIdleCallback?: (cb: () => void) => number;
  cancelIdleCallback?: (id: number) => void;
};

/**
 * По чему кликают НЕ ради правки тела. Список унаследован от прежнего просмотра тела в
 * DetailScreen (Задача 15 его убрала), плюс `[role="dialog"]` — и он здесь не украшение.
 *
 * Редактор блока (Задача 9) открывается ИЗНУТРИ NodeView, а Radix рисует модалку в ПОРТАЛЕ:
 * в DOM она лежит вне поддерева виджета, поэтому `closest('[data-query-widget]')` её не
 * видит, — а React-события из портала всплывают по дереву REACT (на этом уже обожглись один
 * раз, и лечение уехало вместе со старым просмотром). Пробой замерено и то, и другое: клик по
 * шапке модалки доходит до обработчика-предка редактора, и прежний список его пропускал.
 *
 * Сегодня подмены первого кадра этим не случилось бы: к моменту, когда модалку есть откуда
 * открыть, редактор уже смонтирован, а вместе с ним снят и сам обработчик — «Настроить» есть
 * только у виджета NodeView, у виджета первого кадра его нет (onConfigure не передан).
 * Оговорка держится на этом совпадении и молча, поэтому рубеж поставлен явно: любая модалка,
 * открытая из тела, обязана оставаться модалкой.
 *
 * Экспортируется, чтобы тест виджета проверял ИМЕННО ЭТОТ список, а не свою копию строки.
 *
 * Заглушки обвязки и карточки (страницы 1а §9.1) несут тот же признак `[data-query-widget]` — и в
 * первом кадре, и в NodeView: заглушка — блок со своим смыслом (у карточки — кнопка «Сменить»), а
 * не текст тела. Рамки частей контейнера признака НЕ несут: внутри них текст, и касание его зовёт
 * редактор, как касание любого текста.
 */
const NOT_BODY_GESTURE =
  'a, button, input, select, textarea, [role="button"], [data-query-widget], [role="dialog"]';

/**
 * ЗАЧЕМ подняли редактор — и потому же, куда девать фокус.
 *
 * По жесту фокус забирать ОБЯЗАНЫ: клик приходит по первому кадру, редактора в этот момент нет
 * вовсе, и браузерное «клик поставил каретку» ставить её некуда — первый клик уходил впустую,
 * набранное не появлялось нигде, а на планшете не поднималась экранная клавиатура. По простою
 * — НЕЛЬЗЯ: он наступает сам собой, в том числе пока человек пишет в другом поле экрана.
 */
type Mount = { focusAt: { left: number; top: number } | null };
const BY_IDLE: Mount = { focusAt: null };

/**
 * Пустой реестр разбора — для мест БЕЗ блоков данных. `bodyIssues` читает реестр только у узлов
 * `query`, а первый кадр спрашивает её об одном узле обвязки или контейнера за раз и берёт
 * только проблему самого узла (путь длины 1): проблемы блоков данных внутри показывает их
 * собственный `DataBlock` по настоящему реестру. Тем же приёмом пользуется рендерер страниц
 * (`features/page/Renderer.tsx`): проблемы узлов-запросов он отбрасывает, ими говорит блок.
 */
export const NO_REGISTRY: ParseRegistry = {
  properties: new Map(),
  aspects: new Map(),
  roles: new Map(),
  contracts: new Map(),
  locale: OWNER_LOCALE,
};

/**
 * Проблема места ОДНОГО узла (§5.5, §5.8) — или `undefined`, если на этом месте он работает.
 *
 * Одна функция на первый кадр и NodeView редактора: плашка, стоявшая до подъёма редактора, после
 * него обязана остаться той же плашкой с тем же текстом. Берётся только проблема самого узла
 * (путь длины 1): проблемы вложенных узлов спрашиваются, когда до них дойдёт очередь, а блоков
 * данных — их собственным `DataBlock` по настоящему реестру (довод `NO_REGISTRY`).
 */
export function placementIssue(node: PageNode, kind: BodyKind): PlacementIssue | undefined {
  return bodyIssues([node], kind, NO_REGISTRY).find((i) => i.path.length === 1);
}

/** Карточка аспекта в первом кадре — подписью по реестру, без данных (§9.1). */
function FirstFrameCard({ text }: { text: string }) {
  const { registry } = useFieldCatalog();
  return (
    <div data-query-widget="">
      <StubBox label={cardStubLabel(cardAspectTitle(text, null, registry?.parse ?? null))} />
    </div>
  );
}

/** Узлы части контейнера — тем же правилом, что узлы верхнего уровня; пустые (null) отброшены. */
function firstFrameNodes(nodes: readonly PageNode[], kind: BodyKind): ReactNode[] {
  return nodes.map((node, i) => firstFrameNode(node, kind, i)).filter((n) => n !== null);
}

/**
 * Один узел препрохода на первом кадре (спека страниц 1а §5.5, §6.3, §9.1):
 *  - текст — разметкой (пустые края сняты: пустой абзац между виджетами — дыра в раскладке, а
 *    отступ в начале куска сделал бы из него блок кода);
 *  - блок данных — живым виджетом, тем же, что встанет в редакторе;
 *  - блок обвязки, карточка, контейнер или сломанная разметка там, где они не работают (в
 *    заметке — всегда), — плашкой с подсказкой; текст узла остаётся в документе, плашка только
 *    на экране (§5.5);
 *  - уместный контейнер (страница, шаблон) — подписанными рамками частей одна под другой, блок
 *    обвязки — подписанной заглушкой: ровно тот вид, что встанет в редакторе (NodeView
 *    `LayoutFrame`, `RecordBlockStub`), — иначе подъём редактора менял бы тело под руками.
 *    Раскладкой и данными обвязки рисует показ (рендерер страниц), а не тело в правке.
 */
function firstFrameNode(node: PageNode, kind: BodyKind, key: number): ReactNode {
  if (node.kind === 'text') {
    const text = node.text.trim();
    return text === '' ? null : <Markdown key={key} source={text} onEntityLink={openEntity} />;
  }
  if (node.kind === 'query') {
    // Обёртка с data-query-widget — не украшение: по ней страж выше отличает клик по живому
    // виджету от клика по телу (тот же признак, что у NodeView редактора).
    return (
      <div key={key} data-query-widget="">
        <QueryBlock query={node.text} />
      </div>
    );
  }
  const issue = placementIssue(node, kind);
  if (issue !== undefined) {
    // Без признака data-query-widget, в отличие от живого блока: плашка — не виджет со своим
    // смыслом, а место в тексте, и касание её зовёт редактор, где этот текст и правится.
    return (
      <BlockPlaque
        key={key}
        tone="misplaced"
        message={issue.message}
        {...(issue.hint !== undefined && { hint: issue.hint })}
      />
    );
  }
  switch (node.kind) {
    case 'columns':
      return (
        <LayoutStack key={key}>
          {node.parts.map((part, p) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: части не переставляются — порядок и есть их имя
            <LayoutFrameBox key={p} label={columnFrameLabel(p)}>
              {firstFrameNodes(part, kind)}
            </LayoutFrameBox>
          ))}
        </LayoutStack>
      );
    case 'tabs':
      return (
        <LayoutStack key={key}>
          {node.parts.map((tab, p) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: части не переставляются — порядок и есть их имя
            <LayoutFrameBox key={p} label={tabFrameLabel(tab.label)}>
              {firstFrameNodes(tab.children, kind)}
            </LayoutFrameBox>
          ))}
        </LayoutStack>
      );
    case 'record':
      // Признак виджета, как у NodeView заглушки: касание заглушки — не касание текста тела.
      return (
        <div key={key} data-query-widget="">
          <StubBox label={recordStubLabel(node.name)} />
        </div>
      );
    case 'card':
      return <FirstFrameCard key={key} text={node.aspect} />;
    case 'broken':
      // `broken` всегда несёт проблему (`bodyIssues`) и сюда не доходит; ветка — ради полноты
      // разбора: пустоты вместо узла не бывает.
      return <Markdown key={key} source={node.raw.trim()} onEntityLink={openEntity} />;
  }
}

/** Клик по телу (а значит — зовущий редактор) или по чему-то внутри тела со своим смыслом. */
export function isBodyGesture(target: HTMLElement | null): boolean {
  // `== null` (а не `=== null`): у отсутствующей цели `?.` даёт undefined, и такой клик —
  // всё ещё клик по телу, ровно как в прежней записи `if (target?.closest(…)) return`.
  return target?.closest(NOT_BODY_GESTURE) == null;
}

/**
 * Первый кадр — текст вперемежку с живыми виджетами по препроходу тела (`parsePageText`, одна
 * копия правил маркеров, РП-6), ровно так же, как рисовал прежний просмотр тела (его убрала
 * Задача 15). Голый <Markdown> показывал бы `{{query:…}}` строкой, которая через мгновение
 * прыгнула бы на виджет: у сида All Tasks тело и есть один такой блок (ревью И4).
 *
 * Редактор монтируется по первому касанию тела ИЛИ по простою — не по setTimeout(0): иначе
 * чанк схемы тянулся бы при КАЖДОМ чисто читательском открытии записи (ревью И5/И6). Числа
 * ЗАМЕРЕНЫ на сборке Задачи 15, а не оценены: `doc-*.js` — 154.5 кБ gzip, `BodyEditor-*.js` —
 * 27.9 кБ, при 218.9 кБ всей начальной загрузки приложения.
 *
 * `doc === null` — «документа нет», и тогда редактор не встаёт НИКОГДА, ни по касанию, ни по
 * простою: пустой документ в нём выглядел бы стёртым телом, а первое же нажатие клавиши
 * отправило бы эту пустоту в базу поверх настоящего текста. Случай не гипотетический по форме
 * (`bodyDoc` в wire-схеме и опционален, и nullable), но и не штатный: detail просит `bodyDoc` в
 * include всегда, а сервер собирает документ даже для записей без колонки (readBodyDoc). Тело
 * при этом не пропадает — первый кадр рисуется из `markdown`, то есть остаётся читаемым.
 *
 * `readOnly` — только первый кадр, редактор не встаёт вовсе: ни по касанию, ни по простою
 * (предпросмотр шаблона на чужой записи, спека страниц 1а §9.3). Чанк схемы при этом не тянется.
 */
export function EditorShell({
  doc,
  markdown,
  onChange,
  onAccept,
  readOnly = false,
}: {
  doc: BodyDoc | null;
  markdown: string;
  onChange: (doc: BodyDoc) => void;
  /**
   * Редактор принял пришедший документ (см. `BodyEditor.onAccept`). Оболочка его только
   * ПРОНОСИТ: решение о подмене принимает редактор, а знать о нём нужно экрану — он держит
   * рядом второго потребителя показанного документа, режим разметки.
   */
  onAccept?: (doc: BodyDoc) => void;
  readOnly?: boolean;
}) {
  const [mount, setMount] = useState<Mount | null>(null);
  useEffect(() => {
    if (readOnly) return;
    // `m ?? BY_IDLE`, а не голое присваивание: простой наступает и ПОСЛЕ того, как редактор
    // подняли касанием, и перезапись стёрла бы намерение «человек сюда ткнул» вместе с
    // координатами каретки — фокус пропал бы ровно у того, кто его и звал.
    const wantByIdle = () => setMount((m) => m ?? BY_IDLE);
    // Две ветки целиком, а не один id на оба механизма: отменять надо ТЕМ ЖЕ, чем заводили —
    // clearTimeout по id простоя ничего не отменит, и колбэк уже размонтированного экрана
    // дёрнул бы setState. Вызов через `idle.` (не через оторванную ссылку) сохраняет
    // получателя: у отвязанного requestIdleCallback браузер бросает Illegal invocation.
    const idle = window as unknown as IdleApi;
    if (idle.requestIdleCallback) {
      const id = idle.requestIdleCallback(wantByIdle);
      return () => idle.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(wantByIdle, IDLE_FALLBACK_MS);
    return () => clearTimeout(id);
  }, [readOnly]);

  // Касание тела зовёт редактор — но ровно ТЕЛА. Стражи те же и в том же порядке, что стояли у
  // прежнего просмотра тела, и по тем же причинам: ссылка внутри разметки обязана вести по
  // ссылке, живой виджет — оставаться виджетом (у All Tasks весь
  // body — один блок, и подмена его редактором роняла бы экран смарт-листа от случайного
  // клика), модалка блока — модалкой (см. NOT_BODY_GESTURE), а начатое выделение — доживать
  // до конца: подмена первого кадра редактором меняет корень поддерева, и выделение теряется
  // вместе с ним.
  //
  // Событие — click, а НЕ pointerdown: pointerdown приходит и в начале протяжки выделения
  // (тогда подмена случилась бы прямо посреди неё, и click до ссылки уже не доехал бы), и в
  // начале тач-прокрутки — то есть любая прокрутка по телу тянула бы 182 кБ gzip (редактор
  // вместе со схемой), ровно против цели двухфазности. click приходит после mouseup, когда
  // выделение уже сложилось.
  function wantEditor(e: MouseEvent<HTMLDivElement>) {
    if (!isBodyGesture(e.target as HTMLElement | null)) return;
    if (window.getSelection()?.isCollapsed === false) return;
    // Координаты жеста едут в редактор: он сам разрешит их в позицию каретки, когда встанет.
    setMount({ focusAt: { left: e.clientX, top: e.clientY } });
  }

  const kind = useBodyKind();
  // Ключ узла — его порядок в тексте тела: узлы первого кадра не переставляются, только
  // пересобираются из текста целиком.
  const frame = firstFrameNodes(parsePageText(markdown), kind);
  // Оба ослабления a11y — одной строкой ниже: у многострочного `//`-комментария биом читает
  // как подавление только ПОСЛЕДНЮЮ строку, и первое правило осталось бы неподавленным.
  // Довод тот же, что у DetailScreen: клавиатурного двойника у этого жеста нет и не нужно —
  // редактор всё равно встаёт сам по простою, а role=button здесь невозможен, потому что
  // внутри разметки живут ссылки, а интерактивное внутри кнопки — уже не кнопка.
  const preview = (
    // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: жест мыши поверх текста, см. выше
    <div
      data-testid="editor-preview"
      onClick={readOnly ? undefined : wantEditor}
      // Коробка и зазор между сегментами — общие с редактором (BODY_BOX_CLASS, body-box.ts):
      // иначе подмена первого кадра редактором двигала бы текст под руками.
      className={`${BODY_BOX_CLASS} flex flex-col gap-4${readOnly ? '' : ' cursor-text'}`}
    >
      {/* Приглашение к вводу там, где вводить нельзя, звало бы в никуда. */}
      {frame.length === 0 && !readOnly && <p className="text-text-muted">{BODY_PLACEHOLDER}</p>}
      {frame}
    </div>
  );
  // `doc === null` перекрывает даже поднятое намерение: жест «хочу редактор» законен, а вот
  // подставить вместо документа пустышку — нет (см. заголовок файла).
  if (readOnly || mount === null || doc === null) return preview;
  return (
    <Suspense fallback={preview}>
      <BodyEditor doc={doc} onChange={onChange} onAccept={onAccept} focusAt={mount.focusAt} />
    </Suspense>
  );
}
