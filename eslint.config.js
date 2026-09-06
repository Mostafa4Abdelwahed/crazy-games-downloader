// ESLint 9 flat config.
const tseslint = require('typescript-eslint');
const eslintPluginPrettier = require('eslint-plugin-prettier');

module.exports = [
  ...tseslint.configs.recommended,
  {
    plugins: { prettier: eslintPluginPrettier },
    rules: {
      '@typescript-eslint/interface-name-prefix': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'prettier/prettier': ['error', { singleQuote: true, trailingComma: 'all' }],
    },
  },
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
];
