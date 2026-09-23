import { detectorCatalog } from './detectors.ts';

// Single source of the docs-panel URL surface. DOCS_BASE_DIR is the built docs-site path that
// serves the tuning reference, relative to the app's origin.
export const DOCS_BASE_DIR: string = 'docs/tuning-reference';

// Bottleneck sub-anchors that are sections of another entry's page, not pages of their own.
// Most live on a sibling bottleneck page; autoscaling-churn and cache-utilization live on the
// cluster-config and memory-model chapters. Keep in sync with spark-tuning-reference's anchor-map.
const SUB_ANCHOR_PAGES: Record<string, string> = {
  'bottleneck-stage-shape': 'bottleneck-skew',
  'bottleneck-stage-slowness': 'bottleneck-slow-host',
  'bottleneck-partition-sizing': 'bottleneck-shuffle',
  'bottleneck-speculation-waste': 'bottleneck-straggler',
  'bottleneck-core-locality': 'bottleneck-utilization',
  'bottleneck-caching-opportunity': 'bottleneck-utilization',
  'bottleneck-autoscaling-churn': 'cluster-config',
  'bottleneck-cache-utilization': 'memory-model',
};

// Some anchors are in-page fragments on another entry's page: config-audit sub-findings and
// metric-glossary entries live on the 'config'/'metrics' pages, and SUB_ANCHOR_PAGES lists the
// bottleneck sub-anchors.
export function pageForAnchor(anchor: string): string {
  if (anchor.startsWith('metric-')) return 'metrics';
  if (anchor.startsWith('config-')) return 'config';
  return SUB_ANCHOR_PAGES[anchor] ?? anchor;
}

