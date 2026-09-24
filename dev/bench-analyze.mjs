#!/usr/bin/env node
// Manual dev tool: eval harness for detector/estimator tuning and parser performance.
//
// Runs the same collectRun + analyze pipeline the CLI uses over a set of event logs, one child
// process per log (so each log's peak RSS is its own), and writes a JSON snapshot of per-log
// timings, peak memory and every finding's type/location/band/estimate. Two snapshots diff into
// a per-log report of findings added/removed/re-banded and estimate shifts, which is the
// evidence a threshold or estimator change needs.
//
// Usage:
//   node dev/bench-analyze.mjs [--out snap.json] [--repeat N] <file|dir>...
//   node dev/bench-analyze.mjs --diff before.json after.json [--verbose]
//   node dev/bench-analyze.mjs --update dev/corpus-snapshot.json   (rewrite the committed snapshot)
//   node dev/bench-analyze.mjs --check dev/corpus-snapshot.json    (CI gate: exit 1 on any finding change)
//
// Directories are expanded one level (every regular file inside, sorted), except Spark
// rolling-log directories (events_<n>_* files), which are analyzed as one run. With no paths
// it defaults to dev/log-corpus/logs and its external/ subfolder.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, basename, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = join(HERE, '..', 'packages', 'core', 'src');

function findingLocKey(f) {
  // Stable across value changes (findingId hashes `value`, so a threshold tweak that shifts a
  // metric renames the id): type + location + the discriminators analyzer.ts's findingId uses.
  return [
    f.type, f.stageId ?? f.executionId ?? f.property ?? '', f.metric ?? '', f.rule ?? '', f.variant ?? '',
    f.host ?? '', f.executorId ?? '', f.dimension ?? '', f.direction ?? '', f.nodeName ?? '',
    f.groupIndex ?? '', f.rddId ?? '', f.relation ?? '', f.operator ?? '',
  ].join('|');
}

function summarizeFinding(f) {
  const est = f.impactEstimate ?? null;
  return {
    key: findingLocKey(f),
    type: f.type,
    band: f.impactBand,
    confidence: f.confidence ?? null,
    value: typeof f.value === 'number' ? f.value : null,
    basis: est?.basis ?? null,
    method: est?.estimateMethod ?? null,
    wcLow: est?.wallClock?.low ?? null,
    wcHigh: est?.wallClock?.high ?? null,
    rawWaste: est?.rawWaste ? { value: est.rawWaste.value, unit: est.rawWaste.unit } : null,
  };
}

async function runChild(path) {
  const { collectRun } = await import(join(CORE, 'cli', 'collect-run.ts'));
  const { analyze } = await import(join(CORE, 'analyzer.ts'));
  const t0 = performance.now();
  const { appModel, skippedLines } = await collectRun(path);
  const t1 = performance.now();
  const heapAfterParseMB = process.memoryUsage().heapUsed / 1e6;
  const m = appModel;
  const findings = analyze(
    m.app, m.stages, m.executors.added, m.executors.removed, m.jobs, m.sql, m.runAggregates,
  );
  const t2 = performance.now();
  const appDurationMs = m.app?.endTime && m.app?.startTime ? m.app.endTime - m.app.startTime : null;
  const result = {
    name: basename(path),
    bytes: statSync(path).isFile() ? statSync(path).size : null,
    parseMs: t1 - t0,
    analyzeMs: t2 - t1,
    maxRssMB: process.resourceUsage().maxRSS / 1024,
    heapAfterParseMB,
    skippedLines,
    stages: m.stages.size,
    sqlExecutions: m.sql.size,
    appDurationMs,
    findings: findings.map(summarizeFinding),
  };
  process.stdout.write(JSON.stringify(result));
}

function expandPaths(paths) {
  const out = [];
  for (const p of paths) {
    const st = statSync(p);
    if (!st.isDirectory()) { out.push(p); continue; }
    const names = readdirSync(p).sort();
    if (names.some((n) => /^events_\d+_/.test(n))) { out.push(p); continue; }
    for (const n of names) {
      const full = join(p, n);
      const s = statSync(full);
      if (s.isFile() && s.size > 0 && !n.startsWith('.') && !/\.(zip|md|json)$/.test(n)) out.push(full);
      else if (s.isDirectory() && readdirSync(full).some((x) => /^events_\d+_/.test(x))) out.push(full);
    }
  }
  return out;
}

