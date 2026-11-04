import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { validateShsRequest, buildUpstreamUrl } from '../src/shs-request.js';
import { handleShsProxy, fetchShsEventLog, isSameOriginRequest } from '../src/proxy.js';

// Local helpers exercise the real shs-request.js functions.
const isValidAppId = (/** @type {string} */ id) => validateShsRequest({ baseUrl: 'http://shs.invalid', appId: id }).errors.appId === null;
const isValidBaseUrl = (/** @type {string} */ baseUrl) => validateShsRequest({ baseUrl, appId: 'application_1_1' }).errors.baseUrl === null;

/**
 * @param {Parameters<typeof validateShsRequest>[0]} input
 * @returns {import('../src/shs-request.js').ShsRequest}
 */
function validRequestOf(input) {
  const { request } = validateShsRequest(input);
  if (!request) throw new Error('expected a valid SHS request');
  return request;
}

/** @param {string} baseUrl @param {string} appId @param {string | null} [attemptId] */
const buildUpstream = (baseUrl, appId, attemptId = null) =>
  buildUpstreamUrl(validRequestOf({ baseUrl, appId, attemptId: attemptId ?? '' }));

describe('isValidAppId', () => {
  it('accepts a standard app id', () => {
    expect(isValidAppId('application_0000000000000_0001')).toBe(true);
  });
  it('rejects an app id with a combined attempt suffix', () => {
    expect(isValidAppId('application_0000000000000_0001_1')).toBe(false);
  });
  it('rejects path-traversal and arbitrary strings', () => {
    expect(isValidAppId('../../etc/passwd')).toBe(false);
    expect(isValidAppId('application_1_1/extra')).toBe(false);
    expect(isValidAppId('not-an-app-id')).toBe(false);
    expect(isValidAppId('')).toBe(false);
  });
});

describe('isValidBaseUrl', () => {
  it('accepts http and https URLs', () => {
    expect(isValidBaseUrl('http://192.168.11.60:18080')).toBe(true);
    expect(isValidBaseUrl('https://shs.example.com')).toBe(true);
  });
  it('rejects non-http protocols and garbage', () => {
    expect(isValidBaseUrl('file:///etc/passwd')).toBe(false);
    expect(isValidBaseUrl('ftp://host')).toBe(false);
    expect(isValidBaseUrl('not a url')).toBe(false);
    expect(isValidBaseUrl('')).toBe(false);
  });
});

describe('buildUpstreamUrl', () => {
  it('constructs the SHS logs URL and strips trailing slashes', () => {
    expect(buildUpstream('http://shs:18080/', 'application_1_1'))
      .toBe('http://shs:18080/api/v1/applications/application_1_1/logs');
    expect(buildUpstream('http://shs:18080', 'application_1_1'))
      .toBe('http://shs:18080/api/v1/applications/application_1_1/logs');
  });
});

/**
 * Upstream fakes implement only the Response members the proxy reads.
 * @param {(url: string | URL | Request, init?: RequestInit) => Promise<{ ok: boolean, status: number, headers: { get(name: string): string | null }, body?: ReadableStream<Uint8Array> | null }>} impl
 * @returns {typeof fetch}
 */
function fakeFetch(impl) { return /** @type {typeof fetch} */ (/** @type {unknown} */ (impl)); }

/** @typedef {import('node:http').ServerResponse} ServerResponse */
/** @typedef {ServerResponse & { headers: Record<string, string> | null, bodyText(): string }} FakeRes */
/** @typedef {ServerResponse & { headers: Record<string, string> | null, bodyBytes(): Buffer }} FakeStreamRes */

/**
 * handleShsProxy only calls writeHead/write/end (and, on the streaming path, the
 * Writable API) on the response, so the fakes implement just those. The cast to
 * ServerResponse is the single point where that narrower shape is widened.
 * @returns {FakeRes}
 */
