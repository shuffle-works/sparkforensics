// @vitest-environment jsdom
import { test, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { emptyAppModel, store } from '@/store/store';
import { StageDetailProvider } from '@/view/StageDetailContext';
import { CachingOpportunity } from '@/view/widgets/CachingOpportunity';
import type { Finding, TaskData } from '@sparkforensics/core/types.ts';

const getTaskData = async (): Promise<TaskData> => ({ metrics: [], fieldNames: [] });

function renderCachingOpportunity(catalog: Finding[], defaultCollapsed = false) {
  return render(
    <StageDetailProvider>
      <CachingOpportunity appModel={emptyAppModel()} catalog={catalog} getTaskData={getTaskData} defaultCollapsed={defaultCollapsed} />
    </StageDetailProvider>,
  );
}

// Composite relation names render across separate spans, so getByText can't
// match the combined string; match the element whose full textContent equals expected.
function fullTextOf(expected: string) {
  return (_content: string, element: Element | null) => element?.textContent === expected;
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    type: 'cachingOpportunity',
    stageId: null,
    impactBand: 'info',
    metric: 'executionReuse',
    value: 2,
    relation: 'prices',
    format: 'parquet',
    executionIds: [1, 2],
    totalReadBytes: 100_000_000,
    recommendation: 'Read by 2 queries. Cache the shared DataFrame, or broadcast it if it is a small join lookup.',
    ...overrides,
  } as Finding;
}

test('renders nothing when there are no caching-opportunity findings', () => {
  const { container } = renderCachingOpportunity([]);
  expect(container).toBeEmptyDOMElement();
});

test('ignores findings of other types', () => {
  const { container } = renderCachingOpportunity([finding({ type: 'skew', stageId: 1 })]);
  expect(container).toBeEmptyDOMElement();
});

test('renders the widget heading, CACHE badge, and a row for every relation (not just the worst)', async () => {
  const catalog: Finding[] = [
    finding({ relation: 'sales', value: 3, totalReadBytes: 5_000_000 }),
    finding({ relation: 'dw.dim_store', format: 'jdbc', value: 6, totalReadBytes: 900_000_000 }),
  ];
  renderCachingOpportunity(catalog);

  expect(screen.getByRole('heading', { name: /caching opportunities/i })).toBeInTheDocument();
  expect(screen.getByText('CACHE')).toBeInTheDocument();
  const rows = screen.getAllByRole('row');
  // header row + 2 data rows
  expect(rows).toHaveLength(3);
  expect(rows[1]).toHaveTextContent('dw.dim_store');
  expect(rows[2]).toHaveTextContent('sales');
});

test('shows the format badge for each relation', async () => {
  renderCachingOpportunity([finding({ relation: 'dw.dim_store', format: 'jdbc' })]);
  expect(screen.getByText('jdbc')).toBeInTheDocument();
});

test('sorts by totalReadBytes desc, then reuse count desc', async () => {
  const catalog: Finding[] = [
    finding({ relation: 'small', value: 9, totalReadBytes: 1_000 }),
    finding({ relation: 'bigA', value: 2, totalReadBytes: 800_000_000 }),
    finding({ relation: 'bigB', value: 5, totalReadBytes: 800_000_000 }),
  ];
  renderCachingOpportunity(catalog);
  const rows = screen.getAllByRole('row').slice(1);
  expect(rows[0]).toHaveTextContent('bigB'); // same bytes as bigA, higher reuse count
  expect(rows[1]).toHaveTextContent('bigA');
  expect(rows[2]).toHaveTextContent('small');
});

test('shows Data read via formatBytes, and an em-dash when bytes are unknown', async () => {
  const catalog: Finding[] = [
    finding({ relation: 'known', totalReadBytes: 2_100_000_000 }),
    finding({ relation: 'jdbcNoBytes', format: 'jdbc', totalReadBytes: 0 }),
  ];
  renderCachingOpportunity(catalog);
  expect(screen.getByText('2.1 GB')).toBeInTheDocument();
  const jdbcRow = screen.getAllByRole('row').find((r) => r.textContent?.includes('jdbcNoBytes'))!;
  expect(jdbcRow).toHaveTextContent('—');
});

