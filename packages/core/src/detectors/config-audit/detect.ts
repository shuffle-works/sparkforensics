import { noWasteModel } from '../../impact-model.ts';
import { increaseConf, setConf } from '../../remediation.ts';
import { effectiveSparkConf } from '../../spark-conf.ts';
import type { Finding, FindingOf } from '../../types.ts';
import { defaultOverheadSettings, effectiveConf, hasStageOutsideSql } from '../conf.ts';
import { defineConfigDetector } from '../define.ts';
import { setConfUnlessLogged } from '../fixes.ts';
import type { TextFinding } from '../finding-bases.ts';
import type { AllKeys } from '../../finding-types.ts';
import type { DiscriminatorSlot } from '../../finding-meta.ts';

export interface ConfigAuditEvidence {
  property: string;
}

// valueText is the audited property's current value, or a note that it is unset.
export interface ConfigAuditFinding extends TextFinding<'configAudit'>, ConfigAuditEvidence {}

// Spark's default spark.dynamicAllocation.maxExecutors: no upper bound.
const UNBOUNDED_EXECUTORS = 2147483647;

export const configAuditAutoscaleBoundsDetector = defineConfigDetector({
  type: 'configAudit', order: 121, bandPolicy: 'own', fixEffort: 'config', version: 1, inScorecard: false,
  emits: ['configAudit'],
  docAnchor: '#config-autoscale-bounds', thresholds: {}, property: 'spark.dynamicAllocation.maxExecutors',
  detect(target): Finding | null {
    const app = target.app; const res = app?.resources ?? null;
    if (res?.dynamicAllocationEnabled !== true) return null;
    // minExecutors > maxExecutors is not audited: ExecutorAllocationManager.validateSettings throws on it
    // at startup (v3.5.0 lines 196-199), so no run that wrote an event log has inverted bounds.
    // Unbounded is the effective maxExecutors being Spark's default (Int.MaxValue) or that value set.
    const maxN = Number.parseInt(effectiveConf(app, 'spark.dynamicAllocation.maxExecutors') ?? '', 10);
    if (!Number.isFinite(maxN) || maxN >= UNBOUNDED_EXECUTORS) {
      return {
        type: 'configAudit', property: 'spark.dynamicAllocation.maxExecutors',
        impactBand: 'info', metric: 'config', valueText: '(unset)',
        recommendation: 'Dynamic allocation is on with no upper bound: set spark.dynamicAllocation.maxExecutors to cap cluster growth.',
        remediation: [setConf('spark.dynamicAllocation.maxExecutors')],
      };
    }
    return null;
  },
  estimate: noWasteModel,
});

export const configAuditSerializerDetector = defineConfigDetector({
  type: 'configAudit', order: 122, bandPolicy: 'own', fixEffort: 'config', version: 1, inScorecard: false,
  emits: ['configAudit'],
  docAnchor: '#config-serializer', thresholds: {}, property: 'spark.serializer',
  detect(target): Finding | null {
    const app = target.app; const config = app?.config ?? {}; const res = app?.resources ?? null;
    if (Object.keys(config).length === 0) return null;
    // spark.serializer does not serialize SQL rows (shuffles and caches use UnsafeRow and the columnar
    // cache serializer), so the note only applies to a run that ran stages outside any SQL execution.
    // Without the stages there is no evidence of RDD work and no claim.
    if (!hasStageOutsideSql(target.stages)) return null;
    // The serializer the run set; Spark's own default (JavaSerializer) is reported as the default.
    const effective = effectiveSparkConf({ sparkVersion: app?.sparkVersion, properties: config }, 'spark.serializer');
    const ser = res?.serializer ?? (effective?.source === 'default' ? null : effective?.value ?? null);
    const isKryo = typeof ser === 'string' && /kryo/i.test(ser);
    if (isKryo) return null;
    return {
      type: 'configAudit', property: 'spark.serializer',
      impactBand: 'info', metric: 'config', valueText: ser ?? '(default JavaSerializer)',
      recommendation: `Current serializer is ${ser ?? 'the default JavaSerializer'}: consider spark.serializer=org.apache.spark.serializer.KryoSerializer for faster, smaller buffers.`,
      remediation: setConfUnlessLogged(app, 'spark.serializer', 'org.apache.spark.serializer.KryoSerializer'),
    };
  },
  estimate: noWasteModel,
});

export const configAuditMemoryOverheadDetector = defineConfigDetector({
  type: 'configAudit', order: 123, bandPolicy: 'own', fixEffort: 'config', version: 1, inScorecard: false,
  emits: ['configAudit'],
  docAnchor: '#config-memory-overhead', thresholds: { floorMB: 384, floorPct: 0.1 }, property: 'spark.executor.memoryOverhead',
  detect(target, thresholds): Finding | null {
    const res = target.app?.resources ?? null;
    const memMB = res?.executor?.memoryMB ?? null;
    const ovMB = res?.executor?.memoryOverheadMB ?? null;
    if (memMB == null || ovMB == null) return null;
    const { minMB, factor } = defaultOverheadSettings(target.app, thresholds);
    const floor = Math.max(minMB, Math.round(memMB * factor));
    if (ovMB >= floor) return null;
    return {
      type: 'configAudit', property: 'spark.executor.memoryOverhead',
      impactBand: 'info', metric: 'config', valueText: `${ovMB} MiB`,
      recommendation: `Executor memoryOverhead (${ovMB} MiB) is below the ${floor} MiB Spark would have defaulted to (max of ${minMB} MiB or ${Math.round(factor * 1000) / 10}% of executor memory): raise it to avoid off-heap OOM-kills.`,
      remediation: [increaseConf('spark.executor.memoryOverhead', `${floor}m`)],
    };
  },
  estimate: noWasteModel,
});

/** What this detector emits per finding type: its finding members and their public evidence. */
export interface Emits {
  configAudit: { finding: ConfigAuditFinding; evidence: ConfigAuditEvidence };
}

export const detectors = [configAuditAutoscaleBoundsDetector, configAuditSerializerDetector, configAuditMemoryOverheadDetector] as const;

/** The public evidence fields per emitted type, as the evidence report lists them. */
export const evidenceKeys = {
  configAudit: ['property'],
} as const satisfies {
  configAudit: readonly AllKeys<ConfigAuditEvidence>[];
};

/** The fields that tell sibling findings apart in their id (see findingId). */
export const idDiscriminators = {
  configAudit: [],
} as const satisfies {
  configAudit: readonly (DiscriminatorSlot & AllKeys<FindingOf<'configAudit'>>)[];
};
