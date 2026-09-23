import { validateShsRequest } from './shs-request.js';
import { fetchShsEventLog } from './proxy.js';
import { decodeShsArchive } from './parser-worker.ts';
import { collectViaDispatch } from './cli/collect-run.ts';
import { nodeArchiveCodecs } from './cli/native-zstd.ts';
import { deriveEvidenceAvailability } from './evidence-availability.ts';
import { mcpError } from './mcp-error.ts';
import type { AppModel } from './types.ts';

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const DEFAULT_MAX_ARCHIVE_BYTES = envInt('SPARKFORENSICS_MAX_ARCHIVE_BYTES', 1024 * 1024 * 1024);
// Same knob the proxy uses: fetchShsEventLog covers the header phase; this
// covers the body, per chunk, so progressing downloads of any size are fine.
export const DEFAULT_IDLE_TIMEOUT_MS = envInt('SPARKFORENSICS_SHS_TIMEOUT_MS', 30_000);

function collectShsAppModel(zipBytes: Uint8Array): Promise<{ appModel: AppModel; skippedLines: number }> {
  return collectViaDispatch(
    (state, emit) => decodeShsArchive(zipBytes, state, emit, nodeArchiveCodecs),
    (msg) => {
      const m = msg as { code?: string; message?: string };
      return mcpError(m?.code ?? 'invalid-event-log', m?.message ?? 'Failed to decode SHS archive.');
    },
  );
}

// Races one reader.read() against a fresh idle timer. The losing read() stays
// pending after a timeout; reader.cancel() in the caller settles it.
function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout>;
  const stalled: Promise<never> = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(mcpError(
      'upstream-unreachable',
      `SHS archive body stalled for ${idleTimeoutMs} ms (override with SPARKFORENSICS_SHS_TIMEOUT_MS).`,
    )), idleTimeoutMs);
  });
  return Promise.race([reader.read(), stalled]).finally(() => clearTimeout(timer));
}

// Reads the archive body with a byte cap: an unbounded arrayBuffer() on a
// hostile or misconfigured SHS response would OOM the long-running process.
// The per-chunk idle timeout keeps a stalled body from hanging the call
// forever with headers already received.
async function readArchiveBytes(upstream: Response, maxBytes: number, idleTimeoutMs: number): Promise<Uint8Array> {
  const tooLarge = () => mcpError(
    'archive-too-large',
    `SHS archive exceeds the ${maxBytes}-byte cap (override with SPARKFORENSICS_MAX_ARCHIVE_BYTES).`,
  );
  const declared = Number(upstream.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();

  // fetchShsEventLog (./proxy.js, a plain untyped .js sibling)
  // already checks `!upstream.body` and returns `{ ok: false }` before ever
  // returning `{ ok: true, upstream }`, so `body` is guaranteed present here
  // even though DOM's Response.body type is nullable.
  const reader = upstream.body!.getReader();
  // Grown geometrically instead of preallocated at `maxBytes`: a typical
  // archive is nowhere near the cap, so starting small (or at the declared
  // content-length, when trustworthy) and doubling on demand keeps peak memory
  // close to the actual download size. Chunks are copied straight into this
  // buffer as they arrive rather than buffered in an array and copied once at
  // the end, which would keep ~2x-of-total live during the final copy.
  let buf = new Uint8Array(Number.isFinite(declared) && declared > 0 ? Math.min(declared, maxBytes) : 65536);
  let total = 0;
  for (;;) {
    let done: boolean | undefined, value: Uint8Array | undefined;
    try {
      ({ done, value } = await readWithIdleTimeout(reader, idleTimeoutMs));
    } catch (err) {
      await reader.cancel().catch(() => {});
      throw err;
    }
    if (done) break;
    if (value) {
      const newTotal = total + value.byteLength;
      if (newTotal > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      if (newTotal > buf.length) {
        const grown = new Uint8Array(Math.min(maxBytes, Math.max(newTotal, buf.length * 2)));
        grown.set(buf);
        buf = grown;
      }
      buf.set(value, total);
      total = newTotal;
    }
  }
  return buf.subarray(0, total);
}

// fetchShsEventLog is untyped JS; its real contract is this discriminated union
// (either branch, never a mix), asserted here once at the boundary rather than
// widening every downstream read.
type ShsFetchOutcome = { ok: true; upstream: Response } | { ok: false; code: string };

export async function resolveFromShs(
  shsBaseUrl: string,
  appId: string,
  attemptId?: string,
  opts: { fetchImpl?: typeof fetch; maxArchiveBytes?: number; idleTimeoutMs?: number } = {},
): Promise<{ appModel: AppModel; skippedLines: number }> {
  const { fetchImpl = fetch, maxArchiveBytes = DEFAULT_MAX_ARCHIVE_BYTES, idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS } = opts;
  const validated = validateShsRequest({ baseUrl: shsBaseUrl, appId, attemptId: attemptId ?? '' });
  if (!validated.request) throw mcpError('access-or-upstream-failure', 'Invalid SHS request parameters.');
  const fetched = await fetchShsEventLog(validated.request, { fetchImpl }) as ShsFetchOutcome;
  if (!fetched.ok) throw mcpError(fetched.code, `SHS fetch failed: ${fetched.code}`);
  const zipBytes = await readArchiveBytes(fetched.upstream, maxArchiveBytes, idleTimeoutMs);
  const { appModel, skippedLines } = await collectShsAppModel(zipBytes);
  appModel.evidenceAvailability = deriveEvidenceAvailability(appModel, { skippedLines });
  return { appModel, skippedLines };
}
