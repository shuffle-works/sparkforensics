// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';

import { ThemeProvider } from '@/theme/ThemeProvider';
import { DocsProvider, useDocs } from '@/view/DocsContext';
import { DocsSheet } from '@/view/DocsSheet';

// DocsSheet's measurePanel constructs a ResizeObserver on mount; jsdom has
// none. A no-op stub is enough (see docs-sheet.test.tsx for the rationale).
if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

type CapturedPanelProps = {
  minSize?: number | string;
  maxSize?: number | string;
  className?: string;
  children?: ReactNode;
};

// react-resizable-panels does not reflect minSize/maxSize into the DOM (they
// live in an internal registry), so the only way to assert the constraints
// DocsSheet renders is to capture the props it passes to <Panel>.
const capturedPanels: CapturedPanelProps[] = [];

vi.mock('react-resizable-panels', () => ({
  Group: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Separator: () => <div />,
  Panel: (props: CapturedPanelProps) => {
    capturedPanels.push(props);
    return <div>{props.children}</div>;
  },
}));

/** Resolve a react-resizable-panels size prop to pixels the way the library
 * does (numbers are px; `vw` strings are a fraction of window.innerWidth). */
function resolvePx(size: number | string | undefined, innerWidth: number): number {
  if (typeof size === 'number') return size;
  if (typeof size === 'string' && size.endsWith('vw')) {
    return (parseFloat(size) / 100) * innerWidth;
  }
  throw new Error(`unexpected size prop: ${String(size)}`);
}

/** The docs panel is the one carrying a maxSize; the spacer panel has none.
 * Re-renders re-capture, so the last matching entry is the current render. */
function lastDocsPanel(): CapturedPanelProps {
  const match = capturedPanels.filter((p) => p.maxSize !== undefined).at(-1);
  if (!match) throw new Error('docs panel not rendered');
  return match;
}

function setViewportWidth(px: number) {
  Object.defineProperty(window, 'innerWidth', {
    value: px,
    configurable: true,
    writable: true,
  });
}

function Opener() {
  const { open } = useDocs();
  return <button onClick={() => open('#intro')}>open</button>;
}

function renderTree() {
  render(
    <ThemeProvider>
      <DocsProvider>
        <Opener />
        <DocsSheet />
      </DocsProvider>
    </ThemeProvider>,
  );
}

describe('DocsSheet panel min/max constraints', () => {
  beforeEach(() => {
    capturedPanels.length = 0;
  });

  it('keeps minSize <= effective maxSize on a narrow (320px) viewport', async () => {
    setViewportWidth(320);
    const user = userEvent.setup();
    renderTree();
    await user.click(screen.getByText('open'));

    const panel = lastDocsPanel();
    const min = resolvePx(panel.minSize, 320);
    const max = resolvePx(panel.maxSize, 320); // 90vw of 320 = 288
    expect(min).toBeLessThanOrEqual(max);
  });

  it('keeps the full 320px minimum on a normal (1280px) viewport', async () => {
    setViewportWidth(1280);
    const user = userEvent.setup();
    renderTree();
    await user.click(screen.getByText('open'));

    const panel = lastDocsPanel();
    expect(resolvePx(panel.minSize, 1280)).toBe(320);
    expect(resolvePx(panel.minSize, 1280)).toBeLessThanOrEqual(resolvePx(panel.maxSize, 1280));
  });

  it('re-clamps the minimum when the window shrinks while the sheet is open', async () => {
    setViewportWidth(1280);
    const user = userEvent.setup();
    renderTree();
    await user.click(screen.getByText('open'));
    expect(resolvePx(lastDocsPanel().minSize, 1280)).toBe(320);

    setViewportWidth(320);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    const panel = lastDocsPanel();
    expect(resolvePx(panel.minSize, 320)).toBeLessThanOrEqual(resolvePx(panel.maxSize, 320));
  });
});
