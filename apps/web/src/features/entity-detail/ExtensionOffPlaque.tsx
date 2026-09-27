import { type ExtensionId, extensionName, OWNER_LOCALE } from '@orbis/shared';
import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { useSetExtensionEnabled } from '../settings/useDisabledExtensions';

/**
 * Плашка «Расширение «…» выключено — [Включить]» (срез 1б §8.3): стоит в карточке аспекта
 * выключенного расширения на месте «Снять аспект». Поля карточки при этом только читаются, а сама
 * карточка не исчезает — пустота вместо неё спрятала бы от владельца его же данные (§8.3 «записи
 * видны») и причину, почему их нельзя поправить.
 *
 * Доверенная плашка ХОСТА, а не часть содержимого: выключение — состояние графа, и сказать о нём и
 * вернуть расширение может только хост. «Включить» — то же действие, что на экране «Приложения и
 * расширения» (`useSetExtensionEnabled` задачи 22: операция `module_set` с тостом «Отменить»), своей
 * копии мутации здесь нет.
 *
 * Модуль ЛЕНИВЫЙ (точка лени — `AspectSection.tsx`): переключатель с тостом и отменой нужен только
 * записи с выключенным расширением, а секция аспекта стоит в первом кадре каждой записи. Статический
 * импорт вывел замыкание экрана записи за порог веса (задача 23: +1 100 Б при запасе 609 Б, РП-25).
 */
export function ExtensionOffPlaque({
  extension,
  readOnly,
}: {
  extension: ExtensionId;
  /**
   * Хост только для чтения — предпросмотр шаблона на чужой записи (1а новое-5): плашка объясняет,
   * почему поля не правятся, но «Включить» не рисуется — включение меняет маску графа, а из режима
   * «только смотрим» не меняется ничего. Пропом от секции, а не `useHostReadOnly` здесь: импорт
   * `record-host` из ленивого чанка вынес бы хост в отдельный общий чанк (+300 Б замыкания — замер).
   */
  readOnly: boolean;
}) {
  const setEnabled = useSetExtensionEnabled();
  const name = extensionName(extension, OWNER_LOCALE);
  // Защёлка двойного нажатия: второй `module_set` лёг бы в журнал вторым действием «Отменить».
  const [pending, setPending] = useState(false);
  return (
    <Card
      role="status"
      data-testid="extension-off"
      className="flex flex-wrap items-center justify-between gap-2 border-dashed"
    >
      <p className="text-sm text-text-secondary">{`Расширение «${name}» выключено`}</p>
      {!readOnly && (
        <Button
          variant="outline"
          size="sm"
          aria-label={`Включить расширение «${name}»`}
          disabled={pending}
          onClick={() => {
            setPending(true);
            void setEnabled(extension, true).finally(() => setPending(false));
          }}
        >
          Включить
        </Button>
      )}
    </Card>
  );
}
