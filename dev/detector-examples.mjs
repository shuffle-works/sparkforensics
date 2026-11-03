#!/usr/bin/env node
// Manual dev tool and CI gate: picks one public log per finding type and keeps the finding the real
// CLI reports for it, plus the run the dashboard's HTML export carries for that log, so the docs
// site's detector pages render the real dashboard widget from an actual run.
// Details: docs-site/contributor-guide/testing.md.
//
// Usage:
//   node dev/detector-examples.mjs --update   Write dev/detector-examples.json and dev/detector-example-runs.json
//   node dev/detector-examples.mjs --check    Fail when either committed file is out of date
//
// Sources, in order of preference: the public corpus logs named in dev/corpus-snapshot.json
// ('corpus'), then the recorded logs in packages/core/test/fixtures ('fixture'), then the small
// hand-built logs in packages/core/test/fixtures/synthetic ('synthetic'). A later source is read
// only for a type the earlier ones never fire. Pick rule within a source: best impact band
// (critical, warning, info), then highest confidence, then the smaller file, then the name.
// A type no source fires maps to null.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRun } from '../packages/core/src/cli/collect-run.ts';
import { analyzeRun } from '../packages/core/src/analyzed-run.ts';
import { encodeCollections } from '../packages/core/src/export-data.ts';
import { buildHtmlExportData } from '../packages/core/src/html-export.ts';
import { interpretRun } from '../packages/core/src/run-interpretation.ts';
import { gzipSync, strToU8 } from '../packages/core/src/vendor/fflate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLI = join(ROOT, 'packages', 'cli', 'bin', 'sparkforensics-analyze.mjs');
const LOG_DIRS = [join(HERE, 'log-corpus', 'logs'), join(HERE, 'log-corpus', 'logs', 'external')];
const FIXTURE_DIR = join(ROOT, 'packages', 'core', 'test', 'fixtures');
export const SNAPSHOT_FILE = join(HERE, 'corpus-snapshot.json');
export const EXAMPLES_FILE = join(HERE, 'detector-examples.json');
export const RUNS_FILE = join(HERE, 'detector-example-runs.json');

const BAND_RANK = { critical: 0, warning: 1, info: 2 };
const CONFIDENCE_RANK = { high: 0, medium: 1, low: 2 };
// What a docs page needs to find the example finding in its run; everything else in the CLI
// output is dropped.
const KEPT_FIELDS = ['id', 'type'];
// A fixed stamp, so a run's payload changes only when the run does, not with every core edit.
const EXPORT_STAMP = { buildId: 'detector-examples', producer: 'detector-examples' };

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

