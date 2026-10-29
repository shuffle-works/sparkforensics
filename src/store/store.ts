import { createStore } from 'zustand/vanilla';
import { useStore as useZustand } from 'zustand';
import { serializeRun, type SerializedRun } from '@sparkforensics/core/run-serialization.ts';
import type { AnalyzedRun } from '@sparkforensics/core/analyzed-run.ts';
import type { ExportProvenance } from '@sparkforensics/core/export-data.ts';
import type { AppModel, Finding, TaskData, StageId } from '@sparkforensics/core/types.ts';

export function emptyAppModel(): AppModel {
  return {
    app: null,
    stages: new Map(),
    executors: { added: [], removed: [] },
    sql: new Map(),
    jobs: new Map(),
    runAggregates: null,
    evidenceAvailability: null,
  };
}

/** What a view reads before any run is installed. */
export const EMPTY_APP_MODEL: AppModel = emptyAppModel();
const NO_FINDINGS: Finding[] = [];

interface State {
  /** The run on screen, built once by `analyzeRun` (live) or read from an export, and installed whole by
   * `installRun`. Null until a run is installed. Views render its conclusions, never derive them. */
  run: AnalyzedRun | null;
  /** Names the installed run: a view that holds per-run state is keyed by it, so a new run starts it fresh. */
  runKey: string | null;
  /** What produced the loaded export file, shown in its footer; null in the live app. */
  exportProvenance: ExportProvenance | null;
  activeFileId: string | null;
  sessionCache: Map<string, SerializedRun>;
  taskDataCache: Map<StageId, TaskData>;
  parse: { pct: number; lines: number; etaMs: number | null };
  status: 'idle' | 'parsing' | 'ready' | 'error';
  // True only while an SHS/URL fetch is parsing, so the intake stays mounted for
  // in-place progress/recovery instead of the full-page parse route.
  shsParsing: boolean;
  errorMessage: string | null;
  // Bumped on every setError(msg) call with a non-null message, even when the
  // text is identical to the previous error: lets a consumer distinguish "a
  // fresh failure just happened, re-focus the alert" from "still showing the
  // same alert as before" when two distinct attempts produce the same message.
  errorNonce: number;
  theme: 'dark' | 'light';
  widgetDensity: 'basic' | 'advanced';
  /** Set once, at boot, by src/export/hydrate-store.ts. Never toggled at
   * runtime and never reset by resetModel(): it describes which bundle is
   * running (the export template vs. the live app), not run state. */
  exportMode: boolean;
  comparison: { active: boolean; baselineId: string | null; candidateId: string | null };
  compareLoad: { current: 1 | 2 } | null;
  /** A run already parsed this session that the landing's compare view
   * should open with as the baseline ("Compare with another run" on a dashboard).
   * Cleared when that comparison opens or the reader leaves the seeded view. */
  compareSeed: { id: string; label: string } | null;
  setCompareSeed: (seed: { id: string; label: string } | null) => void;
  openComparison: (baselineId: string, candidateId: string) => void;
  setComparisonActive: (active: boolean) => void;
  setCompareLoad: (v: { current: 1 | 2 } | null) => void;
  closeComparison: () => void;
  planGraph: { active: boolean; stageId: number | null; initialScope: 'segment' | 'full' };
  openPlanGraph: (stageId: number, opts?: { initialScope?: 'segment' | 'full' }) => void;
  closePlanGraph: () => void;
  /** Replaces the whole run on screen and starts its task data from the run's source. */
  installRun: (run: AnalyzedRun, runKey: string) => void;
  resetModel: () => void;
  setStatus: (s: State['status']) => void;
  setShsParsing: (v: boolean) => void;
  setParse: (p: State['parse']) => void;
  setTaskData: (stageId: StageId, data: TaskData) => void;
  /** Adds many stages' task data in one state update: a copy of the cache per stage is quadratic. */
  setTaskDataBatch: (entries: Array<[StageId, TaskData]>) => void;
  setActiveFile: (id: string | null) => void;
  setError: (msg: string | null) => void;
  setTheme: (t: 'dark' | 'light') => void;
  setWidgetDensity: (d: 'basic' | 'advanced') => void;
}

/**
 * Persisted choice wins, else OS `prefers-color-scheme`, else dark. Kept in sync
 * with the pre-paint inline script in index.html. Returns 'dark' when SSR.
 */
