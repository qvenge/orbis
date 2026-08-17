// Экран согласия OAuth (§9.3) — единственная страница потока, которую видит владелец.
// Живёт в SPA, а не отдаётся сервером, потому что сессия Supabase лежит в localStorage
// веб-клиента (auth/config.ts): серверному HTML она не видна. Монтируется внутри
// AuthProvider — незалогиненного он сам уводит на вход, и второго способа логина
// заводить не приходится.
import type { GrantScope } from '@orbis/shared';
import { type ReactNode, useId, useMemo, useState } from 'react';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Skeleton } from '../../ui/Skeleton';
import {
  type AuthorizeRequest,
  denialUrl,
  parseAuthorizeRequest,
  redirectHost,
} from './authorize-request';

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
    return <ErrorNotice>Запрос неполон — вернитесь в агента и повторите подключение.</ErrorNotice>;
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
  // Область живёт в состоянии экрана, а не в адресе запроса: её выбирает ВЛАДЕЛЕЦ, и
  // приди она параметром от агента — агент сам решал бы, сколько ему выдать.
  const [scope, setScope] = useState<GrantScope>('full');
  // Занятость общая на обе кнопки, и `isSuccess` в ней не лишний: браузер после успеха
  // только начинает уходить, а «Отклонить» в это окно отправило бы access_denied по уже
  // ВЫДАННОМУ коду — владелец увидел бы в «Агентах» агента, которого считает отклонённым.
  // Тот же приём, что на карточке подтверждения (ConfirmationCard.tsx:41).
  const busy = consent.isPending || consent.isSuccess;

  // Причина отказа — от сервера («клиент не зарегистрирован», «redirect_uri не
  // зарегистрирован этим клиентом»): без неё владелец видел бы пустой экран и не знал,
  // что чинить в агенте.
  if (describe.isError) return <ErrorNotice>{describe.error.message}</ErrorNotice>;
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

      <ScopeChoice value={scope} onChange={setScope} disabled={busy} />

      {/* Адрес возврата — единственный признак, который подделать нельзя. Именем клиента
          не проверяется ничего: /oauth/register публичен, `client_name` сервер только режет
          до 64 символов, и назваться «Claude Code» может кто угодно — вместе со своим
          redirect_uri. Код уйдёт ровно по этому адресу, поэтому владельцу показываются оба:
          хост отдельной строкой (из разобранного адреса — значит в punycode, омограф виден
          как xn--…) и адрес целиком той строкой, что зарегистрировал клиент.
          break-all, а не break-words: в длинном URL нет пробелов, и по словам он не переносится. */}
      <div className="flex flex-col gap-1 rounded-control border border-line bg-surface-2 p-3">
        <span className="text-text-secondary text-xs">Код доступа уйдёт на этот адрес:</span>
        <span className="break-all font-medium font-mono text-sm">{redirectHost(request)}</span>
        <span className="break-all font-mono text-text-muted text-xs">{request.redirectUri}</span>
      </div>

      <div className="flex gap-2">
        <Button
          disabled={busy}
          onClick={() =>
            consent.mutate({
              clientId: request.clientId,
              redirectUri: request.redirectUri,
              codeChallenge: request.codeChallenge,
              codeChallengeMethod: 'S256',
              state: request.state,
              resource: request.resource,
              scope,
            })
          }
        >
          Разрешить
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => navigate(denialUrl(request))}>
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

/**
 * Варианты области (§4.14). Подпись «worker» оставлена в скобках намеренно: этим словом
 * область называется и в ответе /oauth/token, и в конфигурации агента, и владельцу, который
 * будет сверять одно с другим, термин нужен целиком. Пояснение под каждым вариантом —
 * потому что решение принимается один раз, до первого действия агента, и переспросить
 * экран уже не даст.
 */
const SCOPE_OPTIONS: ReadonlyArray<{ value: GrantScope; title: string; hint: string }> = [
  {
    value: 'full',
    title: 'Полный доступ',
    hint: 'Агент читает и изменяет весь ваш граф — как вы сами.',
  },
  {
    value: 'worker',
    title: 'Только исполнитель (worker)',
    hint: 'Исполнитель видит граф и пишет только через глаголы задач; закрыть тикет сам не может.',
  },
];

/**
 * Выбор области. Радио, а не выпадающий список: вариантов два, и оба обязаны быть видны
 * ЦЕЛИКОМ — вместе с тем, что каждый означает. Умолчание — полный доступ: сужение по
 * умолчанию сломало бы подключение обычного агента молча, а владелец узнал бы об этом
 * по непонятному отказу в чужой программе.
 *
 * Пояснение вынесено из <label> в отдельную строку с aria-describedby: попади оно внутрь
 * метки, доступным именем радио стал бы весь абзац, и с клавиатуры вариант звучал бы
 * лекцией вместо названия.
 */
function ScopeChoice({
  value,
  onChange,
  disabled,
}: {
  value: GrantScope;
  onChange: (scope: GrantScope) => void;
  disabled: boolean;
}) {
  // name группы — из useId: два экрана согласия на одной странице (в тестах — в одном
  // документе) иначе делили бы одну радио-группу и гасили выбор друг друга.
  const group = useId();
  return (
    <fieldset className="flex flex-col gap-2 rounded-control border border-line p-3">
      <legend className="px-1 text-text-secondary text-xs">Сколько доступа выдать</legend>
      {SCOPE_OPTIONS.map((option) => {
        const id = `${group}-${option.value}`;
        return (
          <div key={option.value} className="flex items-start gap-2">
            <input
              id={id}
              type="radio"
              name={group}
              className="mt-1 accent-accent"
              checked={value === option.value}
              disabled={disabled}
              onChange={() => onChange(option.value)}
              aria-describedby={`${id}-hint`}
            />
            <div className="flex min-w-0 flex-col gap-0.5">
              <label htmlFor={id} className="cursor-pointer text-sm">
                {option.title}
              </label>
              <span id={`${id}-hint`} className="text-text-muted text-xs">
                {option.hint}
              </span>
            </div>
          </div>
        );
      })}
    </fieldset>
  );
}

/**
 * Отказ во весь экран. `role="alert"` и `text-danger` — конвенция проекта для отказов
 * (LoginScreen.tsx:58, OnboardingGate.tsx:41, ChunkErrorBoundary.tsx:72). EmptyState здесь
 * был неверен дважды: приглушённый «пусто»-стиль выдаёт отказ за пустоту, а появляется он
 * ПОДМЕНОЙ Skeleton (role="status") — без роли скринридер про отказ просто замолкает.
 */
function ErrorNotice({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="mx-auto max-w-md p-6 text-sm text-danger">
      {children}
    </p>
  );
}
