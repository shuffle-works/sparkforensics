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
    routeMessage({ type: 'taskData', reqId: '0', metrics: [1, 2], fieldNames: ['a', 'b'] }, {}, pending);
    expect(resolve).toHaveBeenCalledWith({ metrics: [1, 2], fieldNames: ['a', 'b'] });
    expect(pending.has('0')).toBe(false);
  });

  it('no-ops for a taskData message whose reqId has no pending request', () => {
    const resolve = vi.fn();
    const pending = new Map([['0', { resolve, reject: vi.fn() }]]);
    expect(() => routeMessage({ type: 'taskData', reqId: '1', metrics: [], fieldNames: [] }, {}, pending)).not.toThrow();
    expect(resolve).not.toHaveBeenCalled();
    expect(pending.has('0')).toBe(true);
  });

  it('passes the done message through with just its skippedLines field', () => {
    const onDone = vi.fn();
    routeMessage({ type: 'done', skippedLines: 3, app: {} }, { onDone });
    expect(onDone).toHaveBeenCalledWith({ skippedLines: 3 });
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
