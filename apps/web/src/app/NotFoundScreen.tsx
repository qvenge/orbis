import { HOME_SECTION } from '@orbis/shared/nav';
import { SearchX } from 'lucide-react';
import { useNav } from '../state/navigation';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { ScreenHeader } from './ScreenHeader';

/**
 * Экран «не найдено» (02-core-os §1.3): ссылка на удалённую или чужую запись. Честный тупик вместо
 * вечного скелетона — запрос уже вернулся, данных не будет никогда.
 *
 * «На главную» — корень текущего раздела (повторное нажатие на раздел, §7.3): под мёртвым экраном у
 * пришедшего по ссылке ничего своего нет. Это движение ВПЕРЁД (новая запись истории в режиме сайта),
 * а не откат — откатом занята «‹» присутствия хоста.
 */
export function NotFoundScreen() {
  return (
    <>
      <ScreenHeader title="Не найдено" />
      <EmptyState
        icon={<SearchX size={32} aria-hidden />}
        title="Запись удалена или недоступна"
        action={
          <Button
            variant="outline"
            onClick={() => {
              const { model, openSection } = useNav.getState();
              const app = model.activeApp;
              const section = Object.hasOwn(model.apps, app)
                ? (model.apps[app]?.activeSection ?? HOME_SECTION)
                : HOME_SECTION;
              openSection(app, section);
            }}
          >
            На главную
          </Button>
        }
      />
    </>
  );
}
