import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  resolveOrCreateRun, diagnoseRun, getRunSummary, compareRuns, getFindingEvidence, getFindingDocumentation, getReferenceDoc, evaluateBudgetsForRun,
} from './mcp-tools.ts';
import { listRuns } from './list-runs.ts';
import type { ThresholdOverrides } from './detectors.ts';
import type { ReportGenerator } from './run-output.ts';
import { MAX_NORMALIZE_PATTERN_LENGTH, MAX_NORMALIZE_PATTERNS } from './stage-alignment.ts';

const sourceSchema = z.union([
  z.object({ path: z.string() }),
  z.object({ shsBaseUrl: z.string(), appId: z.string(), attemptId: z.string().optional() }),
]);

const runRefSchema = { source: sourceSchema.optional(), runId: z.string().optional() };
const secondRunRefSchema = { sourceB: sourceSchema.optional(), runIdB: z.string().optional() };
const formatSchema = { format: z.enum(['json', 'md']).optional() };

// list_runs takes a bare shsBaseUrl (no appId/attemptId, unlike sourceSchema's SHS branch, since
// it's listing candidates rather than resolving one), so it can't reuse sourceSchema: refine
// against both dir and shsBaseUrl being set instead, so one doesn't silently win over the other.
const listRunsInputSchema = z.object({
  dir: z.string().optional(),
  shsBaseUrl: z.string().optional(),
  namePattern: z.string().optional(),
  minDate: z.string().optional(),
  maxDate: z.string().optional(),
  maxResults: z.number().int().positive().optional(),
  redact: z.boolean().optional(),
}).refine((v) => !(v.dir && v.shsBaseUrl), { message: 'Provide only one of dir or shsBaseUrl, not both.' });

function toCallToolResult(text: string, structuredContent: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text' as const, text }], structuredContent };
}

function toolErrorResult(error: { message: string; code?: string }): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: error.message }],
    structuredContent: { code: error.code ?? 'access-or-upstream-failure' },
  };
}

// diagnoseRun/compareRuns may carry a `markdown` field (only when the caller asked for
// format: 'md'); it never belongs in structuredContent (whose shape must stay stable regardless of
// format), so it's stripped here and, when present, becomes content[0].text instead of JSON.stringify.
function toolResultWithMarkdown<T extends object>(promise: Promise<T & { markdown?: string }>): Promise<CallToolResult> {
  return promise.then(
    (value) => {
      const { markdown, ...structuredContent } = value;
      return toCallToolResult(markdown !== undefined ? markdown : JSON.stringify(structuredContent), structuredContent as Record<string, unknown>);
    },
    toolErrorResult,
  );
}

// Counterpart for the tools that never produce a markdown field: its own mapping, so there's no
// need to cast T to pretend it might carry a `markdown` field it never does.
function toolResult<T extends object>(promise: Promise<T>): Promise<CallToolResult> {
  return promise.then((value) => toCallToolResult(JSON.stringify(value), value as Record<string, unknown>), toolErrorResult);
}

// The handshake version of a server built without a `generator`: no package to read a version from.
const UNKNOWN_VERSION = '0.0.0';

// Shared by every tool that returns a run handle.
const RUN_ID_NOTE = 'runId is a handle for the run this server process has cached. It differs per tool by design (compare_runs returns runIdA and runIdB, evaluate_budgets the runId of its first run) and per server process, so match runs by app.id and app.attemptId, not by runId.';

/** `thresholds`: the bin's --thresholds overrides, applied to every analyzing tool for the life
 * of the server. Omitted, every tool runs the specification defaults.
 * `generator`: the host package's name, version and core build id. The server reports its version
 * in the MCP handshake and every diagnose_run and compare_runs result carries the block. */
