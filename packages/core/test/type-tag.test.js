import { test, expect } from 'vitest';
import { typeTag } from '../src/finding-presentation.js';

test('typeTag maps configAudit to CFG', () => {
  expect(typeTag('configAudit')).toBe('CFG');
  expect(typeTag('skew')).toBe('SKEW');
  expect(typeTag('autoscalingChurn')).toBe('CHRN');
});
test('typeTag maps coreLocality to LOCAL', () => {
  expect(typeTag('coreLocality')).toBe('LOCAL');
});
