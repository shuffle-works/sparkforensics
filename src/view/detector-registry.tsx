import { lazy, type ComponentType } from 'react';

import { DETECTORS } from '@sparkforensics/core/detectors.ts';
import { FINDING_NAMES } from '@sparkforensics/core/finding-names.ts';
import type { AppModel, Finding, TaskData } from '@sparkforensics/core/types.ts';

// Each widget module is dynamically imported so Vite/Rollup splits it into
// its own chunk instead of bundling every widget into the main entry: these
// are the only widgets ever reached through REGISTRY (both `Alerts.tsx` and
// `Dashboard.tsx`'s `ReferenceSection` render `<Widget .../>` generically off
// `orderedWidgets()`/`REGISTRY`, so this is a single indirection point, not a
// per-call-site change). Named exports, not default, hence the `.then` rewrap.
// Exactly one `lazy(...)` per component, one component per REGISTRY key:
// every `finding.type` maps to its own widget now, so there is no sharing to
// account for here.
const Skew = lazy(() => import('./widgets/Skew').then((m) => ({ default: m.Skew })));
const StageShape = lazy(() => import('./widgets/StageShape').then((m) => ({ default: m.StageShape })));
const TinyTask = lazy(() => import('./widgets/TinyTask').then((m) => ({ default: m.TinyTask })));
const ShuffleIO = lazy(() => import('./widgets/ShuffleIO').then((m) => ({ default: m.ShuffleIO })));
const PartitionSizing = lazy(() => import('./widgets/PartitionSizing').then((m) => ({ default: m.PartitionSizing })));
const Spill = lazy(() => import('./widgets/Spill').then((m) => ({ default: m.Spill })));
const GcPressure = lazy(() => import('./widgets/GcPressure').then((m) => ({ default: m.GcPressure })));
const StageFailed = lazy(() => import('./widgets/StageFailed').then((m) => ({ default: m.StageFailed })));
const TaskFailures = lazy(() => import('./widgets/TaskFailures').then((m) => ({ default: m.TaskFailures })));
const RetryWaste = lazy(() => import('./widgets/RetryWaste').then((m) => ({ default: m.RetryWaste })));
const SlowHost = lazy(() => import('./widgets/SlowHost').then((m) => ({ default: m.SlowHost })));
const StageSlowness = lazy(() => import('./widgets/StageSlowness').then((m) => ({ default: m.StageSlowness })));
const Straggler = lazy(() => import('./widgets/Straggler').then((m) => ({ default: m.Straggler })));
const SpeculationWaste = lazy(() => import('./widgets/SpeculationWaste').then((m) => ({ default: m.SpeculationWaste })));
const ColdStart = lazy(() => import('./widgets/ColdStart').then((m) => ({ default: m.ColdStart })));
const MemoryUtilization = lazy(() => import('./widgets/MemoryUtilization').then((m) => ({ default: m.MemoryUtilization })));
const ExecutorUtilization = lazy(() => import('./widgets/ExecutorUtilization').then((m) => ({ default: m.ExecutorUtilization })));
const CachingOpportunity = lazy(() => import('./widgets/CachingOpportunity').then((m) => ({ default: m.CachingOpportunity })));
const JobFailures = lazy(() => import('./widgets/JobFailures').then((m) => ({ default: m.JobFailures })));
const ConfigAudit = lazy(() => import('./widgets/ConfigAudit').then((m) => ({ default: m.ConfigAudit })));
const DuplicatePlanSubtree = lazy(() => import('./widgets/DuplicatePlanSubtree').then((m) => ({ default: m.DuplicatePlanSubtree })));
const SmallFiles = lazy(() => import('./widgets/SmallFiles').then((m) => ({ default: m.SmallFiles })));
const UnderBroadcast = lazy(() => import('./widgets/UnderBroadcast').then((m) => ({ default: m.UnderBroadcast })));
const OverBroadcast = lazy(() => import('./widgets/OverBroadcast').then((m) => ({ default: m.OverBroadcast })));
const CacheUtilization = lazy(() => import('./widgets/CacheUtilization').then((m) => ({ default: m.CacheUtilization })));
const CoreUsageArea = lazy(() => import('./widgets/CoreUsageArea').then((m) => ({ default: m.CoreUsageArea })));
const AutoscalingChurn = lazy(() => import('./widgets/AutoscalingChurn').then((m) => ({ default: m.AutoscalingChurn })));
const IncompleteRun = lazy(() => import('./widgets/IncompleteRun').then((m) => ({ default: m.IncompleteRun })));

