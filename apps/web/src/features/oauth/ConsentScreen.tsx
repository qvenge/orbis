// Экран согласия OAuth (§9.3) — единственная страница потока, которую видит владелец.
// Живёт в SPA, а не отдаётся сервером, потому что сессия Supabase лежит в localStorage
// веб-клиента (auth/config.ts): серверному HTML она не видна. Монтируется внутри
// AuthProvider — незалогиненного он сам уводит на вход, и второго способа логина
// заводить не приходится.
import { useMemo } from 'react';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { Skeleton } from '../../ui/Skeleton';
import { type AuthorizeRequest, denialUrl, parseAuthorizeRequest } from './authorize-request';

/** Переход браузера — проп: тест подменяет его, не ломая window.location в jsdom. */
export function ConsentScreen({
  search = window.location.search,
  navigate = (url: string) => window.location.assign(url),
}: {
  search?: string;
  navigate?: (url: string) => void;
}) {
  const request = useMemo(() => parseAuthorizeRequest(search), [search]);
  // Компонент разделён надвое намеренно: негодный запрос не должен порождать ни одного
  // обращения к серверу, а useQuery внутри ConsentPrompt попросту не монтируется.
  if (request === null) {
    return <EmptyState title="Запрос неполон — вернитесь в агента и повторите подключение." />;
  }
  return <ConsentPrompt request={request} navigate={navigate} />;
}

function ConsentPrompt({
  request,
  navigate,
}: {
  request: AuthorizeRequest;
  navigate: (url: string) => void;
}) {
  const describe = trpc.oauth.describeRequest.useQuery({
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    resource: request.resource,
  });
  const consent = trpc.oauth.consent.useMutation({
    onSuccess: (r) => navigate(r.redirectTo),
  });

  // Причина отказа — от сервера («клиент не зарегистрирован», «redirect_uri не
  // зарегистрирован этим клиентом»): без неё владелец видел бы пустой экран и не знал,
  // что чинить в агенте.
  if (describe.isError) return <EmptyState title={describe.error.message} />;
  if (!describe.data) return <Skeleton className="mx-auto mt-10 h-24 w-full max-w-md" />;

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 p-6">
      {/* break-words, а не truncate (как в строках списков): подпись клиента полностью
          подконтрольна тому, кто регистрируется, и владелец судит агента ровно по ней —
          прятать её хвост нельзя. Длину сервер уже ограничил 64 код-поинтами, но 64
          символа без единого пробела всё равно вылезли бы за max-w-md. */}
      <h1 className="break-words font-medium text-lg">
        {describe.data.clientName} просит доступ к Orbis
      </h1>
      <p className="text-sm text-text-secondary">
        Агент сможет читать и изменять ваши сущности от вашего имени. Действия попадут в журнал,
        опасные — потребуют подтверждения в чате. Доступ отзывается в разделе «Настройки → Агенты».
      </p>
      <div className="flex gap-2">
        <Button
          disabled={consent.isPending}
          onClick={() =>
            consent.mutate({
              clientId: request.clientId,
              redirectUri: request.redirectUri,
              codeChallenge: request.codeChallenge,
              codeChallengeMethod: 'S256',
              state: request.state,
              resource: request.resource,
            })
          }
        >
          Разрешить
        </Button>
        <Button variant="ghost" onClick={() => navigate(denialUrl(request))}>
          Отклонить
        </Button>
      </div>
      {/* Провал выдачи кода без этой строки был бы молча мёртвой кнопкой: владелец жмёт
          «Разрешить», перехода нет, и причины не видно ни ему, ни агенту. */}
      {consent.isError && (
        <p role="alert" className="text-sm text-danger">
          {consent.error.message}
        </p>
      )}
    </div>
  );
}
