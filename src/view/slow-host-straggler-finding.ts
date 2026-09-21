import type { Finding } from '@sparkforensics/core/types.ts';

// slowHost/straggler (packages/core/src/detectors.ts ~L908/~L1082) carry
// fields the frozen `Finding` interface doesn't declare, bridged with a cast.
// Shared by SlowHost.tsx/Straggler.tsx (own these findings' primary row) and
// Skew.tsx/StageShape.tsx/TinyTask.tsx (surface them only as secondary
// per-stage context), so all these widgets read the same field set instead
// of each declaring their own divergent subset.
export interface SlowHostFinding extends Finding {
  host?: string;
  hostTaskShare?: number;
  executorId?: string;
  dimension?: string;
}

export interface StragglerFinding extends Finding {
  unit?: string;
  speculativeTasks?: number;
}
