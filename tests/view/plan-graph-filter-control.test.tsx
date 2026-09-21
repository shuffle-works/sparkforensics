// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlanGraphFilterControl } from '../../src/view/plan-graph/PlanGraphFilterControl';

describe('PlanGraphFilterControl', () => {
  it('renders the three filter mode options with Basic selected by default', () => {
    render(<PlanGraphFilterControl mode="basic" onChange={vi.fn()} hiddenCount={0} />);
    expect(screen.getByRole('radio', { name: /basic/i })).toBeChecked();
    expect(screen.getByRole('radio', { name: /i\/o only/i })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: /advanced/i })).not.toBeChecked();
  });

  it('calls onChange with the clicked mode', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PlanGraphFilterControl mode="basic" onChange={onChange} hiddenCount={0} />);
    await user.click(screen.getByRole('radio', { name: /i\/o only/i }));
    expect(onChange).toHaveBeenCalledWith('io');
  });

  it('shows a hidden-node-count note only when nodes are hidden', () => {
    const { rerender } = render(<PlanGraphFilterControl mode="basic" onChange={vi.fn()} hiddenCount={0} />);
    expect(screen.queryByText(/hidden/i)).not.toBeInTheDocument();

    rerender(<PlanGraphFilterControl mode="io" onChange={vi.fn()} hiddenCount={5} />);
    expect(screen.getByText('5 nodes hidden')).toBeInTheDocument();
  });

  it('gives each filter option the project’s comfortable coarse-pointer hit area', () => {
    render(<PlanGraphFilterControl mode="basic" onChange={vi.fn()} hiddenCount={0} />);

    for (const radio of screen.getAllByRole('radio')) {
      expect(radio.closest('label')).toHaveClass('min-h-8', 'tap-target-comfortable');
    }
  });

  it('explains what each mode does in a hover tooltip', async () => {
    const user = userEvent.setup();
    render(<PlanGraphFilterControl mode="basic" onChange={vi.fn()} hiddenCount={0} />);

    await user.hover(screen.getByRole('radio', { name: /i\/o only/i }));
    expect(await screen.findByText(/scan and exchange nodes/i)).toBeInTheDocument();

    await user.hover(screen.getByRole('radio', { name: /advanced/i }));
    expect(await screen.findByText(/every operator/i)).toBeInTheDocument();
  });
});