export function initialTheme(): 'dark' | 'light' {
  if (typeof window === 'undefined') return 'dark';
  try {
    const stored = window.localStorage.getItem('shuffle-works-theme');
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    /* ignore unavailable storage */
  }
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

const WIDGET_DENSITY_KEY = 'shuffle-works-widget-density';

/**
 * Persisted choice wins, else 'basic' (the density tier's default). Unlike
 * theme, nothing needs a pre-paint value: no CSS attribute keys off density at
 * first render, so setWidgetDensity can write localStorage directly instead
 * of going through a ThemeProvider-style effect.
 */
export function initialWidgetDensity(): 'basic' | 'advanced' {
  if (typeof window === 'undefined') return 'basic';
  try {
    const stored = window.localStorage.getItem(WIDGET_DENSITY_KEY);
    if (stored === 'basic' || stored === 'advanced') return stored;
  } catch {
    /* ignore unavailable storage */
  }
  return 'basic';
}

/** The run as a session snapshot: everything fetched so far is part of it. */
export function snapshotOf(state: Pick<State, 'run' | 'taskDataCache'>): SerializedRun | null {
  return state.run && serializeRun(state.run, state.taskDataCache);
}

export const store = createStore<State>((set) => ({
  run: null,
  runKey: null,
  exportProvenance: null,
  activeFileId: null,
  sessionCache: new Map(),
  taskDataCache: new Map(),
  parse: { pct: 0, lines: 0, etaMs: null },
  status: 'idle',
  shsParsing: false,
  errorMessage: null,
  errorNonce: 0,
  theme: initialTheme(),
  widgetDensity: initialWidgetDensity(),
  exportMode: false,
  comparison: { active: false, baselineId: null, candidateId: null },
  compareLoad: null,
  compareSeed: null,
  planGraph: { active: false, stageId: null, initialScope: 'segment' },
  setCompareSeed: (compareSeed) => set({ compareSeed }),
  openComparison: (baselineId, candidateId) =>
    set((s) => {
      // Snapshot the active run so a comparison including it resolves by a pure
      // read at render time (never mutate the store during render).
      const snapshot = snapshotOf(s);
      if (s.activeFileId != null && snapshot?.app) s.sessionCache.set(s.activeFileId, snapshot);
      return { comparison: { active: true, baselineId, candidateId } };
    }),
  setComparisonActive: (active) => set((s) => ({ comparison: { ...s.comparison, active } })),
  setCompareLoad: (compareLoad) => set({ compareLoad }),
  closeComparison: () => set({ comparison: { active: false, baselineId: null, candidateId: null } }),
  openPlanGraph: (stageId, opts) => set({ planGraph: { active: true, stageId, initialScope: opts?.initialScope ?? 'segment' } }),
  closePlanGraph: () => set({ planGraph: { active: false, stageId: null, initialScope: 'segment' } }),
  installRun: (run, runKey) =>
    set({
      run,
      runKey,
      taskDataCache: new Map(run.taskData.kind === 'snapshot' ? run.taskData.stages : []),
      status: 'ready',
    }),
  resetModel: () =>
    set({
      run: null,
      runKey: null,
      taskDataCache: new Map(),
      status: 'idle',
      shsParsing: false,
      errorMessage: null,
      comparison: { active: false, baselineId: null, candidateId: null },
      compareLoad: null,
      planGraph: { active: false, stageId: null, initialScope: 'segment' },
    }),
  setStatus: (status) => set({ status }),
  setShsParsing: (shsParsing) => set({ shsParsing }),
  setParse: (parse) => set({ parse }),
  setTaskData: (stageId, data) =>
    set((s) => {
      const next = new Map(s.taskDataCache);
      next.set(stageId, data);
      return { taskDataCache: next };
    }),
  setTaskDataBatch: (entries) =>
    set((s) => {
      if (entries.length === 0) return {};
      const next = new Map(s.taskDataCache);
      for (const [stageId, data] of entries) next.set(stageId, data);
      return { taskDataCache: next };
    }),
  setActiveFile: (activeFileId) => set({ activeFileId }),
  setError: (errorMessage) =>
    set((s) => ({ errorMessage, errorNonce: errorMessage ? s.errorNonce + 1 : s.errorNonce, status: errorMessage ? 'error' : s.status })),
  setTheme: (theme) => set({ theme }),
  setWidgetDensity: (widgetDensity) => {
    try {
      window.localStorage.setItem(WIDGET_DENSITY_KEY, widgetDensity);
    } catch {
      /* ignore unavailable storage */
    }
    set({ widgetDensity });
  },
}));

export function useStore<T>(selector: (s: State) => T): T {
  return useZustand(store, selector);
}

export const selectAppModel = (s: Pick<State, 'run'>): AppModel => s.run?.appModel ?? EMPTY_APP_MODEL;
export const selectCatalog = (s: Pick<State, 'run'>): Finding[] => s.run?.catalog ?? NO_FINDINGS;
export const selectConfigFindings = (s: Pick<State, 'run'>): Finding[] => s.run?.configFindings ?? NO_FINDINGS;

export function useWidgetDensity(): 'basic' | 'advanced' {
  return useStore((s) => s.widgetDensity);
}

export type { State };
