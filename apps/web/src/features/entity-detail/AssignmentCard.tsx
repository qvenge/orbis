// Назначение исполнителя (С2, С8): кому поручена задача — человеку или агенту, каким доступом
// он ходит и волен ли закрыть тикет сам. Собственный контрол, а не строки в общей форме
// свойств: у трёх свойств есть ОБЩИЙ ИНВАРИАНТ (executor=agent ⇔ живой грант,
// invariants.ts:295-326), а форма правит их по одному — переключение исполнителя без гранта
// отдавало бы VALIDATION на каждом втором нажатии.
import { useId, useRef, useState } from 'react';
import { type RouterOutputs, trpc } from '../../trpc';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { useEntityUpdate } from './useEntityDetail';

type Entity = RouterOutputs['entity']['get']['entity'];

const ASSIGNMENT = 'orbis/assignment';
/** Адреса значений — id СВОЙСТВ (§А1-1); `orbis/grant` слит с полем прогона (В1). */
const EXECUTOR = 'orbis/executor';
const GRANT = 'orbis/grant';
const MAY_CLOSE = 'orbis/may_close';
const ASSIGNEE = 'orbis/assignee';

/**
 * Подпись области доступа (§4.14) — та же конвенция, что в «Агентах» настроек
 * (features/settings/ConnectedAgents.tsx:25-27): сравнение с 'worker', а не со списком, потому
 * что подпись не гейт, и незнакомое значение честнее показать полным доступом, чем сужением,
 * которого сервер не подтверждал. Копия в две строки, а не общий импорт: тащить сюда модуль
 * экрана настроек ради подписи значило бы связать ленивый чанк detail с входным.
 */
function scopeLabel(scope: string): string {
  return scope === 'worker' ? 'исполнитель' : 'полный доступ';
}

type Executor = 'human' | 'agent';
interface Draft {
  executor: Executor;
  grantId: string;
  mayClose: boolean;
}

function draftOf(entity: Entity): Draft {
  const props = entity.props;
  return {
    executor: props[EXECUTOR] === 'agent' ? 'agent' : 'human',
    // Проверка на строку, а не на «не пусто»: значением свойства бывает и `null`, и число —
    // сюда доезжает то, что лежит в графе.
    grantId: typeof props[GRANT] === 'string' ? props[GRANT] : '',
    // Отсутствие свойства = false (С8): валидатор default'ов не материализует (РП-9), и
    // «не знаем» тут значит «нет».
    mayClose: props[MAY_CLOSE] === true,
  };
}

