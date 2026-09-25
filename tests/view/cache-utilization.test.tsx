// @vitest-environment jsdom
import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { emptyAppModel, store } from '@/store/store';
import { CacheUtilization } from '@/view/widgets/CacheUtilization';
import { DocsProvider } from '@/view/DocsContext';
import type { AppModel, Finding, SparkAppInfo } from '@sparkforensics/core/types.ts';

interface RddFixtureOverrides {
  name?: string;
  storageLevel?: { useMemory: boolean; useDisk: boolean; deserialized: boolean; replication: number };
  numPartitions?: number;
  numCachedPartitions?: number;
  memorySize?: number;
  diskSize?: number;
}

function rdd(id: number, overrides: RddFixtureOverrides = {}) {
  return {
    id,
    name: `rdd${id}`,
    storageLevel: { useMemory: true, useDisk: false, deserialized: true, replication: 1 },
    numPartitions: 10,
    numCachedPartitions: 10,
    memorySize: 5e8,
    diskSize: 0,
    ...overrides,
  };
}

function buildAppModel(rddInfo?: Map<number, unknown>): AppModel {
  return {
    ...emptyAppModel(),
    app: { ...(rddInfo ? { rddInfo } : {}) } as unknown as SparkAppInfo,
  };
}

function renderWidget(appModel: AppModel, catalog: Finding[] = []) {
  return render(
    <DocsProvider>
      <CacheUtilization appModel={appModel} catalog={catalog} />
    </DocsProvider>,
  );
}

test('renders the widget heading and cached-RDD rows', () => {
  const rddInfo = new Map([
    [1, rdd(1)],
    [2, rdd(2, { numCachedPartitions: 4, memorySize: 2e8, diskSize: 1e8, storageLevel: { useMemory: true, useDisk: true, deserialized: false, replication: 2 } })],
  ]);
  renderWidget(buildAppModel(rddInfo));

  expect(screen.getByRole('heading', { name: /cache storage/i })).toBeInTheDocument();
  expect(screen.getByText('rdd1')).toBeInTheDocument();
  expect(screen.getByText('4 / 10')).toBeInTheDocument();
});

test('renders a doc link pointing at the memory-model anchor', () => {
  const rddInfo = new Map([[1, rdd(1)]]);
  renderWidget(buildAppModel(rddInfo));

  const link = screen.getByRole('link', { name: /how spark accounts cached memory/i });
  expect(link.getAttribute('href')).toContain('#memory-model');
});

test('excludes RDDs that are neither memory- nor disk-cached', () => {
  const rddInfo = new Map([
    [1, rdd(1, { storageLevel: { useMemory: false, useDisk: false, deserialized: false, replication: 1 } })],
  ]);
  const { container } = render(<CacheUtilization appModel={buildAppModel(rddInfo)} catalog={[]} />);
  expect(container.querySelector('[data-widget="cache-utilization"]')).toBeNull();
});

test('excludes RDDs with persist intent but zero actually-cached partitions', () => {
  const rddInfo = new Map([
    [1, rdd(1, { numCachedPartitions: 0, memorySize: 0, diskSize: 0 })],
    [2, rdd(2)],
  ]);
  renderWidget(buildAppModel(rddInfo));
  expect(screen.queryByText('rdd1')).not.toBeInTheDocument();
  expect(screen.getByText('rdd2')).toBeInTheDocument();
});

test('renders nothing when rddInfo is absent', () => {
  const { container } = render(<CacheUtilization appModel={buildAppModel()} catalog={[]} />);
  expect(container).toBeEmptyDOMElement();
});

test('shows a path-like RDD name as its basename with the full path in a tooltip', () => {
  const rddInfo = new Map([[1, rdd(1, { name: 'hdfs://host:8020/data/warehouse/sales/_delta_log' })]]);
  store.getState().setWidgetDensity('advanced');
  renderWidget(buildAppModel(rddInfo));
  const cell = screen.getByText('_delta_log');
  expect(cell.getAttribute('title')).toBe('hdfs://host:8020/data/warehouse/sales/_delta_log');
  store.getState().setWidgetDensity('basic');
});

