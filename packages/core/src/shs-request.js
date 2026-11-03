export const SHS_ERROR_CODES = new Set([
  'local-server-unavailable',
  'upstream-unreachable',
  'application-not-found',
  'access-or-upstream-failure',
  'invalid-event-log',
]);

const APP_ID_PATTERNS = [
  /^application_\d+_\d+$/,
  /^local-\d+$/,
  /^app-[A-Za-z0-9][A-Za-z0-9._-]*$/,
  /^spark-[A-Za-z0-9][A-Za-z0-9._~-]*$/,
  /^driver-\d+$/,
];
const ATTEMPT_ID_RE = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._~-]*$/;

/** @param {unknown} value */
function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** @param {unknown} value @returns {string | null} */
export function normalizeBaseUrl(value) {
  const baseUrl = trimString(value);
  if (!baseUrl || baseUrl.includes('?') || baseUrl.includes('#')) return null;

  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return null;
  }

  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) return null;

  parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/`;
  return parsed.toString();
}

/** @param {string} appId */
function isValidAppId(appId) {
  return APP_ID_PATTERNS.some((pattern) => pattern.test(appId));
}

/** @param {string} attemptId */
function isValidAttemptId(attemptId) {
  return ATTEMPT_ID_RE.test(attemptId);
}

/**
 * @typedef {{ baseUrl: string, appId: string, attemptId: string | null }} ShsRequest
 * @typedef {{ baseUrl: string | null, appId: string | null, attemptId: string | null }} ShsRequestErrors
 */

/**
 * @param {{ baseUrl?: unknown, appId?: unknown, attemptId?: unknown }} [input]
 * @returns {{ request: ShsRequest | null, errors: ShsRequestErrors }}
 */
export function validateShsRequest({ baseUrl = '', appId = '', attemptId = '' } = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const normalizedAppId = trimString(appId);
  const normalizedAttemptId = trimString(attemptId);
  const errors = {
    baseUrl: normalizedBaseUrl ? null : 'Enter an absolute HTTP(S) base URL without credentials, query, or fragment.',
    appId: isValidAppId(normalizedAppId) ? null : 'Enter a supported Spark application ID.',
    attemptId: !normalizedAttemptId || isValidAttemptId(normalizedAttemptId)
      ? null
      : 'Enter a URL-path-safe attempt ID.',
  };

  if (!normalizedBaseUrl || errors.baseUrl || errors.appId || errors.attemptId) return { request: null, errors };

  return {
    request: {
      baseUrl: normalizedBaseUrl,
      appId: normalizedAppId,
      attemptId: normalizedAttemptId || null,
    },
    errors,
  };
}

/** @param {{ request?: ShsRequest | null } | null | undefined} result */
export function isShsRequestValid(result) {
  // validateShsRequest guarantees `request` is null iff any field errored,
  // so a non-null request already implies every error is null.
  return result?.request != null;
}

/** @param {ShsRequest} request */
export function buildProxyRequestUrl({ baseUrl, appId, attemptId }) {
  const params = [
    ['baseUrl', baseUrl],
    ['appId', appId],
  ];
  if (attemptId !== null) params.push(['attemptId', attemptId]);
  return `/shs-proxy?${params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}`;
}

/** @param {ShsRequest} request */
export function buildUpstreamUrl({ baseUrl, appId, attemptId }) {
  const segments = ['api', 'v1', 'applications', appId];
  if (attemptId) segments.push(attemptId);
  segments.push('logs');
  return new URL(segments.map(encodeURIComponent).join('/'), baseUrl).toString();
}

/** @param {unknown} value */
export function isShsErrorCode(value) {
  return typeof value === 'string' && SHS_ERROR_CODES.has(value);
}
