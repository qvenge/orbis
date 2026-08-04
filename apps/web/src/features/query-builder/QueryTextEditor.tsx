import { parseQuery } from '@orbis/shared';
import { useId, useMemo, useRef, useState } from 'react';
import { buildCatalogFromAspects } from '../../lib/query-blocks/parse';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';

// Примитива Textarea в src/ui нет (как и Select — см. ReviewTable): своя строка на своём
// элементе, а не перекрытие классов чужого компонента.
const FIELD_CLS =
  'w-full resize-y rounded-control border border-line bg-surface px-2 py-1.5 font-mono text-sm text-text transition focus-visible:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40';

/**
 * Строковый редактор query-блока (§6.1 — грамматика, §6.4 — что делать с невалидным).
 * Монтируется по «Настроить» на виджете; смонтирован — значит открыт, закрытие идёт через
 * onCancel/onSave (свой флаг open здесь был бы вторым источником правды о видимости).
 *
 * Сохранение доступно ВСЕГДА, в том числе у невалидной строки: §6.4 нормирует битый блок
 * как состояние продукта (красная плашка с позицией), а не как запрет на запись — иначе из
 * блока, который правится в несколько приёмов, нельзя было бы выйти.
 *
 * Ошибку считает сам редактор по ТЕКУЩЕМУ тексту, а не принимает готовую снаружи: замри
 * сообщение на исходном разборе, починенный запрос продолжал бы носить красную плашку, а
 * вызывающему пришлось бы завести второй разбор с каталогом аспектов ровно ради статики.
 */
export function QueryTextEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (query: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const field = useRef<HTMLTextAreaElement>(null);
  const fieldId = useId();
  const errorId = useId();

  const aspects = trpc.aspect.list.useQuery();
  const catalog = useMemo(
    () => (aspects.data ? buildCatalogFromAspects(aspects.data) : null),
    [aspects.data],
  );
  // Разбор ровно того, что уедет в блок: в поле лежит ВНУТРЕННОСТЬ {{query:…}} (обёртку
  // приставит замена подстроки), и края текста в блок всё равно не попадут — .trim() здесь
  // тот же, что в replaceQueryBlock, иначе позиция ошибки считалась бы по одной строке, а
  // сохранялась другая. Поблажки parseBlock на обёртку тут быть НЕ должно: вставленный
  // целиком блок она разобрала бы молча, а сохранение вложило бы {{query: внутрь {{query:.
  const parsed = useMemo(
    () => (catalog ? parseQuery(text.trim(), catalog) : null),
    [catalog, text],
  );
  const error = parsed?.ok === false ? parsed.error : null;

  return (
    <Dialog
      open
      // Фокус — в поле, каретка в конец: редактор открыт по явному действию, и лишний Tab
      // до единственного поля модалки был бы платой ни за что. Штатным хуком Radix, а не
      // отложенным кадром наперегонки с его фокус-ловушкой: своё «потом» выигрывало бы у
      // неё по расписанию, оставляя в настоящем браузере кадр с фокусом на крестике.
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        const el = field.current;
        if (el === null) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }}
      onOpenChange={(v) => {
        // Esc, крестик и клик по подложке — тот же отказ от правки, что «Отмена».
        if (!v) onCancel();
      }}
      title="Настройка блока"
    >
      <div className="mt-3 flex flex-col gap-3">
        <label htmlFor={fieldId} className="text-sm text-text-secondary">
          Текст запроса
        </label>
        <textarea
          id={fieldId}
          ref={field}
          data-testid="query-text-edit"
          value={text}
          rows={5}
          spellCheck={false}
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : errorId}
          onChange={(e) => setText(e.target.value)}
          className={FIELD_CLS}
        />
        {error !== null && (
          // role="status", а не alert: сообщение пересчитывается на каждый символ, и
          // ассертивная озвучка перебивала бы собственный набор пользователя.
          <p id={errorId} role="status" data-testid="query-text-error" className="text-sm">
            <span className="text-danger">{error.message}</span>{' '}
            <span className="text-text-muted">— позиция {error.position}</span>
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            Отмена
          </Button>
          <Button size="sm" onClick={() => onSave(text)}>
            Сохранить
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
