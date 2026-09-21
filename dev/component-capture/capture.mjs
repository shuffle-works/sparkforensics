#!/usr/bin/env node
// Drives a real build of the app against a real Spark event log and dumps every
// high-level UI component as standalone HTML files: real outerHTML plus the real
// compiled CSS the page loaded, no screenshots. For fast prototyping: point a
// redesign at one of these files and it already looks like the app.
//
// Usage:
//   node dev/component-capture/capture.mjs <path-to-event-log> [--out DIR] [--port N] [--skip-build]
//
// Requires `npm run build` output in dist/ (run automatically unless
// --skip-build) and the `playwright` devDependency + its Chromium browser.

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseArgs(argv) {
  const args = { logPath: null, out: null, port: null, skipBuild: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') args.out = argv[++i];
    else if (arg === '--port') args.port = Number(argv[++i]);
    else if (arg === '--skip-build') args.skipBuild = true;
    else if (!args.logPath) args.logPath = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!args.logPath) {
    throw new Error('Usage: node dev/component-capture/capture.mjs <path-to-event-log> [--out DIR] [--port N] [--skip-build]');
  }
  return args;
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
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

/** Google Fonts <link> tags from a built page's <head>, copied verbatim: these
 * files are opened locally, not published, so no CSP reason to inline them. */
function extractFontLinks(html) {
  return (html.match(/<link[^>]*fonts\.g(?:oogleapis|static)\.com[^>]*>/g) ?? []).join('\n');
}

function wrapDocument({ title, fontLinks, css, bodyHtml }) {
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<title>${title}</title>
${fontLinks}
<style>${css}</style>
</head>
<body style="margin:0">
${bodyHtml}
</body>
</html>
`;
}

/** Concatenates every stylesheet currently linked into the page (main bundle +
 * whatever lazy-widget CSS chunks have loaded) plus inline <style> tags. */
async function collectPageCss(page) {
  return page.evaluate(async () => {
    const linkHrefs = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map((l) => l.href);
    const inline = Array.from(document.querySelectorAll('style')).map((s) => s.textContent).join('\n');
    const fetched = await Promise.all(linkHrefs.map((href) => fetch(href).then((r) => r.text())));
    return `${fetched.join('\n')}\n${inline}`;
  });
}

/** Buffers captures against a named CSS source ('main' or 'docs') and writes
 * them all once that source's final CSS is known: CSS keeps accumulating as
 * more lazy widgets mount, so don't freeze it too early. */
function makeWriter(outDir) {
  const pending = [];
  return {
    queue(relPath, bodyHtml, cssSource, title) {
      pending.push({ relPath, bodyHtml, cssSource, title });
    },
    async flush(cssBySource, fontLinksBySource) {
      const written = [];
      for (const item of pending) {
        const doc = wrapDocument({
          title: item.title,
          fontLinks: fontLinksBySource[item.cssSource] ?? '',
          css: cssBySource[item.cssSource] ?? '',
          bodyHtml: item.bodyHtml,
        });
        const fullPath = path.join(outDir, item.relPath);
        await mkdir(path.dirname(fullPath), { recursive: true });
        await writeFile(fullPath, doc);
        written.push(item.relPath);
      }
      return written;
    },
  };
}

/** Opens a collapsed disclosure trigger inside `el` (if any) so its content
 * captures expanded regardless of the region's default. */
async function ensureOpen(page, handle, notes, label) {
  const trigger = await handle.$('button[aria-expanded]');
  if (!trigger) return;
  const expanded = await trigger.getAttribute('aria-expanded');
  if (expanded === 'false') {
    try {
      await trigger.click({ timeout: 3000 });
      await page.waitForTimeout(200);
    } catch (err) {
      notes?.push(`${label ?? 'widget'}: could not click its disclosure trigger (${err.message.split('\n')[0]}), captured collapsed`);
    }
  }
}

async function captureEach(page, writer, testidPrefix, outSubdir, cssSource, notes) {
  const handles = await page.$$(`[data-testid^="${testidPrefix}"]`);
  if (handles.length === 0) {
    notes.push(`${outSubdir}: no elements matched [data-testid^="${testidPrefix}"], nothing rendered for this run`);
    return;
  }
  let index = 0;
  for (const handle of handles) {
    // Lazy widget components can still be mid-mount right after a trigger opens;
    // wait for actual render before capturing empty.
    await page.waitForFunction((el) => el.childElementCount > 0, handle, { timeout: 5000 }).catch(() => {});
    const testid = await handle.getAttribute('data-testid');
    await ensureOpen(page, handle, notes, testid);
    const heading = await handle.$eval('h3.font-heading', (el) => el.textContent?.trim()).catch(() => null);
    const slug = slugify(heading ?? testid?.replace(testidPrefix, '') ?? `item-${index}`);
    index += 1;
    const bodyHtml = await handle.evaluate((el) => el.outerHTML);
    if (!bodyHtml || /^<div[^>]*><\/div>$/.test(bodyHtml.trim())) {
      notes.push(`${outSubdir}/${slug}: rendered empty (Suspense never resolved in time), skipped`);
      continue;
    }
    writer.queue(`${outSubdir}/${String(index).padStart(2, '0')}-${slug}.html`, bodyHtml, cssSource, heading ?? slug);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const logPath = path.resolve(args.logPath);
  if (!existsSync(logPath)) throw new Error(`Log file not found: ${logPath}`);

  const outDir = path.resolve(args.out ?? path.join(REPO_ROOT, 'dev', 'component-capture', 'output', path.basename(logPath).replace(/\.[^.]+$/, '')));
  const port = args.port ?? 4173 + (process.pid % 500);
  const baseUrl = `http://127.0.0.1:${port}`;
  const notes = [];

  // dist/ is committed (GitHub Pages serves it), so a fresh build dirties
  // tracked files. Restore it afterward, but only when it was clean going in:
  // a dirty dist/ means the user has in-progress output not ours to discard.
  const distWasClean = !args.skipBuild
    && spawnSync('git', ['status', '--porcelain', '--', 'dist/'], { cwd: REPO_ROOT }).stdout.toString().trim() === '';

  if (!args.skipBuild) {
    console.log('Building app (npm run build)…');
    const build = spawnSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
    if (build.status !== 0) throw new Error('npm run build failed');
  }

  console.log(`Serving dist/ on ${baseUrl}…`);
  const preview = spawn('npx', ['--no-install', 'vite', 'preview', '--port', String(port), '--strictPort'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  preview.stdout.on('data', () => {});
  preview.stderr.on('data', () => {});

  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    await waitForServer(baseUrl);
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('crash', () => console.error('[capture] PAGE CRASHED'));
    page.on('pageerror', (err) => console.error('[capture] page error:', err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.error('[capture] console.error:', msg.text());
    });
    const writer = makeWriter(outDir);

    console.log('[capture] navigating to landing…');
    await page.goto(baseUrl);
    await page.waitForSelector('[data-testid="drop-zone"]');
    console.log('[capture] landing loaded, capturing…');
    const landingHtml = await page.evaluate(() => document.body.outerHTML);
    writer.queue('landing.html', landingHtml, 'main', 'Landing');

    console.log('[capture] loading log file:', logPath);
    await page.evaluate(() => { delete window.showOpenFilePicker; });
    await page.setInputFiles('[data-testid="file-input"]', logPath);
    console.log('[capture] waiting for dashboard to render (parsing)…');
    await page.waitForSelector('[data-testid="dashboard"]', { timeout: 180000 });
    console.log('[capture] dashboard rendered.');

    // --- Topbar ---
    const topbarHtml = await page.$eval('header', (el) => el.outerHTML).catch(() => null);
    if (topbarHtml) writer.queue('topbar.html', topbarHtml, 'main', 'Topbar');
    else notes.push('topbar: <header> not found');

    // --- Tuning reference panel ---
    const tuningButton = page.locator('[title="Spark tuning reference"]').first();
    if (await tuningButton.count()) {
      await tuningButton.click();
      await page.waitForTimeout(400);
      const panelHtml = await page.evaluate(() => document.body.outerHTML);
      writer.queue('tuning-reference-panel.html', panelHtml, 'main', 'Tuning reference panel');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    } else {
      notes.push('tuning-reference-panel: button not found');
    }

    console.log('[capture] topbar + tuning panel done.');

    // --- All recommendations (highest-impact callout + FixTheseFirst table) ---
    const recommendationsHtml = await page.$eval('section[aria-label="All recommendations"]', (el) => el.outerHTML).catch(() => null);
    if (recommendationsHtml) writer.queue('all-recommendations/board.html', recommendationsHtml, 'main', 'All recommendations');
    else notes.push('all-recommendations/board: section[aria-label="All recommendations"] not found');

    console.log('[capture] all-recommendations done.');

    // --- Suggested Improvements (action-region widgets) ---
    const boardHtml = await page.$eval('#suggested-improvements', (el) => el.outerHTML).catch(() => null);
    if (boardHtml) writer.queue('suggested-improvements/board.html', boardHtml, 'main', 'Suggested Improvements');
    else notes.push('suggested-improvements/board: #suggested-improvements not found');
    await captureEach(page, writer, 'widget-grid-item-alert-', 'suggested-improvements', 'main', notes);

    console.log('[capture] suggested-improvements done.');

    // --- Clean checks (passing action-region widgets) ---
    const cleanTrigger = page.locator('[data-slot="accordion-trigger"]', { hasText: 'Clean checks' }).first();
    if (await cleanTrigger.count()) {
      await cleanTrigger.click();
      await page.waitForTimeout(300);
      const cleanContent = await cleanTrigger.evaluateHandle((el) => el.closest('[data-slot="accordion-item"]'));
      const cleanHtml = await cleanContent.evaluate((el) => el?.outerHTML ?? '');
      // Clean checks render as plain <TableRow>s (CleanCheckRow), not per-widget
      // cards, so the whole table comes along in this one board.html.
      if (cleanHtml) writer.queue('clean-checks/board.html', cleanHtml, 'main', 'Clean checks');
    } else {
      notes.push('clean-checks: accordion trigger not found (no clean widgets this run?)');
    }

    console.log('[capture] clean-checks done.');

    // --- Full app report (reference-region widgets) ---
    // Under a Tab (Dashboard.tsx's Findings/Full app report TabsTrigger pair):
    // selecting the tab is the disclosure, no separate collapse state to capture.
    const reportTrigger = page.locator('[data-slot="tabs-trigger"]', { hasText: 'Full app report' }).first();
    if (await reportTrigger.count()) {
      await reportTrigger.click();
      await page.waitForTimeout(400);
      const reportPanel = page.locator('[data-slot="tabs-content"]', { hasText: 'Full app report' }).first();
      const panelHtml = await reportPanel.evaluate((el) => el?.outerHTML ?? '').catch(() => '');
      if (panelHtml) writer.queue('full-app-report/panel.html', panelHtml, 'main', 'Full app report');
      await captureEach(page, writer, 'widget-grid-item-reference-', 'full-app-report', 'main', notes);
    } else {
      notes.push('full-app-report: tab trigger not found');
    }

    console.log('[capture] full-app-report done.');

    // --- Plan graph (picker dialog when 2+ eligible executions, else direct view) ---
    const planButton = page.locator('header button', { hasText: 'Plan graph' }).first();
    if (await planButton.count()) {
      await planButton.click();
      await page.waitForTimeout(400);
      const dialog = page.locator('[role="dialog"]', { hasText: 'Choose which SQL execution' }).first();
      if (await dialog.count()) {
        const dialogHtml = await dialog.evaluate((el) => el.outerHTML);
        writer.queue('plan-graph/picker-dialog.html', dialogHtml, 'main', 'Plan graph picker');
        await dialog.locator('ul button').first().click();
        await page.waitForTimeout(500);
      }
      const graphHtml = await page.evaluate(() => document.body.outerHTML);
      writer.queue('plan-graph/graph-view.html', graphHtml, 'main', 'Plan graph view');
    } else {
      notes.push('plan-graph: no eligible SQL executions this run (button not rendered)');
    }

    console.log('[capture] plan-graph done. collecting main CSS…');
    const mainCss = await collectPageCss(page);
    console.log('[capture] main CSS collected:', mainCss.length, 'chars');
    const mainIndexHtml = await readFile(path.join(REPO_ROOT, 'dist', 'index.html'), 'utf8');
    const mainFontLinks = extractFontLinks(mainIndexHtml);

    // --- Docs site (separate build, separate design system, own tab) ---
    const docsPage = await context.newPage();
    let docsCss = '';
    let docsFontLinks = '';
    try {
      await docsPage.goto(`${baseUrl}/docs/`);
      await docsPage.waitForLoadState('networkidle');
      const docsBodyHtml = await docsPage.evaluate(() => document.body.outerHTML);
      writer.queue('docs-site.html', docsBodyHtml, 'docs', 'Docs site');
      docsCss = await collectPageCss(docsPage);
      const docsIndexHtml = await readFile(path.join(REPO_ROOT, 'dist', 'docs', 'index.html'), 'utf8');
      docsFontLinks = extractFontLinks(docsIndexHtml);
    } catch (err) {
      notes.push(`docs-site: ${err.message}`);
    } finally {
      await docsPage.close();
    }

    const written = await writer.flush(
      { main: mainCss, docs: docsCss },
      { main: mainFontLinks, docs: docsFontLinks },
    );

    const manifest = {
      sourceLog: path.basename(logPath),
      outDir,
      files: written.sort(),
      notes,
    };
    await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    console.log(`\nWrote ${written.length} component captures to ${outDir}`);
    if (notes.length) {
      console.log('\nSkipped / notes:');
      for (const note of notes) console.log(`  - ${note}`);
    }
  } finally {
    await browser.close().catch(() => {});
    preview.kill('SIGKILL');
    if (distWasClean) {
      console.log('Restoring tracked dist/ to its committed state…');
      spawnSync('git', ['checkout', '--', 'dist/'], { cwd: REPO_ROOT, stdio: 'inherit' });
      spawnSync('git', ['clean', '-fd', '--', 'dist/'], { cwd: REPO_ROOT, stdio: 'inherit' });
    } else if (!args.skipBuild) {
      console.log('dist/ had uncommitted changes before this run, left as-is, not reverting.');
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    // The spawned preview server (or a straggler browser handle) can otherwise
    // keep the event loop alive after everything is written.
    process.exit(process.exitCode ?? 0);
  });