function fakeRes() {
  /** @type {(string | Uint8Array)[]} */
  const chunks = [];
  const res = {
    statusCode: /** @type {number | null} */ (null),
    headers: /** @type {Record<string, string> | null} */ (null),
    ended: false,
    /** @param {number} status @param {Record<string, string>} [headers] */
    writeHead(status, headers) { this.statusCode = status; this.headers = headers || {}; },
    /** @param {string | Uint8Array} chunk */
    write(chunk) { chunks.push(chunk); },
    /** @param {string | Uint8Array} [chunk] */
    end(chunk) { if (chunk) chunks.push(chunk); this.ended = true; },
    bodyText() { return chunks.map(c => (typeof c === 'string' ? c : Buffer.from(c).toString('utf8'))).join(''); },
  };
  return /** @type {FakeRes} */ (/** @type {unknown} */ (res));
}

// handleShsProxy's 200-body path pipes a real Node stream into res for
// backpressure, so this fake res must be a genuine writable stream.
/** @returns {FakeStreamRes} */
function fakeStreamRes() {
  /** @type {Buffer[]} */
  const chunks = [];
  const writable = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
  });
  /** @type {{ statusCode: number | null, headers: Record<string, string> | null, writeHead(status: number, headers?: Record<string, string>): void, bodyBytes(): Buffer }} */
  const extras = {
    statusCode: null,
    headers: null,
    writeHead: (status, headers) => { res.statusCode = status; res.headers = headers || {}; },
    bodyBytes: () => Buffer.concat(chunks),
  };
  const res = Object.assign(writable, extras);
  return /** @type {FakeStreamRes} */ (/** @type {unknown} */ (res));
}

/**
 * @param {string | null} baseUrl
 * @param {string | null} appId
 * @param {string | null} [attemptId]
 * @param {import('node:http').IncomingHttpHeaders} [headers]
 */
function reqFor(baseUrl, appId, attemptId = null, headers = {}) {
  const qs = new URLSearchParams();
  if (baseUrl != null) qs.set('baseUrl', baseUrl);
  if (appId != null) qs.set('appId', appId);
  if (attemptId != null) qs.set('attemptId', attemptId);
  return Object.assign(new IncomingMessage(new Socket()), { url: `/shs-proxy?${qs.toString()}`, headers });
}

describe('isSameOriginRequest', () => {
  it('allows a request with no Origin header', () => {
    expect(isSameOriginRequest({ headers: { host: 'localhost:3000' } })).toBe(true);
  });

  it('allows a matching same-origin Origin/Host pair', () => {
    expect(isSameOriginRequest({
      headers: { origin: 'http://localhost:3000', host: 'localhost:3000' },
    })).toBe(true);
  });

  it('allows matching Origin/Host regardless of case', () => {
    expect(isSameOriginRequest({
      headers: { origin: 'http://LocalHost:3000', host: 'localhost:3000' },
    })).toBe(true);
  });

  it('rejects a mismatched Origin host', () => {
    expect(isSameOriginRequest({
      headers: { origin: 'http://evil.example', host: 'localhost:3000' },
    })).toBe(false);
  });

  it('rejects a malformed Origin header', () => {
    expect(isSameOriginRequest({
      headers: { origin: 'not-a-url', host: 'localhost:3000' },
    })).toBe(false);
  });

  it('rejects when Host is missing, even with a matching-looking Origin', () => {
    expect(isSameOriginRequest({ headers: { origin: 'http://localhost:3000' } })).toBe(false);
  });
});

/**
 * @param {FakeRes} res
 * @param {{ status: number, code: string, baseUrl: string, appId: string, upstreamStatus?: number | null, exceptionText?: string }} expected
 */
