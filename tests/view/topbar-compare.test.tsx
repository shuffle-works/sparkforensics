// @vitest-environment jsdom
import { test, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Topbar } from '@/view/Topbar';
import { store } from '@/store/store';
import { ThemeProvider } from '@/theme/ThemeProvider';
import type { SerializedRun } from '@sparkforensics/core/run-serialization.ts';

const renderTopbar = () =>
  render(
    <ThemeProvider>
      <Topbar
        onLoadNew={() => {}}
        recentEntries={[]}
        activeFileId={null}
        onPickRecent={() => {}}
        onRemoveRecent={() => {}}
      />
    </ThemeProvider>,
  );

beforeEach(() => {
  store.getState().resetModel();
  store.setState({ sessionCache: new Map(), activeFileId: null });
});

test('no Compare button even with two runs cached', () => {
  store.setState({
    activeFileId: 'a',
    sessionCache: new Map([['a', {} as SerializedRun], ['b', {} as SerializedRun]]),
  });
  renderTopbar();
  expect(screen.queryByRole('button', { name: /^compare$/i })).not.toBeInTheDocument();
});

test('shows Back to comparison only while a comparison is paused', async () => {
  const user = userEvent.setup();
  store.setState({ comparison: { active: false, baselineId: 'a', candidateId: 'b' } });
  renderTopbar();
  const back = screen.getByRole('button', { name: /back to comparison/i });
  await user.click(back);
  expect(store.getState().comparison.active).toBe(true);
});
