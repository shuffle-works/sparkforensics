import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from 'react';
import { ChevronDownIcon, ChevronUpIcon, Server, Upload } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { RecentList, type RecentFileEntry } from '@/view/RecentList';
import { type NormalizedShsRequest, type RunSource, useIngest } from '@/store/useIngest';
import { store, useStore } from '@/store/store';
import * as recentFiles from '@sparkforensics/core/recent-files.ts';
import { reassembleRollingEntries } from '@sparkforensics/core/rolling-log-reassembly.ts';
import { cn } from '@/lib/utils';
import { isShsRequestValid, validateShsRequest } from '@sparkforensics/core/shs-request.js';

type ShsField = 'baseUrl' | 'appId' | 'attemptId';

const SHS_FIELD_STORAGE_KEYS: Record<ShsField, string> = {
  baseUrl: 'shuffle-works-shs-base-url',
  appId: 'shuffle-works-shs-app-id',
  attemptId: 'shuffle-works-shs-attempt-id',
};

// Persisted value wins, else empty: same "stored else default" shape as
// store.ts's initialTheme/initialWidgetDensity, so a returning visitor's SHS
// fields are pre-filled instead of starting blank every time.
function initialShsField(field: ShsField): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(SHS_FIELD_STORAGE_KEYS[field]) ?? '';
  } catch {
    return '';
  }
}

// A real, gzip-compressed event log (`dev/log-corpus`'s pairwise-01.ndjson,
// picked by actually running the analyzer over every corpus candidate and
// taking the one with the most findings: 10, across skew/tiny-tasks/plan/
// config/utilization) so a first-time visitor with no log of their own can
// still see a populated board. Relative, not `/sample-runs/...`: same
// subpath-safety reasoning as docsUrl()/DOCS_SITE_ROOT elsewhere in this app.
const SAMPLE_RUN_URL = 'sample-runs/sample-run.ndjson.gz';
// Getting-started section that documents starting local-server mode.
const LOCAL_SERVER_SETUP_URL = 'docs/user-guide/getting-started.html#local-server-mode';
// Every other way to get a log (cloud consoles, bastions, copying from storage).
const ALTERNATIVE_LOG_RETRIEVAL_URL = 'docs/user-guide/alternative-log-retrieval.html';

const SHS_RECOVERY_MESSAGES = {
  'local-server-unavailable': 'The local server is unavailable. Start local-server mode, then try again.',
  'upstream-unreachable': 'The History Server could not be reached. Check the address and try again.',
  'application-not-found': 'The requested application was not found. Check the application and attempt IDs.',
  'access-or-upstream-failure': 'The History Server could not provide this event log. Check access and try again.',
  'invalid-event-log': 'The response did not contain a supported event log. Choose a local file or try another application.',
} as const;

/** Minimal shape this component needs from a persisted FileSystemFileHandle
 * (or a directory entry's file handle): recent-files.js stores these as
 * opaque `unknown`, so callers narrow only what they actually call. */
interface FileHandleLike {
  getFile: () => Promise<File>;
}

/** Reads all entries of a dropped directory (flat, one level; Spark's
 * rolling `eventlog_v2_*` format never nests) via the paginated
 * readEntries() API, which must be called repeatedly until it returns an
 * empty array. `dirEntry` is a FileSystemDirectoryEntry, a Web API with only
 * partial TS lib coverage, kept as `any` at this one boundary. */
async function readDirectoryFiles(dirEntry: any): Promise<File[]> {
  const reader = dirEntry.createReader();
  const allEntries: any[] = [];
  for (;;) {
    const batch: any[] = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) break;
    allEntries.push(...batch);
  }
  const fileEntries = allEntries.filter((entry) => entry.isFile);
  return Promise.all(
    fileEntries.map((entry) => new Promise<File>((resolve, reject) => entry.file(resolve, reject))),
  );
}

/** Custom drag/drop + click-to-pick + folder-browse + SHS-fetch drop zone.
 * Kept custom (not a shadcn component) per spec. */
