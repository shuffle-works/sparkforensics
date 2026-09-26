// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { store } from '@/store/store';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { DocsProvider, useDocs } from '@/view/DocsContext';
import { DocsSheet } from '@/view/DocsSheet';
import { TagBadge } from '@/view/ImpactBadge';
import { docsHref, setPublishedDocs } from '@/view/docs-href';
import { docsUrl } from '@sparkforensics/core/docs-config.ts';
import type { ImpactBand } from '@sparkforensics/core/types.ts';

// The docs panel resizes via react-resizable-panels, which constructs a
// ResizeObserver on mount; jsdom has none. A no-op stub is enough (the panel
// mounts and behaves; only pixel-exact layout, which we don't assert, is lost).
// Scoped to this file: a global stub would make Recharts (in chart/timeline
// tests) abandon its initialDimension fallback and render 0×0.
if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// Neither a vendor chapter page nor a docs-site page has a live channel back
// to this app (see DocsSheet.tsx): every load, including a theme-only change,
// reassigns the iframe `src` with a `t=<theme>` marker ahead of the `#anchor`
// hash so the browser actually reloads it. Mirrors `siteFrameSrc` in
// DocsSheet.tsx.
function withTheme(url: string, theme: 'dark' | 'light' = 'dark'): string {
  const [base, hash] = url.split('#');
  return `${base}?t=${theme}#${hash}`;
}

function Consumer() {
  const { open, openSite, close, isOpen } = useDocs();
  return (
    <div>
      <span data-testid="is-open">{String(isOpen)}</span>
      <button onClick={() => open('#intro')}>open</button>
      <button onClick={() => openSite('docs/user-guide/understanding-findings.html#skew')}>open-site</button>
      <button onClick={() => close()}>close</button>
    </div>
  );
}

function renderTree() {
  render(
    <ThemeProvider>
      <DocsProvider>
        <Consumer />
        <DocsSheet />
      </DocsProvider>
    </ThemeProvider>,
  );
}

function renderLegendAndSheet(tags: { type: string; impactBand: ImpactBand }[], preventNativeNavigation = false) {
  const badges = (
    <div>
      {tags.map((t, i) => <TagBadge key={i} type={t.type} impactBand={t.impactBand} />)}
    </div>
  );
  render(
    <ThemeProvider>
      <DocsProvider>
        {preventNativeNavigation ? (
          <div onClickCapture={(event) => event.preventDefault()}>{badges}</div>
        ) : badges}
        <DocsSheet />
      </DocsProvider>
    </ThemeProvider>,
  );
}

