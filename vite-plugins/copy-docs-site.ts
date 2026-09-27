import { cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This file lives at <repoRoot>/vite-plugins/copy-docs-site.ts, so one
// dirname() strips the filename (-> <repoRoot>/vite-plugins) and a second
// strips that directory (-> <repoRoot>). Resolving from the file's own
// location, not process.cwd(), keeps this a zero-behavior-change extraction
// of vite.config.ts's original __dirname-based resolution (vite.config.ts
// sits directly at <repoRoot>, one dirname short of this file).
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Copies the built VitePress docs site into `<outDir>/docs` at build time, so
 * the shipped app's DocsSheet iframe (which loads relative `docs/...` paths,
 * see packages/core/src/docs-config.ts's docsUrl()) resolves without a
 * network request. Used by the main build (outDir: 'dist'); the HTML export
 * builds carry no docs. */
export function copyDocsSite(outDir: string) {
  return {
    name: 'copy-docs-site',
    apply: 'build' as const,
    closeBundle() {
      const docsDist = path.resolve(repoRoot, 'docs-site/.vitepress/dist');
      if (!existsSync(docsDist)) {
        throw new Error(
          '[copy-docs-site] docs-site/.vitepress/dist not found: run `npm run docs:build` first (the `build` script does this automatically).',
        );
      }
      cpSync(docsDist, path.resolve(repoRoot, outDir, 'docs'), { recursive: true });
    },
  };
}
