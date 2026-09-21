// @vitest-environment jsdom
import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { store } from '../../src/store/store';
import { WidgetDensityControl } from '../../src/view/WidgetDensityControl';

test('reflects the current tier via aria-pressed', () => {
  store.getState().setWidgetDensity('basic');
  render(<WidgetDensityControl />);
  expect(screen.getByRole('button', { name: 'Advanced view' })).toHaveAttribute('aria-pressed', 'false');
});

test('clicking the toggle flips the tier', async () => {
  store.getState().setWidgetDensity('basic');
  render(<WidgetDensityControl />);
  const button = screen.getByRole('button', { name: 'Advanced view' });
  await userEvent.click(button);
  expect(store.getState().widgetDensity).toBe('advanced');
  expect(button).toHaveAttribute('aria-pressed', 'true');
  await userEvent.click(button);
  expect(store.getState().widgetDensity).toBe('basic');
});
