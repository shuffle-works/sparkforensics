import { describe, expect, it } from 'vitest';

import { evidenceAddsDetail } from '@/view/evidence-detail';
import { testFinding } from './_shared/finding';

const smallFiles = (id: string) => testFinding({ type: 'smallFiles', impactBand: 'warning', id });
const memory = (id: string, variant: 'idleCores' | 'memoryBand') =>
  testFinding({ type: 'memoryUtilization', impactBand: 'warning', id, variant });

describe('evidenceAddsDetail', () => {
  it('is true for a type whose widget shows facts the line lacks', () => {
    const finding = testFinding({ type: 'spill', impactBand: 'warning', id: 'a' });
    expect(evidenceAddsDetail(finding, [finding], 'basic')).toBe(true);
  });

  it('is false for a lone finding whose line states everything its widget shows', () => {
    const finding = testFinding({ type: 'utilization', impactBand: 'warning', id: 'a' });
    expect(evidenceAddsDetail(finding, [finding], 'basic')).toBe(false);
    expect(evidenceAddsDetail(finding, [finding], 'advanced')).toBe(false);
  });

  it('is true when the widget also lists another finding of the type', () => {
    const [first, second] = [smallFiles('a'), smallFiles('b')];
    expect(evidenceAddsDetail(first, [first, second], 'basic')).toBe(true);
  });

  it('counts the Advanced status marker as detail', () => {
    const finding = smallFiles('a');
    expect(evidenceAddsDetail(finding, [finding], 'basic')).toBe(false);
    expect(evidenceAddsDetail(finding, [finding], 'advanced')).toBe(true);
  });

  it('keeps the executor of a memory band, but not an idle-core rate, at the Basic view', () => {
    const band = memory('a', 'memoryBand');
    const idle = memory('b', 'idleCores');
    expect(evidenceAddsDetail(band, [band], 'basic')).toBe(true);
    expect(evidenceAddsDetail(idle, [idle], 'basic')).toBe(false);
  });
});
