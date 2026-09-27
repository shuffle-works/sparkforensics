import type { Finding, FindingOf } from './types.ts';

/** The findings of one `type`, typed as that type's finding member. */
export function findingsOfType<T extends Finding['type']>(findings: readonly Finding[], type: T): FindingOf<T>[] {
  return findings.filter((f): f is FindingOf<T> => f.type === type);
}

/** A sql-scope finding's linked stages; undefined for every finding that keys on `stageId`. */
export function findingStageIds(f: Finding): number[] | undefined {
  return 'stageIds' in f ? f.stageIds : undefined;
}
