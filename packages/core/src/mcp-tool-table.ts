import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  resolveOrCreateRun, diagnoseRun, diagnoseHeadline, getRunSummary, compareRuns, resolveFindingEvidence, getFindingDocumentation, getReferenceDoc, evaluateBudgetsForRun,
  type DiagnoseRunResult,
} from './mcp-tools.ts';
import { paginateDiagnose, DEFAULT_PAGE_CHARS } from './diagnose-pagination.ts';
import { listRuns } from './list-runs.ts';
import type { ThresholdOverrides } from './detectors.ts';
import type { ReportGenerator } from './run-output.ts';
import { MAX_NORMALIZE_PATTERN_LENGTH, MAX_NORMALIZE_PATTERNS } from './stage-alignment.ts';
import { IMPACT_BANDS } from './impact-band-order.ts';
import { COMPARISON_METRIC_KEYS } from './run-comparison.ts';
import { FINDING_TYPES } from './cli/flag-values.ts';
import { listDetectors } from './detector-listing.ts';
import { deprecationNote } from './deprecations.ts';

// z.enum wants a non-empty tuple; these lists are never empty.
const nonEmpty = <T extends string>(values: readonly T[]) => values as [T, ...T[]];
const impactBandSchema = z.enum(nonEmpty(IMPACT_BANDS));
const findingTypeSchema = z.enum(nonEmpty(FINDING_TYPES));
const comparisonMetricSchema = z.enum(nonEmpty(COMPARISON_METRIC_KEYS));

// With a server default, shsBaseUrl is optional and falls back to it; without one it is required.
function buildSourceSchema(defaultShsBaseUrl?: string) {
  return z.union([
    z.object({ path: z.string() }),
    z.object({
      shsBaseUrl: defaultShsBaseUrl ? z.string().default(defaultShsBaseUrl) : z.string(),
      appId: z.string(), attemptId: z.string().optional(),
    }),
  ]);
}

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

// A Node file-system error (EACCES, ENOENT, EISDIR, ELOOP, ...) carries its errno name as `code` and
// the absolute path in its message. It is reported under a documented code, with the errno name and
// no path: invalid-event-log for the tools that read an event log, access-or-upstream-failure for the
// documentation tools, which read only bundled files.
const ERRNO_CODE = /^E[A-Z0-9]+$/;

function errorResultMapper(errnoText: string, errnoCode: string) {
  return (error: { message: string; code?: string }): CallToolResult => {
    if (error.code !== undefined && ERRNO_CODE.test(error.code)) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `${errnoText} (${error.code}).` }],
        structuredContent: { code: errnoCode },
      };
    }
    return {
      isError: true,
      content: [{ type: 'text' as const, text: error.message }],
      structuredContent: { code: error.code ?? 'access-or-upstream-failure' },
    };
  };
}

const toolErrorResult = errorResultMapper('The event log could not be read', 'invalid-event-log');
const docToolErrorResult = errorResultMapper('A documentation file could not be read', 'access-or-upstream-failure');

// compareRuns may carry a `markdown` field (only when the caller asked for
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

// With `format: 'md'` the Markdown is the content, and structuredContent holds it too, with a few headline fields.
function diagnoseToolResult(promise: Promise<object & { markdown?: string }>): Promise<CallToolResult> {
  return promise.then(
    (value) => {
      const { markdown, ...structuredContent } = value;
      return markdown !== undefined
        ? toCallToolResult(markdown, { ...diagnoseHeadline(value as DiagnoseRunResult), markdown })
        : toCallToolResult(JSON.stringify(structuredContent), structuredContent as Record<string, unknown>);
    },
    toolErrorResult,
  );
}

// Counterpart for the tools that never produce a markdown field: its own mapping, so there's no
// need to cast T to pretend it might carry a `markdown` field it never does.
function toolResult<T extends object>(promise: Promise<T>, onError = toolErrorResult): Promise<CallToolResult> {
  return promise.then((value) => toCallToolResult(JSON.stringify(value), value as Record<string, unknown>), onError);
}

