// Shared by DetectorIndex.vue and DetectorPage.vue: the shape of the generated data file
// (scripts/build-detector-pages.mjs) and the link helper for catalog paths.
import { withBase } from 'vitepress';

export interface DetectorRecord {
  type: string;
  name: string;
  tag: string;
  tagSharedWith: string[];
  family: string;
  pitch: string;
  region: 'action' | 'reference';
  scope: string;
  fixEffort: string;
  thresholdSummary: string;
  detectors: Array<{ detector: string; version: number; thresholds: Record<string, unknown>; suppressedBy?: string }>;
  pages: { catalog: string; guide: string };
  tuning: { kind: 'page' | 'section' | 'chapter'; anchor: string; path: string } | null;
  gate: { cliFlag: string; airflowParam: string } | null;
  example: { log: string; sparkVersion: string | null; finding: Record<string, any> } | null;
  flags: { sharedTag: boolean; tuning: string; hasExample: boolean; gate: string; reference: boolean; suppressedBy: string[] };
  surfaces: {
    mcp: { listCall: unknown; listResponse: unknown; docsCall: unknown; docsResponse: unknown };
    cli: { detectorsCommand: string; detectorsOutput: string; filterCommand: string; budgetCommand: string | null };
  };
}

export interface DetectorData {
  families: Array<{ id: string; label: string }>;
  records: DetectorRecord[];
}

/** A catalog path ("docs/user-guide/x.html#a", relative to the site root) as a docs-site link. */
export function siteHref(path: string): string {
  return withBase(`/${path.replace(/^docs\//, '')}`);
}

/** The dashboard words a finding name in lowercase; headings and cards start it with a capital. */
export function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const FIX_EFFORT_LABEL: Record<string, string> = {
  config: 'A Spark configuration change',
  code: 'A change in the job code',
  rearchitect: 'A pipeline restructure',
};

export const SCOPE_LABEL: Record<string, string> = {
  stage: 'Judged per stage',
  app: 'Judged on the whole run',
  sql: 'Judged per SQL query',
  config: 'Judged on the Spark configuration',
};
