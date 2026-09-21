import { Readable } from 'node:stream';
import {
  buildUpstreamUrl as buildNormalizedUpstreamUrl,
  validateShsRequest,
} from './shs-request.js';

function sendSafeError(res, status, code) {
  const body = JSON.stringify({ code });
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

function isConnectionFailure(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return true;
  const code = error?.code ?? error?.cause?.code;
  if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'ETIMEDOUT'].includes(code)) return true;
  return /\b(?:ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|ETIMEDOUT)\b/.test(error?.message ?? '');
}

const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;

function upstreamTimeoutMs() {
  const v = Number(process.env.SPARKFORENSICS_SHS_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_UPSTREAM_TIMEOUT_MS;
}

// CSRF guard: verifies the caller, not the proxy target (`normalizeBaseUrl`'s
// private-network allowance is unrelated and deliberate). No Origin header
// means a same-origin navigation or a non-browser client, so it's allowed;
// an Origin present must match Host. Anything unparseable fails closed.
export function isSameOriginRequest(req) {
  const origin = req.headers?.origin;
  if (origin == null) return true;

  const host = req.headers?.host;
  if (!host) return false;

  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  return originHost.toLowerCase() === host.toLowerCase();
}

export async function fetchShsEventLog(request, { fetchImpl = fetch, timeoutMs = upstreamTimeoutMs() } = {}) {
  const upstreamUrl = buildNormalizedUpstreamUrl(request);
  // Header-phase timeout only: the timer is cleared once headers arrive, so a
  // slow-but-progressing body download is never cut off mid-stream (the body
  // gets its own idle watchdog in handleShsProxy).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let upstream;
  try {
    upstream = await fetchImpl(upstreamUrl, { redirect: 'error', credentials: 'omit', signal: controller.signal });
  } catch (error) {
    return { ok: false, code: isConnectionFailure(error) ? 'upstream-unreachable' : 'access-or-upstream-failure' };
  } finally {
    clearTimeout(timer);
  }
  if (!upstream?.ok) {
    return { ok: false, code: upstream?.status === 404 ? 'application-not-found' : 'access-or-upstream-failure' };
  }
  if (!upstream.body) {
    return { ok: false, code: 'access-or-upstream-failure' };
  }
  return { ok: true, upstream };
}

export async function handleShsProxy(req, res, { fetchImpl = fetch, timeoutMs = upstreamTimeoutMs() } = {}) {
  if (!isSameOriginRequest(req)) {
    sendSafeError(res, 403, 'access-or-upstream-failure');
    return;
  }

  const query = new URL(req.url, 'http://localhost').searchParams;
  const result = validateShsRequest({
    baseUrl: query.get('baseUrl') ?? '',
    appId: query.get('appId') ?? '',
    attemptId: query.get('attemptId') ?? '',
  });

  if (!result.request) {
    sendSafeError(res, 400, 'access-or-upstream-failure');
    return;
  }

  const fetched = await fetchShsEventLog(result.request, { fetchImpl, timeoutMs });
  if (!fetched.ok) {
    sendSafeError(res, 502, fetched.code);
    return;
  }

  const { upstream } = fetched;
  let nodeStream;
  try {
    nodeStream = Readable.fromWeb(upstream.body);
  } catch {
    sendSafeError(res, 502, 'access-or-upstream-failure');
    return;
  }

  const headers = {};
  const contentLength = upstream.headers.get('content-length');
  if (contentLength) headers['content-length'] = contentLength;
  headers['content-type'] = 'application/zip';
  res.writeHead(200, headers);

  await new Promise((resolve) => {
    // Idle watchdog: a stalled upstream would otherwise leave this promise
    // pending forever with the 200 already sent. Resets on every chunk, so
    // slow-but-progressing downloads of any size are unaffected.
    let watchdog;
    let settled = false;
    const resetWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => nodeStream.destroy(new Error('upstream idle timeout')), timeoutMs);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      resolve();
    };
    resetWatchdog();
    nodeStream.on('data', resetWatchdog);
    nodeStream.on('error', (err) => {
      if (settled) return;
      console.warn(`[shs-proxy] upstream stream failed mid-body: ${err.message}`);
      // destroy(err), not destroy(): the 200 header is already out, so an
      // abnormal termination is the only signal that the body is truncated.
      res.destroy(err);
      finish();
    });
    // Mirrors the nodeStream-error path in the other direction: a client
    // disconnecting mid-transfer (res 'close') or a write failure (res
    // 'error') must also settle this promise (resolve, same as the
    // nodeStream-error path above) and stop the now-pointless upstream read,
    // or it dangles until the idle watchdog eventually fires. `res` 'close'
    // also fires after a normal 'finish', so the `settled` guard keeps that
    // happy-path case a no-op.
    res.on('error', (err) => {
      if (settled) return;
      console.warn(`[shs-proxy] client connection failed mid-body: ${err.message}`);
      nodeStream.destroy(err);
      finish();
    });
    res.on('close', () => {
      if (settled) return;
      nodeStream.destroy();
      finish();
    });
    res.on('finish', finish);
    nodeStream.pipe(res);
  });
}
