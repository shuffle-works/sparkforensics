import { useCallback } from 'react';
import { createIngestClient } from '@sparkforensics/core/ingest.ts';
import { createModelCallbacks } from '@sparkforensics/core/model-assembler.ts';
import { analyze, auditConfig } from '@sparkforensics/core/analyzer.ts';
import { deriveEvidenceAvailability } from '@sparkforensics/core/evidence-availability.ts';
import { captureSnapshot, applySnapshot } from '@sparkforensics/core/session-snapshot.ts';
import { runLabel } from '@sparkforensics/core/format-utils.ts';
import * as recentFiles from '@sparkforensics/core/recent-files.ts';
import { isShsErrorCode } from '@sparkforensics/core/shs-request.js';
import { store } from './store';
import type { EvidenceAvailability, TaskData } from '@sparkforensics/core/types.ts';

interface Opts { makeClient?: () => ReturnType<typeof createIngestClient>; }

export interface NormalizedShsRequest {
  baseUrl: string;
  appId: string;
  attemptId: string | null;
}

export interface ShsLoadError {
  source: 'shs';
  code: string;
  message?: string;
}

/** A chosen-but-not-yet-parsed run for the two-slot compare flow; parsing is
 * deferred to `startCompareLoad`. `id` matches sessionCache / recentFiles keying
 * so a parsed source snapshots under the same id the comparison later resolves. */
export type RunSource =
  | { kind: 'file'; id: string; label: string; file: File; handle?: unknown }
  | { kind: 'folder'; id: string; label: string; files: File[] }
  | { kind: 'url'; id: string; label: string; request: NormalizedShsRequest }
  | { kind: 'recent'; id: string; label: string; handle?: unknown }
  /** Already parsed this session: its snapshot is in `sessionCache`, so the
   * compare load reuses it instead of parsing it again. */
  | { kind: 'cached'; id: string; label: string };

/** recent-files.js stores FileSystemFileHandles as opaque `unknown`; callers
 * narrow only what they actually call. */
interface FileHandleLike {
  getFile: () => Promise<File>;
}

/** Outcome of `pickRecent`, telling callers whether to refresh their recent-files
 * listing: 'restored' and 'gone' changed persisted state and warrant a refresh;
 * 'started' and 'noop' don't. */
type PickResult = 'restored' | 'started' | 'gone' | 'noop';

// Module-level singleton, not a `useRef`: `useIngest()` is called independently
// from DropZone, Dashboard, and FileSwitcher, so a per-hook-instance ref would
// give whichever instance didn't drive `startLoad` an always-null `clientRef`
// (Dashboard's `getTaskData` would then throw for any un-cached stage). There is
// only ever one active worker client for the whole app.
const clientRef: { current: ReturnType<typeof createIngestClient> | null } = { current: null };
// Handle + metadata for the file being parsed, so `runDone` can call
// `recentFiles.add` on success. Null for handle-less loads (folder / SHS-fetch).
const pendingRef: { current: { handle: unknown; name: string; size: number; lastModified: number } | null } = { current: null };

