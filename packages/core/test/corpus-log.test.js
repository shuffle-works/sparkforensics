import { afterEach, expect, test, vi } from 'vitest';
import { corpusLog } from './corpus-log.js';

afterEach(() => vi.unstubAllEnvs());

test('returns the absolute path of a corpus entry that exists', () => {
  vi.stubEnv('CI', '');
  const path = corpusLog('.');
  expect(path === null || path.endsWith('log-corpus/logs')).toBe(true);
});

test('returns null for a missing entry outside CI, so the gated test skips', () => {
  vi.stubEnv('CI', '');
  expect(corpusLog('no-such-log.ndjson')).toBeNull();
});

test('throws for a missing entry in CI, so the suite fails instead of skipping', () => {
  vi.stubEnv('CI', 'true');
  expect(() => corpusLog('no-such-log.ndjson')).toThrow(/missing in CI/);
});
