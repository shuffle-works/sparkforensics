// @vitest-environment jsdom
import { test, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { store, initialWidgetDensity, useWidgetDensity } from '../../src/store/store';

test('initialWidgetDensity: with no stored choice, defaults to basic', () => {
  window.localStorage.removeItem('shuffle-works-widget-density');
  expect(initialWidgetDensity()).toBe('basic');
});

test('initialWidgetDensity: a persisted choice wins', () => {
  window.localStorage.setItem('shuffle-works-widget-density', 'advanced');
  expect(initialWidgetDensity()).toBe('advanced');
  window.localStorage.removeItem('shuffle-works-widget-density');
});

test('initialWidgetDensity: an invalid stored value falls back to basic', () => {
  window.localStorage.setItem('shuffle-works-widget-density', 'minimal');
  expect(initialWidgetDensity()).toBe('basic');
  window.localStorage.removeItem('shuffle-works-widget-density');
});

test('setWidgetDensity updates the store and persists to localStorage', () => {
  store.getState().setWidgetDensity('advanced');
  expect(store.getState().widgetDensity).toBe('advanced');
  expect(window.localStorage.getItem('shuffle-works-widget-density')).toBe('advanced');
  store.getState().setWidgetDensity('basic');
  expect(window.localStorage.getItem('shuffle-works-widget-density')).toBe('basic');
});

test('useWidgetDensity reads the live store value', () => {
  store.getState().setWidgetDensity('basic');
  const { result } = renderHook(() => useWidgetDensity());
  expect(result.current).toBe('basic');
  act(() => store.getState().setWidgetDensity('advanced'));
  expect(result.current).toBe('advanced');
  store.getState().setWidgetDensity('basic');
});
