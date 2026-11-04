import { describe, it, expect } from 'vitest';
import { resolveFromShs } from '../src/shs-load.ts';
// Helper lives at repo-root tests/helpers/: shared with mcp-tools.test.js and
// packages/cli/test/analyze.test.js.
import { shsZipFetch } from '../../../tests/helpers/shs-fixtures.js';

describe('resolveFromShs', () => {
  it('returns both appModel and skippedLines, not just appModel (fixes 175: the CLI needs the real ' +
    'skipped-line count for its --export-html payload, not a hardcoded 0)', async () => {
    // "SparkListenerJobEnd" is a known Event type, but missing "Job ID" fails its own
    // schema and counts as a skipped line (see parser-worker's dispatchLine contract).
    const ndjson = [
      '{"Event":"SparkListenerApplicationStart","App ID":"app-shs-skip","App Name":"t","Timestamp":0}',
      '{"Event":"SparkListenerJobEnd"}',
      '{"Event":"SparkListenerApplicationEnd","Timestamp":100}',
    ].join('\n');
    const result = await resolveFromShs('http://shs:18080', 'application_1_1', undefined, { fetchImpl: shsZipFetch(ndjson) });
    expect(result.appModel.app.id).toBe('app-shs-skip');
    expect(result.skippedLines).toBe(1);
  });

  it('returns skippedLines: 0 for a clean archive with no malformed lines', async () => {
    const ndjson = '{"Event":"SparkListenerApplicationStart","App ID":"app-shs-clean","App Name":"t","Timestamp":0}\n'
      + '{"Event":"SparkListenerApplicationEnd","Timestamp":100}\n';
    const result = await resolveFromShs('http://shs:18080', 'application_1_1', undefined, { fetchImpl: shsZipFetch(ndjson) });
    expect(result.skippedLines).toBe(0);
  });
});
