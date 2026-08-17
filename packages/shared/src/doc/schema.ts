import type { AnyExtension } from '@tiptap/core';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import StarterKit from '@tiptap/starter-kit';
import { OrbisCode } from './nodes/code';
import { OrbisCodeBlock } from './nodes/code-block';
import { EntityRef } from './nodes/entity-ref';
import { OrbisListItem } from './nodes/list-item';
import { QueryBlock } from './nodes/query-block';
import { RawBlock } from './nodes/raw';

/** Белый список протоколов. Сужает ссылки isAllowedUri — опция `protocols` у Tiptap
 *  РАСШИРЯЕТ базовый список, а не сужает (проверено ревью), поэтому её здесь нет. */
const SAFE_URI = (url: string) => /^(https?|mailto):/i.test(url) || url.startsWith('/');

/**
 * ЕДИНСТВЕННОЕ описание документа Orbis — для сервера и клиента разом.
 *
 * TaskList/TaskItem и TableKit — отдельные пакеты: в StarterKit чеклистов и таблиц НЕТ.
 * UniqueID здесь НЕТ намеренно — он живёт только в редакторе (см. «Известные границы» дизайна).
 *
 * StarterKit конфигурируется ЗДЕСЬ ОДИН РАЗ (ревью Б5, И19):
 * - link.isAllowedUri: `javascript:` и родня ссылкой не становятся. Настраивать надо ИМЕННО
 *   StarterKit — Link живёт внутри него, элемента с name === 'link' в этом массиве нет,
 *   и map по имени молча не нашёл бы никого (так умер белый список в плане v1);
 * - trailingNode: false — иначе StarterKit 3.30.1 дописывает пустой абзац в конец любого
 *   документа, не кончающегося абзацем: все пять сидов «менялись» при простом открытии,
 *   и автосейв слал фантомный entity_update (ревью Б4);
 * - codeBlock: false, code: false и listItem: false — ноды и марка ТЕ ЖЕ, но со своими
 *   сериализаторами (nodes/code-block.ts — длина ограды по содержимому; nodes/code.ts — длина
 *   разделителя кодовой вставки и подкладка краёв; nodes/list-item.ts — маркер пустого пункта
 *   без хвостового пробела). Отключить штатные обязательно: менеджер разметки держит
 *   обработчики списком на имя и берёт ПЕРВЫЙ (@tiptap/markdown, getHandlerForToken),
 *   поэтому вторая регистрация поверх StarterKit была бы мертворождённой.
 */
export const DOC_EXTENSIONS: AnyExtension[] = [
  StarterKit.configure({
    trailingNode: false,
    link: { isAllowedUri: SAFE_URI },
    codeBlock: false,
    code: false,
    listItem: false,
  }),
  OrbisCode,
  OrbisCodeBlock,
  OrbisListItem,
  TaskList,
  TaskItem,
  TableKit,
  EntityRef,
  QueryBlock,
  RawBlock,
];