export function createMcpServer(
  { thresholds, generator }: { thresholds?: ThresholdOverrides; generator?: ReportGenerator } = {},
): McpServer {
  const server = new McpServer({ name: 'sparkforensics', version: generator?.version ?? UNKNOWN_VERSION });

  server.registerTool('list_runs', {
    description: 'List candidate Spark event-log runs from a local directory or a Spark History Server, before diagnosing one with the other tools.',
    inputSchema: listRunsInputSchema,
  }, (params) => toolResult(listRuns(params)));

  server.registerTool('diagnose_run', {
    description: 'Diagnose a Spark run: the dashboard verdict (title, summary, and the top places to look, ranked by potential savings), thresholded findings with remediation text, an impact-ranked fix recommendation rollup, clean-check status, the checks the log lacked the data to run, and the writeTargets, metrics and effectiveConf blocks of the CLI report. When the server was started with --thresholds, findings and clean checks from a tuned detector carry tunedThresholds, and their impact estimates are uncalibrated. The result names the Spark application (app) and the build that wrote it (generator). ' + RUN_ID_NOTE,
    inputSchema: {
      ...runRefSchema, redact: z.boolean().optional(),
      include: z.array(z.enum(['summary', 'evidenceAvailability', 'detectors'])).optional(),
      impactBand: z.array(z.string()).optional(), type: z.array(z.string()).optional(), stageId: z.number().int().optional(),
      ...formatSchema,
    },
  }, ({ source, runId, redact, include, format, impactBand, type, stageId }) => toolResultWithMarkdown(
    resolveOrCreateRun({ source, runId }).then(({ runId: id }) =>
      diagnoseRun(id, { redact, include, markdown: format === 'md', impactBand, type, stageId, thresholds, generator })),
  ));

  server.registerTool('get_run_summary', {
    description: 'App/stage/job/sql counts, duration, and how the run ended (failed/total jobs and Spark\'s first-line failure reason) for a run, no findings.',
    inputSchema: { ...runRefSchema, redact: z.boolean().optional() },
  }, ({ source, runId, redact }) => toolResult(
    resolveOrCreateRun({ source, runId }).then(({ runId: id }) => getRunSummary(id, { redact, thresholds })),
  ));

  server.registerTool('compare_runs', {
    description: 'Compare two runs: the verdict, metric deltas (metrics), categorized findings delta (findings), the stage pairs (stagePairs) with the share of executor run time they cover (runtimeCoverage), and comparability: the configuration differences, plan equality, data volume, executor capacity and the factors that bridge the wall-clock difference. confidence is ok, low or insufficient. metricDeltas and findingsDelta repeat metrics and findings under their earlier names and will be removed. The result names both Spark applications (baselineApp, candidateApp) and the build that wrote it (generator). Each findings row lists its stage names in stages and the same names without call-site directories in stageLabels. ' + RUN_ID_NOTE,
    inputSchema: {
      runIdA: z.string().optional(), sourceA: sourceSchema.optional(),
      ...secondRunRefSchema,
      redact: z.boolean().optional(),
      include: z.array(z.enum(['stagePairs'])).optional()
        .describe('Extra blocks to return. stagePairs: one row per paired stage with its deltas, which can be large.'),
      normalizePath: z.array(z.string().max(MAX_NORMALIZE_PATTERN_LENGTH)).max(MAX_NORMALIZE_PATTERNS).optional()
        .describe('Regular expressions whose every match in a plan node\'s text is replaced with a fixed token before stages are paired, so run-specific text (an output directory that differs per run) does not keep the same stage from pairing. A generic pattern, not only for paths. Affects stage pairing, runtimeCoverage and confidence, never findings. A pattern that backtracks catastrophically can stall the server: keep them simple and anchored.'),
      ignoreConf: z.array(z.string().max(MAX_NORMALIZE_PATTERN_LENGTH)).max(MAX_NORMALIZE_PATTERNS).optional()
        .describe('Regular expressions matched against Spark configuration keys. A key that matches is left out of comparability.conf, for keys that differ by design such as a per-run output path. Per-run identity keys (application id, start time, driver address) are always left out.'),
      noiseBand: z.number().min(0).max(1).optional()
        .describe('Share of the baseline value under which a metric row is marked withinNoise (default 0.02). Never changes a row\'s direction.'),
      ...formatSchema,
    },
  }, ({ runIdA, sourceA, runIdB, sourceB, redact, include, normalizePath, ignoreConf, noiseBand, format }) => toolResultWithMarkdown(
    compareRuns({ runId: runIdA, source: sourceA }, { runId: runIdB, source: sourceB }, { redact, markdown: format === 'md', thresholds, normalizePath, ignoreConf, noiseBand, include, generator }),
  ));

  server.registerTool('evaluate_budgets', {
    description: 'Evaluate a run against pass/fail thresholds, optionally against a baseline run for regression budgets. With two runs, absolute budgets apply to the candidate (sourceB/runIdB), matching the CLI. A run with no ApplicationEnd always adds an inconclusive run-complete result. ' + RUN_ID_NOTE,
    inputSchema: {
      source: sourceSchema.optional().describe('The run to evaluate. When sourceB/runIdB is given, this is the regression baseline instead, and the absolute budgets apply to sourceB/runIdB.'),
      runId: runRefSchema.runId.describe('Same as `source`, referencing an already-resolved run by id.'),
      maxRuntimeMs: z.number().optional(), maxSpillGb: z.number().optional(), maxSkewRatio: z.number().optional(),
      maxFailedTaskRatePct: z.number().optional(), minEfficiencyPct: z.number().optional(),
      sourceB: sourceSchema.optional().describe('Optional candidate run, compared against source/runId as the regression baseline (maxRegressionPct/failOnIntroduced). When given, the absolute budgets (maxRuntimeMs etc.) are evaluated on this run.'),
      runIdB: secondRunRefSchema.runIdB.describe('Same as `sourceB`, referencing an already-resolved run by id.'),
      maxRegressionPct: z.number().optional(), regressionMetric: z.string().optional(), failOnIntroduced: z.string().optional(),
      regressionBudgets: z.array(z.object({ metric: z.string(), maxPct: z.number().nonnegative() })).optional()
        .describe('Further regression budgets, one per metric (the CLI\'s repeated --regression-budget). A metric can be budgeted once across this list and maxRegressionPct/regressionMetric.'),
      stageRegressionBudgets: z.array(z.object({ metric: z.string(), maxPct: z.number().nonnegative() })).optional()
        .describe('Per paired stage (needs sourceB/runIdB): fail when any eligible pair\'s metric (executorRunTime, executorCpuTime, memoryBytesSpilled, diskBytesSpilled, shuffleReadBytes, shuffleWriteBytes) regressed by more than maxPct. One entry per metric. Inconclusive when no stage pairs.'),
      stageQualities: z.array(z.enum(['exact', 'structural', 'aligned'])).optional()
        .describe('Pair qualities the stage budgets read. Default exact and structural: an aligned pair may compare different work.'),
    },
  }, ({
    source, runId, runIdB, sourceB,
    maxRuntimeMs, maxSpillGb, maxSkewRatio, maxFailedTaskRatePct, minEfficiencyPct,
    maxRegressionPct, regressionMetric, failOnIntroduced, regressionBudgets, stageRegressionBudgets, stageQualities,
  }) => toolResult(evaluateBudgetsForRun(
    { source, runId },
    { maxRuntimeMs, maxSpillGb, maxSkewRatio, maxFailedTaskRatePct, minEfficiencyPct, maxRegressionPct, regressionMetric, failOnIntroduced, regressionBudgets, stageRegressionBudgets, stageQualities },
    (runIdB || sourceB) ? { runId: runIdB, source: sourceB } : undefined,
    { thresholds },
  )));

  server.registerTool('get_finding_evidence', {
    description: 'Raw evidence bundle backing one finding, for drill-down after diagnose_run.',
    inputSchema: { runId: z.string(), findingId: z.string(), redact: z.boolean().optional() },
  }, ({ runId, findingId, redact }) => toolResult(
    Promise.resolve().then(() => getFindingEvidence(runId, findingId, { redact, thresholds })),
  ));

  server.registerTool('get_finding_documentation', {
    description: 'Detection and tuning reference documentation for one finding type (not tied to a specific run), so a client without browser access can read the same background material the web view links to.',
    inputSchema: { type: z.string() },
  }, ({ type }) => toolResult(
    Promise.resolve().then(() => getFindingDocumentation(type)),
  ));

  server.registerTool('get_reference_doc', {
    description: 'Full tuning-reference chapter or bottleneck markdown by doc anchor (e.g. "#joins", "#bottleneck-skew", "#metric-task-duration"), so a client without browser access can read the same reference the web view shows.',
    inputSchema: { anchor: z.string() },
  }, ({ anchor }) => toolResult(
    Promise.resolve().then(() => getReferenceDoc(anchor)),
  ));

  return server;
}
