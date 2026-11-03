import { test, expect } from 'vitest';
import { escHtml, pathBasename, trimCallsite } from '../src/text-format.js';

test('pathBasename drops trailing slashes and commas before taking the basename', () => {
  expect(pathBasename('hdfs://host/a/b,/,/')).toBe('b');
  expect(pathBasename('read /data/orders/')).toBe('orders');
});
// The path text comes from the event log. A quadratic trailing-trim regex took >10s here.
test('pathBasename stays linear on a long comma run', () => {
  const started = Date.now();
  expect(pathBasename('hdfs://host/a' + ','.repeat(250000) + 'x')).toBe('a' + ','.repeat(250000) + 'x');
  expect(Date.now() - started).toBeLessThan(2000);
});

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
