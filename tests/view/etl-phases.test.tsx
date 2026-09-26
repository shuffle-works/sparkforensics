// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

import { EtlPhases } from '../../src/view/widgets/EtlPhases';
import { store } from '../../src/store/store';
import type { AppModel, Stage } from '@sparkforensics/core/types.ts';

function makeAppModel(stages: [number, Partial<Stage>][]): AppModel {
  return {
    app: null,
    stages: new Map(stages.map(([id, s]) => [id, { stageId: id, ...s } as Stage])),
    executors: { added: [], removed: [] },
    sql: new Map(),
    jobs: new Map(),
    runAggregates: null,
    evidenceAvailability: null,
  };
}

describe('EtlPhases', () => {
  it('renders nothing when all phases are zero', () => {
    const { container } = render(<EtlPhases appModel={makeAppModel([])} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the widget heading and all three phase labels with an overlap note', () => {
    const appModel = makeAppModel([
      [0, { submittedAt: 0, completedAt: 300, shuffleWriteBytes: 10, outputBytes: 20, inputBytes: 0, shuffleReadBytes: 0 }],
    ]);

    store.getState().setWidgetDensity('advanced');
    render(<EtlPhases appModel={appModel} />);

    expect(screen.getByRole('heading', { name: /ETL Phase Attribution/i })).toBeInTheDocument();
    expect(screen.getByText(/^Extract$/)).toBeInTheDocument();
    expect(screen.getByText(/^Transform$/)).toBeInTheDocument();
    expect(screen.getByText(/^Load$/)).toBeInTheDocument();
    expect(screen.getByText(/overlap/i)).toBeInTheDocument();
    store.getState().setWidgetDensity('basic');
  });

  it('the heuristic caption is Advanced-only', () => {
    const appModel = makeAppModel([
      [0, { submittedAt: 0, completedAt: 300, shuffleWriteBytes: 10, outputBytes: 20, inputBytes: 0, shuffleReadBytes: 0 }],
    ]);

    store.getState().setWidgetDensity('basic');
    render(<EtlPhases appModel={appModel} />);
    expect(screen.queryByText(/heuristic:/i)).not.toBeInTheDocument();

    cleanup();

    store.getState().setWidgetDensity('advanced');
    render(<EtlPhases appModel={appModel} />);
    expect(screen.getByText(/heuristic:/i)).toBeInTheDocument();
    store.getState().setWidgetDensity('basic');
  });

  it('card defaults collapsed with a dominant-phase summary', () => {
    const appModel = makeAppModel([
      [0, { submittedAt: 0, completedAt: 300, shuffleWriteBytes: 10, outputBytes: 20, inputBytes: 0, shuffleReadBytes: 0 }],
    ]);

    render(<EtlPhases appModel={appModel} />);

    // Verify the card starts collapsed (chevron points down, not up)
    const trigger = screen.getByRole('button', { name: /ETL Phase Attribution/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    // Verify the summary shows the dominant phase and context (Transform has max duration)
    expect(screen.getByText(/^largest phase$/i)).toBeInTheDocument();
    expect(screen.getByText(/Transform 300ms/)).toBeInTheDocument();
  });
});
