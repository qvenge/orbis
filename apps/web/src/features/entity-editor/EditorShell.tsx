import type { BodyDoc } from '@orbis/shared/doc'; // ТОЛЬКО type — файл в эагерном чанке
import { lazy, Suspense, useEffect, useState } from 'react';
import { Markdown } from '../../lib/markdown/Markdown';
import { QueryBlock } from '../../lib/query-blocks/QueryBlock';
import { openEntity } from '../../state/navigation';
import { bodySegments } from '../browser/query';
import { BODY_BOX_CLASS } from './body-box';

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

  // Касание тела — жест ПОВЕРХ текста, а не кнопка: внутри живут ссылки и виджеты, и role
  // здесь невозможен ровно по той же причине, что в просмотре (DetailScreen.startEditing).
  // Клавиатурный путь есть и без role: onFocus срабатывает, когда табом входят в ссылку тела.
  const preview = (
    // biome-ignore lint/a11y/noStaticElementInteractions: жест поверх текста, см. выше
    <div
      data-testid="editor-preview"
      onPointerDown={() => setWanted(true)}
      onFocus={() => setWanted(true)}
      // Раскладка — как у сегодняшнего просмотра (DetailScreen): та же коробка и тот же
      // зазор между сегментами, иначе подмена просмотра редактором двигала бы текст.
      className={`${BODY_BOX_CLASS} flex cursor-text flex-col gap-4`}
    >
      {bodySegments(markdown).map((seg, i) =>
        seg.kind === 'query' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: порядок сегментов задан текстом body
          <QueryBlock key={i} query={seg.query} />
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
