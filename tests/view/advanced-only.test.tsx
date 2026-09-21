// @vitest-environment jsdom
import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { store } from '../../src/store/store';
import { AdvancedOnly } from '../../src/view/AdvancedOnly';

test('renders nothing at basic tier', () => {
  store.getState().setWidgetDensity('basic');
  render(<AdvancedOnly><span>meta detail</span></AdvancedOnly>);
  expect(screen.queryByText('meta detail')).not.toBeInTheDocument();
});

test('renders children at advanced tier', () => {
  store.getState().setWidgetDensity('advanced');
  render(<AdvancedOnly><span>meta detail</span></AdvancedOnly>);
  expect(screen.getByText('meta detail')).toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});
