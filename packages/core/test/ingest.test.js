import { describe, it, expect, vi } from 'vitest';
import { routeMessage } from '../src/ingest.js';

// createIngestClient's Worker wiring (postMessage/onmessage/onerror) needs a real browser Worker
// and is exercised end to end via the view's drop-a-file flow (see AGENTS.md); these tests cover
// routeMessage directly, the part createIngestClient and the Node CLI path (src/cli/collect-run.ts)
// both share.
describe('routeMessage', () => {
  it('resolves the matching pending taskData request and removes it from the map', () => {
    const resolve = vi.fn();
    const reject = vi.fn();
    const pending = new Map([['0', { resolve, reject }]]);
    const metrics = new Float64Array([1, 2]);
    routeMessage({ type: 'taskData', stageId: 0, reqId: '0', metrics, fieldNames: ['a', 'b'] }, {}, pending);
    expect(resolve).toHaveBeenCalledWith({ metrics, fieldNames: ['a', 'b'] });
    expect(pending.has('0')).toBe(false);
  });

  it('no-ops for a taskData message whose reqId has no pending request', () => {
    const resolve = vi.fn();
    const pending = new Map([['0', { resolve, reject: vi.fn() }]]);
    expect(() => routeMessage({ type: 'taskData', stageId: 0, reqId: '1', metrics: new Float64Array(0), fieldNames: [] }, {}, pending)).not.toThrow();
    expect(resolve).not.toHaveBeenCalled();
    expect(pending.has('0')).toBe(true);
  });

  it('passes the done summary through whole', () => {
    const onDone = vi.fn();
    routeMessage({ type: 'done', data: { skippedLines: 3, unreadableSqlExecutions: [7] } }, { onDone });
    expect(onDone).toHaveBeenCalledWith({ skippedLines: 3, unreadableSqlExecutions: [7] });
  });

  it('dispatches app/stage/sql handlers with the message data payload, not the envelope', () => {
    const onApp = vi.fn();
    routeMessage({ type: 'app', data: { name: 'x' } }, { onApp });
    expect(onApp).toHaveBeenCalledWith({ name: 'x' });
  });

  it('ignores a message type with no wired handler instead of throwing', () => {
    expect(() => routeMessage({ type: 'app', data: {} }, {})).not.toThrow();
  });
});
