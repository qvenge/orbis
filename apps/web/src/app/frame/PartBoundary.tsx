import { Component, type ReactNode } from 'react';

type Props = {
  children: ReactNode;
  /** Кадр части, которая упала, — на её месте, того же размера: соседи рамки остаются. */
  fallback: ReactNode;
  /** Смена значения снимает прошлый провал (новое приложение — сайдбар пробует заново). */
  resetKey?: string;
};
type State = { failed: boolean; shownFor: string | undefined };

/**
 * Граница ошибок одной части рамки десктопа (гейт 25, I-1): рейки, сайдбара, тела бокового чата. Они
 * стоят вне `<main>` и его границы, а выше границ нет — без этой любая ошибка рисования в них
 * (карточка чата неожиданной формы) уносила бы весь React-корень в белый экран. Упала часть — на её
 * месте свой кадр, основная область и элементы хоста живут (§6.6).
 *
 * Не `ChunkErrorBoundary`: её кадр — шапка экрана с присутствием хоста, а в колонке рамки она
 * повторила бы элементы хоста второй раз.
 */
export class PartBoundary extends Component<Props, State> {
  state: State = { failed: false, shownFor: undefined };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: Props, state: State): State | null {
    if (props.resetKey === state.shownFor) return null;
    return { failed: false, shownFor: props.resetKey };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