export function useIngest(opts: Opts = {}) {
  const make = opts.makeClient ?? createIngestClient;

  const getTaskData = useCallback(async (stageId: number): Promise<TaskData> => {
    const cached = store.getState().taskDataCache.get(stageId);
    if (cached) return cached;
    const data = await clientRef.current!.requestTaskData(stageId);
    store.getState().setTaskData(stageId, data);
    return data;
  }, []);

  const runDone = useCallback(async (skippedLines = 0) => {
    const m = store.getState().appModel;
    const ledger = deriveEvidenceAvailability(m, { skippedLines }) as EvidenceAvailability;
    store.getState().setEvidenceAvailability(ledger);
    const catalog = analyze(m.app, m.stages, m.executors.added, m.executors.removed, m.jobs, m.sql, m.runAggregates);
    store.getState().setCatalog(catalog);
    store.getState().setConfigFindings(auditConfig(m.app));
    store.getState().setSkippedLines(skippedLines);
    store.getState().setStatus('ready');
    const flagged = [...new Set(catalog.map((f) => f.stageId).filter((id): id is number => id != null))];
    const prefetched = await clientRef.current!.prefetchFlaggedStages(flagged);
    for (const { stageId, metrics, fieldNames } of prefetched) store.getState().setTaskData(stageId, { metrics, fieldNames });

    const pending = pendingRef.current;
    if (pending?.handle) {
      const issueCount = new Set(catalog.map((f) => f.stageId ?? `app:${f.type}`)).size;
      await recentFiles.add({
        handle: pending.handle,
        name: pending.name,
        size: pending.size,
        lastModified: pending.lastModified,
        appName: m.app?.name ?? null,
        issueCount,
      });
    }
  }, []);

  // Snapshots the active file into sessionCache so switching away from it can be
  // restored or compared later. Skips a fresh/empty model.
  const cacheCurrentSnapshot = useCallback(() => {
    const s = store.getState();
    if (s.activeFileId != null && s.appModel.app) {
      s.sessionCache.set(s.activeFileId, captureSnapshot(s.appModel, s.catalog, s.taskDataCache));
    }
  }, []);

  const begin = useCallback((onError?: (error: unknown) => void) => {
    clientRef.current?.terminate();
    store.getState().resetModel();
    store.getState().setStatus('parsing');
    store.getState().setActiveFile(null);
    pendingRef.current = null;
    clientRef.current = make();
    return createModelCallbacks(store.getState().appModel, {
      onProgress: (p: any) =>
        store.getState().setParse({ pct: p.pct ?? 0, lines: p.linesProcessed ?? 0, etaMs: p.etaMs ?? null }),
      onDone: (d: any) => { void runDone(d?.skippedLines ?? 0); },
      onError: (e: any) => {
        if (onError) onError(e);
        else store.getState().setError(String(e?.message ?? e));
      },
    });
  }, [make, runDone]);

  const startLoad = useCallback((file: File, o?: { handle?: unknown; id?: string }) => {
    const cb = begin();
    const id = o?.id ?? recentFiles.entryId(file.name, file.size, file.lastModified);
    store.getState().setActiveFile(id);
    if (o?.handle) {
      pendingRef.current = { handle: o.handle, name: file.name, size: file.size, lastModified: file.lastModified };
    }
    clientRef.current!.startParse(file, cb);
  }, [begin]);

  const startLoadFolder = useCallback((files: FileList | File[]) => {
    const cb = begin(); clientRef.current!.startParseFiles(Array.from(files), cb);
  }, [begin]);

  const startLoadFromUrl = useCallback((request: NormalizedShsRequest, onShsError: (error: ShsLoadError) => void) => {
    const cb = begin((error: any) => {
      // Any failure ends the SHS parse: clear the flag before routing so the
      // intake stops showing "Fetching…" and re-enables Fetch.
      store.getState().setShsParsing(false);
      if (error?.source === 'shs' && isShsErrorCode(error.code)) {
        store.getState().resetModel();
        onShsError(error);
        return;
      }
      store.getState().setError(String(error?.message ?? error));
    });
    // Mark this parse SHS-sourced (begin() cleared the flag) so the intake stays
    // mounted for in-place progress/recovery.
    store.getState().setShsParsing(true);
    clientRef.current!.startParseFromUrl(request, cb);
  }, [begin]);

  const resetToDropZone = useCallback(() => {
    // Snapshot the active run before discarding it, so it stays reachable for
    // comparison; otherwise sequential loads leave only the newest run.
    cacheCurrentSnapshot();
    clientRef.current?.terminate();
    store.getState().resetModel();
    store.getState().setStatus('idle');
  }, [cacheCurrentSnapshot]);

  // Abandons an in-flight parse. Unlike resetToDropZone it never snapshots:
  // the half-built model has no findings and must not be restored later.
  const cancelParse = useCallback(() => {
    clientRef.current?.terminate();
    clientRef.current = null;
    pendingRef.current = null;
    store.getState().resetModel();
    store.getState().setActiveFile(null);
    store.getState().setStatus('idle');
  }, []);

  // Switches to a recent-files entry: restores instantly from sessionCache when
  // a snapshot exists, otherwise re-parses from its handle.
  const pickRecent = useCallback(async (id: string, handle?: unknown): Promise<PickResult> => {
    const s = store.getState();
    if (id === s.activeFileId) return 'noop';

    const snap = s.sessionCache.get(id);
    if (snap) {
      cacheCurrentSnapshot();
      clientRef.current?.terminate();
      clientRef.current = null;
      const catalog = applySnapshot(s.appModel, s.taskDataCache, snap);
      store.getState().setCatalog(catalog);
      store.getState().setConfigFindings(auditConfig(s.appModel.app));
      store.getState().setActiveFile(id);
      store.getState().setStatus('ready');
      await recentFiles.touch(id);
      return 'restored';
    }

    const resolvedHandle = (handle as FileHandleLike | undefined) ?? (await recentFiles.getHandle(id));
    if (!resolvedHandle) return 'gone';
    const granted = await recentFiles.ensurePermission(resolvedHandle);
    if (!granted) return 'gone';
    let file: File;
    try {
      file = await resolvedHandle.getFile();
    } catch (err) {
      const isGone = err instanceof DOMException && (err.name === 'NotFoundError' || err.name === 'NotAllowedError');
      if (isGone) {
        await recentFiles.remove(id).catch(() => {});
        s.sessionCache.delete(id);
      }
      return 'gone';
    }

    cacheCurrentSnapshot();
    startLoad(file, { handle: resolvedHandle, id });
    return 'started';
  }, [startLoad, cacheCurrentSnapshot]);

  // Pure read: resolves the two snapshots from sessionCache. Safe during render
  // (the active run is snapshotted into the cache by `openComparison`).
  const prepareComparison = useCallback((baselineId: string, candidateId: string) => {
    const cache = store.getState().sessionCache;
    const base = cache.get(baselineId), cand = cache.get(candidateId);
    if (!base || !cand) return null;
    return { baseline: { label: runLabel(baselineId), snapshot: base }, candidate: { label: runLabel(candidateId), snapshot: cand } };
  }, []);

  // Resolves a RunSource's File(s) at compare time (recent/file handles may need
  // a permission re-grant). Returns null with a set error when unreadable, so the
  // caller aborts the compare.
  const resolveSourceInput = useCallback(async (
    source: RunSource,
    which: 'A' | 'B',
  ): Promise<{ start: (h: ReturnType<typeof createModelCallbacks>) => void } | null> => {
    if (source.kind === 'file') return { start: (h) => clientRef.current!.startParse(source.file, h) };
    if (source.kind === 'folder') return { start: (h) => clientRef.current!.startParseFiles(source.files, h) };
    if (source.kind === 'url') return { start: (h) => clientRef.current!.startParseFromUrl(source.request, h) };
    // `load` in startCompareLoad never parses a cached source.
    if (source.kind === 'cached') return null;
    // recent: resolve the persisted handle to a File, re-granting permission.
    const handle = (source.handle as FileHandleLike | undefined) ?? (await recentFiles.getHandle(source.id));
    if (!handle) { store.getState().setError(`Run ${which}: this recent file is no longer available.`); return null; }
    const granted = await recentFiles.ensurePermission(handle);
    if (!granted) { store.getState().setError(`Run ${which}: permission to read this file was denied.`); return null; }
    let file: File;
    try { file = await handle.getFile(); }
    catch { store.getState().setError(`Run ${which}: this recent file could not be read.`); return null; }
    return { start: (h) => clientRef.current!.startParse(file, h) };
  }, []);

  // Snapshots the just-parsed run into sessionCache under `id`, deriving the
  // ledger and catalog as runDone does but with no status/recent-files side
  // effects: this run is a comparison operand, not the active dashboard.
  const snapshotParsedRun = useCallback((id: string, skippedLines = 0) => {
    const m = store.getState().appModel;
    store.getState().setEvidenceAvailability(deriveEvidenceAvailability(m, { skippedLines }) as EvidenceAvailability);
    const m2 = store.getState().appModel;
    const catalog = analyze(m2.app, m2.stages, m2.executors.added, m2.executors.removed, m2.jobs, m2.sql, m2.runAggregates);
    store.getState().sessionCache.set(id, captureSnapshot(m2, catalog, store.getState().taskDataCache));
  }, []);

  // Sequential two-run compare over the single worker:
  // parse A → snapshot A → parse B → snapshot B → openComparison(idA, idB).
  const startCompareLoad = useCallback((a: RunSource, b: RunSource) => {
    const abort = (which: 'A' | 'B', e: unknown) => {
      clientRef.current?.terminate();
      store.getState().setCompareLoad(null);
      store.getState().setComparisonActive(false);
      const msg = (e as { message?: string })?.message ?? String(e);
      store.getState().setError(`Run ${which}: ${msg}`);
    };

    const parseInto = async (source: RunSource, which: 'A' | 'B', onDone: (skippedLines: number) => void) => {
      clientRef.current?.terminate();
      store.getState().resetModel();
      store.getState().setActiveFile(source.id);
      // Set progress AFTER resetModel (which clears compareLoad) so the
      // "Parsing run N of 2" indicator can observe {current}.
      store.getState().setCompareLoad({ current: which === 'A' ? 1 : 2 });
      clientRef.current = make();
      const resolved = await resolveSourceInput(source, which);
      if (!resolved) {
        // resolveSourceInput already set a run-named error; tear down directly
        // rather than routing through abort (which would re-prefix "Run X: ").
        clientRef.current?.terminate();
        store.getState().setCompareLoad(null);
        store.getState().setComparisonActive(false);
        return;
      }
      const cb = createModelCallbacks(store.getState().appModel, {
        onProgress: (p: any) => store.getState().setParse({ pct: p.pct ?? 0, lines: p.linesProcessed ?? 0, etaMs: p.etaMs ?? null }),
        onDone: (d: any) => onDone(d?.skippedLines ?? 0),
        onError: (e: any) => abort(which, e),
      });
      resolved.start(cb);
    };

    // A cached source is already snapshotted: skip straight to the next run.
    const load = (source: RunSource, which: 'A' | 'B', next: () => void) => {
      if (source.kind === 'cached') {
        if (!store.getState().sessionCache.has(source.id)) {
          store.getState().setError(`Run ${which}: this run is no longer loaded. Load its event log again.`);
          return;
        }
        next();
        return;
      }
      void parseInto(source, which, (skippedLines) => {
        snapshotParsedRun(source.id, skippedLines);
        next();
      });
    };

    load(a, 'A', () => {
      load(b, 'B', () => {
        store.getState().setCompareLoad(null);
        // Clear activeFileId so openComparison's auto-snapshot guard skips it:
        // both runs are already cached via snapshotParsedRun, and re-snapshotting
        // b.id off the store's empty top-level catalog would clobber b's snapshot.
        store.getState().setActiveFile(null);
        store.getState().openComparison(a.id, b.id);
      });
    });
  }, [make, resolveSourceInput, snapshotParsedRun]);

  // "Compare with another run" from a dashboard: keep the open run as Run A
  // (resetToDropZone snapshots it) and open the landing's compare view with
  // that slot already filled, so the reader only picks the other run.
  const compareWithAnotherRun = useCallback(() => {
    const id = store.getState().activeFileId;
    if (id == null) return;
    resetToDropZone();
    store.getState().setCompareSeed({ id, label: runLabel(id) });
  }, [resetToDropZone]);

  // Drill from the comparison page into one cached run's dashboard, keeping the
  // comparison paused (ids retained) and the other run's snapshot intact.
  const drillIntoRun = useCallback((id: string) => {
    const s = store.getState();
    const snap = s.sessionCache.get(id);
    if (!snap) return;
    clientRef.current?.terminate();
    clientRef.current = null;
    const catalog = applySnapshot(s.appModel, s.taskDataCache, snap);
    store.getState().setCatalog(catalog);
    store.getState().setConfigFindings(auditConfig(s.appModel.app));
    store.getState().setActiveFile(id);
    store.getState().setStatus('ready');
    store.getState().setComparisonActive(false);
  }, []);

  return { startLoad, startLoadFolder, startLoadFromUrl, resetToDropZone, cancelParse, getTaskData, pickRecent, prepareComparison, startCompareLoad, drillIntoRun, compareWithAnotherRun };
}
