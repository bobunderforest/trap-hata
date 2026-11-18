import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['dist/**', 'coverage/**', '.wrangler/**']
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        __DEV__: 'readonly'
      }
    },
    rules: {
      'no-var': 'error',
      'prefer-const': 'error',
      'no-shadow': 'error',
      'no-unused-vars': ['error', { vars: 'local', args: 'after-used' }],
      'no-use-before-define': ['error', { functions: false }],
      'no-cond-assign': ['error', 'always'],
      'no-console': 'warn',
      'no-debugger': 'warn',
      'no-alert': 'warn',
      'no-constant-condition': 'warn',
      'no-extra-boolean-cast': 'off',
      'block-scoped-var': 'error',
      'consistent-return': 'error',
      'curly': ['error', 'multi-line'],
      'default-case': 'error',
      'dot-notation': ['error', { allowKeywords: true }],
      'eqeqeq': 'error',
      'guard-for-in': 'error',
      'no-caller': 'error',
      'no-else-return': 'error',
      'no-eq-null': 'error',
      'no-eval': 'error',
      'no-extend-native': 'error',
      'no-extra-bind': 'error',
      'no-implied-eval': 'error',
      'no-lone-blocks': 'error',
      'no-loop-func': 'error',
      'no-multi-str': 'error',
      'no-new': 'error',
      'no-new-func': 'error',
      'no-new-wrappers': 'error',
      'no-octal-escape': 'error',
      'no-param-reassign': 'error',
      'no-proto': 'error',
      'no-return-assign': 'error',
      'no-script-url': 'error',
      'no-self-compare': 'error',
      'no-sequences': 'error',
      'no-throw-literal': 'error',
      'radix': 'error',
      'vars-on-top': 'error',
      'yoda': 'error',
      'camelcase': ['error', { properties: 'never' }],
      'func-names': 'warn',
      'no-nested-ternary': 'error',
      'no-object-constructor': 'error',
      'no-underscore-dangle': 'off',
      'one-var': ['error', 'never'],
      'spaced-comment': ['error', 'always', { exceptions: ['-', '+'], markers: ['=', '!'] }]
    }
  },
  {
    files: ['worker/**/*.js'],
    languageOptions: {
      globals: { ...globals.serviceworker, WebSocketPair: 'readonly' }
    }
  }
];
