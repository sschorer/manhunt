import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  // Load .env* files so DEV_PROXY_TARGET set there configures the dev proxy.
  const env = loadEnv(mode, process.cwd(), '');
  // Where the Vite dev server forwards /socket.io + /health during development.
  // This is a Node-only value (deliberately NOT VITE_-prefixed) so it is never
  // inlined into the browser bundle: the browser always talks to the dev server
  // same-origin and Vite proxies from there. In the Docker dev stack this points
  // at the `server` service; on a bare host it defaults to localhost. An explicit
  // environment variable (e.g. from Docker Compose) wins over .env files.
  const PROXY_TARGET =
    process.env.DEV_PROXY_TARGET || env.DEV_PROXY_TARGET || 'http://localhost:3000';

  return {
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.png', 'apple-touch-icon.png'],
        manifest: {
          name: 'Manhunt',
          short_name: 'Manhunt',
          description: 'Web-based GPS hide-and-seek game',
          theme_color: '#06080c',
          background_color: '#06080c',
          display: 'standalone',
          orientation: 'portrait',
          icons: [
            { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
            { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
            {
              src: 'pwa-maskable-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
      }),
    ],
    // The client is built into the repo-root `dist/`, which the server serves in
    // production and the Dockerfile copies into the runtime image.
    build: {
      outDir: '../dist',
      emptyOutDir: true,
    },
    server: {
      port: 5173,
      // Proxy the Socket.IO endpoint and the health check to the game server so
      // the dev client can reach them same-origin (no CORS, sockets upgrade).
      proxy: {
        '/socket.io': { target: PROXY_TARGET, ws: true, changeOrigin: true },
        '/health': { target: PROXY_TARGET, changeOrigin: true },
      },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.{test,spec}.{js,jsx,ts,tsx}'],
      // Playwright specs live in e2e/ and must not be run by Vitest.
      exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    },
  };
});
