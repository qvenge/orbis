import type { QueryKey } from '@tanstack/react-query';

type Fields = Record<string, unknown>;

/** Explicit UI inputs. Body, CAS and derived server fields have their own writers. */
export type EntityPatch = {
  id: string;
  title?: string;
  emoji?: string | null;
  archived?: boolean;
  tags?: readonly string[];
  props?: Readonly<Fields>;
  unset?: readonly string[];
  aspects?: { attach?: readonly string[]; detach?: readonly string[] };
};

export type FieldChange =
  | { kind: 'title'; value: string }
  | { kind: 'emoji'; value: string | null }
  | { kind: 'archived'; value: boolean }
  | { kind: 'tags'; value: readonly string[] }
  | { kind: 'prop'; id: string; value: unknown; unset: boolean }
  | { kind: 'aspect'; id: string; attach: boolean };

export function fieldKey(change: FieldChange): string {
  return change.kind === 'prop' || change.kind === 'aspect'
    ? `${change.kind}:${change.id}`
    : change.kind;
}

export function entityPatchFields(patch: EntityPatch): FieldChange[] {
  const changes: FieldChange[] = [];
  if (patch.title !== undefined) changes.push({ kind: 'title', value: patch.title });
  if (patch.emoji !== undefined) changes.push({ kind: 'emoji', value: patch.emoji });
  if (patch.archived !== undefined) changes.push({ kind: 'archived', value: patch.archived });
  if (patch.tags !== undefined) changes.push({ kind: 'tags', value: [...patch.tags] });
  for (const [id, value] of Object.entries(patch.props ?? {}))
    changes.push({ kind: 'prop', id, value: structuredClone(value), unset: false });
  // Match executor precedence within one operation. Detach leaves the props intact.
  for (const id of patch.unset ?? [])
    changes.push({ kind: 'prop', id, value: undefined, unset: true });
  for (const id of patch.aspects?.detach ?? []) changes.push({ kind: 'aspect', id, attach: false });
  for (const id of patch.aspects?.attach ?? []) changes.push({ kind: 'aspect', id, attach: true });
  return changes;
}

function record(value: unknown): Fields | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Fields;
}

function sameItems(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((item, i) => Object.is(item, b[i]));
}

function put(record: Fields, key: string, value: unknown): Fields {
  return Object.is(record[key], value) ? record : { ...record, [key]: value };
}

