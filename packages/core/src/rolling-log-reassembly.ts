// Rolling event-log directory/zip member-name reassembly. Import-free (plain
// JS/TS built-ins only) so DropZone.tsx's drag-drop path can use it without
// pulling in the Zod schemas and vendored zstd/gzip decompressors that the rest
// of shs-fetch.ts depends on. Keep it that way.

export function naturalCompare(a: string, b: string): number {
  const tokenize = (s: string) => s.match(/(\d+)|(\D+)/g) ?? [s];
  const ax = tokenize(a), bx = tokenize(b);
  const len = Math.max(ax.length, bx.length);
  for (let i = 0; i < len; i++) {
    const av = ax[i] ?? '', bv = bx[i] ?? '';
    if (av === bv) continue;
    const an = Number(av), bn = Number(bv);
    if (!Number.isNaN(an) && !Number.isNaN(bn)) return an - bn;
    return av < bv ? -1 : 1;
  }
  return 0;
}

// Reassemble a rolling `eventlog_v2_*` directory's (or SHS zip's) member
// names into the ordered list that should actually be parsed: drop the
// zero-byte `appstatus_*` completion marker, drop every non-compact
// `events_*` file at or below the most recent `*.compact` file's index
// (already merged into it, so reading them again double-counts events), and
// sort the remainder in ascending numeric-index order. Throws if the
// resulting index sequence has a gap (a missing roll file).
export function reassembleRollingEntries(names: string[]): string[] {
  const withoutMarker = names.filter(n => !n.toLowerCase().startsWith('appstatus'));
  const eventNames = withoutMarker.filter(n => /^events_\d+_/.test(n));

  const indexOf = (n: string) => parseInt(n.match(/^events_(\d+)_/)![1], 10);

  const compactIndices = eventNames.filter(n => n.endsWith('.compact')).map(indexOf);
  const highestCompactIndex = compactIndices.length > 0 ? Math.max(...compactIndices) : -1;

  const kept = eventNames.filter(n => {
    const index = indexOf(n);
    return n.endsWith('.compact') ? index === highestCompactIndex : index > highestCompactIndex;
  });

  const sorted = kept.sort(naturalCompare);
  const indices = sorted.map(indexOf);
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] !== indices[i - 1] + 1) {
      throw new Error(`Rolling event-log directory is missing file(s) between index ${indices[i - 1]} and ${indices[i]}.`);
    }
  }

  return sorted;
}
