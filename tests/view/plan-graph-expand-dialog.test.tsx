// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExpandConfirmDialog } from '../../src/view/plan-graph/ExpandConfirmDialog';

describe('ExpandConfirmDialog', () => {
  it('states the node count and warns layout may take several seconds', () => {
    render(<ExpandConfirmDialog open nodeCount={914} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/914/)).toBeInTheDocument();
    expect(screen.getByText(/several seconds/i)).toBeInTheDocument();
  });

  it('calls onConfirm when the user proceeds', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ExpandConfirmDialog open nodeCount={914} onConfirm={onConfirm} onCancel={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /expand anyway|proceed|continue/i }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it('renders nothing when closed', () => {
    render(<ExpandConfirmDialog open={false} nodeCount={914} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByText(/several seconds/i)).not.toBeInTheDocument();
  });
});
