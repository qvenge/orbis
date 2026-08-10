import { Skeleton } from '../ui/Skeleton';
import { ScreenHeader } from './ScreenHeader';

/**
 * Кадр экрана, чей чанк ещё грузится. Шапка рисуется ЗДЕСЬ, потому что ScreenHeader живёт
 * внутри самих экранов (ScreenHeader.tsx:18): без неё кадр без шапки читался бы прыжком
 * раскладки, а кнопка «Назад» на миг исчезала бы.
 *
 * Форма повторяет уже принятый в проекте вид загружающегося экрана — DetailScreen.tsx:76-88
 * (шапка + скелетоны). Текста «Загрузка…» нет намеренно: Skeleton несёт role="status"
 * aria-label="Загрузка" сам, а browser.test.tsx:97-100 прямо запрещает текстовую подпись
 * вместо скелетона.
 */
export function ScreenFallback() {
  return (
    <>
      {/* Титул — «…», как у DetailScreen на время загрузки данных (DetailScreen.tsx:79).
          Подставлять сюда угаданное название нельзя: заголовки экранов динамические
          («Бюджет · сентябрь», «Транзакции · сентябрь», имя категории), и любой статический
          текст сменился бы на глазах, как только приедет настоящий экран. */}
      <ScreenHeader title="…" />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 p-3">
        <Skeleton className="h-9 w-2/3" />
        <Skeleton className="h-9" />
        <Skeleton className="h-9 w-1/2" />
      </div>
    </>
  );
}
