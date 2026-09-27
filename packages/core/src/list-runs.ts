import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve as resolvePath, join } from 'node:path';
import { nodeLazyPeekableFromPath, isRollingLogDirectory } from './cli/collect-run.ts';
import { reassembleRollingEntries } from './parser-worker.ts';
import { peekLogHeader } from './log-header-peek.ts';
import { mcpError } from './mcp-error.ts';
import { normalizeBaseUrl } from './shs-request.js';
import { DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_MAX_ARCHIVE_BYTES } from './shs-load.ts';

export interface RunListEntry {
  appId: string;
  name: string;
  sparkVersion?: string;
  startTime?: string;
  durationMs?: number;
  source: { path: string; attemptId?: string } | { shsBaseUrl: string; appId: string; attemptId?: string };
}

export interface ListRunsResult {
  runs: RunListEntry[];
  truncated: boolean;
}

interface ListRunsFilters {
  namePattern?: string;
  minDate?: string;
  maxDate?: string;
  maxResults?: number;
  redact?: boolean;
}

// Local-mode-only convention: a plain file named `<name>_<n>.<ext>` is one attempt of a
// multi-attempt run (e.g. `external-local-1430917381535_1.ndjson`), the `_<n>` disambiguating two
// otherwise-identical appIds. Deliberately anchored on a file extension so a rolling-log
// directory's own name (no extension) never matches this convention.
const LOCAL_ATTEMPT_SUFFIX_RE = /^.+_(\d+)\.[^./\\]+$/;

const DEFAULT_MAX_RESULTS = 100;

// SHS's own timestamp format ends in a literal "GMT" suffix instead of "Z"/an offset, which
// Date.parse cannot parse (returns NaN), normalize before storing, so minDate/maxDate filtering
// (which relies on Date.parse) actually works, and so RunListEntry.startTime has one parseable
// ISO format across both local and SHS mode.
function normalizeShsTimestamp(raw: string): string | undefined {
  if (!Number.isNaN(Date.parse(raw))) return new Date(raw).toISOString();
  if (raw.endsWith('GMT')) {
    const iso = `${raw.slice(0, -3)}Z`;
    if (!Number.isNaN(Date.parse(iso))) return new Date(iso).toISOString();
  }
  return undefined; // genuinely unparseable: omit rather than propagate garbage
}

// Shared by local and SHS mode: both mapping steps produce a flat RunListEntry[] before this runs.
export function applyFiltersAndCap(entries: RunListEntry[], filters: ListRunsFilters): ListRunsResult {
  // Date.parse of an unparseable string returns NaN, and every comparison against NaN is false,
  // left unchecked, a typo'd minDate/maxDate would silently filter out every run rather than
  // reporting the mistake, indistinguishable from a correctly-filtered "no runs matched" result.
  const min = filters.minDate ? Date.parse(filters.minDate) : undefined;
  if (min != null && Number.isNaN(min)) {
    throw mcpError('invalid-date-filter', `minDate is not a parseable date: ${filters.minDate}`);
  }
  const max = filters.maxDate ? Date.parse(filters.maxDate) : undefined;
  if (max != null && Number.isNaN(max)) {
    throw mcpError('invalid-date-filter', `maxDate is not a parseable date: ${filters.maxDate}`);
  }

  let filtered = entries;
  if (filters.namePattern) {
    const needle = filters.namePattern.toLowerCase();
    filtered = filtered.filter((e) => e.name.toLowerCase().includes(needle));
  }
  if (min != null) {
    filtered = filtered.filter((e) => e.startTime != null && Date.parse(e.startTime) >= min);
  }
  if (max != null) {
    filtered = filtered.filter((e) => e.startTime != null && Date.parse(e.startTime) <= max);
  }
  const maxResults = filters.maxResults ?? DEFAULT_MAX_RESULTS;
  const capped = filtered.length <= maxResults
    ? { runs: filtered, truncated: false }
    : { runs: filtered.slice(0, maxResults), truncated: true };
  return filters.redact ? { ...capped, runs: redactRunListEntries(capped.runs) } : capped;
}