// `React.lazy(...)` returns a plain object with no function `.name`: set
// `displayName` on each (matching its widget's file basename) so React
// DevTools and the source-scan contract test in
// tests/view/finding-anchor-coverage.test.ts (which maps
// `component.displayName`/`.name` back to `src/view/widgets/<name>.tsx`)
// both still resolve every widget. React supports `displayName` on a
// `LazyExoticComponent` at runtime, but its type declaration doesn't include
// the property, a narrow, localized cast, same class of gap as
// Skew.tsx's `SlowHostFinding`/`StragglerFinding` bridge casts.
function setDisplayName(component: ComponentType<never>, name: string): void {
  (component as unknown as { displayName?: string }).displayName = name;
}
setDisplayName(Skew, 'Skew');
setDisplayName(StageShape, 'StageShape');
setDisplayName(TinyTask, 'TinyTask');
setDisplayName(ShuffleIO, 'ShuffleIO');
setDisplayName(PartitionSizing, 'PartitionSizing');
setDisplayName(Spill, 'Spill');
setDisplayName(GcPressure, 'GcPressure');
setDisplayName(StageFailed, 'StageFailed');
setDisplayName(TaskFailures, 'TaskFailures');
setDisplayName(RetryWaste, 'RetryWaste');
setDisplayName(SlowHost, 'SlowHost');
setDisplayName(StageSlowness, 'StageSlowness');
setDisplayName(Straggler, 'Straggler');
setDisplayName(SpeculationWaste, 'SpeculationWaste');
setDisplayName(ColdStart, 'ColdStart');
setDisplayName(MemoryUtilization, 'MemoryUtilization');
setDisplayName(ExecutorUtilization, 'ExecutorUtilization');
setDisplayName(CachingOpportunity, 'CachingOpportunity');
setDisplayName(JobFailures, 'JobFailures');
setDisplayName(ConfigAudit, 'ConfigAudit');
setDisplayName(DuplicatePlanSubtree, 'DuplicatePlanSubtree');
setDisplayName(SmallFiles, 'SmallFiles');
setDisplayName(UnderBroadcast, 'UnderBroadcast');
setDisplayName(OverBroadcast, 'OverBroadcast');
setDisplayName(CacheUtilization, 'CacheUtilization');
setDisplayName(CoreUsageArea, 'CoreUsageArea');
setDisplayName(AutoscalingChurn, 'AutoscalingChurn');
setDisplayName(IncompleteRun, 'IncompleteRun');