function expectSafeFailure(res, {
  status, code, baseUrl, appId, upstreamStatus = null, exceptionText = '',
}) {
  expect(res.statusCode).toBe(status);
  const serialized = res.bodyText();
  expect(JSON.parse(serialized)).toEqual({ code });
  expect(serialized).not.toContain(baseUrl);
  expect(serialized).not.toContain(appId);
  if (upstreamStatus !== null) expect(serialized).not.toContain(String(upstreamStatus));
  if (exceptionText) expect(serialized).not.toContain(exceptionText);
}

describe('handleShsProxy', () => {
  it('returns a safe code for an invalid appId', async () => {
    const res = fakeRes();
    const baseUrl = 'http://shs:18080';
    const appId = '../etc';
    await handleShsProxy(reqFor(baseUrl, appId), res, { fetchImpl: async () => { throw new Error('should not fetch'); } });
    expectSafeFailure(res, { status: 400, code: 'access-or-upstream-failure', baseUrl, appId, exceptionText: 'should not fetch' });
  });

  it('returns a safe code for an invalid base URL', async () => {
    const res = fakeRes();
    const baseUrl = 'file:///etc/passwd';
    const appId = 'application_1_1';
    await handleShsProxy(reqFor(baseUrl, appId), res, { fetchImpl: async () => { throw new Error('should not fetch'); } });
    expectSafeFailure(res, { status: 400, code: 'access-or-upstream-failure', baseUrl, appId, exceptionText: 'should not fetch' });
  });

  it('returns a safe code for an invalid attempt ID', async () => {
    const res = fakeRes();
    const baseUrl = 'http://shs:18080';
    const appId = 'application_1_1';
    await handleShsProxy(reqFor(baseUrl, appId, '../2'), res, {
      fetchImpl: async () => { throw new Error('should not fetch'); },
    });
    expectSafeFailure(res, { status: 400, code: 'access-or-upstream-failure', baseUrl, appId, exceptionText: 'should not fetch' });
  });

  it('fetches the constructed upstream URL and streams a 200 body through', async () => {
    const res = fakeStreamRes();
    let fetchedUrl = null;
    await handleShsProxy(reqFor('http://shs:18080', 'application_1_1'), res, {
      fetchImpl: fakeFetch(async (url) => {
        fetchedUrl = url;
        return {
          ok: true, status: 200,
          headers: { get: (n) => n.toLowerCase() === 'content-length' ? '3' : null },
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
              controller.close();
            },
          }),
        };
      }),
    });
    expect(fetchedUrl).toBe('http://shs:18080/api/v1/applications/application_1_1/logs');
    expect(res.statusCode).toBe(200);
    expect(res.headers?.['content-length']).toBe('3');
    expect(Array.from(res.bodyBytes())).toEqual([1, 2, 3]);
  });

  it('passes a validated separate attempt to the upstream SHS logs endpoint', async () => {
    const res = fakeStreamRes();
    let fetchedUrl = null;
    await handleShsProxy(reqFor('https://shs.example/history/', 'local-1700000000000', '2'), res, {
      fetchImpl: fakeFetch(async (url) => {
        fetchedUrl = url;
        return {
          ok: true, status: 200,
          headers: { get: () => null },
          body: new ReadableStream({ start(controller) { controller.close(); } }),
        };
      }),
    });
    expect(fetchedUrl).toBe('https://shs.example/history/api/v1/applications/local-1700000000000/2/logs');
  });

  it('does not follow upstream redirects or send credentials', async () => {
    const res = fakeRes();
    const baseUrl = 'http://shs:18080';
    const appId = 'application_1_1';
    /** @type {RequestInit | undefined} */
    let options;
    await handleShsProxy(reqFor(baseUrl, appId, 'attempt-1'), res, {
      fetchImpl: fakeFetch(async (_url, passedOptions) => {
        options = passedOptions;
        return { ok: false, status: 302, headers: { get: () => null } };
      }),
    });
    expect(options).toMatchObject({ redirect: 'error', credentials: 'omit' });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expectSafeFailure(res, { status: 502, code: 'access-or-upstream-failure', baseUrl, appId, upstreamStatus: 302 });
  });

  it('maps an upstream 404 without exposing upstream details', async () => {
    const res = fakeRes();
    const baseUrl = 'http://shs:18080';
    const appId = 'application_1_9';
    await handleShsProxy(reqFor(baseUrl, appId), res, {
      fetchImpl: fakeFetch(async () => ({ ok: false, status: 404, headers: { get: () => null } })),
    });
    expectSafeFailure(res, { status: 502, code: 'application-not-found', baseUrl, appId, upstreamStatus: 404 });
  });

  it('maps a thrown upstream fetch without exposing exception text', async () => {
    const res = fakeRes();
    const baseUrl = 'http://shs:18080';
    const appId = 'application_1_1';
    await handleShsProxy(reqFor(baseUrl, appId), res, {
      fetchImpl: async () => { throw new TypeError('connect ECONNREFUSED 10.0.0.7'); },
    });
    expectSafeFailure(res, { status: 502, code: 'upstream-unreachable', baseUrl, appId, exceptionText: 'ECONNREFUSED 10.0.0.7' });
  });

  it('maps a non-404 upstream rejection to a safe generic code', async () => {
    const res = fakeRes();
    const baseUrl = 'http://shs:18080';
    const appId = 'application_1_1';
    await handleShsProxy(reqFor(baseUrl, appId), res, {
      fetchImpl: fakeFetch(async () => ({ ok: false, status: 503, headers: { get: () => null } })),
    });
    expectSafeFailure(res, { status: 502, code: 'access-or-upstream-failure', baseUrl, appId, upstreamStatus: 503 });
  });

  it('maps an upstream success with no body to a safe generic code', async () => {
    const res = fakeRes();
    const baseUrl = 'http://shs:18080';
    const appId = 'application_1_1';
    await handleShsProxy(reqFor(baseUrl, appId), res, {
      fetchImpl: fakeFetch(async () => ({ ok: true, status: 200, headers: { get: () => null }, body: null })),
    });
    expectSafeFailure(res, { status: 502, code: 'access-or-upstream-failure', baseUrl, appId });
  });

  it('rejects a cross-origin request before ever calling fetch', async () => {
    const res = fakeRes();
    const baseUrl = 'http://shs:18080';
    const appId = 'application_1_1';
    const req = reqFor(baseUrl, appId, null, { origin: 'http://evil.example', host: 'localhost:3000' });
    await handleShsProxy(req, res, { fetchImpl: async () => { throw new Error('should not fetch'); } });
    expectSafeFailure(res, { status: 403, code: 'access-or-upstream-failure', baseUrl, appId, exceptionText: 'should not fetch' });
  });

  it('allows a same-origin request with a matching Origin/Host through', async () => {
    const res = fakeStreamRes();
    const req = reqFor('http://shs:18080', 'application_1_1', null, { origin: 'http://localhost:3000', host: 'localhost:3000' });
    await handleShsProxy(req, res, {
      fetchImpl: fakeFetch(async () => ({
        ok: true, status: 200,
        headers: { get: () => null },
        body: new ReadableStream({ start(controller) { controller.close(); } }),
      })),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('fetchShsEventLog', () => {
  it('returns the upstream Response on success', async () => {
    const request = validRequestOf({ baseUrl: 'http://shs:18080', appId: 'application_1_1' });
    /** @type {typeof fetch} */
    const fetchImpl = async (url, opts) => {
      expect(url).toBe('http://shs:18080/api/v1/applications/application_1_1/logs');
      expect(opts).toMatchObject({ redirect: 'error', credentials: 'omit' });
      expect(opts?.signal).toBeInstanceOf(AbortSignal);
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    };
    const result = await fetchShsEventLog(request, { fetchImpl });
    if (!result.ok) throw new Error('expected a successful fetch result');
    expect(await result.upstream.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer);
  });

  it('maps a 404 upstream response to application-not-found', async () => {
    const request = validRequestOf({ baseUrl: 'http://shs:18080', appId: 'application_1_1' });
    const fetchImpl = async () => new Response(null, { status: 404 });
    const result = await fetchShsEventLog(request, { fetchImpl });
    expect(result).toEqual({ ok: false, code: 'application-not-found' });
  });

  it('maps a connection-refused throw to upstream-unreachable', async () => {
    const request = validRequestOf({ baseUrl: 'http://shs:18080', appId: 'application_1_1' });
    const fetchImpl = async () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }); };
    const result = await fetchShsEventLog(request, { fetchImpl });
    expect(result).toEqual({ ok: false, code: 'upstream-unreachable' });
  });

  it('maps a timeout abort to upstream-unreachable', async () => {
    const request = validRequestOf({ baseUrl: 'http://shs:18080', appId: 'application_1_1' });
    const fetchImpl = async () => { throw Object.assign(new Error('operation timed out'), { name: 'TimeoutError' }); };
    const result = await fetchShsEventLog(request, { fetchImpl });
    expect(result).toEqual({ ok: false, code: 'upstream-unreachable' });
  });

  it('aborts a header-phase hang after timeoutMs and maps it to upstream-unreachable', async () => {
    const request = validRequestOf({ baseUrl: 'http://shs:18080', appId: 'application_1_1' });
    // Simulates a black-holed upstream: never resolves, only reacts to abort.
    /** @type {typeof fetch} */
    const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
      const signal = /** @type {AbortSignal} */ (init?.signal);
      signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')));
    });
    const result = await fetchShsEventLog(request, { fetchImpl, timeoutMs: 20 });
    expect(result).toEqual({ ok: false, code: 'upstream-unreachable' });
  });
});

