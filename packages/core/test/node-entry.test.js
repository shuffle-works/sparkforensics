import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nodeEntry from '../src/node.ts';

// The CLI and MCP bins read every core export from node.ts's one module. The names are plain
// destructured identifiers, so a name node.ts does not export stays undefined until the bin calls it.
// `tsc` cannot check the bins (they are plain JS with no types of their own), so this reads their
// destructuring of the node.ts module and compares it with what node.ts exports.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BINS = ['packages/cli/bin/sparkforensics-analyze.mjs', 'packages/mcp/bin/sparkforensics-mcp.mjs'];

// The names inside `const { a, b: renamed } = /** @type {typeof import('.../node.ts')} */ (core);`.
function nodeEntryNames(binPath) {
  const source = readFileSync(path.join(root, binPath), 'utf8');
  const match = source.match(/const \{([^}]*)\} = \/\*\* @type \{typeof import\('[^']*\/node\.ts'\)\} \*\/ \(core\);/);
  if (!match) throw new Error(`${binPath} has no destructuring of the node.ts module`);
  return match[1].split(',').map((entry) => entry.split(':')[0].trim()).filter(Boolean);
}

describe('node.ts entry for the CLI and MCP bins', () => {
  it.each(BINS)('%s uses only names node.ts exports', (binPath) => {
    const missing = nodeEntryNames(binPath).filter((name) => !(name in nodeEntry));
    expect(missing).toEqual([]);
  });

  it('exports no name that neither bin uses', () => {
    const used = new Set(BINS.flatMap(nodeEntryNames));
    expect(Object.keys(nodeEntry).filter((name) => !used.has(name))).toEqual([]);
  });
});
