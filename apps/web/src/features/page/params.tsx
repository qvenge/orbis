// Листовой сабпат препрохода, не баррель `@orbis/shared/doc`: провайдер эагерен в экране записи
// (сторожа `check-lazy-chunks.ts` и `save.test.tsx`).
import { type PageNode, type PageParamDecl, paramDeclsOf } from '@orbis/shared/doc/page-grammar';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { useBodyKind } from '../../lib/query-blocks/body-kind';

/**
 * Параметр страницы в web (спека 1в §5.1, РП-15): объявления — из тела, текущие значения — из
 * состояния экрана в истории (`view['param:<имя>']` записи стопки), не из тела и не из адреса.
 *
 * Контекстом, а не пропом — довод `BodyKindProvider`: блок данных доезжает до виджета через тело
 * (рендерер показа, первый кадр, NodeView редактора), и протаскивать значения через эти слои значило
 * бы менять их сигнатуры ради данных, которых они не касаются.
 */

/**
 * Ключ состояния экрана со значением параметра: `param:<имя>` (чат держит `about`, вкладка —
 * `tab:…`). Модель навигации (`@orbis/shared/nav`, `PARAM_VIEW_PREFIX`) переносит через перезапуск
 * ровно ключи с этим префиксом; равенство двух констант пиннит `params.test.tsx`. Своя константа, а
 * не импорт: модуль делят чанк экрана записи, редактор и ленивый переключатель, и импорт модели
 * навигации отсюда выносил её из входного чанка в отдельный (+0,7 КБ gzip замыкания, замер задачи 5).
 */
export const PARAM_VIEW_PREFIX = 'param:';

export interface PageParams {
  /** Объявления тела: первое имя выигрывает (второй блок — плашка «второй»). */
  decls: ReadonlyMap<string, PageParamDecl>;
  /** Значение каждого объявленного параметра — выбранное в истории или умолчание. */
  values: Readonly<Record<string, string>>;
}

/** Вне провайдера и в заметке — пусто: ссылка на параметр там не значит ничего (§3.8). */
const EMPTY: PageParams = { decls: new Map(), values: {} };

const PageParamsContext = createContext<PageParams>(EMPTY);

/**
 * Значения параметров для блоков тела. Объявления берутся только на странице и в шаблоне (род тела
 * — `BodyKindProvider` выше): неуместное объявление заметки блокам не отдаётся — там у блока с `$`
 * и так отказ разбора. Значение `view`, которого нет среди вариантов объявления (старое состояние,
 * правка вариантов), не значит ничего — берётся умолчание, как у открытой впервые страницы.
 *
 * `view` не передан — только умолчания: первый кадр и редактор настройки.
 */
export function PageParamsProvider({
  nodes,
  view,
  children,
}: {
  nodes: readonly PageNode[];
  view?: Readonly<Record<string, string>> | undefined;
  children: ReactNode;
}) {
  const kind = useBodyKind();
  const value = useMemo<PageParams>(() => {
    if (kind === 'note') return EMPTY;
    const decls = paramDeclsOf(nodes);
    // `fromEntries`, а не присваивание по ключу: имя `__proto__` законно (латиница и `_`), и
    // присваивание ушло бы в прототип — параметр читался бы необъявленным.
    const values = Object.fromEntries(
      [...decls].map(([name, decl]) => {
        const picked = view?.[PARAM_VIEW_PREFIX + name];
        return [name, decl.options.find((o) => o === picked) ?? decl.default];
      }),
    );
    return { decls, values };
  }, [kind, nodes, view]);
  return <PageParamsContext.Provider value={value}>{children}</PageParamsContext.Provider>;
}

export function usePageParams(): PageParams {
  return useContext(PageParamsContext);
}
