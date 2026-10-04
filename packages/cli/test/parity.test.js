import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { main } from '../bin/sparkforensics-analyze.mjs';
import { collectRun } from '@sparkforensics/core/cli/collect-run.ts';
import { deriveEvidenceAvailability } from '@sparkforensics/core/evidence-availability.ts';
import { analyze } from '@sparkforensics/core/analyzer.ts';
import { buildComparison } from '@sparkforensics/core/run-comparison.ts';
import { comparisonOutput } from '@sparkforensics/core/comparison-output.ts';
import { createMcpServer } from '@sparkforensics/core/mcp-server-factory.ts';

// Contract test: the CLI's JSON and the MCP tools must report the same run, comparison and budget
// results for the same logs, and the dashboard (which diffs two parsed runs with core's
// compareRuns, see src/App.tsx) the same comparison. It does not list fields: it flattens both
// outputs to key paths and diffs the key sets and every value, so a field added or dropped on one
// side alone fails here. A difference that is meant to stay goes in an allowlist below with its
// reason. Public corpus logs only.
const CORPUS = join(import.meta.dirname, '..', '..', '..', 'dev', 'log-corpus', 'logs', 'external');
const BASELINE = join(CORPUS, 'external-app-20161115172038-0000.ndjson');
const CANDIDATES = [
  join(CORPUS, 'external-app-20161116163331-0000.ndjson'),
  join(CORPUS, 'external-application_1516285256255_0012.ndjson'),
];

// ---- Allowlists of intentional differences. `path` is a key path ("a.b", "list[0].x") and covers
// everything under it. An entry that matches no difference fails the test, so the list cannot rot.

// CLI single-run JSON (`candidate`) against MCP diagnose_run with every `include`.
const RUN_REPORT_ALLOWED = [
  { path: 'schemaVersion', only: 'cli', reason: 'The CLI stamps its report with the evidence schema version; MCP tool results are not versioned.' },
  { path: 'runId', only: 'mcp', reason: 'MCP handle for the cached run, used by follow-up calls. A CLI call has no session.' },
  { path: 'runComplete', only: 'mcp', reason: 'Convenience copy of summary.outcome\'s end-of-run signal that MCP clients read without asking for the summary.' },
];

// CLI `comparison` against MCP compare_runs.
const COMPARISON_ALLOWED = [
  { path: 'runIdA', only: 'mcp', reason: 'MCP run handles for the baseline and the candidate.' },
  { path: 'runIdB', only: 'mcp', reason: 'MCP run handles for the baseline and the candidate.' },
  { path: 'stagePairs', only: 'cli', reason: 'One row per paired stage can be large, so compare_runs returns it only with include: [\'stagePairs\']; the CLI always does. Checked equal with that include below.' },
  { path: 'metricDeltas', only: 'mcp', reason: 'Deprecated alias of `metrics`, kept for one release; checked equal to `metrics` below.' },
  { path: 'findingsDelta', only: 'mcp', reason: 'Deprecated alias of `findings`, kept for one release; checked equal to `findings` below.' },
];

// CLI NDJSON `budgets` against MCP evaluate_budgets `results`: nothing differs.
const BUDGETS_ALLOWED = [];

// ---- Generic diff.

function flatten(value, path = '', out = new Map()) {
  if (Array.isArray(value)) {
    if (value.length === 0) out.set(path, []);
    value.forEach((item, i) => flatten(item, `${path}[${i}]`, out));
  } else if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) out.set(path, {});
    for (const key of keys) flatten(value[key], path ? `${path}.${key}` : key, out);
  } else {
    out.set(path, value);
  }
  return out;
}

