// The export build (vite.export.config.ts) swaps each live-only module for a stub
// in this folder: an exported dashboard hides every control that would call one,
// so a stub call is a bug and says so.
export function notInExport(name: string): () => never {
  return () => {
    throw new Error(`${name} is not available in an exported dashboard.`);
  };
}
