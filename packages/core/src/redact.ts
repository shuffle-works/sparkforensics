// Identifier redaction for the portable evidence report. Replaces the
// application id and every host name with stable pseudonyms (`app-1`,
// `host-1`, ...) so a report can be shared outside the environment that
// produced it without leaking infrastructure identity. User names are scrubbed
// where they are recognizable (URL credentials, `/user/<name>`, `user=`); other
// paths and text are kept (ci-and-automation.md, "What --redact covers").
// Opt-in (default OFF) at the call site; raw task records are excluded from the
// report regardless.
//
// Deterministic (sorted assignment), idempotent (pseudonyms map to themselves),
// and non-mutating (returns a fresh, deep-copied tree).

import { decodeCollections, encodeCollections, type ExportRunData } from './export-data.ts';
import type { AppModel, Finding } from './types.ts';
import { isDetectorConfKey, REDACTED_CONF_VALUE } from './spark-conf.ts';
import { REDACTED_TEXT, redactTaskFailureGroup, type TaskFailureDetail } from './task-failure.ts';

// Host / IP identifier patterns. Used to enumerate host names that surface only
// inside free text: recommendation strings, SQL relation/node names, never as a
// structured `host` field, so redaction reaches those residuals too. A pattern with a
// capture group yields that group, not the whole match. Pseudonyms (`host-1`) are never
// collected (see PSEUDONYM), keeping the scan idempotent.
const HOST_PATTERNS = [
  // EC2-style ip-10-1-2-3 with an optional dotted domain (ip-10-1-2-3.ec2.internal).
  // Each domain label must start with an alphanumeric, so a trailing sentence
  // period ("… bad node ip-10-1-2-3.") is left out of the match.
  /\bip(?:-\d{1,3}){4}(?:\.[a-z0-9][a-z0-9-]*)*/gi,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, // bare IPv4: 10.1.2.3
];