const covers = (prefix, path) => path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`);

// Returns the differences no allowlist entry explains, plus the entries that explained nothing.
function diffSurfaces(cli, mcp, allowed) {
  const a = flatten(cli);
  const b = flatten(mcp);
  const problems = [];
  const used = new Set();
  const explained = (path, kind) => {
    const entry = allowed.find((e) => covers(e.path, path) && (e.only === undefined || e.only === kind));
    if (entry) used.add(entry);
    return entry !== undefined;
  };
  for (const [path, value] of a) {
    if (!b.has(path)) { if (!explained(path, 'cli')) problems.push(`only in CLI: ${path}`); continue; }
    if (JSON.stringify(value) !== JSON.stringify(b.get(path)) && !explained(path, 'differs')) {
      problems.push(`differs: ${path} (CLI ${JSON.stringify(value)}, MCP ${JSON.stringify(b.get(path))})`);
    }
  }
  for (const path of b.keys()) {
    if (!a.has(path) && !explained(path, 'mcp')) problems.push(`only in MCP: ${path}`);
  }
  for (const entry of allowed) if (!used.has(entry)) problems.push(`allowlist entry matched nothing: ${entry.path}`);
  return problems;
}

describe('diffSurfaces', () => {
  it('reports a key missing on either side and a value that differs', () => {
    expect(diffSurfaces({ a: 1, b: 2, c: [1] }, { a: 1, b: 3, d: 4 }, [])).toEqual([
      'differs: b (CLI 2, MCP 3)', 'only in CLI: c[0]', 'only in MCP: d',
    ]);
  });

  it('accepts an allowlisted difference and rejects an allowlist entry that explains nothing', () => {
    expect(diffSurfaces({ a: 1 }, { a: 1, x: { y: 1 } }, [{ path: 'x', only: 'mcp', reason: 'r' }])).toEqual([]);
    expect(diffSurfaces({ a: 1 }, { a: 1 }, [{ path: 'x', only: 'mcp', reason: 'r' }])).toEqual(['allowlist entry matched nothing: x']);
  });
});

// ---- Surfaces.

async function cliOutput(argv) {
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const previous = process.exitCode;
  try {
    await main(argv);
    return { stdout: out.mock.calls.map(([c]) => c).join(''), stderr: err.mock.calls.map(([c]) => c).join(''), exitCode: process.exitCode };
  } finally {
    out.mockRestore();
    err.mockRestore();
    process.exitCode = previous;
  }
}

const cliJson = async (argv) => JSON.parse((await cliOutput(argv)).stdout);
const cliLines = async (argv) => (await cliOutput(argv)).stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));

let mcp;
beforeAll(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createMcpServer().connect(serverTransport);
  mcp = new Client({ name: 'parity-test', version: '1.0.0' });
  await mcp.connect(clientTransport);
});
afterAll(async () => { await mcp?.close(); });

async function mcpCall(name, args) {
  const result = await mcp.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name} failed: ${result.content[0].text}`);
  // The in-memory transport skips the JSON step stdio does, which drops undefined-valued keys.
  return JSON.parse(JSON.stringify(result.structuredContent));
}

// What the dashboard does: parse both runs, analyze, diff the two snapshots.
async function dashboardComparison(baselinePath, candidatePath) {
  const prepare = async (path) => {
    const { appModel, skippedLines } = await collectRun(path);
    appModel.evidenceAvailability = deriveEvidenceAvailability(appModel, { skippedLines });
    const catalog = analyze(
      appModel.app, appModel.stages, appModel.executors.added, appModel.executors.removed,
      appModel.jobs, appModel.sql, appModel.runAggregates,
    );
    return { appModel, catalog };
  };
  const [base, cand] = await Promise.all([prepare(baselinePath), prepare(candidatePath)]);
  return buildComparison({ label: 'baseline', ...base }, { label: 'candidate', ...cand });
}

const INCLUDE_ALL = ['summary', 'evidenceAvailability', 'detectors'];

// The fields of the comparison block (stage pairs and the run-time coverage they feed).
const COMPARISON_BLOCK_FIELDS = [
  'comparisonSchemaVersion', 'stagePairs', 'unmatched', 'replanned', 'bookkeepingStageIds', 'runtimeCoverage',
];
// compare_runs leaves stagePairs out unless asked (see COMPARISON_ALLOWED).
const MCP_DEFAULT_FIELDS = COMPARISON_BLOCK_FIELDS.filter((f) => f !== 'stagePairs');

