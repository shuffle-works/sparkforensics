import { effectiveSparkConf, executorOverheadSettings, overlayModifiedConfigs } from '../spark-conf.ts';
import type { DetectorApp, DetectorConfigTarget, DetectorCtx, DetectorStage } from './types.ts';

// True when any stage ran outside a SQL execution: RDD API work, which spark.serializer governs.
export function hasStageOutsideSql(stages: DetectorConfigTarget['stages']): boolean {
  if (stages == null) return false;
  for (const stage of stages.values()) if (stage.sqlExecutionId == null) return true;
  return false;
}

// The run's effective value of a property: the logged one, else Spark's default for the run's
// version (spark-conf.ts). A detector scoped to one SQL execution passes that execution's app (see
// queryApp) so the settings it ran with count.
export function effectiveConf(app: DetectorApp | null, key: string): string | undefined {
  return effectiveSparkConf({ sparkVersion: app?.sparkVersion, properties: app?.config }, key)?.value;
}

// The factor and minimum Spark applies to size the executor overhead when spark.executor.memoryOverhead
// is unset (spark-conf.ts's executorOverheadSettings); `fallback` is the detector's default pair.
export function defaultOverheadSettings(app: DetectorApp | null, fallback: { floorMB: number; floorPct: number }): { minMB: number; factor: number } {
  return executorOverheadSettings({ sparkVersion: app?.sparkVersion, properties: app?.config }, fallback);
}

const queryAppCache = new WeakMap<object, { base: DetectorApp | null; derived: DetectorApp }>();

// The app as one SQL execution saw it: its modifiedConfigs applied over the logged properties, so
// effectiveConf reads what `spark.conf.set` changed. The app itself when the execution modified
// nothing.
export function queryApp(app: DetectorApp | null, modified: Record<string, string> | undefined): DetectorApp | null {
  if (modified == null) return app;
  const cached = queryAppCache.get(modified);
  if (cached?.base === app) return cached.derived;
  const config = overlayModifiedConfigs(app?.config, modified);
  if (config === app?.config) return app;
  const derived: DetectorApp = { ...app, config };
  queryAppCache.set(modified, { base: app, derived });
  return derived;
}

// The app as the stage's SQL execution saw it; the run's app for a stage outside any SQL execution.
export function stageApp(ctx: DetectorCtx, stage: Pick<DetectorStage, 'sqlExecutionId'>): DetectorApp | null {
  return queryApp(ctx.app, stage.sqlExecutionId != null ? ctx.sql.get(stage.sqlExecutionId)?.modifiedConfigs : undefined);
}

// A setting is only a fix when the run's effective conf doesn't already have it: a run that set it,
// or whose Spark version defaults to it, needs another remedy. Booleans compare case-insensitively,
// as Spark parses them.
export function loggedAs(app: DetectorApp | null, key: string, suggested: string | boolean): boolean {
  const effective = effectiveConf(app, key);
  return typeof suggested === 'boolean'
    ? effective?.toLowerCase() === String(suggested)
    : effective === suggested;
}

// No dynamic-allocation property has an effect on a run that has it off: Spark's default is off, so
// an unset property counts as off, as it does for idleCapacityFix.
export function dynamicAllocationOff(app: DetectorApp | null): boolean {
  if (app?.resources?.dynamicAllocationEnabled != null) return !app.resources.dynamicAllocationEnabled;
  return !loggedAs(app, 'spark.dynamicAllocation.enabled', true);
}
