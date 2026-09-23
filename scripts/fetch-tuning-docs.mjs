// Generates packages/core/src/docs-content/{chapters,tuning,diagrams} (all
// gitignored) from the upstream tuning reference
// (shuffle-works/spark-tuning-reference) at the commit pinned in
// docs-content/upstream.json: vendors its Markdown source and content/diagrams/
// SVGs directly (no submodule) and lets VitePress render.
//
//   npm run docs:fetch              make docs-content/ match the pin: fetch only
//                                   when the stamp says it doesn't, then validate
//   npm run docs:fetch -- --allow-stale
//                                   same, but keep a stale cached copy (with a
//                                   warning) if the fetch fails; docs:dev uses it
//   npm run docs:bump [-- <sha>]    move the pin to <sha> (default: upstream's
//                                   default-branch head), regenerate, and write
//                                   a changeset
//   npm run docs:bump -- --check [<sha>]
//                                   run the anchor gate against <sha> (default:
//                                   upstream head) and print the compare link,
//                                   writing nothing (weekly drift workflow)
//
// ensureTuningDocs() below is the one entry point every consumer calls:
// docs:dev/docs:build (package.json), vendor-core.mjs (every npm pack),
// the root and packages/core vitest globalSetup, and doc-anchor-coverage.js.
// It is idempotent: a stamp (docs-content/.generated.json) records the commit
// and transform the cached copy came from, so a matching cache costs no
// network. It always re-validates the copy in place against every docs anchor
// the app links to, so a new docAnchor without upstream content fails the next
// test run or build even with a warm cache.
//
// Requires `git`: upstream is public, so the pinned commit is fetched
// anonymously over HTTPS. A fetched tree is validated before it replaces the
// cache, so a bad commit never clobbers good docs. Set
// SPARK_TUNING_REFERENCE_DIR to a local spark-tuning-reference checkout to
// build from it instead (offline, or to preview upstream edits); strict mode
// (CI, npm pack) accepts that only when the checkout sits cleanly at the pin.
//
// Also projects the manifest into nav-index.json (projectNavIndex below),
// consumed by the docs-site sidebar, the MCP tools and doc-anchor-coverage.

import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { KNOWN_DOC_ANCHORS, tuningDocSlugForAnchor } from '../packages/core/src/docs-config.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// The browser view (src/) and the shared core (packages/core/src/, where the
// detectors, docs-config.ts and the MCP tools live) both link to docs anchors.
const ANCHOR_SCAN_DIRS = [join(REPO_ROOT, 'src'), join(REPO_ROOT, 'packages', 'core', 'src')];
export const DOCS_CONTENT_DIR = join(REPO_ROOT, 'packages', 'core', 'src', 'docs-content');
// The docs-content/ subdirectories generated from upstream. detection/ is not
// one of them: it's generated from this repo's own findings guide.
const GENERATED_DIRS = ['chapters', 'tuning', 'diagrams'];
const STAMP_NAME = '.generated.json';
// Inside docs-content/ so the swap is a same-filesystem rename. Each process
// renders into its own <pid> subdirectory.
const STAGING_NAME = '.fetch-staging';
const LOCK_NAME = '.fetch.lock';
// docs-content/ entries that describe this checkout's cache, not the docs:
// vendor-core.mjs leaves them out of every published tarball. That includes
// the <lock>.<pid> file reclaimDeadLock moves a dead lock to.
const LOCAL_ONLY_ENTRIES = new Set([STAMP_NAME, STAGING_NAME, LOCK_NAME]);
export function isLocalOnlyEntry(name) {
  return LOCAL_ONLY_ENTRIES.has(name) || name.startsWith(`${LOCK_NAME}.`);
}
// Bump whenever renderDocsContent's output changes for the same upstream
// commit (filters, normalization, nav-index shape), so existing caches
// regenerate instead of passing as fresh.
export const TRANSFORM_VERSION = 1;
export const OVERRIDE_ENV = 'SPARK_TUNING_REFERENCE_DIR';
const CHANGESET_PACKAGES = ['sparkforensics', 'sparkforensics-cli', 'sparkforensics-mcp', 'sparkforensics-server'];
const GIT_TIMEOUT_MS = 120_000;
// Longer than a worst-case fetch (two attempts at GIT_TIMEOUT_MS), so a
// waiter outlasts a slow holder rather than failing beside it.
const LOCK_WAIT_MS = 5 * 60_000;
const LOCK_POLL_MS = 200;

