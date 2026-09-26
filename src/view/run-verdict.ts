// The verdict's ranking, grouping and wording, and the savings formatting, live in core (shared
// with the CLI/MCP report); re-exported here for the view modules and tests that import them from
// this path.
export { estimateProvenance, savingsMeaning } from '@sparkforensics/core/impact-format.ts';
export {
  buildNextSteps, IDLE_NOTABLE_PCT, isIdleCapacityStep, locationKey, NEXT_STEP_LIMIT, verdictIdlePct, type NextStep,
} from '@sparkforensics/core/run-verdict.ts';
