// The finding shapes. Each detector folder (detectors/<type>/detect.ts) declares its own members:
// `<Type>Evidence` is the public part, the fields the evidence report publishes (the folder's
// `evidenceKeys` must list every one of them), and anything declared only on `<Type>Finding` is
// internal, read by another core module (the impact estimator, mostly) and never published.
// Renaming or removing an evidence field is a breaking change to the report and needs an
// EVIDENCE_SCHEMA_VERSION bump.
//
// This module holds what several detectors share, re-exports every member from detectors/index.ts
// so the `types` entry point exports them, and assembles `Finding`, a union discriminated on `type`,
// from each folder's `emits`. `FindingType` (detectors.ts) derives the same set from `DETECTORS`'
// `emits` lists, and a compile-time check there keeps the two equal.

import type detectFolders from './detectors/index.ts';
import type { UnionToIntersection } from './detectors/types.ts';

/** One concrete change a finding's fix makes, alongside its prose `recommendation`. Entries are
 * applied together unless the recommendation words them as alternatives ("either ... or"), as an
 * idle-capacity finding does with dynamic allocation off: then a consumer applies one. */
export type Remediation = ConfRemediation | CodeRemediation;

/** A Spark property the detector already names; `suggested` is null when it computes no value.
 * Sizes carry a Spark unit suffix ("384m"), counts are plain numbers, switches are booleans. */
export interface ConfRemediation {
  kind: 'conf';
  key: string;
  direction: 'increase' | 'decrease' | 'set';
  suggested: number | string | boolean | null;
}

/** A fix no Spark property makes: the job's code or data has to change. `hint` is the same
 * wording the finding's `recommendation` gives. */
export interface CodeRemediation {
  kind: 'code';
  hint: string;
}

/** One overridden threshold: the value the detector ran with, and its specification default. */
export interface TunedThreshold {
  value: number | readonly number[];
  default: number | readonly number[];
}

export type TunedThresholds = Readonly<Record<string, TunedThreshold>>;

// A failed or retried task attempt, as a stage keeps a bounded sample of them.
export interface TaskAttemptSample {
  taskId: number | null;
  attemptNumber: number;
  host: string;
  executorId: string;
  reason: string | null;
  peakExecMem: number;
  memSpilled: number;
  shuffleWrite: number;
}

/** What a skewed stage reads, which decides the fix: 'shuffleJoin' (a shuffle feeding a join, where
 * AQE skew-join handling applies), 'inputScan' (uneven input files) or 'other'. */
export type SkewOrigin = 'shuffleJoin' | 'inputScan' | 'other';

/** What AQE skew-join handling did for a 'shuffleJoin' stage, read from the final plan and the
 * effective conf: 'split' (it split the skewed partition, so the rest is not join skew),
 * 'evenReads' (the shuffle reads are even, so no partition is skewed for AQE to split),
 * 'belowThreshold' (the partition is under the effective skew threshold or factor), 'planShape' (an
 * operator sits between the join and its shuffle), 'userRepartition' (the shuffle is an explicit
 * repartition), 'joinType' (the join type does not let AQE split the skewed side),
 * 'extraShuffle' (splitting would add a shuffle for the operator above the join) or 'notSplit'
 * (nothing in the log explains it). */
export type AqeSkewCase = 'split' | 'evenReads' | 'belowThreshold' | 'planShape' | 'userRepartition' | 'joinType' | 'extraShuffle' | 'notSplit';

/** What a stage reads, by the dominant side: a shuffle, input files, or neither. */
export type StageReads = 'shuffle' | 'input' | 'other';

/** Why a shuffle finding's partition-count advice is or is not given: 'raise' (the property limits
 * the stage), 'sufficient' (tasks are already a good size), 'aqeCoalesced' (AQE merged the
 * partitions, so the advisory size is the lever) or 'ownPartitioning' (the property did not size
 * the stage, so the stage's own repartition(n) or RDD parallelism is the lever). */
export type ShufflePartitions = 'raise' | 'sufficient' | 'aqeCoalesced' | 'ownPartitioning';

/** Why a stage's slow tail is slow (attributeTail in stage-quantiles.ts). 'data': the slow tasks
 * read far more than the median task, so run time follows data volume. 'gc', 'fetchWait' and
 * 'host': the tail's extra time is GC, shuffle fetch wait, or tasks piled on one host.
 * 'unexplained': the slow tasks read no more than the median and none of those accounts for their
 * time. 'unattributed': the stage has no data volume to compare and what data, GC, fetch wait and
 * host do not explain is the largest share (or the stage has no tail attribution), so only the
 * duration is known. */
export type TailCause = 'data' | 'gc' | 'fetchWait' | 'host' | 'unexplained' | 'unattributed';

/** Every key of any member of a union: `keyof` alone sees only the keys the members share. */
export type AllKeys<U> = U extends unknown ? keyof U : never;

export type * from './detectors/index.ts';

/** The finding member for one `type`. */
export type FindingOf<T extends Finding['type']> = Extract<Finding, { type: T }>;


/** What every detector emits, merged from the detector folders. */
type Emitted = UnionToIntersection<(typeof detectFolders)[number]['emits']>;

/** Public evidence fields per finding type: what a report row's `evidence` carries. */
export type FindingEvidenceMap = { [T in keyof Emitted]: Emitted[T]['evidence'] };

export type Finding = Emitted[keyof Emitted]['finding'];
