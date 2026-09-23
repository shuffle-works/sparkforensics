// Writes the committed docs corpus (packages/core/src/docs-content/) from the
// upstream tuning reference (shuffle-works/spark-tuning-reference) at the
// commit pinned in docs-content/upstream.json: vendors its Markdown source and
// content/diagrams/ SVGs directly (no submodule) and lets VitePress render.
//
//   npm run docs:fetch              regenerate the committed copy from the pin
//   npm run docs:fetch -- --check   fail unless the pin reproduces the committed
//                                   copy byte for byte (CI drift guard)
//   npm run docs:bump [-- <sha>]    move the pin to <sha> (default: upstream's
//                                   default-branch head), regenerate, and write
//                                   a changeset
//   npm run docs:bump -- --check [<sha>]
//                                   run the anchor gate against <sha> (default:
//                                   upstream head) and print the compare link,
//                                   writing nothing (weekly drift workflow)
//
// Requires `git`: upstream is public, so the pinned commit is fetched
// anonymously over HTTPS. Every mode first validates the fetched tree contains
// every docs anchor the app links to (manifest page anchor or `{#anchor}`
// heading attr); a missing anchor aborts before anything under docs-content/
// changes.
//
// Also projects the manifest into a committed nav-index.json (projectNavIndex
// below), consumed by the docs-site sidebar and doc-anchor-coverage.

import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { KNOWN_DOC_ANCHORS, tuningDocSlugForAnchor } from '../packages/core/src/docs-config.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// The browser view (src/) and the shared core (packages/core/src/, where the
// detectors, docs-config.ts and the MCP tools live) both link to docs anchors.
const ANCHOR_SCAN_DIRS = [join(REPO_ROOT, 'src'), join(REPO_ROOT, 'packages', 'core', 'src')];
const DOCS_CONTENT_DIR = join(REPO_ROOT, 'packages', 'core', 'src', 'docs-content');
const PIN_FILE = join(DOCS_CONTENT_DIR, 'upstream.json');
// The docs-content/ subdirectories generated from upstream. detection/ is not
// one of them: it's generated from this repo's own findings guide.
const GENERATED_DIRS = ['chapters', 'tuning', 'diagrams'];
// Inside docs-content/ so the swap is a same-filesystem rename.
const STAGING_DIR = join(DOCS_CONTENT_DIR, '.fetch-staging');
const LOCK_FILE = join(DOCS_CONTENT_DIR, '.fetch.lock');
const CHANGESET_PACKAGES = ['sparkforensics', 'sparkforensics-cli', 'sparkforensics-mcp', 'sparkforensics-server'];
const GIT_TIMEOUT_MS = 120_000;

// Thrown rather than calling process.exit() directly, so the caller's
// try/finally (temp dir and lock cleanup) still runs before the process exits.
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

// Validates parsed upstream.json: an HTTPS git URL and a full 40-character
// commit SHA (a short SHA can't be fetched by id, and a branch name isn't
// reproducible). Returns the pin; throws on anything else.
export function parsePin(pin) {
  if (!pin || typeof pin !== 'object') throw new Error('upstream.json must be a JSON object');
  const { repository, commit } = pin;
  if (typeof repository !== 'string' || !/^https:\/\/\S+\.git$/.test(repository)) {
    throw new Error(`upstream.json "repository" must be an https:// git URL ending in .git, got ${JSON.stringify(repository)}`);
  }
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`upstream.json "commit" must be a full 40-character lowercase SHA, got ${JSON.stringify(commit)}`);
  }
  return { repository, commit };
}

// Upstream stores many files with CRLF; this repo's `.gitattributes`
// (`* text=auto eol=lf`) would normalize them on commit anyway, so normalize
// up front and the generated copy matches what git stores byte for byte.
export function normalizeEol(text) {
  return text.replace(/\r\n/g, '\n');
}

export function compareUrl(repository, fromCommit, toCommit) {
  return `${repository.replace(/\.git$/, '')}/compare/${fromCommit}...${toCommit}`;
}

// Parses `bump`'s arguments: an optional `--check` and an optional full SHA,
// in either order. Throws on anything else.
export function parseBumpArgs(args) {
  const positional = args.filter((a) => a !== '--check');
  const checkFlags = args.length - positional.length;
  if (checkFlags > 1 || positional.length > 1) {
    throw new Error(`usage: fetch-tuning-docs.mjs bump [--check] [<sha>], got bump ${args.join(' ')}`);
  }
  const [sha] = positional;
  if (sha !== undefined && !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`bump takes a full 40-character lowercase commit SHA, got ${JSON.stringify(sha)}`);
  }
  return { check: checkFlags === 1, sha };
}