describe('DocsSheet + DocsContext', () => {
  it('keeps the documentation sheet closed for a Ctrl-clicked tag badge link', () => {
    renderLegendAndSheet([{ type: 'jobFailureRate', impactBand: 'warning' }], true);

    const link = screen.getByRole('link', { name: 'JOBS' });
    expect(link).toHaveAttribute('href', docsUrl('#bottleneck-job-failure-rate'));
    fireEvent.click(link, { ctrlKey: true });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('moves focus into the sheet, then restores focus to a tag badge link after Escape', async () => {
    const user = userEvent.setup();
    renderLegendAndSheet([{ type: 'jobFailureRate', impactBand: 'warning' }]);

    const link = screen.getByRole('link', { name: 'JOBS' });
    await user.click(link);

    expect(document.querySelector('iframe')?.getAttribute('src')).toBe(
      withTheme(docsUrl('#bottleneck-job-failure-rate')),
    );
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement | null);

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(link).toHaveFocus();
  });

  it('reassigns the iframe src when a second vendor destination is selected while the sheet is open', async () => {
    const user = userEvent.setup();
    // Two distinct tags, each its own docs link, to exercise re-navigation
    // while the sheet stays open.
    renderLegendAndSheet([
      { type: 'skew', impactBand: 'warning' },
      { type: 'jobFailureRate', impactBand: 'info' },
    ]);

    const skewLink = screen.getByRole('link', { name: 'SKEW' });
    const jobsLink = screen.getByRole('link', { name: 'JOBS' });
    await user.click(skewLink);
    await user.click(jobsLink);

    expect(document.querySelector('iframe')?.getAttribute('src')).toBe(
      withTheme(docsUrl('#bottleneck-job-failure-rate')),
    );
  });

  it('renders only the guide link, no vendor-doc link, for a type outside the known tag vocabulary', () => {
    store.getState().setWidgetDensity('advanced');
    renderLegendAndSheet([{ type: 'zetaSignal', impactBand: 'info' }]);

    expect(screen.getByText('ZETASIGNAL')).toBeInTheDocument();
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', 'docs/user-guide/understanding-findings.html#zetasignal');
    store.getState().setWidgetDensity('basic');
  });

  it('open() sets isOpen and sets the iframe src to docsUrl(anchor)', async () => {
    const user = userEvent.setup();
    renderTree();

    await user.click(screen.getByText('open'));

    expect(screen.getByTestId('is-open').textContent).toBe('true');
    const iframe = document.querySelector('iframe');
    expect(iframe?.getAttribute('src')).toBe(withTheme(docsUrl('#intro')));
  });

  it('reloads the vendor iframe (fresh src) when the theme toggles while a vendor anchor is open', async () => {
    const user = userEvent.setup();
    renderTree();

    await user.click(screen.getByText('open'));
    expect(document.querySelector('iframe')?.getAttribute('src')).toBe(withTheme(docsUrl('#intro'), 'dark'));

    act(() => {
      store.getState().setTheme('light');
    });

    expect(document.querySelector('iframe')?.getAttribute('src')).toBe(withTheme(docsUrl('#intro'), 'light'));

    // Restore the shared theme store: it's a module singleton, not reset
    // between tests within this file.
    act(() => {
      store.getState().setTheme('dark');
    });
  });

  it('close() sets isOpen back to false', async () => {
    const user = userEvent.setup();
    renderTree();

    await user.click(screen.getByText('open'));
    expect(screen.getByTestId('is-open').textContent).toBe('true');

    await user.click(screen.getByText('close'));
    expect(screen.getByTestId('is-open').textContent).toBe('false');
  });

  it('re-opening after close reloads the same anchor with a fresh src assignment', async () => {
    const user = userEvent.setup();
    renderTree();

    await user.click(screen.getByText('open'));
    const firstSrc = document.querySelector('iframe')?.getAttribute('src');
    await user.click(screen.getByText('close'));
    await user.click(screen.getByText('open'));

    expect(document.querySelector('iframe')?.getAttribute('src')).toBe(firstSrc);
  });

  it('clicking a finding\'s guide icon opens the same panel as the vendor link, on the docs-site page', async () => {
    const user = userEvent.setup();
    store.getState().setWidgetDensity('advanced');
    renderLegendAndSheet([{ type: 'skew', impactBand: 'warning' }]);

    const guideLink = screen.getByRole('link', { name: /sparkforensics guide: task skew/i });
    await user.click(guideLink);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Guide');
    expect(document.querySelector('iframe')?.getAttribute('src')).toBe(
      'docs/user-guide/understanding-findings.html?t=dark#skew',
    );
    store.getState().setWidgetDensity('basic');
  });

  it('keeps the panel closed for a Ctrl-clicked guide icon (native navigation fallback)', () => {
    store.getState().setWidgetDensity('advanced');
    renderLegendAndSheet([{ type: 'skew', impactBand: 'warning' }], true);

    const guideLink = screen.getByRole('link', { name: /sparkforensics guide: task skew/i });
    fireEvent.click(guideLink, { ctrlKey: true });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    store.getState().setWidgetDensity('basic');
  });

  it('reloads the docs-site iframe (fresh src) when the theme toggles while a guide page is open', async () => {
    const user = userEvent.setup();
    renderTree();

    await user.click(screen.getByText('open-site'));
    expect(document.querySelector('iframe')?.getAttribute('src')).toBe(
      'docs/user-guide/understanding-findings.html?t=dark#skew',
    );

    act(() => {
      store.getState().setTheme('light');
    });

    expect(document.querySelector('iframe')?.getAttribute('src')).toBe(
      'docs/user-guide/understanding-findings.html?t=light#skew',
    );

    // Restore the shared theme store: it's a module singleton, not reset
    // between tests within this file.
    act(() => {
      store.getState().setTheme('dark');
    });
  });

  it('switching from a vendor anchor to a docs-site guide swaps the panel title and reloads the iframe', async () => {
    const user = userEvent.setup();
    renderTree();

    await user.click(screen.getByText('open'));
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Reference');

    await user.click(screen.getByText('open-site'));
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Guide');
    expect(document.querySelector('iframe')?.getAttribute('src')).toBe(
      'docs/user-guide/understanding-findings.html?t=dark#skew',
    );
  });
});

describe('DocsSheet Escape inside the docs frame', () => {
  it('closes the panel on Escape pressed inside the frame, but not while the docs search popup is open', async () => {
    const user = userEvent.setup();
    renderTree();
    await user.click(screen.getByRole('button', { name: 'open-site' }));
    expect(screen.getByTestId('is-open')).toHaveTextContent('true');

    const frame = document.querySelector('[data-slot="docs-panel"] iframe') as HTMLIFrameElement;
    fireEvent.load(frame);
    const frameDoc = frame.contentDocument!;

    // The docs site's own search popup owns Escape while it is open.
    const search = frameDoc.createElement('div');
    search.className = 'VPLocalSearchBox';
    // jsdom never loads the page, so the frame document starts empty.
    if (!frameDoc.documentElement) frameDoc.appendChild(frameDoc.createElement('html'));
    frameDoc.documentElement.appendChild(search);
    act(() => { frameDoc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(screen.getByTestId('is-open')).toHaveTextContent('true');

    search.remove();
    act(() => { frameDoc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(screen.getByTestId('is-open')).toHaveTextContent('false');
  });
});

// A single-file HTML download has no docs/ folder beside it, so the export
// app flips docs-href to the published sites (see src/view/docs-href.ts).
describe('published docs (single-file HTML export)', () => {
  const TUNING = 'https://shuffle-works.github.io/spark-tuning-reference/';
  const GUIDE = 'https://shuffle-works.github.io/sparkforensics/docs/';

  it('maps the tuning reference and the guide to their published sites', () => {
    setPublishedDocs(true);
    try {
      expect(docsHref(docsUrl('#bottleneck-skew'))).toBe(`${TUNING}bottleneck-skew.html#bottleneck-skew`);
      expect(docsHref('docs/user-guide/understanding-findings.html#skew')).toBe(`${GUIDE}user-guide/understanding-findings.html#skew`);
      expect(docsHref('docs/')).toBe(GUIDE);
    } finally {
      setPublishedDocs(false);
    }
    expect(docsHref('docs/')).toBe('docs/');
  });

  it('points the panel iframe and the tag links at the published docs', async () => {
    const user = userEvent.setup();
    setPublishedDocs(true);
    store.getState().setWidgetDensity('advanced');
    try {
      renderLegendAndSheet([{ type: 'skew', impactBand: 'warning' }]);
      const guideLink = screen.getByRole('link', { name: /sparkforensics guide: task skew/i });
      expect(guideLink).toHaveAttribute('href', `${GUIDE}user-guide/understanding-findings.html#skew`);

      await user.click(guideLink);
      expect(document.querySelector('iframe')?.getAttribute('src')).toBe(
        `${GUIDE}user-guide/understanding-findings.html?t=dark#skew`,
      );
    } finally {
      setPublishedDocs(false);
      store.getState().setWidgetDensity('basic');
    }
  });
});