export function DropZone({ onPick, compact = false }: { onPick?: (source: RunSource) => void; compact?: boolean } = {}) {
  const { startLoad, startLoadFolder, startLoadFromUrl, pickRecent } = useIngest();
  // A local load supersedes an in-flight SHS fetch automatically: every parse
  // routes through `useIngest`'s `begin()`, which clears this flag, and only
  // `startLoadFromUrl` re-sets it, so local entry points need no wrapping.
  const shsParsing = useStore((s) => s.shsParsing);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  const [dragOver, setDragOver] = useState(false);
  const [entries, setEntries] = useState<RecentFileEntry[]>([]);
  const [baseUrl, setBaseUrl] = useState(() => initialShsField('baseUrl'));
  const [appId, setAppId] = useState(() => initialShsField('appId'));
  const [attemptId, setAttemptId] = useState(() => initialShsField('attemptId'));
  const [otherSourcesOpen, setOtherSourcesOpen] = useState(false);
  const [findLogOpen, setFindLogOpen] = useState(false);
  const [shsOpen, setShsOpen] = useState(false);
  const [shsReachable, setShsReachable] = useState(false);
  const [touched, setTouched] = useState<Record<ShsField, boolean>>({ baseUrl: false, appId: false, attemptId: false });
  const [shsError, setShsError] = useState<{ code: keyof typeof SHS_RECOVERY_MESSAGES; message?: string } | null>(null);
  const shsAlertRef = useRef<HTMLParagraphElement | null>(null);
  const [sampleLoading, setSampleLoading] = useState(false);

  const shsValidation = validateShsRequest({ baseUrl, appId, attemptId });
  const isShsPanelOpen = shsOpen || shsParsing;
  const isOtherSourcesOpen = otherSourcesOpen || shsParsing;

  useEffect(() => {
    if (shsError) shsAlertRef.current?.focus();
  }, [shsError]);

  // Local-server reachability probe: an empty /shs-proxy request fails
  // validateShsRequest synchronously and returns 400 (packages/core/src/
  // proxy.js), before any upstream fetch, whenever a local server is actually
  // routing that path. A zero-backend static deploy has no such route, so the
  // same request either network-errors or 404s. Compact instances (the
  // two-run comparison slots) never render the callout this feeds, so they
  // skip the probe entirely rather than firing it twice for no UI benefit.
  // Defaults to (and stays) unreachable on any error, so nothing changes on
  // screen after paint if the probe is inconclusive.
  useEffect(() => {
    if (compact) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 800);
    fetch('/shs-proxy', { signal: controller.signal })
      .then((res) => {
        if (res.status === 400) setShsReachable(true);
      })
      .catch(() => {})
      .finally(() => clearTimeout(timeout));
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [compact]);

  // Recent files are best-effort: IndexedDB or permissions can be
  // unavailable, in which case the section just stays empty.
  const refreshEntries = useCallback(() => {
    recentFiles
      .list()
      .then((list: RecentFileEntry[]) => setEntries(list))
      .catch(() => setEntries([]));
  }, []);

  useEffect(() => {
    refreshEntries();
  }, [refreshEntries]);

  // Fetches the bundled sample event log and runs it through the exact same
  // intake path as a locally picked file (onPick for a compare slot, else
  // startLoad), so downstream code has no idea the bytes came from the
  // network instead of the user's disk.
  const loadSampleRun = useCallback(async () => {
    setSampleLoading(true);
    try {
      const res = await fetch(SAMPLE_RUN_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const file = new File([blob], 'sample-run.ndjson.gz', { type: 'application/gzip' });
      if (onPick) onPick({ kind: 'file', id: recentFiles.entryId(file.name, file.size, file.lastModified), label: file.name, file });
      else startLoad(file);
    } catch {
      store.getState().setError('Could not load the sample run. Check your connection and try again, or choose a file below.');
    } finally {
      setSampleLoading(false);
    }
  }, [startLoad, onPick]);

  const openFilePicker = useCallback(async () => {
    if (recentFiles.isSupported()) {
      let handle: FileHandleLike;
      try {
        [handle] = await (window as any).showOpenFilePicker();
      } catch {
        return; // user cancelled the picker
      }
      try {
        const file = await handle.getFile();
        if (onPick) onPick({ kind: 'file', id: recentFiles.entryId(file.name, file.size, file.lastModified), label: file.name, file, handle });
        else startLoad(file, { handle });
      } catch {
        store.getState().setError('Could not read the selected file.');
      }
      return;
    }
    fileInputRef.current?.click();
  }, [startLoad, onPick]);

  // Validate + reassemble a dropped/picked rolling-log folder's files before
  // handing them to the worker, which parses files in the exact order given
  // with no reordering/dedup of its own.
  const loadFolder = useCallback(
    (files: File[]) => {
      const names = files.map((f) => f.name);
      if (!names.some((n) => /^events_\d+_/.test(n))) {
        store.getState().setError("This isn't a Spark rolling event-log directory. Choose file to load a single event log.");
        return;
      }
      let orderedNames: string[];
      try {
        orderedNames = reassembleRollingEntries(names);
      } catch (e) {
        store.getState().setError((e as Error).message);
        return;
      }
      const byName = new Map(files.map((f) => [f.name, f]));
      const orderedFiles = orderedNames.map((n) => byName.get(n)!);
      if (onPick) {
        const first = orderedFiles[0];
        onPick({ kind: 'folder', id: `folder:${first?.name ?? orderedNames[0]}`, label: `${orderedFiles.length}-file rolling log`, files: orderedFiles });
        return;
      }
      startLoadFolder(orderedFiles);
    },
    [startLoadFolder, onPick],
  );

  const onFileInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        if (onPick) onPick({ kind: 'file', id: recentFiles.entryId(file.name, file.size, file.lastModified), label: file.name, file });
        else startLoad(file);
      }
      e.target.value = '';
    },
    [startLoad, onPick],
  );

  const onFolderInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length) loadFolder(files);
      e.target.value = '';
    },
    [loadFolder],
  );

  // Capture a persistable handle from a drop when the browser supports it,
  // otherwise fall back to the plain File. A dropped directory (rolling
  // eventlog_v2_* folder) takes priority over the single-file handling.
  const handleDrop = useCallback(
    async (e: DragEvent<HTMLDivElement>) => {
      const fallbackFile = e.dataTransfer.files[0];
      const item = e.dataTransfer.items?.[0] as any;
      const dirEntry = item?.webkitGetAsEntry?.();
      if (dirEntry && dirEntry.isDirectory) {
        try {
          const files = await readDirectoryFiles(dirEntry);
          loadFolder(files);
        } catch {
          store.getState().setError('Could not read the dropped folder.');
        }
        return;
      }
      if (recentFiles.isSupported() && item?.getAsFileSystemHandle) {
        try {
          const handle = (await item.getAsFileSystemHandle()) as (FileHandleLike & { kind: string }) | null;
          if (handle && handle.kind === 'file') {
            const file = await handle.getFile();
            if (onPick) onPick({ kind: 'file', id: recentFiles.entryId(file.name, file.size, file.lastModified), label: file.name, file, handle });
            else startLoad(file, { handle });
            return;
          }
        } catch {
          store.getState().setError('Could not read the selected file.');
          return;
        }
      }
      if (fallbackFile) {
        if (onPick) onPick({ kind: 'file', id: recentFiles.entryId(fallbackFile.name, fallbackFile.size, fallbackFile.lastModified), label: fallbackFile.name, file: fallbackFile });
        else startLoad(fallbackFile);
      }
    },
    [startLoad, loadFolder, onPick],
  );

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      void handleDrop(e);
    },
    [handleDrop],
  );

  // Restores instantly from the in-session snapshot cache when the entry was
  // already parsed this session; otherwise re-acquires permission and
  // re-parses from its handle (`pickRecent` in useIngest owns that branching).
  const onPickRecent = useCallback(
    async (id: string) => {
      const entry = entries.find((e) => e.id === id);
      if (onPick) {
        onPick({ kind: 'recent', id, label: entry?.appName || entry?.name || id, handle: entry?.handle });
        return;
      }
      const result = await pickRecent(id, entry?.handle);
      if (result === 'restored' || result === 'gone') refreshEntries();
    },
    [entries, pickRecent, refreshEntries, onPick],
  );

  const onRemoveRecent = useCallback(
    (id: string) => {
      const entry = entries.find((e) => e.id === id);
      recentFiles
        .remove(id)
        .catch(() => {})
        .finally(refreshEntries);
      if (entry) {
        toast(`Removed "${entry.appName || entry.name}" from recent files`, {
          action: {
            label: 'Undo',
            onClick: () => {
              // Same untyped-JS boundary cast as useIngest.ts's recentFiles.add call:
              // recent-files.js's default-valued params make TS infer `appName`/
              // `issueCount` as exactly `null`.
              recentFiles.add(entry as any).catch(() => {}).finally(refreshEntries);
            },
          },
        });
      }
    },
    [entries, refreshEntries],
  );

  const setShsField = useCallback((field: ShsField, value: string) => {
    if (field === 'baseUrl') setBaseUrl(value);
    if (field === 'appId') setAppId(value);
    if (field === 'attemptId') setAttemptId(value);
    setShsError(null);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(SHS_FIELD_STORAGE_KEYS[field], value);
      } catch {
        /* ignore unavailable storage */
      }
    }
  }, []);

  const markTouched = useCallback((field: ShsField) => {
    setTouched((current) => ({ ...current, [field]: true }));
  }, []);

  const submitShsFetch = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setTouched({ baseUrl: true, appId: true, attemptId: true });
      setShsError(null);
      const request = shsValidation.request as NormalizedShsRequest | null;
      if (!isShsRequestValid(shsValidation) || !request) return;
      if (onPick) {
        const label = request.attemptId ? `${request.appId}/${request.attemptId}` : request.appId;
        onPick({ kind: 'url', id: label, label, request });
        return;
      }
      // `startLoadFromUrl` owns the store's `shsParsing` flag (set on start,
      // cleared on any error), so this handler only surfaces the error copy.
      startLoadFromUrl(request, (error) => {
        setShsError({ code: error.code as keyof typeof SHS_RECOVERY_MESSAGES, message: error.message });
      });
    },
    [shsValidation, startLoadFromUrl, onPick],
  );

  const fieldError = (field: ShsField) => touched[field] ? shsValidation.errors[field] : null;

  const historyServerSource = (
    <section className="landing-history-server w-full text-left">
      <button
        type="button"
        className="tap-target-comfortable flex w-full cursor-pointer items-center justify-between rounded-md border border-border px-3 py-2 text-left text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={isShsPanelOpen}
        aria-controls="shs-fetch-panel"
        onClick={() => setShsOpen((open) => !open)}
      >
        Fetch from Spark History Server
        {isShsPanelOpen ? (
          <ChevronUpIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        )}
      </button>
      {isShsPanelOpen ? (
        <div id="shs-fetch-panel" className="mt-3 rounded-md border border-border p-4">
          <p className="mb-3 text-sm text-muted-foreground">
            Requires local-server mode and a History Server reachable from this machine.
          </p>
          <form onSubmit={submitShsFetch} className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Base URL
                <input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setShsField('baseUrl', e.target.value)}
                  onBlur={() => markTouched('baseUrl')}
                  placeholder="http://history-server:18080"
                  aria-label="Spark History Server base URL"
                  aria-invalid={Boolean(fieldError('baseUrl'))}
                  aria-describedby={fieldError('baseUrl') ? 'shs-base-url-error' : undefined}
                  className="tap-target-input rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground"
                />
                {fieldError('baseUrl') ? <span id="shs-base-url-error" className="text-destructive">{fieldError('baseUrl')}</span> : null}
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Application ID
                <input
                  type="text"
                  value={appId}
                  onChange={(e) => setShsField('appId', e.target.value)}
                  onBlur={() => markTouched('appId')}
                  placeholder="application_1234567890_0001"
                  aria-label="Application ID"
                  aria-invalid={Boolean(fieldError('appId'))}
                  aria-describedby={fieldError('appId') ? 'shs-app-id-error' : undefined}
                  className="tap-target-input rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground"
                />
                {fieldError('appId') ? <span id="shs-app-id-error" className="text-destructive">{fieldError('appId')}</span> : null}
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Attempt ID (optional)
                <input
                  type="text"
                  value={attemptId}
                  onChange={(e) => setShsField('attemptId', e.target.value)}
                  onBlur={() => markTouched('attemptId')}
                  placeholder="2"
                  aria-label="Attempt ID (optional)"
                  aria-invalid={Boolean(fieldError('attemptId'))}
                  aria-describedby={fieldError('attemptId') ? 'shs-attempt-id-error' : undefined}
                  className="tap-target-input rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground"
                />
                {fieldError('attemptId') ? <span id="shs-attempt-id-error" className="text-destructive">{fieldError('attemptId')}</span> : null}
              </label>
            </div>
            {shsParsing ? <p role="status" aria-live="polite" className="text-sm text-muted-foreground">Fetching event log…</p> : null}
            {shsError ? (
              <p ref={shsAlertRef} role="alert" tabIndex={-1} className="text-sm text-destructive">
                {SHS_RECOVERY_MESSAGES[shsError.code]}
                {' '}Edit the fields, review <a href={LOCAL_SERVER_SETUP_URL} target="_blank" rel="noopener noreferrer" className="tap-target-comfortable text-primary underline-offset-4 hover:underline">Local-server setup</a>, or choose a local file.
                {shsError.message ? <span data-testid="shs-error-detail" className="mt-1 block">{shsError.message}</span> : null}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" className="tap-target-comfortable" disabled={!isShsRequestValid(shsValidation) || shsParsing}>
                Fetch
              </Button>
              <span className="text-xs text-muted-foreground">Application IDs: application_…, local-…, app-…, spark-…, or driver-…</span>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  );

  return (
    <div
      data-testid="drop-zone"
      role="region"
      aria-label="Drop Spark event log file here"
      className={cn(
        'mx-auto flex w-full flex-col items-center justify-center gap-6 rounded-xl border-2 border-dashed border-border p-6 text-center transition-colors',
        compact ? 'max-w-full' : 'landing-drop-zone max-w-none p-6 sm:p-8',
        dragOver && 'border-primary bg-primary/5',
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <Upload aria-hidden="true" className="size-10 text-primary" />

      <div>
        <p className="font-heading text-lg font-semibold">Choose a Spark event log</p>
        <p className="text-sm text-muted-foreground">Drop an event log file here, or choose a file below.</p>
        <p className="mt-1 max-w-xl text-xs text-muted-foreground">
          Accepts a Spark event log file: newline-delimited JSON, one event per line, optionally
          gzip/Zstandard/LZ4/Snappy-compressed, or the .zip a Spark History Server download returns.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button type="button" className="tap-target-comfortable" onClick={() => void openFilePicker()}>
          Choose file
        </Button>
        {/* No log of your own yet? A real, populated run so the board isn't
            the first thing a first-time visitor has to take on faith. Hidden
            in compact mode (the two-run comparison slots): those need the
            user's own baseline/candidate pair, not a canned single run. */}
        {!compact ? (
          <Button
            type="button"
            variant="outline"
            className="tap-target-comfortable"
            onClick={() => void loadSampleRun()}
            disabled={sampleLoading}
          >
            {sampleLoading ? 'Loading sample…' : 'Try a sample run'}
          </Button>
        ) : null}
      </div>

      {/* A first-time visitor often has no idea where Spark keeps this
          file, or that it has to be switched on: answer that right under
          the buttons that need it, instead of only in the docs. */}
      {!compact ? (
        <section className="w-full max-w-2xl text-left">
          <button
            type="button"
            className="tap-target-comfortable mx-auto flex cursor-pointer items-center gap-1 rounded-sm text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-expanded={findLogOpen}
            aria-controls="find-event-log-panel"
            onClick={() => setFindLogOpen((open) => !open)}
          >
            Where do I find my event log?
            {findLogOpen ? (
              <ChevronUpIcon aria-hidden="true" className="size-4 shrink-0" />
            ) : (
              <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0" />
            )}
          </button>
          {findLogOpen ? (
            <div id="find-event-log-panel" className="mt-3 rounded-md border border-border bg-background p-4 text-sm">
              <ol className="list-decimal space-y-2 pl-5 text-muted-foreground">
                <li>
                  <span className="font-medium text-foreground">Turn event logging on.</span> Spark writes one log per
                  application when <code>spark.eventLog.enabled</code> is <code>true</code>, into the directory set by{' '}
                  <code>spark.eventLog.dir</code> (for example <code>/tmp/spark-events</code>, or an HDFS or object-store
                  path). Copy the file for your application from there.
                </li>
                <li>
                  <span className="font-medium text-foreground">Or download it from a Spark History Server.</span> Open{' '}
                  <code>{'<history-server>/api/v1/applications/<app-id>/logs'}</code> and drop the .zip it returns here
                  as-is.
                </li>
                <li>
                  <span className="font-medium text-foreground">Just exploring?</span>{' '}
                  <button
                    type="button"
                    className="cursor-pointer rounded-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => void loadSampleRun()}
                    disabled={sampleLoading}
                  >
                    Load the sample run
                  </button>{' '}
                  to see what the report looks like first.
                </li>
              </ol>
              <a
                href={ALTERNATIVE_LOG_RETRIEVAL_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-block text-primary underline-offset-4 hover:underline"
              >
                More ways to get a log
              </a>
            </div>
          ) : null}
        </section>
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        data-testid="file-input"
        aria-label="Choose file"
        onChange={onFileInputChange}
      />
      <input
        ref={folderInputRef}
        type="file"
        className="hidden"
        data-testid="folder-input"
        aria-label="Choose rolling log folder"
        onChange={onFolderInputChange}
        {...({ webkitdirectory: 'true', directory: 'true' } as React.InputHTMLAttributes<HTMLInputElement>)}
      />

      {compact ? (
        <>
          <Button type="button" variant="outline" className="tap-target-comfortable" onClick={() => folderInputRef.current?.click()}>
            Choose rolling-log folder
          </Button>
          <div className="w-full max-w-2xl">{historyServerSource}</div>
        </>
      ) : (
        <>
          {shsReachable ? (
            <div className="flex w-full max-w-2xl items-start gap-2 rounded-md border border-border p-4 text-left">
              <Server aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                If a Spark History Server is reachable, open{' '}
                <strong className="font-medium text-foreground">Other sources</strong> below to
                fetch a run from it directly.
              </p>
            </div>
          ) : null}
          <section className="landing-other-sources w-full max-w-2xl text-left">
            <button
              type="button"
              className="tap-target-comfortable flex w-full cursor-pointer items-center justify-between rounded-md border border-border px-3 py-2 text-left text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-expanded={isOtherSourcesOpen}
              aria-controls="other-sources-panel"
              onClick={() => setOtherSourcesOpen((open) => !open)}
            >
              Other sources
              {isOtherSourcesOpen ? (
                <ChevronUpIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              )}
            </button>
            {isOtherSourcesOpen ? (
              <div id="other-sources-panel" className="mt-3 flex flex-col gap-3 rounded-md border border-border p-4">
                <p className="text-sm text-muted-foreground">
                  Use these for a rolling <code>eventlog_v2_*</code> directory or to fetch an application from a local Spark History Server.
                </p>
                <div>
                  <Button type="button" variant="outline" className="tap-target-comfortable" onClick={() => folderInputRef.current?.click()}>
                    Choose rolling-log folder
                  </Button>
                </div>
                {historyServerSource}
              </div>
            ) : null}
          </section>
        </>
      )}

      {entries.length > 0 && (
        <div className="w-full max-w-md text-left">
          <p className="mb-1 px-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Recent files
          </p>
          <RecentList entries={entries} onPick={(id) => void onPickRecent(id)} onRemove={onRemoveRecent} />
        </div>
      )}
    </div>
  );
}
