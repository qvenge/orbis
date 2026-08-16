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

/** Клик по телу (а значит — зовущий редактор) или по чему-то внутри тела со своим смыслом. */
export function isBodyGesture(target: HTMLElement | null): boolean {
  // `== null` (а не `=== null`): у отсутствующей цели `?.` даёт undefined, и такой клик —
  // всё ещё клик по телу, ровно как в прежней записи `if (target?.closest(…)) return`.
  return target?.closest(NOT_BODY_GESTURE) == null;
}

/**
 * Первый кадр — текст вперемежку с живыми виджетами через bodySegments, ровно так же, как
 * рисовал прежний просмотр тела (его убрала Задача 15). Голый <Markdown> показывал бы
 * `{{query:…}}` строкой, которая через мгновение прыгнула бы на виджет: у сида All Tasks тело
 * и есть один такой блок (ревью И4).
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
 */
export function EditorShell({
  doc,
  markdown,
  onChange,
}: {
  doc: BodyDoc | null;
  markdown: string;
  onChange: (doc: BodyDoc) => void;
}) {
  const [mount, setMount] = useState<Mount | null>(null);
  useEffect(() => {
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
  }, []);

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
      // Коробка и зазор между сегментами — общие с редактором (BODY_BOX_CLASS, body-box.ts):
      // иначе подмена первого кадра редактором двигала бы текст под руками.
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
  // `doc === null` перекрывает даже поднятое намерение: жест «хочу редактор» законен, а вот
  // подставить вместо документа пустышку — нет (см. заголовок файла).
  if (mount === null || doc === null) return preview;
  return (
    <Suspense fallback={preview}>
      <BodyEditor doc={doc} onChange={onChange} focusAt={mount.focusAt} />
    </Suspense>
  );
}
