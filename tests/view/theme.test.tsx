// @vitest-environment jsdom
import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, useTheme } from '../../src/theme/ThemeProvider';
import { initialTheme } from '../../src/store/store';

function Toggle() { const { theme, toggle } = useTheme(); return <button onClick={toggle}>{theme}</button>; }

function withPrefersLight(prefersLight: boolean, fn: () => void) {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: prefersLight && query.includes('light'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  try {
    fn();
  } finally {
    window.matchMedia = original;
  }
}

test('initialTheme: with no stored choice, follows prefers-color-scheme: light', () => {
  window.localStorage.removeItem('shuffle-works-theme');
  withPrefersLight(true, () => expect(initialTheme()).toBe('light'));
});

test('initialTheme: with no stored choice and a non-light OS, defaults to dark', () => {
  window.localStorage.removeItem('shuffle-works-theme');
  withPrefersLight(false, () => expect(initialTheme()).toBe('dark'));
});

test('initialTheme: a persisted choice wins over prefers-color-scheme', () => {
  window.localStorage.setItem('shuffle-works-theme', 'dark');
  withPrefersLight(true, () => expect(initialTheme()).toBe('dark'));
  window.localStorage.removeItem('shuffle-works-theme');
});

test('toggle flips data-theme and persists', async () => {
  render(<ThemeProvider><Toggle /></ThemeProvider>);
  const btn = screen.getByRole('button');
  const start = document.documentElement.getAttribute('data-theme');
  await userEvent.click(btn);
  expect(document.documentElement.getAttribute('data-theme')).not.toBe(start);
  expect(window.localStorage.getItem('shuffle-works-theme')).toBe(btn.textContent);
});

test('toggle keeps the docs-site (VitePress) appearance key in sync, so a docs-site page opened any way picks up the current theme', async () => {
  render(<ThemeProvider><Toggle /></ThemeProvider>);
  const btn = screen.getByRole('button');
  await userEvent.click(btn);
  expect(window.localStorage.getItem('vitepress-theme-appearance')).toBe(btn.textContent);
});

test('storage mutators return undefined', () => {
  expect(window.localStorage.setItem('mutator-return', 'value')).toBeUndefined();
  expect(window.localStorage.removeItem('mutator-return')).toBeUndefined();
});
