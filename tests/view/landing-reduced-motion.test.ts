// The landing DropZone and shared Button must switch to instant motion under
// prefers-reduced-motion; guards against the scoped override being removed or broadened.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../../src/index.css', import.meta.url)), 'utf8');

test('landing dropzone and shared Button transitions are effectively instant for reduced motion', () => {
  const motionOverride = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';

  expect(motionOverride).toMatch(
    /\.landing-drop-zone\s*\{\s*transition-duration:\s*0\.01ms\s*;\s*\}/,
  );
  expect(motionOverride).toMatch(
    /\.group\\\/button\s*\{\s*transition-duration:\s*0\.01ms\s*;\s*\}/,
  );
});
