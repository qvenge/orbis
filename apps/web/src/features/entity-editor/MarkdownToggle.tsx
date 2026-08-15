import { type BodyDoc, parseBody, serializeBody } from '@orbis/shared/doc';
import { useMemo, useState } from 'react';
import { Button } from '../../ui/Button';

/**
 * Предупреждение о неразобранной разметке. Второе «Применить» — не украшение: `parseBody`
 * никогда не бросает и молча уводит непонятое в `rawBlock` дословно, так что без явного
 * подтверждения человек решил бы, что его разметку разобрали.
 */
const RAW_WARNING =
  'Часть разметки не разобрана — эти блоки сохранятся дословно, «как есть». ' +
  'Нажмите «Применить» ещё раз, чтобы подтвердить.';

/**
 * Правка тела как markdown — для тех, кто пишет разметку руками, и как окно в то, что реально
 * лежит в `body` (а лежит там ровно эта строка: FTS, промпт и MCP читают её же).
 *
 * Экран монтирует тумблер ТОЛЬКО через `lazy()`: значимый импорт `@orbis/shared/doc` тянет всю
 * схему документа (~156 kB gzip), и статический импорт утащил бы её в первый кадр записи.
 */
export function MarkdownToggle({
  doc,
  onChange,
  onClose,
}: {
  doc: BodyDoc;
  onChange: (doc: BodyDoc) => void;
  onClose: () => void;
}) {
  // Мемо, а не голый вызов: сериализация зовётся при КАЖДОМ рендере, то есть на каждое нажатие
  // клавиши в поле, и стоит ~1 мс на теле из сорока блоков (замерено) — платить эту миллисекунду
  // за символ не за что. Показанная строка — канон, ровно содержимое колонки `body`.
  // База сравнения ПОДВИЖНА: придёт новый `doc` (правка с другого устройства) — `initial`
  // пересчитается, и «без изменений» будет считаться относительно НОВОГО документа. Так и
  // задумано: писать поверх чужой правки то же самое незачем.
  const initial = useMemo(() => serializeBody(doc), [doc]);
  // А вот `text` — снимок на момент открытия: набранное пользователем НЕ перетирается
  // приходящим `doc` (автосохранение Задачи 13 отдаёт новый объект документа на каждый круг
  // записи, и живое обновление стирало бы набранный текст под руками).
  const [text, setText] = useState(initial);
  // ОДНО состояние на подтверждение и предупреждение, а не два: они всегда поднимаются и
  // гаснут вместе, и разъехаться им можно было бы только по ошибке.
  const [awaitingRawConfirm, setAwaitingRawConfirm] = useState(false);

  function apply() {
    // Без изменений — без записи: лишняя мутация подняла бы updated_at ни за что.
    if (text === initial) {
      onClose();
      return;
    }
    const next = parseBody(text);
    // `.some`, а не «весь документ — один rawBlock»: непонятое уезжает в raw ПОБЛОЧНО, и
    // частичная неразобранность (абзац + картинка) — самый обычный случай.
    //
    // Верхнего уровня ДОСТАТОЧНО, слепого пятна тут нет: `parseBody` строит rawNode только в
    // цикле по токенам верхнего уровня, а непонятое внутри (картинка в цитате, в пункте списка,
    // в ячейке таблицы) утаскивает в raw ВЕСЬ блок целиком — вложенным rawBlock не бывает по
    // построению (проверено пробой на пяти вложениях).
    const hasRaw = (next.doc.content ?? []).some((node) => node.type === 'rawBlock');
    if (hasRaw && !awaitingRawConfirm) {
      // НЕ закрываемся: в закрытом тумблере предупреждения не увидел бы никто, а юнит-тест
      // остался бы зелёным — спай `onClose` компонент не размонтирует (ревью И12).
      setAwaitingRawConfirm(true);
      return;
    }
    onChange(next);
    // Гасим плашку ДО закрытия: сегодня родитель тумблер размонтирует, но Задача 15 вправе
    // спрятать его через `hidden` или переиспользовать смонтированным — и тогда при следующем
    // открытии всплыло бы предупреждение о разметке, которой в новом теле может уже не быть.
    setAwaitingRawConfirm(false);
    onClose();
  }

  return (
    <div className="flex flex-col gap-2">
      <textarea
        data-testid="markdown-source"
        aria-label="Тело записи как markdown"
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          // Подтверждение и предупреждение относятся к ПРЕЖНЕМУ тексту: новый разбирается
          // заново, и переносить на него согласие «сохранить как есть» нельзя.
          setAwaitingRawConfirm(false);
        }}
        // Кольцо фокуса, а не голый outline-none: поле без рамки лежит прямо на листе, и с
        // погашенным контуром пришедшего табуляцией фокуса не видно вовсе. Пара классов — та
        // же, что у textarea тела в DetailScreen.tsx:315.
        className="min-h-64 w-full resize-none rounded-lg bg-transparent px-2 py-1.5 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
      />
      {awaitingRawConfirm && (
        // text-alert, а НЕ text-warning: --color-warning объявлен цветом заливки бара и на
        // белом листе даёт 3.18:1 (документировано в NativeRow.tsx:92, GoalProgress.tsx:55-57).
        <p role="alert" className="text-sm text-alert">
          {RAW_WARNING}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Отмена
        </Button>
        <Button size="sm" onClick={apply}>
          Применить
        </Button>
      </div>
    </div>
  );
}
