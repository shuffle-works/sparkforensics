// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const resetToDropZone = vi.fn();
vi.mock('@/store/useIngest', () => ({ useIngest: () => ({ resetToDropZone }) }));

import { store } from '@/store/store';
import { DocsProvider } from '@/view/DocsContext';
import { SAMPLE_RUN_ID } from '@/view/sample-run';
import { SampleRunNotice } from '@/view/SampleRunNotice';

function renderNotice() {
  render(
    <DocsProvider>
      <SampleRunNotice />
    </DocsProvider>,
  );
}

afterEach(() => {
  resetToDropZone.mockClear();
  store.setState({ activeFileId: null, exportMode: false });
});

describe('SampleRunNotice', () => {
  it('says the open run is the sample and offers a way to the reader\'s own log', async () => {
    const user = userEvent.setup();
    store.setState({ activeFileId: SAMPLE_RUN_ID });
    renderNotice();

    expect(screen.getByTestId('sample-run-notice')).toHaveTextContent('This is the sample run');
    expect(screen.getByRole('link', { name: 'Where do I find my log?' })).toHaveAttribute('href', 'docs/user-guide/alternative-log-retrieval.html');
    await user.click(screen.getByRole('button', { name: /load my event log/i }));
    expect(resetToDropZone).toHaveBeenCalledOnce();
  });

  it('stays out of the way for any other run and in the export bundle', () => {
    store.setState({ activeFileId: 'my-run.log::1::2' });
    renderNotice();
    expect(screen.queryByTestId('sample-run-notice')).not.toBeInTheDocument();

    store.setState({ activeFileId: SAMPLE_RUN_ID, exportMode: true });
    renderNotice();
    expect(screen.queryByTestId('sample-run-notice')).not.toBeInTheDocument();
  });
});