// Listing-wide app identity redaction: redact.ts's redactors each work over one run, with no way
// to keep two listing entries sharing an appId in sync, so this builds its own stable per-distinct-appId pseudonym map
// (numeric-aware sort, same scheme as redact.ts's buildMap) across the whole result set, two
// attempts of the same app redact to the same identity, and applies it to every identity-bearing
// field: appId, name (a listing's human-readable name is as identifying as the id itself), and the
// source's own path/appId.
function redactRunListEntries(entries: RunListEntry[]): RunListEntry[] {
  const appIds = new Set<string>();
  for (const e of entries) appIds.add(e.appId);
  const sorted = [...appIds].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const pseudonyms = new Map(sorted.map((id, i) => [id, `app-${i + 1}`]));
  return entries.map((e) => {
    const pseudonym = pseudonyms.get(e.appId) ?? e.appId;
    const source = 'path' in e.source
      ? { ...e.source, path: pseudonym }
      : { ...e.source, appId: pseudonym };
    return { ...e, appId: pseudonym, name: pseudonym, source };
  });
}

export async function listRunsLocal(input: { dir: string } & ListRunsFilters): Promise<ListRunsResult> {
  const dir = resolvePath(input.dir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw mcpError('directory-not-found', `No such directory: ${dir}`);
  }

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    throw mcpError('directory-not-found', `Could not read directory: ${dir}`);
  }

  // `path` is the entry's own source-worthy location (a file, or a rolling-log dir); `peekPath` is
  // the single file peekLogHeader actually reads (the rolling dir's earliest segment). `attemptId`
  // is only ever set for the plain-file case (see LOCAL_ATTEMPT_SUFFIX_RE), a rolling-log
  // directory's name has no file extension, so it never matches the convention.
  const candidates: Array<{ path: string; peekPath: string; attemptId?: string }> = [];
  for (const name of names) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // vanished between readdir and stat: skip
    }
    if (st.isFile()) {
      const attemptMatch = name.match(LOCAL_ATTEMPT_SUFFIX_RE);
      candidates.push({ path: full, peekPath: full, ...(attemptMatch ? { attemptId: attemptMatch[1] } : {}) });
    } else if (st.isDirectory()) {
      let isRolling = false;
      try {
        isRolling = isRollingLogDirectory(full);
      } catch {
        continue; // permission denied or other error reading the directory: skip this candidate
      }
      if (!isRolling) continue; // not a rolling log directory: skip
      let subNames: string[];
      try {
        subNames = readdirSync(full);
      } catch {
        continue;
      }
      let ordered: string[];
      try {
        ordered = reassembleRollingEntries(subNames);
      } catch {
        continue; // malformed rolling dir (index gap, etc.): skip like any unpeekable candidate
      }
      if (ordered.length === 0) continue;
      candidates.push({ path: full, peekPath: join(full, ordered[0]) });
    }
    // Anything else (a plain non-rolling subdirectory, a socket, ...): not a candidate, skip.
  }

  const entries: RunListEntry[] = [];
  for (const c of candidates) {
    let peeked;
    try {
      peeked = await peekLogHeader(nodeLazyPeekableFromPath(c.peekPath));
    } catch {
      continue; // corrupt/unreadable candidate: one bad file shouldn't fail the whole listing
    }
    if (!peeked || !peeked.appId) continue; // no usable appId: not enough to hand back as a candidate
    entries.push({
      appId: peeked.appId,
      name: peeked.name ?? '',
      ...(peeked.sparkVersion ? { sparkVersion: peeked.sparkVersion } : {}),
      ...(peeked.startTimeMs != null ? { startTime: new Date(peeked.startTimeMs).toISOString() } : {}),
      source: { path: c.path, ...(c.attemptId ? { attemptId: c.attemptId } : {}) },
    });
  }

  // readdir order is arbitrary, and applyFiltersAndCap keeps the first maxResults, without a sort
  // a directory of thousands of logs would hand back an arbitrary 100 rather than the newest 100.
  // Newest-first also matches SHS mode, which inherits that order from SHS's own attempt ordering.
  entries.sort((a, b) => {
    if (a.startTime == null && b.startTime == null) return 0;
    if (a.startTime == null) return 1; // undated entries sort last, after every dated one
    if (b.startTime == null) return -1;
    return Date.parse(b.startTime) - Date.parse(a.startTime);
  });

  return applyFiltersAndCap(entries, input);
}

