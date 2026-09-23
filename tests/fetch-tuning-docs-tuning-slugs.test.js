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

  // A chapter-hosted sub-anchor mapped as its own page would demand a
  // content/bottlenecks/autoscaling-churn.md that upstream never ships.
  it('requires no bottleneck page for sub-anchors hosted on a chapter', () => {
    expect(requiredTuningSlugs(['bottleneck-autoscaling-churn', 'bottleneck-cache-utilization'])).toEqual([]);
    expect(requiredTuningSlugs(['bottleneck-partition-sizing', 'bottleneck-core-locality'])).toEqual(['shuffle', 'utilization']);
  });

  it('ignores non-bottleneck anchors', () => {
    expect(requiredTuningSlugs(['metric-task-duration', 'config-serializer', 'bottleneck-gc'])).toEqual(['gc']);
  });

  it('dedupes and sorts', () => {
    expect(requiredTuningSlugs(['bottleneck-skew', 'bottleneck-skew'])).toEqual(['skew']);
  });
});
