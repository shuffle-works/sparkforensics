// The CLI's JSON output as one typed value, built once here for every JSON mode (a single run, a
// run against a baseline, and each NDJSON line) so the shape never changes with the flags.
import type { BudgetResult } from './cli/budgets.ts';
import type { ComparisonOutput } from './comparison-output.ts';
import type { EvidenceReportJson } from './evidence-report.ts';
import type { runOutputBlocks } from './run-output.ts';

/** Bumped when the envelope's own keys change; the run's report carries its own `schemaVersion`. */
export const CLI_ENVELOPE_SCHEMA_VERSION = 1;

/** The evidence report of the analyzed run with the blocks the CLI and MCP share. */
export type CliRunReport = EvidenceReportJson & { notesHidden: number } & ReturnType<typeof runOutputBlocks>;

export interface CliEnvelope {
  schemaVersion: number;
  run: CliRunReport;
  /** Present when the run is compared with a baseline. */
  comparison?: ComparisonOutput;
  /** Every budget result, passes included; empty without budgets. */
  budgets: BudgetResult[];
}

export function cliRunReport(
  { json, notesHidden }: { json: EvidenceReportJson; notesHidden: number },
  blocks: ReturnType<typeof runOutputBlocks>,
): CliRunReport {
  return { ...json, notesHidden, ...blocks };
}

export function cliEnvelope(
  { run, comparison, budgets }: { run: CliRunReport; comparison?: ComparisonOutput; budgets: BudgetResult[] },
): CliEnvelope {
  return { schemaVersion: CLI_ENVELOPE_SCHEMA_VERSION, run, ...(comparison ? { comparison } : {}), budgets };
}
