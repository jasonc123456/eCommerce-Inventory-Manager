/**
 * Prettier is the single deterministic formatter for the workspace (D-115).
 * ESLint does not carry stylistic rules; eslint-config-prettier switches off any
 * that arrive with a plugin.
 *
 * @type {import('prettier').Config}
 */
export default {
  printWidth: 100,
  singleQuote: true,
  semi: true,
  trailingComma: 'all',
  arrowParens: 'always',
  endOfLine: 'lf',
  overrides: [
    {
      files: ['*.md'],
      options: { proseWrap: 'preserve' },
    },
    {
      files: ['*.yml', '*.yaml'],
      options: { singleQuote: false },
    },
  ],
};
