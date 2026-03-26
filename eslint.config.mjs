import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import js from '@eslint/js';
import ts from 'typescript-eslint';

export default defineConfig(
  js.configs.recommended,
  ts.configs.recommended,
  {
    languageOptions: { globals: globals.browser },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'curly': ['error', 'all'],
      'brace-style': ['error', 'stroustrup'],
    },
  },
  globalIgnores([
    ".output/**",
    ".wxt/**",
  ]),
);