// Thrown rather than calling process.exit() directly, so the caller's
// try/finally (temp dir and lock cleanup) still runs before the process exits.
export class DieError extends Error {}
// A network or upstream-availability failure: the one kind a stale cache may
// paper over (allowStale). A fetched tree failing the gate is not one.
class FetchError extends DieError {}

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

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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

// Projects a parsed content manifest into the generated nav index consumed by
// the render step, the docs-site sidebar, and doc-anchor-coverage. `store`/
// `slug` locate each entry's generated markdown.
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

// Upstream stores many files with CRLF; normalize so the generated copy (and
// the pages and MCP payloads built from it) stays LF-only on every platform.
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

// True when a cache stamp (parsed .generated.json, or null) describes exactly
// the copy `want` asks for. Nothing involving a checkout with uncommitted
// content/ edits counts as fresh, on either side: the edits may have moved on.
export function stampIsFresh(stamp, want) {
  if (!stamp || stamp.dirty || want.dirty) return false;
  return ['source', 'commit', 'dir', 'transformVersion'].every((k) => stamp[k] === want[k]);
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

function docsPaths(docsContentDir) {
  return {
    root: docsContentDir,
    pin: join(docsContentDir, 'upstream.json'),
    stamp: join(docsContentDir, STAMP_NAME),
    stagingRoot: join(docsContentDir, STAGING_NAME),
    staging: join(docsContentDir, STAGING_NAME, String(process.pid)),
    lock: join(docsContentDir, LOCK_NAME),
    navIndex: join(docsContentDir, 'chapters', 'nav-index.json'),
  };
}

function readPin(pinFile) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(pinFile, 'utf8'));
  } catch (err) {
    die(`can't read ${relative(REPO_ROOT, pinFile)}: ${err.message}`);
  }
  try {
    return parsePin(raw);
  } catch (err) {
    die(err.message);
  }
}

function readStamp(stampFile) {
  try {
    return JSON.parse(readFileSync(stampFile, 'utf8'));
  } catch {
    return null;
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
    throw new FetchError(
      `fetch of ${commit} from ${repository} failed (network down, or the commit is gone upstream?):\n` +
        `${String(lastErr.stderr || lastErr.message).trim()}`,
    );
  }
  git(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', 'FETCH_HEAD'], dir);
  const head = git(['rev-parse', 'HEAD'], dir);
  if (head !== commit) die(`fetched ${head}, expected ${commit}`);
}

// Every `{#id}` heading attr across the .md files directly inside dirs.
function headingIds(dirs) {
  const ids = new Set();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/\{#([^}\s]+)\}/g)) ids.add(m[1]);
    }
  }
  return ids;
}

// Lists what a docs tree lacks that the app links to: an anchor that is
// neither a page anchor nor a `{#anchor}` heading attr, a tuning doc a
// '#bottleneck-*' anchor resolves to, or the diagrams directory. Both layouts
// go through it: an upstream checkout before it's rendered, and the generated
// copy on every call.
function treeProblems({ pageAnchors, markdownDirs, tuningDir, diagramsDir }, anchors) {
  const ids = headingIds(markdownDirs);
  const problems = anchors.filter((a) => !pageAnchors.has(a) && !ids.has(a)).map((a) => `missing anchor #${a}`);
  if (!existsSync(tuningDir)) {
    problems.push(`no ${basename(tuningDir)}/ directory`);
  } else {
    for (const slug of requiredTuningSlugs(anchors)) {
      if (!existsSync(join(tuningDir, `${slug}.md`))) problems.push(`missing tuning doc ${basename(tuningDir)}/${slug}.md`);
    }
  }
  if (!existsSync(diagramsDir)) problems.push(`no ${basename(diagramsDir)}/ directory (the chapters reference its SVGs)`);
  return problems;
}

// Throws before anything is written if an upstream checkout (a fresh fetch or
// the override dir) lacks an anchor or a tuning doc the app links to. Returns
// the parsed manifest.
function validateUpstreamTree(upstreamDir, anchors, label) {
  const content = join(upstreamDir, 'content');
  const manifestPath = join(content, 'manifest.yaml');
  if (!existsSync(manifestPath)) die(`${label} has no content/manifest.yaml; did upstream move its Markdown source?`);
  const manifest = loadYaml(readFileSync(manifestPath, 'utf8'));
  const problems = treeProblems(
    {
      pageAnchors: new Set(manifest.groups.flatMap((g) => g.entries.map((e) => e.anchor))),
      markdownDirs: [content, join(content, 'bottlenecks')],
      tuningDir: join(content, 'bottlenecks'),
      diagramsDir: join(content, 'diagrams'),
    },
    anchors,
  );
  if (problems.length) {
    die(`${label} fails the docs gate (${problems.length} problem(s)): NOT replacing docs-content/\n  ${problems.join('\n  ')}`);
  }
  return manifest;
}

