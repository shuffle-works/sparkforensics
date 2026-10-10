#!/usr/bin/env node
// Manual dev tool: browser dashboard load timing against a production build (`vite build` +
// `vite preview`). Each repeat opens a fresh browser context, drops the log into the file input
// and records, in-page: time to the first rendered dashboard and to the point no lazy-widget skeleton is left, main-thread long tasks (>50 ms)
// between the drop and the dashboard, and the JS heap once the dashboard is up and the peak resident memory of the whole browser. Then it
// switches the dashboard's report tabs and records the long tasks of each switch.
//
// Usage: node dev/bench-dashboard.mjs [--repeat N] [--json out.json] [--dist dir] [--no-tabs] <log>...
//   Run `npx vite build` first. One browser at a time; the preview server is stopped at exit.
import { spawn, execFileSync } from 'node:child_process';
import { statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const MARKER = String(process.pid);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { logs: [], repeat: 5, json: null, tabs: true, port: 4399, dist: 'dist' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--repeat') args.repeat = Number(argv[++i]);
    else if (a === '--json') args.json = argv[++i];
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--dist') args.dist = argv[++i];
    else if (a === '--no-tabs') args.tabs = false;
    else args.logs.push(a);
  }
  if (!args.logs.length) throw new Error('Usage: node dev/bench-dashboard.mjs [--repeat N] [--json out.json] [--dist dir] [--no-tabs] <log>...');
  return args;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function waitForServer(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Preview server never came up at ${url}`);
}

// Installed before any page script runs: collects long tasks and stamps the moment the
// dashboard root first appears in the DOM.
const INIT_SCRIPT = () => {
  window.__bench = { longTasks: [], dashboardAt: null, settledAt: null };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__bench.longTasks.push({ start: e.startTime, dur: e.duration });
  }).observe({ type: 'longtask', buffered: true });
  // Settled: the dashboard is up and no lazy-widget skeleton (an aria-hidden Card) is left.
  const mo = new MutationObserver(() => {
    const b = window.__bench;
    if (b.dashboardAt == null && document.querySelector('[data-testid="dashboard"]')) b.dashboardAt = performance.now();
    if (b.dashboardAt != null && b.settledAt == null && !document.querySelector('[data-slot="card"][aria-hidden="true"]')) {
      b.settledAt = performance.now();
      mo.disconnect();
    }
  });
  document.addEventListener('DOMContentLoaded', () => mo.observe(document.documentElement, { childList: true, subtree: true }));
};

// Resident memory (MB) of the browser process and all its descendants: renderer, worker and GPU
// processes together, which is the tab's real footprint (the JS heap alone misses the workers).
function browserRssMB(marker) {
  try {
    const rootPid = Number(execFileSync('pgrep', ['-f', '--', `--bench-marker=${marker}`], { encoding: 'utf8' }).trim().split('\n')[0]);
    const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
    const live = new Set([rootPid]);
    for (let grew = true; grew;) {
      grew = false;
      for (const [pid, ppid] of rows) if (live.has(ppid) && !live.has(pid)) { live.add(pid); grew = true; }
    }
    return rows.filter(([pid]) => live.has(pid)).reduce((sum, [, , rss]) => sum + rss, 0) / 1024;
  } catch { return 0; }
}

async function runOnce(browser, baseUrl, logPath, withTabs) {
  let peakRssMB = 0;
  const sampler = setInterval(() => { peakRssMB = Math.max(peakRssMB, browserRssMB(MARKER)); }, 100);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(INIT_SCRIPT);
  await page.goto(baseUrl);
  await page.waitForSelector('[data-testid="drop-zone"]');
  await page.evaluate(() => { delete window.showOpenFilePicker; });
  const t0 = await page.evaluate(() => performance.now());
  await page.setInputFiles('[data-testid="file-input"]', logPath);
  await page.waitForSelector('[data-testid="dashboard"]', { timeout: 300000 });
  // Let the post-parse prefetch and the first paint settle before reading the heap.
  await page.waitForTimeout(500);
  const load = await page.evaluate((t) => {
    const b = window.__bench;
    const tasks = b.longTasks.filter((x) => x.start + x.dur >= t);
    return {
      toDashboardMs: b.dashboardAt - t,
      toSettledMs: b.settledAt == null ? null : b.settledAt - t,
      longTaskCount: tasks.length,
      longTaskTotalMs: tasks.reduce((s, x) => s + x.dur, 0),
      longTaskMaxMs: tasks.reduce((m, x) => Math.max(m, x.dur), 0),
      heapMB: performance.memory ? performance.memory.usedJSHeapSize / 1e6 : null,
    };
  }, t0);

  const tabs = [];
  if (withTabs) {
    const tabButtons = page.getByRole('tablist', { name: 'Report view' }).getByRole('tab');
    const n = await tabButtons.count();
    for (let i = 0; i < n; i += 1) {
      const tab = tabButtons.nth(i);
      const name = (await tab.textContent())?.trim() ?? `tab-${i}`;
      const mark = await page.evaluate(() => performance.now());
      await tab.click();
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await page.waitForTimeout(300);
      const t = await page.evaluate((m) => {
        const tasks = window.__bench.longTasks.filter((x) => x.start >= m);
        return { count: tasks.length, totalMs: tasks.reduce((s, x) => s + x.dur, 0), maxMs: tasks.reduce((mx, x) => Math.max(mx, x.dur), 0) };
      }, mark);
      tabs.push({ name, ...t });
    }
  }
  clearInterval(sampler);
  peakRssMB = Math.max(peakRssMB, browserRssMB(MARKER));
  await context.close();
  return { ...load, peakRssMB, tabs };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = `http://127.0.0.1:${args.port}/`;
  // Run vite's own bin under this node: killing an `npx` wrapper would leave the server running.
  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const server = spawn(process.execPath, [viteBin, 'preview', '--outDir', path.resolve(args.dist), '--port', String(args.port), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  const stop = () => { try { server.kill('SIGTERM'); } catch { /* already gone */ } };
  process.on('exit', stop);
  process.on('SIGINT', () => { stop(); process.exit(130); });
  let browser;
  const report = [];
  try {
    await waitForServer(baseUrl);
    browser = await chromium.launch({ channel: process.env.BENCH_BROWSER_CHANNEL || undefined, args: ['--enable-precise-memory-info', `--bench-marker=${MARKER}`] });
    for (const logPath of args.logs) {
      const runs = [];
      for (let i = 0; i < args.repeat; i += 1) runs.push(await runOnce(browser, baseUrl, logPath, args.tabs));
      const row = {
        log: path.basename(logPath),
        bytes: statSync(logPath).size,
        repeat: args.repeat,
        toDashboardMs: median(runs.map((r) => r.toDashboardMs)),
        toSettledMs: median(runs.map((r) => r.toSettledMs ?? NaN)),
        longTaskTotalMs: median(runs.map((r) => r.longTaskTotalMs)),
        longTaskMaxMs: median(runs.map((r) => r.longTaskMaxMs)),
        longTaskCount: median(runs.map((r) => r.longTaskCount)),
        heapMB: median(runs.map((r) => r.heapMB ?? 0)),
        peakRssMB: median(runs.map((r) => r.peakRssMB)),
        spreadMs: [Math.min(...runs.map((r) => r.toDashboardMs)), Math.max(...runs.map((r) => r.toDashboardMs))],
        tabs: runs[0].tabs.map((t, ti) => ({
          name: t.name,
          totalMs: median(runs.map((r) => r.tabs[ti].totalMs)),
          maxMs: median(runs.map((r) => r.tabs[ti].maxMs)),
        })),
      };
      report.push(row);
      console.log(`${row.log}  ${(row.bytes / 1e6).toFixed(1)} MB  dashboard ${row.toDashboardMs.toFixed(0)} ms, settled ${row.toSettledMs.toFixed(0)} ms [${row.spreadMs.map((x) => x.toFixed(0)).join('..')}]  long tasks ${row.longTaskCount} (${row.longTaskTotalMs.toFixed(0)} ms total, ${row.longTaskMaxMs.toFixed(0)} ms max)  heap ${row.heapMB.toFixed(0)} MB  peak browser RSS ${row.peakRssMB.toFixed(0)} MB`);
      for (const t of row.tabs) console.log(`    tab ${t.name}: ${t.totalMs.toFixed(0)} ms long-task total, ${t.maxMs.toFixed(0)} ms max`);
    }
  } finally {
    await browser?.close();
    stop();
  }
  if (args.json) writeFileSync(args.json, JSON.stringify(report, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
