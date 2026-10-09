import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { build } from 'vite';

const root = path.resolve(import.meta.dirname, '..');

/** Every url(...) target in the template's CSS, quotes stripped. */
function cssUrls(html) {
  return [...html.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map((match) => match[2]);
}

describe('export template fonts', () => {
  it('embeds every font as a data URI so the file opened from disk makes no font request', async () => {
    // Same graph as the template build `npm run build` ships, bundled in memory.
    const { output } = await build({
      root,
      configFile: path.join(root, 'vite.export.config.ts'),
      mode: 'guard',
      logLevel: 'silent',
      build: { write: false },
    });
    const html = output.find((chunk) => chunk.fileName.endsWith('.html'))?.source;
    expect(typeof html).toBe('string');

    const fontFaces = html.match(/@font-face\{[^}]*\}/g) ?? [];
    expect(fontFaces.length).toBeGreaterThanOrEqual(4);
    for (const fontFace of fontFaces) {
      const urls = cssUrls(fontFace);
      expect(urls).not.toEqual([]);
      // A bare package path or a relative file would 404 under file://.
      expect(urls.filter((url) => !url.startsWith('data:font/'))).toEqual([]);
    }
  }, 180_000);
});
