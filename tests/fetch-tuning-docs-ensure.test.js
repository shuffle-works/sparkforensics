import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DieError,
  OVERRIDE_ENV,
  TRANSFORM_VERSION,
  ensureTuningDocs,
  stampIsFresh,
  withLock,
} from '../scripts/fetch-tuning-docs.mjs';

// Nothing listens on port 9, so a fetch from here fails at once: any test that
// would reach the network fails loudly instead of passing by accident.
const UNREACHABLE = 'https://127.0.0.1:9/spark-tuning-reference.git';
const ANCHORS = ['bottleneck-skew', 'joins', 'joins-broadcast'];

function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

// A minimal spark-tuning-reference checkout: one chapter (CRLF, like upstream),
// one bottleneck page, and a diagram with its .mmd source. Returns its HEAD.
function makeUpstream(dir) {
  mkdirSync(join(dir, 'content', 'bottlenecks'), { recursive: true });
  mkdirSync(join(dir, 'content', 'diagrams'));
  writeFileSync(
    join(dir, 'content', 'manifest.yaml'),
    'groups:\n' +
      '  - title: Guide\n    entries:\n      - { anchor: joins, title: Joins, file: content/05-joins.md }\n' +
      '  - title: Detector Catalog\n    entries:\n      - { anchor: bottleneck-skew, title: Skew, file: content/bottlenecks/skew.md }\n',
  );
  writeFileSync(join(dir, 'content', '05-joins.md'), '# Joins\r\n\r\n## Broadcast {#joins-broadcast}\r\n');
  writeFileSync(join(dir, 'content', 'bottlenecks', 'skew.md'), '# Skew\n');
  writeFileSync(join(dir, 'content', 'diagrams', 'a.svg'), '<svg/>\n');
  writeFileSync(join(dir, 'content', 'diagrams', 'a.mmd'), 'graph TD\n');
  git(['init', '--quiet'], dir);
  git(['add', '.'], dir);
  git(['commit', '--quiet', '-m', 'init'], dir);
  return git(['rev-parse', 'HEAD'], dir);
}

