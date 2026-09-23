import { describe, it, expect } from 'vitest';
import { requiredTuningSlugs } from '../scripts/fetch-tuning-docs.mjs';

describe('requiredTuningSlugs', () => {
  it('strips the bottleneck- prefix for page-owning anchors', () => {
    expect(requiredTuningSlugs(['bottleneck-skew', 'bottleneck-shuffle'])).toEqual(['shuffle', 'skew']);
  });

  it('collapses stage-shape/stage-slowness sub-anchors into their owning page slug', () => {
    expect(requiredTuningSlugs(['bottleneck-stage-shape', 'bottleneck-skew'])).toEqual(['skew']);
    expect(requiredTuningSlugs(['bottleneck-stage-slowness', 'bottleneck-slow-host'])).toEqual(['slow-host']);
  });

  it('ignores non-bottleneck anchors', () => {
    expect(requiredTuningSlugs(['metric-task-duration', 'config-serializer', 'bottleneck-gc'])).toEqual(['gc']);
  });

  it('dedupes and sorts', () => {
    expect(requiredTuningSlugs(['bottleneck-skew', 'bottleneck-skew'])).toEqual(['skew']);
  });
});
