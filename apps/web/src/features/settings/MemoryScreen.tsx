// Экран «Память AI» (02-core-os §2.7): Browser, отфильтрованный по аспекту
// orbis/memory, с поясняющим текстом сверху. Отдельного хранилища и отдельного
// редактора нет: правка формулировки и архивация — обычный DetailScreen (§7.4:
// архивная memory-сущность в контекст не инжектится).
//
// EntityList (features/browser) намеренно НЕ переиспользован (K10): он жёстко пушит
// detail в стек таба browser, а этот экран открывается поверх АКТИВНОГО таба (в
// настройки входят из chat/budget) — тап по правилу визуально «ничего бы не сделал».
// Пустое состояние Browser'а («добавьте через быструю запись ниже») для памяти тоже
// неверно: правила рождаются из эскалации, а не из быстрой записи. Общий с Browser'ом
// хук useEntities оставлен: строку запроса собирает browserQuery, и своего sortBy
// добавлять нельзя — повтор параметра ломает парсер грамматики.
import { parseRuleTitle } from '@orbis/shared';
import { AlertTriangle, Brain } from 'lucide-react';
import { ScreenHeader } from '../../app/ScreenHeader';
import { useNav } from '../../state/navigation';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { EmptyState } from '../../ui/EmptyState';
import { Skeleton } from '../../ui/Skeleton';
import { EntityRow } from '../browser/EntityRow';
import { useEntities } from '../browser/useEntities';

/**
 * Единственная конструкция фильтра: sortBy/limit дописывает browserQuery (см. шапку).
 * Экспортирован ради пиннинга: боевой текст обязан разбираться каноном (§А5-3).
 */
export const MEMORY_FILTER = 'aspect=orbis/memory';

const ROW_CLASS =
  'flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50';

/**
 * Правило со сломанным форматом заголовка (уборочная фаза). Диагноз ставится и на
 * detail-экране при правке, но приходят сюда СПЕЦИАЛЬНО ревизовать память — и в списке
 * мёртвое правило было неотличимо от рабочего. Источник неканоничных заголовков не только
 * рука владельца: модель тоже создаёт memory-сущности, а формат ей нигде не задан.
 */
function isBrokenRule(e: { title: string; aspectsMap: unknown }): boolean {
  const memory = (e.aspectsMap as Record<string, { kind?: unknown } | undefined>)['orbis/memory'];
  return memory?.kind === 'rule' && parseRuleTitle(e.title) === null;
}

/** Detail открывается в ТЕКУЩЕМ табе (экран памяти живёт в его же стеке). */
function openEntity(id: string) {
  const { activeTab, push } = useNav.getState();
  push(activeTab, { kind: 'entity', id });
}

export function MemoryScreen() {
  const { entities, hasMore, loadMore, isLoading, isError } = useEntities(MEMORY_FILTER);

  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title="Память AI" />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
        <p data-testid="memory-intro" className="text-sm leading-relaxed text-text-secondary">
          Это всё, что AI помнит о вас между разговорами: <b>факты</b> — знания о вас,{' '}
          <b>правила</b> — как разбирать ввод («кофе → Развлечения»); правила появляются и сами, из
          повторных исправлений. Откройте запись, чтобы поправить формулировку или заархивировать её
          — архивная запись перестаёт влиять на ответы.
        </p>

        {/* Ошибку показываем явно и ПЕРЕД пустотой: упавший запрос и пустая память
            выглядят одинаково, а «AI пока ничего не запомнил» на отказе — ложь про
            содержимое графа, из-за которой владелец заведёт правила заново. Та же
            норма, что на Повестке (плашка «Не удалось загрузить просроченное»). */}
        {isError ? (
          <p data-testid="memory-error" className="text-sm text-text-muted">
            Не удалось загрузить память
          </p>
        ) : isLoading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
          </div>
        ) : entities.length === 0 ? (
          <div data-testid="memory-empty">
            <EmptyState
              icon={<Brain size={32} aria-hidden />}
              title="AI пока ничего не запомнил"
              hint="Попросите его что-то запомнить — или исправьте категорию дважды подряд, и он предложит правило"
            />
          </div>
        ) : (
          <Card className="p-1">
            <ul className="flex flex-col gap-px">
              {entities.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    data-testid="memory-row"
                    onClick={() => openEntity(e.id)}
                    className={ROW_CLASS}
                  >
                    <EntityRow entity={e} />
                    {isBrokenRule(e) && (
                      <span
                        data-testid="memory-broken"
                        title="Формат правила не распознан — быстрый ввод и импорт его не применят"
                        className="flex shrink-0 items-center gap-1 text-2xs text-alert"
                      >
                        <AlertTriangle size={12} aria-hidden />
                        формат
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {hasMore && (
          <Button variant="ghost" onClick={loadMore} className="self-center">
            Показать ещё
          </Button>
        )}
      </div>
    </div>
  );
}