// The one-line result `bump --check` prints once upstream has moved past the
// pin. Under GitHub Actions it's prefixed as a workflow annotation, so the
// result and the compare link show on the run's summary page.
export function driftReport(repository, fromCommit, toCommit, gatePassed, annotate = false) {
  const url = compareUrl(repository, fromCommit, toCommit);
  const text = gatePassed
    ? `upstream ${toCommit.slice(0, 7)} differs from the pin ${fromCommit.slice(0, 7)} and passes the anchor gate; \`npm run docs:bump\` is safe: ${url}`
    : `upstream ${toCommit.slice(0, 7)} fails the anchor gate, so a bump from ${fromCommit.slice(0, 7)} would break: ${url}`;
  if (!annotate) return text;
  return `::${gatePassed ? 'notice' : 'error'} title=Tuning reference drift::${text}`;
}

// The changeset a bump writes: every published package ships the vendored docs.
export function bumpChangeset(repository, fromCommit, toCommit) {
  const name = basename(repository).replace(/\.git$/, '');
  return (
    '---\n' +
    CHANGESET_PACKAGES.map((p) => `"${p}": patch\n`).join('') +
    '---\n\n' +
    `Tuning reference refreshed to ${name}@${toCommit.slice(0, 7)} (${compareUrl(repository, fromCommit, toCommit)}).\n`
  );
}

function git(args, cwd) {
  // GIT_TERMINAL_PROMPT=0: if the repo ever moves or stops being public, fail
  // at once instead of hanging on a credentials prompt.
  return execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function readPin() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(PIN_FILE, 'utf8'));
  } catch (err) {
    die(`can't read ${relative(REPO_ROOT, PIN_FILE)}: ${err.message}`);
  }
  try {
    return parsePin(raw);
  } catch (err) {
    die(err.message);
  }
}

// Default-branch head, resolved without an API token.
function resolveUpstreamHead(repository) {
  let out;
  try {
    out = git(['ls-remote', repository, 'HEAD']);
  } catch (err) {
    die(`git ls-remote ${repository} failed (network down, or the repo moved?):\n${err.stderr || err.message}`);
  }
  const sha = out.split(/\s/)[0];
  if (!/^[0-9a-f]{40}$/.test(sha)) die(`git ls-remote ${repository} HEAD returned no commit`);
  return sha;
}

// A fresh `git init` plus a depth-1 fetch of the exact commit: no history, no
// branch to drift, and the enclosing checkout's credential config isn't used.
// Retries once, so a single network blip doesn't fail CI.
function fetchCommit(repository, commit, dir) {
  git(['init', '--quiet'], dir);
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      git(['fetch', '--quiet', '--depth=1', repository, commit], dir);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) {
    die(`fetch of ${commit} from ${repository} failed (network down, or the commit is gone upstream?):\n${lastErr.stderr || lastErr.message}`);
  }
  git(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', 'FETCH_HEAD'], dir);
  const head = git(['rev-parse', 'HEAD'], dir);
  if (head !== commit) die(`fetched ${head}, expected ${commit}`);
}

// Throws before anything is written if the fetched tree lacks an anchor or a
// tuning doc the app links to. Returns the parsed manifest.
function validateClone(cloneDir, anchors) {
  const manifestPath = join(cloneDir, 'content', 'manifest.yaml');
  if (!existsSync(manifestPath)) die('fetched tree has no content/manifest.yaml; did upstream move its Markdown source?');
  const sparkManifest = loadYaml(readFileSync(manifestPath, 'utf8'));
  const manifestAnchors = new Set(sparkManifest.groups.flatMap((g) => g.entries.map((e) => e.anchor)));
  const missing = anchors.filter((a) => !anchorPresentInMarkdown(cloneDir, manifestAnchors, a));
  if (missing.length) {
    die(
      `fetched docs are missing ${missing.length} anchor(s) the app links to: NOT overwriting committed docs\n  ` +
        missing.map((a) => `#${a}`).join('\n  '),
    );
  }

  const bottlenecksDir = join(cloneDir, 'content', 'bottlenecks');
  if (!existsSync(bottlenecksDir)) {
    die('fetched tree has no content/bottlenecks/ directory; is upstream still committing its Markdown source there?');
  }
  const missingTuning = requiredTuningSlugs(anchors).filter((slug) => !existsSync(join(bottlenecksDir, `${slug}.md`)));
  if (missingTuning.length) {
    die(
      `fetched docs are missing ${missingTuning.length} tuning doc(s) the app needs: NOT overwriting committed docs ` +
        `(content/bottlenecks/ may be stale):\n  ` +
        missingTuning.map((s) => `content/bottlenecks/${s}.md`).join('\n  '),
    );
  }
  if (!existsSync(join(cloneDir, 'content', 'diagrams'))) {
    die('fetched tree has no content/diagrams/ directory; the chapters reference its SVGs');
  }
  return sparkManifest;
}