describe.skipIf(!existsSync(BASELINE))('CLI, MCP and dashboard parity on public corpus logs', () => {
  describe.each(CANDIDATES)('%s', (candidate) => {
    it.each([[false], [true]])('reports the same run (redact: %s) through the CLI and diagnose_run', async (redact) => {
      const cli = await cliJson([candidate, '--format', 'json', ...(redact ? ['--redact'] : [])]);
      const viaMcp = await mcpCall('diagnose_run', { source: { path: candidate }, include: INCLUDE_ALL, redact });

      // Sanity: the blocks the MCP default view gained are really compared.
      expect(Object.keys(cli)).toEqual(expect.arrayContaining(['writeTargets', 'metrics', 'effectiveConf']));
      expect(diffSurfaces(cli, viaMcp, RUN_REPORT_ALLOWED)).toEqual([]);
    });

    it('returns writeTargets, metrics and effectiveConf in diagnose_run\'s default view', async () => {
      const viaMcp = await mcpCall('diagnose_run', { source: { path: candidate } });
      expect(Object.keys(viaMcp)).toEqual(expect.arrayContaining(['writeTargets', 'metrics', 'effectiveConf']));
    });

    it.each([[false], [true]])('reports the same comparison (redact: %s) through the CLI and compare_runs', async (redact) => {
      const flags = redact ? ['--redact'] : [];
      const [line] = await cliLines([candidate, '--baseline', BASELINE, '--format', 'ndjson', ...flags]);
      const single = await cliJson([candidate, '--baseline', BASELINE, '--format', 'json', ...flags]);
      const viaMcp = await mcpCall('compare_runs', { sourceA: { path: BASELINE }, sourceB: { path: candidate }, redact });

      expect(line.comparison.metrics.find((m) => m.key === 'wallClock')).toMatchObject({ baseline: expect.any(Number), candidate: expect.any(Number) });
      expect(diffSurfaces(line.comparison, viaMcp, COMPARISON_ALLOWED)).toEqual([]);
      // The two CLI outputs are the same pair of blocks.
      expect(single).toEqual({ candidate: line.candidate, comparison: line.comparison });
      // The deprecated MCP names carry the same values as the CLI names.
      expect(viaMcp.metricDeltas).toEqual(viaMcp.metrics);
      expect(viaMcp.findingsDelta).toEqual(viaMcp.findings);
    });

    // Every field of the comparison block, on both surfaces and in the dashboard's compareRuns.
    it('reports every stage-pair field on the CLI, compare_runs and the dashboard', async () => {
      const [line] = await cliLines([candidate, '--baseline', BASELINE, '--format', 'ndjson']);
      const viaMcp = await mcpCall('compare_runs', { sourceA: { path: BASELINE }, sourceB: { path: candidate }, include: ['stagePairs'] });
      const viaMcpDefault = await mcpCall('compare_runs', { sourceA: { path: BASELINE }, sourceB: { path: candidate } });
      const dashboard = JSON.parse(JSON.stringify(comparisonOutput(await dashboardComparison(BASELINE, candidate))));
      for (const surface of [line.comparison, viaMcp, dashboard]) {
        expect(Object.keys(surface)).toEqual(expect.arrayContaining(COMPARISON_BLOCK_FIELDS));
        expect(surface.comparisonSchemaVersion).toBe(1);
        expect(surface.replanned).toEqual([]);
        expect(surface.confidence).toMatch(/^(ok|low|insufficient)$/);
      }
      for (const field of COMPARISON_BLOCK_FIELDS) expect(viaMcp[field]).toEqual(line.comparison[field]);
      // The default MCP view carries every other field and leaves only stagePairs out.
      expect(Object.keys(viaMcpDefault)).toEqual(expect.arrayContaining(MCP_DEFAULT_FIELDS));
      expect(viaMcpDefault).not.toHaveProperty('stagePairs');
      for (const field of MCP_DEFAULT_FIELDS) expect(viaMcpDefault[field]).toEqual(line.comparison[field]);
      // The corpus pair may share no stage: the shape of a pair is read from a run against itself.
      const [self] = await cliLines([BASELINE, '--baseline', BASELINE, '--format', 'ndjson']);
      expect(self.comparison.stagePairs[0]).toEqual({
        pairId: expect.any(String), baseStageIds: expect.any(Array), candStageIds: expect.any(Array),
        quality: 'exact', score: 1, deltas: expect.any(Object),
      });
      expect(Object.keys(self.comparison.stagePairs[0].deltas)).toEqual([
        'executorRunTime', 'executorCpuTime', 'memoryBytesSpilled', 'diskBytesSpilled',
        'inputBytes', 'outputBytes', 'shuffleReadBytes', 'shuffleWriteBytes',
      ]);
    });

    it('applies --normalize-path and normalizePath the same way', async () => {
      const patterns = ['/staging/[A-Za-z0-9]+/', 'unused-pattern-[0-9]+'];
      const flags = patterns.flatMap((p) => ['--normalize-path', p]);
      const [line] = await cliLines([candidate, '--baseline', BASELINE, '--format', 'ndjson', ...flags]);
      const viaMcp = await mcpCall('compare_runs', { sourceA: { path: BASELINE }, sourceB: { path: candidate }, normalizePath: patterns });
      expect(diffSurfaces(line.comparison, viaMcp, COMPARISON_ALLOWED)).toEqual([]);
    });

    it('reports the same comparison as the dashboard\'s compareRuns', async () => {
      const [line] = await cliLines([candidate, '--baseline', BASELINE, '--format', 'ndjson']);
      expect(line.comparison).toEqual(JSON.parse(JSON.stringify(comparisonOutput(await dashboardComparison(BASELINE, candidate)))));
    });

    it('reports the candidate block of a comparison as the same run report', async () => {
      const [line] = await cliLines([candidate, '--baseline', BASELINE, '--format', 'ndjson']);
      expect(line.candidate).toEqual(await cliJson([candidate, '--format', 'json']));
    });

    // Budgets carry no stage text, so redaction cannot move them: the CLI budgets the redacted
    // comparison and MCP has no redact input. Core's mcp-tools test shows it with host tokens.
    it.each([[false], [true]])('reports the same budget results (redact: %s) through the CLI and evaluate_budgets', async (redact) => {
      const [line] = await cliLines([
        candidate, '--baseline', BASELINE, '--format', 'ndjson',
        '--regression-budget', 'wallClock:5', '--regression-budget', 'gcTime:5', '--regression-budget', 'taskCount:5',
        '--fail-on-introduced', 'all', '--max-runtime', '1000000000', '--max-skew', '1', '--min-efficiency', '99',
        ...(redact ? ['--redact'] : []),
      ]);
      const viaMcp = await mcpCall('evaluate_budgets', {
        source: { path: BASELINE }, sourceB: { path: candidate },
        regressionBudgets: [{ metric: 'wallClock', maxPct: 5 }, { metric: 'gcTime', maxPct: 5 }, { metric: 'taskCount', maxPct: 5 }],
        failOnIntroduced: 'all', maxRuntimeMs: 1000000000, maxSkewRatio: 1, minEfficiencyPct: 99,
      });

      expect(line.budgets.filter((r) => r.name === 'max-regression').map((r) => r.metric)).toEqual(['wallClock', 'gcTime', 'taskCount']);
      // The CLI lists absolute budgets first, then regression; MCP evaluates in the same order.
      expect(diffSurfaces(line.budgets, viaMcp.results, BUDGETS_ALLOWED)).toEqual([]);
      expect(viaMcp.violated).toBe(line.exitCode === 1);
      expect(viaMcp.inconclusive).toBe(line.budgets.some((r) => r.status === 'inconclusive'));
    });
  });

  it('refuses an invalid --normalize-path, and one without --baseline, with a usage error', async () => {
    const invalid = await cliOutput([CANDIDATES[0], '--baseline', BASELINE, '--normalize-path', '(unclosed']);
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stderr).toMatch(/--normalize-path: Normalize pattern "\(unclosed" is not a valid regular expression/);
    expect(invalid.stdout).toBe('');

    const withoutBaseline = await cliOutput([CANDIDATES[0], '--normalize-path', 'x']);
    expect(withoutBaseline.exitCode).toBe(2);
    expect(withoutBaseline.stderr).toMatch(/--normalize-path require --baseline/);

    await expect(mcpCall('compare_runs', {
      sourceA: { path: BASELINE }, sourceB: { path: CANDIDATES[0] }, normalizePath: ['(unclosed'],
    })).rejects.toThrow(/normalizePath: Normalize pattern/);
  });

  it('keeps the stderr line and exit code the operator reads for a violated budget', async () => {
    const { stderr, exitCode } = await cliOutput([
      CANDIDATES[0], '--baseline', BASELINE, '--format', 'json', '--fail-on-introduced', 'all', '--max-runtime', '1',
    ]);
    expect(stderr).toMatch(/^\[violation\] max-runtime: .+$/m);
    expect(exitCode).toBe(1);
  });

  describe('tuned thresholds in Markdown', () => {
    let dir;
    let thresholdsPath;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'sparkforensics-parity-'));
      thresholdsPath = join(dir, 'thresholds.json');
      writeFileSync(thresholdsPath, JSON.stringify({ skew: { ratioWarn: 2 } }));
    });
    afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

    // The CLI names the tuned run in its report section, and compare_runs (which has no report
    // section) in its comparison section: one note on each surface, never two.
    it('names the tuned thresholds once on the CLI and once in compare_runs', async () => {
      const note = /^- Tuned thresholds( \(both runs\))?: skew ratioWarn 2/gm;
      const cli = (await cliOutput([CANDIDATES[0], '--baseline', BASELINE, '--format', 'md', '--thresholds', thresholdsPath])).stdout;
      expect(cli.match(note)).toHaveLength(1);

      const tuned = createMcpServer({ thresholds: { skew: { ratioWarn: 2 } } });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await tuned.connect(serverTransport);
      const client = new Client({ name: 'parity-test-tuned', version: '1.0.0' });
      await client.connect(clientTransport);
      try {
        const result = await client.callTool({
          name: 'compare_runs', arguments: { sourceA: { path: BASELINE }, sourceB: { path: CANDIDATES[0] }, format: 'md' },
        });
        expect(result.content[0].text.match(note)).toHaveLength(1);
      } finally {
        await client.close();
      }
    });
  });
});
