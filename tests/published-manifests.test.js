import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Their third-party code is bundled at prepack, so an install has nothing to resolve.
describe('bundled packages', () => {
  it.each(['cli', 'mcp', 'server'])('packages/%s declares no runtime dependencies', (dir) => {
    const manifest = JSON.parse(readFileSync(join('packages', dir, 'package.json'), 'utf8'));
    expect(manifest.dependencies).toBeUndefined();
  });
});
