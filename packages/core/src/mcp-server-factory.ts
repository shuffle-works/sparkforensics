import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  resolveOrCreateRun, diagnoseRun, getRunSummary, compareRuns, getFindingEvidence, getFindingDocumentation, getReferenceDoc, evaluateBudgetsForRun,
} from './mcp-tools.ts';
import { listRuns } from './list-runs.ts';

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

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'sparkforensics', version: '1.0.0' });

  server.registerTool('list_runs', {
    description: 'List candidate Spark event-log runs from a local directory or a Spark History Server, before diagnosing one with the other tools.',
    inputSchema: listRunsInputSchema,
  }, (params) => toolResult(listRuns(params)));

  server.registerTool('diagnose_run', {
    description: 'Diagnose a Spark run: thresholded findings with remediation text, an impact-ranked fix recommendation rollup, and clean-check status.',
    inputSchema: {
      ...runRefSchema, redact: z.boolean().optional(),
      include: z.array(z.enum(['summary', 'evidenceAvailability', 'detectors'])).optional(),
      impactBand: z.array(z.string()).optional(), type: z.array(z.string()).optional(), stageId: z.number().int().optional(),
      ...formatSchema,
    },
  }, ({ source, runId, redact, include, format, impactBand, type, stageId }) => toolResultWithMarkdown(
    resolveOrCreateRun({ source, runId }).then(({ runId: id }) =>
      diagnoseRun(id, { redact, include, markdown: format === 'md', impactBand, type, stageId })),
  ));

  server.registerTool('get_run_summary', {
    description: 'App/stage/job/sql counts and duration for a run, no findings.',
    inputSchema: { ...runRefSchema, redact: z.boolean().optional() },
  }, ({ source, runId, redact }) => toolResult(
    resolveOrCreateRun({ source, runId }).then(({ runId: id }) => getRunSummary(id, { redact })),
  ));

  server.registerTool('compare_runs', {
    description: 'Compare two runs: categorized findings delta and metric deltas.',
    inputSchema: {
      runIdA: z.string().optional(), sourceA: sourceSchema.optional(),
      ...secondRunRefSchema,
      redact: z.boolean().optional(),
      ...formatSchema,
    },
  }, ({ runIdA, sourceA, runIdB, sourceB, redact, format }) => toolResultWithMarkdown(
    compareRuns({ runId: runIdA, source: sourceA }, { runId: runIdB, source: sourceB }, { redact, markdown: format === 'md' }),
  ));

  server.registerTool('evaluate_budgets', {
    description: 'Evaluate a run against pass/fail thresholds, optionally against a baseline run for regression budgets. With two runs, absolute budgets apply to the candidate (sourceB/runIdB), matching the CLI. A run with no ApplicationEnd always adds an inconclusive run-complete result.',
    inputSchema: {
      source: sourceSchema.optional().describe('The run to evaluate. When sourceB/runIdB is given, this is the regression baseline instead, and the absolute budgets apply to sourceB/runIdB.'),
      runId: runRefSchema.runId.describe('Same as `source`, referencing an already-resolved run by id.'),
      maxRuntimeMs: z.number().optional(), maxSpillGb: z.number().optional(), maxSkewRatio: z.number().optional(),
      maxFailedTaskRatePct: z.number().optional(), minEfficiencyPct: z.number().optional(),
      sourceB: sourceSchema.optional().describe('Optional candidate run, compared against source/runId as the regression baseline (maxRegressionPct/failOnIntroduced). When given, the absolute budgets (maxRuntimeMs etc.) are evaluated on this run.'),
      runIdB: secondRunRefSchema.runIdB.describe('Same as `sourceB`, referencing an already-resolved run by id.'),
      maxRegressionPct: z.number().optional(), regressionMetric: z.string().optional(), failOnIntroduced: z.string().optional(),
    },
  }, ({
    source, runId, runIdB, sourceB,
    maxRuntimeMs, maxSpillGb, maxSkewRatio, maxFailedTaskRatePct, minEfficiencyPct,
    maxRegressionPct, regressionMetric, failOnIntroduced,
  }) => toolResult(evaluateBudgetsForRun(
    { source, runId },
    { maxRuntimeMs, maxSpillGb, maxSkewRatio, maxFailedTaskRatePct, minEfficiencyPct, maxRegressionPct, regressionMetric, failOnIntroduced },
    (runIdB || sourceB) ? { runId: runIdB, source: sourceB } : undefined,
  )));

  server.registerTool('get_finding_evidence', {
    description: 'Raw evidence bundle backing one finding, for drill-down after diagnose_run.',
    inputSchema: { runId: z.string(), findingId: z.string(), redact: z.boolean().optional() },
  }, ({ runId, findingId, redact }) => toolResult(
    Promise.resolve().then(() => getFindingEvidence(runId, findingId, { redact })),
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
