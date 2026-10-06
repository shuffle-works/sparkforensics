import { runFindings } from './evidence-report.ts';
import { redactRunModel } from './redact.ts';
import { computeRunMetrics, type RunMetrics } from './run-metrics.ts';
import { buildEffectiveConf, type EffectiveConf } from './effective-conf.ts';
import type { ThresholdOverrides } from './detectors.ts';
import type { AppModel } from './types.ts';

/** Which build wrote a report: the host package's name and version, and the build id of the core it
 * loaded. Core does not know its host, so the surface passes it in. */
export interface ReportGenerator {
  name: string;
  version: string;
  buildId: string;
}

/** The CLI report's `metrics` and `effectiveConf` blocks, shared with MCP diagnose_run. Under
 * `redact` they come from the run redacted with the report's own inputs, so host and app
 * pseudonyms match the report's. `confKeys`/`confRedactRegex` narrow and mask `effectiveConf`.
 * `generator`, when the surface supplies it, is returned as given: it holds no run identifiers. */
export function runOutputBlocks(
  appModel: AppModel,
  { redact, thresholds, confKeys, confRedactRegex, generator }: {
    redact?: boolean; thresholds?: ThresholdOverrides; confKeys?: string[]; confRedactRegex?: string;
    generator?: ReportGenerator;
  } = {},
): { generator?: ReportGenerator; metrics: RunMetrics; effectiveConf: EffectiveConf | null } {
  let blocksModel = appModel;
  if (redact) {
    const { catalog, config } = runFindings(appModel, thresholds);
    blocksModel = redactRunModel(appModel, catalog, config).appModel;
  }
  return {
    ...(generator ? { generator } : {}),
    metrics: computeRunMetrics(blocksModel, thresholds),
    effectiveConf: buildEffectiveConf(blocksModel.app, { keys: confKeys, userPattern: confRedactRegex }),
  };
}
