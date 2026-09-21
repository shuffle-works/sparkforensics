// Identifier redaction for the portable evidence report. Replaces the
// application id and every host name with stable pseudonyms (`app-1`,
// `host-1`, ...) so a report can be shared outside the environment that
// produced it without leaking infrastructure identity. Opt-in (default OFF)
// at the call site; raw task records are excluded from the report regardless.
//
// Deterministic (sorted assignment), idempotent (pseudonyms map to themselves),
// and non-mutating (returns a fresh, deep-copied tree).

import type { ExportRunData } from './export-data.ts';

// Host / IP identifier patterns. Used to enumerate host names that surface only
// inside free text: recommendation strings, `stageFailed`'s failure-reason
// value, SQL relation/node names, never as a structured `host` field, so
// redaction reaches those residuals too. Pseudonyms (`host-1`) match neither
// pattern, keeping the scan idempotent.
const HOST_PATTERNS = [
  // EC2-style ip-10-1-2-3 with an optional dotted domain (ip-10-1-2-3.ec2.internal).
  // Each domain label must start with an alphanumeric, so a trailing sentence
  // period ("… bad node ip-10-1-2-3.") is left out of the match.
  /\bip(?:-\d{1,3}){4}(?:\.[a-z0-9][a-z0-9-]*)*/gi,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, // bare IPv4: 10.1.2.3
];

// Spark application id (e.g. application_1690000000000_0001). Besides
// redactReport's structured summary.app.id field, an app id can also surface
// as a residual free-text token (e.g. embedded in a finding's evidence or
// recommendation string), same as a host/IP token embedded in a stage name
// or plan detail. redactComparison has no structured app-id field at all
// (baselineLabel/candidateLabel are caller-supplied labels, not Spark app
// ids), so free text is its *only* source of app ids.
const APP_ID_PATTERNS = [/\bapplication_\d{10,}_\d+\b/g];

// Walk every string in the tree once, collecting matches for each `{ patterns,
// out }` sink. One shared traversal for every token kind (instead of one
// traversal per kind) keeps redactComparison's dual host+app-id scan the same
// cost as the single-kind scan redactReport/redactAppIdentity already do.
function scanTokens(node: unknown, sinks: Array<{ patterns: RegExp[]; out: Set<string> }>): void {
  if (typeof node === 'string') {
    for (const { patterns, out } of sinks) {
      for (const re of patterns) {
        const found = node.match(re);
        if (found) for (const m of found) out.add(m);
      }
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const n of node) scanTokens(n, sinks);
    return;
  }
  if (node && typeof node === 'object') {
    for (const v of Object.values(node)) scanTokens(v, sinks);
  }
}

// Walk every string in the tree, collecting host/IP tokens into `hosts`.
function scanHostTokens(node: unknown, hosts: Set<string>): void {
  scanTokens(node, [{ patterns: HOST_PATTERNS, out: hosts }]);
}

// Recursively collects every string value found under a key literally named
// `host`, anywhere in the tree. Host names surface at several depths, a
// finding's own `host`, `evidence.host`, and now
// `evidence.failedTaskDetails[].host` / `evidence.retriedTaskDetails[].host`,
// and only some of them are host-*pattern*-shaped (a plain FQDN like
// `worker-3.internal` matches neither HOST_PATTERN). Walking by key name rather
// than enumerating known paths keeps any future nested `host` field covered.
function collectHostFields(node: unknown, hosts: Set<string>): void {
  if (Array.isArray(node)) {
    for (const n of node) collectHostFields(n, hosts);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'host' && typeof v === 'string' && v.length > 0) hosts.add(v);
      else collectHostFields(v, hosts);
    }
  }
}

// Spark config keys ending in `host`/`hostname` (e.g. spark.driver.host,
// spark.yarn.am.hostname) carry plain FQDN host names that neither
// HOST_PATTERNS matches (no IP/EC2 shape) nor collectHostFields's by-key-name
// walk catches (the literal key is the dotted Spark property name, never
// `host` itself). app.config is a flat Record<string, string> unique to
// redactExportData: no other redact* export ships a raw Spark config dict.
// Known gap: a hostname value under a differently-named key isn't caught by
// this suffix check. Confirmed against a real cluster config: spark.master,
// spark.yarn.historyServer.address, and the plural YARN proxy/HA keys
// (...AmIpFilter.param.PROXY_HOSTS, ...RM_HA_URLS) all carry real hostnames
// through un-redacted today.
function collectConfigHostValues(config: Record<string, string> | undefined, hosts: Set<string>): void {
  if (!config) return;
  for (const [key, value] of Object.entries(config)) {
    const lastSegment = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
    if ((lastSegment === 'host' || lastSegment === 'hostname') && value) hosts.add(value);
  }
}

// Known locations of the identifiers, so we don't have to guess which strings
// are sensitive: the app id lives at summary.app.id; host names live under any
// `host` key in the findings tree (see collectHostFields), plus a free-text
// scan for hosts/IPs and app ids that appear only inside string values (e.g. a
// finding's evidence/recommendation text).
interface RedactableReport {
  // `id` accepts `null`: summary.app.id is genuinely nullable (app can be
  // absent), and `collectIds` below narrows with `typeof appId === 'string'`.
  summary?: { app?: { id?: string | null } };
  // Deliberately untyped: collectHostFields walks by key name, so no per-field
  // typing is needed and any finding shape (including nested evidence arrays)
  // is accepted.
  findings?: unknown[];
}

