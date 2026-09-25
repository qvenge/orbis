import { parsePageText } from '@orbis/shared/doc/page-grammar';
import { useMemo, useRef } from 'react';
import { ThisEntityProvider } from '../../lib/query-blocks/this-entity';
import { type RouterOutputs, trpc } from '../../trpc';
import { usePlanToFactPrompt } from '../budget/usePlanToFactPrompt';
import { type BodyGate, BodyScreenProvider, bodyKindOf } from '../entity-detail/EntityBody';
import { RecordHostProvider, recordHostValue } from '../entity-detail/record-host';
import { detailGetInput } from '../entity-detail/useEntityDetail';
import { OwnBodyProvider, Renderer } from './Renderer';

type EntityGetReply = RouterOutputs['entity']['get'];

/**
 * Страница своим телом (спека страниц 1а §4.2 шаг 1): запись с аспектом `orbis/page` показана
 * рендерером по её собственному тексту. Шаблон (страница с непустым «Шаблон для») — так же, сам
 * на себе: `kind = 'template'`, а `{{body}}` — заглушка (тела записи у шаблона нет, §6.4).
 *
 * `this` — сама страница (§6.4). Данные обвязки — из `reply`, ответа `entity.get` экрана записи
 * (`DETAIL_INCLUDE`, ключ `detailGetInput(id)`): второго запроса записи нет (РП-13, Э-14), а
 * оптимистичные правки `{{title}}` ложатся под тот же ключ и видны здесь сразу.
 */
export function PageView({ reply }: { reply: EntityGetReply }) {
  const { entity } = reply;
  const utils = trpc.useUtils();
  // Тела своим редактором страница не ставит — регистрироваться сюда некому; реф нужен форме.
  const bodyGate = useRef<BodyGate | null>(null);
  // «План → факт» — состояние хоста, как на экране записи (Ф-1а-18): поднимает его чекбокс
  // `{{title}}`, показывает карточка `orbis/financial`, где бы та ни стояла.
  const planToFact = usePlanToFactPrompt();
  const nodes = useMemo(() => parsePageText(entity.body), [entity.body]);
  const kind = bodyKindOf(entity);
  // Корень хоста — вне вкладок: блок, стоящий не во вкладке, виден всегда (`activeTab`).
  const host = recordHostValue(reply, { planToFact, activeTab: 'page', readOnlyBody: false });
  return (
    <RecordHostProvider value={host}>
      {/* Экран тела. Своим телом страница редактор записи не ставит (`{{body}}` на странице —
          плашка, на шаблоне — заглушка), но примитив `{{body}}` без экрана бросает: провайдер —
          страховка сборки, а не канал. Плашек тела здесь нет, и узла для них тоже. */}
      <BodyScreenProvider
        value={{
          asMarkdown: false,
          onCloseMarkdown: () => {},
          screenConflict: false,
          noticeHost: null,
          onRefresh: () => void utils.entity.get.invalidate(detailGetInput(entity.id)),
          bodyGate,
        }}
      >
        <ThisEntityProvider id={entity.id}>
          <OwnBodyProvider>
            <div data-testid="page-view" className="flex flex-col gap-6 px-4 pb-10 pt-5 md:px-6">
              <Renderer nodes={nodes} kind={kind} appendUnplacedCards={false} />
            </div>
          </OwnBodyProvider>
        </ThisEntityProvider>
      </BodyScreenProvider>
    </RecordHostProvider>
  );
}
