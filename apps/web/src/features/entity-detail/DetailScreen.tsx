import { buildAppPath } from '@orbis/shared';
import { Archive, ArchiveRestore, EllipsisVertical, Link2, Pin } from 'lucide-react';
import { useState } from 'react';
import { NotFoundScreen } from '../../app/NotFoundScreen';
import { ScreenHeader } from '../../app/ScreenHeader';
import { QueryBlock } from '../../lib/query-blocks/QueryBlock';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { DropdownMenu } from '../../ui/DropdownMenu';
import { Input } from '../../ui/Input';
import { Skeleton } from '../../ui/Skeleton';
import { Tabs } from '../../ui/Tabs';
import { useToast } from '../../ui/toast-store';
import { queryBlocks } from '../browser/query';
import { PlannedToFactCard } from '../budget/PlannedToFactCard';
import { usePlanToFactPrompt } from '../budget/usePlanToFactPrompt';
import { ChatThread } from '../chat/ChatThread';
import { AspectCards } from './AspectCards';
import { Backlinks } from './Backlinks';
import { Blocks } from './Blocks';
import { NativeRow } from './NativeRow';
import { Subtasks } from './Subtasks';
import { useEntityDetail } from './useEntityDetail';

export function DetailScreen({ entityId }: { entityId: string }) {
  const { get, toggleTask, saveBody, saveTitle, setArchived, conflict, dismissConflict } =
    useEntityDetail(entityId);
  const utils = trpc.useUtils();
  const settings = trpc.user.getSettings.useQuery();
  const updateSettings = trpc.user.updateSettings.useMutation({
    onSuccess: () => void utils.user.getSettings.invalidate(),
  });
  // §2.7: перевод задачи-покупки в done → карточка «Покупка совершена?» (Task B6).
  // Единственный мутационный путь чекбокса — toggleTask здесь (см. usePlanToFactPrompt).
  const planToFact = usePlanToFactPrompt();
  // §3.5 «Скопировать ссылку». Буфер обмена — не данность: его нет в http-контексте,
  // а разрешение пользователь может и не дать. На отказе показываем саму ссылку
  // (manualLink), чтобы копирование осталось возможным руками, а не превратилось в
  // кнопку, которая молча ничего не делает.
  //
  // Ссылка хранится ВМЕСТЕ с id сущности, которой принадлежит. Роутер монтирует этот
  // экран без key (router.tsx), поэтому переход entity→entity внутри таба — бэклинк,
  // подзадача, блокировка — меняет только проп: инстанс тот же, состояние переживает
  // переход. Голая строка осталась бы висеть под заголовком СОСЕДНЕЙ сущности и
  // предлагала бы скопировать чужой адрес. Сверка id при рендере делает это невозможным
  // по построению, а не «пока не забыли прибраться»: где буфер отказывает (небезопасный
  // контекст), он отказывает каждый раз, и плашка там — не редкий гость.
  const [manualLink, setManualLink] = useState<{ id: string; url: string } | null>(null);
  const { show } = useToast();

  async function copyLink() {
    // Форму пути знает ТОЛЬКО buildAppPath (B1): собранная здесь руками строка разъехалась
    // бы с роутером при первой же правке таблицы маршрутов, и ссылки из чужих писем вели
    // бы в никуда. origin делает её абсолютной — ссылку отправляют наружу, а не внутрь SPA.
    const url = `${window.location.origin}${buildAppPath({ kind: 'entity', id: entityId })}`;
    try {
      // Обращение к navigator.clipboard намеренно внутри try: когда API нет вовсе,
      // это TypeError — та же беда для пользователя, что и отклонённое разрешение.
      await navigator.clipboard.writeText(url);
      setManualLink(null);
      show('Ссылка скопирована');
    } catch {
      setManualLink({ id: entityId, url });
    }
  }

  // §1.3: ссылка на удалённую или чужую сущность. Без этой ветки NOT_FOUND давал вечный
  // скелетон: isLoading уже false, а data не приедет никогда. Проверка — ровно по коду:
  // сеть и 500 «не найдено» не означают, и подменять их этим экраном значило бы врать
  // (такие ошибки остаются на прежнем поведении — это отдельный разговор, не §1.3).
  if (get.isError && get.error.data?.code === 'NOT_FOUND') return <NotFoundScreen />;

  if (get.isLoading || !get.data) {
    return (
      <>
        <ScreenHeader title="…" />
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-3">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-24" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      </>
    );
  }
  const { entity, thread, relations, backlinks, backlinksTruncated } = get.data;
  const blocks = queryBlocks(entity.body ?? '');

  // В шапке — только title; emoji сущности — крупная page-иконка (Notion-style) в строке
  // с заголовком/NativeRow. Нет emoji — ничего не рендерим (без плейсхолдера).
  const entityTab = (
    <div className="flex flex-col gap-6 px-4 pb-10 pt-5 md:px-6">
      {/* Notion-style шапка страницы: крупная emoji-иконка над заголовком. */}
      <div className="flex flex-col gap-3">
        {entity.emoji && (
          <span aria-hidden className="text-4xl leading-none">
            {entity.emoji}
          </span>
        )}
        <NativeRow
          entity={entity}
          onToggleTask={(done) => {
            toggleTask(done);
            // Данные сущности ДО перевода: planned ещё true — карточка на переходе в done
            if (done) planToFact.onTaskDone(entity);
          }}
          onSaveTitle={saveTitle}
        />
      </div>
      {/* Карточка plan→fact (§2.7) — инлайн под строкой задачи, как в мокапе */}
      {planToFact.prompt !== null && (
        <PlannedToFactCard prompt={planToFact.prompt} onClose={planToFact.dismiss} />
      )}
      {conflict && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-control border border-danger/40 bg-danger/10 px-3 py-2"
        >
          <p className="text-sm text-danger">Изменено в другом месте — обновите.</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void get.refetch();
              dismissConflict();
            }}
          >
            Обновить
          </Button>
        </div>
      )}
      {/* key по id, НЕ по updatedAt: refetch после каждого save менял key и ремоунтил
          редактор, стирая текст, набранный за время запроса (а при 409 — ещё и уничтожая
          черновик, который §5.2 предлагает «повторить вручную»). */}
      <BodyEditor key={entity.id} initial={entity.body ?? ''} onSave={saveBody} />
      {/* §3.4: КАЖДЫЙ query-блок body — свой виджет. У сидированного Daily Planning их три
          (Inbox / «Сегодня» / «Ожидание», §3.3), у Upcoming — два; рендер только первого
          прятал «Сегодня» целиком (приёмка 02-core-os §8.4). */}
      {blocks.length > 0 && (
        <div className="flex flex-col gap-3">
          {blocks.map((q, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: порядок блоков задан текстом body
            <QueryBlock key={i} query={q} />
          ))}
        </div>
      )}
      <AspectCards entity={entity} />
      {/* Секции 5–7 §3.5: связи уже приехали этим же entity.get — своих запросов графа
          секции не заводят. */}
      <Subtasks parentId={entity.id} relations={relations ?? []} />
      <Blocks entityId={entity.id} relations={relations ?? []} />
      <Backlinks items={backlinks ?? []} truncated={backlinksTruncated === true} />
    </div>
  );

  return (
    <>
      <ScreenHeader
        title={entity.title}
        actions={
          <DetailMenu
            onPin={() => {
              const pinned = settings.data?.pinnedEntities ?? [];
              updateSettings.mutate({
                pinnedEntities: [...pinned, { id: entity.id, order: pinned.length }],
              });
            }}
            onArchive={() => setArchived(!entity.archived)}
            onCopyLink={() => void copyLink()}
            archived={entity.archived}
          />
        }
      />
      {/* Запасной путь копирования — ВНЕ табов: ссылку просят из меню, а меню одно на оба
          таба, и прятать ответ на вкладке «Сущность» значило бы иногда не отвечать вовсе. */}
      {manualLink !== null && manualLink.id === entityId && (
        <ManualLinkNotice url={manualLink.url} onHide={() => setManualLink(null)} />
      )}
      {/* Табы «Сущность/Тред» — под шапкой; контент центрирован, шапка — на всю ширину. */}
      <div className="mx-auto w-full max-w-3xl">
        <Tabs
          defaultValue="entity"
          tabs={[
            { value: 'entity', label: 'Сущность', content: entityTab },
            {
              value: 'thread',
              label: 'Тред',
              content: thread ? (
                <ChatThread threadId={thread.threadId} />
              ) : (
                <p className="p-3 text-sm text-text-muted">Нет треда</p>
              ),
            },
          ]}
        />
      </div>
    </>
  );
}

