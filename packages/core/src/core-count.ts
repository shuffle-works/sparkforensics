// Total cores: sum executor totalCores, else peakExecutors x configured cores.
export function computeTotalCores(app: {resources?: {executor?: {cores?: number}}}, executorsAdded: Array<{totalCores?: number}>): number {
  let total = executorsAdded.reduce((s, e) => s + (e.totalCores ?? 0), 0);
  if (total <= 0) {
    const cores = app.resources?.executor?.cores ?? null;
    total = cores != null ? executorsAdded.length * cores : 0;
  }
  return total;
}

// Peak concurrently-alive core count: sweep add/remove events by timestamp, track running max,
// rather than summing every addition. A cumulative sum overstates capacity under dynamic
// allocation (a churned-through executor's cores were never concurrent with its replacement's).
// Tie-break same-timestamp events by delta ascending so a removal applies before a same-instant
// addition; else a seamless swap would momentarily double-count both as concurrent.
function sweepPeak(events: Array<{time: number; delta: number}>): number {
  const sorted = [...events].sort((a, b) => a.time - b.time || a.delta - b.delta);
  let running = 0;
  let peak = 0;
  for (const ev of sorted) {
    running += ev.delta;
    if (running > peak) peak = running;
  }
  return peak;
}

export function computePeakConcurrentCores(
  app: {resources?: {executor?: {cores?: number}}},
  executorsAdded: Array<{executorId: string; timestamp: number; totalCores?: number}>,
  executorsRemoved: Array<{executorId: string; timestamp: number}>,
): number {
  const coresByExecutor = new Map<string, number>();
  const coreEvents: Array<{time: number; delta: number}> = [];
  for (const e of executorsAdded) {
    const cores = e.totalCores ?? 0;
    coresByExecutor.set(e.executorId, cores);
    coreEvents.push({ time: e.timestamp, delta: cores });
  }
  for (const e of executorsRemoved) {
    const cores = coresByExecutor.get(e.executorId) ?? 0;
    coreEvents.push({ time: e.timestamp, delta: -cores });
  }
  const peak = sweepPeak(coreEvents);
  if (peak > 0) return peak;
  // totalCores missing/zero for every add, so the cores sweep is blind. Falling back to
  // executorsAdded.length * cores would reintroduce the cumulative overcount this avoids;
  // sweep peak executor count instead: concurrency-aware, cores-blind.
  const peakExecutorCount = computePeakConcurrentExecutorCount(executorsAdded, executorsRemoved);
  const cores = app.resources?.executor?.cores ?? null;
  return cores != null ? peakExecutorCount * cores : 0;
}

// Peak concurrently-alive executor COUNT (not cores): the denominator memoryUtilization's
// per-executor waste math (allocatedMB x executor count) needs. Same sweep as
// computePeakConcurrentCores, over add/remove events rather than cores, so a churned-through
// executor's slot is never double-counted against its replacement's.
export function computePeakConcurrentExecutorCount(
  executorsAdded: Array<{executorId: string; timestamp: number}>,
  executorsRemoved: Array<{executorId: string; timestamp: number}>,
): number {
  const countEvents: Array<{time: number; delta: number}> = [
    ...executorsAdded.map((e) => ({ time: e.timestamp, delta: 1 })),
    ...executorsRemoved.map((e) => ({ time: e.timestamp, delta: -1 })),
  ];
  return sweepPeak(countEvents);
}
