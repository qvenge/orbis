// apps/server/src/oauth/errors.ts
// Ошибки OAuth-поверхности: коды — из OAuth 2.1 (invalid_grant, invalid_request,
// invalid_client, invalid_target, unsupported_grant_type), форма ответа —
// { error, error_description } по спеке. Структурная форма { error: { code } },
// которой отвечают /mcp и tRPC, здесь НЕ применяется: это другой протокол,
// и клиент разбирает именно спецификационные поля.
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(`${code}: ${description}`);
    this.name = 'OAuthError';
  }

  toResponseBody(): { error: string; error_description: string } {
    return { error: this.code, error_description: this.description };
  }
}
