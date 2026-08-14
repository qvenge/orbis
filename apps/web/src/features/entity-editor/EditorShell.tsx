import type { BodyDoc } from '@orbis/shared/doc'; // ТОЛЬКО type — файл в эагерном чанке
import { lazy, type MouseEvent, Suspense, useEffect, useState } from 'react';
import { Markdown } from '../../lib/markdown/Markdown';
import { QueryBlock } from '../../lib/query-blocks/QueryBlock';
import { openEntity } from '../../state/navigation';
import { bodySegments } from '../browser/query';
import { BODY_BOX_CLASS, BODY_PLACEHOLDER } from './body-box';

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
 * По чему кликают НЕ ради правки тела. Список тот же, что у сегодняшнего просмотра
 * (DetailScreen.startEditing), плюс `[role="dialog"]` — и он здесь не украшение.
 *
 * Редактор блока (Задача 9) открывается ИЗНУТРИ NodeView, а Radix рисует модалку в ПОРТАЛЕ:
 * в DOM она лежит вне поддерева виджета, поэтому `closest('[data-query-widget]')` её не
 * видит, — а React-события из портала всплывают по дереву REACT (это и есть случай, которым
 * уже обожглись в DetailScreen.tsx:390-396). Пробой замерено и то, и другое: клик по шапке
 * модалки доходит до обработчика-предка редактора, и прежний список его пропускал.
 *
 * Сегодня подмены первого кадра этим не случилось бы: к моменту, когда модалку есть откуда
 * открыть, редактор уже смонтирован, а вместе с ним снят и сам обработчик — «Настроить» есть
 * только у виджета NodeView, у виджета первого кадра его нет (onConfigure не передан).
 * Оговорка держится на этом совпадении и молча, поэтому рубеж поставлен явно: любая модалка,
 * открытая из тела, обязана оставаться модалкой.
 *
 * Экспортируется, чтобы тест виджета проверял ИМЕННО ЭТОТ список, а не свою копию строки.
 */
const NOT_BODY_GESTURE =
  'a, button, input, select, textarea, [role="button"], [data-query-widget], [role="dialog"]';

/** Клик по телу (а значит — зовущий редактор) или по чему-то внутри тела со своим смыслом. */
export function isBodyGesture(target: HTMLElement | null): boolean {
  // `== null` (а не `=== null`): у отсутствующей цели `?.` даёт undefined, и такой клик —
  // всё ещё клик по телу, ровно как в прежней записи `if (target?.closest(…)) return`.
  return target?.closest(NOT_BODY_GESTURE) == null;
}

/**
 * Первый кадр — ТО ЖЕ, что рисует сегодняшний просмотр: текст вперемежку с живыми виджетами
 * через bodySegments. Голый <Markdown> показывал бы `{{query:…}}` строкой, которая через
 * мгновение прыгнула бы на виджет: у сида All Tasks тело и есть один такой блок (ревью И4).
 *
 * Редактор монтируется по первому касанию тела ИЛИ по простою — не по setTimeout(0): иначе
 * чанк схемы (~160 kB gzip при 219 kB всей начальной загрузки) тянулся бы при КАЖДОМ чисто
 * читательском открытии записи (ревью И5/И6).
 */
export function EditorShell({
  doc,
  markdown,
  onChange,
}: {
  doc: BodyDoc;
  markdown: string;
  onChange: (doc: BodyDoc) => void;
}) {
  const [wanted, setWanted] = useState(false);
  useEffect(() => {
    // Две ветки целиком, а не один id на оба механизма: отменять надо ТЕМ ЖЕ, чем заводили —
    // clearTimeout по id простоя ничего не отменит, и колбэк уже размонтированного экрана
    // дёрнул бы setState. Вызов через `idle.` (не через оторванную ссылку) сохраняет
    // получателя: у отвязанного requestIdleCallback браузер бросает Illegal invocation.
    const idle = window as unknown as IdleApi;
    if (idle.requestIdleCallback) {
      const id = idle.requestIdleCallback(() => setWanted(true));
      return () => idle.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(() => setWanted(true), IDLE_FALLBACK_MS);
    return () => clearTimeout(id);
  }, []);

  // Касание тела зовёт редактор — но ровно ТЕЛА. Стражи те же и в том же порядке, что у
  // сегодняшнего просмотра (DetailScreen.startEditing), и по тем же причинам: ссылка внутри
  // разметки обязана вести по ссылке, живой виджет — оставаться виджетом (у All Tasks весь
  // body — один блок, и подмена его редактором роняла бы экран смарт-листа от случайного
  // клика), модалка блока — модалкой (см. NOT_BODY_GESTURE), а начатое выделение — доживать
  // до конца: подмена первого кадра редактором меняет корень поддерева, и выделение теряется
  // вместе с ним.
  //
  // Событие — click, а НЕ pointerdown: pointerdown приходит и в начале протяжки выделения
  // (тогда подмена случилась бы прямо посреди неё, и click до ссылки уже не доехал бы), и в
  // начале тач-прокрутки — то есть любая прокрутка по телу тянула бы чанк в 157 кБ, ровно
  // против цели двухфазности. click приходит после mouseup, когда выделение уже сложилось.
  function wantEditor(e: MouseEvent<HTMLDivElement>) {
    if (!isBodyGesture(e.target as HTMLElement | null)) return;
    if (window.getSelection()?.isCollapsed === false) return;
    setWanted(true);
  }

  const segments = bodySegments(markdown);
  // Оба ослабления a11y — одной строкой ниже: у многострочного `//`-комментария биом читает
  // как подавление только ПОСЛЕДНЮЮ строку, и первое правило осталось бы неподавленным.
  // Довод тот же, что у DetailScreen: клавиатурного двойника у этого жеста нет и не нужно —
  // редактор всё равно встаёт сам по простою, а role=button здесь невозможен, потому что
  // внутри разметки живут ссылки, а интерактивное внутри кнопки — уже не кнопка.
  const preview = (
    // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: жест мыши поверх текста, см. выше
    <div
      data-testid="editor-preview"
      onClick={wantEditor}
      // Раскладка — как у сегодняшнего просмотра (DetailScreen): та же коробка и тот же
      // зазор между сегментами, иначе подмена просмотра редактором двигала бы текст.
      className={`${BODY_BOX_CLASS} flex cursor-text flex-col gap-4`}
    >
      {segments.length === 0 && <p className="text-text-muted">{BODY_PLACEHOLDER}</p>}
      {segments.map((seg, i) =>
        seg.kind === 'query' ? (
          // Обёртка с data-query-widget — не украшение: по ней страж выше отличает клик по
          // живому виджету от клика по телу (тот же признак, что в DetailScreen).
          // biome-ignore lint/suspicious/noArrayIndexKey: порядок сегментов задан текстом body
          <div key={i} data-query-widget="">
            <QueryBlock query={seg.query} />
          </div>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: порядок сегментов задан текстом body
          <Markdown key={i} source={seg.text} onEntityLink={openEntity} />
        ),
      )}
    </div>
  );
  if (!wanted) return preview;
  return (
    <Suspense fallback={preview}>
      <BodyEditor doc={doc} onChange={onChange} />
    </Suspense>
  );
}