function BodyEditor({ initial, onSave }: { initial: string; onSave: (body: string) => void }) {
  const [value, setValue] = useState(initial);
  const [serverBody, setServerBody] = useState(initial);

  // Серверный body сменился (наш save или чужая правка): подхватываем его, только если
  // черновик не трогали. Иначе текст пользователя остаётся — о конфликте сообщает баннер
  // выше, и правку есть что повторить.
  if (initial !== serverBody) {
    setServerBody(initial);
    if (value === serverBody) setValue(initial);
  }

  return (
    // Notion-style: текст лежит прямо на листе — рамка не нужна, hover подсказывает
    // редактируемость, каретка появляется по клику.
    <textarea
      data-testid="body-edit"
      value={value}
      placeholder="Заметки…"
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => value !== serverBody && onSave(value)}
      className="min-h-24 w-full resize-none rounded-lg bg-transparent px-2 py-1.5 text-sm leading-relaxed transition placeholder:text-text-muted hover:bg-surface-2/60 focus:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
    />
  );
}

/**
 * Запасной путь копирования: буфер отказал — показываем сам адрес, чтобы его можно было
 * взять руками. Живёт ВНЕ табов (ссылку просят из меню, а меню одно на оба таба, и
 * прятать ответ на вкладке «Сущность» значило бы иногда не отвечать вовсе).
 */
