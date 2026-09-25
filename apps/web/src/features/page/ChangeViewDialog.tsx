import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import type { ChangeViewQuestion } from './change-view';

/** Подсказка кнопки «Сохранить версией и убрать» (спека страниц 1а §8.4, Р-19). */
export const HIDE_AS_VERSION_HINT =
  'Пока текст лежит в версии, его не видят поиск и агент. Вернуть — «Открыть как запись» → «Детали» → «Версии».';

/**
 * Первая фраза вопроса. `no-body` — текст Р-19 дословно (§8.4). `breaks-template` — тело шаблон
 * показывает, но текст записи несёт блоки страницы и на месте `{{body}}` сломал бы
 * шаблон: вопрос и кнопки те же, а причина названа своя — иначе фраза «текст не показывается» была
 * бы неправдой.
 */
export const CHANGE_VIEW_QUESTION: Readonly<Record<ChangeViewQuestion, string>> = {
  'no-body': 'В этом шаблоне текст записи не показывается, а у записи он есть.',
  'breaks-template':
    'В тексте записи есть блоки страницы — на месте тела они сломали бы шаблон, поэтому текст записи не подставлен.',
};

/**
 * Вопрос случая 3 «Изменить вид только этой записи» (§8.4, Р-19): шаблон тело не показывает, а у
 * записи текст есть. «Как раньше» и сохранность текста разом невозможны, и решить за владельца
 * нельзя ни в одну сторону — молча убранный текст пропал бы из поиска, молча дописанный изменил бы
 * вид (С1а-8).
 *
 * Про версию сказано прямо, в подсказке кнопки: текст из закреплённой версии поиск и агент не
 * видят, и узнать об этом потом, не найдя свою заметку, было бы хуже, чем выбрать «Показать внизу».
 */
export function ChangeViewDialog({
  reason,
  onHideAsVersion,
  onShowBelow,
  onCancel,
}: {
  reason: ChangeViewQuestion;
  onHideAsVersion: () => void;
  onShowBelow: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title="Изменить вид только этой записи"
    >
      <div className="flex flex-col gap-3 pt-2">
        <p className="text-sm text-text-secondary">
          {CHANGE_VIEW_QUESTION[reason]} Что с ним сделать?
        </p>
        <div className="flex flex-col gap-1">
          <Button onClick={onHideAsVersion} aria-describedby="change-view-version-hint">
            Сохранить версией и убрать
          </Button>
          <p id="change-view-version-hint" className="text-2xs text-text-muted">
            {HIDE_AS_VERSION_HINT}
          </p>
        </div>
        <Button variant="outline" onClick={onShowBelow}>
          Показать внизу страницы
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Отмена
        </Button>
      </div>
    </Dialog>
  );
}