test('truncates a long non-path RDD name and keeps the full text in a tooltip', () => {
  const longName =
    '*(1) Project [STORE_ID#58, STORE_NAME#59, STORE_SEGMENT#89] +- Scan JDBCRelation((SELECT * FROM sales) SPARK_GEN_SUBQ_0) [numPartitions=8]';
  const rddInfo = new Map([[1, rdd(1, { name: longName })]]);
  store.getState().setWidgetDensity('advanced');
  const { container } = renderWidget(buildAppModel(rddInfo));
  const cell = container.querySelector('td');
  expect(cell?.textContent?.length).toBe(71); // 70 chars + ellipsis
  expect(cell?.textContent?.endsWith('…')).toBe(true);
  expect(cell?.getAttribute('title')).toBe(longName);
  store.getState().setWidgetDensity('basic');
});

test('tags its root element with data-widget for instrumentation', () => {
  const rddInfo = new Map([[1, rdd(1)]]);
  const { container } = renderWidget(buildAppModel(rddInfo));
  expect(container.querySelector('[data-widget="cache-utilization"]')).not.toBeNull();
});

function cacheUtilizationFinding(overrides: Partial<Finding> = {}): Finding {
  const rddId = overrides.rddId ?? 1;
  const variant = overrides.variant ?? 'partialCache';
  return {
    type: 'cacheUtilization', variant, stageId: null,
    rddId, rddName: 'rdd1',
    impactBand: 'warning', metric: 'cachedRatio', value: 40,
    confidence: 'medium',
    id: `cacheUtilization:${rddId}:${variant}`,
    // Real memory/disk/partition values so the always-visible detail line has something to render.
    memorySize: 2e8, diskSize: 3e8, numCachedPartitions: 4, numPartitions: 10,
    recommendation: 'RDD rdd1 is 60% evicted from cache (40% of partitions cached), increase executor memory or reduce the cached dataset size.',
    ...overrides,
  } as Finding;
}

test('shows the CSTOR tag once, in the header, and keeps a per-row impact dot for the flagged RDD only', async () => {
  const user = userEvent.setup();
  const rddInfo = new Map([
    [1, rdd(1, { numCachedPartitions: 4 })], // flagged: 4/10 = 0.40 < 0.50
    [2, rdd(2)], // clean: 10/10
  ]);
  const catalog = [cacheUtilizationFinding({ rddId: 1, rddName: 'rdd1' })];
  renderWidget(buildAppModel(rddInfo), catalog);

  // Present once, in the header, while the widget is still collapsed.
  expect(screen.getByText('CSTOR')).toBeInTheDocument();
  // Expand the collapsed widget to reach the table rows.
  await user.click(screen.getByRole('button', { name: /cache storage/i }));
  const rows = screen.getAllByRole('row');
  // header + 2 data rows; row for rdd1 (data row 1) carries an impact dot, row for rdd2 does not.
  expect(rows[1].querySelectorAll('.size-2.rounded-full')).toHaveLength(1);
  expect(rows[2].querySelectorAll('.size-2.rounded-full')).toHaveLength(0);
});

test('lists the recommendation text for every flagged RDD below the table, worst-first', async () => {
  const rddInfo = new Map([
    [1, rdd(1, { numCachedPartitions: 8 })], // 0.80 -> info tier
    [2, rdd(2, { numCachedPartitions: 4 })], // 0.40 -> warning tier
  ]);
  const catalog = [
    cacheUtilizationFinding({ rddId: 1, rddName: 'rdd1', impactBand: 'info', recommendation: 'RDD rdd1 is 20% evicted from cache (80% of partitions cached), increase executor memory or reduce the cached dataset size.' }),
    cacheUtilizationFinding({ rddId: 2, rddName: 'rdd2', impactBand: 'warning', recommendation: 'RDD rdd2 is 60% evicted from cache (40% of partitions cached), increase executor memory or reduce the cached dataset size.' }),
  ];
  renderWidget(buildAppModel(rddInfo), catalog);

  const texts = screen.getAllByText(/evicted from cache/).map((el) => el.textContent);
  // Worst-first: the warning (rdd2) recommendation must appear before the info (rdd1) one.
  expect(texts[0]).toContain('rdd2');
  expect(texts[1]).toContain('rdd1');
});