// Copies every file under srcDir that keep(relative path) accepts into
// destDir, EOL-normalized. Only text is vendored (vendor-core.mjs reads every
// vendored file as UTF-8), and a directory is created only when a file lands
// in it, so no empty directories show up in a byte-for-byte comparison.
function copyNormalized(srcDir, destDir, keep, rel = '') {
  for (const entry of readdirSync(join(srcDir, rel), { withFileTypes: true })) {
    const relPath = rel ? join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      copyNormalized(srcDir, destDir, keep, relPath);
    } else if (keep(relPath)) {
      const dest = join(destDir, relPath);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, normalizeEol(readFileSync(join(srcDir, relPath), 'utf8')));
    }
  }
}

// Writes GENERATED_DIRS into outDir from a validated clone.
function renderDocsContent(cloneDir, sparkManifest, outDir) {
  const content = join(cloneDir, 'content');
  // Top-level chapters -> chapters/ (bottlenecks and meta handled elsewhere or
  // not vendored at all).
  const isChapterFile = (p) => {
    const top = p.split(/[\\/]/)[0];
    return top !== 'bottlenecks' && top !== 'meta' && p.endsWith('.md');
  };
  copyNormalized(content, join(outDir, 'chapters'), isChapterFile);
  // Bottleneck tuning docs -> tuning/.
  copyNormalized(join(content, 'bottlenecks'), join(outDir, 'tuning'), (p) => p.endsWith('.md'));
  // Diagram SVGs -> diagrams/ (shared by chapters and tuning docs;
  // build-tuning-reference.mjs rewrites both reference forms). content/diagrams/
  // also carries .mmd sources we never serve.
  copyNormalized(join(content, 'diagrams'), join(outDir, 'diagrams'), (p) => p.endsWith('.svg'));
  writeFileSync(join(outDir, 'chapters', 'nav-index.json'), JSON.stringify(projectNavIndex(sparkManifest), null, 2) + '\n');
}

function listFiles(dir, rel = '') {
  if (!existsSync(join(dir, rel))) return [];
  const out = [];
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const relPath = rel ? join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(dir, relPath));
    else out.push(relPath);
  }
  return out;
}

// Returns human-readable differences between two generated trees, empty when
// they match byte for byte.
function diffTrees(expectedDir, actualDir) {
  const expected = new Set(GENERATED_DIRS.flatMap((d) => listFiles(expectedDir, d)));
  const actual = new Set(GENERATED_DIRS.flatMap((d) => listFiles(actualDir, d)));
  const diffs = [];
  for (const p of [...new Set([...expected, ...actual])].sort()) {
    if (!actual.has(p)) diffs.push(`missing: ${p}`);
    else if (!expected.has(p)) diffs.push(`not upstream: ${p}`);
    else if (!readFileSync(join(expectedDir, p)).equals(readFileSync(join(actualDir, p)))) diffs.push(`differs: ${p}`);
  }
  return diffs;
}

// Replaces GENERATED_DIRS in docs-content/ with the staged ones. Everything
// was validated and fully rendered before this runs.
function swapInStaged() {
  for (const d of GENERATED_DIRS) {
    rmSync(join(DOCS_CONTENT_DIR, d), { recursive: true, force: true });
    if (existsSync(join(STAGING_DIR, d))) renameSync(join(STAGING_DIR, d), join(DOCS_CONTENT_DIR, d));
  }
}

// Exclusive lock (O_EXCL), so two writers can't interleave their swaps.
function withLock(fn) {
  let fd;
  try {
    fd = openSync(LOCK_FILE, 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') {
      die(`${relative(REPO_ROOT, LOCK_FILE)} exists: another fetch is running (delete it if a run was killed)`);
    }
    throw err;
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    rmSync(LOCK_FILE, { force: true });
  }
}

