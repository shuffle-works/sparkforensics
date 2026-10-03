import { runFindings } from './evidence-report.ts';
import { redactRunModel } from './redact.ts';
import { computeRunMetrics, type RunMetrics } from './run-metrics.ts';
import { buildEffectiveConf, type EffectiveConf } from './effective-conf.ts';
import type { ThresholdOverrides } from './detectors.ts';
import type { AppModel } from './types.ts';

/** The CLI report's `metrics` and `effectiveConf` blocks, shared with MCP diagnose_run. Under
 * `redact` they come from the run redacted with the report's own inputs, so host and app
 * pseudonyms match the report's. `confKeys`/`confRedactRegex` narrow and mask `effectiveConf`. */
export function runOutputBlocks(
  appModel: AppModel,
  { redact, thresholds, confKeys, confRedactRegex }: {
    redact?: boolean; thresholds?: ThresholdOverrides; confKeys?: string[]; confRedactRegex?: string;
  } = {},
): { metrics: RunMetrics; effectiveConf: EffectiveConf | null } {
  let blocksModel = appModel;
  if (redact) {
    const { catalog, config } = runFindings(appModel, thresholds);
    blocksModel = redactRunModel(appModel, catalog, config).appModel;
  }
  return {
    metrics: computeRunMetrics(blocksModel, thresholds),
    effectiveConf: buildEffectiveConf(blocksModel.app, { keys: confKeys, userPattern: confRedactRegex }),
  };
}
