// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { test, expect, vi } from 'vitest';
import { ExpandToggleButton } from '@/view/ExpandToggleButton';

// Regression: asserts the `flex w-fit` classes directly (jsdom has no layout);
// dropping either would let the button sit inline instead of on its own line.
test('renders on its own line at intrinsic width (flex w-fit), not inline', () => {
  render(<ExpandToggleButton expanded={false} onClick={() => {}} label="Task detail" location="Stage 1" />);
  const button = screen.getByRole('button', { name: /task detail/i });
  expect(button.className).toMatch(/\bflex\b/);
  expect(button.className).toMatch(/\bw-fit\b/);
});

test('renders the caller-supplied label as its visible text', () => {
  render(<ExpandToggleButton expanded={false} onClick={() => {}} label="Task detail" location="Stage 1" />);
  expect(screen.getByText('Task detail')).toBeInTheDocument();
});

test('label stays fixed on click; aria-expanded and aria-label track expand state', async () => {
  const user = userEvent.setup();
  const onClick = vi.fn();
  const { rerender } = render(<ExpandToggleButton expanded={false} onClick={onClick} label="Task detail" location="Stage 1" />);

  const button = screen.getByRole('button', { name: /show task detail for stage 1/i });
  expect(button).toHaveAttribute('aria-expanded', 'false');
  expect(button).toHaveTextContent('Task detail');

  await user.click(button);
  expect(onClick).toHaveBeenCalledTimes(1);

  rerender(<ExpandToggleButton expanded onClick={onClick} label="Task detail" location="Stage 1" />);
  expect(screen.getByRole('button', { name: /hide task detail for stage 1/i })).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText('Task detail')).toBeInTheDocument();
});

test('shows a chevron icon that is present in both collapsed and expanded state', () => {
  const { container, rerender } = render(<ExpandToggleButton expanded={false} onClick={() => {}} label="Task detail" location="Stage 1" />);
  expect(container.querySelector('svg')).toBeInTheDocument();
  expect(container.querySelector('.lucide-chevron-down')).toBeInTheDocument();
  expect(container.querySelector('.lucide-chevron-up')).not.toBeInTheDocument();

  rerender(<ExpandToggleButton expanded onClick={() => {}} label="Task detail" location="Stage 1" />);
  expect(container.querySelector('svg')).toBeInTheDocument();
  expect(container.querySelector('.lucide-chevron-up')).toBeInTheDocument();
  expect(container.querySelector('.lucide-chevron-down')).not.toBeInTheDocument();
});

test('associates aria-controls with the supplied controlsId', () => {
  render(<ExpandToggleButton expanded={false} onClick={() => {}} label="Task detail" location="Stage 1" controlsId="stage-1-detail" />);
  expect(screen.getByRole('button', { name: /task detail/i })).toHaveAttribute('aria-controls', 'stage-1-detail');
});