export async function listRunsShs(
  input: { shsBaseUrl: string } & ListRunsFilters,
  opts?: { fetchImpl?: typeof fetch },
): Promise<ListRunsResult> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const normalized = normalizeBaseUrl(input.shsBaseUrl);
  if (!normalized) {
    throw mcpError('invalid-shs-base-url', 'Enter an absolute HTTP(S) base URL without credentials, query, or fragment.');
  }

  const url = new URL('api/v1/applications', normalized);
  if (input.minDate) url.searchParams.set('minDate', input.minDate);
  if (input.maxDate) url.searchParams.set('maxDate', input.maxDate);

  let res: Response;
  try {
    // An unresponsive SHS would otherwise hang the tool call forever. A timed-out signal rejects
    // the fetch with an AbortError, which this same catch turns into access-or-upstream-failure.
    res = await fetchImpl(url.toString(), { signal: AbortSignal.timeout(DEFAULT_IDLE_TIMEOUT_MS) });
  } catch (e) {
    throw mcpError('access-or-upstream-failure', `Could not reach ${normalized}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    throw mcpError('access-or-upstream-failure', `SHS applications list request failed with status ${res.status}.`);
  }
  // Best-effort size guard: this endpoint returns a modest JSON listing, so a declared length over
  // the archive cap means something is wrong. Absent (e.g. chunked) header: skip the check rather
  // than pull in a streaming reader for a listing.
  const declaredLength = Number.parseInt(res.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declaredLength) && declaredLength > DEFAULT_MAX_ARCHIVE_BYTES) {
    throw mcpError('access-or-upstream-failure', 'SHS applications list response exceeds the byte cap.');
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw mcpError('access-or-upstream-failure', 'SHS applications list response was not valid JSON.');
  }
  if (!Array.isArray(payload)) {
    throw mcpError('access-or-upstream-failure', 'SHS applications list response was not an array.');
  }

  const entries: RunListEntry[] = [];
  for (const app of payload as Array<Record<string, unknown>>) {
    if (!app || typeof app !== 'object') continue;
    const id = typeof app.id === 'string' ? app.id : null;
    if (!id) continue;
    const name = typeof app.name === 'string' ? app.name : '';
    const attempts = Array.isArray(app.attempts) ? app.attempts as Array<Record<string, unknown>> : [];
    const attempt = attempts[0]; // SHS's own ordering: most recent attempt first
    if (!attempt) continue;
    const sparkVersion = typeof attempt.appSparkVersion === 'string' ? attempt.appSparkVersion : undefined;
    const startTime = typeof attempt.startTime === 'string' ? normalizeShsTimestamp(attempt.startTime) : undefined;
    const durationMs = typeof attempt.duration === 'number' ? attempt.duration : undefined;
    const attemptId = typeof attempt.attemptId === 'string' ? attempt.attemptId : undefined;
    entries.push({
      appId: id,
      name,
      ...(sparkVersion ? { sparkVersion } : {}),
      ...(startTime ? { startTime } : {}),
      ...(durationMs != null ? { durationMs } : {}),
      source: { shsBaseUrl: normalized, appId: id, ...(attemptId ? { attemptId } : {}) },
    });
  }

  return applyFiltersAndCap(entries, input);
}

export async function listRuns(
  input: { dir?: string; shsBaseUrl?: string } & ListRunsFilters,
  opts?: { fetchImpl?: typeof fetch },
): Promise<ListRunsResult> {
  if (input.dir) {
    return listRunsLocal({
      dir: input.dir, namePattern: input.namePattern, minDate: input.minDate, maxDate: input.maxDate, maxResults: input.maxResults, redact: input.redact,
    });
  }
  if (input.shsBaseUrl) {
    return listRunsShs(
      { shsBaseUrl: input.shsBaseUrl, namePattern: input.namePattern, minDate: input.minDate, maxDate: input.maxDate, maxResults: input.maxResults, redact: input.redact },
      opts,
    );
  }
  throw mcpError('access-or-upstream-failure', 'Provide either dir or shsBaseUrl.');
}

