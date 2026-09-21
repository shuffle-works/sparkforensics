// Persistence for the recent-files list. Stores FileSystemFileHandles + light
// metadata in IndexedDB. Never stores parsed data or file bytes: every reopen
// re-parses from the handle, so parsed-model changes need no migration.

// Internal browser-storage record (not event-derived).
export interface RecentFileEntry {
  id: string;
  name: string;
  size: number;
  lastModified: number;
  handle: FileSystemFileHandle;
  appName: string | null;
  issueCount: number | null;
  lastOpenedAt: number;
}

// TS's bundled DOM lib doesn't include the File System Access API's
// queryPermission/requestPermission on FileSystemFileHandle, and callers
// elsewhere (useIngest.ts, DropZone.tsx) already treat a persisted handle as
// an opaque, minimally-typed value rather than the full FileSystemFileHandle
// shape (their own local `FileHandleLike`, `{ getFile: () => Promise<File> }`).
// All-optional so both those looser handles and a real FileSystemFileHandle
// remain assignable here.
interface HandleLike {
  getFile?: () => Promise<File>;
  queryPermission?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
}

const DB_NAME = 'sparkforensics';
// Bump on Entry-shape change: clears the store rather than migrating (see
// applyUpgrade). This is a low-stakes cache, not durable data, so a bump just
// costs the user re-picking a recent file; not worth migration machinery.
export const DB_VERSION = 1;
const STORE = 'recentFiles';
const CAP = 10;

// Monotonic timestamp to ensure sort stability when entries are added quickly
let lastTimestamp = 0;
function getNow(): number {
  const now = Date.now();
  if (now > lastTimestamp) {
    lastTimestamp = now;
    return now;
  }
  return ++lastTimestamp;
}

export function isSupported(): boolean {
  return typeof window !== 'undefined' && 'showOpenFilePicker' in window;
}

// Runs inside onupgradeneeded. Deletes + recreates the store so a DB_VERSION
// bump wipes stale entries rather than migrating them: entries are cheap and
// re-derivable by reopening files.
export function applyUpgrade(db: IDBDatabase): void {
  if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
  db.createObjectStore(STORE, { keyPath: 'id' });
}

export function entryId(name: string, size: number, lastModified: number): string {
  return `${name}::${size}::${lastModified}`;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => applyUpgrade(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function store(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function reqP<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    request.onsuccess = () => res(request.result);
    request.onerror = () => rej(request.error);
  });
}

export async function add({ handle, name, size, lastModified, appName = null, issueCount = null }: {
  handle: HandleLike;
  name: string;
  size: number;
  lastModified: number;
  appName?: string | null;
  issueCount?: number | null;
}): Promise<RecentFileEntry> {
  const db = await openDB();
  try {
    const entry: RecentFileEntry = {
      id: entryId(name, size, lastModified),
      name, size, lastModified, handle: handle as FileSystemFileHandle, appName, issueCount,
      lastOpenedAt: getNow(),
    };
    await reqP(store(db, 'readwrite').put(entry));
    const all: RecentFileEntry[] = await reqP(store(db, 'readonly').getAll());
    if (all.length > CAP) {
      all.sort((a, b) => a.lastOpenedAt - b.lastOpenedAt);
      const evict = all.slice(0, all.length - CAP);
      for (const e of evict) await reqP(store(db, 'readwrite').delete(e.id));
    }
    return entry;
  } finally {
    db.close();
  }
}

export async function list(): Promise<RecentFileEntry[]> {
  const db = await openDB();
  try {
    const all: RecentFileEntry[] = await reqP(store(db, 'readonly').getAll());
    return all.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  } finally {
    db.close();
  }
}

export async function touch(id: string): Promise<void> {
  const db = await openDB();
  try {
    const entry: RecentFileEntry | undefined = await reqP(store(db, 'readonly').get(id));
    if (!entry) return;
    entry.lastOpenedAt = getNow();
    await reqP(store(db, 'readwrite').put(entry));
  } finally {
    db.close();
  }
}

export async function remove(id: string): Promise<void> {
  const db = await openDB();
  try {
    await reqP(store(db, 'readwrite').delete(id));
  } finally {
    db.close();
  }
}

export async function getHandle(id: string): Promise<FileSystemFileHandle | null> {
  const db = await openDB();
  try {
    const entry: RecentFileEntry | undefined = await reqP(store(db, 'readonly').get(id));
    return entry ? entry.handle : null;
  } finally {
    db.close();
  }
}

// Must be called from a user-gesture handler (requestPermission requirement).
export async function ensurePermission(
  handle: HandleLike,
  mode: 'read' | 'readwrite' = 'read',
): Promise<boolean> {
  if (!handle) return false;
  // Callers only ever pass a real handle (see HandleLike above); narrow past
  // the optional-methods typing to call queryPermission/requestPermission.
  const h = handle as Required<Pick<HandleLike, 'queryPermission' | 'requestPermission'>>;
  const opts = { mode };
  if ((await h.queryPermission(opts)) === 'granted') return true;
  return (await h.requestPermission(opts)) === 'granted';
}
