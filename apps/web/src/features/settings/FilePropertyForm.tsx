import { effectiveLabel, OWNER_LOCALE, type PropertyDefinition } from '@orbis/shared';
import { FILE_LIST_LIMIT } from '@orbis/shared/files';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { REGISTRY_QUERY_KEY } from '../../lib/registry/useRegistry';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';

export function FilePropertyForm({ definition }: { definition?: PropertyDefinition }) {
  const type = definition?.type.kind === 'file' ? definition.type : undefined;
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [cardinality, setCardinality] = useState<'one' | 'many'>('one');
  const [maximum, setMaximum] = useState(String(FILE_LIST_LIMIT));
  const queryClient = useQueryClient();
  const onSuccess = () => {
    void queryClient.invalidateQueries({ queryKey: REGISTRY_QUERY_KEY });
    setName('');
    setDescription('');
    setCardinality('one');
    setMaximum(String(FILE_LIST_LIMIT));
    setOpen(false);
  };
  const create = trpc.registry.createProperty.useMutation({ onSuccess });
  const update = trpc.registry.updateProperty.useMutation({ onSuccess });
  const mutation = definition ? update : create;
  if (!open)
    return (
      <Button
        variant="outline"
        className="self-start"
        onClick={() => {
          mutation.reset();
          setName(definition ? effectiveLabel(definition.label, OWNER_LOCALE) : '');
          setDescription(definition ? effectiveLabel(definition.description, OWNER_LOCALE) : '');
          setCardinality(type?.cardinality ?? 'one');
          setMaximum(String(type?.maxItems ?? FILE_LIST_LIMIT));
          setOpen(true);
        }}
      >
        {definition
          ? `Изменить поле ${effectiveLabel(definition.label, OWNER_LOCALE)}`
          : 'Новое файловое поле'}
      </Button>
    );
  return (
    <form
      className="flex flex-col gap-3 rounded-control border border-line p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim() || mutation.isPending) return;
        if (definition) {
          update.mutate({
            id: definition.id,
            label: { ...definition.label, ru: name.trim() },
            description: { ...definition.description, ru: description.trim() || name.trim() },
          });
          return;
        }
        create.mutate({
          label: { ru: name.trim() },
          description: { ru: description.trim() || name.trim() },
          status: 'active',
          type: {
            kind: 'file',
            cardinality,
            ...(cardinality === 'many' ? { maxItems: Number(maximum) } : {}),
          },
        });
      }}
    >
      <label htmlFor={fieldId + '-name'} className="flex flex-col gap-1 text-sm">
        Название поля
        <Input
          id={fieldId + '-name'}
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label htmlFor={fieldId + '-description'} className="flex flex-col gap-1 text-sm">
        Описание (необязательно)
        <Input
          id={fieldId + '-description'}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Количество файлов
        <select
          className="rounded-control border border-line bg-surface px-3 py-2"
          disabled={!!definition}
          value={cardinality}
          onChange={(e) => setCardinality(e.target.value === 'many' ? 'many' : 'one')}
        >
          <option value="one">Один файл</option>
          <option value="many">Несколько файлов</option>
        </select>
      </label>
      {cardinality === 'many' && (
        <label htmlFor={fieldId + '-maximum'} className="flex flex-col gap-1 text-sm">
          Максимум файлов
          <Input
            id={fieldId + '-maximum'}
            type="number"
            required
            min={1}
            max={FILE_LIST_LIMIT}
            step={1}
            disabled={!!definition}
            value={maximum}
            onChange={(e) => setMaximum(e.target.value)}
          />
        </label>
      )}
      {mutation.isError && <p role="alert">{mutation.error.message}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={mutation.isPending || !name.trim()}>
          {definition ? 'Сохранить поле' : 'Создать поле'}
        </Button>
        <Button variant="ghost" disabled={mutation.isPending} onClick={() => setOpen(false)}>
          Отмена
        </Button>
      </div>
    </form>
  );
}
