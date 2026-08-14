import type { AnyExtension } from '@tiptap/core';
import type { Editor } from '@tiptap/react';
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { trpc } from '../../../trpc';
import { useToast } from '../../../ui/toast-store';
import { filterSlashItems, SLASH_ITEMS } from './items';
import { type MenuRow, SlashMenu, type SlashMenuHandle } from './SlashMenu';
import { closeSuggest, type SuggestSnapshot, suggestionExtensions } from './suggestion';

/**
 * Идентификаторы служебных строк `@`-меню. С id сущности не столкнутся: те — uuid.
 * Строки состояния ДЕЙСТВИЯ не имеют — `pick` их просто не находит и молчит, а Enter при этом
 * не проваливается в редактор переносом строки.
 */
const CREATE_ROW = 'create-from-typed';
const SEARCHING_ROW = 'suggest-searching';
const FAILED_ROW = 'suggest-failed';

export type EditorSuggest = {
  /** Расширения для useEditor — стабильный массив, схему редактора не меняют. */
  extensions: AnyExtension[];
  active: SuggestSnapshot | null;
  /**
   * ЖИВОЙ снимок: он обновляется на каждую букву, тогда как `active` — снимок кадра рендера.
   * Разница важна ровно там, где между выбором строки и вставкой есть ожидание сети.
   */
  live: RefObject<SuggestSnapshot | null>;
  handleRef: RefObject<SlashMenuHandle | null>;
  close: () => void;
};

/**
 * Состояние обоих меню. Живёт в React, а не в плагине, и это не деталь вкуса: строки `@`
 * приезжают из `entity.suggest` через tRPC, а плагинный `items` жил бы вне React Query — без
 * кэша, без отмены устаревшего запроса и без единого следа в тестовом харнессе.
 */
export function useEditorSuggest(): EditorSuggest {
  const [active, setActive] = useState<SuggestSnapshot | null>(null);
  // Зеркало состояния для колбэков: они собраны ОДИН раз (иначе пересборка расширений
  // пересобирала бы схему редактора), и замыкание на `active` в них навсегда осталось бы
  // на первом значении.
  const activeRef = useRef<SuggestSnapshot | null>(null);
  const handleRef = useRef<SlashMenuHandle | null>(null);

  const extensions = useMemo(
    () =>
      suggestionExtensions({
        onOpen: (s) => {
          activeRef.current = s;
          setActive(s);
        },
        // Сверки «а мой ли это вход?» здесь НЕТ, и это замерено, а не забыто. Два меню
        // одновременно открытыми не бывают: `/` не срабатывает после буквы, `@` — тоже
        // (allowedPrefixes у suggestion — пробел или начало строки), а пункт «Ссылка на
        // сущность» набирает `@` ОТДЕЛЬНОЙ транзакцией после той, что сняла `/ссыл`, —
        // выход `/` приходит раньше входа `@`. Мутационная проверка это подтвердила:
        // вариант со сверкой вида неотличим от этого ни одним тестом файла.
        onClose: () => {
          setActive(null);
          activeRef.current = null;
        },
        onKeyDown: (_kind, event) => handleRef.current?.onKeyDown(event) ?? false,
      }),
    [],
  );

  const close = useCallback(() => {
    const cur = activeRef.current;
    // `isDestroyed` — не перестраховка: закрытие зовут и обработчики жизненного цикла
    // (уход фокуса), а blur прилетает в том числе при сносе редактора — диспатч в
    // уничтоженный view упал бы необработанной ошибкой прогона при зелёных ассертах
    // (та же ловушка, что у эффекта в BodyEditor).
    if (cur !== null && !cur.view.isDestroyed) closeSuggest(cur.view, cur.kind);
  }, []);

  return { extensions, active, live: activeRef, handleRef, close };
}

/**
 * Строки меню и то, что делает выбор. Компонент смонтирован ВСЕГДА (запросы — хуки, а хуки
 * условными не бывают) и сам решает, рисовать ли список.
 */
