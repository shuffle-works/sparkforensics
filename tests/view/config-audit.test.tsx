// @vitest-environment jsdom
import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { emptyAppModel, store } from '@/store/store';
import { DocsProvider } from '@/view/DocsContext';
import { ConfigAudit } from '@/view/widgets/ConfigAudit';
import { auditConfig } from '@sparkforensics/core/analysis';
import type { AppModel } from '@sparkforensics/core/types';
import { testApp, testStage } from './_shared/model';

// One stage outside any SQL execution, so the serializer check applies.
const RDD_STAGES = new Map([[1, testStage({ id: 1 })]]);

function buildAppModel(app: AppModel['app'], ledger?: AppModel['evidenceAvailability']): AppModel {
  return { ...emptyAppModel(), app, evidenceAvailability: ledger ?? null };
}

function renderWidget(app: AppModel['app'], ledger?: AppModel['evidenceAvailability']) {
  return render(
    <DocsProvider>
      <ConfigAudit
        appModel={buildAppModel(app, ledger)}
        catalog={[]}
        configFindings={auditConfig(app, RDD_STAGES)}
        getTaskData={async () => ({ metrics: [], fieldNames: [] })}
      />
    </DocsProvider>,
  );
}

test('renders the WidgetCard heading and every triggered config warning, not just one', async () => {
  // Two triggered findings: unbounded maxExecutors and missing-serializer (both info).
  const user = userEvent.setup();
  store.getState().setWidgetDensity('advanced');
  renderWidget(testApp({
    config: { 'spark.app.name': 'demo' },
    resources: { dynamicAllocationEnabled: true },
  }));

  expect(screen.getByRole('heading', { name: /config audit/i })).toBeInTheDocument();

  // Expand the card to see the findings
  const collapseButton = screen.getByRole('button', { name: /config audit/i });
  await user.click(collapseButton);

  expect(screen.getByText('spark.dynamicAllocation.maxExecutors')).toBeInTheDocument();
  expect(screen.getByText('spark.serializer')).toBeInTheDocument();
  // CFG tag and the evidence marker each appear once on the header badge;
  // per-row findings get their own impact dot instead.
  expect(screen.getAllByText('CFG')).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: /^evidence: spark configuration$/i })).toHaveLength(1);
  store.getState().setWidgetDensity('basic');
});

test('renders nothing when config was captured but nothing is misconfigured', () => {
  // Kryo configured (avoids the serializer finding); allocation/overhead checks short-circuit with no resources.
  const model = buildAppModel(testApp({
    config: { 'spark.serializer': 'org.apache.spark.serializer.KryoSerializer' },
    resources: {},
  }));

  const { container } = renderWidget(model.app);

  expect(container).toBeEmptyDOMElement();
});

test('renders nothing when the ledger says sparkConfiguration was not emitted', () => {
  const ledger: AppModel['evidenceAvailability'] = {
    schemaVersion: 1,
    entries: [{
      key: 'sparkConfiguration',
      state: 'notEmitted',
      reasonCode: 'noEnvironmentUpdate',
      summary: 'Not emitted by this event log.',
    }],
  };
  const model = buildAppModel(testApp({
    config: { 'spark.serializer': 'org.apache.spark.serializer.KryoSerializer' },
    resources: {},
    evidenceInputs: {
      environmentUpdates: 0,
      applicationEnds: 1,
      stageSubmissions: 0,
      rddStorageSnapshots: 0,
      sqlExecutions: 0,
      resolvedSqlPlans: 0,
      executorMetricRows: 0,
      taskRecords: 0,
    },
  }), ledger);

  const basic = renderWidget(model.app, ledger);
  expect(basic.container).toBeEmptyDOMElement();
  basic.unmount();

  store.getState().setWidgetDensity('advanced');
  const advanced = renderWidget(model.app, ledger);
  expect(advanced.container).toBeEmptyDOMElement();
  store.getState().setWidgetDensity('basic');
});

test('renders nothing when the ledger cannot trust an incomplete parse', () => {
  const ledger: AppModel['evidenceAvailability'] = {
    schemaVersion: 1,
    entries: [{
      key: 'sparkConfiguration',
      state: 'unknown',
      reasonCode: 'parseIncomplete',
      summary: 'Cannot determine from an incomplete parse.',
    }],
  };
  const model = buildAppModel(testApp({
    config: { 'spark.serializer': 'org.apache.spark.serializer.KryoSerializer' },
    resources: {},
    evidenceInputs: {
      environmentUpdates: 0,
      applicationEnds: 0,
      stageSubmissions: 0,
      rddStorageSnapshots: 0,
      sqlExecutions: 0,
      resolvedSqlPlans: 0,
      executorMetricRows: 0,
      taskRecords: 0,
    },
  }), ledger);

  const basic = renderWidget(model.app, ledger);
  expect(basic.container).toBeEmptyDOMElement();
  basic.unmount();

  store.getState().setWidgetDensity('advanced');
  const advanced = renderWidget(model.app, ledger);
  expect(advanced.container).toBeEmptyDOMElement();
  store.getState().setWidgetDensity('basic');
});

