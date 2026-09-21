import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      // Merge browser+worker+node globals: one shared no-undef check across
      // all three environments, no per-directory overrides.
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.worker,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Guard against em dashes in detectors.ts's user-facing strings. Scoped to
    // this one file; em dashes are fine elsewhere. Uses a trivial no-op parser
    // (returns an empty Program) plus a raw-text scan because espree can't parse
    // TypeScript and typescript-eslint crashes against TS 7 (see ignores below).
    files: ['packages/core/src/detectors.ts'],
    languageOptions: {
      parser: {
        parse(text) {
          return {
            type: 'Program',
            body: [],
            sourceType: 'module',
            comments: [],
            tokens: [],
            range: [0, text.length],
            loc: {
              start: { line: 1, column: 0 },
              end: { line: text.split('\n').length, column: 0 },
            },
          };
        },
      },
    },
    plugins: {
      'em-dash-guard': {
        rules: {
          'no-em-dash-text': {
            create(context) {
              return {
                Program(node) {
                  const text = context.sourceCode.getText();
                  // Blank out comments (same length keeps indices aligned) before scanning.
                  const stripped = text
                    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
                    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
                  const re = /—/g;
                  let match;
                  while ((match = re.exec(stripped)) !== null) {
                    const before = text.slice(0, match.index);
                    const line = before.split('\n').length;
                    const column = match.index - before.lastIndexOf('\n') - 1;
                    context.report({
                      node,
                      loc: { line, column },
                      message:
                        'Em dash (—) not allowed in detectors.ts string/template literals; use a period, comma, or parenthetical instead.',
                    });
                  }
                },
              };
            },
          },
        },
      },
    },
    rules: {
      'em-dash-guard/no-em-dash-text': 'error',
    },
  },
  {
    // `.ts`/`.tsx` are NOT linted: typescript-eslint crashes at import time
    // against TypeScript 7 (`ts.Extension.Cjs` gone), and no released version
    // supports it yet. `tsc --noEmit` is the only type/syntax check on the view
    // layer until then.
    ignores: [
      'node_modules/**',
      'packages/server/node_modules/**',
      'packages/core/src/vendor/**',
      'packages/server/public/**',
      'packages/*/vendor-core/**',
      'dist/**',
      'docs-site/.vitepress/dist/**',
      'docs-site/.vitepress/cache/**',
      '.claude/worktrees/**',
    ],
  },
];
