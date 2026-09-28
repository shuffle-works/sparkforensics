import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseThresholdOverrides, tunedThresholdsOf, tunedDetectors, tunedDetectorCatalog, describeTunedThresholds,
} from '../src/threshold-overrides.ts';
import { loadThresholdOverrides } from '../src/cli/threshold-config.ts';
import { DETECTORS, detectorCatalog } from '../src/detectors.ts';

const entry = (type) => DETECTORS.find((d) => d.type === type);

describe('parseThresholdOverrides', () => {
  it('accepts numbers and same-length ascending tier tables, and freezes the result', () => {
    const parsed = parseThresholdOverrides({ skew: { ratioWarn: 5 }, slowHost: { ratioTiers: [1.5, 2, 4, 12] }, tinyTask: {} });
    expect(parsed).toEqual({ skew: { ratioWarn: 5 }, slowHost: { ratioTiers: [1.5, 2, 4, 12] }, tinyTask: {} });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.skew)).toBe(true);
    expect(Object.isFrozen(parsed.slowHost.ratioTiers)).toBe(true);
  });

  it.each([
    [[], 'expected a JSON object keyed by detector type'],
    [null, 'expected a JSON object keyed by detector type'],
    [{ skw: {} }, 'unknown detector "skw" (tunable detectors: skew,'],
    [{ configAudit: { floorMB: 1 } }, '"configAudit" is not tunable'],
    [{ stageFailed: {} }, '"stageFailed" has no thresholds to tune'],
    [{ skew: 5 }, '"skew" must be an object of threshold values'],
    [{ skew: { ratioWarm: 5 } }, 'unknown threshold "skew.ratioWarm" (skew thresholds: ratioWarn, minTasksForP95, floorPctWarn)'],
    [{ skew: { ratioWarn: -1 } }, '"skew.ratioWarn" must be a non-negative number'],
    [{ skew: { ratioWarn: '5' } }, '"skew.ratioWarn" must be a non-negative number'],
    [{ skew: { ratioWarn: [5] } }, '"skew.ratioWarn" must be a non-negative number'],
    [{ slowHost: { ratioTiers: [1, 2, 3] } }, '"slowHost.ratioTiers" must be an ascending list of 4 non-negative numbers'],
    [{ slowHost: { ratioTiers: [1, 3, 2, 4] } }, 'must be an ascending list of 4'],
    [{ slowHost: { ratioTiers: 2 } }, 'must be an ascending list of 4'],
  ])('refuses %j', (raw, message) => {
    expect(() => parseThresholdOverrides(raw)).toThrow(message);
  });
});

describe('tuned threshold labels', () => {
  it('reports only the thresholds an override moves off the default', () => {
    const overrides = parseThresholdOverrides({ skew: { ratioWarn: 5, minTasksForP95: 20 } });
    expect(tunedThresholdsOf(entry('skew'), overrides)).toEqual({ ratioWarn: { value: 5, default: 3 } });
    expect(tunedThresholdsOf(entry('skew'), parseThresholdOverrides({ skew: { ratioWarn: 3 } }))).toBeNull();
    expect(tunedThresholdsOf(entry('skew'), undefined)).toBeNull();
    expect(tunedDetectors(overrides)).toEqual({ skew: { ratioWarn: { value: 5, default: 3 } } });
    expect(tunedDetectors(undefined)).toBeNull();
  });

  it('compares tier tables by value', () => {
    const tiers = [...entry('slowHost').thresholds.ratioTiers];
    expect(tunedThresholdsOf(entry('slowHost'), parseThresholdOverrides({ slowHost: { ratioTiers: tiers } }))).toBeNull();
    expect(describeTunedThresholds({ ratioTiers: { value: [1, 2], default: [3, 4] } })).toBe('ratioTiers [1, 2] (default [3, 4])');
  });

  it('shows a tuned row\'s effective thresholds in the catalog and leaves the others as they are', () => {
    const catalog = tunedDetectorCatalog(parseThresholdOverrides({ skew: { ratioWarn: 5 } }));
    const skew = catalog.find((row) => row.type === 'skew');
    expect(skew.thresholds).toEqual({ ...entry('skew').thresholds, ratioWarn: 5 });
    expect(skew.tunedThresholds).toEqual({ ratioWarn: { value: 5, default: 3 } });
    const others = catalog.filter((row) => row.type !== 'skew');
    expect(others).toEqual(detectorCatalog().filter((row) => row.type !== 'skew'));
    expect(tunedDetectorCatalog(undefined)).toEqual(detectorCatalog());
  });
});

describe('loadThresholdOverrides', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-thresholds-'));
  const write = (name, text) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };

  it('reads and validates a JSON file', () => {
    expect(loadThresholdOverrides(write('ok.json', '{"skew":{"ratioWarn":5}}'))).toEqual({ skew: { ratioWarn: 5 } });
  });

  it('refuses a missing, malformed or invalid file, naming it', () => {
    const missing = join(dir, 'missing.json');
    expect(() => loadThresholdOverrides(missing)).toThrow(`Cannot read thresholds file ${missing}:`);
    const bad = write('bad.json', '{"skew":');
    expect(() => loadThresholdOverrides(bad)).toThrow(`Thresholds file ${bad} is not valid JSON:`);
    const invalid = write('invalid.json', '{"skew":{"ratioWarn":-1}}');
    expect(() => loadThresholdOverrides(invalid)).toThrow(`Thresholds file ${invalid}: "skew.ratioWarn" must be a non-negative number`);
  });
});
