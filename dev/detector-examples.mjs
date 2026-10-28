#!/usr/bin/env node
// Manual dev tool and CI gate: picks one public corpus log per finding type and keeps the finding
// the real CLI reports for it, so the docs site's detector pages show a real finding card.
// Details: docs-site/contributor-guide/testing.md.
//
// Usage:
//   node dev/detector-examples.mjs --update   Write dev/detector-examples.json
//   node dev/detector-examples.mjs --check    Fail when the committed file is out of date
//
// Pick rule per type, over the logs named in dev/corpus-snapshot.json: best impact band
// (critical, warning, info), then highest confidence, then the smaller file, then the name.
// A type no public log fires maps to null.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLI = join(ROOT, 'packages', 'cli', 'bin', 'sparkforensics-analyze.mjs');
const LOG_DIRS = [join(HERE, 'log-corpus', 'logs'), join(HERE, 'log-corpus', 'logs', 'external')];
export const SNAPSHOT_FILE = join(HERE, 'corpus-snapshot.json');
export const EXAMPLES_FILE = join(HERE, 'detector-examples.json');

const BAND_RANK = { critical: 0, warning: 1, info: 2 };
const CONFIDENCE_RANK = { high: 0, medium: 1, low: 2 };
// The finding fields a docs page renders; everything else in the CLI output is dropped.
const KEPT_FIELDS = [
  'id', 'type', 'name', 'tag', 'impactBand', 'stageId', 'metric', 'value', 'recommendation',
  'actionLabel', 'confidence', 'validationRequired', 'impact', 'impactMeaning',
  'estimateProvenance', 'evidence', 'remediation',
];

function die(message) {
  console.error(message);
  process.exit(2);
}

function logPath(name) {
  return LOG_DIRS.map((dir) => join(dir, name)).find((p) => existsSync(p)) ?? null;
}

// A rolling log is a directory; its size is the sum of its files.
function sizeOf(path) {
  const st = statSync(path);
  if (!st.isDirectory()) return st.size;
  return readdirSync(path).reduce((sum, n) => sum + sizeOf(join(path, n)), 0);
}

function analyze(path) {
  const r = spawnSync(process.execPath, [
    CLI, path, '--impact', 'critical,warning,info', '--redact', '--format', 'json',
  ], { encoding: 'utf8', maxBuffer: 1 << 30 });
  // Exit 3 is an inconclusive run (no ApplicationEnd): the report is still complete.
  if (r.status !== 0 && r.status !== 3) return null;
  return JSON.parse(r.stdout);
}

function better(a, b) {
  const key = (c) => [BAND_RANK[c.finding.impactBand] ?? 9, CONFIDENCE_RANK[c.finding.confidence] ?? 9, c.bytes, c.log];
  const ka = key(a); const kb = key(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] < kb[i]) return true;
    if (ka[i] > kb[i]) return false;
  }
  return false;
}

/** Regenerates the examples in memory: { <type>: { log, sparkVersion, finding } | null }. */
export function buildExamples() {
  const snapshot = JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8'));
  const names = snapshot.logs.filter((l) => !l.error).map((l) => l.name).sort();
  const best = new Map();
  for (const name of names) {
    const path = logPath(name);
    if (!path) die(`Corpus log ${name} is named in ${SNAPSHOT_FILE} but not found under dev/log-corpus/logs.`);
    const report = analyze(path);
    if (!report) die(`The CLI failed on ${name}.`);
    const bytes = sizeOf(path);
    const seen = new Set();
    for (const f of report.findings) {
      if (seen.has(f.type)) continue; // the first finding of a type in the log
      seen.add(f.type);
      const candidate = { log: name, bytes, sparkVersion: report.summary?.app?.sparkVersion ?? null, finding: f };
      const current = best.get(f.type);
      if (!current || better(candidate, current)) best.set(f.type, candidate);
    }
  }
  const out = {};
  for (const type of catalogTypes()) {
    const c = best.get(type);
    out[type] = c ? {
      log: c.log,
      sparkVersion: c.sparkVersion,
      finding: Object.fromEntries(KEPT_FIELDS.filter((k) => c.finding[k] !== undefined).map((k) => [k, c.finding[k]])),
    } : null;
  }
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
}

// Every finding type, taken from the catalog so a new type shows up as a null entry.
function catalogTypes() {
  const r = spawnSync(process.execPath, [CLI, 'detectors', '--format', 'json'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) die(`sparkforensics-analyze detectors failed: ${r.stderr}`);
  return JSON.parse(r.stdout).detectors.map((d) => d.type);
}

function serialize(examples) {
  return `${JSON.stringify(examples, null, 2)}\n`;
}

function main(argv) {
  const mode = argv[0];
  if (mode !== '--update' && mode !== '--check') die('Usage: node dev/detector-examples.mjs --update | --check');
  if (!existsSync(LOG_DIRS[0])) {
    die('dev/log-corpus is missing. Check out the submodule first: git submodule update --init dev/log-corpus');
  }
  const text = serialize(buildExamples());
  if (mode === '--update') {
    writeFileSync(EXAMPLES_FILE, text);
    console.log(`Wrote ${EXAMPLES_FILE} (${(text.length / 1024).toFixed(1)} KB).`);
    return;
  }
  const committed = existsSync(EXAMPLES_FILE) ? readFileSync(EXAMPLES_FILE, 'utf8') : '';
  if (committed !== text) {
    const was = committed ? JSON.parse(committed) : {};
    const now = JSON.parse(text);
    for (const type of new Set([...Object.keys(was), ...Object.keys(now)])) {
      if (JSON.stringify(was[type]) !== JSON.stringify(now[type])) console.log(`changed: ${type}`);
    }
    console.log('\ndev/detector-examples.json is out of date. If the detector change is intended, refresh it with');
    console.log('  node dev/detector-examples.mjs --update\nand commit the result.');
    process.exit(1);
  }
  console.log('dev/detector-examples.json matches the corpus.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
