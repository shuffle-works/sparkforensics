import { describe, expect, it } from 'vitest';
import {
  SHS_ERROR_CODES,
  buildProxyRequestUrl,
  buildUpstreamUrl,
  isShsErrorCode,
  isShsRequestValid,
  validateShsRequest,
} from '../src/shs-request.js';

describe('SHS request contract', () => {
  it('normalizes a reverse-proxy base path and encodes a separate attempt', () => {
    const result = validateShsRequest({
      baseUrl: ' https://history.example/shs/ ',
      appId: ' application_1777489669889_56601 ',
      attemptId: ' 2 ',
    });

    expect(isShsRequestValid(result)).toBe(true);
    expect(result.request).toEqual({
      baseUrl: 'https://history.example/shs/',
      appId: 'application_1777489669889_56601',
      attemptId: '2',
    });
    expect(buildUpstreamUrl(result.request)).toBe(
      'https://history.example/shs/api/v1/applications/application_1777489669889_56601/2/logs',
    );
  });

  it.each(['application_1_2', 'local-1777489669889', 'app-standalone_01', 'spark-abc123', 'spark-app_1.2~3', 'driver-1699900000'])(
    'accepts supported base app ID %s',
    (appId) => expect(isShsRequestValid(validateShsRequest({
      baseUrl: 'http://shs:18080', appId, attemptId: '',
    }))).toBe(true),
  );

  it('canonicalizes a base URL to exactly one trailing slash', () => {
    const result = validateShsRequest({
      baseUrl: 'https://history.example/shs///', appId: 'application_1_2',
    });

    expect(result.request?.baseUrl).toBe('https://history.example/shs/');
  });

  it('builds a proxy query from normalized values and omits a missing attempt', () => {
    const withAttempt = validateShsRequest({
      baseUrl: 'https://history.example/shs',
      appId: 'application_1_2',
      attemptId: '3',
    });
    const withoutAttempt = validateShsRequest({
      baseUrl: 'https://history.example/shs', appId: 'application_1_2', attemptId: '',
    });

    expect(buildProxyRequestUrl(withAttempt.request)).toBe(
      '/shs-proxy?baseUrl=https%3A%2F%2Fhistory.example%2Fshs%2F&appId=application_1_2&attemptId=3',
    );
    expect(buildProxyRequestUrl(withoutAttempt.request)).toBe(
      '/shs-proxy?baseUrl=https%3A%2F%2Fhistory.example%2Fshs%2F&appId=application_1_2',
    );
  });

  it('builds a proxy query without URLSearchParams', () => {
    const original = globalThis.URLSearchParams;
    globalThis.URLSearchParams = undefined;
    try {
      expect(buildProxyRequestUrl({
        baseUrl: 'https://history.example/shs/', appId: 'application_1_2', attemptId: '3',
      })).toBe('/shs-proxy?baseUrl=https%3A%2F%2Fhistory.example%2Fshs%2F&appId=application_1_2&attemptId=3');
    } finally {
      globalThis.URLSearchParams = original;
    }
  });

  it.each([
    ['credentials', { baseUrl: 'https://user:pass@history.example', appId: 'application_1_2' }, 'baseUrl'],
    ['query string', { baseUrl: 'https://history.example/shs?x=1', appId: 'application_1_2' }, 'baseUrl'],
    ['empty query delimiter', { baseUrl: 'https://history.example/shs?', appId: 'application_1_2' }, 'baseUrl'],
    ['fragment', { baseUrl: 'https://history.example/shs#top', appId: 'application_1_2' }, 'baseUrl'],
    ['empty fragment delimiter', { baseUrl: 'https://history.example/shs#', appId: 'application_1_2' }, 'baseUrl'],
    ['non-HTTP URL', { baseUrl: 'file:///etc/passwd', appId: 'application_1_2' }, 'baseUrl'],
    ['app traversal', { baseUrl: 'https://history.example', appId: '../application_1_2' }, 'appId'],
    ['app path separator', { baseUrl: 'https://history.example', appId: 'application_1_2/extra' }, 'appId'],
    ['combined application attempt ID', { baseUrl: 'https://history.example', appId: 'application_1_2_1' }, 'appId'],
    ['unsupported app ID', { baseUrl: 'https://history.example', appId: 'unsupported-app' }, 'appId'],
    ['spark path separator', { baseUrl: 'https://history.example', appId: 'spark-app/1' }, 'appId'],
    ['spark percent', { baseUrl: 'https://history.example', appId: 'spark-app%20' }, 'appId'],
    ['spark hash', { baseUrl: 'https://history.example', appId: 'spark-app#1' }, 'appId'],
    ['spark query', { baseUrl: 'https://history.example', appId: 'spark-app?1' }, 'appId'],
    ['driver non-numeric', { baseUrl: 'https://history.example', appId: 'driver-abc' }, 'appId'],
    ['attempt traversal', { baseUrl: 'https://history.example', appId: 'application_1_2', attemptId: '..' }, 'attemptId'],
    ['attempt path separator', { baseUrl: 'https://history.example', appId: 'application_1_2', attemptId: '1/2' }, 'attemptId'],
  ])('rejects %s with a field-specific error and no request', (_label, input, invalidField) => {
    const result = validateShsRequest(input);

    expect(result.request).toBeNull();
    expect(result.errors[invalidField]).not.toBeNull();
    for (const field of ['baseUrl', 'appId', 'attemptId']) {
      if (field !== invalidField) expect(result.errors[field]).toBeNull();
    }
  });

  it('reports every invalid field independently', () => {
    const result = validateShsRequest({ baseUrl: 'ftp://history.example', appId: 'bad/id', attemptId: '../2' });

    expect(result.request).toBeNull();
    expect(result.errors).toEqual({ baseUrl: expect.any(String), appId: expect.any(String), attemptId: expect.any(String) });
  });

  it('recognizes only the five stable safe error codes', () => {
    expect([...SHS_ERROR_CODES]).toEqual([
      'local-server-unavailable',
      'upstream-unreachable',
      'application-not-found',
      'access-or-upstream-failure',
      'invalid-event-log',
    ]);
    expect(isShsErrorCode('application-not-found')).toBe(true);
    expect(isShsErrorCode('unexpected-server-message')).toBe(false);
    expect(isShsErrorCode(null)).toBe(false);
  });

  it('does not consider a missing request valid', () => {
    expect(isShsRequestValid({
      request: undefined,
      errors: { baseUrl: null, appId: null, attemptId: null },
    })).toBe(false);
  });
});
