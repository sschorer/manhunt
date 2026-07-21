import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  // Load .env* files so VITE_SERVER_URL set there configures the dev proxy.
  const env = loadEnv(mode, process.cwd(), '');
  // The API/socket server the client talks to during development.
  const SERVER = env.VITE_SERVER_URL || 'http://localhost:3000';

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
        '/socket.io': { target: SERVER, ws: true, changeOrigin: true },
        '/health': { target: SERVER, changeOrigin: true },
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
