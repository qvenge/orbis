import type { FileFieldEdit, FileInfo } from '@orbis/shared/files';
import { useLayoutEffect, useReducer, useRef, useState } from 'react';
import { useOnline } from '../../state/retry';
import { captureProductRequest, trpc } from '../../trpc';
import { FileContent } from '../files/FileContent';
import { idFromFileAddress, uploadFile } from '../files/transport';
import { graphFailure } from '../graph-command';
import { useGraphUndo } from '../useGraphUndo';

type Edit = FileFieldEdit['edit'];
type Item = {
  file: File;
  uploadId: string;
  command?: FileFieldEdit;
  info?: FileInfo;
  done: boolean;
  started?: boolean;
  offset: number;
  error?: string;
  expected: string | null;
};
const idsOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : typeof value === 'string'
      ? [value]
      : [];

export function FileFieldControl({
  entityId,
  propertyId,
  value,
  many,
  maxItems,
  readOnly = false,
}: {
  entityId?: string;
  propertyId: string;
  value: unknown;
  many: boolean;
  maxItems?: number;
  readOnly?: boolean;
}) {
  const utils = trpc.useUtils();
  const limits = trpc.files.limits.useQuery(undefined, { enabled: !readOnly });
  const offerUndo = useGraphUndo();
  const online = useOnline();
  const life = useRef(new AbortController());
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new field, record, or access mode ends the old transfer.
  useLayoutEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    return () => controller.abort();
  }, [entityId, propertyId, readOnly]);
  const [confirmed, setConfirmed] = useState<{ basis: unknown; value: unknown }>();
  if (confirmed && confirmed.basis !== value) setConfirmed(undefined);
  const ids = idsOf(confirmed && confirmed.basis === value ? confirmed.value : value);

  const basis = useRef(value);
  basis.current = value;
  const [group, setGroup] = useState<Item[]>([]);
  const [, render] = useReducer((n) => n + 1, 0);
  const [paste, setPaste] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const max = Math.min(limits.data?.maxFiles ?? 0, maxItems ?? Infinity);
  const locked = readOnly || !online || !entityId || busy;
  const unresolved = group.find((item) => item.error && item.command);
  function command(edit: Edit): FileFieldEdit {
    return { entityId: entityId!, propertyId, commandId: crypto.randomUUID(), edit };
  }
  async function commit(input: FileFieldEdit, signal: AbortSignal) {
    const scope = captureProductRequest(signal);
    signal.throwIfAborted();
    if (!scope.isCurrent() || !navigator.onLine) throw Error('Нет соединения с графом');
    const result = await utils.client.files.editField.mutate(input, {
      signal: scope.signal ?? signal,
    });
    signal.throwIfAborted();
    if (!scope.isCurrent()) throw Error('Сессия изменилась');
    if (result.entityId !== entityId || result.propertyId !== propertyId)
      throw Error('Сохранение не подтверждено');
    setConfirmed({ basis: basis.current, value: result.value });

    if (result.actionId)
      offerUndo(result.actionId, 'Изменено файловое поле', undefined, [input.entityId]);
    // Replay can confirm an old result; the canonical record also includes intervening writes.
    void utils.entity.get.invalidate({ id: input.entityId });
  }
  async function act(work: (signal: AbortSignal) => Promise<void>) {
    if (lock.current || locked) return;
    lock.current = true;
    setBusy(true);
    setMessage('');
    const controller = life.current;
    try {
      await work(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) {
        setMessage((error as Error).message);
        setConfirmed(undefined);
        void utils.entity.get.invalidate({ id: entityId });
      }
    } finally {
      lock.current = false;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function transfer(items: Item[], group: Item[], signal: AbortSignal) {
    if (!limits.data) return;
    const scope = captureProductRequest(signal);
    const active = scope.signal ?? signal;
    for (const item of items) {
      active.throwIfAborted();
      if (!scope.isCurrent()) return;
      item.started = true;
      item.error = undefined;
      try {
        const files = utils.client.files;
        item.info ??= await uploadFile(
          {
            begin: (input) => files.begin.mutate(input, { signal: active }),
            finish: (input) => files.finish.mutate(input, { signal: active }),
          },
          item.file,
          item.uploadId,
          limits.data,
          active,
          (offset) => {
            item.offset = offset;
            render();
          },
        );
        if (!scope.isCurrent()) return;
        const next = group.slice(group.indexOf(item) + 1).find((it) => it.done)?.info?.id;
        const edit: Edit = many
          ? { kind: 'add', fileId: item.info.id, ...(next && { beforeId: next }) }
          : { kind: 'set', fileId: item.info.id, expected: item.expected };
        // An unknown outcome is replayed with the exact original payload.
        item.command ??= command(edit);
        await commit(item.command, active);
        item.done = true;
      } catch (error) {
        if (active.aborted) return;
        item.error = (error as Error).message;
        if (item.command) {
          if (graphFailure(error).kind === 'rejected') {
            item.command = undefined;
            setConfirmed(undefined);
            void utils.entity.get.invalidate({ id: entityId });
          } else {
            // Later additions would change the position of a replay of this append.
            // Confirm its original command before moving to the next item.
            render();
            return;
          }
        }
      }
      render();
    }
  }
  function select(files: File[]) {
    if (!files.length || locked || unresolved || !limits.data) return;
    if (many && ids.length + files.length > max) {
      setMessage(`Допустимо файлов: ${max}`);
      return;
    }
    const items = (many ? files : files.slice(0, 1)).map((file) => ({
      file,
      uploadId: crypto.randomUUID(),
      expected: ids[0] ?? null,
      done: false,
      offset: 0,
    }));
    setGroup(items);
    void act((signal) => transfer(items, items, signal));
  }
  const pendingEdit = useRef<FileFieldEdit | null>(null);
  function change(edit: Edit) {
    const input = command(edit);
    void act(async (signal) => {
      pendingEdit.current = input;
      try {
        await commit(input, signal);
      } catch (error) {
        if (graphFailure(error).kind === 'rejected') {
          pendingEdit.current = null;
          if (input.edit.kind === 'reorder')
            throw Error(
              'Порядок изменился. Проверьте обновлённый список и повторите перестановку.',
            );
        }
        throw error;
      }
      pendingEdit.current = null;
      setPaste(null);
    });
  }
  return (
    <div data-testid={`prop-${propertyId}`} className="min-w-0 space-y-2 text-sm">
      {ids.map((id, i) => (
        <div key={id} className="flex min-w-0 flex-wrap items-center gap-2">
          <FileContent id={id} />
          {!readOnly && (
            <>
              {many &&
                [-1, 1].map((delta) => (
                  <button
                    key={delta}
                    type="button"
                    disabled={locked || i + delta < 0 || i + delta >= ids.length}
                    aria-label={delta < 0 ? 'Переместить вверх' : 'Переместить вниз'}
                    onClick={() => {
                      const value = [...ids];
                      value.splice(i, 1);
                      value.splice(i + delta, 0, id);
                      change({ kind: 'reorder', expected: ids, value });
                    }}
                  >
                    {delta < 0 ? '↑' : '↓'}
                  </button>
                ))}
              <button
                type="button"
                disabled={locked}
                onClick={() =>
                  change(many ? { kind: 'remove', fileId: id } : { kind: 'clear', expected: id })
                }
              >
                Открепить
              </button>
            </>
          )}
        </div>
      ))}
      {!readOnly && (
        <>
          <input
            type="file"
            multiple={many}
            aria-label="Выбрать файл"
            disabled={locked || !!unresolved || !limits.data}
            className="block max-w-full text-sm"
            onChange={(e) => {
              select(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
          <button type="button" disabled={locked} onClick={() => setPaste('')}>
            Вставить ссылку на файл
          </button>
          {paste !== null && (
            <label className="flex flex-wrap items-center gap-2">
              Ссылка на файл
              <input
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                className="min-w-0 rounded border px-2 py-1"
              />
              <button
                type="button"
                disabled={locked || !idFromFileAddress(paste)}
                onClick={() => {
                  const fileId = idFromFileAddress(paste);
                  if (fileId)
                    change(
                      many
                        ? { kind: 'add', fileId }
                        : { kind: 'set', fileId, expected: ids[0] ?? null },
                    );
                }}
              >
                Прикрепить
              </button>
            </label>
          )}
          {group
            .filter((item) => !item.done)
            .map((item) => (
              <div key={item.uploadId} className="break-words" role="status">
                {item.file.name} · {item.error || `${item.offset} / ${item.file.size} байт`}
                {!item.started && unresolved && ' · ожидает подтверждения предыдущей привязки'}
                {item.error && (
                  <button
                    type="button"
                    className="ml-2"
                    disabled={locked || (!!unresolved && unresolved !== item)}
                    onClick={() =>
                      void act((signal) =>
                        transfer(
                          [item, ...group.filter((next) => !next.started && next !== item)],
                          group,
                          signal,
                        ),
                      )
                    }
                  >
                    Повторить
                  </button>
                )}
              </div>
            ))}
          {!online && <p role="status">Для прикрепления файла нужно подключение к сети.</p>}
          {limits.isError && <p role="alert">{limits.error.message}</p>}
        </>
      )}
      {message && (
        <p role="alert">
          {message}{' '}
          {pendingEdit.current && (
            <button
              type="button"
              disabled={locked}
              onClick={() => {
                const input = pendingEdit.current!;
                void act(async (signal) => {
                  await commit(input, signal);
                  pendingEdit.current = null;
                  setPaste(null);
                });
              }}
            >
              Повторить действие
            </button>
          )}
        </p>
      )}
    </div>
  );
}