export interface WidgetProps {
  appModel: AppModel;
  catalog: Finding[];
  getTaskData: (id: number) => Promise<TaskData>;
  // Memoized `auditConfig(appModel.app)` result, threaded from Dashboard so the
  // config-scope detector loop runs once per render instead of once here plus
  // once in ConfigAudit. Optional: only ConfigAudit reads it, and direct
  // callers (tests) omit it and fall back to computing it themselves.
  configFindings?: Finding[];
  // The store's `activeFileId` (src/store/store.ts): the one thing that
  // reliably changes identity when the active file switches. `applySnapshot`
  // (src/session-snapshot.js, used by useIngest.ts's `pickRecent`
  // "restored" fast path and `drillIntoRun`) mutates `appModel`'s fields in
  // place rather than replacing the `appModel` object itself, so a widget
  // that memoizes on `appModel`'s reference alone (ExecutorCountChart.tsx,
  // CoreUsageArea.tsx, AutoscalingChurn.tsx) would otherwise keep showing
  // the previous file's derived data. Optional: only widgets that memoize
  // on `appModel` need it; direct callers (tests) may omit it.
  activeFileId?: string | null;
  // Region is read again for exactly the three single-purpose reference
  // widgets (Memory Utilization, Executor Utilization, Core Usage by
  // Locality): the Full app report (Dashboard.tsx's ReferenceSection) always
  // mounts the last from `appModel` regardless of finding state (see
  // `isAlwaysMountedType`/`alwaysMountedWidgets`). Every
  // other REGISTRY widget
  // renders unconditionally as either a full card (has a finding) or a
  // `CleanCheckRow` stub (doesn't), so this suppression floor still matters
  // for them: a marginal finding doesn't default open. Optional: direct
  // callers (tests, and widgets rendered outside Alerts.tsx) may omit it.
  defaultCollapsed?: boolean;
}

export type WidgetRegion = 'action' | 'reference';

export interface RegistryEntry {
  // Every real REGISTRY widget is now code-split (finding 13) via
  // `React.lazy`, which is a `ComponentType` but not an `FC`: this stays
  // `ComponentType` (rather than `LazyExoticComponent<FC<WidgetProps>>`) so
  // `tests/view/triage-navigation.test.tsx`'s plain-function test doubles
  // (substituted directly into `REGISTRY.spill.component` for deterministic
  // route/focus assertions) keep typechecking too.
  component: ComponentType<WidgetProps>;
  region: WidgetRegion;
  widgetId: string;
  widgetTitle: string;
  findingLabel: string;
  routeable: boolean;
}

/**
 * `finding.type` -> component + region, one entry per emitted finding type.
 * Every type maps to its own component: no two `REGISTRY` entries ever
 * share a `component` value.
 *
 * `broadcastSizing` is the one `DETECTORS`-level type with no entry here: it
 * never backs a real `Finding` (the detector only ever pushes
 * `underBroadcast` / `overBroadcast`, both registered below in their own
 * right), so it's a dead type at the `DETECTORS` level with nothing to map.
 */