// Re-validates the generated copy in place, with no network.
function validateGenerated(paths, anchors, commitLabel) {
  if (!existsSync(paths.navIndex)) die(`no generated ${relative(REPO_ROOT, paths.navIndex)}`);
  const nav = JSON.parse(readFileSync(paths.navIndex, 'utf8'));
  const problems = treeProblems(
    {
      pageAnchors: new Set(nav.map((e) => e.anchor)),
      markdownDirs: [join(paths.root, 'chapters'), join(paths.root, 'tuning')],
      tuningDir: join(paths.root, 'tuning'),
      diagramsDir: join(paths.root, 'diagrams'),
    },
    anchors,
  );
  if (problems.length) {
    die(
      `the tuning reference at ${commitLabel} lacks ${problems.length} thing(s) the app links to; add them upstream ` +
        'and `npm run docs:bump`, or drop the link:\n  ' +
        problems.join('\n  '),
    );
  }
}

// Copies every file under srcDir that keep(relative path) accepts into
// destDir, EOL-normalized. Only text is vendored (vendor-core.mjs reads every
// vendored file as UTF-8), and a directory is created only when a file lands
// in it.
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

// Writes GENERATED_DIRS into outDir from a validated upstream tree.
function renderDocsContent(upstreamDir, sparkManifest, outDir) {
  const content = join(upstreamDir, 'content');
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

// Renders a validated upstream tree into staging, then replaces
// GENERATED_DIRS with it. The stamp goes first and comes back last, so an
// interrupted swap leaves no stamp and the next call regenerates. Caller holds
// the lock.
function writeGenerated(paths, upstreamDir, manifest, stamp) {
  rmSync(paths.staging, { recursive: true, force: true });
  try {
    renderDocsContent(upstreamDir, manifest, paths.staging);
    rmSync(paths.stamp, { force: true });
    for (const d of GENERATED_DIRS) {
      rmSync(join(paths.root, d), { recursive: true, force: true });
      if (existsSync(join(paths.staging, d))) renameSync(join(paths.staging, d), join(paths.root, d));
    }
    writeFileSync(paths.stamp, JSON.stringify(stamp, null, 2) + '\n');
  } finally {
    rmSync(paths.staging, { recursive: true, force: true });
    try {
      rmdirSync(paths.stagingRoot);
    } catch (err) {
      if (err.code !== 'ENOTEMPTY' && err.code !== 'ENOENT') throw err;
    }
  }
}

function lockHolder(lockFile) {
  try {
    const pid = Number.parseInt(readFileSync(lockFile, 'utf8'), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// Moves a dead holder's lock aside before deleting it, so two waiters that saw
// the same dead pid can't delete each other's fresh lock. If the moved file
// turns out to be a newer lock, it is linked back (never over a third one).
function reclaimDeadLock(lockFile, deadPid) {
  const aside = `${lockFile}.${process.pid}`;
  try {
    renameSync(lockFile, aside);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  try {
    if (lockHolder(aside) !== deadPid) linkSync(aside, lockFile);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  } finally {
    rmSync(aside, { force: true });
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Exclusive lock (O_EXCL) holding the owner's pid, so two writers can't
// interleave their swaps. Several vitest processes (root and packages/core)
// reach this at once, so a busy lock is waited on, not an error: the waiter
// usually finds the holder already wrote the copy it wanted. A lock whose pid
// is gone (a killed run) is reclaimed. Exported for its unit test.
export function withLock(lockFile, fn, { timeoutMs = LOCK_WAIT_MS, pollMs = LOCK_POLL_MS, log = console.log } = {}) {
  const deadline = Date.now() + timeoutMs;
  let fd;
  let announced = false;
  for (;;) {
    try {
      fd = openSync(lockFile, 'wx');
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    // null: the holder created the file but hasn't written its pid yet.
    const holder = lockHolder(lockFile);
    if (holder !== null && !processAlive(holder)) {
      reclaimDeadLock(lockFile, holder);
      continue;
    }
    if (Date.now() >= deadline) {
      die(
        `gave up after ${Math.round(timeoutMs / 1000)}s waiting for ${relative(REPO_ROOT, lockFile)} ` +
          `(held by pid ${holder ?? 'unknown'}); delete it if that run is gone`,
      );
    }
    if (!announced) {
      log(`fetch-tuning-docs: waiting for another fetch (pid ${holder ?? 'unknown'}) to finish ...`);
      announced = true;
    }
    sleepSync(pollMs);
  }
  try {
    writeSync(fd, String(process.pid));
    return fn();
  } finally {
    closeSync(fd);
    rmSync(lockFile, { force: true });
  }
}

// Fetches `commit` into a temp dir, validates it, and hands the tree and its
// manifest to fn; the temp dir goes away afterwards.
function withValidatedFetch(repository, commit, anchors, fn) {
  const tmp = mkdtempSync(join(tmpdir(), 'spark-tuning-reference-'));
  try {
    const cloneDir = join(tmp, 'clone');
    mkdirSync(cloneDir);
    console.log(`fetch-tuning-docs: fetching ${repository} @ ${commit} ...`);
    fetchCommit(repository, commit, cloneDir);
    return fn(cloneDir, validateUpstreamTree(cloneDir, anchors, `${repository} @ ${commit.slice(0, 7)}`));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function requireAnchors() {
  const anchors = collectRequiredAnchors();
  if (anchors.length === 0) die(`no docs anchors found under ${ANCHOR_SCAN_DIRS.join(', ')}; refusing to run blind.`);
  return anchors;
}

// Describes the SPARK_TUNING_REFERENCE_DIR checkout as the stamp its copy
// would carry. Strict mode refuses anything but a clean checkout of the pin,
// so a tarball or CI build can't ship unpinned docs.
function overrideSource(rawDir, pin, strict) {
  const dir = resolve(rawDir);
  if (!existsSync(join(dir, 'content', 'manifest.yaml'))) {
    die(`${OVERRIDE_ENV}=${rawDir} has no content/manifest.yaml; point it at a spark-tuning-reference checkout`);
  }
  let commit = null;
  let dirty = true;
  try {
    // Only the checkout's own HEAD counts, not an enclosing repo's.
    if (realpathSync(git(['rev-parse', '--show-toplevel'], dir)) === realpathSync(dir)) {
      commit = git(['rev-parse', 'HEAD'], dir);
      dirty = git(['status', '--porcelain', '--', 'content'], dir) !== '';
    }
  } catch {
    // Not a git checkout: usable outside strict mode, never fresh.
  }
  if (strict && (commit !== pin.commit || dirty)) {
    const at = commit ? `${commit}${dirty ? ' with uncommitted content/ changes' : ''}` : 'no git HEAD';
    die(
      `${OVERRIDE_ENV} checkout is at ${at}, but the pin is ${pin.commit}. Strict mode (CI, npm pack) builds only ` +
        `the pinned docs: check out the pin there, or unset ${OVERRIDE_ENV}.`,
    );
  }
  return { dir, stamp: { source: 'local', dir, commit, dirty, transformVersion: TRANSFORM_VERSION } };
}

// Makes docs-content/{chapters,tuning,diagrams} match the pin (or the
// SPARK_TUNING_REFERENCE_DIR checkout), then validates the copy in place.
//   allowStale: if the fetch fails, keep an existing cached copy (warning
//               that it isn't the pin) instead of failing. Local dev only.
//   strict:     the override must be a clean checkout of the pin. For npm
//               pack.
// CI (the CI env var) forces strict and disables allowStale. The remaining
// options exist for tests. Returns the stamp of the copy in place ({ source,
// commit, dir? }) plus whether this call wrote it and whether it is a stale
// copy kept by allowStale.
export function ensureTuningDocs({
  allowStale = false,
  strict = false,
  docsContentDir = DOCS_CONTENT_DIR,
  anchors,
  env = process.env,
  warn = console.warn,
} = {}) {
  if (!have('git')) die('`git` not found: install git to fetch the upstream docs repo.');
  const ci = Boolean(env.CI);
  strict = strict || ci;
  allowStale = allowStale && !ci;
  const paths = docsPaths(docsContentDir);
  const pin = readPin(paths.pin);
  const required = anchors ?? requireAnchors();
  const override = env[OVERRIDE_ENV] ? overrideSource(env[OVERRIDE_ENV], pin, strict) : null;
  const want = override?.stamp ?? { source: 'pin', commit: pin.commit, transformVersion: TRANSFORM_VERSION };
  const isFresh = () => stampIsFresh(readStamp(paths.stamp), want) && existsSync(paths.navIndex);

  let regenerated = false;
  let used = want;
  if (!isFresh()) {
    withLock(paths.lock, () => {
      // Another process may have written it while this one waited on the lock.
      if (isFresh()) return;
      if (override) {
        const manifest = validateUpstreamTree(override.dir, required, `${OVERRIDE_ENV}=${override.dir}`);
        writeGenerated(paths, override.dir, manifest, want);
        regenerated = true;
        return;
      }
      try {
        withValidatedFetch(pin.repository, pin.commit, required, (cloneDir, manifest) =>
          writeGenerated(paths, cloneDir, manifest, want),
        );
        regenerated = true;
      } catch (err) {
        if (!(err instanceof FetchError)) throw err;
        const cached = existsSync(paths.navIndex) ? readStamp(paths.stamp) : null;
        if (allowStale && cached) {
          used = cached;
          warn(
            `fetch-tuning-docs: ${err.message}\nfetch-tuning-docs: using cached docs for ${cached.commit ?? 'an unknown commit'}` +
              `${cached.source === 'local' ? ` from ${cached.dir}` : ''}, pin is ${pin.commit}`,
          );
          return;
        }
        const why = cached
          ? `The cached copy is for ${cached.commit ?? 'an unknown commit'}, and only docs:dev and local test runs ` +
            'may fall back to a stale copy.'
          : `No cached copy of ${pin.commit}.`;
        throw new FetchError(
          `${err.message}\n${why} To build offline, set ${OVERRIDE_ENV} to a local spark-tuning-reference checkout.`,
        );
      }
    });
  }
  validateGenerated(paths, required, `${(used.commit ?? 'no commit').slice(0, 7)}${used === want ? '' : ' (stale cache)'}`);
  return { source: used.source, commit: used.commit, dir: used.dir, regenerated, stale: used !== want };
}

function runEnsure(allowStale) {
  const { source, commit, dir, regenerated, stale } = ensureTuningDocs({ allowStale });
  const from = `${source === 'local' ? `${dir} at ` : ''}${commit ? commit.slice(0, 7) : 'no git HEAD'}`;
  const state = stale ? 'kept (stale) from' : regenerated ? 'written from' : 'up to date with';
  console.log(`fetch-tuning-docs: docs-content/{${GENERATED_DIRS.join(',')}} ${state} ${from}.`);
}

function runBump(requested) {
  if (!have('git')) die('`git` not found: install git to fetch the upstream docs repo.');
  const paths = docsPaths(DOCS_CONTENT_DIR);
  const { repository, commit: from } = readPin(paths.pin);
  const to = requested ?? resolveUpstreamHead(repository);
  if (to === from) {
    console.log(`fetch-tuning-docs: already pinned to ${to}; nothing to bump (\`npm run docs:fetch\` regenerates).`);
    return;
  }
  const anchors = requireAnchors();
  withLock(paths.lock, () =>
    withValidatedFetch(repository, to, anchors, (cloneDir, manifest) =>
      writeGenerated(paths, cloneDir, manifest, { source: 'pin', commit: to, transformVersion: TRANSFORM_VERSION }),
    ),
  );
  writeFileSync(paths.pin, JSON.stringify({ repository, commit: to }, null, 2) + '\n');
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
  if (!have('git')) die('`git` not found: install git to fetch the upstream docs repo.');
  const { repository, commit: from } = readPin(docsPaths(DOCS_CONTENT_DIR).pin);
  const to = requested ?? resolveUpstreamHead(repository);
  if (to === from) {
    console.log(`fetch-tuning-docs: upstream head is the pin ${to.slice(0, 7)}; no drift.`);
    return;
  }
  const anchors = requireAnchors();
  let gatePassed = true;
  try {
    withValidatedFetch(repository, to, anchors, () => {});
  } catch (err) {
    if (!(err instanceof DieError)) throw err;
    console.error(`fetch-tuning-docs: ${err.message}`);
    gatePassed = false;
  }
  console.log(driftReport(repository, from, to, gatePassed, process.env.GITHUB_ACTIONS === 'true'));
  if (!gatePassed) process.exitCode = 1;
}

function main(args) {
  const [first, ...rest] = args;
  if (first === undefined) return runEnsure(false);
  if (first === '--allow-stale' && rest.length === 0) return runEnsure(true);
  if (first === 'bump') {
    let parsed;
    try {
      parsed = parseBumpArgs(rest);
    } catch (err) {
      die(err.message);
    }
    return parsed.check ? runBumpCheck(parsed.sha) : runBump(parsed.sha);
  }
  die(`usage: fetch-tuning-docs.mjs [--allow-stale | bump [--check] [<sha>]], got ${args.join(' ')}`);
}

// Guards main() behind direct execution: vendor-core.mjs, the vitest
// globalSetup and the fetch-tuning-docs-*.test.js files import this module,
// and an unguarded top-level call would run the CLI on every import.
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