// Every source is a public corpus log, a recorded fixture or a synthetic log, so nothing here is
// redacted: the docs widgets show the names and values the dashboard shows for the same log.
function analyze(path) {
  const r = spawnSync(process.execPath, [
    CLI, path, '--impact', 'critical,warning,info', '--format', 'json',
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

// The best candidate per finding type over `files` ({ name, path }), read through the real CLI.
function bestByType(files, source) {
  const best = new Map();
  for (const { name, path } of files) {
    const report = analyze(path);
    if (!report) die(`The CLI failed on ${name}.`);
    const bytes = sizeOf(path);
    const seen = new Set();
    for (const f of report.findings) {
      if (seen.has(f.type)) continue; // the first finding of a type in the log
      seen.add(f.type);
      const candidate = { source, log: name, path, bytes, finding: f };
      const current = best.get(f.type);
      if (!current || better(candidate, current)) best.set(f.type, candidate);
    }
  }
  return best;
}

function ndjsonIn(dir) {
  return readdirSync(dir).filter((n) => n.endsWith('.ndjson')).sort().map((name) => ({ name, path: join(dir, name) }));
}

// The smallest potential saving a docs example shows, by what the figure counts. A tiny log saves
// milliseconds, which reads as no gain on a page that explains the fix, so the example's estimate is
// scaled up to between one and four times this much, by the finding's id so the figures differ from
// page to page but never from run to run. Docs payloads only: the analyzer and the user's export are
// untouched.
const MIN_SAVING = { wallClockMs: 30_000, ms: 30_000, coreMs: 1_800_000, coreHours: 0.5, mbSeconds: 7_372_800, bytes: 1 << 30 };

function scaleRange(range, factor) {
  return range && { low: Math.round(range.low * factor), high: Math.round(range.high * factor) };
}

// `estimate` of finding `id` with its savings raised to MIN_SAVING or more, every figure by the same
// factor so they stay consistent with each other.
function raisedEstimate(estimate, id) {
  const { wallClock, rawWaste } = estimate;
  const shown = wallClock ? wallClock.high : rawWaste?.value ?? 0;
  const minimum = wallClock ? MIN_SAVING.wallClockMs : MIN_SAVING[rawWaste?.unit];
  if (!minimum || shown >= minimum) return estimate;
  const floor = minimum * (1 + (Number.parseInt(String(id).slice(0, 4), 16) % 300) / 100);
  if (shown <= 0) {
    // A figure of zero has no ratio to scale: a wall-clock claim gets a fixed range.
    return wallClock ? { ...estimate, wallClock: { low: floor / 2, high: floor } } : estimate;
  }
  const factor = floor / shown;
  return {
    ...estimate,
    wallClock: scaleRange(wallClock, factor),
    rawWaste: rawWaste && { ...rawWaste, value: rawWaste.value * factor },
    ...(estimate.coreTimeMs ? { coreTimeMs: scaleRange(estimate.coreTimeMs, factor) } : {}),
    ...(estimate.idleCoreTimeMs ? { idleCoreTimeMs: scaleRange(estimate.idleCoreTimeMs, factor) } : {}),
  };
}

// The payload the dashboard's HTML export carries for `path`, the way the CLI's --export-html
// builds it (that flag needs a built template, which this gate must not). The gzip header's
// timestamp is zeroed, or every run would encode differently.
async function exportPayload(path) {
  const analyzed = analyzeRun((await collectRun(path)).appModel);
  for (const finding of analyzed.catalog) {
    if (finding.impactEstimate) finding.impactEstimate = raisedEstimate(finding.impactEstimate, finding.id);
  }
  const run = { ...analyzed, interpretation: interpretRun(analyzed.appModel, analyzed.catalog, analyzed.configFindings) };
  const data = buildHtmlExportData(run, { redact: false, ...EXPORT_STAMP });
  return Buffer.from(gzipSync(strToU8(JSON.stringify(encodeCollections(data))), { mtime: 0 })).toString('base64');
}

/**
 * Regenerates both files in memory: `examples` is { <type>: { source, log, finding } | null } and
 * `runs` is { "<source>/<log>": the export payload of that log }, for the logs the examples use.
 */
export async function buildExamples() {
  const snapshot = JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8'));
  const corpus = snapshot.logs.filter((l) => !l.error).map((l) => l.name).sort().map((name) => {
    const path = logPath(name);
    if (!path) die(`Corpus log ${name} is named in ${SNAPSHOT_FILE} but not found under dev/log-corpus/logs.`);
    return { name, path };
  });
  const types = catalogTypes();
  const best = bestByType(corpus, 'corpus');
  for (const [dir, source] of [[FIXTURE_DIR, 'fixture'], [join(FIXTURE_DIR, 'synthetic'), 'synthetic']]) {
    if (types.every((t) => best.has(t))) break;
    for (const [type, candidate] of bestByType(ndjsonIn(dir), source)) {
      if (!best.has(type)) best.set(type, candidate);
    }
  }
  const out = {};
  const logs = new Map();
  for (const type of types) {
    const c = best.get(type);
    out[type] = c ? {
      source: c.source,
      log: c.log,
      finding: Object.fromEntries(KEPT_FIELDS.filter((k) => c.finding[k] !== undefined).map((k) => [k, c.finding[k]])),
    } : null;
    if (c) logs.set(`${c.source}/${c.log}`, c.path);
  }
  const runs = {};
  for (const key of [...logs.keys()].sort()) runs[key] = await exportPayload(logs.get(key));
  return { examples: sortKeys(out), runs };
}

function sortKeys(object) {
  return Object.fromEntries(Object.keys(object).sort().map((k) => [k, object[k]]));
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

// Prints each key whose entry differs between the committed file and the regenerated one; true
// when any does.
function reportChanges(file, committedText, text, label) {
  if (committedText === text) return false;
  const was = committedText ? JSON.parse(committedText) : {};
  const now = JSON.parse(text);
  for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
    if (JSON.stringify(was[key]) !== JSON.stringify(now[key])) console.log(`changed ${label}: ${key}`);
  }
  console.log(`${file} is out of date.`);
  return true;
}

async function main(argv) {
  const mode = argv[0];
  if (mode !== '--update' && mode !== '--check') die('Usage: node dev/detector-examples.mjs --update | --check');
  if (!existsSync(LOG_DIRS[0])) {
    die('dev/log-corpus is missing. Check out the submodule first: git submodule update --init dev/log-corpus');
  }
  const { examples, runs } = await buildExamples();
  const files = [
    { path: EXAMPLES_FILE, text: serialize(examples), label: 'example' },
    { path: RUNS_FILE, text: serialize(runs), label: 'run' },
  ];
  if (mode === '--update') {
    for (const { path, text } of files) {
      writeFileSync(path, text);
      console.log(`Wrote ${path} (${(text.length / 1024).toFixed(1)} KB).`);
    }
    return;
  }
  const stale = files.map(({ path, text, label }) => (
    reportChanges(path, existsSync(path) ? readFileSync(path, 'utf8') : '', text, label)
  ));
  if (stale.includes(true)) {
    console.log('\nIf the detector change is intended, refresh them with');
    console.log('  node dev/detector-examples.mjs --update\nand commit the result.');
    process.exit(1);
  }
  console.log('dev/detector-examples.json and dev/detector-example-runs.json match the corpus.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