// Shared by every tool that returns a run handle.
const RUN_ID_NOTE = 'A run id is a handle for the run this server process has cached. It differs per server process, so match runs by app.id and app.attemptId, not by run id.';

/** Where the CLI gives the same data as a tool: `twin` names the command or flag mode, `none` the reason there is no twin. */
export type CliParity = { twin: string } | { none: string };

type ToolInput = z.ZodRawShape | z.ZodType;
type ToolArgs<I extends ToolInput> = I extends z.ZodType ? z.infer<I> : I extends z.ZodRawShape ? z.infer<z.ZodObject<I>> : never;

/** One MCP tool: what `createMcpServer` registers, and the CLI twin that is the parity decision for it.
 * `outputSchema` describes the `structuredContent` of a successful call; error results are not checked against it. */
export interface McpToolEntry {
  name: string;
  description: string;
  inputSchema: ToolInput;
  outputSchema: z.ZodRawShape;
  // Each entry types its own arguments through `tool()`; the table holds them all, so they are widened here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any) => Promise<CallToolResult>;
  cli: CliParity;
}

function tool<I extends ToolInput>(
  entry: Omit<McpToolEntry, 'inputSchema' | 'handler'> & { inputSchema: I; handler: (args: ToolArgs<I>) => Promise<CallToolResult> },
): McpToolEntry {
  return entry;
}

export interface McpToolContext {
  thresholds?: ThresholdOverrides;
  generator?: ReportGenerator;
  defaultShsBaseUrl?: string;
}

// Output shapes. Each lists the top-level keys a tool's successful call returns; nested payloads
// stay loose. The server registers them as loose objects, so a key not listed here is allowed.
const outputRunId = z.string().describe('The handle of the run this server process has cached.');

const listRunsOutput = { runs: z.array(z.unknown()), truncated: z.boolean() };

const diagnoseRunOutput = {
  runId: outputRunId, runComplete: z.boolean(),
  view: z.enum(['compact', 'full']).optional(),
  verdict: z.unknown().optional(),
  findings: z.array(z.unknown()).optional(),
  findingsOmitted: z.number().optional(), notesHidden: z.number().optional(),
  recommendations: z.array(z.unknown()).optional(),
  cleanChecks: z.array(z.unknown()).optional(), notRunChecks: z.array(z.unknown()).optional(),
  writeTargets: z.unknown().optional(), metrics: z.unknown().optional(), effectiveConf: z.unknown().optional(),
  tunedThresholds: z.unknown().optional(),
  pagination: z.unknown().optional(),
  // With format "md": the Markdown and the headline fields.
  markdown: z.string().optional(), title: z.string().optional(),
  findingCount: z.number().optional(), recommendationCount: z.number().optional(),
};

const getRunSummaryOutput = {
  runId: outputRunId,
  app: z.object({ id: z.string().nullable(), name: z.string().nullable(), sparkVersion: z.string().nullable() }),
  stageCount: z.number(), jobCount: z.number(), sqlExecutionCount: z.number(),
  executorCount: z.object({ added: z.number(), removed: z.number() }),
  durationMs: z.number().nullable(), skippedLines: z.number(), runComplete: z.boolean(),
  runShape: z.unknown(),
};

const compareRunsOutput = {
  baselineRunId: outputRunId, candidateRunId: outputRunId,
  runIdA: z.string().optional().describe(`Same as baselineRunId. ${deprecationNote('compare_runs result', 'runIdA')}`),
  runIdB: z.string().optional().describe(`Same as candidateRunId. ${deprecationNote('compare_runs result', 'runIdB')}`),
  verdict: z.unknown().optional(), metrics: z.unknown().optional(), findings: z.unknown().optional(),
  comparability: z.unknown().optional(), stagePairs: z.unknown().optional(), runtimeCoverage: z.unknown().optional(),
};