export function AssignmentCard({ entity }: { entity: Entity }) {
  const { mutation } = useEntityUpdate(entity.id);
  const [draft, setDraft] = useState(() => draftOf(entity));
  // Экран монтируется БЕЗ key (router.tsx), и переход запись→запись меняет только проп: без
  // сброса черновик соседней задачи предлагал бы сохранить чужого исполнителя.
  const prevIdRef = useRef(entity.id);
  if (prevIdRef.current !== entity.id) {
    prevIdRef.current = entity.id;
    setDraft(draftOf(entity));
  }
  const executorName = useId();
  const grantSelectId = useId();
  // Список доступов спрашиваем ТОЛЬКО когда он нужен: карточка висит на каждой задаче, а
  // владельцу, назначающему человека, список агентов не нужен вовсе (тот же приём, что у
  // пикера категорий — AspectCards.tsx:150-154).
  const grants = trpc.oauth.listGrants.useQuery(undefined, { enabled: draft.executor === 'agent' });
  // Отозванный доступ выбирать нельзя: сервер откажет NOT_FOUND (invariants.ts:304-318).
  const live = (grants.data ?? []).filter((g) => g.revokedAt === null);

  // «Назначение есть» — факт СПИСКА аспектов (§А1-1), а не «в карте есть ключ»: назначение
  // без единого заполненного свойства (сервер их не требует) прежде было неотличимо от
  // снятого, и карточка показывала «Не назначен» на записи, которую агент считает своей.
  const assigned = entity.aspects.includes(ASSIGNMENT);
  const props = entity.props;
  const savedGrantId = typeof props[GRANT] === 'string' ? props[GRANT] : undefined;
  const savedGrant = live.find((g) => g.id === savedGrantId);
  /**
   * Грант отозвали ПОСЛЕ того, как назначение сохранили. В списке живых его больше нет, и
   * контролируемый `<select>` не находит своего option — визуально он показывает первый
   * пункт-плейсхолдер «— выберите доступ —», хотя черновик держит отозванный id. Молчать об
   * этом нельзя дважды: назначение выглядит целым (а агент по нему ходить уже не может), и
   * «Сохранить» бодро отправляла бы тот же мёртвый id, получая NOT_FOUND без объяснения.
   *
   * Условие через `grants.data !== undefined`, а не через пустой `live`: пока список едет,
   * живых грантов не видно вовсе — и «отозван» было бы враньём на каждом открытии.
   */
  const grantsLoaded = grants.data !== undefined;
  const savedGrantRevoked = grantsLoaded && savedGrantId !== undefined && savedGrant === undefined;
  const draftGrantRevoked =
    grantsLoaded && draft.grantId !== '' && !live.some((g) => g.id === draft.grantId);

  function save() {
    /**
     * СНЯТИЕ гранта при переключении на человека ОБЯЗАТЕЛЬНО, и это не уборка мусора.
     * Пара (executor=human, grant) — рассогласование, а не лишнее поле: сервер отвечает на
     * неё VALIDATION (invariants.ts:319-325), потому что тикет читался бы как назначенный
     * агенту одним кодом и человеку другим. Патч мержится по ключам, и без явного снятия
     * прежний грант пережил бы переключение.
     * `orbis/may_close` там же и по той же причине: «может закрывать сам» — про глагол
     * исполнителя (С8), у назначенного человека смысла оно не имеет.
     *
     * Снятие уезжает СПИСКОМ `unset` (§А1-1), а не `null` в значении: `null` — законное
     * значение json-свойства, и совмещать «снять» и «записать null» одним ключом больше
     * нечем.
     */
    const agent = draft.executor === 'agent';
    mutation.mutate({
      id: entity.id,
      // Метку версии шлём для единообразия с прочими правками экрана; 409 она здесь не даёт
      // никогда — гейт §5.2 стоит под условием `body || bodyDoc` (см. checksVersion), и правку
      // одних свойств сервер проводит по LWW. Обещать защиту от гонки в UI нечем.
      expectedUpdatedAt: entity.updatedAt,
      props: agent
        ? { [EXECUTOR]: 'agent', [GRANT]: draft.grantId, [MAY_CLOSE]: draft.mayClose }
        : { [EXECUTOR]: 'human' },
      ...(agent ? {} : { unset: [GRANT, MAY_CLOSE] }),
    });
  }

  return (
    <div data-testid="assignment-card" className="flex flex-col gap-2">
      <p className="text-2xs font-medium uppercase tracking-wide text-text-muted">Назначение</p>
      {!assigned ? (
        <p className="text-sm text-text-muted">Не назначен</p>
      ) : props[EXECUTOR] === 'agent' ? (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          Агент
          {/* break-words: подпись гранта пишет тот, кто регистрировался (сервер режет её до 64
              код-поинтов, но не до узкой). */}
          <span className="break-words">
            {savedGrant?.label ?? (grants.isLoading ? '…' : (savedGrantId ?? '—'))}
          </span>
          {savedGrant !== undefined && <Badge>{scopeLabel(savedGrant.scope)}</Badge>}
          {savedGrantRevoked && <Badge tone="danger">грант отозван</Badge>}
          {/* Согласие дано, а токены агент не забрал: ходить он не может, и назначение на него
              будет ждать вечно — молчать об этом нельзя (та же ветка в ConnectedAgents). */}
          {savedGrant?.connected === false && <Badge tone="danger">не подключён</Badge>}
        </p>
      ) : (
        <p className="text-sm">
          Человек
          {typeof props[ASSIGNEE] === 'string' ? ` · ${props[ASSIGNEE]}` : ''}
        </p>
      )}

      <fieldset className="flex flex-wrap items-center gap-4 text-sm">
        <legend className="sr-only">Исполнитель</legend>
        {(['human', 'agent'] as const).map((value) => (
          <label key={value} className="flex cursor-pointer items-center gap-2">
            <input
              type="radio"
              name={executorName}
              className="size-4 accent-accent"
              checked={draft.executor === value}
              onChange={() => setDraft((d) => ({ ...d, executor: value }))}
            />
            {value === 'human' ? 'Человек' : 'Агент'}
          </label>
        ))}
      </fieldset>

      {draft.executor === 'agent' && (
        <div className="flex flex-col gap-2">
          <label htmlFor={grantSelectId} className="text-sm text-text-secondary">
            Доступ агента
          </label>
          <select
            id={grantSelectId}
            value={draft.grantId}
            onChange={(e) => setDraft((d) => ({ ...d, grantId: e.target.value }))}
            className="rounded-control border border-line bg-surface px-3 py-2 text-sm"
          >
            <option value="">— выберите доступ —</option>
            {live.map((g) => (
              <option key={g.id} value={g.id}>
                {`${g.label} · ${scopeLabel(g.scope)}${g.connected ? '' : ' · не подключён'}`}
              </option>
            ))}
          </select>
          {draftGrantRevoked && (
            <p className="text-danger text-sm">
              Этот доступ отозван — выберите живой из списка, иначе сервер откажет.
            </p>
          )}
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-accent"
              checked={draft.mayClose}
              onChange={(e) => setDraft((d) => ({ ...d, mayClose: e.target.checked }))}
            />
            Может закрывать сам
          </label>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          // Агент без гранта — гарантированный VALIDATION сервера, с отозванным — NOT_FOUND:
          // не отправляем вовсе ни то, ни другое.
          disabled={
            mutation.isPending ||
            (draft.executor === 'agent' && (draft.grantId === '' || draftGrantRevoked))
          }
          onClick={save}
        >
          Сохранить
        </Button>
        {assigned && (
          <Button
            size="sm"
            variant="ghost"
            disabled={mutation.isPending}
            onClick={() =>
              mutation.mutate({
                id: entity.id,
                expectedUpdatedAt: entity.updatedAt,
                // `detach` снимает АСПЕКТ (§А1-1) — задача остаётся задачей, но ничьей.
                // Значений снятие не трогает (Р9): исполнитель, которого сняли, остаётся
                // фактом владельца и виден в секции «Свойства».
                aspects: { detach: [ASSIGNMENT] },
              })
            }
          >
            Снять назначение
          </Button>
        )}
      </div>
      {/* Отказ сервера показываем текстом: он здесь содержательный — отозванный между открытием
          экрана и нажатием грант отвечает «не найден или отозван», и без этой строки владелец
          видел бы нажатую кнопку и прежнее назначение, не понимая, сохранилось ли что-нибудь. */}
      {mutation.isError && (
        <p role="alert" className="text-danger text-sm">
          {mutation.error.message}
        </p>
      )}
    </div>
  );
}
