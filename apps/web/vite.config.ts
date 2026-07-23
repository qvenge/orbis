// `defineConfig` is imported from 'vitest/config' (not 'vite') so the `test` key is
// type-checked in this single file; plain vite's defineConfig doesn't type `test`.
import tailwind from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';
import { pwaManifest } from './src/pwa/manifest';

export default defineConfig({
  plugins: [
    react(),
    tailwind(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: pwaManifest,
      workbox: {
        navigateFallback: '/index.html', // app-shell для офлайна
        // png/ico — иконки манифеста: без них установленное PWA стартует офлайн без иконок.
        globPatterns: ['**/*.{js,css,html,svg,woff2,png,ico}'],
      },
    }),
  ],
  // ORBIS_DEV_API — переопределение цели dev-прокси (порт 3001 на дев-машине может быть занят посторонним сервисом)
  server: { port: 5173, proxy: { '/trpc': process.env.ORBIS_DEV_API ?? 'http://localhost:3001' } },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./tests/setup.ts'] },
});
