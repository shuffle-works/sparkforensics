import { lazy, type ComponentType } from 'react';

import { warmLazy } from '@/lib/warm-lazy';
import { evidencePanel, type AnyEvidencePanel, type PanelInput, type RowsOf, type WidgetRow } from '@/view/evidence-panel';
import type { FindingWidgetModel } from '@/view/finding-widget';
import { autoscalingChurnModel } from '@/view/widgets/AutoscalingChurn.rows';
import { cacheUtilizationModel } from '@/view/widgets/CacheUtilization.rows';
import { cachingOpportunityModel } from '@/view/widgets/CachingOpportunity.rows';
import { coldStartModel } from '@/view/widgets/ColdStart.rows';
import { configAuditModel } from '@/view/widgets/ConfigAudit.rows';
import { coreUsageModel } from '@/view/widgets/CoreUsageArea.rows';
import { duplicatePlanSubtreeModel } from '@/view/widgets/DuplicatePlanSubtree.rows';
import { executorUtilizationModel } from '@/view/widgets/ExecutorUtilization.rows';
import { gcModel } from '@/view/widgets/GcPressure.rows';
import { incompleteRunModel } from '@/view/widgets/IncompleteRun.rows';
import { jobFailuresModel } from '@/view/widgets/JobFailures.rows';
import { joinKeyCastModel } from '@/view/widgets/JoinKeyCast.rows';
import { memoryUtilizationModel } from '@/view/widgets/MemoryUtilization.rows';
import { mergeRewriteModel } from '@/view/widgets/MergeRewrite.rows';
import { nestedLoopJoinModel } from '@/view/widgets/NestedLoopJoin.rows';
import { overBroadcastModel } from '@/view/widgets/OverBroadcast.rows';
import { partitionSizingModel } from '@/view/widgets/PartitionSizing.rows';
import { pythonUdfModel } from '@/view/widgets/PythonUdf.rows';
import { retryWasteModel } from '@/view/widgets/RetryWaste.rows';
import { rightSizingModel } from '@/view/widgets/RightSizing.rows';
import { shuffleModel } from '@/view/widgets/ShuffleIO.rows';
import { skewModel } from '@/view/widgets/Skew.rows';
import { slowHostModel } from '@/view/widgets/SlowHost.rows';
import { smallFilesModel } from '@/view/widgets/SmallFiles.rows';
import { speculationWasteModel } from '@/view/widgets/SpeculationWaste.rows';
import { spillModel } from '@/view/widgets/Spill.rows';
import { stageFailedModel } from '@/view/widgets/StageFailed.rows';
import { stageShapeModel } from '@/view/widgets/StageShape.rows';
import { stageSlownessModel } from '@/view/widgets/StageSlowness.rows';
import { stragglerModel } from '@/view/widgets/Straggler.rows';
import { taskFailuresModel } from '@/view/widgets/TaskFailures.rows';
import { tinyTaskModel } from '@/view/widgets/TinyTask.rows';
import { underBroadcastModel } from '@/view/widgets/UnderBroadcast.rows';
import { unprunedScanModel } from '@/view/widgets/UnprunedScan.rows';
import type { DetectorInfo } from '@sparkforensics/core/detector-docs.ts';
import { FINDING_PRESENTATION } from '@sparkforensics/core/finding-presentation.ts';
import type { AppModel, Finding, FindingType, TaskData } from '@sparkforensics/core/types.ts';

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
const RightSizing = lazy(() => import('./widgets/RightSizing').then((m) => ({ default: m.RightSizing })));
const CachingOpportunity = lazy(() => import('./widgets/CachingOpportunity').then((m) => ({ default: m.CachingOpportunity })));
const JobFailures = lazy(() => import('./widgets/JobFailures').then((m) => ({ default: m.JobFailures })));
const ConfigAudit = lazy(() => import('./widgets/ConfigAudit').then((m) => ({ default: m.ConfigAudit })));
const DuplicatePlanSubtree = lazy(() => import('./widgets/DuplicatePlanSubtree').then((m) => ({ default: m.DuplicatePlanSubtree })));
const PythonUdf = lazy(() => import('./widgets/PythonUdf').then((m) => ({ default: m.PythonUdf })));
const MergeRewrite = lazy(() => import('./widgets/MergeRewrite').then((m) => ({ default: m.MergeRewrite })));
const UnprunedScan = lazy(() => import('./widgets/UnprunedScan').then((m) => ({ default: m.UnprunedScan })));
const JoinKeyCast = lazy(() => import('./widgets/JoinKeyCast').then((m) => ({ default: m.JoinKeyCast })));
const NestedLoopJoin = lazy(() => import('./widgets/NestedLoopJoin').then((m) => ({ default: m.NestedLoopJoin })));
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
setDisplayName(RightSizing, 'RightSizing');
setDisplayName(CachingOpportunity, 'CachingOpportunity');
setDisplayName(JobFailures, 'JobFailures');
setDisplayName(ConfigAudit, 'ConfigAudit');
setDisplayName(DuplicatePlanSubtree, 'DuplicatePlanSubtree');
setDisplayName(PythonUdf, 'PythonUdf');
setDisplayName(SmallFiles, 'SmallFiles');
setDisplayName(MergeRewrite, 'MergeRewrite');
setDisplayName(UnprunedScan, 'UnprunedScan');
setDisplayName(NestedLoopJoin, 'NestedLoopJoin');
setDisplayName(JoinKeyCast, 'JoinKeyCast');
setDisplayName(UnderBroadcast, 'UnderBroadcast');
setDisplayName(OverBroadcast, 'OverBroadcast');
setDisplayName(CacheUtilization, 'CacheUtilization');
setDisplayName(CoreUsageArea, 'CoreUsageArea');
setDisplayName(AutoscalingChurn, 'AutoscalingChurn');
setDisplayName(IncompleteRun, 'IncompleteRun');

