// @vitest-environment jsdom
import { test, expect } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { toast } from 'sonner';
import { Toaster } from '../../src/components/ui/sonner';
import { ThemeProvider } from '../../src/theme/ThemeProvider';
import { store } from '../../src/store/store';

// setup.ts's matchMedia shim always reports `matches: false`, so Sonner's own
// "system" resolution of `prefers-color-scheme: dark` yields 'light'. Forcing
// the app theme to 'dark' therefore separates "follows the app theme" from
// "follows the OS color scheme".
const getToaster = () => document.querySelector('[data-sonner-toaster]');

test('Toaster renders with the app theme, not the OS color scheme', async () => {
  act(() => { store.getState().setTheme('dark'); });
  render(<ThemeProvider><Toaster /></ThemeProvider>);
  // Sonner only renders [data-sonner-toaster] once at least one toast exists.
  act(() => { toast('app-theme probe'); });
  await waitFor(() => expect(getToaster()).not.toBeNull());
  expect(getToaster()?.getAttribute('data-sonner-theme')).toBe('dark');
});

test('Toaster follows the app theme toggle via the store', async () => {
  act(() => { store.getState().setTheme('dark'); });
  render(<ThemeProvider><Toaster /></ThemeProvider>);
  act(() => { toast('toggle probe'); });
  await waitFor(() => expect(getToaster()).not.toBeNull());
  act(() => { store.getState().setTheme('light'); });
  await waitFor(() => expect(getToaster()?.getAttribute('data-sonner-theme')).toBe('light'));
  act(() => { store.getState().setTheme('dark'); });
  await waitFor(() => expect(getToaster()?.getAttribute('data-sonner-theme')).toBe('dark'));
});
