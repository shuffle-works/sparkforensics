import { findingKey, type FindingLocator } from '@sparkforensics/core/finding-identity.ts';
import type { Finding } from '@sparkforensics/core/types.ts';

// A stage or execution is named by its id: the keys of one run need no label shared with another.
const RUN_LOCATOR: FindingLocator = { stage: (id) => `#${id}`, execution: (id) => `#${id}` };

/** The core `findingKey` of each finding of a run, made unique: findings that share a key take their
 * order among them as a suffix, so each keeps its own row. */
export function runFindingKeys(findings: readonly Finding[]): (finding: Finding) => string {
  const keyOf = (finding: Finding) => findingKey(finding, RUN_LOCATOR);
  const keys = new Map<Finding, string>();
  const seen = new Map<string, number>();
  for (const finding of findings) {
    const key = keyOf(finding);
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    keys.set(finding, n === 0 ? key : `${key}#${n}`);
  }
  return (finding) => keys.get(finding) ?? keyOf(finding);
}
