// @vitest-environment jsdom
import { Suspense, lazy } from 'react';
import { expect, test } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { warmLazy } from '../../src/lib/warm-lazy';

function deferredChunk() {
  let load!: () => void;
  const loaded = new Promise<void>((resolve) => { load = resolve; });
  const Widget = lazy(() => loaded.then(() => ({ default: () => <p>widget</p> })));
  return { Widget, load: () => act(async () => { load(); await loaded; }) };
}

test('a lazy component that was not warmed commits its fallback on first render', async () => {
  const { Widget, load } = deferredChunk();
  await load();

  render(<Suspense fallback={<p>loading</p>}><Widget /></Suspense>);

  expect(screen.getByText('loading')).toBeInTheDocument();
  expect(screen.queryByText('widget')).toBeNull();
});

test('a warmed lazy component renders its content on first render, with no fallback', async () => {
  const { Widget, load } = deferredChunk();
  warmLazy(Widget);
  await load();

  render(<Suspense fallback={<p>loading</p>}><Widget /></Suspense>);

  expect(screen.getByText('widget')).toBeInTheDocument();
  expect(screen.queryByText('loading')).toBeNull();
});

test('warming ignores values that are not lazy components', () => {
  expect(() => warmLazy(null, undefined, 42, {}, () => null)).not.toThrow();
});

test('warming a component whose chunk fails to load does not throw', async () => {
  const Broken = lazy(() => Promise.reject(new Error('chunk failed')));
  expect(() => warmLazy(Broken)).not.toThrow();
  await act(async () => { await Promise.resolve(); });
});
