import { auditConfig } from './analyzer.ts';
import { redactRunModel } from './redact.ts';
import { computeRunMetrics, type RunMetrics } from './run-metrics.ts';
import { buildEffectiveConf, type EffectiveConf } from './effective-conf.ts';
import type { ThresholdOverrides } from './detectors.ts';
import type { AppModel, Finding } from './types.ts';

export interface RunOutputOptions {
  redact?: boolean; thresholds?: ThresholdOverrides;
  /** Narrows `effectiveConf` to these Spark properties. */
  confKeys?: string[];
  /** Extra pattern whose matching properties have their value withheld. */
  confRedactRegex?: string;
}

/** Additive blocks on a run's JSON report: each carries its own schemaVersion. Shared by the CLI
 * report and MCP diagnose_run. Under `redact` they come from the run redacted with the report's
 * own inputs, so host and app pseudonyms in stage fingerprints and conf values match the report's. */
export function runOutputBlocks(
  appModel: AppModel, catalog: Finding[], { redact, thresholds, confKeys, confRedactRegex }: RunOutputOptions = {},
): { metrics: RunMetrics; effectiveConf: EffectiveConf | null } {
  const blocksModel = redact ? redactRunModel(appModel, catalog, auditConfig(appModel.app)).appModel : appModel;
  return {
    metrics: computeRunMetrics(blocksModel, thresholds),
    effectiveConf: buildEffectiveConf(blocksModel.app, { keys: confKeys, userPattern: confRedactRegex }),
  };
}
