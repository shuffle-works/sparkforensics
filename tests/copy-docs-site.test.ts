import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { escapeRegExp, rewriteAbsoluteDocsPaths } from '../vite-plugins/copy-docs-site.ts';

// The HTML export is opened via `file://`, where a root-absolute path
// resolves against the filesystem root instead of the export folder — see
// copy-docs-site.ts's doc comment for the full root-cause story. This exercises
// the rewrite that fixes it, against a small fixture tree standing in for a
// copied VitePress build.
describe('rewriteAbsoluteDocsPaths', () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rewrites a top-level page to a "./"-relative prefix, appending index.html for the bare root link', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'copy-docs-site-'));
    writeFileSync(path.join(dir, 'index.html'), '<link href="/docs/assets/style.css"><a href="/docs/">Home</a>');

    rewriteAbsoluteDocsPaths(dir, dir);

    expect(readFileSync(path.join(dir, 'index.html'), 'utf8')).toBe(
      '<link href="./assets/style.css"><a href="./index.html">Home</a>',
    );
  });

  it('rewrites a page one folder deep to a "../"-relative prefix', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'copy-docs-site-'));
    mkdirSync(path.join(dir, 'tuning-reference'));
    writeFileSync(
      path.join(dir, 'tuning-reference', 'aqe.html'),
      '<link href="/docs/assets/style.css"><img src="/docs/assets/aqe-loop.svg">',
    );

    rewriteAbsoluteDocsPaths(dir, dir);

    expect(readFileSync(path.join(dir, 'tuning-reference', 'aqe.html'), 'utf8')).toBe(
      '<link href="../assets/style.css"><img src="../assets/aqe-loop.svg">',
    );
  });

  // `file://` has no server-side "/" -> "/index.html" resolution the way an
  // HTTP server does; Chromium shows its own directory listing instead
  // (confirmed against a real exported report — see PR notes). VitePress
  // links a directory's index page by its bare directory path, so this must
  // append the real filename.
  it('appends index.html to a directory-style nested link', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'copy-docs-site-'));
    mkdirSync(path.join(dir, 'tuning-reference'));
    writeFileSync(
      path.join(dir, 'tuning-reference', 'aqe.html'),
      '<a href="/docs/tuning-reference/">Tuning Reference</a>',
    );

    rewriteAbsoluteDocsPaths(dir, dir);

    expect(readFileSync(path.join(dir, 'tuning-reference', 'aqe.html'), 'utf8')).toBe(
      '<a href="../tuning-reference/index.html">Tuning Reference</a>',
    );
  });

  it('rewrites a page two folders deep to a "../../"-relative prefix', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'copy-docs-site-'));
    mkdirSync(path.join(dir, 'contributor-guide', 'architecture'), { recursive: true });
    writeFileSync(
      path.join(dir, 'contributor-guide', 'architecture', 'overview.html'),
      '<link href="/docs/assets/style.css">',
    );

    rewriteAbsoluteDocsPaths(dir, dir);

    expect(readFileSync(path.join(dir, 'contributor-guide', 'architecture', 'overview.html'), 'utf8')).toBe(
      '<link href="../../assets/style.css">',
    );
  });

  it('rewrites a CSS url() reference relative to the stylesheet itself', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'copy-docs-site-'));
    mkdirSync(path.join(dir, 'assets'));
    writeFileSync(
      path.join(dir, 'assets', 'style.css'),
      "@font-face{src:url(/docs/assets/inter-roman-latin.woff2)}",
    );

    rewriteAbsoluteDocsPaths(dir, dir);

    expect(readFileSync(path.join(dir, 'assets', 'style.css'), 'utf8')).toBe(
      "@font-face{src:url(../assets/inter-roman-latin.woff2)}",
    );
  });

  // The tuning-reference sidebar's own links omit the extension (VitePress's
  // client-side router normally resolves this; MPA mode has none — see the
  // doc comment on rewriteAbsoluteDocsPaths).
  it('appends .html to an extensionless page-slug link', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'copy-docs-site-'));
    mkdirSync(path.join(dir, 'tuning-reference'));
    writeFileSync(path.join(dir, 'tuning-reference', 'aqe.html'), '<a href="/docs/tuning-reference/joins">Joins</a>');

    rewriteAbsoluteDocsPaths(dir, dir);

    expect(readFileSync(path.join(dir, 'tuning-reference', 'aqe.html'), 'utf8')).toBe(
      '<a href="../tuning-reference/joins.html">Joins</a>',
    );
  });

  it('preserves a trailing #fragment when appending .html to an extensionless link', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'copy-docs-site-'));
    writeFileSync(path.join(dir, 'index.html'), '<a href="/docs/tuning-reference/joins#broadcast">Broadcast</a>');

    rewriteAbsoluteDocsPaths(dir, dir);

    expect(readFileSync(path.join(dir, 'index.html'), 'utf8')).toBe(
      '<a href="./tuning-reference/joins.html#broadcast">Broadcast</a>',
    );
  });

  it('leaves an unrelated absolute URL that happens to contain "/docs/" untouched', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'copy-docs-site-'));
    const html = '<a href="https://spark.apache.org/docs/latest/tuning.html">Spark tuning</a>';
    writeFileSync(path.join(dir, 'index.html'), html);

    rewriteAbsoluteDocsPaths(dir, dir);

    expect(readFileSync(path.join(dir, 'index.html'), 'utf8')).toBe(html);
  });

  // VitePress bakes literal absolute `/docs/...` strings into per-page JS
  // chunks too (e.g. a dark/light diagram-swap for tuning-reference/aqe.md),
  // not just HTML/CSS — confirmed against a real DOCS_MPA=1 build. Opened
  // under `file://` in dark theme, the unrewritten path resolves against the
  // filesystem root instead of the export folder: broken image.
  it('rewrites an absolute /docs/ string literal inside a JS chunk', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'copy-docs-site-'));
    mkdirSync(path.join(dir, 'assets'));
    writeFileSync(
      path.join(dir, 'assets', 'tuning-reference_aqe.md.abc123.js'),
      'const n="/docs/assets/aqe-loop.abc123.svg", r="/docs/assets/aqe-loop.dark.abc123.svg";',
    );

    rewriteAbsoluteDocsPaths(dir, dir);

    expect(readFileSync(path.join(dir, 'assets', 'tuning-reference_aqe.md.abc123.js'), 'utf8')).toBe(
      'const n="../assets/aqe-loop.abc123.svg", r="../assets/aqe-loop.dark.abc123.svg";',
    );
  });

  // Same-depth-directory case (0 depth here) so the relative prefix is "./",
  // exercising the JS rewrite alongside the top-level depth logic already
  // covered for HTML/CSS above.
  it('rewrites an absolute /docs/ string literal inside a top-level JS chunk', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'copy-docs-site-'));
    writeFileSync(path.join(dir, 'app.abc123.js'), 'const logo="/docs/assets/logo.svg";');

    rewriteAbsoluteDocsPaths(dir, dir);

    expect(readFileSync(path.join(dir, 'app.abc123.js'), 'utf8')).toBe('const logo="./assets/logo.svg";');
  });

  // A directory-style link (trailing slash) carrying only a `#fragment` and
  // no other path segment must still resolve to that directory's
  // index.html, not to a bare ".html#fragment" (which 404s under `file://`).
  it('appends index.html before a bare "#fragment" on the docs root link', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'copy-docs-site-'));
    writeFileSync(path.join(dir, 'index.html'), '<a href="/docs/#top">Top</a>');

    rewriteAbsoluteDocsPaths(dir, dir);

    expect(readFileSync(path.join(dir, 'index.html'), 'utf8')).toBe('<a href="./index.html#top">Top</a>');
  });

  it('appends index.html before a "#fragment" on a nested directory-style link', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'copy-docs-site-'));
    writeFileSync(path.join(dir, 'index.html'), '<a href="/docs/tuning-reference/#section">Tuning</a>');

    rewriteAbsoluteDocsPaths(dir, dir);

    expect(readFileSync(path.join(dir, 'index.html'), 'utf8')).toBe(
      '<a href="./tuning-reference/index.html#section">Tuning</a>',
    );
  });
});

// A prior version only escaped `/` (`prefix.replace(/\//g, '\\/')`), leaving
// every other regex metacharacter live. That is fine for today's literal
// '/docs/' prefix, but breaks the moment a prefix contains one: an unescaped
// '.' would match any character instead of a literal dot, corrupting the
// rewrite for unrelated content that merely resembles the prefix.
describe('escapeRegExp', () => {
  it('escapes regex metacharacters beyond "/", not just slashes', () => {
    const escaped = escapeRegExp('/do.s/');
    const pattern = new RegExp(`^${escaped}$`);

    expect(pattern.test('/do.s/')).toBe(true);
    expect(pattern.test('/doXs/')).toBe(false);
  });
});
