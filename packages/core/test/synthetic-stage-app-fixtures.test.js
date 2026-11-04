import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { analyzedRunFrom } from './fixtures/analyzed-run.js';

// Hand-made logs, each built so one detector fires at its default thresholds.
/** @param {string} name */
const analyzeFixture = async (name) => {
  const run = await analyzedRunFrom(fileURLToPath(new URL(`./fixtures/synthetic/${name}.ndjson`, import.meta.url)));
  return { appModel: run.appModel, findings: run.catalog };
};
/**
 * @template {import('../src/finding-types.ts').Finding['type']} T
 * @param {import('../src/finding-types.ts').Finding[]} findings
 * @param {T} type
 * @returns {Extract<import('../src/finding-types.ts').Finding, { type: T }>[]}
 */
const ofType = (findings, type) => findings.filter(
  /** @returns {f is Extract<import('../src/finding-types.ts').Finding, { type: T }>} */
  (f) => f.type === type,
);

describe('synthetic stage and app fixtures', () => {
  it('stage-slowness: one 17-minute input scan, flagged on that stage and not on the short one', async () => {
    const { appModel, findings } = await analyzeFixture('stage-slowness');
    expect(appModel.skippedLines).toBe(0);
    const slow = ofType(findings, 'stageSlowness');
    expect(slow.map((f) => f.stageId)).toEqual([0]);
    expect(slow[0].impactBand).toBe('info');
    expect(slow[0].reads).toBe('input');
    expect(slow[0].value).toBeGreaterThanOrEqual(15);
    expect(ofType(findings, 'slowHost')).toEqual([]);
  });

  it('right-sizing: 16 cores held, every stage has 8 tasks, so 8 cores model the same time', async () => {
    const { appModel, findings } = await analyzeFixture('right-sizing');
    expect(appModel.skippedLines).toBe(0);
    const [f, ...rest] = ofType(findings, 'rightSizing');
    expect(rest).toEqual([]);
    expect(f.stageId).toBeNull();
    expect(f.observedCores).toBe(16);
    expect(f.value).toBe(8);
    expect(f.impactBand).toBe('warning');
  });

  it('core-locality: 16 of 54 tasks ran RACK_LOCAL or ANY', async () => {
    const { appModel, findings } = await analyzeFixture('core-locality');
    expect(appModel.skippedLines).toBe(0);
    const [f, ...rest] = ofType(findings, 'coreLocality');
    expect(rest).toEqual([]);
    expect(f.stageId).toBeNull();
    expect(f.nonLocalTaskCount).toBe(16);
    expect(f.value).toBe(30);
    expect(f.impactBand).toBe('warning');
  });

  it('autoscaling-churn: 5 of 9 removed executors lived under 2 minutes with dynamic allocation on', async () => {
    const { appModel, findings } = await analyzeFixture('autoscaling-churn');
    expect(appModel.skippedLines).toBe(0);
    const [f, ...rest] = ofType(findings, 'autoscalingChurn');
    expect(rest).toEqual([]);
    expect(f.stageId).toBeNull();
    expect(f.shortLivedExecutorCount).toBe(5);
    expect(f.value).toBe(56);
    expect(f.dynamicAllocation).toBe('on');
    expect(f.impactBand).toBe('warning');
  });

  it('speculation-waste: six losing copies are flagged as core time, and the stage whose copies won is not', async () => {
    const { appModel, findings } = await analyzeFixture('speculation-waste');
    expect(appModel.skippedLines).toBe(0);
    const [f, ...rest] = ofType(findings, 'speculationWaste');
    expect(rest).toEqual([]);
    expect(f.stageId).toBe(0);
    expect(f.value).toBe(150000);
    expect(f.impactBand).toBe('warning');
    expect(f.impactEstimate).toMatchObject({ basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured' });
  });
});