// Fetches and validates `commit`, then hands the clone and manifest to fn.
function withValidatedClone(repository, commit, fn) {
  const anchors = collectRequiredAnchors();
  if (anchors.length === 0) die(`no docs anchors found under ${ANCHOR_SCAN_DIRS.join(', ')}; refusing to run blind.`);
  const tmp = mkdtempSync(join(tmpdir(), 'spark-tuning-reference-'));
  try {
    const cloneDir = join(tmp, 'clone');
    mkdirSync(cloneDir);
    console.log(`fetch-tuning-docs: fetching ${repository} @ ${commit} ...`);
    fetchCommit(repository, commit, cloneDir);
    return fn(cloneDir, validateClone(cloneDir, anchors), tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function writeFromClone(cloneDir, sparkManifest) {
  withLock(() => {
    rmSync(STAGING_DIR, { recursive: true, force: true });
    try {
      renderDocsContent(cloneDir, sparkManifest, STAGING_DIR);
      swapInStaged();
    } finally {
      rmSync(STAGING_DIR, { recursive: true, force: true });
    }
  });
}

function runWrite() {
  const { repository, commit } = readPin();
  withValidatedClone(repository, commit, (cloneDir, manifest) => writeFromClone(cloneDir, manifest));
  console.log(`fetch-tuning-docs: wrote docs-content/{${GENERATED_DIRS.join(',')}} from ${commit.slice(0, 7)}.`);
}

function runCheck() {
  const { repository, commit } = readPin();
  const diffs = withValidatedClone(repository, commit, (cloneDir, manifest, tmp) => {
    const outDir = join(tmp, 'generated');
    renderDocsContent(cloneDir, manifest, outDir);
    return diffTrees(outDir, DOCS_CONTENT_DIR);
  });
  if (diffs.length) {
    die(
      `committed docs-content/ doesn't match the pinned ${commit.slice(0, 7)} (${diffs.length} file(s)); ` +
        'run `npm run docs:fetch` and commit the result, and fix any wanted edit upstream instead:\n  ' +
        diffs.join('\n  '),
    );
  }
  console.log(`fetch-tuning-docs: committed docs-content/ matches ${commit.slice(0, 7)}.`);
}

function runBump(requested) {
  const { repository, commit: from } = readPin();
  const to = requested ?? resolveUpstreamHead(repository);
  if (to === from) {
    console.log(`fetch-tuning-docs: already pinned to ${to}; nothing to bump (\`npm run docs:fetch\` regenerates).`);
    return;
  }
  withValidatedClone(repository, to, (cloneDir, manifest) => writeFromClone(cloneDir, manifest));
  writeFileSync(PIN_FILE, JSON.stringify({ repository, commit: to }, null, 2) + '\n');
  const changesetPath = join(REPO_ROOT, '.changeset', `tuning-reference-${to.slice(0, 7)}.md`);
  writeFileSync(changesetPath, bumpChangeset(repository, from, to));
  console.log(
    `fetch-tuning-docs: pinned ${to}, regenerated docs-content/ and wrote ${relative(REPO_ROOT, changesetPath)}.\n` +
      `Upstream changes for the PR body: ${compareUrl(repository, from, to)}`,
  );
}

// Fetches and gates `requested` (default: upstream head) like a bump would,
// then reports instead of writing: the pin, docs-content/ and .changeset/ are
// untouched. Exits 1 when the gate fails, so the scheduled workflow goes red.
function runBumpCheck(requested) {
  const { repository, commit: from } = readPin();
  const to = requested ?? resolveUpstreamHead(repository);
  if (to === from) {
    console.log(`fetch-tuning-docs: upstream head is the pin ${to.slice(0, 7)}; no drift.`);
    return;
  }
  let gatePassed = true;
  try {
    withValidatedClone(repository, to, () => {});
  } catch (err) {
    if (!(err instanceof DieError)) throw err;
    console.error(`fetch-tuning-docs: ${err.message}`);
    gatePassed = false;
  }
  console.log(driftReport(repository, from, to, gatePassed, process.env.GITHUB_ACTIONS === 'true'));
  if (!gatePassed) process.exitCode = 1;
}

function main(args) {
  if (!have('git')) die('`git` not found: install git to fetch the upstream docs repo.');
  const [first, ...rest] = args;
  if (first === undefined) return runWrite();
  if (first === '--check' && rest.length === 0) return runCheck();
  if (first === 'bump') {
    let parsed;
    try {
      parsed = parseBumpArgs(rest);
    } catch (err) {
      die(err.message);
    }
    return parsed.check ? runBumpCheck(parsed.sha) : runBump(parsed.sha);
  }
  die(`usage: fetch-tuning-docs.mjs [--check | bump [--check] [<sha>]], got ${args.join(' ')}`);
}

// Guards main() behind direct execution: the fetch-tuning-docs-*.test.js
// files import this module for its pure exports alone, and an unguarded
// top-level call would fire a real fetch on every test run.
function isDirectExecution() {
  return process.argv[1] && join(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof DieError)) throw err;
    console.error(`fetch-tuning-docs: ${err.message}`);
    process.exit(1);
  }
}