test('renders memory/disk size and partition counts in the Advanced-only detail line', () => {
  const rddInfo = new Map([[1, rdd(1, { numCachedPartitions: 4 })]]);
  const catalog = [cacheUtilizationFinding({
    rddId: 1, variant: 'partialCache', memorySize: 2e8, diskSize: 0, numCachedPartitions: 4, numPartitions: 10,
  })];
  store.getState().setWidgetDensity('advanced');
  renderWidget(buildAppModel(rddInfo), catalog);

  // cacheFindingDetail reads sizes/partitions off the finding, not the RDD fixture above.
  expect(screen.getByText('40% cached (4/10 partitions)')).toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});

test('hides the memory/disk size and partition-count detail line at Basic density', () => {
  const rddInfo = new Map([[1, rdd(1, { numCachedPartitions: 4 })]]);
  const catalog = [cacheUtilizationFinding({
    rddId: 1, variant: 'partialCache', memorySize: 2e8, diskSize: 0, numCachedPartitions: 4, numPartitions: 10,
  })];
  renderWidget(buildAppModel(rddInfo), catalog);

  expect(screen.queryByText('40% cached (4/10 partitions)')).not.toBeInTheDocument();
});

test('renders both findings for an RDD that crosses both the partialCache and diskSpillover tiers', async () => {
  const rddInfo = new Map([
    [1, rdd(1, {
      storageLevel: { useMemory: true, useDisk: true, deserialized: false, replication: 1 },
      numCachedPartitions: 4, memorySize: 300, diskSize: 700,
    })],
  ]);
  const catalog = [
    cacheUtilizationFinding({
      rddId: 1, rddName: 'rdd1', variant: 'partialCache', impactBand: 'warning',
      recommendation: 'RDD rdd1 is 60% evicted from cache (40% of partitions cached), increase executor memory or reduce the cached dataset size.',
    }),
    cacheUtilizationFinding({
      rddId: 1, rddName: 'rdd1', variant: 'diskSpillover', impactBand: 'warning', metric: 'diskRatio', value: 70,
      recommendation: 'RDD rdd1 is 70% spilled to disk despite requesting MEMORY_AND_DISK, executor memory may be too small for this cached dataset.',
    }),
  ];
  store.getState().setWidgetDensity('advanced');
  renderWidget(buildAppModel(rddInfo), catalog);

  expect(screen.getByText(/60% evicted from cache/)).toBeInTheDocument();
  // Exactly two matches: the Advanced-only detail line ("70% spilled to
  // disk: ...") and the recommendation prose itself, proving the
  // recommendation actually renders and not just the detail line.
  expect(screen.getAllByText(/70% spilled to disk/)).toHaveLength(2);
  store.getState().setWidgetDensity('basic');
});

test('a flagged row does not leak another RDD\'s findings (per-row catalog filtering by rddId)', async () => {
  const user = userEvent.setup();
  const rddInfo = new Map([
    [1, rdd(1)], // clean
    [2, rdd(2, { numCachedPartitions: 4 })], // flagged
    [3, rdd(3)], // clean
  ]);
  const catalog = [cacheUtilizationFinding({ rddId: 2, rddName: 'rdd2' })];
  renderWidget(buildAppModel(rddInfo), catalog);

  // Expand the collapsed widget to reach the table rows.
  await user.click(screen.getByRole('button', { name: /cache storage/i }));
  const rows = screen.getAllByRole('row');
  expect(rows).toHaveLength(4); // header + 3 data rows
  const rdd1Row = rows.find((r) => r.textContent?.includes('rdd1'));
  const rdd3Row = rows.find((r) => r.textContent?.includes('rdd3'));
  expect(rdd1Row).not.toHaveTextContent('CSTOR');
  expect(rdd3Row).not.toHaveTextContent('CSTOR');
});

