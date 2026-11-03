import { expect, test } from 'vitest';

import type { Finding } from '@sparkforensics/core/types';
import { runFindingKeys } from '@/view/finding-keys';
import { testFinding } from './_shared/finding';

function skewFinding(stageId = 1): Finding {
  return testFinding({ type: 'skew', stageId, impactBand: 'warning', recommendation: 'Salt the key.' });
}

function stageShapeFinding(stageId = 1): Finding {
  return testFinding({ type: 'stageShape', stageId, impactBand: 'info', recommendation: 'Check partition count.', rule: 'lowParallelism' });
}

test('runFindingKeys gives findings that share a core key one key each, and leaves a lone finding its core key', () => {
  const [a, b, lone] = [skewFinding(1), skewFinding(2), stageShapeFinding(3)];
  const keys = runFindingKeys([a, b, lone]);
  expect([keys(a), keys(b), keys(lone)]).toEqual(['skew|skew|stage:#1', 'skew|skew|stage:#2', 'stageShape|lowParallelism|stage:#3']);
  const twin = skewFinding(1);
  const twins = runFindingKeys([a, twin]);
  expect([twins(a), twins(twin)]).toEqual(['skew|skew|stage:#1', 'skew|skew|stage:#1#1']);
  // A finding outside the run's list falls back to the core key.
  expect(twins(skewFinding(9))).toBe('skew|skew|stage:#9');
});
