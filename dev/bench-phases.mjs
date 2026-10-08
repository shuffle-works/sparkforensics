#!/usr/bin/env node
// Manual dev tool: per-phase timing of the analysis pipeline (decompress, parse + model build,
// detectors, evidence JSON, comparison, CLI end to end, MCP tool call), with median and spread
// over repeated cold child processes.
//
// Usage:
//   node dev/bench-phases.mjs [--repeat N] [--json out.json] <log>[:<baseline-log>]...
//   node dev/bench-phases.mjs --cli  [--repeat N] <log>...     # CLI end to end (child process)
//   node dev/bench-phases.mjs --mcp  [--repeat N] <log>[:<other>]  # MCP tool calls (cold + warm)
//
// Each repeat is a fresh `node` process, so JIT warm-up and heap growth are part of the number,
// as they are for a real CLI run. Phases are measured in sequence inside one process:
//   decompress : streamFile with a no-op consumer (codec only; absent for zip archives)
//   collect    : collectRun = decompress + line split + JSON.parse + event handlers + model
//   findings   : runFindings (detectors + impact estimates) on the parsed model
//   evidence   : buildEvidenceReport({markdown:false}) + JSON.stringify of the result
//   outputBlocks: runOutputBlocks (the CLI report's metrics + effectiveConf blocks; stage identity per stage)
//   compare    : collect of the second log (not counted) + buildComparisonOutput of the pair
// parse+model is derived as collect - decompress (the two run back to back, so the second pass
// has a warm page cache and JIT; treat the split as approximate and collect as the real number).
import { spawnSync } from 'node:child_process';
import { statSync, writeFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CORE = join(ROOT, 'packages', 'core', 'src');
const SELF = fileURLToPath(import.meta.url);

const ms = (t0) => performance.now() - t0;

async function childPhases(path, otherPath) {
  const { collectRun, nodeFileFromPath } = await import(join(CORE, 'cli', 'collect-run.ts'));
  const { streamFile } = await import(join(CORE, 'parser-worker.ts'));
  const { nodeParseCodecs } = await import(join(CORE, 'cli', 'native-zstd.ts'));
  const { runFindings, buildEvidenceReport } = await import(join(CORE, 'evidence-report.ts'));
  const { deriveEvidenceAvailability } = await import(join(CORE, 'evidence-availability.ts'));
  const { buildComparisonOutput } = await import(join(CORE, 'comparison-output.ts'));
  const out = { name: basename(path), bytes: statSync(path).size };

  const isZip = path.endsWith('.zip');
  if (!isZip) {
    const file = nodeFileFromPath(path);
    let decoded = 0;
    const t = performance.now();
    await streamFile(file, (c) => { decoded += c.length; }, 512 * 1024, nodeParseCodecs.zstdDecoder);
    out.decompressMs = ms(t);
    out.decodedBytes = decoded;
    file.close();
  }

  const t1 = performance.now();
  const { appModel, skippedLines } = await collectRun(path);
  out.collectMs = ms(t1);
  out.heapAfterCollectMB = process.memoryUsage().heapUsed / 1e6;
  appModel.evidenceAvailability = deriveEvidenceAvailability(appModel, { skippedLines });
  out.stages = appModel.stages.size;

  const t2 = performance.now();
  const { catalog } = runFindings(appModel, undefined);
  out.findingsMs = ms(t2);
  out.findings = catalog.length;

  const t3 = performance.now();
  const { json } = buildEvidenceReport(appModel, { markdown: false });
  out.evidenceBuildMs = ms(t3);
  const t4 = performance.now();
  out.evidenceJsonBytes = JSON.stringify(json).length;
  out.evidenceStringifyMs = ms(t4);

  const { runOutputBlocks } = await import(join(CORE, 'run-output.ts'));
  const t6 = performance.now();
  runOutputBlocks(appModel, {});
  out.outputBlocksMs = ms(t6);

  if (otherPath) {
    const b = await collectRun(otherPath);
    b.appModel.evidenceAvailability = deriveEvidenceAvailability(b.appModel, { skippedLines: b.skippedLines });
    const bCatalog = runFindings(b.appModel, undefined).catalog;
    const t5 = performance.now();
    buildComparisonOutput(
      { label: 'baseline', appModel: b.appModel, catalog: bCatalog },
      { label: 'candidate', appModel, catalog },
      {},
    );
    out.compareMs = ms(t5);
  }
  out.maxRssMB = process.resourceUsage().maxRSS / 1024;
  process.stdout.write(JSON.stringify(out));
}

async function childMcp(path, otherPath) {
  const tools = await import(join(CORE, 'mcp-tools.ts'));
  const out = { name: basename(path) };
  let t = performance.now();
  const a = await tools.resolveOrCreateRun({ source: { path } });
  out.resolveColdMs = ms(t);
  t = performance.now();
  tools.getRunSummary(a.runId);
  out.summaryFirstMs = ms(t);
  t = performance.now();
  tools.getRunSummary(a.runId);
  out.summaryWarmMs = ms(t);
  t = performance.now();
  tools.diagnoseRun(a.runId);
  out.diagnoseMs = ms(t);
  t = performance.now();
  await tools.resolveOrCreateRun({ source: { path } });
  out.resolveWarmMs = ms(t);
  if (otherPath) {
    t = performance.now();
    await tools.compareRuns({ source: { path: otherPath } }, { runId: a.runId });
    out.compareColdMs = ms(t); // includes parsing the other log
    t = performance.now();
    await tools.compareRuns({ source: { path: otherPath } }, { runId: a.runId });
    out.compareWarmMs = ms(t);
  }
  out.maxRssMB = process.resourceUsage().maxRSS / 1024;
  process.stdout.write(JSON.stringify(out));
}

function cliOnce(path, otherPath) {
  const args = [join(ROOT, 'packages', 'cli', 'bin', 'sparkforensics-analyze.mjs'), path, '--format', 'json'];
  if (otherPath) args.push('--baseline', otherPath);
  const t = performance.now();
  const r = spawnSync(process.execPath, ['--max-old-space-size=8192', ...args], { encoding: 'buffer', maxBuffer: 1 << 30 });
  return { wallMs: ms(t), exit: r.status, outBytes: r.stdout.length };
}

function median(a) { const s = [...a].sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; }
const fmt = (v, k = '') => (v == null ? '-' : /MB$/.test(k) ? `${v.toFixed(0)}MB` : v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${v.toFixed(0)}ms`);

function summarize(runs, keys) {
  const row = {};
  for (const k of keys) {
    const v = runs.map((r) => r[k]).filter((x) => typeof x === 'number');
    if (!v.length) continue;
    row[k] = { median: median(v), min: Math.min(...v), max: Math.max(...v) };
  }
  return row;
}

const argv = process.argv.slice(2);
if (argv[0] === '--child') {
  const [, mode, path, other] = argv;
  await (mode === 'mcp' ? childMcp : childPhases)(path, other || undefined);
} else {
  let repeat = 5; let json = null; let mode = 'phases'; const targets = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repeat') repeat = Number(argv[++i]);
    else if (argv[i] === '--json') json = argv[++i];
    else if (argv[i] === '--cli') mode = 'cli';
    else if (argv[i] === '--mcp') mode = 'mcp';
    else targets.push(argv[i]);
  }
  const results = [];
  for (const target of targets) {
    const [path, other] = target.split(':');
    const runs = [];
    for (let i = 0; i < repeat; i++) {
      if (mode === 'cli') { runs.push(cliOnce(path, other)); continue; }
      const r = spawnSync(process.execPath, ['--max-old-space-size=8192', SELF, '--child', mode, path, other ?? ''], { encoding: 'utf8', maxBuffer: 1 << 30 });
      if (r.status !== 0) { console.error(`FAILED ${path}: ${r.stderr.trim().split('\n').slice(-3).join(' / ')}`); break; }
      runs.push(JSON.parse(r.stdout));
    }
    if (!runs.length) continue;
    const keys = Object.keys(runs[0]).filter((k) => typeof runs[0][k] === 'number' && !/bytes|stages|findings$/i.test(k));
    const sum = summarize(runs, keys);
    results.push({ target, runs: runs.length, bytes: statSync(path).size, summary: sum, raw: runs });
    console.log(`${basename(path)}${other ? ` vs ${basename(other)}` : ''}  (${runs.length} runs)`);
    for (const [k, s] of Object.entries(sum)) console.log(`  ${k.padEnd(20)} median ${fmt(s.median, k).padStart(8)}  min ${fmt(s.min, k).padStart(8)}  max ${fmt(s.max, k).padStart(8)}`);
  }
  if (json) writeFileSync(json, JSON.stringify(results, null, 1));
}
