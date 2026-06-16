import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

// Pragmatic, NON-type-aware lint config: this codebase was never linted, so the gate is scoped to
// real bug classes (rules-of-hooks, constant conditions, undeclared globals via TS) — stylistic
// and "any"/non-null rules are off so the lint stays a meaningful, passable gate rather than a
// wall of cosmetic noise. Type safety is already enforced by `npm run typecheck` (strict tsc).
export default tseslint.config(
  { ignores: ['out/**', 'release/**', 'node_modules/**', 'dist/**', '**/*.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error', // the audit's headline lint win — real bug class
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-constant-condition': ['error', { checkLoops: false }],
      'prefer-const': 'warn',
      'no-useless-escape': 'warn',
      // Off — these flag INTENTIONAL/defensive idioms, not bugs (behavior is covered by tsc + the
      // test suite). no-useless-assignment fires on `let x = [] ` initializers before a try/catch
      // that always reassigns-or-returns; preserve-caught-error wants `{ cause }` on every rethrow;
      // no-unused-expressions fires on the deliberate `(set.add(x), stack.push(x))` loop-body comma
      // idiom. Keeping them on would make the gate cosmetic noise rather than a bug catcher.
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
      '@typescript-eslint/no-unused-expressions': 'off'
    }
  },
  {
    // node-side scripts + config use process/console freely
    files: ['scripts/**', '*.config.*', '*.config.js'],
    rules: { 'no-undef': 'off' }
  }
)
