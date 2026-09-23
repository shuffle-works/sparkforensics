// Refreshes the committed docs corpus (packages/core/src/docs-content/) from
// upstream (shuffle-works/spark-tuning-reference): vendors its Markdown source
// and content/diagrams/ SVGs directly (no submodule) and lets VitePress render.
//
// Run: npm run update-docs
//
// Requires `git`: upstream is public, so it's cloned anonymously over HTTPS.
// Validates the clone contains every docs anchor the app links to (manifest
// page anchor or `{#anchor}` heading attr) before overwriting the committed
// copy; a missing anchor aborts without touching
// packages/core/src/docs-content/.
//
// Also projects the manifest into a committed nav-index.json (projectNavIndex
// below), consumed by the docs-site sidebar and doc-anchor-coverage.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { KNOWN_DOC_ANCHORS, tuningDocSlugForAnchor } from '../packages/core/src/docs-config.ts';

const SOURCE_REPO = 'shuffle-works/spark-tuning-reference';
const SOURCE_URL = `https://github.com/${SOURCE_REPO}.git`;
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// The browser view (src/) and the shared core (packages/core/src/, where the
// detectors, docs-config.ts and the MCP tools live) both link to docs anchors.
const ANCHOR_SCAN_DIRS = [join(REPO_ROOT, 'src'), join(REPO_ROOT, 'packages', 'core', 'src')];
const CHAPTERS_MD_DIR = join(REPO_ROOT, 'packages', 'core', 'src', 'docs-content', 'chapters');
const TUNING_VENDOR_DIR = join(REPO_ROOT, 'packages', 'core', 'src', 'docs-content', 'tuning');
const DIAGRAMS_VENDOR_DIR = join(REPO_ROOT, 'packages', 'core', 'src', 'docs-content', 'diagrams');

// Thrown rather than calling process.exit() directly, so the caller's
// try/finally (temp clone cleanup) still runs before the process exits.
class DieError extends Error {}

function die(msg) {
  throw new DieError(msg);
}

function have(bin) {
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Collects every anchor the app links to, bare (no '#'), sorted: each
// '#metric-*/#bottleneck-*/#config-*' literal found by scanning scanDirs as
// text, plus every allowlisted anchor (knownAnchors, the gate DocsLink renders
// through, which adds page anchors like '#joins'). The text scan also catches
// a JSX `DocsLink anchor="..."` literal missing from the allowlist. Exported
// (defaults are the real repo) so it's unit-tested without a live clone.
export function collectRequiredAnchors(scanDirs = ANCHOR_SCAN_DIRS, knownAnchors = KNOWN_DOC_ANCHORS) {
  const anchors = new Set([...knownAnchors].map((a) => a.replace(/^#/, '')));
  const re = /#(?:metric|bottleneck|config)-[a-z0-9-]+/g;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(js|ts|tsx)$/.test(entry.name)) {
        const text = readFileSync(p, 'utf8');
        for (const m of text.matchAll(re)) anchors.add(m[0].slice(1));
      }
    }
  };
  for (const dir of scanDirs) walk(dir);
  return [...anchors].sort();
}

// Anchor is satisfied if it's a manifest page anchor or a `{#anchor}` heading
// attr somewhere in the cloned spark markdown corpus (chapters + bottlenecks).
function anchorPresentInMarkdown(cloneDir, manifestAnchors, anchor) {
  if (manifestAnchors.has(anchor)) return true;
  const dirs = [join(cloneDir, 'content'), join(cloneDir, 'content', 'bottlenecks')];
  const re = new RegExp(`\\{#${anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`);
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.md') && re.test(readFileSync(join(dir, f), 'utf8'))) return true;
    }
  }
  return false;
}

// Projects a parsed content manifest into the committed nav index consumed by
// the render step, the docs-site sidebar, and doc-anchor-coverage. `store`/
// `slug` locate each entry's committed markdown.
export function projectNavIndex(manifest) {
  const out = [];
  for (const group of manifest.groups) {
    for (const entry of group.entries) {
      const slug = basename(entry.file).replace(/\.md$/, '');
      const store = entry.file.startsWith('content/bottlenecks/') ? 'tuning' : 'chapters';
      out.push({
        anchor: entry.anchor,
        section: group.title,
        title: entry.title,
        keywords: entry.keywords ?? [],
        store,
        slug,
      });
    }
  }
  return out;
}

// Maps required '#bottleneck-*' anchors to the content/bottlenecks/<slug>.md
// filenames to vendor, via docs-config.ts's tuningDocSlugForAnchor. Exported
// (no filesystem access) so it's unit-tested without a live clone.
export function requiredTuningSlugs(anchors) {
  const slugs = new Set();
  for (const a of anchors) {
    const slug = tuningDocSlugForAnchor(a);
    if (slug) slugs.add(slug);
  }
  return [...slugs].sort();
}

