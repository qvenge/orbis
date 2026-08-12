// Раздел «Агенты» в настройках (§9.3): кому выдан доступ к данным владельца, когда им
// пользовались в последний раз и кнопка отзыва. Экран — обратная сторона браузерного
// входа: без него выданный агенту доступ не отозвать ничем, кроме SQL.
import { formatDate } from '../../lib/format';
import { MCP_URL, type RouterOutputs, trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Skeleton } from '../../ui/Skeleton';

type Grant = RouterOutputs['oauth']['listGrants'][number];

/** kind — колонка базы ('oauth' | 'pat'); владельцу показываем, чем этот доступ является. */
function kindLabel(kind: string): string {
  return kind === 'pat' ? 'токен для CI' : 'браузерный вход';
}

/**
 * Подпись строки. Ключевое различие — `connected`: строка гранта создаётся в момент
 * согласия владельца, ДО обмена кода на токены, и агент, который до обмена не дошёл
 * (упал, окно закрыли), оставляет её в базе навсегда. Такую строку нельзя подписывать
 * «подключён»: доступа у агента нет, а выглядела бы она как подключённый агент.
 */
function metaLine(g: Grant, tz: string | undefined): string {
  if (!g.connected) return `${kindLabel(g.kind)} · согласие дано ${formatDate(g.createdAt, tz)}`;
  const parts = [kindLabel(g.kind), `подключён ${formatDate(g.createdAt, tz)}`];
  if (g.lastUsedAt !== null) parts.push(`последний вызов ${formatDate(g.lastUsedAt, tz)}`);
  return parts.join(' · ');
}

export function ConnectedAgents() {
  const utils = trpc.useUtils();
  // Зона владельца, а не браузера: настройки уже в кеше — SettingsScreen монтирует вкладки
  // только после их загрузки, — поэтому второго ожидания здесь не появляется.
  const tz = trpc.user.getSettings.useQuery().data?.timezone;
  const grants = trpc.oauth.listGrants.useQuery();
  const revoke = trpc.oauth.revokeGrant.useMutation({
    onSuccess: () => utils.oauth.listGrants.invalidate(),
  });

  // Отказ списка — отдельная ветка: без неё `!data` держал бы вечный скелетон, выдавая
  // недоступный список за загрузку. Роль и цвет — конвенция отказов (LoginScreen.tsx:58).
  if (grants.isError) return <Notice>{grants.error.message}</Notice>;
  if (!grants.data) return <Skeleton className="m-3 h-20" />;

  if (grants.data.length === 0) {
    return (
      <div className="flex flex-col items-start gap-2 p-3 text-sm text-text-secondary">
        <p>Ни одного доступа не выдано. Чтобы подключить агента, выполните:</p>
        {/* break-all: в адресе стенда нет пробелов, по словам он не переносится. */}
        <code className="break-all rounded-control bg-surface-2 p-2 font-mono text-xs">
          claude mcp add --transport http orbis {MCP_URL}
        </code>
        <p>Дальше выполните в агенте команду /mcp — вход откроется в браузере.</p>
      </div>
    );
  }

  // Отказ мутации показываем один раз на список: кнопка нажимается по одной, и второго
  // отказа одновременно быть не может. revoked:false — грант не найден: сервер отвечает
  // им и на чужой, и на исчезнувший грант, и молчать о нём нельзя — владелец видел бы
  // нажатую кнопку и живую строку, не понимая, отозван доступ или нет.
  const failure = revoke.isError
    ? revoke.error.message
    : revoke.data?.revoked === false
      ? 'Доступ не найден — возможно, он уже отозван.'
      : null;

  return (
    <div className="flex flex-col gap-2 p-3">
      <ul className="flex flex-col gap-2">
        {grants.data.map((g) => (
          <li
            key={g.id}
            className="flex items-center justify-between gap-3 rounded-control border border-line p-3"
          >
            <div className="flex min-w-0 flex-col gap-0.5">
              {/* break-words: метка — подпись клиента, полностью подконтрольная тому, кто
                  регистрировался (сервер режет её до 64 код-поинтов, но не до узкой). */}
              <span className="break-words text-sm">{g.label}</span>
              <span className="text-text-secondary text-xs">{metaLine(g, tz)}</span>
              {!g.connected && g.revokedAt === null && (
                <span className="text-text-muted text-xs">
                  Агент не забрал доступ — повторите подключение в агенте.
                </span>
              )}
            </div>
            {g.revokedAt === null ? (
              // Кнопка есть и у незавершённого входа: пока код не обменян, отзыв — тот
              // самый рычаг, которым владелец гасит выданный по ошибке доступ, и сервер
              // его чтит (exchangeAuthorizationCode отказывает отозванному гранту).
              <Button
                variant="ghost"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate({ grantId: g.id })}
              >
                Отозвать
              </Button>
            ) : (
              <span className="shrink-0 text-text-secondary text-xs">
                отозван {formatDate(g.revokedAt, tz)}
              </span>
            )}
          </li>
        ))}
      </ul>
      {failure !== null && <Notice>{failure}</Notice>}
    </div>
  );
}

function Notice({ children }: { children: string }) {
  return (
    <p role="alert" className="p-3 text-danger text-sm">
      {children}
    </p>
  );
}
