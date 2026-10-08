// @ts-check
import js from '@eslint/js';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import importX from 'eslint-plugin-import-x';
import noUnsanitized from 'eslint-plugin-no-unsanitized';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

const root = import.meta.dirname;

// Layer rules from PLAN §2.1. Paths are relative to the repo root; `except`
// is relative to `from`. eslint-plugin-import-x is registered under the
// `import` namespace, so the rule id is `import/no-restricted-paths`.
const LAYER_ZONES = [
  {
    target: './src/domain',
    from: './src',
    except: ['./domain', './ports'],
    message: 'src/domain may import only src/domain and src/ports (PLAN §2.1).',
  },
  {
    target: './src/adapters',
    from: './src',
    except: [
      './adapters',
      './ports',
      './domain/types.ts',
      './domain/snipe/types.ts',
      './domain/calendar/types.ts',
      './domain/audit/types.ts',
      './domain/storage/schema.ts',
    ],
    message: 'src/adapters may import only src/adapters, src/ports and domain types (PLAN §2.1).',
  },
];
const NOTHING_IMPORTS_ENTRYPOINTS = {
  target: '.',
  from: './src/entrypoints',
  message: 'Nothing imports from src/entrypoints (PLAN §2.1).',
};

const NO_POLYFILL = {
  name: 'webextension-polyfill',
  message: 'The polyfill is archived and not used; import { browser } from "wxt/browser".',
};
const BROWSER_API_IMPORTS = ['wxt/browser', '@wxt-dev/browser', '#imports', 'wxt/utils/storage', '@wxt-dev/storage'].map(
  (name) => ({
    name,
    message:
      'Extension APIs may be used only in src/adapters/browser, src/background, src/content and src/entrypoints (PLAN §2.1).',
  }),
);

export default defineConfig(
  globalIgnores([
    '.output/',
    '.wxt/',
    'coverage/',
    'node_modules/',
    'planning/',
    'playwright-report/',
    'test-results/',
    '.superpowers/',
    'scripts/*-probe/**',
  ]),

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: root,
      },
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // No unsanitized DOM sinks (innerHTML/outerHTML/insertAdjacentHTML...), no
  // eval or new Function, no polyfill: everywhere. String timers are caught by
  // @typescript-eslint/no-implied-eval (strictTypeChecked).
  noUnsanitized.configs.recommended,
  {
    rules: {
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-imports': ['error', { paths: [NO_POLYFILL] }],
    },
  },

  // Dependency rule (PLAN §2.1).
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { import: importX },
    settings: {
      'import-x/resolver-next': [createTypeScriptImportResolver({ project: `${root}/tsconfig.json` })],
    },
    rules: {
      'import/no-restricted-paths': [
        'error',
        { basePath: root, zones: [...LAYER_ZONES, NOTHING_IMPORTS_ENTRYPOINTS] },
      ],
    },
  },
  {
    files: ['src/entrypoints/**/*.{ts,tsx}'],
    rules: {
      'import/no-restricted-paths': ['error', { basePath: root, zones: LAYER_ZONES }],
    },
  },

  // Extension APIs only where PLAN §2.1 allows them.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/adapters/browser/**', 'src/background/**', 'src/content/**', 'src/entrypoints/**'],
    rules: {
      'no-restricted-imports': ['error', { paths: [NO_POLYFILL, ...BROWSER_API_IMPORTS] }],
      'no-restricted-globals': [
        'error',
        { name: 'browser', message: BROWSER_API_IMPORTS[0]?.message },
        { name: 'chrome', message: BROWSER_API_IMPORTS[0]?.message },
      ],
    },
  },

  // Production code: no HTML-string DOM APIs, no Date.parse, no storage.sync
  // (PLAN §7.1, §1.8).
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[property.name='sync'][object.type='MemberExpression'][object.property.name='storage'], MemberExpression[property.name='sync'][object.name='storage']",
          message: 'No storage.sync: it uploads data to the browser vendor. Use storage.local.',
        },
        {
          selector: "MemberExpression[property.name=/^(innerHTML|outerHTML)$/]",
          message: 'No innerHTML/outerHTML: build DOM nodes or render with Preact.',
        },
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'No dangerouslySetInnerHTML: render text, never HTML strings.',
        },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='parse']",
          message: 'No Date.parse: parse SGW times with src/domain/time.',
        },
      ],
    },
  },
);
