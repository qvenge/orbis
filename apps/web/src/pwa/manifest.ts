// theme/background — токен bg светлой темы (#fbfbfa, дефолт).
export const pwaManifest = {
  name: 'Orbis',
  short_name: 'Orbis',
  description: 'Личная операционная система',
  display: 'standalone' as const,
  start_url: '/',
  scope: '/',
  theme_color: '#fbfbfa',
  background_color: '#fbfbfa',
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
};
