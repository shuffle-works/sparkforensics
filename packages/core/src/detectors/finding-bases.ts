// The finding shapes every detector folder builds on: the columns each finding carries, the
// numeric and text value forms, and the plan-finding evidence shared by the SQL plan detectors.
import type { MetricName } from '../finding-presentation.ts';
import type { ImpactBand, ImpactEstimate, StageId } from '../types.ts';
import type { Remediation, TunedThresholds } from '../finding-types.ts';

// The columns every finding carries, whatever its detector.
export interface FindingCore<T extends string> {
  id?: string;
  detectorVersion?: number;
  type: T;
  // Optional (not just nullable): config-scope findings key on `property` and sql-scope findings
  // on `executionId`/`stageIds`, never setting a `stageId`. `auditConfig` backfills `null` for
  // config-scope findings, but sql-scope findings reach consumers with the key absent.
  stageId?: StageId | null;
  impactBand: ImpactBand;
  metric?: MetricName;
  recommendation?: string;
  // Structured form of the property changes `recommendation` names; absent when it names none.
  remediation?: Remediation[];
  docAnchor?: string;
  confidence?: string;
  validationRequired?: string;
  impactEstimate?: ImpactEstimate;
  // Set only when the CLI or MCP server ran this finding's detector with a user override that
  // differs from the specification default: each overridden threshold, keyed by name.
  tunedThresholds?: TunedThresholds;
}

// A finding whose `value` is a magnitude (a ratio, byte count, percentage, duration...). Absent on
// an evidence caveat, which has nothing to measure.
export interface NumericFinding<T extends string> extends FindingCore<T> {
  value?: number;
  valueText?: undefined;
}

// A finding whose observed value is display text (a failure reason, an audited config's current
// value), carried in `valueText` so `value` stays numeric across every finding.
export interface TextFinding<T extends string> extends FindingCore<T> {
  value?: undefined;
  valueText: string;
}

export interface PlanFindingEvidence {
  executionId: number;
  stageIds: number[];
}

// View-layer plan-graph node ids the finding came from (plan-graph-model.ts). An array: a
// duplicate subtree spans many nodes, and a broadcast finding can involve more than one.
export interface PlanNodeOrigin {
  planNodeIds: string[];
}
