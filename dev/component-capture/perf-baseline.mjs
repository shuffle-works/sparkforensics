#!/usr/bin/env node
// One-off baseline for the parsing + stage-modal optimization path. Drives a
// real build against a real event log and times two things with Date.now()
// deltas around Playwright waits: (1) file-drop to dashboard render (parse),
// (2) stage-row click to modal settled (modal-open), repeated to see variance.
// Not a permanent regression test.
//
// Usage: node dev/component-capture/perf-baseline.mjs <path-to-event-log> [--runs N] [--port N]

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseArgs(argv) {
  const args = { logPath: null, runs: 3, port: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--runs') args.runs = Number(argv[++i]);
    else if (arg === '--port') args.port = Number(argv[++i]);
    else if (!args.logPath) args.logPath = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!args.logPath) throw new Error('Usage: node dev/component-capture/perf-baseline.mjs <path-to-event-log> [--runs N] [--port N]');
  return args;
}

async function waitForServer(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Preview server never came up at ${url}`);
}

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function measureParse(page, baseUrl, logPath) {
  await page.goto(baseUrl);
  await page.waitForSelector('[data-testid="drop-zone"]');
  await page.evaluate(() => { delete window.showOpenFilePicker; });
  const t0 = Date.now();
  await page.setInputFiles('[data-testid="file-input"]', logPath);
  await page.waitForSelector('[data-testid="dashboard"]', { timeout: 300000 });
  return Date.now() - t0;
}

async function openFirstStageModalAndMeasure(page) {
  // A raw `table tbody tr` locator can resolve to the Timeline chart's hidden
  // accessible "table view" (first in DOM order, same tabpanel) instead of the
  // Stage Summary table; its clipped rows still report non-zero rects, so a
  // click there lands nowhere. Target the stage-cell button (StageTable.tsx
  // `aria-label="Open Stage N details"`), unique to the real table.
  const openDetailsButton = page.getByRole('button', { name: /^Open Stage \d+ details$/ }).first();
  await openDetailsButton.waitFor({ state: 'visible', timeout: 10000 });
  const t0 = Date.now();
  await openDetailsButton.click({ timeout: 5000 });
  await page.waitForSelector('[data-slot="dialog-content"]', { timeout: 10000 });
  // Body renders "Loading task data…" while getTaskData() resolves; modal
  // is "settled" once that's gone (StageDetailDialog.tsx:296).
  await page.waitForFunction(
    () => !document.body.textContent?.includes('Loading task data'),
    { timeout: 30000 },
  );
  const elapsed = Date.now() - t0;
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  return elapsed;
}

async function measureModalOpen(page) {
  // StageTable only renders inside the "Full app report" tab
  // (Dashboard.tsx's ReferenceSection); select it before rows exist.
  const reportTrigger = page.locator('[data-slot="tabs-trigger"]', { hasText: 'Full app report' }).first();
  await reportTrigger.click();

  // Default-sort case: whatever the table's default order surfaces first
  // (the "problem view": biggest/flagged stages).
  const defaultMs = await openFirstStageModalAndMeasure(page);

  // Worst-case: the stage with the most task events; the modal's histogram/plan
  // computations scale with task count, so this is the case worth optimizing.
  const tasksHeader = page.getByRole('columnheader', { name: /Tasks/ }).first();
  await tasksHeader.click();
  await tasksHeader.click();
  const maxTasksMs = await openFirstStageModalAndMeasure(page);

  return { defaultMs, maxTasksMs };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const logPath = path.resolve(args.logPath);
  if (!existsSync(logPath)) throw new Error(`Log file not found: ${logPath}`);

  const port = args.port ?? 4173 + (process.pid % 500);
  const baseUrl = `http://127.0.0.1:${port}`;

  const distWasClean = spawnSync('git', ['status', '--porcelain', '--', 'dist/'], { cwd: REPO_ROOT }).stdout.toString().trim() === '';

  console.log('Building app (npm run build)…');
  const build = spawnSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
  if (build.status !== 0) throw new Error('npm run build failed');

  console.log(`Serving dist/ on ${baseUrl}…`);
  const preview = spawn('npx', ['--no-install', 'vite', 'preview', '--port', String(port), '--strictPort'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const parseTimes = [];
  const modalDefaultTimes = [];
  const modalMaxTasksTimes = [];
  try {
    await waitForServer(baseUrl);
    for (let i = 0; i < args.runs; i += 1) {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.on('pageerror', (err) => console.error(`[run ${i + 1}] page error:`, err.message));
      console.log(`\n[run ${i + 1}/${args.runs}] loading ${path.basename(logPath)}…`);
      const parseMs = await measureParse(page, baseUrl, logPath);
      console.log(`[run ${i + 1}] parse (drop -> dashboard): ${parseMs}ms`);
      parseTimes.push(parseMs);

      const { defaultMs, maxTasksMs } = await measureModalOpen(page);
      console.log(`[run ${i + 1}] stage modal open, default-sort row (click -> settled): ${defaultMs}ms`);
      console.log(`[run ${i + 1}] stage modal open, max-task-count row (click -> settled): ${maxTasksMs}ms`);
      modalDefaultTimes.push(defaultMs);
      modalMaxTasksTimes.push(maxTasksMs);

      await context.close();
    }
  } finally {
    await browser.close().catch(() => {});
    preview.kill('SIGKILL');
    if (distWasClean) {
      spawnSync('git', ['checkout', '--', 'dist/'], { cwd: REPO_ROOT, stdio: 'inherit' });
      spawnSync('git', ['clean', '-fd', '--', 'dist/'], { cwd: REPO_ROOT, stdio: 'inherit' });
    } else {
      console.log('dist/ had uncommitted changes before this run, left as-is, not reverting.');
    }
  }

  console.log('\n=== Baseline summary ===');
  console.log('log file:', path.basename(logPath), `(${(statSync(logPath).size / 1e6).toFixed(1)}MB compressed)`);
  console.log('parse (drop -> dashboard) ms:', parseTimes, 'median:', median(parseTimes));
  console.log('modal open, default-sort row, ms:', modalDefaultTimes, 'median:', median(modalDefaultTimes));
  console.log('modal open, max-task-count row, ms:', modalMaxTasksTimes, 'median:', median(modalMaxTasksTimes));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(process.exitCode ?? 0);
  });