export const REGISTRY: Record<string, RegistryEntry> = {
  incompleteRun: { component: IncompleteRun, region: 'action', widgetId: 'incomplete-run', widgetTitle: 'Incomplete Run', findingLabel: FINDING_NAMES.incompleteRun, routeable: true },

  skew: { component: Skew, region: 'action', widgetId: 'skew', widgetTitle: 'Task Skew', findingLabel: FINDING_NAMES.skew, routeable: true },
  stageShape: { component: StageShape, region: 'action', widgetId: 'stage-shape', widgetTitle: 'Stage Shape', findingLabel: FINDING_NAMES.stageShape, routeable: true },
  tinyTask: { component: TinyTask, region: 'action', widgetId: 'tiny-task', widgetTitle: 'Tiny Tasks', findingLabel: FINDING_NAMES.tinyTask, routeable: true },

  shuffle: { component: ShuffleIO, region: 'action', widgetId: 'shuffle-io', widgetTitle: 'Shuffle I/O', findingLabel: FINDING_NAMES.shuffle, routeable: true },
  partitionSizing: { component: PartitionSizing, region: 'action', widgetId: 'partition-sizing', widgetTitle: 'Partition Sizing', findingLabel: FINDING_NAMES.partitionSizing, routeable: true },

  spill: { component: Spill, region: 'action', widgetId: 'spill', widgetTitle: 'Spill', findingLabel: FINDING_NAMES.spill, routeable: true },

  gc: { component: GcPressure, region: 'action', widgetId: 'gc-pressure', widgetTitle: 'GC Pressure', findingLabel: FINDING_NAMES.gc, routeable: true },

  stageFailed: { component: StageFailed, region: 'action', widgetId: 'stage-failed', widgetTitle: 'Failed Stages', findingLabel: FINDING_NAMES.stageFailed, routeable: true },
  failures: { component: TaskFailures, region: 'action', widgetId: 'task-failures', widgetTitle: 'Failed Tasks', findingLabel: FINDING_NAMES.failures, routeable: true },
  retryWaste: { component: RetryWaste, region: 'action', widgetId: 'retry-waste', widgetTitle: 'Retry Waste', findingLabel: FINDING_NAMES.retryWaste, routeable: true },

  slowHost: { component: SlowHost, region: 'action', widgetId: 'slow-host', widgetTitle: 'Slow Executor Host', findingLabel: FINDING_NAMES.slowHost, routeable: true },
  stageSlowness: { component: StageSlowness, region: 'action', widgetId: 'stage-slowness', widgetTitle: 'Slow Stage', findingLabel: FINDING_NAMES.stageSlowness, routeable: true },
  straggler: { component: Straggler, region: 'action', widgetId: 'straggler', widgetTitle: 'Stragglers', findingLabel: FINDING_NAMES.straggler, routeable: true },
  speculationWaste: { component: SpeculationWaste, region: 'action', widgetId: 'speculation-waste', widgetTitle: 'Speculation Waste', findingLabel: FINDING_NAMES.speculationWaste, routeable: true },
  coldStart: { component: ColdStart, region: 'action', widgetId: 'cold-start', widgetTitle: 'Cold Start', findingLabel: FINDING_NAMES.coldStart, routeable: true },

  memoryUtilization: { component: MemoryUtilization, region: 'reference', widgetId: 'memory-utilization', widgetTitle: 'Memory Utilization', findingLabel: FINDING_NAMES.memoryUtilization, routeable: true },
  utilization: { component: ExecutorUtilization, region: 'reference', widgetId: 'executor-utilization', widgetTitle: 'Executor Utilization', findingLabel: FINDING_NAMES.utilization, routeable: true },
  coreLocality: { component: CoreUsageArea, region: 'reference', widgetId: 'core-usage-area', widgetTitle: 'Core Usage by Locality', findingLabel: FINDING_NAMES.coreLocality, routeable: true },
  cachingOpportunity: { component: CachingOpportunity, region: 'action', widgetId: 'caching-opportunity', widgetTitle: 'Caching Opportunities', findingLabel: FINDING_NAMES.cachingOpportunity, routeable: true },
  cacheUtilization: { component: CacheUtilization, region: 'reference', widgetId: 'cache-utilization', widgetTitle: 'Cache Storage', findingLabel: FINDING_NAMES.cacheUtilization, routeable: true },
  jobFailureRate: { component: JobFailures, region: 'action', widgetId: 'job-failures', widgetTitle: 'Job Failures', findingLabel: FINDING_NAMES.jobFailureRate, routeable: true },
  autoscalingChurn: { component: AutoscalingChurn, region: 'action', widgetId: 'autoscaling-churn', widgetTitle: 'Autoscaling Churn', findingLabel: FINDING_NAMES.autoscalingChurn, routeable: true },

  configAudit: { component: ConfigAudit, region: 'action', widgetId: 'config-audit', widgetTitle: 'Config Sanity', findingLabel: FINDING_NAMES.configAudit, routeable: true },

  duplicatePlanSubtree: { component: DuplicatePlanSubtree, region: 'action', widgetId: 'duplicate-plan-subtree', widgetTitle: 'Redundant Plan Subtree', findingLabel: FINDING_NAMES.duplicatePlanSubtree, routeable: true },
  smallFiles: { component: SmallFiles, region: 'action', widgetId: 'small-files', widgetTitle: 'Excessive Small Files', findingLabel: FINDING_NAMES.smallFiles, routeable: true },
  underBroadcast: { component: UnderBroadcast, region: 'action', widgetId: 'under-broadcast', widgetTitle: 'Missed Broadcast Join', findingLabel: FINDING_NAMES.underBroadcast, routeable: true },
  overBroadcast: { component: OverBroadcast, region: 'action', widgetId: 'over-broadcast', widgetTitle: 'Oversized Broadcast Join', findingLabel: FINDING_NAMES.overBroadcast, routeable: true },
};

