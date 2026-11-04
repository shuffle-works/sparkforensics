import { formatBytes } from '../../units.ts';
import { walkPlanTree } from '../../plan-tree-walk.ts';
import { costOnly, withAssumptions } from '../../impact-model.ts';
import type { Finding, ImpactEstimate, PlanNode, FindingOf } from '../../types.ts';
import { cachingReuseConfidence } from '../confidence.ts';
import { defineAppDetector } from '../define.ts';
import { FILES_READ_BYTES, findCompositeCandidates, relationIdOf } from '../plan-shape.ts';
import { MB } from '../units.ts';
import type { NumericFinding } from '../finding-bases.ts';
import type { AllKeys } from '../../finding-types.ts';
import type { DiscriminatorSlot } from '../../finding-meta.ts';

interface CachingReuseEvidence {
  relation: string;
  format: string;
  executionIds: number[];
  totalReadBytes: number;
}

// A relation scanned by several SQL executions (no `variant`, so the key is absent at runtime).
export interface CachingRelationEvidence extends CachingReuseEvidence {
  variant?: undefined;
}

// A join/union result several executions recompute, which lists its leaf relations.
export interface CachingCompositeEvidence extends CachingReuseEvidence {
  variant: 'composite';
  relations: { relation: string; format: string }[];
  operator: 'join' | 'union';
}

export type CachingOpportunityEvidence = CachingRelationEvidence | CachingCompositeEvidence;

export interface CachingRelationFinding extends NumericFinding<'cachingOpportunity'>, CachingRelationEvidence {}

export interface CachingCompositeFinding extends NumericFinding<'cachingOpportunity'>, CachingCompositeEvidence {}

export type CachingOpportunityFinding = CachingRelationFinding | CachingCompositeFinding;

