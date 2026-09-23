import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync, zstdCompressSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createState, runParse, runParseFiles } from '../src/parser-worker.ts';
import { createZstdWorkerHandler } from '../src/zstd-worker.ts';
import { createWorkerZstdDecoders } from '../src/zstd-worker-client.ts';
import { Decompress } from '../src/vendor/fzstd.js';

// The two ends of the decompress-worker protocol (zstd-worker.ts, zstd-worker-client.ts), run in
// Node: over a real MessageChannel for end-to-end parses (async delivery and buffer transfer
// both behave as between workers), and over a hand-driven fake port where a test needs exact
// control of when replies arrive.

const enc = new TextEncoder();
const zstd = (u8) => new Uint8Array(zstdCompressSync(u8));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const fzstdFallback = (onChunk) => new Decompress(onChunk);

const sampleNdjson = gunzipSync(readFileSync(fileURLToPath(new URL('../../../public/sample-runs/sample-run.ndjson.gz', import.meta.url))));

function fakeFile(bytes, name = 'eventlog.zstd') {
  return {
    name,
    size: bytes.length,
    slice(start, end) {
      const view = bytes.subarray(start, end);
      return { async arrayBuffer() { return view.slice().buffer; } };
    },
  };
}

// A decompress worker on the far side of a MessageChannel, running the real handler. Tracks the
// slices sent but not yet acknowledged, as the parse side sees them.
const openPorts = [];
function channelWorker({ batchBytes } = {}) {
  const { port1, port2 } = new MessageChannel();
  const handle = createZstdWorkerHandler((msg, transfer) => port2.postMessage(msg, transfer ?? []), batchBytes);
  const requests = [];
  port2.onmessage = ({ data }) => { requests.push(data.type); handle(data); };
  const port = {
    requests,
    inFlight: 0,
    maxInFlight: 0,
    onmessage: null,
    onerror: null,
    postMessage(msg, transfer) {
      if (msg.type === 'data') port.maxInFlight = Math.max(port.maxInFlight, ++port.inFlight);
      port1.postMessage(msg, transfer);
    },
    terminate: () => { port1.close(); port2.close(); },
  };
  port1.onmessage = (ev) => {
    if (ev.data.type === 'consumed') port.inFlight--;
    port.onmessage?.(ev);
  };
  openPorts.push(port);
  port2.postMessage({ type: 'ready' });
  return port;
}

// A port whose replies the test sends by hand.
function fakePort() {
  const port = {
    sent: [],
    onmessage: null,
    onerror: null,
    terminated: false,
    postMessage(msg) { port.sent.push(msg); },
    terminate() { port.terminated = true; },
    reply(data) { port.onmessage({ data }); },
    fail(message) {
      const ev = { message, preventDefault: vi.fn() };
      port.onerror(ev);
      return ev;
    },
    data() { return port.sent.filter((m) => m.type === 'data'); },
  };
  return port;
}

afterEach(() => {
  while (openPorts.length) openPorts.pop().terminate();
});

// Progress `pct` is the read position, which runs up to the in-flight window ahead of the
// slice being parsed once decoding is off-thread; everything else must match exactly.
const withoutPct = (emitted) => emitted.map((m) => (m.type === 'progress' ? { ...m, pct: undefined } : m));

async function parse(file, zstdDecoder, chunkSize) {
  const state = createState();
  const emitted = [];
  await runParse(file, state, { emit: (m) => emitted.push(m), chunkSize, zstdDecoder });
  return { state, emitted };
}

