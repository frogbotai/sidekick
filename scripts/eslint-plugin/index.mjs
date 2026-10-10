import noComments from './rules/no-comments.mjs';
import noImportsFromSelf from './rules/no-imports-from-self.mjs';

/** @type {import('eslint').ESLint.Plugin} */
export default {
  meta: { name: 'sidekick' },
  rules: {
    'no-comments': noComments,
    'no-imports-from-self': noImportsFromSelf,
  },
};
