import { test, expect } from 'vitest';
import { VISIBLE_LIMIT } from '../../src/view/visible-limit';

test('VISIBLE_LIMIT constant preserved', () => {
  expect(VISIBLE_LIMIT).toBe(6);
});