describe('ensureTuningDocs', () => {
  let tmp;
  let docsDir;
  let upstreamDir;
  let head;

  const writePin = (commit, repository = UNREACHABLE) =>
    writeFileSync(join(docsDir, 'upstream.json'), JSON.stringify({ repository, commit }));
  const stamp = () => JSON.parse(readFileSync(join(docsDir, '.generated.json'), 'utf8'));
  const ensure = (opts = {}) => ensureTuningDocs({ docsContentDir: docsDir, anchors: ANCHORS, env: {}, ...opts });
  const withOverride = (env = {}) => ({ ...env, [OVERRIDE_ENV]: upstreamDir });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ensure-tuning-docs-'));
    docsDir = join(tmp, 'docs-content');
    upstreamDir = join(tmp, 'upstream');
    mkdirSync(docsDir);
    mkdirSync(upstreamDir);
    head = makeUpstream(upstreamDir);
    writePin(head);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('generates chapters, tuning, diagrams and nav-index from an override checkout, LF-normalized', () => {
    const result = ensure({ env: withOverride() });
    expect(result).toEqual({ source: 'local', commit: head, dir: upstreamDir, regenerated: true, stale: false });
    expect(readFileSync(join(docsDir, 'chapters', '05-joins.md'), 'utf8')).toBe('# Joins\n\n## Broadcast {#joins-broadcast}\n');
    expect(readdirSync(join(docsDir, 'tuning'))).toEqual(['skew.md']);
    expect(readdirSync(join(docsDir, 'diagrams'))).toEqual(['a.svg']);
    const nav = JSON.parse(readFileSync(join(docsDir, 'chapters', 'nav-index.json'), 'utf8'));
    expect(nav.map((e) => [e.anchor, e.store, e.slug])).toEqual([
      ['joins', 'chapters', '05-joins'],
      ['bottleneck-skew', 'tuning', 'skew'],
    ]);
    expect(stamp()).toMatchObject({ source: 'local', commit: head, dirty: false, transformVersion: TRANSFORM_VERSION });
    expect(existsSync(join(docsDir, '.fetch-staging'))).toBe(false);
    expect(existsSync(join(docsDir, '.fetch.lock'))).toBe(false);
  });

  it('skips regenerating a clean override checkout it already rendered', () => {
    ensure({ env: withOverride() });
    expect(ensure({ env: withOverride() }).regenerated).toBe(false);
  });

  it('re-renders an override checkout with uncommitted content/ edits on every call', () => {
    writeFileSync(join(upstreamDir, 'content', 'bottlenecks', 'skew.md'), '# Skew\n\nedited\n');
    ensure({ env: withOverride() });
    writeFileSync(join(upstreamDir, 'content', 'bottlenecks', 'skew.md'), '# Skew\n\nedited again\n');
    expect(ensure({ env: withOverride() }).regenerated).toBe(true);
    expect(readFileSync(join(docsDir, 'tuning', 'skew.md'), 'utf8')).toContain('edited again');
  });

  it('strict mode refuses an override whose HEAD is not the pin, and CI implies strict', () => {
    writePin('0'.repeat(40));
    expect(() => ensure({ env: withOverride(), strict: true })).toThrow(/pin is 0{40}.*Strict mode/s);
    expect(() => ensure({ env: withOverride({ CI: 'true' }) })).toThrow(/Strict mode/);
    expect(existsSync(join(docsDir, 'chapters'))).toBe(false);
  });

  it('strict mode refuses a pinned override with uncommitted content/ edits', () => {
    writeFileSync(join(upstreamDir, 'content', 'bottlenecks', 'skew.md'), '# Skew\n\nedited\n');
    expect(() => ensure({ env: withOverride(), strict: true })).toThrow(/uncommitted content\/ changes/);
  });

  it('strict mode accepts a clean override checkout at the pin', () => {
    expect(ensure({ env: withOverride(), strict: true }).regenerated).toBe(true);
  });

  it('uses a cache stamped with the pin without touching the network', () => {
    ensure({ env: withOverride() });
    // Re-stamp the rendered copy as the pin's own: the pin's repository is
    // unreachable, so reaching for it would throw.
    writeFileSync(join(docsDir, '.generated.json'), JSON.stringify({ source: 'pin', commit: head, transformVersion: TRANSFORM_VERSION }));
    expect(ensure()).toEqual({ source: 'pin', commit: head, dir: undefined, regenerated: false, stale: false });
  });

  it('treats a cache from an older transform as stale', () => {
    ensure({ env: withOverride() });
    writeFileSync(join(docsDir, '.generated.json'), JSON.stringify({ source: 'pin', commit: head, transformVersion: TRANSFORM_VERSION - 1 }));
    expect(() => ensure()).toThrow(/fetch of .* failed/);
  });

  describe('when the pin moved and the fetch fails', () => {
    beforeEach(() => {
      ensure({ env: withOverride() });
      writePin('f'.repeat(40));
    });

    it('fails, naming the pin and the override', () => {
      const err = (() => {
        try {
          ensure();
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(DieError);
      expect(err.message).toMatch(new RegExp(`cached copy is for ${head}, and only docs:dev.*${OVERRIDE_ENV}`, 's'));
    });

    it('keeps the cached copy with a warning when allowStale', () => {
      const warnings = [];
      const result = ensure({ allowStale: true, warn: (m) => warnings.push(m) });
      expect(result).toMatchObject({ source: 'local', commit: head, regenerated: false, stale: true });
      expect(warnings.join('\n')).toMatch(new RegExp(`using cached docs for ${head} from .*, pin is f{40}`));
    });

    it('ignores allowStale under CI', () => {
      expect(() => ensure({ allowStale: true, env: { CI: 'true' } })).toThrow(/cached copy is for/);
    });

    it('fails with no cached copy even when allowStale', () => {
      rmSync(join(docsDir, 'chapters'), { recursive: true });
      expect(() => ensure({ allowStale: true })).toThrow(/No cached copy of f{40}/);
    });
  });

  it('rejects an upstream tree missing a linked anchor and leaves the cache intact', () => {
    ensure({ env: withOverride() });
    writeFileSync(join(upstreamDir, 'content', '05-joins.md'), '# Joins\n');
    expect(() => ensure({ env: withOverride() })).toThrow(/fails the docs gate.*missing anchor #joins-broadcast/s);
    expect(readFileSync(join(docsDir, 'chapters', '05-joins.md'), 'utf8')).toContain('{#joins-broadcast}');
  });

  it('re-validates a warm cache against a newly linked anchor', () => {
    ensure({ env: withOverride() });
    expect(() => ensure({ env: withOverride(), anchors: [...ANCHORS, 'bottleneck-gc'] })).toThrow(
      /missing anchor #bottleneck-gc.*missing tuning doc tuning\/gc\.md/s,
    );
  });
});

describe('stampIsFresh', () => {
  const want = { source: 'pin', commit: 'a'.repeat(40), transformVersion: TRANSFORM_VERSION };

  it('matches source, commit, dir and transform version', () => {
    expect(stampIsFresh({ ...want }, want)).toBe(true);
    expect(stampIsFresh(null, want)).toBe(false);
    expect(stampIsFresh({ ...want, commit: 'b'.repeat(40) }, want)).toBe(false);
    expect(stampIsFresh({ ...want, source: 'local', dir: '/x' }, want)).toBe(false);
    expect(stampIsFresh({ ...want, transformVersion: 0 }, want)).toBe(false);
  });

  it('never treats a dirty checkout as fresh', () => {
    const local = { source: 'local', dir: '/x', commit: 'a'.repeat(40), dirty: true, transformVersion: TRANSFORM_VERSION };
    expect(stampIsFresh(local, local)).toBe(false);
    expect(stampIsFresh({ ...local, dirty: false }, local)).toBe(false);
  });
});

describe('withLock', () => {
  let tmp;
  let lockFile;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'fetch-lock-'));
    lockFile = join(tmp, '.fetch.lock');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('waits for a live holder to release the lock, then takes it', async () => {
    // The holder stays alive after releasing, so only the release can end the wait.
    const holder = spawn(process.execPath, [
      '-e',
      `setTimeout(() => require('fs').rmSync(${JSON.stringify(lockFile)}), 400); setTimeout(() => {}, 5000);`,
    ]);
    try {
      await new Promise((r) => holder.once('spawn', r));
      writeFileSync(lockFile, String(holder.pid));
      const logs = [];
      const started = Date.now();
      const result = withLock(lockFile, () => readFileSync(lockFile, 'utf8'), { pollMs: 20, log: (m) => logs.push(m) });
      expect(Date.now() - started).toBeGreaterThanOrEqual(300);
      expect(result).toBe(String(process.pid));
      expect(logs).toEqual([`fetch-tuning-docs: waiting for another fetch (pid ${holder.pid}) to finish ...`]);
      expect(existsSync(lockFile)).toBe(false);
    } finally {
      holder.kill();
    }
  });

  it('reclaims a lock left by a process that is gone', () => {
    const { pid } = spawnSync(process.execPath, ['-e', '']);
    writeFileSync(lockFile, String(pid));
    expect(withLock(lockFile, () => 'ran', { timeoutMs: 1000 })).toBe('ran');
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('gives up after the timeout while the holder is alive', () => {
    writeFileSync(lockFile, String(process.pid));
    expect(() => withLock(lockFile, () => 'ran', { timeoutMs: 100, pollMs: 20, log: () => {} })).toThrow(
      new RegExp(`gave up after 0s waiting for .*held by pid ${process.pid}`),
    );
    expect(existsSync(lockFile)).toBe(true);
  });

  it('releases the lock when fn throws', () => {
    expect(() => withLock(lockFile, () => { throw new Error('boom'); })).toThrow('boom');
    expect(existsSync(lockFile)).toBe(false);
  });
});
