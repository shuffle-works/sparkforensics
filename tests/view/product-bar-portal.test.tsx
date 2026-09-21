// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProductBarPortal } from '@/view/ProductBarPortal';

afterEach(() => {
  document.body.innerHTML = '';
});

test('renders children in place, marked for the hub, when no shared product bar exists', () => {
  render(
    <ProductBarPortal className="landing-identity">
      <button type="button">Toggle theme</button>
    </ProductBarPortal>,
  );

  const button = screen.getByRole('button', { name: 'Toggle theme' });
  const wrapper = button.parentElement!;
  expect(wrapper).toHaveAttribute('data-shuffle-page-controls');
  expect(wrapper).toHaveClass('landing-identity');
});

test('portals children into the shared product bar when the hub has published one', () => {
  const bar = document.createElement('header');
  bar.setAttribute('data-shuffle-product-bar', '');
  document.body.appendChild(bar);

  render(
    <ProductBarPortal className="landing-identity">
      <button type="button">Toggle theme</button>
    </ProductBarPortal>,
  );

  const button = screen.getByRole('button', { name: 'Toggle theme' });
  expect(bar.contains(button)).toBe(true);
  expect(button.parentElement).toHaveAttribute('data-shuffle-page-controls');
  expect(button.parentElement).not.toHaveClass('landing-identity');
});
