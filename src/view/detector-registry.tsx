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
// `React.lazy(...)` returns a plain object with no function `.name`: `lazyWidget` sets `displayName`
// to the widget's export name (its file basename) so React DevTools still resolves every widget.
// React supports `displayName` on a `LazyExoticComponent` at runtime, but its type declaration
// doesn't include the property, a narrow, localized cast, same class of gap as Skew.tsx's
// `SlowHostFinding`/`StragglerFinding` bridge casts.
function lazyWidget<N extends string>(
  name: N, load: () => Promise<Record<N, ComponentType<never>>>,
): ComponentType<WidgetProps> {
  const component = lazy(async () => ({ default: (await load())[name] as ComponentType<WidgetProps> }));
  (component as unknown as { displayName?: string }).displayName = name;
  return component;
}

const Skew = lazyWidget('Skew', () => import('./widgets/Skew'));
const StageShape = lazyWidget('StageShape', () => import('./widgets/StageShape'));
const TinyTask = lazyWidget('TinyTask', () => import('./widgets/TinyTask'));
const ShuffleIO = lazyWidget('ShuffleIO', () => import('./widgets/ShuffleIO'));
const PartitionSizing = lazyWidget('PartitionSizing', () => import('./widgets/PartitionSizing'));
const Spill = lazyWidget('Spill', () => import('./widgets/Spill'));
const GcPressure = lazyWidget('GcPressure', () => import('./widgets/GcPressure'));
const StageFailed = lazyWidget('StageFailed', () => import('./widgets/StageFailed'));
const TaskFailures = lazyWidget('TaskFailures', () => import('./widgets/TaskFailures'));
const RetryWaste = lazyWidget('RetryWaste', () => import('./widgets/RetryWaste'));
const SlowHost = lazyWidget('SlowHost', () => import('./widgets/SlowHost'));
const StageSlowness = lazyWidget('StageSlowness', () => import('./widgets/StageSlowness'));
const Straggler = lazyWidget('Straggler', () => import('./widgets/Straggler'));
const SpeculationWaste = lazyWidget('SpeculationWaste', () => import('./widgets/SpeculationWaste'));
const ColdStart = lazyWidget('ColdStart', () => import('./widgets/ColdStart'));
const MemoryUtilization = lazyWidget('MemoryUtilization', () => import('./widgets/MemoryUtilization'));
const ExecutorUtilization = lazyWidget('ExecutorUtilization', () => import('./widgets/ExecutorUtilization'));
const RightSizing = lazyWidget('RightSizing', () => import('./widgets/RightSizing'));
const CachingOpportunity = lazyWidget('CachingOpportunity', () => import('./widgets/CachingOpportunity'));
const JobFailures = lazyWidget('JobFailures', () => import('./widgets/JobFailures'));
const ConfigAudit = lazyWidget('ConfigAudit', () => import('./widgets/ConfigAudit'));
const DuplicatePlanSubtree = lazyWidget('DuplicatePlanSubtree', () => import('./widgets/DuplicatePlanSubtree'));
const PythonUdf = lazyWidget('PythonUdf', () => import('./widgets/PythonUdf'));
const MergeRewrite = lazyWidget('MergeRewrite', () => import('./widgets/MergeRewrite'));
const UnprunedScan = lazyWidget('UnprunedScan', () => import('./widgets/UnprunedScan'));
const JoinKeyCast = lazyWidget('JoinKeyCast', () => import('./widgets/JoinKeyCast'));
const NestedLoopJoin = lazyWidget('NestedLoopJoin', () => import('./widgets/NestedLoopJoin'));
const SmallFiles = lazyWidget('SmallFiles', () => import('./widgets/SmallFiles'));
const UnderBroadcast = lazyWidget('UnderBroadcast', () => import('./widgets/UnderBroadcast'));
const OverBroadcast = lazyWidget('OverBroadcast', () => import('./widgets/OverBroadcast'));
const CacheUtilization = lazyWidget('CacheUtilization', () => import('./widgets/CacheUtilization'));
const CoreUsageArea = lazyWidget('CoreUsageArea', () => import('./widgets/CoreUsageArea'));
const AutoscalingChurn = lazyWidget('AutoscalingChurn', () => import('./widgets/AutoscalingChurn'));
const IncompleteRun = lazyWidget('IncompleteRun', () => import('./widgets/IncompleteRun'));

/** Starts loading every widget chunk, so a dashboard opened after a parse shows its widgets without
 * a Suspense fallback (see `warmLazy`). */
export function warmWidgetChunks(): void {
  warmLazy(...Object.values(REGISTRY).map((entry) => entry.component));
}

export interface WidgetProps {
  appModel: AppModel;
  catalog: Finding[];
  getTaskData: (id: number) => Promise<TaskData>;
  // The run's `configFindings` (the `auditConfig(appModel.app)` result),
  // threaded from Dashboard. Optional: only ConfigAudit reads it, and treats an
  // omitted prop as no config findings.
  configFindings?: Finding[];
  // Region is read again for exactly the three single-purpose reference
  // widgets (Memory Utilization, Executor Utilization, Core
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

// The widget that always mounts from `appModel`, independent of finding state, in the Full app
// report tab (Core Usage by Locality; see docs-site's widget-rendering/reference-section.md): the
// widget's model says so with `alwaysMounted`. The other reference-region widgets collapse to a
// `CleanCheckRow` on a clean run like an ordinary action-region type.
export function isAlwaysMountedType(type: string): boolean {
  return REGISTRY[type]?.model.alwaysMounted === true;
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
