import { serializeRun, type SerializedRun } from './run-serialization.ts';
import type { AnalyzedRun } from './analyzed-run.ts';
import type {
  FindingSavings, InterpretedCostStep, InterpretedStep, RollupGroupData, RunInterpretation, RunVerdictData, StageFindingsData,
} from './run-interpretation.ts';
import type { Finding } from './types.ts';

/** The export payload format: a serialized run plus its provenance. It carries the interpretation
 * layer, which refers to findings by id, and types findings per detector: a text figure
 * (stageFailed, configAudit, incompleteRun) is in `valueText`, and Plan Advisor findings always
 * carry `planNodeIds`. The export bundle reads `EXPORT_DATA_SCHEMA_VERSION` and the versions
 * `upgradeExportPayload` converts, and refuses any other: a payload of another version lacks the
 * conclusions the bundle would otherwise have to derive, or carries them in fields it does not read. */
export const EXPORT_DATA_SCHEMA_VERSION = 4;

/** @sparkforensics/core's own version (packages/core/package.json, which a test keeps in sync).
 * A constant, not a JSON import, because the vendored copies in cli/mcp/server ship without
 * that package.json. */
export const CORE_VERSION = '0.1.0';

/** What produced an export, shown in the exported dashboard's footer. */
export interface ExportProvenance {
  coreVersion: string;
  /** Content hash of the core sources that ran the analysis (`coreSourceHash`), or 'dev' when
   * the producer could not compute one. */
  buildId: string;
  /** The tool that wrote the file, e.g. "sparkforensics-analyze 0.25.0". */
  producer: string;
}

export interface ExportRunData extends SerializedRun {
  schemaVersion: number;
  provenance: ExportProvenance;
}

/** A run as the HTML export's data.js carries it. Raw per-task TaskData is far too large to
 * inline, so `taskData` is always null and task-detail widgets degrade gracefully in export mode.
 * Maps and Sets nested deeper than the run's collections (`app.rddInfo`, each stage's
 * `executorMetrics`) stay as they are here; `encodeCollections` tags them for JSON, and
 * `reviveExportCollections` turns them back on load. */
export function buildExportRunData(run: AnalyzedRun, provenance: ExportProvenance): ExportRunData {
  return {
    schemaVersion: EXPORT_DATA_SCHEMA_VERSION,
    provenance,
    ...serializeRun({ ...run, taskData: { kind: 'none' } }),
  };
}

// The interpretation of a version 3 payload, which pointed at findings by position in
// `[...catalog, ...configFindings]`.
type WithIndex<T, Id extends string, Index extends string> = Omit<T, Id> & Record<Index, number>;
type WithIndexes<T, Ids extends string, Indexes extends string> = Omit<T, Ids> & Record<Indexes, number[]>;

interface InterpretationV3 extends Omit<RunInterpretation, 'savings' | 'verdict' | 'savingsRank' | 'stages' | 'rollup'> {
  savings: FindingSavings[];
  verdict: Omit<RunVerdictData, 'steps' | 'costSteps'> & {
    steps: Array<WithIndex<InterpretedStep, 'leadId', 'leadIndex'>>;
    costSteps: Array<WithIndex<InterpretedCostStep, 'leadId', 'leadIndex'>>;
  };
  savingsRank: number[];
  stages: Record<string, WithIndexes<StageFindingsData, 'findingIds', 'findingIndexes'>>;
  rollup: {
    eligibleIndexes: number[];
    groups: Array<WithIndexes<RollupGroupData, 'memberIds', 'memberIndexes'>>;
  };
}

export interface ExportRunDataV3 extends Omit<ExportRunData, 'interpretation' | 'taskData' | 'unreadableSqlExecutions'> {
  interpretation: InterpretationV3;
}

/** Rewrites a version 3 payload as version 4: each position in the interpretation becomes the id of
 * the finding it pointed at. */
export function upgradeExportPayload(data: ExportRunDataV3): ExportRunData {
  const findings: Finding[] = [...data.catalog, ...data.configFindings];
  const idAt = (index: number): string => {
    const id = findings[index]?.id;
    if (id == null) throw new Error(`The export's interpretation points at finding ${index}, which has no id.`);
    return id;
  };
  const { interpretation } = data;
  return {
    ...data,
    schemaVersion: EXPORT_DATA_SCHEMA_VERSION,
    unreadableSqlExecutions: null,
    taskData: null,
    interpretation: {
      ...interpretation,
      savings: Object.fromEntries(interpretation.savings.map((savings, index) => [idAt(index), savings])),
      verdict: {
        ...interpretation.verdict,
        steps: interpretation.verdict.steps.map(({ leadIndex, ...step }) => ({ ...step, leadId: idAt(leadIndex) })),
        costSteps: interpretation.verdict.costSteps.map(({ leadIndex, ...step }) => ({ ...step, leadId: idAt(leadIndex) })),
      },
      savingsRank: interpretation.savingsRank.map(idAt),
      stages: Object.fromEntries(Object.entries(interpretation.stages).map(([stageId, { findingIndexes, ...stage }]) => [
        stageId, { ...stage, findingIds: findingIndexes.map(idAt) },
      ])),
      rollup: {
        eligibleIds: interpretation.rollup.eligibleIndexes.map(idAt),
        groups: interpretation.rollup.groups.map(({ memberIndexes, ...group }) => ({ ...group, memberIds: memberIndexes.map(idAt) })),
      },
    },
  };
}

/** The payload versions an export bundle reads: the current one, and the ones before it that
 * `upgradeExportPayload` converts. */
export const READABLE_EXPORT_SCHEMA_VERSIONS: readonly number[] = [EXPORT_DATA_SCHEMA_VERSION, 3];

// Maps and Sets nested inside the payload (`app.rddInfo`, each stage's
// `executorMetrics`) would serialize to `{}` under plain JSON, and a widget
// calling `.values()` on one then throws. They travel as tagged plain objects
// instead, which survive JSON and redaction's deep copy alike;
// `reviveExportCollections` turns them back on load.
const MAP_TAG = '__sparkforensicsMap';
const SET_TAG = '__sparkforensicsSet';

export function encodeCollections(value: unknown): unknown {
  if (value instanceof Map) return { [MAP_TAG]: [...value].map(([k, v]) => [encodeCollections(k), encodeCollections(v)]) };
  if (value instanceof Set) return { [SET_TAG]: [...value].map(encodeCollections) };
  if (Array.isArray(value)) return value.map(encodeCollections);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeCollections(v)]));
  }
  return value;
}

/** The in-memory counterpart of `reviveExportCollections`: rebuilds every
 * tagged Map and Set in a tree `encodeCollections` produced, without a JSON
 * round trip. */
export function decodeCollections<T = unknown>(value: unknown): T {
  return decodeTree(value) as T;
}

function decodeTree(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeTree);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record[MAP_TAG])) {
      return new Map((record[MAP_TAG] as [unknown, unknown][]).map(([k, v]) => [decodeTree(k), decodeTree(v)]));
    }
    if (Array.isArray(record[SET_TAG])) return new Set((record[SET_TAG] as unknown[]).map(decodeTree));
    return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, decodeTree(v)]));
  }
  return value;
}

/** `JSON.parse` reviver for the export payload: rebuilds every Map and Set
 * `buildExportRunData` tagged. */
export function reviveExportCollections(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record[MAP_TAG])) return new Map(record[MAP_TAG] as [unknown, unknown][]);
    if (Array.isArray(record[SET_TAG])) return new Set(record[SET_TAG] as unknown[]);
  }
  return value;
}