function main() {
  if (!have('git')) die('`git` not found: install git to clone the upstream docs repo.');

  const anchors = collectRequiredAnchors();
  if (anchors.length === 0) die(`no docs anchors found under ${ANCHOR_SCAN_DIRS.join(', ')}; refusing to run blind.`);

  const cloneDir = mkdtempSync(join(tmpdir(), 'spark-tuning-reference-'));
  try {
    console.log(`update-docs: cloning ${SOURCE_URL} (shallow) ...`);
    try {
      // GIT_TERMINAL_PROMPT=0: if the repo ever moves or stops being public,
      // fail at once instead of hanging on a credentials prompt.
      execFileSync('git', ['clone', '--depth=1', '--quiet', SOURCE_URL, cloneDir], {
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: 120_000,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
    } catch (err) {
      die(`clone of ${SOURCE_URL} failed (network down, or the repo moved?):\n${err.stderr || err.message}`);
    }

    const sparkManifest = loadYaml(readFileSync(join(cloneDir, 'content', 'manifest.yaml'), 'utf8'));
    const manifestAnchors = new Set(sparkManifest.groups.flatMap((g) => g.entries.map((e) => e.anchor)));
    const missing = anchors.filter((a) => !anchorPresentInMarkdown(cloneDir, manifestAnchors, a));
    if (missing.length) {
      die(
        `cloned docs are missing ${missing.length} anchor(s) the app links to: NOT overwriting committed docs\n  ` +
          missing.map((a) => `#${a}`).join('\n  '),
      );
    }

    const tuningSlugs = requiredTuningSlugs(anchors);
    const bottlenecksDir = join(cloneDir, 'content', 'bottlenecks');
    if (!existsSync(bottlenecksDir)) {
      die('cloned tree has no content/bottlenecks/ directory; is upstream still committing its Markdown source there?');
    }
    const missingTuning = tuningSlugs.filter((slug) => !existsSync(join(bottlenecksDir, `${slug}.md`)));
    if (missingTuning.length) {
      die(
        `cloned docs are missing ${missingTuning.length} tuning doc(s) the app needs: NOT overwriting committed docs ` +
          `(content/bottlenecks/ may be stale):\n  ` +
          missingTuning.map((s) => `content/bottlenecks/${s}.md`).join('\n  '),
      );
    }

    // All fetched content validated: only now touch the committed docs.

    // Top-level chapters -> docs-content/chapters/ (bottlenecks handled below).
    rmSync(CHAPTERS_MD_DIR, { recursive: true, force: true });
    cpSync(join(cloneDir, 'content'), CHAPTERS_MD_DIR, {
      recursive: true,
      filter: (src) => {
        if (src.includes(`${join('content', 'bottlenecks')}`)) return false;
        if (src.includes(`${join('content', 'meta')}`)) return false;
        return statSync(src).isDirectory() || src.endsWith('.md');
      },
    });

    // Bottleneck tuning docs -> docs-content/tuning/.
    rmSync(TUNING_VENDOR_DIR, { recursive: true, force: true });
    // Filtered to .md only: vendor-core.mjs reads every vendored file as UTF-8,
    // which would corrupt a stray binary if one landed in content/bottlenecks/.
    // Directories pass through so cpSync still recurses.
    cpSync(bottlenecksDir, TUNING_VENDOR_DIR, {
      recursive: true,
      filter: (src) => statSync(src).isDirectory() || src.endsWith('.md'),
    });

    // Diagram SVGs -> docs-content/diagrams/ (shared by chapters and tuning
    // docs; build-tuning-reference.mjs rewrites both reference forms). Filtered
    // to .svg only: content/diagrams/ also carries .mmd sources we never serve.
    const diagramsDir = join(cloneDir, 'content', 'diagrams');
    if (existsSync(diagramsDir)) {
      rmSync(DIAGRAMS_VENDOR_DIR, { recursive: true, force: true });
      cpSync(diagramsDir, DIAGRAMS_VENDOR_DIR, {
        recursive: true,
        filter: (src) => statSync(src).isDirectory() || src.endsWith('.svg'),
      });
    }

    writeFileSync(join(CHAPTERS_MD_DIR, 'nav-index.json'), JSON.stringify(projectNavIndex(sparkManifest), null, 2) + '\n');
    console.log('update-docs: wrote committed markdown + nav-index. Review `git diff` and commit with `chore(docs):`.');
  } finally {
    rmSync(cloneDir, { recursive: true, force: true });
  }
}

// Guards main() behind direct execution: the update-docs-*.test.js files
// import this module for its pure exports alone, and an unguarded top-level
// call would fire a real `git clone` on every test run.
function isDirectExecution() {
  return process.argv[1] && join(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  try {
    main();
  } catch (err) {
    if (!(err instanceof DieError)) throw err;
    console.error(`update-docs: ${err.message}`);
    process.exit(1);
  }
}
