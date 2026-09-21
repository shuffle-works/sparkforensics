import { describe, it, expect } from 'vitest';
import { deriveImpactBand } from '../src/impact-band.ts';
import type { Finding, SparkAppInfo } from '../src/types.ts';

const APP_20_MIN: SparkAppInfo = { startTime: 0, endTime: 20 * 60_000 };

function timeFinding(impactBand: Finding['impactBand'], recoverableMs: number): Finding {
  return {
    type: 'tinyTask',
    impactBand,
    impactEstimate: { basis: 'serial', wallClock: { low: recoverableMs, high: recoverableMs }, estimateMethod: 'modeled' },
  } as Finding;
}

function resourceOnlyFinding(impactBand: Finding['impactBand']): Finding {
  return {
    type: 'memoryUtilization',
    impactBand,
    impactEstimate: { basis: 'resourceOnly', wallClock: null, estimateMethod: 'modeled', rawWaste: { value: 10, unit: 'mbSeconds' } },
  } as Finding;
}

function informationalFinding(impactBand: Finding['impactBand']): Finding {
  return {
    type: 'configAudit',
    impactBand,
    impactEstimate: { basis: 'informational', wallClock: null, estimateMethod: 'none' },
  } as Finding;
}

describe('deriveImpactBand', () => {
  it('promotes an info-graded finding to critical when recoverable time is a large fraction of the run', () => {
    // 30_000ms recoverable / 1_200_000ms run = 2.5%, over the 2% critical floor.
    const findings = [timeFinding('info', 30_000)];
    deriveImpactBand(findings, APP_20_MIN);
    expect(findings[0].impactBand).toBe('critical');
  });

  it('demotes a critical-graded finding to info when recoverable time is negligible', () => {
    // 1_000ms recoverable / 1_200_000ms run = 0.083%, under the 0.5% warning floor.
    const findings = [timeFinding('critical', 1_000)];
    deriveImpactBand(findings, APP_20_MIN);
    expect(findings[0].impactBand).toBe('info');
  });

  it('grades a mid-range recoverable time as warning', () => {
    // 10_000ms recoverable / 1_200_000ms run = 0.833%, between the two floors.
    const findings = [timeFinding('info', 10_000)];
    deriveImpactBand(findings, APP_20_MIN);
    expect(findings[0].impactBand).toBe('warning');
  });

  it('grades on wallClock.high, not .low', () => {
    // low = 1_000ms (0.083% of the run, under the warning floor), high =
    // 30_000ms (2.5%, over the critical floor): grading on .high must land
    // critical, not info.
    const findings: Finding[] = [{
      type: 'tinyTask',
      impactBand: 'info',
      impactEstimate: { basis: 'contended', wallClock: { low: 1_000, high: 30_000 }, estimateMethod: 'modeled' },
    } as Finding];
    deriveImpactBand(findings, APP_20_MIN);
    expect(findings[0].impactBand).toBe('critical');
  });

  it('leaves resourceOnly findings (no wallClock estimate) untouched', () => {
    const findings = [resourceOnlyFinding('critical')];
    deriveImpactBand(findings, APP_20_MIN);
    expect(findings[0].impactBand).toBe('critical');
  });

  it('leaves informational findings (no wallClock estimate) untouched', () => {
    const findings = [informationalFinding('info')];
    deriveImpactBand(findings, APP_20_MIN);
    expect(findings[0].impactBand).toBe('info');
  });

  it('leaves impactBand untouched when app duration is unknown', () => {
    const findings = [timeFinding('info', 30_000)];
    deriveImpactBand(findings, null);
    expect(findings[0].impactBand).toBe('info');
  });

  it('leaves impactBand untouched when app duration is zero or negative', () => {
    const findings = [timeFinding('info', 30_000)];
    deriveImpactBand(findings, { startTime: 1000, endTime: 1000 });
    expect(findings[0].impactBand).toBe('info');
  });

  it('never demotes maxPartitionTooBig (regression): a safety signal, not a time-recovery one', () => {
    // A 2-hour app whose maxPartitionTooBig-triggering stage only saves ~10s of wall-clock time:
    // 10_000 / 7_200_000 = 0.14%, well under the 0.5% warning floor, which would demote any other
    // wallClock-bearing finding all the way down to 'info'.
    const app: SparkAppInfo = { startTime: 0, endTime: 2 * 60 * 60_000 };
    const findings: Finding[] = [{
      type: 'partitionSizing', rule: 'maxPartitionTooBig', impactBand: 'critical',
      impactEstimate: { basis: 'serial', wallClock: { low: 10_000, high: 10_000 }, estimateMethod: 'modeled' },
    } as Finding];
    deriveImpactBand(findings, app);
    expect(findings[0].impactBand).toBe('critical');
  });

  it('still grades every other partitionSizing rule normally (exemption is rule-scoped, not type-scoped)', () => {
    const app: SparkAppInfo = { startTime: 0, endTime: 2 * 60 * 60_000 };
    const findings: Finding[] = [{
      type: 'partitionSizing', rule: 'shufflePartitionSkew', impactBand: 'warning',
      impactEstimate: { basis: 'serial', wallClock: { low: 10_000, high: 10_000 }, estimateMethod: 'modeled' },
    } as Finding];
    deriveImpactBand(findings, app);
    expect(findings[0].impactBand).toBe('info');
  });
});
