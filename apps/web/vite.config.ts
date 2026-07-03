// `defineConfig` is imported from 'vitest/config' (not 'vite') so the `test` key is
// type-checked in this single file; plain vite's defineConfig doesn't type `test`.
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: { name: 'Orbis', short_name: 'Orbis', display: 'standalone' },
    }),
  ],
  server: { port: 5173, proxy: { '/trpc': 'http://localhost:3001' } },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./tests/setup.ts'] },
});
