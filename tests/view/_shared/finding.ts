import type { Finding, FindingOf, FindingType } from '@sparkforensics/core/types.ts';

/** A test fixture finding of one `type`, holding only the fields the test needs. Every field
 * given must exist on that type's finding member with its declared type, so a fixture can't drift
 * from the detector's shape, but required evidence fields a test doesn't read may be left out. */
export function testFinding<T extends FindingType>(
  fields: { type: T; impactBand: Finding['impactBand'] } & Partial<FindingOf<T>>,
): FindingOf<T> {
  return fields as FindingOf<T>;
}

/** A finding whose `type` no detector emits, for tests of unknown-type fallbacks. */
export function unknownTypeFinding(fields: { type: string; impactBand: Finding['impactBand'] } & Record<string, unknown>): Finding {
  return fields as unknown as Finding;
}
