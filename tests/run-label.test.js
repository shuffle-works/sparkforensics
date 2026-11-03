import { test, expect } from 'vitest';
import { runLabel } from '../src/store/run-label';

test('runLabel takes the name segment of a recent-files composite id', () => {
  expect(runLabel('app-name::12345::1700000000000')).toBe('app-name');
});
test('runLabel returns the whole string when there is no "::" separator', () => {
  expect(runLabel('bare-id')).toBe('bare-id');
});