function runAll(paths, repeat) {
  const results = [];
  for (const path of paths) {
    let best = null;
    for (let i = 0; i < repeat; i++) {
      const r = spawnSync(process.execPath, ['--max-old-space-size=8192', fileURLToPath(import.meta.url), '--child', path], {
        encoding: 'utf8', maxBuffer: 1 << 30,
      });
      if (r.status !== 0) {
        console.error(`FAILED ${path}: ${r.stderr.trim().split('\n').slice(-3).join(' / ')}`);
        best = { name: basename(path), error: r.stderr.trim().split('\n').slice(-1)[0] };
        break;
      }
      const res = JSON.parse(r.stdout);
      // Keep the fastest run's timings, but the max peak memory seen (peak is what matters).
      if (!best) best = res;
      else {
        best.parseMs = Math.min(best.parseMs, res.parseMs);
        best.analyzeMs = Math.min(best.analyzeMs, res.analyzeMs);
        best.maxRssMB = Math.max(best.maxRssMB, res.maxRssMB);
      }
    }
    if (!best.error) {
      console.error(
        `${best.name.padEnd(64)} parse ${best.parseMs.toFixed(0).padStart(7)}ms  analyze ${best.analyzeMs.toFixed(0).padStart(6)}ms  ` +
        `rss ${best.maxRssMB.toFixed(0).padStart(5)}MB  stages ${String(best.stages).padStart(5)}  findings ${best.findings.length}`,
      );
    }
    results.push(best);
  }
  return results;
}

function fmtMs(v) { return v == null ? '-' : `${(v / 1000).toFixed(1)}s`; }

// The committed regression snapshot keeps only what is deterministic for a given log: timings
// and memory vary per machine, so they are dropped and the diff below treats them as absent.
function stableSnapshot(logs) {
  return {
    logs: logs.map((l) => (l.error ? { name: l.name, error: l.error } : {
      name: l.name, stages: l.stages, sqlExecutions: l.sqlExecutions, skippedLines: l.skippedLines,
      findings: [...l.findings].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0)),
    })),
  };
}

function diff(beforePath, afterPath, verbose) {
  return diffSnapshots(JSON.parse(readFileSync(beforePath, 'utf8')), JSON.parse(readFileSync(afterPath, 'utf8')), verbose);
}