test('renders the ms raw-waste figure when the finding carries an impactEstimate', async () => {
  renderCachingOpportunity([finding({
    impactEstimate: { basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured', rawWaste: { value: 800, unit: 'ms' } },
  })]);
  expect(screen.getByText('800ms')).toBeInTheDocument();
});

test('renders the recommendation text', async () => {
  renderCachingOpportunity([finding()]);
  expect(screen.getByText(/Cache the shared DataFrame, or broadcast it if it is a small join lookup/)).toBeInTheDocument();
});

test('renders the recommendation unconditionally, with no per-row toggle', async () => {
  renderCachingOpportunity([finding()]);

  const recommendation = /Cache the shared DataFrame, or broadcast it if it is a small join lookup/;
  expect(screen.getByText(recommendation)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /recommendation for prices/i })).not.toBeInTheDocument();
});

test('never renders a per-row confidence toggle: every finding here is low confidence', async () => {
  renderCachingOpportunity([finding(), compositeFinding()]);
  expect(screen.queryByRole('button', { name: /confidence/i })).not.toBeInTheDocument();
});

function compositeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    type: 'cachingOpportunity',
    variant: 'composite',
    stageId: null,
    impactBand: 'info',
    metric: 'executionReuse',
    value: 2,
    format: 'derived',
    relations: [{ relation: 'mx.a', format: 'delta' }, { relation: 'mx.b', format: 'delta' }],
    operator: 'join',
    relation: 'mx.a join mx.b',
    executionIds: [1, 2],
    totalReadBytes: 100_000_000,
    confidence: 'low',
    validationRequired: 'Composite reuse is inferred from a structural plan-shape match...',
    recommendation: 'Joined result read by 2 queries. Cache the joined DataFrame (mx.a join mx.b), or reconsider whether it needs to be recomputed each time.',
    ...overrides,
  } as Finding;
}

test('renders a composite row with an operator badge instead of a format badge', async () => {
  renderCachingOpportunity([compositeFinding()]);
  expect(screen.getByText('JOIN')).toBeInTheDocument();
  expect(screen.queryByText('DERIVED')).not.toBeInTheDocument();
  expect(screen.getByText(fullTextOf('mx.a join mx.b'))).toBeInTheDocument();
});

test('renders the join connector word with emphasis distinct from the relation names', async () => {
  renderCachingOpportunity([compositeFinding()]);
  const connector = screen.getByText('join', { selector: 'span' });
  expect(connector).toHaveClass('font-semibold', 'mx-1');
  // Full relation text still reads as one continuous string.
  expect(screen.getByText(fullTextOf('mx.a join mx.b'))).toBeInTheDocument();
});

test('renders a union composite row with a UNION operator badge', async () => {
  renderCachingOpportunity([compositeFinding({ operator: 'union', relation: 'mx.a union mx.b', recommendation: 'Unioned result read by 2 queries. Cache the unioned DataFrame (mx.a union mx.b), or reconsider whether it needs to be recomputed each time.' })]);
  expect(screen.getByText('UNION')).toBeInTheDocument();
});

test('defaults to collapsed and shows the top-relation summary with RowStatusCluster confidence note', async () => {
  store.getState().setWidgetDensity('advanced');
  const catalog: Finding[] = [
    finding({ relation: 'sales', value: 3, totalReadBytes: 5_000_000, confidence: 'low' }),
    finding({ relation: 'dw.dim_store', format: 'jdbc', value: 2, totalReadBytes: 900_000_000, confidence: 'low' }),
  ];
  renderCachingOpportunity(catalog, true);

  // Card collapsed by default: table rows are NOT visible
  const rows = screen.queryAllByRole('row');
  expect(rows).toHaveLength(0);

  // But summary shows the top finding (dw.dim_store with 2 reuse count, highest bytes)
  expect(screen.getByText('2×')).toBeInTheDocument();
  expect(screen.getByText(/read by 2 queries: dw\.dim_store/i)).toBeInTheDocument();

  // RowStatusCluster renders a low-confidence badge per row; the caveat sentence is a
  // separate, plain always-legible paragraph (not a hover-only tooltip).
  expect(screen.getAllByText(/low confidence/i).length).toBeGreaterThan(0);
  const caveat = screen.getByText(/Reuse is inferred from plan structure, not confirmed by execution/i);
  expect(caveat).toBeInTheDocument();
  expect(caveat).not.toHaveClass('sr-only');
  expect(caveat.tagName).toBe('P');

  store.getState().setWidgetDensity('basic');
});