test('renders a doc link naming the property it explains, for every triggered property', async () => {
  // Same fixture as the first test: unbounded maxExecutors and
  // missing-serializer (both info), each carrying its own docAnchor. The
  // recommendation (and its doc link) sit behind a per-row toggle that
  // defaults to expanded, so both are visible without any click.
  const user = userEvent.setup();
  renderWidget(testApp({
    config: { 'spark.app.name': 'demo' },
    resources: { dynamicAllocationEnabled: true },
  }));

  // Expand the card to see the findings
  const collapseButton = screen.getByRole('button', { name: /config audit/i });
  await user.click(collapseButton);

  const links = screen.getAllByRole('link', { name: /^why .* matters$/i });
  expect(links).toHaveLength(2);
  expect(links.map((l) => l.textContent)).toEqual(
    expect.arrayContaining([expect.stringContaining('spark.dynamicAllocation.maxExecutors'), expect.stringContaining('spark.serializer')]),
  );
  expect(links.map((l) => l.getAttribute('href'))).toEqual(
    expect.arrayContaining([expect.stringContaining('#config-autoscale-bounds'), expect.stringContaining('#config-serializer')]),
  );
  // Recommendation text is visible by default, with no click needed.
  expect(screen.getByText(/no upper bound/i)).toBeInTheDocument();
});

test('each row shows what it measured and the card states its fix once, with no toggle', async () => {
  const user = userEvent.setup();
  renderWidget(testApp({
    config: { 'spark.app.name': 'demo' },
    resources: { dynamicAllocationEnabled: true },
  }));

  // Expand the card to see the findings
  const collapseButton = screen.getByRole('button', { name: /config audit/i });
  await user.click(collapseButton);

  expect(screen.getByText(/no upper bound/i)).toBeInTheDocument();
  expect(screen.getByText('Set spark.dynamicAllocation.maxExecutors to cap cluster growth.')).toBeInTheDocument();
  expect(screen.getAllByText(/spark\.dynamicAllocation\.maxExecutors to cap/)).toHaveLength(1);
  expect(screen.getByRole('link', { name: /why spark\.dynamicAllocation\.maxExecutors matters/i })).toBeInTheDocument();

  // No per-row expand/collapse toggle.
  expect(screen.queryByRole('button', { name: /recommendation for spark\.dynamicAllocation\.maxExecutors/i })).not.toBeInTheDocument();
});

test('renders no impact-estimate element for its informational-only findings', async () => {
  renderWidget(testApp({
    config: { 'spark.app.name': 'demo' },
    resources: { dynamicAllocationEnabled: true },
  }));

  expect(screen.queryByText(/Est\./)).not.toBeInTheDocument();
  expect(document.querySelector('.impact-estimate')).not.toBeInTheDocument();
});

test('does not leak domain-specific copy', () => {
  renderWidget(testApp({
    config: { 'spark.app.name': 'demo' },
    resources: { dynamicAllocationEnabled: true },
  }));

  const text = document.body.textContent ?? '';
  expect(text).not.toMatch(/scanntech|retail|cpg/i);
});

test('card defaults collapsed with summary; the current-value chip renders unconditionally', () => {
  // Two findings: unbounded maxExecutors and missing-serializer (both info)
  renderWidget(testApp({
    config: { 'spark.app.name': 'demo' },
    resources: { dynamicAllocationEnabled: true },
  }));

  // Card should default collapsed with summary showing count
  expect(screen.getByText('2')).toBeInTheDocument();
  expect(screen.getByText('misconfigurations flagged')).toBeInTheDocument();

  // The current-value chip next to the property name is visible unconditionally.
  expect(screen.getByText('spark.dynamicAllocation.maxExecutors')).toBeInTheDocument();
  expect(screen.getByText('(unset)')).toBeInTheDocument();
});

test('the evidence marker stays out of the summary view until the card is expanded', async () => {
  const user = userEvent.setup();
  store.getState().setWidgetDensity('advanced');
  renderWidget(testApp({
    config: { 'spark.app.name': 'demo' },
    resources: { dynamicAllocationEnabled: true },
  }));

  expect(screen.queryByRole('button', { name: /evidence:/i })).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /config audit/i }));
  expect(screen.getByRole('button', { name: /evidence: spark configuration/i })).toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});

test('the header CFG pill links to the sub-check section when every finding shares one', () => {
  // Kryo set, so only the unbounded-maxExecutors check fires.
  renderWidget(testApp({
    config: { 'spark.serializer': 'org.apache.spark.serializer.KryoSerializer' },
    resources: { dynamicAllocationEnabled: true },
  }));
  expect(screen.getByRole('link', { name: 'CFG' })).toHaveAttribute('href', 'docs/tuning-reference/config.html#config-autoscale-bounds');
});

test('the header CFG pill falls back to the guide entry when findings span several sub-checks', () => {
  renderWidget(testApp({
    config: { 'spark.app.name': 'demo' },
    resources: { dynamicAllocationEnabled: true },
  }));
  expect(screen.getByRole('link', { name: 'CFG' })).toHaveAttribute('href', 'docs/user-guide/understanding-findings.html#cfg');
});