// Returns the number of finding-level changes (added, removed, re-banded, estimate-changed) plus
// logs that appeared, disappeared or changed error state, so --check can fail on any of them.
function diffSnapshots(snapA, snapB, verbose) {
  const a = new Map(snapA.logs.map((l) => [l.name, l]));
  const b = new Map(snapB.logs.map((l) => [l.name, l]));
  let logChanges = 0;
  for (const [name, la] of a) {
    const lb = b.get(name);
    if (!lb) { logChanges++; console.log(`${name}: missing from the new run`); }
    else if (Boolean(la.error) !== Boolean(lb.error)) { logChanges++; console.log(`${name}: error ${la.error ?? 'none'} -> ${lb.error ?? 'none'}`); }
  }
  for (const name of b.keys()) if (!a.has(name)) { logChanges++; console.log(`${name}: new log, not in the snapshot`); }
  let totAdded = 0; let totRemoved = 0; let totRebanded = 0; let totEst = 0;
  const typeDelta = new Map();
  const bump = (t, k) => { const e = typeDelta.get(t) ?? { added: 0, removed: 0, rebanded: 0, est: 0 }; e[k]++; typeDelta.set(t, e); };
  let parseA = 0; let parseB = 0; let anA = 0; let anB = 0;
  for (const [name, la] of a) {
    const lb = b.get(name);
    if (!lb || la.error || lb.error) continue;
    parseA += la.parseMs ?? 0; parseB += lb.parseMs ?? 0; anA += la.analyzeMs ?? 0; anB += lb.analyzeMs ?? 0;
    const fa = new Map(la.findings.map((f) => [f.key, f]));
    const fb = new Map(lb.findings.map((f) => [f.key, f]));
    const lines = [];
    for (const [k, f] of fa) {
      if (!fb.has(k)) { totRemoved++; bump(f.type, 'removed'); lines.push(`  - ${f.band.padEnd(8)} ${k}  wc=${fmtMs(f.wcHigh)}`); continue; }
      const g = fb.get(k);
      if (f.band !== g.band) { totRebanded++; bump(f.type, 'rebanded'); lines.push(`  ~ ${f.band}->${g.band} ${k}  wc=${fmtMs(f.wcHigh)}->${fmtMs(g.wcHigh)}`); }
      else if (f.wcHigh !== g.wcHigh || f.wcLow !== g.wcLow || f.basis !== g.basis || JSON.stringify(f.rawWaste) !== JSON.stringify(g.rawWaste) || f.confidence !== g.confidence) {
        totEst++; bump(f.type, 'est');
        if (verbose) lines.push(`  = ${k}  wc=[${fmtMs(f.wcLow)},${fmtMs(f.wcHigh)}]->[${fmtMs(g.wcLow)},${fmtMs(g.wcHigh)}] ${f.basis}->${g.basis} conf ${f.confidence}->${g.confidence}`);
      }
    }
    for (const [k, g] of fb) {
      if (!fa.has(k)) { totAdded++; bump(g.type, 'added'); lines.push(`  + ${g.band.padEnd(8)} ${k}  wc=${fmtMs(g.wcHigh)}`); }
    }
    const speed = la.parseMs == null || lb.parseMs == null ? '' : `parse ${la.parseMs.toFixed(0)}->${lb.parseMs.toFixed(0)}ms analyze ${la.analyzeMs.toFixed(0)}->${lb.analyzeMs.toFixed(0)}ms rss ${la.maxRssMB.toFixed(0)}->${lb.maxRssMB.toFixed(0)}MB`;
    if (lines.length || verbose) console.log(`${name}: ${la.findings.length} -> ${lb.findings.length} findings${speed ? `; ${speed}` : ''}`);
    for (const l of lines) console.log(l);
  }
  console.log(`\nTotals: +${totAdded} -${totRemoved} rebanded ${totRebanded} estimate-changed ${totEst}`);
  if (parseA > 0 && anA > 0) console.log(`Parse ${parseA.toFixed(0)} -> ${parseB.toFixed(0)}ms (${(((parseB - parseA) / parseA) * 100).toFixed(1)}%), analyze ${anA.toFixed(0)} -> ${anB.toFixed(0)}ms (${(((anB - anA) / anA) * 100).toFixed(1)}%)`);
  for (const [t, e] of [...typeDelta].sort()) console.log(`  ${t.padEnd(22)} +${e.added} -${e.removed} ~${e.rebanded} =${e.est}`);
  return totAdded + totRemoved + totRebanded + totEst + logChanges;
}

const argv = process.argv.slice(2);
if (argv[0] === '--child') {
  await runChild(argv[1]);
} else if (argv[0] === '--diff') {
  diff(argv[1], argv[2], argv.includes('--verbose'));
} else {
  let out = null; let repeat = 1; let check = null; let update = null; const paths = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i];
    else if (argv[i] === '--check') check = argv[++i];
    else if (argv[i] === '--update') update = argv[++i];
    else if (argv[i] === '--repeat') repeat = Number(argv[++i]);
    else paths.push(resolve(argv[i]));
  }
  if (paths.length === 0) paths.push(join(HERE, 'log-corpus', 'logs'), join(HERE, 'log-corpus', 'logs', 'external'));
  const logs = runAll(expandPaths(paths), repeat);
  if (out) writeFileSync(out, JSON.stringify({ createdAt: new Date().toISOString(), logs }, null, 1));
  if (update) writeFileSync(update, `${JSON.stringify(stableSnapshot(logs), null, 1)}\n`);
  if (check) {
    const changes = diffSnapshots(JSON.parse(readFileSync(check, 'utf8')), stableSnapshot(logs), true);
    if (changes > 0) {
      console.log(`\n${changes} change(s) against ${check}. If the detector change is intended, refresh it with`);
      console.log(`  node dev/bench-analyze.mjs --update ${check}\nand commit the result.`);
      process.exit(1);
    }
    console.log(`\nNo finding changes against ${check}.`);
  }
}