test('renders the ms raw-waste figure when a cacheUtilization finding carries an impactEstimate', async () => {
  const rddInfo = new Map([[1, rdd(1, { numCachedPartitions: 4 })]]);
  const catalog = [cacheUtilizationFinding({
    rddId: 1,
    impactEstimate: { basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured', rawWaste: { value: 1200, unit: 'ms' } },
  })];
  renderWidget(buildAppModel(rddInfo), catalog);

  expect(screen.getByText('1.2s')).toBeInTheDocument();
});

test('passes the worst impact band across all findings to WidgetCard for the header dot', () => {
  const rddInfo = new Map([[1, rdd(1, { numCachedPartitions: 4 })]]);
  const catalog = [cacheUtilizationFinding({ rddId: 1, impactBand: 'warning' })];
  const { container } = renderWidget(buildAppModel(rddInfo), catalog);
  // WidgetCard applies the impact band as a border-color class, not a data-* attribute.
  expect(container.querySelector('.border-warning')).not.toBeNull();
});

test('paginates the RDD table 6-at-a-time with Previous/Next controls', async () => {
  const user = userEvent.setup();
  const rddInfo = new Map(
    Array.from({ length: 7 }, (_, i) => [i + 1, rdd(i + 1, { name: `rdd${i + 1}` })]),
  );
  renderWidget(buildAppModel(rddInfo));

  // Expand the collapsed widget to reach the table rows.
  await user.click(screen.getByRole('button', { name: /cache storage/i }));
  expect(screen.getAllByRole('row')).toHaveLength(1 + 6); // header + 6 data rows
  expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
});

test('paginates the recommendation list 6-at-a-time, independent of the RDD table pagination', async () => {
  const rddInfo = new Map(
    Array.from({ length: 7 }, (_, i) => [i + 1, rdd(i + 1, { name: `rdd${i + 1}`, numCachedPartitions: 4 })]),
  );
  const catalog = Array.from({ length: 7 }, (_, i) =>
    cacheUtilizationFinding({ rddId: i + 1, rddName: `rdd${i + 1}` }),
  );
  renderWidget(buildAppModel(rddInfo), catalog);

  // Recommendations are expanded by default; count them directly (the table
  // itself paginates independently).
  expect(screen.getAllByText(/evicted from cache/)).toHaveLength(6);
});

test('shows each RDD\'s recommendation unconditionally, with no per-row toggle', async () => {
  const user = userEvent.setup();
  const rddInfo = new Map([[1, rdd(1, { numCachedPartitions: 4 })]]);
  const catalog = [cacheUtilizationFinding({
    rddId: 1, rddName: 'rdd1',
    recommendation: 'RDD rdd1 is 60% evicted from cache (40% of partitions cached), increase executor memory or reduce the cached dataset size.',
  })];
  renderWidget(buildAppModel(rddInfo), catalog);

  // Expand the collapsed widget to reach the recommendation rows.
  await user.click(screen.getByRole('button', { name: /cache storage/i }));

  const recommendation = 'RDD rdd1 is 60% evicted from cache (40% of partitions cached), increase executor memory or reduce the cached dataset size.';
  expect(screen.getByText(recommendation)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /hide recommendation for rdd1/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /show recommendation for rdd1/i })).not.toBeInTheDocument();
});

test('the RDD storage table always renders; finding-detail list shows recommendations', () => {
  const rddInfo = new Map([[1, rdd(1)]]);
  const appModel = buildAppModel(rddInfo);

  renderWidget(appModel);
  expect(screen.getByText(/storage level/i)).toBeInTheDocument();
});

test('the total cached-bytes figure stays visible at Basic, even with the RDD table gated', () => {
  const rddInfo = new Map([
    [1, rdd(1, { memorySize: 3e8, diskSize: 0 })],
    [2, rdd(2, { memorySize: 2e8, diskSize: 1e8 })],
  ]);
  renderWidget(buildAppModel(rddInfo));
  expect(screen.getByText('600 MB')).toBeInTheDocument();
  expect(screen.getByText('cached across memory + disk')).toBeInTheDocument();
});

test('renders the storageUnobserved caveat when persisted RDDs have no storage evidence', () => {
  const rddInfo = new Map([[1, rdd(1, { numCachedPartitions: 0, memorySize: 0, diskSize: 0 })]]);
  const caveat = {
    id: 'c1', type: 'cacheUtilization', variant: 'storageUnobserved', stageId: null, impactBand: 'info',
    metric: 'persistedRdds', value: 1, dataUnavailable: true,
    recommendation: '1 persisted RDD has no cache-storage evidence in this log: needs spark.eventLog.logBlockUpdates.enabled=true.',
  } as unknown as Finding;
  renderWidget(buildAppModel(rddInfo), [caveat]);

  expect(screen.getByRole('heading', { name: /cache storage/i })).toBeInTheDocument();
  expect(screen.getByText('Cache storage not logged')).toBeInTheDocument();
  expect(screen.getByText(/spark\.eventLog\.logBlockUpdates\.enabled=true/)).toBeInTheDocument();
  expect(screen.queryByRole('table')).toBeNull();
});
