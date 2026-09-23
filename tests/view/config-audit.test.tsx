// @vitest-environment jsdom
import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { emptyAppModel, store } from '@/store/store';
import { DocsProvider } from '@/view/DocsContext';
import { EvidenceAvailabilityProvider } from '@/view/EvidenceAvailabilityContext';
import { ConfigAudit } from '@/view/widgets/ConfigAudit';
import type { AppModel } from '@sparkforensics/core/types.ts';

function buildAppModel(app: AppModel['app'], ledger?: AppModel['evidenceAvailability']): AppModel {
  return { ...emptyAppModel(), app, evidenceAvailability: ledger ?? null };
}

function renderWidget(app: AppModel['app'], ledger?: AppModel['evidenceAvailability']) {
  return render(
    <DocsProvider>
      <EvidenceAvailabilityProvider>
        <ConfigAudit
          appModel={buildAppModel(app, ledger)}
          catalog={[]}
          getTaskData={async () => ({ metrics: [], fieldNames: [] })}
        />
      </EvidenceAvailabilityProvider>
    </DocsProvider>,
  );
}

test('renders the WidgetCard heading and every triggered config warning, not just one', async () => {
  // Two triggered findings: shuffle-service-off (warning) and missing-serializer
  // (info); maxExecutors is pinned so that detector stays quiet, keeping the fixture at 2.
  const user = userEvent.setup();
  store.getState().setWidgetDensity('advanced');
  renderWidget({
    config: { 'spark.dynamicAllocation.maxExecutors': '10' },
    resources: { dynamicAllocationEnabled: true, shuffleServiceEnabled: false },
  });

  expect(screen.getByRole('heading', { name: /config sanity/i })).toBeInTheDocument();

  // Expand the card to see the findings
  const collapseButton = screen.getByRole('button', { name: /config sanity/i });
  await user.click(collapseButton);

  expect(screen.getByText('spark.shuffle.service.enabled')).toBeInTheDocument();
  expect(screen.getByText('spark.serializer')).toBeInTheDocument();
  // CFG tag and the evidence marker each appear once on the header badge;
  // per-row findings get their own impact dot instead.
  expect(screen.getAllByText('CFG')).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: /^evidence: spark configuration$/i })).toHaveLength(1);
  store.getState().setWidgetDensity('basic');
});

test('shows a muted clean state when config was captured but nothing is misconfigured', () => {
  // Kryo configured (avoids the serializer finding); allocation/overhead checks short-circuit with no resources.
  const model = buildAppModel({
    config: { 'spark.serializer': 'org.apache.spark.serializer.KryoSerializer' },
    resources: {},
  });

  renderWidget(model.app);

  expect(screen.getByRole('heading', { name: /config sanity/i })).toBeInTheDocument();
  expect(screen.getByText(/no misconfigurations detected/i)).toBeInTheDocument();
  expect(screen.queryByText('CFG')).not.toBeInTheDocument();
});

test('shows a muted no-data state when the ledger says sparkConfiguration was not emitted', () => {
  const ledger: AppModel['evidenceAvailability'] = {
    schemaVersion: 1,
    entries: [{
      key: 'sparkConfiguration',
      state: 'notEmitted',
      reasonCode: 'noEnvironmentUpdate',
      summary: 'Not emitted by this event log.',
    }],
  };
  const model = buildAppModel({
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
  }, ledger);

  // The evidence marker is gated behind Advanced density like every other
  // widget's RowStatusCluster, so it's absent here at the default 'basic'.
  const first = renderWidget(model.app, ledger);
  expect(screen.getByText(/no environment info captured/i)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /evidence: spark configuration/i })).not.toBeInTheDocument();
  expect(screen.queryByText(/no misconfigurations detected/i)).not.toBeInTheDocument();
  first.unmount();

  store.getState().setWidgetDensity('advanced');
  renderWidget(model.app, ledger);
  expect(screen.getByRole('button', { name: /evidence: spark configuration/i })).toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});

test('shows the parse-incomplete summary when the ledger cannot trust an incomplete parse', () => {
  const ledger: AppModel['evidenceAvailability'] = {
    schemaVersion: 1,
    entries: [{
      key: 'sparkConfiguration',
      state: 'unknown',
      reasonCode: 'parseIncomplete',
      summary: 'Cannot determine from an incomplete parse.',
    }],
  };
  const model = buildAppModel({
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
  }, ledger);

  // Same Advanced-density gate applies to the parse-incomplete branch.
  const first = renderWidget(model.app, ledger);
  expect(screen.getByText(/cannot determine from an incomplete parse/i)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /evidence: spark configuration/i })).not.toBeInTheDocument();
  expect(screen.queryByText(/no environment info captured/i)).not.toBeInTheDocument();
  first.unmount();

  store.getState().setWidgetDensity('advanced');
  renderWidget(model.app, ledger);
  expect(screen.getByRole('button', { name: /evidence: spark configuration/i })).toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});

