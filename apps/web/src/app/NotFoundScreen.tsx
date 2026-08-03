import { SearchX } from 'lucide-react';
import { useNav } from '../state/navigation';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { ScreenHeader } from './ScreenHeader';

/**
 * Экран «не найдено» (02-core-os §1.3): ссылка на удалённую или чужую запись. Честный
 * тупик вместо вечного скелетона — запрос уже вернулся, данных не будет никогда.
 *
 * Шапка обязательна: экран лежит в стеке как обычный push-экран, и без «Назад» уйти
 * с него можно было бы только кнопкой. Заголовок «Не найдено» живёт именно в шапке —
 * в теле его не дублируем, там пояснение, зачем пользователь сюда попал.
 *
 * «На главную» — `resetTabToRoot` активной вкладки: сворачиваем стек целиком, а не pop.
 * Под мёртвым экраном у пришедшего по ссылке ничего своего нет, и возвращать его
 * в позицию, которой он не видел, незачем.
 */
export function NotFoundScreen() {
  const activeTab = useNav((s) => s.activeTab);
  const resetTabToRoot = useNav((s) => s.resetTabToRoot);

  return (
    <>
      <ScreenHeader title="Не найдено" />
      <EmptyState
        icon={<SearchX size={32} aria-hidden />}
        title="Запись удалена или недоступна"
        action={
          <Button variant="outline" onClick={() => resetTabToRoot(activeTab)}>
            На главную
          </Button>
        }
      />
    </>
  );
}
