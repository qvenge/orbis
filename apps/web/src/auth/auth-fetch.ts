// These codes explicitly reject the refresh credential, session or account.
// A gateway status alone does not establish any of those conditions.
const REFRESH_REFUSALS = new Set([
  'session_not_found',
  'session_expired',
  'refresh_token_not_found',
  'refresh_token_already_used',
  'user_not_found',
  'user_banned',
  'invalid_grant',
]);

export function isRefreshRefusalCode(code: unknown): code is string {
  return typeof code === 'string' && REFRESH_REFUSALS.has(code);
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null) return value as Record<string, unknown>;
}

function discard(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

/**
 * auth-js 2.110.0 removes an expired session on non-retryable errors,
 * including unrecognized HTTP statuses and invalid refresh payloads.
 * Present uncertain refresh responses as a retryable 503 before that decision.
 */
export function authFetch(authUrl: string): typeof fetch {
  const endpoint = new URL(`${authUrl}/token`);
  return async (input, init) => {
    const response = await fetch(input, init);
    const request = input instanceof Request ? input : undefined;
    const method = init?.method ?? request?.method;
    if (method?.toUpperCase() !== 'POST') return response;
    const url = new URL(request?.url ?? String(input), endpoint);
    if (
      url.origin !== endpoint.origin ||
      url.pathname !== endpoint.pathname ||
      url.searchParams.get('grant_type') !== 'refresh_token'
    ) {
      return response;
    }

    if (response.status === 503) return response;
    const temporaryStatus =
      response.status === 408 || response.status === 425 || response.status === 429;
    const candidateRefusal = response.status >= 400 && response.status < 500 && !temporaryStatus;
    if (response.ok || candidateRefusal) {
      const body = record(
        await response
          .clone()
          .json()
          .catch(() => undefined),
      );
      if (
        response.ok &&
        typeof body?.access_token === 'string' &&
        body.access_token &&
        typeof body.refresh_token === 'string' &&
        body.refresh_token &&
        typeof body.expires_in === 'number' &&
        Number.isFinite(body.expires_in) &&
        body.expires_in > 0 &&
        typeof record(body.user)?.id === 'string'
      ) {
        return response;
      }
      // Match auth-js's versioned error fields before considering the legacy
      // OAuth "error" field. An HTTP status stored in "code" is not an auth code.
      const apiVersion = response.headers.get('X-Supabase-Api-Version') ?? '';
      const modern =
        /^2[0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/.test(apiVersion) &&
        apiVersion >= '2024-01-01';
      const code =
        modern && typeof body?.code === 'string'
          ? body.code
          : typeof body?.error_code === 'string'
            ? body.error_code
            : body?.error;
      if (candidateRefusal && isRefreshRefusalCode(code)) {
        discard(response);
        // The pinned SDK reads error_code for legacy responses. Some servers
        // return the OAuth refusal under "error" instead.
        return Response.json({ ...body, error_code: code }, { status: response.status });
      }
    }

    discard(response);
    return new Response(null, { status: 503 });
  };
}
