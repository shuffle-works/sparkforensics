import { test, expect } from 'vitest';
import { stageWidgetFrequency } from '../src/stage-widget-frequency.js';

test('stageWidgetFrequency counts distinct board widgets flagging each stage, deduping same-widget types', () => {
  const freq = stageWidgetFrequency([
    { stageId: 1, type: 'skew' },
    { stageId: 1, type: 'straggler' }, // same widget (task-skew) as skew: counts once
    { stageId: 1, type: 'shuffle' }, // a different widget: bumps the count
    { stageId: 2, type: 'gc' },
    { stageId: 2, type: 'coldStart' }, // a different widget than gc: bumps the count
  ]);
  expect(freq.get(1)).toBe(2);
  expect(freq.get(2)).toBe(2);
});
test('stageWidgetFrequency ignores findings with no stageId or with an unmapped type', () => {
  const freq = stageWidgetFrequency([
    { stageId: null, type: 'skew' },
    { type: 'shuffle' },
    { stageId: 3, type: 'configAudit' },
  ]);
  expect(freq.size).toBe(0);
});
