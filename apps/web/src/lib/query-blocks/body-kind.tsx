import type { BodyKind } from '@orbis/shared/doc/placement';
import { createContext, type ReactNode, useContext } from 'react';

/**
 * Род тела, внутри которого рисуется блок: заметка, страница или шаблон (спека страниц 1а §5.5,
 * §5.6). От него зависит, что блок вправе показать: абсолютная дата в запросе законна в заметке
 * (она документ) и — ошибка блока на странице и в шаблоне (они живут годами).
 *
 * Контекст, а не проп — по тому же доводу, что `ThisEntityProvider`: блок доезжает до виджета
 * через тело (первый кадр, NodeView внутри ProseMirror), и протаскивать род через эти слои
 * значило бы менять их сигнатуры ради данных, которых они не касаются.
 */
const BodyKindContext = createContext<BodyKind>('note');

export function BodyKindProvider({ kind, children }: { kind: BodyKind; children: ReactNode }) {
  return <BodyKindContext.Provider value={kind}>{children}</BodyKindContext.Provider>;
}

/**
 * Умолчание — `'note'`: вне хоста страницы или шаблона тело рисуется только у обычной записи,
 * и строже заметки обходиться с ним нельзя — блок, законный в заметке, погас бы плашкой.
 */
export function useBodyKind(): BodyKind {
  return useContext(BodyKindContext);
}
