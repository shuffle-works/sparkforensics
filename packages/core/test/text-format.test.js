import { test, expect } from 'vitest';
import { escHtml, trimCallsite } from '../src/text-format.js';

test('escHtml escapes ampersands and angle brackets', () => {
  expect(escHtml('<script>a&b</script>')).toBe('&lt;script&gt;a&amp;b&lt;/script&gt;');
});
test('trimCallsite reduces an hdfs/s3 path in a Spark callsite to its basename', () => {
  expect(trimCallsite('collect at /u02/app/utils.py:1869')).toBe('collect at utils.py:1869');
  expect(trimCallsite('save at hdfs://host/warehouse/table/part.parquet:12')).toBe('save at part.parquet:12');
});
test('trimCallsite passes through a string with no " at " separator unchanged', () => {
  expect(trimCallsite('no callsite here')).toBe('no callsite here');
});