const evaluateBudgetsOutput = {
  baselineRunId: z.string().optional().describe('Present with two runs: the regression baseline.'),
  candidateRunId: outputRunId,
  runId: z.string().optional().describe(`The first run's id: the baseline when two runs are given, so read candidateRunId for the run the budgets judged. ${deprecationNote('evaluate_budgets result', 'runId')}`),
  results: z.array(z.unknown()), violated: z.boolean(), inconclusive: z.boolean(),
  tunedThresholds: z.unknown().optional(),
};

const getFindingEvidenceOutput = { runId: outputRunId, finding: z.record(z.string(), z.unknown()) };

const getFindingDocumentationOutput = {
  type: z.string(), name: z.string(), detectionDoc: z.unknown(), tuningDoc: z.unknown(),
};

const listDetectorsOutput = { count: z.number(), detectors: z.array(z.unknown()) };

const getReferenceDocOutput = { anchor: z.string(), title: z.string(), content: z.string() };

/** The table of MCP tools: one entry per tool, each with its input and output schemas, its handler
 * and its CLI twin. `createMcpServer` registers exactly these. */
export function mcpToolEntries({ thresholds, generator, defaultShsBaseUrl }: McpToolContext = {}): McpToolEntry[] {
  const sourceSchema = buildSourceSchema(defaultShsBaseUrl);
  const runRefSchema = { source: sourceSchema.optional(), runId: z.string().optional() };
  const secondRunRefSchema = { sourceB: sourceSchema.optional(), runIdB: z.string().optional() };
  return [
    tool({
      name: 'list_runs',
      description: 'List candidate Spark event-log runs from a local directory or a Spark History Server, before diagnosing one with the other tools.',
      inputSchema: listRunsInputSchema,
      outputSchema: listRunsOutput,
      cli: { none: 'The CLI takes a log path or directory as its input and has no listing mode; list_runs finds the candidates to pass to the other tools.' },
      handler: (params) => toolResult(listRuns({ ...params, shsBaseUrl: params.shsBaseUrl ?? (params.dir ? undefined : defaultShsBaseUrl) })),
    }),

    tool({
      name: 'diagnose_run',
      description: 'Diagnose a Spark run: the dashboard verdict (title, summary, and the top places to look, ranked by stage task time or idle core time, then potential savings, each with its lead finding), findings, an impact-ranked fix recommendation rollup, and the writeTargets, metrics and effectiveConf blocks of the CLI report. view "compact" (the default) lists one short row per finding and leaves out the clean-check and not-checked lists; view "full" returns every finding with its remediation text and evidence, and those lists. Every finding row has a key that stays the same for the same finding in a rerun of the job (compare_runs rows list the same keys), and an id for get_finding_evidence. With format "md" the content is Markdown, and structuredContent holds it as markdown next to a few headline fields. A JSON result longer than ' + DEFAULT_PAGE_CHARS + ' characters comes in pages: pass pagination.nextCursor as cursor, with the other arguments unchanged, for the next one. When the server was started with --thresholds, findings and clean checks from a tuned detector carry tunedThresholds, and their impact estimates are uncalibrated. The result names the Spark application (app) and the build that wrote it (generator). ' + RUN_ID_NOTE,
      inputSchema: {
        ...runRefSchema, redact: z.boolean().optional(),
        view: z.enum(['compact', 'full']).optional()
          .describe('compact (default): one short row per finding. full: the CLI report\'s rows, clean checks and not-checked checks.'),
        include: z.array(z.enum(['summary', 'evidenceAvailability', 'detectors'])).optional(),
        impactBand: z.array(impactBandSchema).optional(), type: z.array(findingTypeSchema).optional(), stageId: z.number().int().nonnegative().optional(),
        minBand: impactBandSchema.optional()
          .describe('List only findings at this band or a more severe one. Without minBand or impactBand, info findings are left out and notesHidden counts them; "info" lists all.'),
        maxFindings: z.number().int().nonnegative().optional()
          .describe('List at most this many findings, most severe first. findingsOmitted counts the ones left out; each verdict step still carries its lead finding.'),
        cursor: z.string().optional()
          .describe('The pagination.nextCursor of the previous page. Not used with format "md".'),
        ...formatSchema,
      },
      outputSchema: diagnoseRunOutput,
      cli: { twin: 'sparkforensics-analyze <log>' },
      handler: ({ source, runId, redact, include, format, impactBand, type, stageId, view, minBand, maxFindings, cursor }) => diagnoseToolResult(
        resolveOrCreateRun({ source, runId }, { thresholds }).then(({ runId: id }) => paginateDiagnose(
          diagnoseRun(id, { redact, include, markdown: format === 'md', impactBand, type, stageId, thresholds, generator, view: view ?? 'compact', minBand, maxFindings }),
          { cursor },
        )),
      ),
    }),

    tool({
      name: 'get_run_summary',
      description: 'App/stage/job/sql counts, duration, and how the run ended (failed/total jobs and Spark\'s first-line failure reason) for a run, no findings.',
      inputSchema: { ...runRefSchema, redact: z.boolean().optional() },
      outputSchema: getRunSummaryOutput,
      cli: { twin: 'sparkforensics-analyze <log>' },
      handler: ({ source, runId, redact }) => toolResult(
        resolveOrCreateRun({ source, runId }, { thresholds }).then(({ runId: id }) => getRunSummary(id, { redact, thresholds })),
      ),
    }),

    tool({
      name: 'compare_runs',
      description: 'Compare two runs: the verdict, metric deltas (metrics), categorized findings delta (findings), the stage pairs (stagePairs) with the share of executor run time they cover (runtimeCoverage), and comparability: the configuration differences, plan equality, data volume, executor capacity and the factors that bridge the wall-clock difference. confidence is ok, low or insufficient. The result names both Spark applications (baselineApp, candidateApp) and the build that wrote it (generator). Each findings row lists its stage names in stages and the same names without call-site directories in stageLabels. ' + RUN_ID_NOTE,
      inputSchema: {
        baselineRunId: z.string().optional().describe('The baseline run, by the run id of an earlier call.'),
        candidateRunId: z.string().optional().describe('The candidate run, by the run id of an earlier call.'),
        runIdA: z.string().optional().describe(`Same as baselineRunId. ${deprecationNote('compare_runs input', 'runIdA')}`),
        runIdB: z.string().optional().describe(`Same as candidateRunId. ${deprecationNote('compare_runs input', 'runIdB')}`),
        sourceA: sourceSchema.optional(), sourceB: sourceSchema.optional(),
        redact: z.boolean().optional(),
        include: z.array(z.enum(['stagePairs'])).optional()
          .describe('Extra blocks to return. stagePairs: one row per paired stage with its deltas, which can be large.'),
        normalizePath: z.array(z.string().max(MAX_NORMALIZE_PATTERN_LENGTH)).max(MAX_NORMALIZE_PATTERNS).optional()
          .describe('Regular expressions whose every match in a plan node\'s text is replaced with a fixed token before stages are paired, so run-specific text (an output directory that differs per run) does not keep the same stage from pairing. A generic pattern, not only for paths. Affects stage pairing, runtimeCoverage and confidence, never findings. A pattern that backtracks catastrophically can stall the server: keep them simple and anchored.'),
        ignoreConf: z.array(z.string().max(MAX_NORMALIZE_PATTERN_LENGTH)).max(MAX_NORMALIZE_PATTERNS).optional()
          .describe('Regular expressions matched against Spark configuration keys. A key that matches is left out of comparability.conf, for keys that differ by design such as a per-run output path. Per-run identity keys (application id, start time, driver address) are always left out.'),
        noiseBand: z.number().min(0).max(1).optional()
          .describe('Share of the baseline value under which a metric row is marked withinNoise (default 0.02). Never changes a row\'s direction.'),
        executorRatio: z.number().min(1).optional()
          .describe('Factor by which mean executors must differ, either way, for the verdict to say the wall-clock change reflects executor availability (default 1.5). Sets comparability.caveats.executors.'),
        unmatchedShare: z.number().min(0).max(1).optional()
          .describe('Share of the baseline\'s stages that pair with no candidate stage above which the verdict says the plans differ (default 0.2). Sets comparability.caveats.unmatchedStages.'),
        taskCountChange: z.number().min(0).optional()
          .describe('Relative task-count change above which the verdict calls out the task count change (default 0.25). Sets comparability.caveats.taskCount.'),
        ...formatSchema,
      },
      outputSchema: compareRunsOutput,
      cli: { twin: 'sparkforensics-analyze <log> --baseline <log>' },
      handler: ({ baselineRunId, candidateRunId, runIdA, sourceA, runIdB, sourceB, redact, include, normalizePath, ignoreConf, noiseBand, executorRatio, unmatchedShare, taskCountChange, format }) => toolResultWithMarkdown(
        compareRuns({ runId: baselineRunId ?? runIdA, source: sourceA }, { runId: candidateRunId ?? runIdB, source: sourceB }, { redact, markdown: format === 'md', thresholds, normalizePath, ignoreConf, noiseBand, caveatThresholds: { executorRatio, unmatchedShare, taskCountChange }, include, generator }),
      ),
    }),

    tool({
      name: 'evaluate_budgets',
      description: 'Evaluate a run against pass/fail thresholds, optionally against a baseline run for regression budgets. With two runs, absolute budgets apply to the candidate (sourceB/runIdB), matching the CLI. The candidateRunId in the result names the run the budgets judged; the deprecated runId names the baseline (the first run) when two runs are given. A run with no ApplicationEnd always adds an inconclusive run-complete result, and a run with skipped log lines an inconclusive parse-incomplete result. ' + RUN_ID_NOTE,
      inputSchema: {
        source: sourceSchema.optional().describe('The run to evaluate. When sourceB/runIdB is given, this is the regression baseline instead, and the absolute budgets apply to sourceB/runIdB.'),
        runId: runRefSchema.runId.describe('Same as `source`, referencing an already-resolved run by id.'),
        maxRuntimeMs: z.number().nonnegative().optional(), maxSpillGb: z.number().nonnegative().optional(), maxSkewRatio: z.number().nonnegative().optional(),
        maxFailedTaskRatePct: z.number().nonnegative().optional(), minEfficiencyPct: z.number().nonnegative().optional(),
        sourceB: sourceSchema.optional().describe('Optional candidate run, compared against source/runId as the regression baseline (maxRegressionPct/failOnIntroduced). When given, the absolute budgets (maxRuntimeMs etc.) are evaluated on this run.'),
        runIdB: secondRunRefSchema.runIdB.describe('Same as `sourceB`, referencing an already-resolved run by id.'),
        maxRegressionPct: z.number().nonnegative().optional(), regressionMetric: comparisonMetricSchema.optional(),
        failOnIntroduced: z.enum(['all', ...nonEmpty(IMPACT_BANDS)]).optional(),
        regressionBudgets: z.array(z.object({ metric: comparisonMetricSchema, maxPct: z.number().nonnegative() })).optional()
          .describe('Further regression budgets, one per metric (the CLI\'s repeated --regression-budget). A metric can be budgeted once across this list and maxRegressionPct/regressionMetric.'),
        stageRegressionBudgets: z.array(z.object({ metric: z.string(), maxPct: z.number().nonnegative() })).optional()
          .describe('Per paired stage (needs sourceB/runIdB): fail when any eligible pair\'s metric (executorRunTime, executorCpuTime, memoryBytesSpilled, diskBytesSpilled, shuffleReadBytes, shuffleWriteBytes) regressed by more than maxPct. One entry per metric. Inconclusive when no stage pairs.'),
        stageQualities: z.array(z.enum(['exact', 'structural', 'aligned'])).optional()
          .describe('Pair qualities the stage budgets read. Default exact and structural: an aligned pair may compare different work.'),
      },
      outputSchema: evaluateBudgetsOutput,
      cli: { twin: 'sparkforensics-analyze <log> with the budget flags, and --baseline <log> for regression budgets' },
      handler: ({
        source, runId, runIdB, sourceB,
        maxRuntimeMs, maxSpillGb, maxSkewRatio, maxFailedTaskRatePct, minEfficiencyPct,
        maxRegressionPct, regressionMetric, failOnIntroduced, regressionBudgets, stageRegressionBudgets, stageQualities,
      }) => toolResult(evaluateBudgetsForRun(
        { source, runId },
        { maxRuntimeMs, maxSpillGb, maxSkewRatio, maxFailedTaskRatePct, minEfficiencyPct, maxRegressionPct, regressionMetric, failOnIntroduced, regressionBudgets, stageRegressionBudgets, stageQualities },
        (runIdB || sourceB) ? { runId: runIdB, source: sourceB } : undefined,
        { thresholds },
      )),
    }),

    tool({
      name: 'get_finding_evidence',
      description: 'Raw evidence bundle backing one finding, for drill-down after diagnose_run. Pass the runId of the diagnosis. When the runId is not cached (after a server restart), pass the source of the run, as for diagnose_run, and optionally its appId: the run is analysed again and the findingId stays the same.',
      inputSchema: {
        runId: z.string().optional(), source: sourceSchema.optional(),
        appId: z.string().optional().describe('The application the source must hold. Needs source.'),
        findingId: z.string(), redact: z.boolean().optional(),
      },
      outputSchema: getFindingEvidenceOutput,
      cli: { twin: 'sparkforensics-analyze <log>' },
      handler: ({ runId, source, appId, findingId, redact }) => toolResult(
        resolveFindingEvidence({ runId, source, appId }, findingId, { redact, thresholds }),
      ),
    }),

    tool({
      name: 'get_finding_documentation',
      description: 'Detection and tuning reference documentation for one finding type (not tied to a specific run), so a client without browser access can read the same background material the web view links to.',
      inputSchema: { type: z.string() },
      outputSchema: getFindingDocumentationOutput,
      cli: { none: 'The CLI lists a type\'s documentation paths in `detectors` but does not print the documentation text.' },
      handler: ({ type }) => toolResult(
        Promise.resolve().then(() => getFindingDocumentation(type)),
        docToolErrorResult,
      ),
    }),

    tool({
      name: 'list_detectors',
      description: 'Every finding type SparkForensics can report, with no run needed: its tag, outcome family, scope, fix effort, one-sentence pitch, default thresholds, docs paths, and the budget flag that gates it, when it has one. Pass a type for that one record. Docs paths are relative to the published site root.',
      inputSchema: { type: findingTypeSchema.optional() },
      outputSchema: listDetectorsOutput,
      cli: { twin: 'sparkforensics-analyze detectors' },
      handler: ({ type }) => toolResult(Promise.resolve().then(() => listDetectors(type))),
    }),

    tool({
      name: 'get_reference_doc',
      description: 'Full tuning-reference chapter or bottleneck markdown by doc anchor (e.g. "#joins", "#bottleneck-skew", "#metric-task-duration"), so a client without browser access can read the same reference the web view shows.',
      inputSchema: { anchor: z.string() },
      outputSchema: getReferenceDocOutput,
      cli: { none: 'The tuning reference is bundled documentation, not analysis of a log; the CLI has no command that prints it.' },
      handler: ({ anchor }) => toolResult(
        Promise.resolve().then(() => getReferenceDoc(anchor)),
        docToolErrorResult,
      ),
    }),
  ];
}
