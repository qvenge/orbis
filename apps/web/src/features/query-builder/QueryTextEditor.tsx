// BLOCK_END — из `@orbis/shared` (грамматика запроса), а НЕ из `@orbis/shared/doc`, где та же
// пара символов зовётся QUERY_BLOCK_CLOSE. Причина — СЛОЙ, а не вес: этот файл про грамматику
// запроса, и рубеж он держит тот же самый, что serializeQuery, — что откажется напечатать
// сериализатор, того редактор не даёт и набрать. Возьми он константу у схемы документа —
// редактор запроса стал бы зависеть от чужой грамматики, и разойтись с собственным
// сериализатором ему стало бы нечем помешать.
//
// Довода «иначе утащили бы вес схемы» здесь НЕТ, и это проверено сборкой, а не выведено:
// `QueryTextEditor` лежит в чанке `BodyEditor-*.js`, который схему (`doc-*.js`) статически
// импортирует и без него, — импорт из `@orbis/shared/doc` стоил бы тут ноль байт. Решение
// верное, но обосновывать его числом, которого нет, значит подсунуть следующему читателю
// ложную опору (ревью раунда 2).
import { BLOCK_END, parseQuery } from '@orbis/shared';
import { useId, useMemo, useRef, useState } from 'react';
import { useFieldCatalog } from '../../lib/query-blocks/useFieldCatalog';
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
 *
 * Единственное исключение из «сохранить можно всегда» — `}}` в тексте, и оно про РАЗМЕТКУ
 * тела, а не про грамматику: невалидная строка живёт ВНУТРИ блока и починится следующей
 * правкой, а `}}` — это конец обёртки. Парсер его принимает молча (`tags=a}}b` разбирается
 * без ошибки, красной плашки нет), рендерер же закроет блок на первом вхождении: хвост
 * запроса уедет текстом заметки, а `{{query:` в этом хвосте заведёт ЛИШНИЙ блок и сдвинет
 * нумерацию — на первом блоке стоит бейдж pinned-сущности (§3.2). Кавычки тут не спасают
 * (грамматики рендерер не знает), поэтому единственный выход — не пустить такую строку.
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
  const brokenId = useId();

  const { catalog } = useFieldCatalog();
  // В поле лежит ВНУТРЕННОСТЬ {{query:…}} — обёртку приставит сериализация документа. Края
  // текста разбору не помеха, а вот в атрибут ноды они уезжают как есть, и это НАМЕРЕННО:
  // сидированные блоки многострочны, и подстриженный край переписал бы их одной строкой при
  // первой же правке (см. тесты «„Настроить“ открывает редактор блока с ДОСЛОВНЫМ текстом» и
  // «правка блока не съедает обрамляющие пробелы обёртки»).
  //
  // ИЗВЕСТНЫЙ ОСТАТОК (принятый долг, не лечится здесь): `position` в плашке ошибки ниже
  // считается по ТРИМЛЕННОМУ тексту, а в поле человек видит нетримленный. У блока с ведущим
  // переносом и отступом — то есть у любого сида §3.3 — показанная позиция смещена на длину
  // этого края. Раньше расхождения не было: правка блока шла заменой подстроки, которая тем же
  // `.trim()` края и отрезала. Лечить надо сдвигом позиции на длину `trimStart`, а не тримом
  // текста — трим вернул бы схлопывание сидов, ради которого края здесь и сохраняются.
  //
  // Поблажки parseBlock на обёртку тут быть НЕ должно: вставленный целиком блок она разобрала
  // бы молча, а сохранение вложило бы {{query: внутрь {{query:.
  const parsed = useMemo(
    () => (catalog ? parseQuery(text.trim(), catalog) : null),
    [catalog, text],
  );
  const error = parsed?.ok === false ? parsed.error : null;
  // Проверяем ВЕСЬ текст поля, а не тримленный: у `}}` на краю разбора может и не быть, а
  // пролом обёртки он делает такой же — и в блок этот край, в отличие от прежней замены
  // подстроки, доезжает дословно.
  const breaksBlock = text.includes(BLOCK_END);

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
          aria-invalid={error !== null || breaksBlock}
          aria-describedby={
            [error === null ? null : errorId, breaksBlock ? brokenId : null]
              .filter((id) => id !== null)
              .join(' ') || undefined
          }
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
        {breaksBlock && (
          // Отдельное сообщение, а не текст ошибки парсера: у `}}` разбора может и не быть
          // (`tags=a}}b` разбирается), и причина у него другая — не «запрос непонятен», а
          // «этим текстом закроется сам блок». Тот же role="status", что у плашки разбора:
          // сообщение пересчитывается на каждый символ, и alert перебивал бы набор.
          <p id={brokenId} role="status" data-testid="query-text-wrapper" className="text-sm">
            <span className="text-danger">
              Сочетание «{BLOCK_END}» закрывает блок: всё, что после него, стало бы обычным текстом
              заметки.
            </span>{' '}
            <span className="text-text-muted">Уберите его из запроса.</span>
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            Отмена
          </Button>
          {/* Единственный случай, когда «Сохранить» гаснет (§6.4 — про невалидную строку
              ВНУТРИ блока, и она сохраняется как была). */}
          <Button size="sm" disabled={breaksBlock} onClick={() => onSave(text)}>
            Сохранить
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