// The host of a URL authority (`scheme://[userinfo@]host[:port]/`): hdfs, jdbc, s3a, spark,
// http. Reads the host from any shape, a short name (`nn01`) or an FQDN (`db01.corp.example`),
// a bucket name or a bracketed IPv6 address. A nested scheme (`k8s://https://host:443`) is read
// through to the inner URL's host, never taken as a host itself. The host is the end of the match.
const URL_AUTHORITY_PATTERNS = [
  /\b(?:[a-z][a-z0-9+.-]*:\/\/)+(?:[^\s/?#@]*@)?(\[[0-9a-f:.]+\]|[^\s/?#:@'"<>()[\]{}|,;\\]+)(?![^\s/?#:@'"<>()[\]{}|,;\\]|:\/\/)/gi,
];

// A pseudonym this module writes. Never given a new pseudonym, so a second pass over a redacted
// tree leaves it alone instead of numbering it again.
const PSEUDONYM = /^(?:host|app)-\d+$/;

// A user name has no list to look up, so it is scrubbed where it is recognizable: the user part
// of URL credentials, the segment after `/user/`, `/home/` or `/Users/`, and a `user=` /
// `username=` / `user.name=` value. The same name elsewhere is not recognized. The replacement
// is fixed, so the scrub is idempotent.
const REDACTED_USER = 'redacted-user';
const USER_SCRUBS: Array<[RegExp, string]> = [
  [/((?:\b[a-z][a-z0-9+.-]*:\/\/)+)[^\s/?#@]+@/gi, `$1${REDACTED_USER}@`],
  [/(\/(?:user|home|Users)\/)[^\s/?#:@'"<>()[\]{}|,;&\\]+/g, `$1${REDACTED_USER}`],
  [/((?:\b|(?<=-D))(?:user\.name|username|user)=)[^\s&;,'"<>()[\]{}|\\]+/gi, `$1${REDACTED_USER}`],
];
function scrubUserNames(s: string): string {
  let out = s;
  for (const [pattern, replacement] of USER_SCRUBS) out = out.replace(pattern, replacement);
  return out;
}

// Spark application id (e.g. application_1690000000000_0001). Besides the
// structured summary.app.id field, an app id can surface as a free-text token
// in evidence or recommendation strings. redactComparison has no structured
// app-id field, so free text is its only source of app ids.
const APP_ID_PATTERNS = [/\bapplication_\d{10,}_\d+\b/g];

// Walk every string in the tree once, collecting matches for each `{ patterns,
// out }` sink. One shared traversal for every token kind (instead of one
// traversal per kind) keeps redactComparison's dual host+app-id scan the same
// cost as the single-kind scan redactReport already does.
function scanTokens(node: unknown, sinks: Array<{ patterns: RegExp[]; out: Set<string> }>): void {
  if (typeof node === 'string') {
    for (const { patterns, out } of sinks) {
      for (const re of patterns) {
        for (const m of node.matchAll(re)) out.add(m[1] ?? m[0]);
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

// Recursively collects every string value found under a key literally named
// `host`, anywhere in the tree. Host names surface at several depths (a
// finding's own `host`, `evidence.host`, `evidence.failedTaskDetails[].host`,
// `evidence.retriedTaskDetails[].host`), and only some are host-pattern-shaped
// (a plain FQDN like `worker-3.internal` matches neither HOST_PATTERNS).
// Walking by key name keeps any nested `host` field covered.
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

// A failed-task error's message and stack text can carry file paths and data values that no
// host/app-id pattern recognizes, so they are dropped rather than pseudonymized: every array under
// a key named `failureGroups` gets redactTaskFailureGroup applied. Returns a fresh tree.
function redactFailureGroups<T>(node: T): T {
  if (Array.isArray(node)) return node.map((n) => redactFailureGroups(n)) as T;
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = k === 'failureGroups' && Array.isArray(v)
        ? v.map((g) => (g && typeof g === 'object' ? redactTaskFailureGroup(g as TaskFailureDetail) : g))
        : redactFailureGroups(v);
    }
    return out as T;
  }
  return node;
}

// A stage's failure reason is Spark's free-text message and can carry file paths and data values
// too, so it is replaced outright: a `stageFailed` finding's `valueText`, a stage's
// `stageFailureReason`, a job's `exception` and the report's `failureReason`. Returns a fresh tree.
const REASON_KEYS = new Set(['stageFailureReason', 'exception', 'failureReason']);
function redactStageFailureReasons<T>(node: T): T {
  if (Array.isArray(node)) return node.map((n) => redactStageFailureReasons(n)) as T;
  if (node && typeof node === 'object') {
    const isStageFailed = (node as { type?: unknown }).type === 'stageFailed';
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      const isReason = REASON_KEYS.has(k) || (isStageFailed && k === 'valueText');
      out[k] = isReason && typeof v === 'string' ? REDACTED_TEXT : redactStageFailureReasons(v);
    }
    return out as T;
  }
  return node;
}

// Both passes for free text no host/app-id pattern recognizes.
function redactFailureText<T>(node: T): T {
  return redactStageFailureReasons(redactFailureGroups(node));
}

// Spark config keys ending in `host`/`hostname` (e.g. spark.driver.host,
// spark.yarn.am.hostname) carry plain FQDN host names that neither
// HOST_PATTERNS matches (no IP/EC2 shape) nor collectHostFields's by-key-name
// walk catches (the literal key is the dotted Spark property name, never
// `host` itself). app.config and each SQL execution's modifiedConfigs are
// flat Record<string, string> dicts that only the run-tree redaction ships.
// A value under any other key is caught when it is a URL (HOST_PATTERNS) or a comma-separated
// list of `host:port` entries (spark.yarn.historyServer.address, the YARN HA addresses). A bare
// host name under another key (`spark.some.server=db01`) is not recognized.
const HOST_PORT = /^(?=[^:]*[a-z])([a-z0-9][a-z0-9.-]*):\d{2,5}$/i;
function collectConfigHostValues(config: Record<string, string> | undefined, hosts: Set<string>): void {
  if (!config) return;
  for (const [key, value] of Object.entries(config)) {
    if (!value) continue;
    const lastSegment = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
    if (lastSegment === 'host' || lastSegment === 'hostname') hosts.add(value);
    else for (const entry of value.split(',')) {
      const host = HOST_PORT.exec(entry.trim())?.[1];
      if (host) hosts.add(host);
    }
  }
}

// Known locations of the identifiers: the app id lives at summary.app.id; host
// names live under any `host` key in the findings tree (see collectHostFields),
// plus a free-text scan for hosts/IPs and app ids inside string values.
interface RedactableReport {
  // `id` accepts `null`: summary.app.id is genuinely nullable (app can be
  // absent), and `collectIds` below narrows with `typeof appId === 'string'`.
  summary?: { app?: { id?: string | null; name?: string | null } };
  // Deliberately untyped: collectHostFields walks by key name, so no per-field
  // typing is needed and any finding shape (including nested evidence arrays)
  // is accepted.
  findings?: unknown[];
}

function collectIds(report: RedactableReport): { appIds: Set<string>; hosts: Set<string>; urlHosts: Set<string> } {
  const appIds = new Set<string>();
  const hosts = new Set<string>();
  const urlHosts = new Set<string>();
  const appId = report?.summary?.app?.id;
  if (typeof appId === 'string' && appId.length > 0) appIds.add(appId);
  collectHostFields(report?.findings, hosts);
  // Free-text scan for both host/IP tokens and app-id tokens: an app id can
  // surface in a finding's evidence/recommendation text (e.g. "retry app
  // application_1690000000000_0001 failed") same as redactComparison's scan.
  scanTokens(report, [
    { patterns: HOST_PATTERNS, out: hosts },
    { patterns: URL_AUTHORITY_PATTERNS, out: urlHosts },
    { patterns: APP_ID_PATTERNS, out: appIds },
  ]);
  return { appIds, hosts, urlHosts };
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
// canonical fields), then scrub user names. One pass per string: `replace` reads
// an alternation of every identifier, longest first so no identifier is a
// prefix-shadow of another, and its output is never re-read, so a pseudonym can
// not be replaced again. Returns a fresh tree, never mutates the input.
function deepReplace(node: unknown, replace: (text: string) => string): unknown {
  if (typeof node === 'string') return scrubUserNames(replace(node));
  if (Array.isArray(node)) return node.map((n) => deepReplace(n, replace));
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = deepReplace(v, replace);
    return out;
  }
  return node;
}

// A host is replaced only as a whole token, so a short host such as `master` leaves `metadata`,
// `raw_data` and `masters` alone. An app id is distinctive enough to be replaced anywhere, including
// inside a file name. A single-word host read from a URL (`s3a://data/logs`) is replaced only in URL
// authority position: the same word elsewhere is prose or a finding's `type` and stays as written.
const HOST_TOKEN_BEFORE = '(?<![A-Za-z0-9_.-])';
const HOST_TOKEN_AFTER = '(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])';

function singlePassReplacer(
  appIds: Map<string, string>,
  hosts: Map<string, string>,
  urlWordHosts: Map<string, string>,
): (text: string) => string {
  const alternation = (ids: Map<string, string>) => [...ids.keys()]
    .filter((id) => id.length > 0)
    .sort((a, b) => b.length - a.length)
    .map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const appAlternation = alternation(appIds);
  const hostAlternation = alternation(hosts);
  const branches = [
    ...(appAlternation ? [`(?:${appAlternation})`] : []),
    ...(hostAlternation ? [`${HOST_TOKEN_BEFORE}(?:${hostAlternation})${HOST_TOKEN_AFTER}`] : []),
  ];
  const pattern = branches.length > 0 ? new RegExp(branches.join('|'), 'g') : null;
  const replaceWholeTokens = (text: string) => (pattern
    ? text.replace(pattern, (match) => appIds.get(match) ?? hosts.get(match) ?? match)
    : text);
  if (urlWordHosts.size === 0) return replaceWholeTokens;
  const replaceUrlHost = (text: string) => URL_AUTHORITY_PATTERNS.reduce((out, re) => out.replace(re, (match, host: string) => {
    const pseudonym = urlWordHosts.get(host);
    return pseudonym ? match.slice(0, match.length - host.length) + pseudonym : match;
  }), text);
  return (text) => replaceUrlHost(replaceWholeTokens(text));
}

// Shared by every redact* export below: turns collected app-id/host sets into
// the replacement list and applies it. Centralizes the
// buildMap+sort+deepReplace sequence so each narrower redact* function only
// has to say what it collects, not how replacement is carried out.
function applyReplacements<T>(node: T, ids: { appIds?: Set<string>; hosts: Set<string>; urlHosts: Set<string> }): T {
  const unseen = (set: Set<string>) => new Set([...set].filter((id) => !PSEUDONYM.test(id)));
  const appIds = ids.appIds ? buildMap(unseen(ids.appIds), 'app') : new Map<string, string>();
  // A URL host with a dot (FQDN, IPv4) or colon (IPv6) is host-shaped, so it joins the whole-token
  // set. A single word stays in the URL-only map, unless a host field names it too.
  const isWord = (host: string) => !/[.:]/.test(host);
  const wordUrlHosts = new Set([...ids.urlHosts].filter((h) => isWord(h) && !ids.hosts.has(h)));
  const allHosts = buildMap(unseen(new Set([...ids.hosts, ...ids.urlHosts])), 'host');
  const urlWordHosts = new Map([...allHosts].filter(([host]) => wordUrlHosts.has(host)));
  const wholeTokenHosts = new Map([...allHosts].filter(([host]) => !wordUrlHosts.has(host)));
  return deepReplace(node, singlePassReplacer(appIds, wholeTokenHosts, urlWordHosts)) as T;
}

// The app name identifies a job as much as its id, so a redacted name becomes the id's
// pseudonym, as list_runs does. Only the structured field is replaced, never substrings: a
// short name ("t", "etl") would otherwise corrupt every string it happens to occur in.
function withRedactedName<A extends { id?: string | null; name?: string | null }>(app: A): A {
  return app.name == null ? app : { ...app, name: app.id ?? null };
}

export function redactReport<T extends RedactableReport>(input: T): T {
  const report = redactFailureText(input);
  const out = applyReplacements(report, collectIds(report));
  const app = out.summary?.app;
  return app ? { ...out, summary: { ...out.summary, app: withRedactedName(app) } } : out;
}

// Run-comparison counterpart: stage names surface throughout the tree and can
// carry a host/IP token or an app id as free text (e.g. `collect at
// application_1690000000000_0001 worker-10-1-2-3.scala:45`). Scans the whole
// tree rather than enumerating fields, so any free-text field is covered.
export function redactComparison<T>(comparison: T): T {
  const hosts = new Set<string>();
  const urlHosts = new Set<string>();
  const appIds = new Set<string>();
  scanTokens(comparison, [
    { patterns: HOST_PATTERNS, out: hosts },
    { patterns: URL_AUTHORITY_PATTERNS, out: urlHosts },
    { patterns: APP_ID_PATTERNS, out: appIds },
  ]);
  return applyReplacements(comparison, { appIds, hosts, urlHosts });
}

// HTML-export counterpart to redactReport/redactComparison. Unlike
// redactReport, this also walks executors.added/removed for their literal
// `host` field, since raw executor records reach the export, not just findings.
type RunTree = Pick<ExportRunData, 'app' | 'executors' | 'catalog' | 'configFindings'> & {
  // Each stage's `hostStats[].host` names a host with no executor or finding record.
  stages?: unknown[];
  // Each SQL execution carries the session settings it ran with (`modifiedConfigs`), which can hold
  // the same host values the application config does.
  sql?: Array<{ modifiedConfigs?: Record<string, string> }>;
};

// A per-query setting is whatever the job passed to spark.conf.set: a path, a bucket name, a host. A
// detector reads only the Spark SQL tuning keys, so every other value is replaced by Spark's own
// placeholder for a hidden value and keeps no job-written text.
function withoutJobSetQueryValues<E extends { modifiedConfigs?: Record<string, string> }>(exec: E): E {
  if (!exec.modifiedConfigs) return exec;
  const kept = Object.fromEntries(Object.entries(exec.modifiedConfigs)
    .map(([key, value]) => [key, isDetectorConfKey(key) ? value : REDACTED_CONF_VALUE]));
  return { ...exec, modifiedConfigs: kept };
}

// An executor's removal reason is Spark's free-text message and can carry a path or a data value. No
// surface displays it. It is replaced by field, not through REASON_KEYS: `reason` also names unrelated
// fields elsewhere, and the key walk would blank those.
function withoutExecutorRemovalReasons<T extends RunTree>(data: T): T {
  const removed = data.executors.removed.map((e) => ({ ...e, reason: REDACTED_TEXT }));
  return { ...data, executors: { ...data.executors, removed } };
}

function redactRunTree<T extends RunTree>(input: T): T {
  const data = withoutExecutorRemovalReasons(redactFailureText(input));
  const appIds = new Set<string>();
  const hosts = new Set<string>();
  const urlHosts = new Set<string>();
  const appId = data.app?.id;
  if (typeof appId === 'string' && appId.length > 0) appIds.add(appId);
  collectHostFields(data.executors.added, hosts);
  collectHostFields(data.executors.removed, hosts);
  collectHostFields(data.catalog, hosts);
  collectHostFields(data.configFindings, hosts);
  collectHostFields(data.stages, hosts);
  collectConfigHostValues(data.app?.config, hosts);
  for (const exec of data.sql ?? []) collectConfigHostValues(exec.modifiedConfigs, hosts);
  scanTokens(data, [
    { patterns: HOST_PATTERNS, out: hosts },
    { patterns: URL_AUTHORITY_PATTERNS, out: urlHosts },
    { patterns: APP_ID_PATTERNS, out: appIds },
  ]);
  const replaced = applyReplacements(data, { appIds, hosts, urlHosts });
  const out = replaced.sql ? { ...replaced, sql: replaced.sql.map(withoutJobSetQueryValues) } : replaced;
  if (!out.app) return out;
  const app = withRedactedName(out.app);
  // spark.app.name repeats the name in the config the HTML export ships.
  if (app.config?.['spark.app.name'] == null) return { ...out, app };
  return { ...out, app: { ...app, config: { ...app.config, 'spark.app.name': app.id ?? '' } } };
}

/** A run's model and findings with every identifier pseudonymized. Redact this before anything derives
 * text from the run: the verdict truncates Spark's failure reason, and an
 * identifier cut by that truncation is a fragment no later pass can match. */
export function redactRunModel(
  appModel: AppModel,
  catalog: Finding[],
  configFindings: Finding[],
): { appModel: AppModel; catalog: Finding[]; configFindings: Finding[] } {
  // Maps and Sets would lose their entries in the deep copy, so they cross as
  // tagged plain objects, the way the export payload carries them.
  const tree = encodeCollections({
    app: appModel.app,
    stages: [...appModel.stages.values()],
    jobs: [...appModel.jobs.values()],
    sql: [...appModel.sql.values()],
    executors: appModel.executors,
    runAggregates: appModel.runAggregates,
    evidenceAvailability: appModel.evidenceAvailability,
    catalog,
    configFindings,
  }) as RunTree & { stages: unknown[]; jobs: unknown[]; sql: unknown[]; runAggregates: unknown; evidenceAvailability: unknown };
  const redacted = decodeCollections(redactRunTree(tree)) as typeof tree;
  const byId = <V extends { id: number }>(items: unknown[]) => new Map((items as V[]).map((item) => [item.id, item]));
  return {
    appModel: {
      app: redacted.app,
      stages: byId(redacted.stages),
      jobs: byId(redacted.jobs),
      sql: byId(redacted.sql),
      executors: redacted.executors,
      runAggregates: redacted.runAggregates as AppModel['runAggregates'],
      evidenceAvailability: redacted.evidenceAvailability as AppModel['evidenceAvailability'],
      // Counts and execution ids, nothing to pseudonymize.
      skippedLines: appModel.skippedLines,
      unreadableSqlExecutions: appModel.unreadableSqlExecutions,
    } as AppModel,
    catalog: redacted.catalog,
    configFindings: redacted.configFindings,
  };
}
