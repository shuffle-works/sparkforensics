// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlanGraphDurationModeControl } from '../../src/view/plan-graph/PlanGraphDurationModeControl';

describe('PlanGraphDurationModeControl', () => {
  it('renders two radio options and marks the active mode checked', () => {
    render(<PlanGraphDurationModeControl mode="exclusive" onChange={() => {}} />);
    expect(screen.getByRole('radio', { name: /node only/i })).toBeChecked();
    expect(screen.getByRole('radio', { name: /node \+ descendants/i })).not.toBeChecked();
  });

  it('calls onChange with the other mode when clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PlanGraphDurationModeControl mode="exclusive" onChange={onChange} />);
    await user.click(screen.getByRole('radio', { name: /node \+ descendants/i }));
    expect(onChange).toHaveBeenCalledWith('inclusive');
  });

  it('uses the same tap-target classes as the category filter control', () => {
    render(<PlanGraphDurationModeControl mode="exclusive" onChange={() => {}} />);
    const label = screen.getByRole('radio', { name: /node only/i }).closest('label');
    expect(label).toHaveClass('min-h-8', 'tap-target-comfortable');
  });

  it('explains what each mode does in a hover tooltip', async () => {
    const user = userEvent.setup();
    render(<PlanGraphDurationModeControl mode="exclusive" onChange={() => {}} />);

    await user.hover(screen.getByRole('radio', { name: /node only/i }));
    expect(await screen.findByText(/excluding its descendants/i)).toBeInTheDocument();

    await user.hover(screen.getByRole('radio', { name: /node \+ descendants/i }));
    expect(await screen.findByText(/adds in every descendant/i)).toBeInTheDocument();
  });
});