/** Starts loading every widget chunk, so a dashboard opened after a parse shows its widgets without
 * a Suspense fallback (see `warmLazy`). */
export function warmWidgetChunks(): void {
  warmLazy(...Object.values(REGISTRY).map((entry) => entry.component));
}

export interface WidgetProps {
  appModel: AppModel;
  catalog: Finding[];
  getTaskData: (id: number) => Promise<TaskData>;
  // The store's `configFindings` (the `auditConfig(appModel.app)` result),
  // threaded from Dashboard. Optional: only ConfigAudit reads it, and treats an
  // omitted prop as no config findings.
  configFindings?: Finding[];
  // The store's `activeFileId` (src/store/store.ts): the one thing that
  // reliably changes identity when the active file switches. `applySnapshot`
  // (packages/core/src/session-snapshot.ts, used by useIngest.ts's `pickRecent`
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

export type RegistryEntryOf<T extends FindingType> = {
  // Every real REGISTRY widget is code-split via `React.lazy`, which is a `ComponentType` but not an
  // `FC`: this stays `ComponentType` so `tests/view/triage-navigation.test.tsx`'s plain-function test
  // doubles keep typechecking too.
  component: ComponentType<WidgetProps>;
  widgetId: string;
  routeable: boolean;
  /** What the widget decides about its type: the rows it shows, which the panel check and the
   * widget read alike. Lives in `<Widget>.rows.ts`, not in the lazy-loaded widget file. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the row type is the widget's own.
  model: FindingWidgetModel<T, any>;
};

/** An entry as `REGISTRY` is read by finding type name, where the type is not known to the compiler. */
export type RegistryEntry = Omit<RegistryEntryOf<FindingType>, 'model'> & {
  model: FindingWidgetModel<FindingType, WidgetRow>;
  /** The board region, from the type's `FINDING_PRESENTATION` row. */
  region: WidgetRegion;
};

/**
 * `finding.type` -> component and row model, one entry per emitted finding type.
 * View-only concerns: a type's name, tag, labels and region live in core's
 * `FINDING_PRESENTATION`, and its scope and order in `DETECTORS`. Every type
 * maps to its own component: no two `REGISTRY` entries ever share a
 * `component` value. `satisfies` requires exactly one entry per emitted
 * `FindingType`.
 */
const ENTRIES = {
  incompleteRun: { component: IncompleteRun, widgetId: 'incomplete-run', routeable: true, model: incompleteRunModel },

  skew: { component: Skew, widgetId: 'skew', routeable: true, model: skewModel },
  stageShape: { component: StageShape, widgetId: 'stage-shape', routeable: true, model: stageShapeModel },
  tinyTask: { component: TinyTask, widgetId: 'tiny-task', routeable: true, model: tinyTaskModel },

  shuffle: { component: ShuffleIO, widgetId: 'shuffle-io', routeable: true, model: shuffleModel },
  partitionSizing: { component: PartitionSizing, widgetId: 'partition-sizing', routeable: true, model: partitionSizingModel },

  spill: { component: Spill, widgetId: 'spill', routeable: true, model: spillModel },

  gc: { component: GcPressure, widgetId: 'gc-pressure', routeable: true, model: gcModel },

  stageFailed: { component: StageFailed, widgetId: 'stage-failed', routeable: true, model: stageFailedModel },
  failures: { component: TaskFailures, widgetId: 'task-failures', routeable: true, model: taskFailuresModel },
  retryWaste: {
    component: RetryWaste, widgetId: 'retry-waste', routeable: true,
    model: retryWasteModel,
  },

  slowHost: { component: SlowHost, widgetId: 'slow-host', routeable: true, model: slowHostModel },
  stageSlowness: {
    component: StageSlowness, widgetId: 'stage-slowness', routeable: true,
    model: stageSlownessModel,
  },
  straggler: { component: Straggler, widgetId: 'straggler', routeable: true, model: stragglerModel },
  speculationWaste: { component: SpeculationWaste, widgetId: 'speculation-waste', routeable: true, model: speculationWasteModel },
  coldStart: { component: ColdStart, widgetId: 'cold-start', routeable: true, model: coldStartModel },

  memoryUtilization: { component: MemoryUtilization, widgetId: 'memory-utilization', routeable: true, model: memoryUtilizationModel },
  utilization: { component: ExecutorUtilization, widgetId: 'executor-utilization', routeable: true, model: executorUtilizationModel },
  rightSizing: {
    component: RightSizing, widgetId: 'right-sizing', routeable: true,
    model: rightSizingModel,
  },
  coreLocality: { component: CoreUsageArea, widgetId: 'core-usage-area', routeable: true, model: coreUsageModel },
  cachingOpportunity: { component: CachingOpportunity, widgetId: 'caching-opportunity', routeable: true, model: cachingOpportunityModel },
  cacheUtilization: { component: CacheUtilization, widgetId: 'cache-utilization', routeable: true, model: cacheUtilizationModel },
  jobFailureRate: { component: JobFailures, widgetId: 'job-failures', routeable: true, model: jobFailuresModel },
  autoscalingChurn: { component: AutoscalingChurn, widgetId: 'autoscaling-churn', routeable: true, model: autoscalingChurnModel },

  configAudit: { component: ConfigAudit, widgetId: 'config-audit', routeable: true, model: configAuditModel },

  duplicatePlanSubtree: { component: DuplicatePlanSubtree, widgetId: 'duplicate-plan-subtree', routeable: true, model: duplicatePlanSubtreeModel },
  smallFiles: { component: SmallFiles, widgetId: 'small-files', routeable: true, model: smallFilesModel },
  pythonUdf: { component: PythonUdf, widgetId: 'python-udf', routeable: true, model: pythonUdfModel },
  mergeRewrite: { component: MergeRewrite, widgetId: 'merge-rewrite', routeable: true, model: mergeRewriteModel },
  unprunedScan: { component: UnprunedScan, widgetId: 'unpruned-scan', routeable: true, model: unprunedScanModel },
  nestedLoopJoin: { component: NestedLoopJoin, widgetId: 'nested-loop-join', routeable: true, model: nestedLoopJoinModel },
  joinKeyCast: { component: JoinKeyCast, widgetId: 'join-key-cast', routeable: true, model: joinKeyCastModel },
  underBroadcast: { component: UnderBroadcast, widgetId: 'under-broadcast', routeable: true, model: underBroadcastModel },
  overBroadcast: { component: OverBroadcast, widgetId: 'over-broadcast', routeable: true, model: overBroadcastModel },
} satisfies { [T in FindingType]: RegistryEntryOf<T> };

// Read by a type name the compiler cannot know, each model's rows take the input of its own type.
export const REGISTRY = Object.fromEntries(
  Object.entries(ENTRIES).map(([type, entry]) => [type, { ...entry, region: FINDING_PRESENTATION[type as FindingType].region ?? 'action' }]),
) as unknown as Readonly<Record<string, RegistryEntry>>;

const REGION_ORDER: Record<WidgetRegion, number> = { action: 0, reference: 1 };

/**
 * One entry per emitted finding type that has a `REGISTRY` mapping, in
 * ascending detector order (the alert region sorted before the reference
 * region). `detectors` is the run interpretation's per-type info
 * (`detectorInfoByType`): it already folds repeated detectors (e.g.
 * `configAudit`) to their lowest order, lists `broadcastSizing`'s emitted
 * `overBroadcast`/`underBroadcast` under their own names, and its key order
 * (declaration order) breaks ties.
 */
export function orderedWidgets(
  detectors: Record<string, DetectorInfo>,
): Array<Pick<RegistryEntry, 'component' | 'region' | 'widgetId'> & { type: string }> {
  return Object.entries(detectors)
    .filter(([type]) => REGISTRY[type] !== undefined)
    .map(([type, { order }]) => ({ entry: REGISTRY[type], type, order }))
    .sort((a, b) => REGION_ORDER[a.entry.region] - REGION_ORDER[b.entry.region] || a.order - b.order)
    .map(({ entry, type }) => ({
      component: entry.component,
      region: entry.region,
      widgetId: entry.widgetId,
      type,
    }));
}

/** The evidence panel `type`'s widget shows for `input`, or null when it has nothing to show beyond
 * what the line above states. The only way a host gets a panel, for the evidence control, the
 * panel itself and its route target alike. */
export function evidencePanelFor(type: string, input: PanelInput<FindingType>): AnyEvidencePanel | null {
  const entry = REGISTRY[type];
  if (!entry) return null;
  return evidencePanel(type as FindingType, entry.model.rows as RowsOf<FindingType, WidgetRow>, { ...input, inPanel: true }) as AnyEvidencePanel | null;
}

export function registryTypes(): string[] {
  return Object.keys(REGISTRY);
}

// The one single-purpose reference widget that always mounts from
// `appModel`, independent of finding state, in the Full app report tab (Core
// Usage by Locality; see docs-site's widget-rendering/reference-section.md). `region:
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