test('renders a doc link naming the property it explains, for every triggered property', async () => {
  // Same fixture as the first test: shuffle-service-off (warning) and
  // missing-serializer (info), each carrying its own docAnchor. The
  // recommendation (and its doc link) sit behind a per-row toggle that
  // defaults to expanded, so both are visible without any click.
  const user = userEvent.setup();
  renderWidget({
    config: { 'spark.dynamicAllocation.maxExecutors': '10' },
    resources: { dynamicAllocationEnabled: true, shuffleServiceEnabled: false },
  });

  // Expand the card to see the findings
  const collapseButton = screen.getByRole('button', { name: /config sanity/i });
  await user.click(collapseButton);

  const links = screen.getAllByRole('link', { name: /^why .* matters$/i });
  expect(links).toHaveLength(2);
  expect(links.map((l) => l.textContent)).toEqual(
    expect.arrayContaining([expect.stringContaining('spark.shuffle.service.enabled'), expect.stringContaining('spark.serializer')]),
  );
  expect(links.map((l) => l.getAttribute('href'))).toEqual(
    expect.arrayContaining([expect.stringContaining('#config-shuffle-service'), expect.stringContaining('#config-serializer')]),
  );
  // Recommendation text is visible by default, with no click needed.
  expect(screen.getByText(/external shuffle service is off/i)).toBeInTheDocument();
});

test('the recommendation is always visible per row, with no toggle to hide it', async () => {
  const user = userEvent.setup();
  renderWidget({
    config: { 'spark.dynamicAllocation.maxExecutors': '10' },
    resources: { dynamicAllocationEnabled: true, shuffleServiceEnabled: false },
  });

  // Expand the card to see the findings
  const collapseButton = screen.getByRole('button', { name: /config sanity/i });
  await user.click(collapseButton);

  const recommendation = /external shuffle service is off/i;
  expect(screen.getByText(recommendation)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /why spark\.shuffle\.service\.enabled matters/i })).toBeInTheDocument();

  // The per-row expand/collapse toggle was removed; there's nothing left to hide the recommendation.
  expect(screen.queryByRole('button', { name: /recommendation for spark\.shuffle\.service\.enabled/i })).not.toBeInTheDocument();
});

test('renders no impact-estimate element for its informational-only findings', async () => {
  renderWidget({
    config: { 'spark.dynamicAllocation.maxExecutors': '10' },
    resources: { dynamicAllocationEnabled: true, shuffleServiceEnabled: false },
  });

  expect(screen.queryByText(/Est\./)).not.toBeInTheDocument();
  expect(document.querySelector('.impact-estimate')).not.toBeInTheDocument();
});

test('does not leak domain-specific copy', () => {
  renderWidget({
    config: { 'spark.dynamicAllocation.maxExecutors': '10' },
    resources: { dynamicAllocationEnabled: true, shuffleServiceEnabled: false },
  });

  const text = document.body.textContent ?? '';
  expect(text).not.toMatch(/scanntech|retail|cpg/i);
});

test('card defaults collapsed with summary; the current-value chip renders unconditionally', () => {
  // Two findings: shuffle-service-off (warning) and missing-serializer (info)
  renderWidget({
    config: { 'spark.dynamicAllocation.maxExecutors': '10' },
    resources: { dynamicAllocationEnabled: true, shuffleServiceEnabled: false },
  });

  // Card should default collapsed with summary showing count
  expect(screen.getByText('2')).toBeInTheDocument();
  expect(screen.getByText('misconfigurations flagged')).toBeInTheDocument();

  // The current-value chip next to the property name is visible unconditionally.
  expect(screen.getByText('spark.shuffle.service.enabled')).toBeInTheDocument();
  expect(screen.getByText('false')).toBeInTheDocument();
});

test('the evidence marker stays out of the summary view until the card is expanded', async () => {
  const user = userEvent.setup();
  store.getState().setWidgetDensity('advanced');
  renderWidget({
    config: { 'spark.dynamicAllocation.maxExecutors': '10' },
    resources: { dynamicAllocationEnabled: true, shuffleServiceEnabled: false },
  });

  expect(screen.queryByRole('button', { name: /evidence:/i })).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /config sanity/i }));
  expect(screen.getByRole('button', { name: /evidence: spark configuration/i })).toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});

test('the header CFG pill links to the sub-check section when every finding shares one', () => {
  // Kryo set, so only the shuffle-service check fires.
  renderWidget({
    config: { 'spark.dynamicAllocation.maxExecutors': '10', 'spark.serializer': 'org.apache.spark.serializer.KryoSerializer' },
    resources: { dynamicAllocationEnabled: true, shuffleServiceEnabled: false },
  });
  expect(screen.getByRole('link', { name: 'CFG' })).toHaveAttribute('href', 'docs/tuning-reference/config.html#config-shuffle-service');
});

test('the header CFG pill falls back to the guide entry when findings span several sub-checks', () => {
  renderWidget({
    config: { 'spark.dynamicAllocation.maxExecutors': '10' },
    resources: { dynamicAllocationEnabled: true, shuffleServiceEnabled: false },
  });
  expect(screen.getByRole('link', { name: 'CFG' })).toHaveAttribute('href', 'docs/user-guide/understanding-findings.html#cfg');
});
