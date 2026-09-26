// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, renderHook } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from '@testing-library/react';

const openStage = vi.fn();
vi.mock('@/view/StageDetailContext', () => ({
  useStageDetail: () => ({ stageId: null, openStage, close: vi.fn() }),
}));

import { StagePill, StagePillGroup, useRevealMore } from '@/view/StagePill';

describe('StagePill', () => {
  it('calls openStage with the stage id on click', async () => {
    const user = userEvent.setup();
    render(<StagePill stageId={7} />);

    await user.click(screen.getByRole('button', { name: /open details for stage 7/i }));

    expect(openStage).toHaveBeenCalledWith(7);
  });

  it('spells out "Stage 7" and keeps that visible text inside its accessible name', () => {
    render(<StagePill stageId={7} />);
    const pill = screen.getByRole('button', { name: /open details for stage 7/i });
    expect(pill).toHaveTextContent('Stage 7');
    expect(pill.getAttribute('aria-label')).toContain(pill.textContent ?? '');
  });
});

describe('StagePillGroup', () => {
  const pills = Array.from({ length: 40 }, (_, i) => ({ id: i }));

  it('shows only the visible limit of pills plus an overflow button', () => {
    render(<StagePillGroup pills={pills} />);

    const stageButtons = screen.getAllByRole('button', { name: /^open details for stage \d+$/i });
    expect(stageButtons).toHaveLength(6);
    expect(screen.getByRole('button', { name: /show 34 more stages/i })).toBeInTheDocument();
  });

  it('collapses repeated stage ids to a single pill', () => {
    render(<StagePillGroup pills={[{ id: 5 }, { id: 5 }, { id: 7 }, { id: 5 }]} />);
    expect(screen.getAllByRole('button', { name: /open details for stage 5$/i })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /open details for stage 7$/i })).toHaveLength(1);
  });

  it('reveals 30 more pills per overflow click', async () => {
    const user = userEvent.setup();
    render(<StagePillGroup pills={pills} />);

    await user.click(screen.getByRole('button', { name: /show 34 more stages/i }));

    expect(screen.getAllByRole('button', { name: /^open details for stage \d+$/i })).toHaveLength(36);
    expect(screen.getByRole('button', { name: /show 4 more stages/i })).toBeInTheDocument();
  });

  it('keeps revealed pills visible when an equivalent pills array is recreated', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<StagePillGroup pills={[...pills]} />);

    await user.click(screen.getByRole('button', { name: /show 34 more stages/i }));
    expect(screen.getAllByRole('button', { name: /^open details for stage \d+$/i })).toHaveLength(36);

    rerender(<StagePillGroup pills={[...pills]} />);

    expect(screen.getAllByRole('button', { name: /^open details for stage \d+$/i })).toHaveLength(36);
    expect(screen.getByRole('button', { name: /show 4 more stages/i })).toBeInTheDocument();
  });
});

describe('useRevealMore', () => {
  it('shows only the first `limit` items initially', () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const { result } = renderHook(() => useRevealMore(items, { limit: 4, chunk: 3 }));

    expect(result.current.visible).toEqual([0, 1, 2, 3]);
    expect(result.current.remaining).toBe(6);
  });

  it('reveals up to `chunk` more items per revealMore() call', () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const { result } = renderHook(() => useRevealMore(items, { limit: 4, chunk: 3 }));

    act(() => result.current.revealMore());

    expect(result.current.visible).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(result.current.remaining).toBe(3);
  });

  it('stops correctly at the list end instead of over-revealing', () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const { result } = renderHook(() => useRevealMore(items, { limit: 4, chunk: 3 }));

    act(() => result.current.revealMore());
    act(() => result.current.revealMore());

    expect(result.current.visible).toEqual(items);
    expect(result.current.remaining).toBe(0);
  });

  it('defaults limit/chunk to VISIBLE_LIMIT/OVERFLOW_REVEAL_CHUNK when omitted', () => {
    const items = Array.from({ length: 40 }, (_, i) => i);
    const { result } = renderHook(() => useRevealMore(items));

    expect(result.current.visible).toHaveLength(6);
    expect(result.current.remaining).toBe(34);
  });

  it('resets the revealed window across an A -> B -> same-A dataset round trip', () => {
    const firstItems = Array.from({ length: 40 }, (_, i) => i);
    const secondItems = Array.from({ length: 40 }, (_, i) => i + 100);
    const { result, rerender } = renderHook(
      ({ items, dataset }) => useRevealMore(items, { limit: 4, chunk: 3, dataset }),
      { initialProps: { items: firstItems, dataset: firstItems } },
    );

    act(() => result.current.revealMore());
    expect(result.current.visible).toHaveLength(7);

    rerender({ items: secondItems, dataset: secondItems });

    expect(result.current.visible).toEqual([100, 101, 102, 103]);
    expect(result.current.remaining).toBe(36);

    rerender({ items: firstItems, dataset: firstItems });

    expect(result.current.visible).toEqual([0, 1, 2, 3]);
    expect(result.current.remaining).toBe(36);
  });

  describe('revealThrough', () => {
    it('reveals just enough extra items that the given index becomes visible', () => {
      const items = Array.from({ length: 10 }, (_, i) => i);
      const { result } = renderHook(() => useRevealMore(items, { limit: 4, chunk: 3 }));

      act(() => result.current.revealThrough(6));

      // limit(4) + revealed must cover index 6, i.e. shownCount >= 7.
      expect(result.current.visible).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(result.current.remaining).toBe(3);
    });

    it('is a no-op (same visible/remaining) when the index is already visible', () => {
      const items = Array.from({ length: 10 }, (_, i) => i);
      const { result } = renderHook(() => useRevealMore(items, { limit: 4, chunk: 3 }));
      const visibleBefore = result.current.visible;
      const remainingBefore = result.current.remaining;

      act(() => result.current.revealThrough(2));

      expect(result.current.visible).toBe(visibleBefore);
      expect(result.current.remaining).toBe(remainingBefore);
    });

    it('does not reduce an already-larger reveal window', () => {
      const items = Array.from({ length: 10 }, (_, i) => i);
      const { result } = renderHook(() => useRevealMore(items, { limit: 4, chunk: 3 }));

      act(() => result.current.revealMore());
      expect(result.current.visible).toEqual([0, 1, 2, 3, 4, 5, 6]);

      // Index 4 is already visible from the earlier revealMore(); revealing
      // through it must not shrink the window back down.
      act(() => result.current.revealThrough(4));

      expect(result.current.visible).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(result.current.remaining).toBe(3);
    });
  });
});
