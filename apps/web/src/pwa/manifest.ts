// theme/background — токен bg «ночной обсерватории» (#0c0d12, §4.9).
export const pwaManifest = {
  name: 'Orbis',
  short_name: 'Orbis',
  description: 'Личная операционная система',
  display: 'standalone' as const,
  start_url: '/',
  scope: '/',
  theme_color: '#0c0d12',
  background_color: '#0c0d12',
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
};