export const cachingOpportunityDetector = defineAppDetector({
  // Cross-execution relation reuse: flags an input relation scanned by two or more SQL
  // executions in one run, firing on real relation names (parquet:..., jdbc:...).
  type: 'cachingOpportunity', order: 105, bandPolicy: 'own', fixEffort: 'code', version: 1,
  emits: ['cachingOpportunity'],
  docAnchor: '#bottleneck-caching-opportunity',
  thresholds: { minExecutions: 2 },
  detect(ctx, thresholds): Finding[] | null {
    const sql = ctx.sql;
    if (!(sql instanceof Map) || sql.size === 0) return null;

    interface RelationAgg {
      format: string; relation: string;
      executionIds: Set<number>; executionBytes: Map<number, number>;
    }
    interface PerExecCompositeAgg {
      operator: 'join' | 'union'; node: PlanNode;
      leafRelationBytes: Map<string, number>; ancestorFingerprints: Set<string>;
    }
    interface ByCompositeAgg {
      operator: 'join' | 'union'; exampleNode: PlanNode;
      executionIds: Set<number>; executionBytes: Map<number, number>;
      ancestorFingerprints: Set<string>; leafRelationRids: Set<string>;
    }
    interface CompositeResolution { finalExecutionIds: Set<number>; suppressed: boolean; }

    const byRelation = new Map<string, RelationAgg>();
    for (const exec of sql.values()) {
      if (!exec.planTree) continue;
      // Dedupe relations within one execution (self-joins count once), summing read bytes per relation.
      const perExec = new Map<string, number>();
      walkPlanTree(exec.planTree, (node) => {
        const rid = relationIdOf(node);
        if (!rid) return;
        const bytesMetric = (node.metrics ?? []).find(m => m.name === FILES_READ_BYTES);
        perExec.set(rid, (perExec.get(rid) ?? 0) + (bytesMetric ? bytesMetric.value : 0));
      });
      for (const [rid, bytes] of perExec) {
        let agg = byRelation.get(rid);
        if (!agg) {
          const colon = rid.indexOf(':');
          agg = { format: rid.slice(0, colon), relation: rid.slice(colon + 1), executionIds: new Set(), executionBytes: new Map() };
          byRelation.set(rid, agg);
        }
        agg.executionIds.add(exec.id);
        agg.executionBytes.set(exec.id, (agg.executionBytes.get(exec.id) ?? 0) + bytes);
      }
    }

    const byComposite = new Map<string, ByCompositeAgg>();
    for (const exec of sql.values()) {
      if (!exec.planTree) continue;
      const candidates = findCompositeCandidates(exec.planTree);
      const fingerprintByNode = new Map<PlanNode, string>(candidates.map((c): [PlanNode, string] => [c.node, c.fingerprint]));

      // Dedupe identical fingerprints within this execution (repeated composite counts once).
      const perExecComposite = new Map<string, PerExecCompositeAgg>();
      for (const c of candidates) {
        let agg = perExecComposite.get(c.fingerprint);
        if (!agg) {
          agg = {
            operator: c.operator, node: c.node,
            leafRelationBytes: new Map(),
            ancestorFingerprints: new Set(
              c.ancestorNodes.map(n => fingerprintByNode.get(n)).filter((fp): fp is string => Boolean(fp)),
            ),
          };
          perExecComposite.set(c.fingerprint, agg);
        }
        for (const [rid, bytes] of c.leafRelationBytes) {
          agg.leafRelationBytes.set(rid, (agg.leafRelationBytes.get(rid) ?? 0) + bytes);
        }
      }

      for (const [fingerprint, agg] of perExecComposite) {
        let cAgg = byComposite.get(fingerprint);
        if (!cAgg) {
          cAgg = {
            operator: agg.operator, exampleNode: agg.node,
            executionIds: new Set(), executionBytes: new Map(),
            ancestorFingerprints: new Set(), leafRelationRids: new Set(),
          };
          byComposite.set(fingerprint, cAgg);
        }
        cAgg.executionIds.add(exec.id);
        const execBytes = [...agg.leafRelationBytes.values()].reduce((sum, b) => sum + b, 0);
        cAgg.executionBytes.set(exec.id, (cAgg.executionBytes.get(exec.id) ?? 0) + execBytes);
        for (const af of agg.ancestorFingerprints) cAgg.ancestorFingerprints.add(af);
        for (const rid of agg.leafRelationBytes.keys()) cAgg.leafRelationRids.add(rid);
      }
    }

    // Qualifying = enough distinct executions on its own. Nested-dedupe: a qualifying composite
    // with a qualifying ANCESTOR is subsumed, fully (equal sets) or partially (residual).
    const isQualifying = (fp: string): boolean =>
      byComposite.has(fp) && byComposite.get(fp)!.executionIds.size >= thresholds.minExecutions;
    const compositeResolutions = new Map<string, CompositeResolution>();
    for (const [fingerprint, agg] of byComposite) {
      if (!isQualifying(fingerprint)) { compositeResolutions.set(fingerprint, { finalExecutionIds: agg.executionIds, suppressed: true }); continue; }
      const qualifyingAncestors = [...agg.ancestorFingerprints].filter(isQualifying).map(fp => byComposite.get(fp)!);
      if (qualifyingAncestors.length === 0) { compositeResolutions.set(fingerprint, { finalExecutionIds: agg.executionIds, suppressed: false }); continue; }
      const coveredByAncestors = new Set(qualifyingAncestors.flatMap(outer => [...outer.executionIds]));
      const residual = new Set([...agg.executionIds].filter(id => !coveredByAncestors.has(id)));
      if (residual.size === 0) compositeResolutions.set(fingerprint, { finalExecutionIds: residual, suppressed: true });
      else if (residual.size < thresholds.minExecutions) compositeResolutions.set(fingerprint, { finalExecutionIds: residual, suppressed: true });
      else compositeResolutions.set(fingerprint, { finalExecutionIds: residual, suppressed: false });
    }

    const relationDisplayName = (rid: string): string => rid.slice(rid.indexOf(':') + 1);
    const compositeVerb: Record<'join' | 'union', [string, string]> = { join: ['joined', 'join'], union: ['unioned', 'union'] };

    const out: Finding[] = [];
    // rid -> Set<execId> covered by an emitted composite, for leaf suppression.
    const coveredExecutionsByRid = new Map<string, Set<number>>();
    for (const [fingerprint, agg] of byComposite) {
      const resolution = compositeResolutions.get(fingerprint)!;
      if (resolution.suppressed) continue;
      const finalExecutionIds = [...resolution.finalExecutionIds].sort((a, b) => a - b);
      const totalReadBytes = finalExecutionIds.reduce((sum, id) => sum + (agg.executionBytes.get(id) ?? 0), 0);
      const rids = [...agg.leafRelationRids].sort();
      if (rids.length === 0) continue;
      const relations = rids.map(rid => {
        const colon = rid.indexOf(':');
        return { relation: rid.slice(colon + 1), format: rid.slice(0, colon) };
      });
      const [verb, connector] = compositeVerb[agg.operator];
      const relationDisplay = rids.map(relationDisplayName).join(` ${connector} `);
      const value = finalExecutionIds.length;
      const recommendation = totalReadBytes >= 128 * MB
        ? `${verb[0].toUpperCase()}${verb.slice(1)} result read by ${value} queries (~${formatBytes(totalReadBytes)}): cache/persist the ${verb} DataFrame so it is computed once.`
        : `${verb[0].toUpperCase()}${verb.slice(1)} result read by ${value} queries: cache the ${verb} DataFrame, or reconsider whether it needs to be recomputed each time.`;

      out.push({
        type: 'cachingOpportunity', variant: 'composite', stageId: null, impactBand: 'info',
        metric: 'executionReuse', value,
        format: 'derived', relations, operator: agg.operator, relation: relationDisplay,
        executionIds: finalExecutionIds, totalReadBytes,
        confidence: cachingReuseConfidence(value, thresholds.minExecutions),
        validationRequired:
          'Composite reuse is inferred from a structural plan-shape match (operator + normalized ' +
          'join/filter condition + child shapes) across SQL executions; confirm these executions ' +
          'truly compute the same join/union before caching.',
        recommendation,
      });

      for (const rid of rids) {
        if (!coveredExecutionsByRid.has(rid)) coveredExecutionsByRid.set(rid, new Set());
        for (const id of finalExecutionIds) coveredExecutionsByRid.get(rid)!.add(id);
      }
    }

    for (const [rid, agg] of byRelation) {
      const covered = coveredExecutionsByRid.get(rid);
      const residualExecutionIds = covered
        ? [...agg.executionIds].filter(id => !covered.has(id))
        : [...agg.executionIds];
      if (residualExecutionIds.length < thresholds.minExecutions) continue;
      const value = residualExecutionIds.length;
      const totalReadBytes = residualExecutionIds.reduce((sum, id) => sum + (agg.executionBytes.get(id) ?? 0), 0);
      const recommendation = totalReadBytes >= 128 * MB
        ? `Read by ${value} queries (~${formatBytes(totalReadBytes)}): cache/persist the shared DataFrame so it is scanned once.`
        : `Read by ${value} queries: cache the shared DataFrame, or broadcast it if it is a small join lookup.`;
      out.push({
        type: 'cachingOpportunity', stageId: null, impactBand: 'info',
        metric: 'executionReuse', value,
        relation: agg.relation, format: agg.format,
        executionIds: residualExecutionIds.sort((a, b) => a - b),
        totalReadBytes,
        confidence: cachingReuseConfidence(value, thresholds.minExecutions),
        validationRequired:
          'Relation-reuse is inferred from the pre-AQE plan scan identity across SQL ' +
          'executions; confirm the reads are the same data and cacheable within one ' +
          'session before acting.',
        recommendation,
      });
    }
    return out;
  },
  estimate(finding): ImpactEstimate | null {
    const totalReadBytes = (finding.totalReadBytes as number | undefined) ?? 0;
    // The measured scan volume and the query count, not a time: the bytes are cumulative task
    // input across queries, and a re-read cost depends on how much of it a cache would serve.
    const queries = (finding.executionIds as number[] | undefined)?.length ?? 0;
    return withAssumptions(
      costOnly('measured', { value: totalReadBytes, unit: 'bytes', reread: true }),
      `counts the bytes ${queries} ${queries === 1 ? 'query' : 'queries'} scanned from the same relation, matched by plan; a cache would still read it once`,
    );
  },
});

/** What this detector emits per finding type: its finding members and their public evidence. */
export interface Emits {
  cachingOpportunity: { finding: CachingRelationFinding | CachingCompositeFinding; evidence: CachingOpportunityEvidence };
}

export declare const emits: Emits;

export const detectors = [cachingOpportunityDetector] as const;

/** The public evidence fields per emitted type, as the evidence report lists them. */
export const evidenceKeys = {
  cachingOpportunity: ['variant', 'relation', 'format', 'relations', 'operator', 'executionIds', 'totalReadBytes'],
} as const satisfies {
  cachingOpportunity: readonly AllKeys<CachingOpportunityEvidence>[];
};

/** The fields that tell sibling findings apart in their id (see findingId). */
export const idDiscriminators = {
  cachingOpportunity: ['variant', 'relation', 'format', 'operator', 'executionIds'],
} as const satisfies {
  cachingOpportunity: readonly (DiscriminatorSlot & AllKeys<FindingOf<'cachingOpportunity'>>)[];
};