test('the RowStatusCluster confidence note is Advanced-only', () => {
  const catalog = [compositeFinding()];
  store.getState().setWidgetDensity('basic');
  render(
    <StageDetailProvider>
      <CachingOpportunity appModel={emptyAppModel()} catalog={catalog} getTaskData={getTaskData} defaultCollapsed={true} />
    </StageDetailProvider>,
  );
  expect(screen.queryByText(/low confidence/i)).not.toBeInTheDocument();

  cleanup();
  store.getState().setWidgetDensity('advanced');
  render(
    <StageDetailProvider>
      <CachingOpportunity appModel={emptyAppModel()} catalog={catalog} getTaskData={getTaskData} defaultCollapsed={true} />
    </StageDetailProvider>,
  );
  expect(screen.getByText(/low confidence/i)).toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});

test('each row shows its own finding confidence, not a single shared value', () => {
  store.getState().setWidgetDensity('advanced');
  const catalog: Finding[] = [
    finding({ relation: 'sales', value: 3, totalReadBytes: 5_000_000, confidence: 'medium' }),
    finding({ relation: 'dw.dim_store', format: 'jdbc', value: 2, totalReadBytes: 900_000_000, confidence: 'low' }),
  ];
  renderCachingOpportunity(catalog);

  expect(screen.getByText(/medium confidence/i)).toBeInTheDocument();
  expect(screen.getByText(/low confidence/i)).toBeInTheDocument();

  store.getState().setWidgetDensity('basic');
});

test('the "verify before caching" caveat paragraph is Advanced-only, same as the confidence badge', () => {
  const catalog = [compositeFinding()];
  store.getState().setWidgetDensity('basic');
  render(
    <StageDetailProvider>
      <CachingOpportunity appModel={emptyAppModel()} catalog={catalog} getTaskData={getTaskData} defaultCollapsed={true} />
    </StageDetailProvider>,
  );
  expect(screen.queryByText(/Reuse is inferred from plan structure/i)).not.toBeInTheDocument();

  cleanup();
  store.getState().setWidgetDensity('advanced');
  render(
    <StageDetailProvider>
      <CachingOpportunity appModel={emptyAppModel()} catalog={catalog} getTaskData={getTaskData} defaultCollapsed={true} />
    </StageDetailProvider>,
  );
  expect(screen.getByText(/Reuse is inferred from plan structure/i)).toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});

test('leaf rows are unaffected by composite rendering changes', async () => {
  renderCachingOpportunity([finding()]);
  expect(screen.getByText('parquet')).toBeInTheDocument();
});

test('two composite findings sharing format/relation/executionIds (but from genuinely different fingerprints) both render as distinct rows with no React key-collision warning', async () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    // Same display text/operator/executionIds from two different byComposite
    // fingerprints must not collide on a shared React key.
    const catalog: Finding[] = [
      compositeFinding({ recommendation: 'Joined result read by 2 queries. Cache the joined DataFrame (mx.a join mx.b), or reconsider whether it needs to be recomputed each time. [variant X]' }),
      compositeFinding({ recommendation: 'Joined result read by 2 queries. Cache the joined DataFrame (mx.a join mx.b), or reconsider whether it needs to be recomputed each time. [variant Y]' }),
    ];
    renderCachingOpportunity(catalog);

    // Both rows rendered (not deduped/collapsed by React reconciling a shared key).
    expect(screen.getAllByText(fullTextOf('mx.a join mx.b'))).toHaveLength(2);
    expect(screen.getByText(/\[variant X\]/)).toBeInTheDocument();
    expect(screen.getByText(/\[variant Y\]/)).toBeInTheDocument();

    // No "Encountered two children with the same key" (or similar) React warning.
    const keyWarning = consoleError.mock.calls.some((args) =>
      args.some((a) => typeof a === 'string' && /same key/i.test(a)));
    expect(keyWarning).toBe(false);
  } finally {
    consoleError.mockRestore();
  }
});