function collectIds(report: RedactableReport): { appIds: Set<string>; hosts: Set<string> } {
  const appIds = new Set<string>();
  const hosts = new Set<string>();
  const appId = report?.summary?.app?.id;
  if (typeof appId === 'string' && appId.length > 0) appIds.add(appId);
  collectHostFields(report?.findings, hosts);
  // Free-text scan for both host/IP tokens and app-id tokens: an app id can
  // surface in a finding's evidence/recommendation text (e.g. "retry app
  // application_1690000000000_0001 failed") same as redactComparison's scan.
  scanTokens(report, [{ patterns: HOST_PATTERNS, out: hosts }, { patterns: APP_ID_PATTERNS, out: appIds }]);
  return { appIds, hosts };
}

// Numeric-aware sorted assignment => deterministic numbering that is stable
// across passes. A lexicographic sort orders `host-1, host-10, host-11, host-2`
// so a second pass over already-pseudonymized ids would re-slot `host-10`→`2`
// at >=10 items and break idempotency; a numeric-aware sort keeps `host-2`
// before `host-10`, so each pseudonym maps back to itself.
function buildMap(ids: Set<string>, prefix: string): Map<string, string> {
  const map = new Map<string, string>();
  [...ids]
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .forEach((id, i) => map.set(id, `${prefix}-${i + 1}`));
  return map;
}

// Deep-replace every string occurrence of each identifier across the whole
// tree (covers ids embedded in free-text recommendations, not just the
// canonical fields). Longest-first so no identifier is a prefix-shadow of
// another. Returns a fresh tree, never mutates the input.
function deepReplace(node: unknown, replacements: Array<[string, string]>): unknown {
  if (typeof node === 'string') {
    let s = node;
    for (const [from, to] of replacements) s = s.split(from).join(to);
    return s;
  }
  if (Array.isArray(node)) return node.map((n) => deepReplace(n, replacements));
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = deepReplace(v, replacements);
    return out;
  }
  return node;
}

// Shared by every redact* export below: turns collected app-id/host sets into
// the longest-first replacement list and applies it. Centralizes the
// buildMap+sort+deepReplace sequence so each narrower redact* function only
// has to say what it collects, not how replacement is carried out.
function applyReplacements<T>(node: T, ids: { appIds?: Set<string>; hosts: Set<string> }): T {
  const merged: Array<[string, string]> = [
    ...(ids.appIds ? buildMap(ids.appIds, 'app') : []),
    ...buildMap(ids.hosts, 'host'),
  ];
  // Replace longer identifiers first to avoid partial-substring clobbering.
  merged.sort((a, b) => b[0].length - a[0].length);
  return deepReplace(node, merged) as T;
}

export function redactReport<T extends RedactableReport>(report: T): T {
  const { appIds, hosts } = collectIds(report);
  return applyReplacements(report, { appIds, hosts });
}

// Narrow counterpart to redactReport(), for getRunSummary()'s standalone app
// object (no findings tree to walk). There's exactly one app id here, so no
// Set/Map/sort is needed for it; name/sparkVersion still go through the
// shared host/IP scan-and-replace since either can carry a host token as
// free text.
export function redactAppIdentity(
  app: { id: string | null; name: string | null; sparkVersion: string | null },
): { id: string | null; name: string | null; sparkVersion: string | null } {
  const hosts = new Set<string>();
  scanHostTokens(app.name, hosts);
  scanHostTokens(app.sparkVersion, hosts);
  return {
    id: typeof app.id === 'string' && app.id.length > 0 ? 'app-1' : app.id,
    name: applyReplacements(app.name, { hosts }),
    sparkVersion: applyReplacements(app.sparkVersion, { hosts }),
  };
}

// Run-comparison counterpart: no single app-id *field* to pseudonymize
// (baselineLabel/candidateLabel are caller-supplied labels, not Spark app
// ids), but stage names surface throughout the tree (FindingsDeltaRow.stages,
// baseStages/candStages[].name) and, like the evidence report's findings, can
// carry a host/IP token or an app id as free text (e.g. `collect at
// application_1690000000000_0001 worker-10-1-2-3.scala:45`). Scans the whole
// comparison tree rather than enumerating those fields individually, so a
// future CompareRunsResult field carrying free text is covered without this
// function needing to change.
export function redactComparison<T>(comparison: T): T {
  const hosts = new Set<string>();
  const appIds = new Set<string>();
  scanTokens(comparison, [{ patterns: HOST_PATTERNS, out: hosts }, { patterns: APP_ID_PATTERNS, out: appIds }]);
  return applyReplacements(comparison, { appIds, hosts });
}

// HTML-export counterpart to redactReport/redactComparison. Unlike
// redactReport (scoped to EvidenceReportJson's summary.app.id + findings),
// this also walks executors.added/removed for their literal `host` field
// (ExecutorAddedEvent.host), since raw executor records: not just findings
//: reach data.js.
export function redactExportData(data: ExportRunData): ExportRunData {
  const appIds = new Set<string>();
  const hosts = new Set<string>();
  const appId = data.app?.id;
  if (typeof appId === 'string' && appId.length > 0) appIds.add(appId);
  collectHostFields(data.executors.added, hosts);
  collectHostFields(data.executors.removed, hosts);
  collectHostFields(data.catalog, hosts);
  collectHostFields(data.configFindings, hosts);
  collectConfigHostValues(data.app?.config, hosts);
  scanTokens(data, [{ patterns: HOST_PATTERNS, out: hosts }, { patterns: APP_ID_PATTERNS, out: appIds }]);
  return applyReplacements(data, { appIds, hosts });
}
