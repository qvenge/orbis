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
    // Дефолт vitest — `availableParallelism − 1`; на машине разработчика это 11 форков
    // jsdom на 12 ядрах при 16 ГБ, и они переподписывают процессор: та же работа стоит
    // 205 с процессорного времени против 65 с на четырёх воркерах, сьют идёт 64–70 с
    // против 49–58 с. Размена «медленнее, зато стабильнее» здесь нет — ограничение
    // одновременно и быстрее, и стабильнее, поэтому оно же и есть лечение флака:
    // на четырёх воркерах дефолтный порог ожидания Testing Library держит нагрузку
    // (см. tests/setup.ts), и поднимать пороги не пришлось.
    // Замер под внешней нагрузкой (6 счётных петель), длительность самого тяжёлого теста
    // при его бюджете 30 с: дефолт — 29.6 с и один прогон в падение, 6 воркеров — 36.2 с
    // (падение: доля планировщика падает вместе с числом воркеров), 4 воркера — 15.0–18.9 с,
    // восемь стресс-прогонов из восьми зелёные.
    //
    // На CI намеренно не вмешиваемся. Там 4 vCPU и дефолт равен 3; переподписка на CI
    // есть и без нас — корневой `bun run test` гоняет серверный сьют одновременно с web, —
    // но выигрыша от вмешательства нет (флак наблюдался только на многоядерной машине
    // разработчика), а запас мал: в прогоне 31323625842 web занял 60.87 с и финишировал
    // всего на 6.0 с раньше серверного сьюта (67.56 с), который и есть критический путь
    // шага. Забрать у web ещё одно ядро — риск удлинить CI без всякой выгоды.
    maxWorkers: process.env.CI ? undefined : 4,
  },
});