const REGION_ORDER: Record<WidgetRegion, number> = { action: 0, reference: 1 };

/**
 * `broadcastSizing`'s own `DETECTORS`-level type never backs a `Finding`
 * (see the module doc comment above `REGISTRY`): the detector pushes findings
 * under these two types instead, so `orderedWidgets()` expands it to both.
 */
const BROADCAST_SIZING_EMITTED_TYPES = ['overBroadcast', 'underBroadcast'];

/**
 * One entry per emitted finding type that has a `REGISTRY` mapping, in
 * ascending `DETECTORS` order (the alert region sorted before the reference
 * region). Every `REGISTRY` entry now maps to its own unique component
 * (see the module doc comment above `REGISTRY`): dedup by type to skip
 * repeated detectors (e.g. `configAudit` appears multiple times in DETECTORS)
 * and keep the lowest-order occurrence. `broadcastSizing` itself never
 * matches a `REGISTRY` key (see the completeness test in
 * `tests/view/detector-registry.test.tsx`); it's expanded to
 * `BROADCAST_SIZING_EMITTED_TYPES` instead so those two widgets still surface.
 */
export function orderedWidgets(): Array<Pick<RegistryEntry, 'component' | 'region' | 'widgetId' | 'widgetTitle' | 'findingLabel'> & { type: string }> {
  const infoByType = new Map<string, { entry: RegistryEntry; type: string; order: number }>();

  for (const detector of DETECTORS as { type: string; order: number }[]) {
    const emittedTypes = detector.type === 'broadcastSizing' ? BROADCAST_SIZING_EMITTED_TYPES : [detector.type];
    for (const type of emittedTypes) {
      const entry = REGISTRY[type];
      if (!entry) continue;
      const existing = infoByType.get(type);
      if (!existing || detector.order < existing.order) {
        infoByType.set(type, { entry, type, order: detector.order });
      }
    }
  }

  return [...infoByType.values()]
    .sort((a, b) => REGION_ORDER[a.entry.region] - REGION_ORDER[b.entry.region] || a.order - b.order)
    .map(({ entry, type }) => ({
      component: entry.component,
      region: entry.region,
      widgetId: entry.widgetId,
      widgetTitle: entry.widgetTitle,
      findingLabel: entry.findingLabel,
      type,
    }));
}

export function registryTypes(): string[] {
  return Object.keys(REGISTRY);
}

// The one single-purpose reference widget that always mounts from
// `appModel`, independent of finding state, in the Full app report tab (Core
// Usage by Locality; see docs-site's widget-rendering.md). `region:
// 'reference'` marks the candidate set; `cacheUtilization`,
// `memoryUtilization`, and `utilization` are `reference` too (same
// single-purpose shape) but are excluded by product decision: a clean run
// on any of them isn't evidence worth surfacing unconditionally, so each
// collapses to a `CleanCheckRow` like an ordinary action-region type instead.
const ALWAYS_MOUNTED_EXCEPTIONS = new Set(['cacheUtilization', 'memoryUtilization', 'utilization']);

export function isAlwaysMountedType(type: string): boolean {
  const entry = REGISTRY[type];
  return entry !== undefined && entry.region === 'reference' && !ALWAYS_MOUNTED_EXCEPTIONS.has(type);
}

export interface AlwaysMountedWidget {
  component: ComponentType<WidgetProps>;
  widgetId: string;
}

/**
 * Every `isAlwaysMountedType` type's widget: just `coreLocality` (see the
 * module doc comment above `REGISTRY`).
 */
export function alwaysMountedWidgets(): AlwaysMountedWidget[] {
  return Object.entries(REGISTRY)
    .filter(([type]) => isAlwaysMountedType(type))
    .map(([, entry]) => ({ component: entry.component, widgetId: entry.widgetId }));
}
