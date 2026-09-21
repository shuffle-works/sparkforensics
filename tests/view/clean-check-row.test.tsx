// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Table, TableBody } from '../../src/components/ui/table';
import { CleanCheckRow } from '../../src/view/widgets/CleanCheckRow';
import { store } from '../../src/store/store';

function renderRow(props: { type: string; label: string; thresholdSummary: string }) {
  return render(
    <Table>
      <TableBody>
        <CleanCheckRow {...props} />
      </TableBody>
    </Table>,
  );
}

describe('CleanCheckRow', () => {
  it('capitalizes the label and threshold summary, both taken lowercase from REGISTRY, at advanced density', () => {
    store.getState().setWidgetDensity('advanced');
    renderRow({ type: 'spill', label: 'spill', thresholdSummary: 'single-task disk spill above 2 GiB' });
    expect(screen.getByText('Spill')).toBeInTheDocument();
    expect(screen.getByText('Single-task disk spill above 2 GiB.')).toBeInTheDocument();
    store.getState().setWidgetDensity('basic');
  });

  it('hides the threshold summary caption at basic density', () => {
    renderRow({ type: 'spill', label: 'spill', thresholdSummary: 'single-task disk spill above 2 GiB' });
    expect(screen.getByText('Spill')).toBeInTheDocument();
    expect(screen.queryByText(/single-task disk spill above 2 GiB/i)).not.toBeInTheDocument();
  });

  it("renders the type's tag vocabulary as a clean-colored pill", () => {
    renderRow({ type: 'spill', label: 'spill', thresholdSummary: 'single-task disk spill above 2 GiB' });
    expect(screen.getByText('SPILL')).toBeInTheDocument();
  });
});
