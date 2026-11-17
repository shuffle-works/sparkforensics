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
    expect(result.appModel.app?.id).toBe('app-shs-skip');
    expect(result.skippedLines).toBe(1);
  });

  it('returns skippedLines: 0 for a clean archive with no malformed lines', async () => {
    const ndjson = '{"Event":"SparkListenerApplicationStart","App ID":"app-shs-clean","App Name":"t","Timestamp":0}\n'
      + '{"Event":"SparkListenerApplicationEnd","Timestamp":100}\n';
    const result = await resolveFromShs('http://shs:18080', 'application_1_1', undefined, { fetchImpl: shsZipFetch(ndjson) });
    expect(result.skippedLines).toBe(0);
  });

  describe('attempt handling', () => {
    const ndjson = '{"Event":"SparkListenerApplicationStart","App ID":"app-shs-attempts","App Name":"t","Timestamp":0}\n'
      + '{"Event":"SparkListenerApplicationEnd","Timestamp":100}\n';

    // A History Server double: the application endpoint lists `attempts`; the logs endpoint serves the archive.
    /** @param {Array<{ attemptId?: string }>} attempts */
    function historyServer(attempts) {
      /** @type {string[]} */
      const urls = [];
      /** @param {string | URL | Request} url */
      const fetchImpl = async (url) => {
        urls.push(String(url));
        if (String(url).endsWith('/logs')) return shsZipFetch(ndjson)();
        return Response.json({ id: 'application_1_1', name: 't', attempts });
      };
      return { fetchImpl, urls };
    }

    it('fails before downloading logs when the application has several attempts, listing the ids', async () => {
      const { fetchImpl, urls } = historyServer([{ attemptId: '2' }, { attemptId: '1' }]);
      await expect(resolveFromShs('http://shs:18080', 'application_1_1', undefined, { fetchImpl }))
        .rejects.toMatchObject({
          code: 'invalid-argument', appId: 'application_1_1', attemptIds: ['2', '1'],
          message: 'Application application_1_1 has 2 attempts: 2, 1.',
        });
      expect(urls).toEqual(['http://shs:18080/api/v1/applications/application_1_1']);
    });

    it('downloads the logs when the application has one attempt', async () => {
      const { fetchImpl, urls } = historyServer([{ attemptId: '1' }]);
      const { appModel } = await resolveFromShs('http://shs:18080', 'application_1_1', undefined, { fetchImpl });
      expect(appModel.app?.id).toBe('app-shs-attempts');
      expect(urls).toEqual(['http://shs:18080/api/v1/applications/application_1_1', 'http://shs:18080/api/v1/applications/application_1_1/logs']);
    });

    it('downloads the logs when the application has attempts without ids', async () => {
      const { fetchImpl } = historyServer([{}]);
      await expect(resolveFromShs('http://shs:18080', 'application_1_1', undefined, { fetchImpl })).resolves.toBeDefined();
    });

    it('skips the lookup when an attempt id is given', async () => {
      const { fetchImpl, urls } = historyServer([{ attemptId: '1' }, { attemptId: '2' }]);
      await resolveFromShs('http://shs:18080', 'application_1_1', '2', { fetchImpl });
      expect(urls).toEqual(['http://shs:18080/api/v1/applications/application_1_1/2/logs']);
    });

    it('goes on to the logs request when the lookup fails, so that request reports the failure', async () => {
      /** @param {string | URL | Request} url */
      const fetchImpl = async (url) => (String(url).endsWith('/logs') ? shsZipFetch(ndjson)() : new Response(null, { status: 500 }));
      await expect(resolveFromShs('http://shs:18080', 'application_1_1', undefined, { fetchImpl })).resolves.toBeDefined();
    });
  });

  it('names each invalid argument in the error', async () => {
    await expect(resolveFromShs('ftp://shs', 'not-an-app', 'bad/attempt', { fetchImpl: shsZipFetch('') }))
      .rejects.toMatchObject({
        code: 'invalid-argument',
        message: expect.stringMatching(/source\.shsBaseUrl: Enter an absolute HTTP\(S\) base URL.*source\.appId: Enter a supported Spark application ID.*source\.attemptId: Enter a URL-path-safe attempt ID/),
      });
  });
});
