import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This file lives at <repoRoot>/vite-plugins/copy-docs-site.ts, so one
// dirname() strips the filename (-> <repoRoot>/vite-plugins) and a second
// strips that directory (-> <repoRoot>). Resolving from the file's own
// location, not process.cwd(), keeps this a zero-behavior-change extraction
// of vite.config.ts's original __dirname-based resolution (vite.config.ts
// sits directly at <repoRoot>, one dirname short of this file).
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Mirrors docs-site/.vitepress/config.ts's default DOCS_BASE. The export
// build never overrides DOCS_BASE (only DOCS_MPA, see that file), so this is
// the actual literal prefix VitePress bakes into every generated page's own
// href/src attributes and CSS `url()` calls.
const DOCS_BASE_PREFIX = '/docs/';

/** Rewrites every root-absolute `/docs/...` reference a copied VitePress page
 * carries in its own attributes/CSS into the correct `../`-repeated relative
 * path for that file's actual depth under `docsRoot`. VitePress applies one
 * literal `base` string to every generated page regardless of its folder
 * depth: `/docs/assets/x.css` is right for `docs/index.html` but needs to be
 * `../assets/x.css` from `docs/tuning-reference/aqe.html`, which is what
 * breaks the HTML export (opened via `file://`, so a root-absolute path
 * resolves against the filesystem root instead of the export folder). Only
 * matches the prefix immediately after a quote or `url(` so it never touches
 * the same substring inside an unrelated absolute URL (e.g.
 * `https://spark.apache.org/docs/latest/...`). VitePress also bakes literal
 * `/docs/...` strings into per-page JS chunks, so `.js` files get the same
 * treatment as `.html`/`.css`.
 *
 * VitePress also links a directory's index page by its bare directory path
 * (e.g. `/docs/tuning-reference/`, no filename): an HTTP server resolves that
 * trailing slash to `index.html` on its own, but `file://` has no such
 * resolution and instead shows Chromium's own directory listing. Every such
 * link's target does have a real `index.html` on disk (VitePress always
 * emits one for a directory-index page), so append it whenever the path part
 * (after stripping any `#fragment`) is empty or trailing-slash — including
 * the bare `/docs/` root link and a fragment-only directory link like
 * `/docs/#top` (which must resolve to `index.html#top`, not `.html#top`).
 *
 * The tuning-reference sidebar's own links (built by config.ts's
 * `navSidebar()`) go a step further and omit the extension entirely, e.g.
 * `/docs/tuning-reference/aqe` with no `.html`: normally VitePress's
 * client-side router intercepts the click and resolves the page by slug, but
 * MPA mode has no such router, so a plain `<a>` navigation needs the real
 * filename. Append `.html` to any non-directory remainder whose last path
 * segment has no extension already (an asset reference like `assets/x.css`
 * is left alone), preserving a trailing `#fragment` after the inserted
 * extension. */
export function rewriteAbsoluteDocsPaths(docsRoot: string, dir: string): void {
  const prefixPattern = new RegExp(`(["'(])${DOCS_BASE_PREFIX.replace(/\//g, '\\/')}([^"')]*)`, 'g');
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      rewriteAbsoluteDocsPaths(docsRoot, full);
      continue;
    }
    if (!/\.(html|css|js)$/.test(entry.name)) continue;
    const depth = path.relative(docsRoot, dir).split(path.sep).filter(Boolean).length;
    const relPrefix = depth === 0 ? './' : '../'.repeat(depth);
    const content = readFileSync(full, 'utf8');
    const rewritten = content.replace(prefixPattern, (_match, delim: string, rest: string) => {
      // Split off the fragment before classifying the path, so a directory-style
      // link carrying only a `#fragment` (e.g. `/docs/#top`) still resolves to
      // index.html rather than a bare `.html#fragment`.
      const [pathPart, ...fragParts] = rest.split('#');
      const frag = fragParts.length ? `#${fragParts.join('#')}` : '';
      const resolvedPath =
        pathPart === '' || pathPart.endsWith('/')
          ? `${pathPart}index.html`
          : /\.[a-z0-9]+$/i.test(pathPart) ? pathPart : `${pathPart}.html`;
      return `${delim}${relPrefix}${resolvedPath}${frag}`;
    });
    if (rewritten !== content) writeFileSync(full, rewritten);
  }
}

/** Copies the built VitePress docs site into `<outDir>/docs` at build time, so
 * the shipped app's DocsSheet iframe (which loads relative `docs/...` paths,
 * see packages/core/src/docs-config.ts's docsUrl()) resolves without a
 * network request. Shared by the main build (outDir: 'dist') and the
 * export-html build (outDir: 'dist-export'). `rewriteRelative` is export-only
 * (see vite.export.config.ts): the server-hosted build keeps VitePress's
 * root-absolute paths, which resolve correctly against its HTTP origin. */
export function copyDocsSite(outDir: string, opts: { rewriteRelative?: boolean } = {}) {
  return {
    name: 'copy-docs-site',
    apply: 'build' as const,
    closeBundle() {
      const docsDist = path.resolve(repoRoot, 'docs-site/.vitepress/dist');
      if (!existsSync(docsDist)) {
        throw new Error(
          '[copy-docs-site] docs-site/.vitepress/dist not found: run `npm run docs:build` first (the `build`/`build:export` scripts do this automatically).',
        );
      }
      const dest = path.resolve(repoRoot, outDir, 'docs');
      cpSync(docsDist, dest, { recursive: true });
      if (opts.rewriteRelative) rewriteAbsoluteDocsPaths(dest, dest);
    },
  };
}
