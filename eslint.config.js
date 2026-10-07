import js from '@eslint/js';
import globals from 'globals';

// Root config covers packages/** and runtimes/**. Apps keep the configs they arrived
// with (linted through `pnpm -r run lint`). Rule block mirrors canvas-cli's so
// the repos share one style.
export default [
    {
        ignores: ['apps/**', '**/node_modules/**', '**/dist/**', '**/coverage/**']
    },
    js.configs.recommended,
    {
        files: ['scripts/**/*.{js,mjs}'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.node,
                ...globals.es2022
            }
        }
    },
    {
        files: ['packages/**/*.{js,mjs}', 'runtimes/**/*.{js,mjs}', 'runtimes/**/bin/*'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.node,
                ...globals.es2022
            }
        },
        rules: {
            'no-console': 'off',
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            'prefer-const': 'warn',
            'no-var': 'error',
            semi: ['error', 'always'],
            quotes: ['warn', 'single', { allowTemplateLiterals: true }],
            indent: ['warn', 4, { SwitchCase: 1 }],
            'no-trailing-spaces': 'warn',
            'eol-last': 'warn'
        }
    }
];