describe('zstd decompress worker handler', () => {
  function drive(msgs, batchBytes) {
    const out = [];
    const handle = createZstdWorkerHandler((msg, transfer) => out.push({ msg, transfer }), batchBytes);
    for (const m of msgs) handle(m);
    return out;
  }
  const slices = (bytes, size) => {
    const parts = [];
    for (let o = 0; o < bytes.length; o += size) parts.push(bytes.slice(o, o + size));
    return parts;
  };
  const dataMsgs = (id, parts) => parts.map((p, seq) => ({ type: 'data', id, seq, bytes: p.buffer, final: seq === parts.length - 1 }));
  const joined = (out) => Buffer.concat(out.filter((o) => o.msg.type === 'chunk').map((o) => new Uint8Array(o.msg.bytes, 0, o.msg.length)));

  it('decodes a stream into batched, transferred chunks, each slice acknowledged after its output', () => {
    const parts = slices(zstd(sampleNdjson), 4096);
    const out = drive([{ type: 'start', id: 7 }, ...dataMsgs(7, parts)], 64 * 1024);

    expect(joined(out).equals(sampleNdjson)).toBe(true);
    const chunks = out.filter((o) => o.msg.type === 'chunk');
    expect(chunks.every((o) => o.msg.id === 7 && o.msg.length <= 64 * 1024)).toBe(true);
    expect(chunks.every((o) => o.transfer?.[0] === o.msg.bytes)).toBe(true);
    // Output leaves in batches, not one message per zstd block.
    expect(chunks.length).toBeLessThanOrEqual(Math.ceil(sampleNdjson.length / (64 * 1024)) + parts.length);
    const consumed = out.filter((o) => o.msg.type === 'consumed').map((o) => o.msg.seq);
    expect(consumed).toEqual(parts.map((_, seq) => seq));
    expect(out.at(-1).msg).toEqual({ type: 'consumed', id: 7, seq: parts.length - 1 });
  });

  it('reports a corrupt stream once, as an error, and ignores the rest of it', () => {
    const bytes = zstd(sampleNdjson);
    const corrupt = bytes.slice(0, 2000);
    corrupt.fill(0xff, 20, 2000);
    const out = drive([
      { type: 'start', id: 1 },
      { type: 'data', id: 1, seq: 0, bytes: corrupt.buffer, final: false },
      { type: 'data', id: 1, seq: 1, bytes: bytes.slice(2000).buffer, final: true },
    ]);
    const errors = out.filter((o) => o.msg.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].msg.id).toBe(1);
    expect(errors[0].msg.message).toBeTruthy();
    expect(out.at(-1).msg.type).toBe('error');
  });

  it('drops a cancelled stream, and a later start serves only the new stream', () => {
    const parts = slices(zstd(sampleNdjson), 4096);
    const out = drive([
      { type: 'start', id: 1 },
      ...dataMsgs(1, parts).slice(0, 2),
      { type: 'cancel', id: 1 },
      ...dataMsgs(1, parts).slice(2),
      { type: 'start', id: 2 },
      ...dataMsgs(2, parts),
      ...dataMsgs(1, parts),
    ]);
    const cancelAt = out.findIndex((o) => o.msg.type === 'consumed' && o.msg.id === 1 && o.msg.seq === 1);
    expect(out.slice(cancelAt + 1).every((o) => o.msg.id === 2)).toBe(true);
    expect(joined(out.slice(cancelAt + 1)).equals(sampleNdjson)).toBe(true);
  });
});

