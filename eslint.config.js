// @ts-check

import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  {
    name: 'tachi-lens/global-ignores',
    ignores: [
      'node_modules/**',
      'dist/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  {
    name: 'tachi-lens/language-options',
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  // Match TypeScript's established unused-identifier convention. tsc's
  // noUnusedLocals/noUnusedParameters already ignore identifiers prefixed
  // with an underscore (used for intentional omission and interface stubs
  // throughout this codebase), so ESLint must honor the same convention
  // rather than flag code that tsc strict mode deliberately accepts.
  {
    name: 'tachi-lens/no-unused-vars-convention',
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  // React Hooks recommended rules for TSX/React files (Popup component + tests).
  {
    name: 'tachi-lens/react-hooks',
    files: ['**/*.tsx'],
    ...reactHooks.configs.flat.recommended,
  },
  // The Popup component is hand-written React (no React Compiler). The React
  // Compiler-specific rules bundled in the react-hooks v7 recommended preset
  // flag the component's intentional patterns: mount-time data loading via an
  // async callback (set-state-in-effect) and cross-referenced useCallback
  // memoization (immutability / preserve-manual-memoization). Fixing these
  // would require changing hook dependency arrays or declaration order, which
  // alters React Hook behavior. This narrow file-level exception keeps the
  // classic React Hooks rules (rules-of-hooks, exhaustive-deps) active while
  // dropping only the compiler-assumption rules for this one component.
  {
    name: 'tachi-lens/react-hooks-app-exceptions',
    files: ['src/popup/App.tsx'],
    rules: {
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
    },
  },
  // Playwright requires the `context` fixture to be declared with Playwright's
  // object-destructuring form (`async ({}, use)`) for it to receive the base
  // `context` fixture. The empty pattern is intentional — the fixture value is
  // unused because the extension launches its own persistent context. This is
  // the narrowest exception for that single platform-required fixture.
  {
    name: 'tachi-lens/e2e-extension-fixture-empty-pattern',
    files: ['e2e/fixtures/extension.ts'],
    rules: {
      'no-empty-pattern': 'off',
    },
  },
  // Node globals for maintained scripts, E2E tests, config files, and the root
  // documentation-contract test that reads the rule documents from disk.
  {
    name: 'tachi-lens/node-globals',
    files: [
      'eslint.config.js',
      'scripts/**/*.mjs',
      'e2e/**/*.ts',
      'vite.config.ts',
      'vitest.config.ts',
      'playwright.config.ts',
      'playwright.canary.config.ts',
      'src/agents-policy.contract.test.ts',
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  // Service Worker + WebExtension globals for the MV3 background worker.
  {
    name: 'tachi-lens/service-worker-globals',
    files: ['src/background/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.serviceworker,
        ...globals.webextensions,
      },
    },
  },
  // Browser + WebExtension globals for the content script and React popup.
  {
    name: 'tachi-lens/browser-globals',
    files: ['src/content/**/*.ts', 'src/popup/**/*.ts', 'src/popup/**/*.tsx'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.webextensions,
      },
    },
  },
  // Cross-context modules shared between SW, content script, and tests. The
  // browser + WebExtension superset is safe for pure modules and matches the
  // codebase's use of platform globals guarded by feature checks.
  {
    name: 'tachi-lens/shared-globals',
    files: [
      'src/shared/**/*.ts',
      'src/storage/**/*.ts',
      'src/providers/**/*.ts',
      'src/test-utils/**/*.ts',
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.webextensions,
      },
    },
  },
  // Vitest globals for colocated tests. Tests inherit their directory's
  // platform globals (jsdom tests in content/popup get browser globals;
  // background tests get service-worker globals) via config merging.
  {
    name: 'tachi-lens/vitest-globals',
    files: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    languageOptions: {
      globals: globals.vitest,
    },
  },
)
