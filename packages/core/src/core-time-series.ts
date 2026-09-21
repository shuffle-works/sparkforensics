// Sweep-line "busy cores over time". Pure so it runs in parser-worker (over retained task
// timestamps) or on the main thread (scaling simulator). One core per task: Spark's default.
// `hypotheticalCores` clamps the concurrent busy-core count to N; it does NOT re-schedule
// tasks (makespan re-estimation is the scaling simulator's job, layered on this signal).

interface Interval {
  launch: number;
  finish: number;
}

interface Segment {
  tStart: number;
  tEnd: number;
  busy: number;
}

function buildStepFunction(intervals: Interval[], hypotheticalCores: number | null): Segment[] {
  const events: Array<{ t: number; delta: number }> = [];
  for (const { launch, finish } of intervals) {
    if (!(finish > launch)) continue;
    events.push({ t: launch, delta: 1 });
    events.push({ t: finish, delta: -1 });
  }
  // At equal time process -1 before +1 so [launch, finish) is half-open (a task finishing
  // exactly as another launches does not overlap).
  events.sort((a, b) => (a.t - b.t) || (a.delta - b.delta));

  const segments: Segment[] = [];
  let busy = 0;
  for (let i = 0; i < events.length; i++) {
    const cur = events[i];
    busy += cur.delta;
    const next = events[i + 1];
    if (!next || next.t === cur.t) continue;
    const effective = hypotheticalCores != null ? Math.min(busy, hypotheticalCores) : busy;
    segments.push({ tStart: cur.t, tEnd: next.t, busy: effective });
  }
  return segments;
}

export function computeCoreTimeSeries(intervals: Interval[], {
  bucketBy = 'time',
  bucketWidthMs = 1000,
  hypotheticalCores = null,
}: {
  bucketBy?: 'time' | 'coreCount';
  bucketWidthMs?: number;
  hypotheticalCores?: number | null;
} = {}): { mode: 'coreCount'; histogram: number[] } | {
  mode: 'time';
  bucketWidthMs: number;
  startTime: number | null;
  endTime: number | null;
  buckets: Array<{ tStart: number; tEnd: number; busyCoreMs: number; avgBusyCores: number }>;
} {
  const segments = buildStepFunction(intervals, hypotheticalCores);

  if (bucketBy === 'coreCount') {
    const histogram: number[] = [];
    for (const seg of segments) {
      histogram[seg.busy] = (histogram[seg.busy] ?? 0) + (seg.tEnd - seg.tStart);
    }
    // Fill sparse holes with 0 so the array reads as a dense histogram.
    for (let k = 0; k < histogram.length; k++) if (histogram[k] === undefined) histogram[k] = 0;
    return { mode: 'coreCount', histogram };
  }

  // bucketBy === 'time'
  if (segments.length === 0) {
    return { mode: 'time', bucketWidthMs, startTime: null, endTime: null, buckets: [] };
  }
  const startTime = segments[0].tStart;
  const endTime = segments[segments.length - 1].tEnd;
  const buckets: Array<{ tStart: number; tEnd: number; busyCoreMs: number; avgBusyCores: number }> = [];
  for (let tStart = startTime; tStart < endTime; tStart += bucketWidthMs) {
    const tEnd = tStart + bucketWidthMs;
    let busyCoreMs = 0;
    for (const seg of segments) {
      const lo = Math.max(seg.tStart, tStart);
      const hi = Math.min(seg.tEnd, tEnd);
      if (hi > lo) busyCoreMs += seg.busy * (hi - lo);
    }
    buckets.push({ tStart, tEnd, busyCoreMs, avgBusyCores: busyCoreMs / bucketWidthMs });
  }
  return { mode: 'time', bucketWidthMs, startTime, endTime, buckets };
}
