/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Опц. абсолютный base-URL API (режим B — раздельные origins фронта и бэка).
   * Не задан/пусто → относительный `/trpc` (режим A, same-origin, дефолт). См. trpc.ts.
   */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
