// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RowStatusCluster } from '../../src/view/RowStatusCluster.tsx';
import { EvidenceAvailabilityContext } from '../../src/view/EvidenceAvailabilityContext.tsx';

describe('RowStatusCluster', () => {
  it('renders nothing when neither confidence nor an evidence key is given', () => {
    const { container } = render(<RowStatusCluster />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a deterministic finding ("high" confidence, no evidence)', () => {
    const { container } = render(<RowStatusCluster confidence="high" validationRequired="n/a" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders confidence-only as plain, non-interactive text with a tooltip', () => {
    render(<RowStatusCluster confidence="low" validationRequired="Inspect the raw metrics before acting." />);
    const caveat = screen.getByText(/low confidence/i);
    expect(caveat).toBeInTheDocument();
    // Copy no longer carries the old ": verify" suffix.
    expect(caveat.textContent).not.toMatch(/verify/i);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(caveat).toHaveAttribute('title', 'Inspect the raw metrics before acting.');
    const describedById = caveat.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    const description = document.getElementById(describedById!);
    expect(description).toHaveTextContent('Inspect the raw metrics before acting.');
    expect(description).toHaveClass('sr-only');
    // Focusable: native `title` never fires on keyboard focus, so this needs
    // its own tab stop for sighted keyboard-only users to reach the caveat.
    expect(caveat).toHaveAttribute('tabindex', '0');
    // No visible tooltip bubble until focused...
    expect(screen.queryByTestId('visible-tooltip')).not.toBeInTheDocument();
    fireEvent.focus(caveat);
    // ...and it appears once focus lands, carrying the same text a mouse
    // user would get from the native `title` attribute.
    expect(screen.getByTestId('visible-tooltip')).toHaveTextContent('Inspect the raw metrics before acting.');
  });

  it('omits aria-describedby/title when confidence is given but there is no validationRequired text to describe', () => {
    // PlanView/CachingOpportunity's callers pass confidence with no
    // validationRequired (the caveat sentence is now a plain paragraph
    // elsewhere): useAccessibleTooltip must not wire aria-describedby up to
    // an empty sr-only span in that case.
    render(<RowStatusCluster confidence="low" />);
    const caveat = screen.getByText(/low confidence/i);
    expect(caveat).not.toHaveAttribute('aria-describedby');
    expect(caveat).not.toHaveAttribute('title');
  });

  it('renders evidence-only as a real button with an "Evidence: <label>" accessible name', async () => {
    const user = userEvent.setup();
    const revealEvidence = vi.fn();
    render(
      <EvidenceAvailabilityContext.Provider
        value={{ referenceOpen: false, setReferenceOpen: vi.fn(), evidenceCardOpen: false, setEvidenceCardOpen: vi.fn(), revealEvidence, registerRow: vi.fn() }}
      >
        <RowStatusCluster evidenceKey="sqlPlan" />
      </EvidenceAvailabilityContext.Provider>,
    );
    const button = screen.getByRole('button', { name: /^evidence: sql plan$/i });
    // Visible text is just the bare label, not the full accessible name.
    expect(button).toHaveTextContent('SQL plan');
    await user.click(button);
    expect(revealEvidence).toHaveBeenCalledWith('sqlPlan');
  });

  it('renders both confidence and evidence together, in one cluster', () => {
    render(<RowStatusCluster confidence="medium" validationRequired="verify me" evidenceKey="executorMetrics" />);
    expect(screen.getByText(/medium confidence/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^evidence: executor metrics$/i })).toBeInTheDocument();
  });

  it('renders the evidence button even without an EvidenceAvailabilityProvider in scope (click is then a safe no-op)', async () => {
    const user = userEvent.setup();
    render(<RowStatusCluster evidenceKey="sqlPlan" />);
    const button = screen.getByRole('button', { name: /^evidence: sql plan$/i });
    expect(button).toBeInTheDocument();
    await user.click(button); // must not throw
  });
});
