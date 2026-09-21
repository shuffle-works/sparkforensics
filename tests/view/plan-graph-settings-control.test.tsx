// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlanGraphSettingsControl } from '../../src/view/plan-graph/PlanGraphSettingsControl';

function renderControl(overrides: Partial<Parameters<typeof PlanGraphSettingsControl>[0]> = {}) {
  const onFilterModeChange = vi.fn();
  const onDurationModeChange = vi.fn();
  render(
    <PlanGraphSettingsControl
      filterMode="basic"
      onFilterModeChange={onFilterModeChange}
      hiddenCount={0}
      durationMode="exclusive"
      onDurationModeChange={onDurationModeChange}
      {...overrides}
    />,
  );
  return { onFilterModeChange, onDurationModeChange };
}

describe('PlanGraphSettingsControl', () => {
  it('keeps both controls out of the topbar row until the settings trigger is opened', () => {
    renderControl();
    expect(screen.queryByRole('radio', { name: /basic/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /node only/i })).not.toBeInTheDocument();
  });

  it('opens a panel exposing both the node filter and the duration attribution controls', async () => {
    const user = userEvent.setup();
    renderControl();
    await user.click(screen.getByRole('button', { name: /settings/i }));

    const panel = await screen.findByRole('dialog', { name: /plan graph settings/i });
    expect(within(panel).getByRole('radio', { name: /basic/i })).toBeChecked();
    expect(within(panel).getByRole('radio', { name: /node only/i })).toBeChecked();
  });

  it('reports the hidden-node count inside the panel', async () => {
    const user = userEvent.setup();
    renderControl({ hiddenCount: 5 });
    await user.click(screen.getByRole('button', { name: /settings/i }));
    expect(await screen.findByText('5 nodes hidden')).toBeInTheDocument();
  });

  it('keeps the panel open across both controls, so changing the filter does not close it before the duration toggle is reachable', async () => {
    const user = userEvent.setup();
    const { onFilterModeChange, onDurationModeChange } = renderControl();
    await user.click(screen.getByRole('button', { name: /settings/i }));

    await user.click(await screen.findByRole('radio', { name: /i\/o only/i }));
    expect(onFilterModeChange).toHaveBeenCalledWith('io');

    await user.click(screen.getByRole('radio', { name: /node \+ descendants/i }));
    expect(onDurationModeChange).toHaveBeenCalledWith('inclusive');
  });
});
