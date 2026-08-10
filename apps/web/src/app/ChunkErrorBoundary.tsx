import { Component, type ReactNode } from 'react';
import { Button } from '../ui/Button';

type Props = {
  children: ReactNode;
  /**
   * Идентификатор экрана под границей. Смена значения снимает прошлый провал.
   * Без него граница, поймавшая ошибку один раз, держит свой кадр ВЕЧНО — включая
   * вкладки, чьи экраны грузятся статически и ни в чём не виноваты: state класса
   * переживает любую смену children, а другого способа его сбросить у роутера нет.
   * Прокидывать сюда `key` нельзя: он ремонтировал бы и само поддерево, а внутри
   * одного kind'а (DetailScreen со сменой entityId) это стоило бы состояния экрана.
   */
  resetKey?: string;
};
type State = { failed: boolean; shownFor: string | undefined };

/**
 * Единственная граница ошибок в приложении. Заведена под конкретный класс отказа, который
 * ввела ленивая загрузка: чанк экрана не загрузился (устаревшая вкладка после деплоя,
 * пропавшая сеть). Первый такой провал chunk-reload.ts лечит перезагрузкой; сюда доезжает
 * второй — и любая ошибка рендера ленивого поддерева.
 *
 * Кнопка, а не автоматический reload: цикл перезагрузок при настоящей потере сети хуже
 * одного честного экрана. Форма кадра — как у соседа с той же ролью
 * (OnboardingGate.tsx:38-56): role="alert", центр, text-danger, кнопка variant="outline".
 */
export class ChunkErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, shownFor: undefined };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  // Провал помечен экраном, на котором случился (`shownFor` записывается ДО ошибки,
  // на обычном рендере). Пока экран тот же — кадр держится; сменился — снимаем.
  static getDerivedStateFromProps(props: Props, state: State): State | null {
    if (props.resetKey === state.shownFor) return null;
    return { failed: false, shownFor: props.resetKey };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        role="alert"
        className="flex h-full flex-col items-center justify-center gap-3 text-sm text-danger"
      >
        <span>Не удалось загрузить экран</span>
        <Button variant="outline" data-testid="chunk-reload" onClick={() => location.reload()}>
          Обновить
        </Button>
      </div>
    );
  }
}
