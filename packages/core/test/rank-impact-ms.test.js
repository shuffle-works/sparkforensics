import { describe, it, expect } from 'vitest';
import { rankImpactMs } from '../src/recommendation-rollup.ts';

/** @param {any} impactEstimate */
const row = (impactEstimate) => ({ impactEstimate });

describe('rankImpactMs', () => {
  it('passes coreMs through', () => {
    expect(rankImpactMs(row({ rawWaste: { unit: 'coreMs', value: 12_500 } }))).toBe(12_500);
  });

  it('passes ms through', () => {
    expect(rankImpactMs(row({ rawWaste: { unit: 'ms', value: 8_000 } }))).toBe(8_000);
  });

  it('converts coreHours to milliseconds (0.5 core-hour is 1,800,000 ms)', () => {
    expect(rankImpactMs(row({ rawWaste: { unit: 'coreHours', value: 0.5 } }))).toBe(1_800_000);
  });

  it('gives null for mbSeconds and bytes', () => {
    expect(rankImpactMs(row({ rawWaste: { unit: 'mbSeconds', value: 257_633 } }))).toBeNull();
    expect(rankImpactMs(row({ rawWaste: { unit: 'bytes', value: 4_096 } }))).toBeNull();
  });

  it('falls back to the idle core time high figure when raw waste has a non-ranking unit', () => {
    expect(rankImpactMs(row({
      rawWaste: { unit: 'bytes', value: 4_096 },
      idleCoreTimeMs: { low: 100, high: 9_000 },
    }))).toBe(9_000);
  });

  it('falls back to the idle core time high figure when there is no raw waste', () => {
    expect(rankImpactMs(row({ idleCoreTimeMs: { low: 100, high: 7_000 } }))).toBe(7_000);
  });

  it('gives null for an estimate with no figure and for no estimate', () => {
    expect(rankImpactMs(row({}))).toBeNull();
    expect(rankImpactMs(row(undefined))).toBeNull();
  });
});