describe('handleShsProxy (stream failure hardening)', () => {
  it('destroys the response with an error when the upstream body fails mid-stream', async () => {
    const res = fakeStreamRes();
    const resErrors = [];
    res.on('error', (e) => resErrors.push(e));
    await handleShsProxy(reqFor('http://shs:18080', 'application_1_1'), res, {
      fetchImpl: fakeFetch(async () => ({
        ok: true, status: 200,
        headers: { get: () => null },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.error(new Error('upstream reset'));
          },
        }),
      })),
    });
    expect(res.destroyed).toBe(true);
    // destroy(err) not destroy(): the client must see an abnormal termination, not a clean end of a truncated 200 body.
    expect(resErrors.length).toBeGreaterThan(0);
  });

  it('settles the piping promise when the client disconnects mid-stream', async () => {
    const res = fakeStreamRes();
    res.on('error', () => {}); // destroy(err) below raises it; don't crash the test
    const handled = handleShsProxy(reqFor('http://shs:18080', 'application_1_1'), res, {
      fetchImpl: fakeFetch(async () => ({
        ok: true, status: 200,
        headers: { get: () => null },
        // Enqueues once then sits open; the client disconnect below is what has to end the wait.
        body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); } }),
      })),
    });
    await new Promise((r) => setImmediate(r));
    res.destroy(new Error('client disconnected'));
    // Needs 'close'/'error' listeners on res, otherwise the piping promise never resolves.
    await handled;
    expect(res.destroyed).toBe(true);
  });

  it('settles and cuts the connection when the upstream body stalls past the idle timeout', async () => {
    const res = fakeStreamRes();
    res.on('error', () => {});
    await handleShsProxy(reqFor('http://shs:18080', 'application_1_1'), res, {
      timeoutMs: 20,
      fetchImpl: fakeFetch(async () => ({
        ok: true, status: 200,
        headers: { get: () => null },
        // Never produces data and never closes: a stalled upstream.
        body: new ReadableStream({ start() {} }),
      })),
    });
    expect(res.destroyed).toBe(true);
  });
});