export function SuggestMenu({
  editor,
  suggest,
}: {
  editor: Editor | null;
  suggest: EditorSuggest;
}) {
  const { active, live, handleRef, close } = suggest;
  const { show } = useToast();
  const open = active !== null;
  // Счётчик перерисовки, а не хранимые координаты: единственный источник правды о позиции —
  // живая `active.rect()`, и держать рядом её копию значило бы завести второй источник,
  // который разъедется при первой же прокрутке между тиком и рендером.
  const [, repaint] = useReducer((n: number) => n + 1, 0);

  /**
   * Жизненный цикл меню. Плагин `@tiptap/suggestion` пересчитывает своё состояние ТОЛЬКО на
   * транзакциях редактора — ни `blur`, ни `handleDOMEvents` у него нет (проверено по
   * dist/index.js). Значит, всё, что происходит МИМО документа, обязаны закрыть мы сами:
   * клик по сайдбару транзакции не даёт, и панель `fixed z-50` осталась бы висеть поверх
   * всего приложения на координатах момента открытия.
   *
   * Прокрутка и смена размера окна документ тоже не трогают — на них меню не закрывается, а
   * ПЕРЕСЧИТЫВАЕТСЯ: каретка на месте, уехала только её проекция на экран.
   */
  useEffect(() => {
    if (!open) return;
    const onOutside = (e: Event) => {
      const el = e.target as HTMLElement | null;
      // Клик по самому меню — это выбор строки, а не уход: закрыть его здесь значило бы
      // снять меню раньше, чем сработает `onMouseDown` строки (слушатель в capture-фазе
      // приходит первым).
      if (el?.closest('[data-suggest-menu]')) return;
      // Клик по телу редактора закрывает меню САМ — сменой каретки, то есть транзакцией.
      // Перебивать это здесь незачем, а вредно: клик по уже набранному `/` не должен
      // гасить только что открытое меню.
      if (editor !== null && el !== null && editor.view.dom.contains(el)) return;
      close();
    };
    const onMove = () => repaint();
    // Прокрутка не всплывает — слушаем в capture-фазе, иначе прокрутка ЛЮБОГО контейнера
    // (а тело записи живёт внутри скроллящегося экрана) до окна не доедет.
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    document.addEventListener('pointerdown', onOutside, true);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
      document.removeEventListener('pointerdown', onOutside, true);
    };
  }, [open, editor, close]);

  // Уход фокуса — отдельный сигнал, а не дубль клика снаружи: фокус уводят и табом, и
  // программно, и ни одно из этих событий указателем не сопровождается.
  useEffect(() => {
    if (!open || editor === null) return;
    editor.on('blur', close);
    return () => {
      editor.off('blur', close);
    };
  }, [open, editor, close]);
  const term = active?.kind === 'mention' ? active.query : '';
  // Поле входа — `term` (контракт entitySuggestInput): не `prefix` (сопоставление идёт по
  // ВХОЖДЕНИЮ) и не `query` — это слово в кодовой базе занято смарт-листами.
  // Пустой запрос до сети не доходит вовсе: у входа есть min(1), и `@` без единой буквы
  // получил бы ошибку валидации вместо пустого списка.
  const found = trpc.entity.suggest.useQuery({ term }, { enabled: term !== '', staleTime: 10_000 });
  const create = trpc.entity.create.useMutation();

  /**
   * Строки `@`-меню. Порядок веток — это порядок обещаний, а не вкусовщина.
   *
   * Строки «Создать …» нет, пока поиск не ОТВЕТИЛ про этот самый набор: Enter, нажатый
   * быстрее ответа, молча заводил бы ДУБЛЬ уже существующей сущности — и человек этого не
   * заметил бы, потому что чип с правильной подписью на экране появился бы. Вместо неё
   * стоит немая строка состояния: меню не мигает между буквами, Enter не проваливается в
   * редактор переносом строки, а обещать нечего — и оно ничего не обещает.
   */
  function mentionRows(): MenuRow[] {
    if (term === '') return []; // `@` без единой буквы: искать нечего и предлагать нечего
    if (found.isError) return [{ id: FAILED_ROW, label: 'Поиск недоступен' }];
    if (!found.isSuccess) return [{ id: SEARCHING_ROW, label: 'Поиск…' }];
    return [
      ...found.data.map((e) => ({
        id: e.id,
        label: e.emoji ? `${e.emoji} ${e.title}` : e.title,
      })),
      // Создание из набранного: иначе «упомянуть то, чего ещё нет» требовало бы уйти с
      // экрана и потерять мысль.
      { id: CREATE_ROW, label: `Создать «${term}»` },
    ];
  }

  const rows: MenuRow[] =
    active === null
      ? []
      : active.kind === 'slash'
        ? filterSlashItems(active.query).map((i) => ({ id: i.id, label: i.label, hint: i.hint }))
        : mentionRows();

  function insertRef(entityId: string, label: string): void {
    if (editor === null || active === null) return;
    // Диапазон берём ЖИВОЙ, а не из кадра рендера: между выбором строки и вставкой может
    // стоять создание сущности (ожидание сети), и всё, что человек за это время дописал,
    // осталось бы хвостом после чипа. Живой снимок едет за набором; если меню за это время
    // закрылось совсем — остаётся диапазон кадра, другого адреса всё равно нет.
    const range = live.current?.range ?? active.range;
    // Хвостовой пробел не украшение: entityRef — атом, и без него каретка осталась бы
    // прижатой к чипу, а следующая буква уехала бы ему в подпись на глаз человека.
    editor
      .chain()
      .focus()
      .deleteRange(range)
      .insertContent([
        { type: 'entityRef', attrs: { entityId, label } },
        { type: 'text', text: ' ' },
      ])
      .run();
  }

  async function pick(id: string): Promise<void> {
    if (editor === null || active === null) return;
    if (active.kind === 'slash') {
      const item = SLASH_ITEMS.find((i) => i.id === id);
      if (item === undefined) return;
      // Диапазон запроса снимает вызывающая сторона — пункт работает по чистому месту.
      editor.chain().focus().deleteRange(active.range).run();
      item.run(editor);
      return;
    }
    if (id === CREATE_ROW) {
      // Второй Enter по той же строке — второй Enter, а не вторая сущность.
      if (create.isPending) return;
      try {
        const created = await create.mutateAsync({
          input: { title: term, tags: [] },
          source: 'ui', // прямое действие владельца в интерфейсе (§7.5)
        });
        insertRef(created.id, term);
      } catch {
        // Отказ ГРОМКИЙ, и набранное остаётся текстом: молча проглоченное создание — та же
        // потеря мысли, только без следа.
        show('Не удалось создать сущность', 'danger');
        close();
      }
      return;
    }
    // Строки состояния («Поиск…», «Поиск недоступен») сюда доходят и не находятся — это и
    // есть их немота: делать им нечего, а Enter уже погашен меню.
    const row = (found.data ?? []).find((e) => e.id === id);
    if (row !== undefined) insertRef(row.id, row.title);
  }

  if (active === null) return null;
  // Координаты берутся ЗАНОВО на каждый рендер — в том числе на тот, что вызвала прокрутка.
  const rect = active.rect();
  return (
    <SlashMenu
      ref={handleRef}
      rows={rows}
      onPick={(id) => void pick(id)}
      onClose={close}
      coords={{ left: rect?.left ?? 0, top: rect?.bottom ?? 0 }}
    />
  );
}