function patchProps(props: Fields, changes: readonly FieldChange[]): Fields {
  let next = props;
  for (const change of changes) {
    if (change.kind !== 'prop') continue;
    const present = Object.hasOwn(next, change.id);
    if (change.unset ? !present : present && Object.is(next[change.id], change.value)) continue;
    if (next === props) next = { ...props };
    if (change.unset) delete next[change.id];
    else
      Object.defineProperty(next, change.id, {
        value: change.value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
  }
  return next;
}

function patchAspects(aspects: string[], changes: readonly FieldChange[]): string[] {
  let next = aspects;
  for (const change of changes) {
    if (change.kind !== 'aspect') continue;
    const attached = next.includes(change.id);
    if (change.attach && !attached) next = [...next, change.id];
    if (!change.attach && attached) next = next.filter((id) => id !== change.id);
  }
  return next;
}

function patchRow(row: Fields, changes: readonly FieldChange[]): Fields {
  let next = row;
  for (const change of changes) {
    if (change.kind === 'prop' || change.kind === 'aspect' || !Object.hasOwn(row, change.kind))
      continue;
    const previous = row[change.kind];
    if (change.kind === 'tags' && Array.isArray(previous) && sameItems(previous, change.value))
      continue;
    next = put(next, change.kind, change.value);
  }
  const props = record(row.props);
  if (props) next = put(next, 'props', patchProps(props, changes));
  if (Array.isArray(row.aspects)) next = put(next, 'aspects', patchAspects(row.aspects, changes));
  return next;
}

function mapArray(value: unknown, map: (item: unknown) => unknown): unknown {
  if (!Array.isArray(value)) return value;
  let next: unknown[] | undefined;
  for (let i = 0; i < value.length; i++) {
    const mapped = map(value[i]);
    if (Object.is(mapped, value[i])) continue;
    next ??= value.slice();
    next[i] = mapped;
  }
  return next ?? value;
}

function mapField(value: unknown, name: string, map: (item: unknown) => unknown): unknown {
  const wrapper = record(value);
  return wrapper && Object.hasOwn(wrapper, name) ? put(wrapper, name, map(wrapper[name])) : value;
}

function entityResponseFamily(key: QueryKey): string | undefined {
  const [prefix] = key;
  return Array.isArray(prefix) ? prefix.join('.') : typeof prefix === 'string' ? prefix : undefined;
}

function refField(change: FieldChange): boolean {
  return change.kind === 'title' || change.kind === 'emoji' || change.kind === 'archived';
}

export function rowContainsField(row: Fields, change: FieldChange): boolean {
  const key = change.kind === 'prop' ? 'props' : change.kind === 'aspect' ? 'aspects' : change.kind;
  return Object.hasOwn(row, key);
}

export function isEntityResponseKey(key: QueryKey): boolean {
  const family = entityResponseFamily(key);
  return (
    family === 'entity.get' ||
    family === 'entity.query' ||
    family === 'entity.resolveRefs' ||
    (family === 'query-block' && key[1] !== 'badge')
  );
}

export function canContainEntity(
  key: QueryKey,
  id: string,
  changes?: ReadonlyMap<string, FieldChange>,
): boolean {
  const input = record(record(key[1])?.input);
  switch (entityResponseFamily(key)) {
    case 'entity.get':
      return (
        input?.id === id || (Array.isArray(input?.include) && input.include.includes('backlinks'))
      );
    case 'entity.resolveRefs':
      return (
        Array.isArray(input?.ids) &&
        input.ids.includes(id) &&
        (!changes || [...changes.values()].some(refField))
      );
    case 'entity.query':
      return true;
    case 'query-block':
      return key[1] !== 'badge';
    default:
      return false;
  }
}

/** One traversal describes both projection and indexing of the actual raw record references. */
function mapEntities(
  key: QueryKey,
  raw: unknown,
  project: (id: string, row: Fields) => Fields,
): unknown {
  const row = (value: unknown) => {
    const fields = record(value);
    return typeof fields?.id === 'string' ? project(fields.id, fields) : value;
  };
  const rows = (value: unknown) => mapArray(value, row);
  const wrappedRow = (value: unknown) => mapField(value, 'entity', row);
  switch (entityResponseFamily(key)) {
    case 'entity.get':
      return mapField(wrappedRow(raw), 'backlinks', (backlinks) => mapArray(backlinks, wrappedRow));
    case 'entity.query':
      return mapField(raw, 'rows', rows);
    case 'entity.resolveRefs':
      return rows(raw);
    case 'query-block': {
      const block = record(raw);
      if (block?.ok !== true) return raw;
      if (block.kind === 'rows') return mapField(block, 'rows', rows);
      if (block.kind === 'groups')
        return mapField(block, 'groups', (groups) =>
          mapArray(groups, (group) =>
            mapField(group, 'rows', (items) => mapArray(items, wrappedRow)),
          ),
        );
      return raw;
    }
    default:
      return raw;
  }
}

export function responseEntityRows(key: QueryKey, raw: unknown): ReadonlyMap<string, Fields> {
  const rows = new Map<string, Fields>();
  mapEntities(key, raw, (id, row) => {
    if (!rows.has(id)) rows.set(id, row);
    return row;
  });
  return rows;
}

export function projectEntityResponse(
  key: QueryKey,
  raw: unknown,
  changesFor: (id: string) => readonly FieldChange[],
): unknown {
  return mapEntities(key, raw, (id, row) => {
    const changes = changesFor(id);
    return changes.length ? patchRow(row, changes) : row;
  });
}

export type EntityCardFields = {
  entityId: string;
  title: string;
  aspects: string[];
  keyFields: Fields;
};

export function liveCardFields<T extends EntityCardFields>(
  card: T,
  source: { title?: unknown; aspects?: unknown; props?: unknown },
  changes: readonly FieldChange[],
): T {
  const titleChange = changes.find((change) => change.kind === 'title');
  const title =
    titleChange?.value ?? (typeof source.title === 'string' ? source.title : card.title);
  const aspects = Array.isArray(source.aspects)
    ? source.aspects.filter((aspect): aspect is string => typeof aspect === 'string')
    : card.aspects;
  const nextAspects = patchAspects(aspects, changes);
  const liveProps = record(source.props);
  const patched = patchProps(liveProps ?? card.keyFields, changes);
  const keyFields = Object.fromEntries(
    Object.keys(card.keyFields).flatMap((key) =>
      Object.hasOwn(patched, key) ? [[key, patched[key]]] : [],
    ),
  );
  const sameKeyFields =
    Object.keys(card.keyFields).length === Object.keys(keyFields).length &&
    Object.keys(keyFields).every((key) => Object.is(keyFields[key], card.keyFields[key]));
  if (title === card.title && sameItems(nextAspects, card.aspects) && sameKeyFields) return card;
  return {
    ...card,
    title,
    aspects: sameItems(nextAspects, card.aspects) ? card.aspects : nextAspects,
    keyFields: sameKeyFields ? card.keyFields : keyFields,
  };
}
