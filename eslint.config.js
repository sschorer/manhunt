import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default [
  {
    ignores: [
      '**/node_modules/**',
      'dist/**',
      'client/dist/**',
      'client/dev-dist/**',
      'public/**',
    ],
  },

  js.configs.recommended,

  // Node-side code: server + build/config tooling.
  {
    files: [
      'server/**/*.js',
      '*.config.js',
      'client/vite.config.js',
      'client/playwright.config.js',
    ],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  // TypeScript server code (run directly via Node's native type stripping).
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['server/**/*.ts'],
  })),
  {
    files: ['server/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  // React client (browser).
  {
    files: ['client/src/**/*.{js,jsx}'],
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
    files: ['**/*.test.{js,jsx,ts}', 'client/e2e/**/*.spec.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
];