function ManualLinkNotice({ url, onHide }: { url: string; onHide: () => void }) {
  return (
    <div
      role="alert"
      className="mx-auto mt-3 flex w-full max-w-3xl flex-col gap-2 rounded-control border border-line bg-surface-2 px-3 py-2"
    >
      <p className="text-sm text-text-secondary">
        Буфер обмена недоступен — скопируйте ссылку вручную:
      </p>
      <div className="flex items-center gap-2">
        <Input
          aria-label="Ссылка на сущность"
          readOnly
          value={url}
          // Клик по полю выделяет адрес целиком: копировать руками половину UUID —
          // ровно та беда, ради которой этот запасной путь и заведён.
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1"
        />
        <Button variant="outline" size="sm" onClick={onHide}>
          Скрыть
        </Button>
      </div>
    </div>
  );
}

/**
 * Меню ⋮ шапки detail (§3.5). Раньше «меню» было двумя icon-кнопками в ряд: пункт
 * «Скопировать ссылку» третьей кнопкой сделал бы шапку панелью инструментов, а на узком
 * экране — очередью иконок поверх заголовка. Теперь это настоящее меню, действия внутри.
 */
function DetailMenu({
  onPin,
  onArchive,
  onCopyLink,
  archived,
}: {
  onPin: () => void;
  onArchive: () => void;
  onCopyLink: () => void;
  archived: boolean;
}) {
  const archiveLabel = archived ? 'Разархивировать' : 'Архивировать';
  return (
    <DropdownMenu
      trigger={
        <Button
          size="icon"
          variant="ghost"
          aria-label="Меню"
          title="Меню"
          data-testid="detail-menu"
        >
          <EllipsisVertical size={16} aria-hidden />
        </Button>
      }
      items={[
        { label: 'Закрепить', icon: <Pin size={16} aria-hidden />, onSelect: onPin },
        {
          label: archiveLabel,
          icon: archived ? (
            <ArchiveRestore size={16} aria-hidden />
          ) : (
            <Archive size={16} aria-hidden />
          ),
          onSelect: onArchive,
        },
        {
          label: 'Скопировать ссылку',
          icon: <Link2 size={16} aria-hidden />,
          onSelect: onCopyLink,
        },
      ]}
    />
  );
}
