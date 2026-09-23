#!/usr/bin/env node
// Manual dev tool: scores the skew and straggler detectors against a task-level ground truth.
//
// For every stage with 2+ tasks, replays its own tasks with list scheduling (slots = the stage's
// observed peak concurrent tasks, tasks in launch order, each on the earliest free slot) twice:
// with the real durations, and with every task over 4x P50 (the parser's straggler definition)
// capped at P50. The difference is the wall-clock a tail fix would recover. A stage is a positive
// when that recoverable time is >= 0.5% of app runtime, the detectors' own noise floor.
//
// Reports, per detector and for "either fired": precision/recall of the non-info findings, and
// how far each finding's wallClock.high sits from the replayed recoverable time.
//
// Usage: node dev/eval-tail-replay.mjs [--set detector.threshold=value ...] <file|dir>...
//   e.g. --set straggler.shareWarn=0.03 to score a threshold change without editing code.
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createState, runParse, runParseFiles, reassembleRollingEntries } from '../packages/core/src/parser-worker.ts';
import { nodeFileFromPath, emptyAppModel, dispatch, isRollingLogDirectory } from '../packages/core/src/cli/collect-run.ts';
import { createModelCallbacks } from '../packages/core/src/model-assembler.ts';
import { FIELDS } from '../packages/core/src/stage-quantiles.ts';
import { analyze } from '../packages/core/src/analyzer.ts';
import { DETECTORS } from '../packages/core/src/detectors.ts';

const FLOOR_PCT = 0.005;
const STRAGGLER_MULTIPLE = 4;

function listScheduleEnd(tasks, slots) {
  const free = new Array(slots).fill(0);
  let end = 0;
  for (const t of tasks) {
    let k = 0;
    for (let i = 1; i < slots; i++) if (free[i] < free[k]) k = i;
    free[k] += t.dur;
    if (free[k] > end) end = free[k];
  }
  return end;
}

function replayRecoverableMs(arr, p50) {
  const n = arr.length / FIELDS.STRIDE;
  const events = [];
  const tasks = [];
  for (let i = 0; i < n; i++) {
    const launch = arr[i * FIELDS.STRIDE + FIELDS.LAUNCH_TIME];
    events.push([launch, 1], [arr[i * FIELDS.STRIDE + FIELDS.FINISH_TIME], -1]);
    tasks.push({ launch, dur: arr[i * FIELDS.STRIDE + FIELDS.DURATION] });
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let running = 0, slots = 1;
  for (const [, delta] of events) { running += delta; if (running > slots) slots = running; }
  tasks.sort((a, b) => a.launch - b.launch);
  const fixed = tasks.map((t) => ({ ...t, dur: t.dur > STRAGGLER_MULTIPLE * p50 ? p50 : t.dur }));
  return listScheduleEnd(tasks, slots) - listScheduleEnd(fixed, slots);
}

async function loadRun(path) {
  const appModel = emptyAppModel();
  const handlers = createModelCallbacks(appModel, {});
  const state = createState();
  const emit = (msg) => dispatch(msg, handlers);
  if (statSync(path).isDirectory()) {
    const files = reassembleRollingEntries(readdirSync(path)).map((n) => nodeFileFromPath(join(path, n)));
    await runParseFiles(files, state, { emit });
  } else {
    await runParse(nodeFileFromPath(path), state, { emit });
  }
  const app = appModel.app;
  if (app?.startTime == null || app?.endTime == null) return null;
  const appMs = app.endTime - app.startTime;
  const truth = new Map();
  for (const s of appModel.stages.values()) {
    const arr = state.taskStore.get(s.id);
    if (!arr || arr.length / FIELDS.STRIDE < 2 || !(s.taskDurationP50 > 0)) continue;
    truth.set(s.id, replayRecoverableMs(arr, s.taskDurationP50));
  }
  state.taskStore.clear();
  return { path, appModel, appMs, truth };
}

function expand(paths) {
  const out = [];
  for (const p of paths) {
    if (!statSync(p).isDirectory() || isRollingLogDirectory(p)) { out.push(p); continue; }
    for (const n of readdirSync(p).sort()) {
      const full = join(p, n);
      if (statSync(full).isFile() && !n.startsWith('.') && !/\.(zip|md|json)$/.test(n)) out.push(full);
    }
  }
  return out;
}

function score(runs) {
  const tally = { skew: [0, 0, 0], straggler: [0, 0, 0], either: [0, 0, 0] };
  const ratios = [];
  for (const { appModel: m, appMs, truth } of runs) {
    const findings = analyze(m.app, m.stages, m.executors.added, m.executors.removed, m.jobs, m.sql, m.runAggregates);
    const fired = { skew: new Map(), straggler: new Map() };
    for (const f of findings) {
      if ((f.type === 'skew' || f.type === 'straggler') && f.impactBand !== 'info') fired[f.type].set(f.stageId, f);
    }
    for (const [stageId, recoverableMs] of truth) {
      const positive = recoverableMs >= FLOOR_PCT * appMs;
      for (const key of ['skew', 'straggler', 'either']) {
        const hit = key === 'either' ? fired.skew.has(stageId) || fired.straggler.has(stageId) : fired[key].has(stageId);
        if (positive && hit) tally[key][0]++;
        else if (!positive && hit) tally[key][1]++;
        else if (positive && !hit) tally[key][2]++;
      }
      for (const key of ['skew', 'straggler']) {
        const f = fired[key].get(stageId);
        const est = f?.impactEstimate?.wallClock?.high;
        if (est != null) ratios.push({ est, truth: recoverableMs });
      }
    }
  }
  for (const [key, [tp, fp, fn]] of Object.entries(tally)) {
    const precision = tp + fp > 0 ? tp / (tp + fp) : NaN;
    const recall = tp + fn > 0 ? tp / (tp + fn) : NaN;
    console.log(`${key.padEnd(10)} tp ${tp} fp ${fp} fn ${fn}  precision ${precision.toFixed(2)}  recall ${recall.toFixed(2)}`);
  }
  const within = ratios.filter((r) => r.est >= 0.5 * r.truth && r.est <= 2 * r.truth + 1000).length;
  const under = ratios.filter((r) => r.est < 0.5 * r.truth).length;
  const mae = ratios.reduce((s, r) => s + Math.abs(r.est - r.truth), 0) / Math.max(1, ratios.length);
  console.log(`estimates  ${ratios.length} non-info findings: within 2x ${within}, >2x under ${under}, >2x over ${ratios.length - within - under}, mean abs error ${(mae / 1000).toFixed(2)}s`);
}

const argv = process.argv.slice(2);
const paths = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--set') {
    const [key, value] = argv[++i].split('=');
    const [type, name] = key.split('.');
    const detector = DETECTORS.find((d) => d.type === type);
    if (!detector?.thresholds || !(name in detector.thresholds)) throw new Error(`unknown threshold ${key}`);
    detector.thresholds[name] = Number(value);
  } else {
    paths.push(resolve(argv[i]));
  }
}
if (paths.length === 0) {
  console.error('Usage: node dev/eval-tail-replay.mjs [--set detector.threshold=value ...] <file|dir>...');
  process.exit(2);
}
const runs = [];
for (const p of expand(paths)) {
  const run = await loadRun(p);
  if (run) runs.push(run);
}
console.log(`${runs.length} runs, ${runs.reduce((s, r) => s + r.truth.size, 0)} stages with 2+ tasks`);
score(runs);