describe('worker-backed zstd decoding', () => {
  it('parses a log to exactly the messages and task data the in-thread decoder gives', async () => {
    const bytes = zstd(sampleNdjson);
    const inThread = await parse(fakeFile(bytes), undefined, 8192);
    const port = channelWorker({ batchBytes: 16 * 1024 });
    const viaWorker = await parse(fakeFile(bytes), createWorkerZstdDecoders(() => port, fzstdFallback), 8192);

    expect(inThread.emitted.some((m) => m.type === 'error')).toBe(false);
    expect(inThread.emitted.filter((m) => m.type === 'stage').length).toBeGreaterThan(0);
    expect(withoutPct(viaWorker.emitted)).toEqual(withoutPct(inThread.emitted));
    expect([...viaWorker.state.taskStore.entries()]).toEqual([...inThread.state.taskStore.entries()]);
    expect(port.requests.filter((t) => t === 'data').length).toBeGreaterThan(10);
  });

  it('serves every file of a rolling log from one worker, one stream at a time', async () => {
    const text = new TextDecoder().decode(sampleNdjson);
    const lines = text.split('\n');
    const cut = Math.floor(lines.length / 3);
    const parts = [lines.slice(0, cut), lines.slice(cut, 2 * cut), lines.slice(2 * cut)]
      .map((ls, i) => fakeFile(zstd(enc.encode(ls.join('\n') + (i < 2 ? '\n' : ''))), `events_${i + 1}_app.zstd`));
    const run = async (zstdDecoder) => {
      const emitted = [];
      await runParseFiles(parts, createState(), { emit: (m) => emitted.push(m), chunkSize: 8192, zstdDecoder });
      return emitted;
    };
    const inThread = await run(undefined);
    let spawns = 0;
    const viaWorker = await run(createWorkerZstdDecoders(() => { spawns++; return channelWorker(); }, fzstdFallback));

    expect(withoutPct(viaWorker)).toEqual(withoutPct(inThread));
    expect(spawns).toBe(1);
    expect(openPorts[0].requests.filter((t) => t === 'start')).toHaveLength(3);
  });

  it('transfers each compressed slice to the worker instead of copying it', async () => {
    const port = channelWorker();
    const decoder = createWorkerZstdDecoders(() => port, fzstdFallback)(() => {});
    const slice = zstd(sampleNdjson);
    await decoder.push(slice, true);
    expect(slice.buffer.byteLength).toBe(0);
  });

  it('keeps at most maxInFlight slices unacknowledged, and resolves the final push only when drained', async () => {
    const port = fakePort();
    const fed = [];
    const decoder = createWorkerZstdDecoders(() => port, fzstdFallback, { maxInFlight: 2 })((c) => fed.push(c.length));
    const slice = () => new Uint8Array(8);

    const first = decoder.push(slice());
    await tick();
    port.reply({ type: 'ready' });
    await first; // 1 in flight
    expect(port.sent.map((m) => m.type)).toEqual(['start', 'data']);

    let secondDone = false;
    const second = decoder.push(slice()).then(() => { secondDone = true; });
    await tick();
    expect(secondDone).toBe(false); // 2 in flight: at the window
    expect(port.data()).toHaveLength(2);

    port.reply({ type: 'chunk', id: 0, bytes: new ArrayBuffer(4), length: 3 });
    await tick();
    expect(secondDone).toBe(false); // output alone does not open the window
    port.reply({ type: 'consumed', id: 0, seq: 0 });
    await second;
    expect(fed).toEqual([3]);

    let finalDone = false;
    const last = decoder.push(slice(), true).then(() => { finalDone = true; });
    await tick();
    expect(port.data().map((m) => m.final)).toEqual([false, false, true]);
    port.reply({ type: 'consumed', id: 0, seq: 1 });
    await tick();
    expect(finalDone).toBe(false); // 1 still in flight
    port.reply({ type: 'consumed', id: 0, seq: 2 });
    await last;
  });

  it('bounds queued output on a real channel when parsing is slower than decompression', async () => {
    const port = channelWorker({ batchBytes: 4096 });
    const bytes = zstd(sampleNdjson);
    const slowParse = () => { const until = performance.now() + 0.2; while (performance.now() < until); };
    const decoder = createWorkerZstdDecoders(() => port, fzstdFallback, { maxInFlight: 3 })(slowParse);
    for (let o = 0; o < bytes.length; o += 2048) await decoder.push(bytes.slice(o, o + 2048), o + 2048 >= bytes.length);
    expect(port.maxInFlight).toBe(3);
    expect(port.inFlight).toBe(0);
  });

  it('reports a corrupt log with the same error the in-thread decoder gives', async () => {
    const bytes = zstd(sampleNdjson);
    bytes.fill(0xff, 20, 4000);
    const inThread = await parse(fakeFile(bytes, 'bad.zstd'), undefined, 1024);
    const viaWorker = await parse(fakeFile(bytes, 'bad.zstd'), createWorkerZstdDecoders(() => channelWorker(), fzstdFallback), 1024);

    const error = inThread.emitted.find((m) => m.type === 'error');
    expect(error.message).toMatch(/^Could not decompress "bad\.zstd": /);
    expect(viaWorker.emitted.filter((m) => m.type === 'error')).toEqual([error]);
    expect(viaWorker.emitted.some((m) => m.type === 'done')).toBe(false);
  });

  it('fails the push when parsing a decoded chunk throws, and cancels the stream', async () => {
    const port = fakePort();
    const decoder = createWorkerZstdDecoders(() => port, fzstdFallback)(() => { throw new Error('bad line'); });
    const pushed = decoder.push(new Uint8Array(8));
    await tick();
    port.reply({ type: 'ready' });
    await tick();
    port.reply({ type: 'chunk', id: 0, bytes: new ArrayBuffer(4), length: 4 });
    await expect(pushed).resolves.toBeUndefined(); // the window was open: push already returned
    await expect(decoder.push(new Uint8Array(8))).rejects.toThrow('bad line');
    expect(port.sent.at(-1)).toEqual({ type: 'cancel', id: 0 });
  });

  it('cancel() rejects the waiting push and ignores output that arrives after it', async () => {
    const port = fakePort();
    const fed = [];
    const decoder = createWorkerZstdDecoders(() => port, fzstdFallback, { maxInFlight: 1 })((c) => fed.push(c));
    const pushed = decoder.push(new Uint8Array(8));
    await tick();
    port.reply({ type: 'ready' });
    await tick();
    decoder.cancel();
    await expect(pushed).rejects.toThrow('Decompression cancelled');
    expect(port.sent.at(-1)).toEqual({ type: 'cancel', id: 0 });
    port.reply({ type: 'chunk', id: 0, bytes: new ArrayBuffer(4), length: 4 });
    port.reply({ type: 'consumed', id: 0, seq: 0 });
    expect(fed).toEqual([]);
  });

  it('cancels the worker stream when reading the file fails mid-stream', async () => {
    const port = channelWorker();
    const bytes = zstd(sampleNdjson);
    let reads = 0;
    const file = {
      name: 'eventlog.zstd',
      size: bytes.length,
      slice(start, end) {
        return { async arrayBuffer() {
          if (++reads === 4) throw new Error('disk gone');
          return bytes.slice(start, end).buffer;
        } };
      },
    };
    const { emitted } = await parse(file, createWorkerZstdDecoders(() => port, fzstdFallback), 1024);
    expect(emitted.filter((m) => m.type === 'error')).toEqual([{ type: 'error', message: 'Could not decompress "eventlog.zstd": disk gone' }]);
    await tick();
    expect(port.requests.at(-1)).toBe('cancel');
  });

  it('fails the running stream when the worker crashes, and decodes later streams in-thread', async () => {
    const port = fakePort();
    const onFallback = vi.fn();
    const factory = createWorkerZstdDecoders(() => port, fzstdFallback, { maxInFlight: 1, onFallback });
    const pushed = factory(() => {}).push(new Uint8Array(8));
    await tick();
    port.reply({ type: 'ready' });
    await tick();
    const ev = port.fail('out of memory');
    await expect(pushed).rejects.toThrow('Decompress worker crashed: out of memory');
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(port.terminated).toBe(true);
    expect(onFallback).toHaveBeenCalledWith('the decompress worker crashed: out of memory');

    const { emitted } = await parse(fakeFile(zstd(sampleNdjson)), factory, 8192);
    expect(emitted.at(-1).type).toBe('done');
    expect(port.data()).toHaveLength(1);
  });

  describe('falls back to in-thread decoding with identical output', () => {
    const expectFallbackParse = async (factory) => {
      const bytes = zstd(sampleNdjson);
      const inThread = await parse(fakeFile(bytes), undefined, 8192);
      const fallback = await parse(fakeFile(bytes), factory, 8192);
      expect(fallback.emitted).toEqual(inThread.emitted);
    };

    it('when the worker cannot be constructed', async () => {
      const onFallback = vi.fn();
      await expectFallbackParse(createWorkerZstdDecoders(() => { throw new Error('Worker is not defined'); }, fzstdFallback, { onFallback }));
      expect(onFallback).toHaveBeenCalledWith('could not start the decompress worker: Worker is not defined');
    });

    it('when the worker script fails to load', async () => {
      const port = fakePort();
      const onFallback = vi.fn();
      const factory = createWorkerZstdDecoders(() => {
        setTimeout(() => expect(port.fail('').preventDefault).toHaveBeenCalled(), 0);
        return port;
      }, fzstdFallback, { onFallback });
      await expectFallbackParse(factory);
      expect(onFallback).toHaveBeenCalledWith('the decompress worker failed to load: unknown error');
      expect(port.terminated).toBe(true);
      expect(port.sent).toEqual([]);
    });

    it('when the worker never reports ready', async () => {
      const port = fakePort();
      const onFallback = vi.fn();
      await expectFallbackParse(createWorkerZstdDecoders(() => port, fzstdFallback, { readyTimeoutMs: 5, onFallback }));
      expect(onFallback).toHaveBeenCalledWith('the decompress worker did not start in time');
      expect(port.terminated).toBe(true);
    });
  });
});
