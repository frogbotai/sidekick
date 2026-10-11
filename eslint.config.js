import eslint from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import vitest from '@vitest/eslint-plugin';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import sidekick from './scripts/eslint-plugin/index.mjs';
import { reactA11yRules } from './scripts/lib/eslint-react-a11y.mjs';

const IGNORES = ['**/node_modules/*', '**/dist/*', '**/build/*', '**/.output/*', '**/.wxt/*'];

const SPECS = ['**/*.spec.ts', '**/*.spec.tsx'];

const SLEEP = 'Wait for a condition, not a fixed time';

const CAST_MESSAGE =
  'No `as never` or `as unknown as` in product code. Type the value, or cross a seam with a checked converter.';

const NO_SYNC_MESSAGE =
  'Settings and credentials stay on this device: use chrome.storage.local, never storage.sync (PLAN D7).';

const noSync = [
  {
    selector:
      "MemberExpression:matches([object.name='storage'], [object.property.name='storage']):matches([property.name='sync'], [property.value='sync'])",
    message: NO_SYNC_MESSAGE,
  },
  {
    selector:
      "VariableDeclarator:matches([init.name='storage'], [init.property.name='storage']) > ObjectPattern > Property[key.name='sync']",
    message: NO_SYNC_MESSAGE,
  },
];

const castBans = [
  { selector: "TSAsExpression[typeAnnotation.type='TSNeverKeyword']", message: CAST_MESSAGE },
  {
    selector:
      "TSAsExpression[expression.type='TSAsExpression'][expression.typeAnnotation.type='TSUnknownKeyword']",
    message: CAST_MESSAGE,
  },
];

function topLevel(...types) {
  const exported = types.map((type) => `[declaration.type="${type}"]`).join(', ');

  return {
    selector: `Program > :matches(${types.join(', ')}, ExportNamedDeclaration:matches(${exported}))`,
  };
}

const DECLARATION = topLevel(
  'ClassDeclaration',
  'FunctionDeclaration',
  'TSDeclareFunction',
  'TSEnumDeclaration',
  'TSInterfaceDeclaration',
  'TSModuleDeclaration',
  'TSTypeAliasDeclaration',
);

const OVERLOAD = topLevel('TSDeclareFunction');

const FUNCTION = topLevel('FunctionDeclaration', 'TSDeclareFunction');

const PARAGRAPH = ['for', 'while', 'do', 'multiline-expression'];

const blankLines = [
  'error',
  { blankLine: 'always', prev: '*', next: 'return' },
  { blankLine: 'always', prev: ['multiline-const', 'multiline-let'], next: '*' },
  { blankLine: 'always', prev: '*', next: PARAGRAPH },
  { blankLine: 'always', prev: PARAGRAPH, next: '*' },
  { blankLine: 'always', prev: 'block-like', next: '*' },
  { blankLine: 'always', prev: '*', next: DECLARATION },
  { blankLine: 'always', prev: DECLARATION, next: '*' },
  { blankLine: 'any', prev: OVERLOAD, next: FUNCTION },
];

export default tseslint.config(
  { ignores: IGNORES },
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser, chrome: 'readonly' },
    },
    plugins: { '@stylistic': stylistic, 'simple-import-sort': simpleImportSort },
    rules: {
      '@stylistic/padding-line-between-statements': blankLines,
      '@stylistic/lines-between-class-members': [
        'error',
        'always',
        { exceptAfterSingleLine: true },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': 'allow-with-description',
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-check': false,
          minimumDescriptionLength: 10,
        },
      ],
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      'no-console': 'error',
      'no-restricted-syntax': ['error', ...noSync],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      curly: ['error', 'multi-line'],
    },
  },
  {
    files: SPECS,
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
      'vitest/padding-around-expect-groups': 'error',
      'no-restricted-syntax': [
        'error',
        ...noSync,
        { selector: "CallExpression[callee.name='sleep']", message: SLEEP },
      ],
    },
  },
  {
    files: ['**/scripts/**', '**/bin/**', '**/cli/**'],
    rules: { 'no-console': 'off' },
  },
  {
    plugins: { sidekick },
    rules: {
      'sidekick/no-comments': 'error',
      'sidekick/no-imports-from-self': 'error',
    },
  },
  {
    files: ['packages/**/src/**/*.{ts,tsx}'],
    ignores: SPECS,
    rules: { 'no-restricted-syntax': ['error', ...noSync, ...castBans] },
  },
  {
    files: ['packages/**/src/**'],
    ignores: SPECS,
    rules: { 'max-lines': ['error', { max: 500, skipBlankLines: true, skipComments: true }] },
  },
  {
    files: ['**/*.tsx'],
    plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-hooks/exhaustive-deps': 'error',
      ...reactA11yRules,
      'jsx-a11y/anchor-is-valid': 'off',
      'jsx-a11y/control-has-associated-label': 'off',
      'jsx-a11y/no-static-element-interactions': 'off',
      'jsx-a11y/label-has-associated-control': 'off',
    },
  },
);
