/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BUILD_ID: string;
  readonly VITE_RESPONSE_PERSISTENCE?: string;
  /**
   * Опц. абсолютный base-URL API (режим B — раздельные origins фронта и бэка).
   * Не задан/пусто → относительный `/trpc` (режим A, same-origin, дефолт). См. trpc.ts.
   */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
