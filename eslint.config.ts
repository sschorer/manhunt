import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      'dist/**',
      'dist-worker/**',
      'dist-next/**',
      'client/dist/**',
      'client/dev-dist/**',
      'public/**',
      '**/.wrangler/**',
    ],
  },

  js.configs.recommended,

  // Base TypeScript rules for every .ts/.tsx file (server, client, configs).
  ...tseslint.configs.recommended,

  // Node-side TypeScript: server + build/config tooling.
  {
    files: [
      'server/**/*.ts',
      'scripts/**/*.ts',
      '*.config.ts',
      'client/vite.config.ts',
      'client/playwright.config.ts',
      'client/e2e/**/*.ts',
    ],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  // Shared wire protocol (imported by the browser client, the Node server and
  // the Worker) and the game core (hosted by a Durable Object, tested in plain
  // Vitest) must stay free of platform imports.
  {
    files: ['shared/**/*.ts', 'server/game/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['node:*', 'cloudflare:*'], message: 'shared/ and the game core must use web standards only.' }] },
      ],
    },
  },

  // React client (browser).
  {
    files: ['client/src/**/*.{ts,tsx}'],
    plugins: {
      react,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // Vite/React 19: the JSX transform is automatic, no React import needed.
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },

  // Test files run under Vitest (browser + node globals available).
  {
    files: ['**/*.test.{ts,tsx}', 'client/e2e/**/*.spec.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },

  // Static service-worker scripts served from client/public (e.g. the Web Push
  // handlers imported into the generated worker): they run in the ServiceWorker
  // global scope, not the window.
  {
    files: ['client/public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.serviceworker },
    },
  },
);
