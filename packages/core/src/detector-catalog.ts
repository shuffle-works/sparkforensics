// The detector catalog: one record per emitted finding type, built from DETECTORS and
// FINDING_PRESENTATION, with no run needed. `list_detectors` (MCP), `sparkforensics-analyze
// detectors` (CLI) and the docs site's /docs/detectors/ pages all read it, so they state the same
// thresholds, docs and gates. It imports detectors.ts by value, so the HTML export never reaches it.
import { DETECTORS, ENTRY_BY_TYPE, type DetectorScope, type DetectorThresholds, type ThresholdOverrides } from './detectors.ts';
import { docAnchorForType } from './detector-docs.ts';
import { docsUrl, pageForAnchor } from './docs-config.ts';
import { detectorPageUrl, findingGuideUrl } from './docs-site-config.ts';
import {
  DETECTOR_FAMILIES, FINDING_PRESENTATION, type DetectorFamily,
} from './finding-presentation.ts';
import { getThresholdSummary } from './threshold-summary.ts';
import { effectiveThresholds, tunedDetectors } from './threshold-overrides.ts';
import type { FindingType, FixEffort, TunedThresholds } from './types.ts';

/** The CLI budget flag and Airflow operator parameter that gate a finding type directly. A type
 * with no entry is gated through `--fail-on-introduced` against a baseline, or not at all. */
export interface BudgetGate {
  cliFlag: string;
  airflowParam: string;
}

// Keyed by finding type, so renaming a type breaks the build here. The flags are checked against
// the CLI's --help text in detector-catalog.test.js.
const BUDGET_GATES: { readonly [T in FindingType]?: BudgetGate } = {
  skew: { cliFlag: '--max-skew', airflowParam: 'max_skew_ratio' },
  spill: { cliFlag: '--max-spill', airflowParam: 'max_spill_gb' },
  utilization: { cliFlag: '--min-efficiency', airflowParam: 'min_efficiency_pct' },
  jobFailureRate: { cliFlag: '--max-failed-task-rate', airflowParam: 'max_failed_task_rate_pct' },
};

/** Where a type's tuning documentation lives: its own bottleneck page, a section of another
 * page, or a general chapter. */
export interface TuningDocRef {
  kind: 'page' | 'section' | 'chapter';
  anchor: string;
  /** The docs path under the site root, with the anchor. */
  path: string;
}

/** One DETECTORS entry that emits the type (configAudit has three, broadcast sizing emits two types). */
export interface DetectorEntryInfo {
  detector: string;
  version: number;
  thresholds: DetectorThresholds;
  /** Present only when an override moved a threshold off its default. */
  tunedThresholds?: TunedThresholds;
  suppressedBy?: string;
}

export interface DetectorCatalogRecord {
  type: FindingType;
  /** Lowercase label, as the dashboard words it. */
  name: string;
  tag: string;
  /** Other finding types that share the tag. */
  tagSharedWith: FindingType[];
  family: DetectorFamily;
  pitch: string;
  /** Where the dashboard renders the type's widget. */
  region: 'action' | 'reference';
  scope: DetectorScope;
  fixEffort: FixEffort;
  /** The clean-check criterion, under any overrides. */
  thresholdSummary: string;
  detectors: DetectorEntryInfo[];
  /** The docs path of this type's catalog page and of its entry in the findings guide. */
  pages: { catalog: string; guide: string };
  /** Null when no single tuning anchor covers the type. */
  tuning: TuningDocRef | null;
  gate: BudgetGate | null;
}

export interface DetectorCatalogFilter {
  type?: string;
  tag?: string;
  family?: string;
  scope?: string;
}

export interface DetectorCatalogResult {
  count: number;
  detectors: DetectorCatalogRecord[];
}

function tuningDocRef(type: string): TuningDocRef | null {
  const anchor = docAnchorForType(type);
  if (!anchor) return null;
  const fragment = anchor.replace(/^#/, '');
  const kind = pageForAnchor(fragment) !== fragment ? 'section' : fragment.startsWith('bottleneck-') ? 'page' : 'chapter';
  return { kind, anchor, path: docsUrl(anchor) };
}

/** Every emitted finding type's record, in detector order (the order `ENTRY_BY_TYPE` gives). */
export function buildDetectorCatalog(options: { thresholds?: ThresholdOverrides } = {}): DetectorCatalogRecord[] {
  const { thresholds } = options;
  const tuned = tunedDetectors(thresholds);
  const types = [...ENTRY_BY_TYPE.keys()] as FindingType[];
  const typesByTag = new Map<string, FindingType[]>();
  for (const type of types) {
    const { tag } = FINDING_PRESENTATION[type];
    typesByTag.set(tag, [...(typesByTag.get(tag) ?? []), type]);
  }
  return types.map((type) => {
    const presentation = FINDING_PRESENTATION[type];
    const first = ENTRY_BY_TYPE.get(type)!;
    return {
      type,
      name: presentation.name,
      tag: presentation.tag,
      tagSharedWith: typesByTag.get(presentation.tag)!.filter((other) => other !== type),
      family: presentation.family,
      pitch: presentation.pitch,
      region: presentation.region ?? 'action',
      scope: first.scope,
      fixEffort: first.fixEffort,
      thresholdSummary: getThresholdSummary(type, thresholds),
      detectors: DETECTORS.filter((entry) => (entry.emits as readonly string[]).includes(type)).map((entry) => ({
        detector: entry.type,
        version: entry.version,
        thresholds: effectiveThresholds(entry, thresholds),
        ...(tuned?.[entry.type] ? { tunedThresholds: tuned[entry.type] } : {}),
        ...(entry.suppressedBy ? { suppressedBy: entry.suppressedBy } : {}),
      })),
      pages: { catalog: detectorPageUrl(type), guide: findingGuideUrl(type) },
      tuning: tuningDocRef(type),
      gate: BUDGET_GATES[type] ?? null,
    };
  });
}

/** The tags in use, in catalog order. */
export function catalogTags(): string[] {
  return [...new Set([...ENTRY_BY_TYPE.keys()].map((type) => FINDING_PRESENTATION[type as FindingType].tag))];
}

/** The records a filter keeps. Every field is exact; a tag matches in any case. */
export function listDetectors(
  filter: DetectorCatalogFilter = {}, options: { thresholds?: ThresholdOverrides } = {},
): DetectorCatalogResult {
  const tag = filter.tag?.toUpperCase();
  const detectors = buildDetectorCatalog(options).filter((record) =>
    (filter.type === undefined || record.type === filter.type)
    && (tag === undefined || record.tag === tag)
    && (filter.family === undefined || record.family === filter.family)
    && (filter.scope === undefined || record.scope === filter.scope));
  return { count: detectors.length, detectors };
}

/** The catalog as Markdown, grouped by family: what the CLI prints with `--format md`. */
export function renderDetectorCatalogMarkdown(records: readonly DetectorCatalogRecord[]): string {
  const lines = [`# Detectors (${records.length})`, ''];
  for (const family of DETECTOR_FAMILIES) {
    const rows = records.filter((r) => r.family === family.id);
    if (rows.length === 0) continue;
    lines.push(`## ${family.label}`, '', '| Tag | Type | Scope | Fix | Gate | What it finds |', '| --- | --- | --- | --- | --- | --- |');
    for (const r of rows) {
      const gate = r.gate ? `\`${r.gate.cliFlag}\`` : '';
      lines.push(`| ${r.tag} | \`${r.type}\` | ${r.scope} | ${r.fixEffort} | ${gate} | ${r.pitch} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
