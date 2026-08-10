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
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    // Дефолт (≈ ядра − 1, тут 11 форков jsdom на 12 ядрах и 16 ГБ) переподписывает машину:
    // то же самое время тестов раздувается втрое от одной только борьбы воркеров между
    // собой — суммарное `tests` 205 с при дефолте против 65 с на четырёх воркерах, а весь
    // сьют идёт 64–70 с против 51 с. Ограничение не размен «медленнее, зато стабильнее»:
    // на спокойной машине оно И быстрее, И стабильнее.
    // Замер под внешней нагрузкой (6 счётных петель), длительность самого тяжёлого теста
    // при бюджете 30 с: дефолт — 29.6 с (и один прогон за 30 с в падение), 6 воркеров —
    // 36.2 с (падение), 4 воркера — 15.0 / 15.6 / 18.9 с, три прогона из трёх зелёные.
    // Число намерено абсолютное, а не процент: процент от 4 vCPU раннера CI дал бы одного
    // воркера и замедлил бы CI втрое, тогда как переподписка живёт только на многоядерных
    // машинах разработчиков.
    maxWorkers: 4,
  },
});