// Build a docs URL for an anchor like '#bottleneck-skew'. The leading '#' is
// stripped and re-added so the fragment is never percent-encoded away.
export function docsUrl(anchor: string): string {
  const frag = String(anchor).replace(/^#/, '');
  return `${DOCS_BASE_DIR}/${pageForAnchor(frag)}.html#${encodeURIComponent(frag)}`;
}

// Internal metric key → docs '#metric-*' anchor. A metric with no entry renders
// as plain text (no broken link). Keys are the app's own metric identifiers.
export const METRIC_ANCHORS: Record<string, string> = {
  'task-duration': '#metric-task-duration',
  'shuffle-read-bytes': '#metric-shuffle-read-bytes',
  'shuffle-write-bytes': '#metric-shuffle-write-bytes',
  'memory-bytes-spilled': '#metric-memory-bytes-spilled',
  'disk-bytes-spilled': '#metric-disk-bytes-spilled',
  'jvm-gc-time': '#metric-jvm-gc-time',
  'gcpct': '#metric-gcpct',
  'executor-run-time': '#metric-executor-run-time',
  'fetch-wait-time-ratio': '#metric-fetch-wait-time-ratio',
  'input-bytes': '#metric-input-bytes',
  'output-bytes': '#metric-output-bytes',
  'io-ratio': '#metric-io-ratio',
  'peak-execution-memory': '#metric-peak-execution-memory',
  'failed-tasks': '#metric-failed-tasks',
  'speculative-tasks': '#metric-speculative-tasks',
  'first-stage-submitted-at': '#metric-first-stage-submitted-at',
  'executor-count': '#metric-executor-count',
  'stage-duration': '#metric-stage-duration',
};

// Allowlist of every anchor that exists in the committed tuning-reference markdown. DocsLink
// renders a link only for anchors here: a detector may declare a docAnchor for an unwritten
// section, and gating keeps that from becoming a dead "Learn more" link. docs-config.test.js
// asserts this stays a subset of the real ids so it can't drift.
export const KNOWN_DOC_ANCHORS: Set<string> = new Set([
  // Page sections
  '#intro', '#spark-architecture', '#memory-model', '#partitioning', '#joins',
  '#shuffle', '#data-formats', '#table-formats', '#caching', '#pyspark', '#aqe',
  '#cluster-config', '#anti-patterns', '#metrics', '#config',
  // Bottleneck sections
  '#bottleneck-cold-start', '#bottleneck-failures', '#bottleneck-gc',
  '#bottleneck-job-failure-rate', '#bottleneck-retry-waste', '#bottleneck-shuffle',
  '#bottleneck-skew', '#bottleneck-slow-host', '#bottleneck-spill',
  '#bottleneck-straggler', '#bottleneck-tiny-tasks', '#bottleneck-utilization',
  '#bottleneck-memory-utilization', '#bottleneck-broadcast-sizing',
  '#bottleneck-duplicate-plan-subtree', '#bottleneck-small-files',
  '#bottleneck-stage-shape', '#bottleneck-stage-slowness',
  '#bottleneck-partition-sizing', '#bottleneck-speculation-waste',
  '#bottleneck-core-locality', '#bottleneck-caching-opportunity',
  '#bottleneck-autoscaling-churn', '#bottleneck-cache-utilization',
  // Config-audit sections
  '#config-autoscale-bounds', '#config-memory-overhead', '#config-serializer',
  '#config-shuffle-service',
  // Metric glossary entries
  ...Object.values(METRIC_ANCHORS),
]);

// True when `anchor` resolves to a real section in the committed
// tuning-reference markdown.
export function isKnownDocAnchor(anchor: unknown): boolean {
  return KNOWN_DOC_ANCHORS.has(String(anchor));
}

// Finding types that never appear as their own DETECTORS entry's type: the parent entry declares
// a different type because one plan-walk covers two rules (see broadcastSizing). Map to the parent.
const TYPE_ALIASES: Record<string, string> = {
  underBroadcast: 'broadcastSizing',
  overBroadcast: 'broadcastSizing',
};

// DETECTORS is static, so this grouping is built once (lazily) instead of re-scanning per
// docAnchorForType call (called once per TagBadge per render).
let anchorsByTypeCache: Map<string, Set<string | undefined>> | undefined;

function anchorsByType(): Map<string, Set<string | undefined>> {
  if (!anchorsByTypeCache) {
    anchorsByTypeCache = new Map();
    for (const entry of detectorCatalog()) {
      const anchors = anchorsByTypeCache.get(entry.type) ?? new Set();
      anchors.add(entry.docAnchor);
      anchorsByTypeCache.set(entry.type, anchors);
    }
  }
  return anchorsByTypeCache;
}

/** Resolves a finding `type` to its documented anchor from detectorCatalog(). Returns undefined
 * when entries sharing the type disagree on docAnchor (only configAudit today), or when the
 * resolved anchor isn't in the allowlist (isKnownDocAnchor, the same gate DocsLink uses). */
export function docAnchorForType(type: string): string | undefined {
  const resolvedType = TYPE_ALIASES[type] ?? type;
  const anchors = anchorsByType().get(resolvedType) ?? new Set();
  if (anchors.size !== 1) return undefined;
  const [anchor] = anchors;
  return anchor && isKnownDocAnchor(anchor) ? anchor : undefined;
}

/** The docAnchor every finding in `findings` carries, or undefined when they disagree or any lacks
 * one. For a badge standing for several findings (a widget header, a grouped row) whose type-level
 * docAnchorForType can't pick one: configAudit's sub-checks each stamp their own anchor. */
export function sharedDocAnchor(findings: ReadonlyArray<{ docAnchor?: string }>): string | undefined {
  const anchors = new Set(findings.map((f) => f.docAnchor));
  if (anchors.size !== 1) return undefined;
  const [anchor] = anchors;
  return anchor;
}

// Resolves a docAnchorForType() result to the tuning-doc file slug under docs-content/tuning/.
// Reuses pageForAnchor's sub-anchor resolution so a sub-anchor like bottleneck-stage-shape maps
// to its owning page (skew.md), not a stage-shape.md that never exists. Returns null for anchors
// with no bottleneck tuning doc (metric-/config-prefixed, a page section like #memory-model, or a
// sub-anchor hosted on a chapter like #bottleneck-autoscaling-churn).
export function tuningDocSlugForAnchor(anchor: string): string | null {
  const bare = String(anchor).replace(/^#/, '');
  const page = pageForAnchor(bare);
  return page.startsWith('bottleneck-') ? page.slice('bottleneck-'.length) : null;
}
